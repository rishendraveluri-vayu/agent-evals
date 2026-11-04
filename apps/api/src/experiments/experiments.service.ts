import { Inject, Injectable } from '@nestjs/common';
import type {
  ActualSoFar,
  ArmView,
  CompareResponse,
  CreateExperimentRequest,
  Estimate,
  EstimateRequest,
  EstimateResponse,
  ExperimentCounts,
  ExperimentDetail,
  ExperimentEvent,
  ExperimentEventKind,
  ExperimentStatus,
  ExperimentSummary,
  FutilityRule,
  TrialRowSummary,
  TrialStatus,
} from '../contract';
import { TRIAL_STATUSES } from '../contract';
import { badRequest, conflict, notFound } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { normalizeSha } from '../common/hashing';
import { newId } from '../common/ids';
import { CatalogueService, type StoredPrompt, type StoredTask, taskView } from '../catalogue/catalogue.service';
import { CONFIG_SELECT, type ConfigRow, configView } from '../configs/configs.service';
import { Db, type Queryable } from '../database/db.service';
import { JudgeService } from '../judge/judge.service';
import { LiteLlmClient } from '../litellm/litellm.client';
import { SIM_MAX_OUTPUT_TOKENS, simTemperature } from '../worker/spec-builder';
import { type CellInput, type History, LIVE_WORKER_S, type Price, estimate } from './estimate';
import { claimOrder, isSeed, newSeed } from './order';
import { type BaselineOutcome, decideBaseline } from './baseline';
import { estimatePerTrial, projectedSpend, resolveFutility } from './rules';
import { type ArmRow, addEvent, pauseArm, pauseExperiment } from './run-state';

/** D35: arm A and arm B, or one config for a pilot. */
export const MAX_ARMS = 2;

export interface ExperimentRow {
  id: string;
  name: string;
  axis: string;
  config_hashes: string[];
  task_sha256s: string[];
  n: number;
  sim_model: string | null;
  sim_prompt_sha256: string | null;
  sim_temperature: number | null;
  sim_max_output_tokens: number | null;
  budget_usd: number;
  trial_budget_usd: number;
  sim_budget_usd: number;
  litellm_team_id: string | null;
  platform_commit: string | null;
  plan_commit: string | null;
  estimate: Estimate;
  status: ExperimentStatus;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  cancelled_at: Date | null;
  paused_at: Date | null;
  paused_reason: string | null;
  resumed_at: Date | null;
  // 005
  parent_experiment_id: string | null;
  reuse_baseline: boolean;
  baseline_decision: string | null;
  /** bigint: node-pg returns it as a string. */
  order_seed: string | null;
  futility: FutilityRule | null;
  spend_guard_at: Date | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Marks a running experiment done once none of its trials is queued or held. */
export async function finishIfDone(q: Queryable, experimentId: string): Promise<void> {
  await q.query(
    `UPDATE experiments SET status = 'done', finished_at = now()
     WHERE id = $1 AND status = 'running'
       AND NOT EXISTS (SELECT 1 FROM trials WHERE experiment_id = $1 AND status IN ('queued', 'claimed', 'running'))`,
    [experimentId],
  );
}

interface Plan {
  configs: ConfigRow[];
  tasks: StoredTask[];
  n: number;
  simModel: string | null;
  estimate: Estimate;
}

@Injectable()
export class ExperimentsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly catalogue: CatalogueService,
    private readonly litellm: LiteLlmClient,
    private readonly judge: JudgeService,
  ) {}

  // ---- planning ----

  private async plan(body: EstimateRequest): Promise<Plan> {
    if (typeof body !== 'object' || body === null) throw badRequest('invalid_experiment', 'the body must be a JSON object');
    const configHashes = shaList(body.config_hashes, 'config_hashes');
    if (configHashes.length > MAX_ARMS) {
      // D35: two arms, A against B. A question with more arms is several A/B experiments.
      throw badRequest(
        'too_many_arms',
        `an experiment has one config (a pilot) or two (arm A and arm B); this one has ${configHashes.length}`,
        'Run several A/B experiments against the same parent: each new config as arm B, the shared baseline as arm A (reuse_baseline can reuse its trials).',
      );
    }
    const taskShas = shaList(body.task_sha256s, 'task_sha256s');
    const n = body.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000) {
      throw badRequest('invalid_experiment', 'n must be an integer from 1 to 1000');
    }
    const configs = await this.db.query<ConfigRow>(`${CONFIG_SELECT} WHERE c.hash = ANY($1)`, [configHashes]);
    const missingConfig = configHashes.find((h) => !configs.some((c) => c.hash === h));
    if (missingConfig) throw badRequest('unknown_config', `no config ${missingConfig}`);
    const { tasks, problems } = await this.catalogue.tasksBySha(taskShas);
    for (const sha of taskShas) {
      const why = problems.get(sha);
      if (why) throw badRequest('invalid_task', `task ${sha} cannot be used: ${why.join('; ')}`);
      if (!tasks.some((t) => t.sha256 === sha)) throw badRequest('unknown_task', `no task ${sha}; see GET /tasks`);
    }
    const ordered = {
      configs: configHashes.map((h) => configs.find((c) => c.hash === h) as ConfigRow),
      tasks: taskShas.map((s) => tasks.find((t) => t.sha256 === s) as StoredTask),
    };
    const needsSim = ordered.tasks.some((t) => isSimTask(t));
    const simModel = typeof body.sim_model === 'string' && body.sim_model.trim() ? body.sim_model.trim() : null;
    if (needsSim && !simModel) throw badRequest('sim_model_required', 'a task has a simulated client, so sim_model is required');

    const prices = new Map<string, Price>();
    for (const model of new Set([...ordered.configs.map((c) => c.model), ...(needsSim && simModel ? [simModel] : [])])) {
      const found = await this.litellm.findModel(model);
      if (!found) throw badRequest('unknown_model', `LiteLLM serves no model named ${model}`);
      if (found.inputPerToken === null || found.outputPerToken === null) {
        throw badRequest('no_price', `LiteLLM has no price for ${model}, so the run cannot be costed`);
      }
      prices.set(model, { inputPerToken: found.inputPerToken, outputPerToken: found.outputPerToken });
    }

    // Item 8: the closest history there is. Finished trials only, with LiteLLM's full record.
    type Row = { trials: number; input_tokens: number; output_tokens: number; wall_s: number | null; cost_usd: number | null };
    // Probes (D33) render a prompt on the fake model; they are never history.
    const finished = `t.status = 'done' AND NOT t.probe AND t.input_tokens IS NOT NULL AND t.output_tokens IS NOT NULL AND t.proxy_complete IS NOT FALSE`;
    const means = `count(*)::int AS trials, avg(t.input_tokens)::float8 AS input_tokens, avg(t.output_tokens)::float8 AS output_tokens,
                   avg(t.wall_s)::float8 AS wall_s, avg(t.cost_usd)::float8 AS cost_usd`;
    const byCell = await this.db.query<Row & { config_hash: string; task_sha256: string; sim_cost_usd: number | null }>(
      `SELECT t.config_hash, t.task_sha256, ${means}, avg(t.sim_cost_usd)::float8 AS sim_cost_usd
       FROM trials t WHERE ${finished} AND t.config_hash = ANY($1) AND t.task_sha256 = ANY($2)
       GROUP BY t.config_hash, t.task_sha256`,
      [configHashes, taskShas],
    );
    const byHarnessModel = await this.db.query<Row & { harness: string; model: string }>(
      `SELECT t.harness, c.model, ${means}
       FROM trials t JOIN configs c ON c.hash = t.config_hash
       WHERE ${finished} AND t.harness = ANY($1) AND c.model = ANY($2)
       GROUP BY t.harness, c.model`,
      [[...new Set(ordered.configs.map((c) => c.harness))], [...new Set(ordered.configs.map((c) => c.model))]],
    );
    const simByTask = needsSim
      ? await this.db.query<{ task_sha256: string; sim_cost_usd: number }>(
          `SELECT t.task_sha256, avg(t.sim_cost_usd)::float8 AS sim_cost_usd
           FROM trials t JOIN experiments e ON e.id = t.experiment_id
           WHERE t.status = 'done' AND t.sim_cost_usd IS NOT NULL AND e.sim_model = $1 AND t.task_sha256 = ANY($2)
           GROUP BY t.task_sha256`,
          [simModel, taskShas],
        )
      : [];
    const workers = new Map(
      (
        await this.db.query<{ harness: string; live: number }>(
          `SELECT harness, count(*)::int AS live FROM workers WHERE last_seen_at > now() - make_interval(secs => $1) GROUP BY harness`,
          [LIVE_WORKER_S],
        )
      ).map((w) => [w.harness, w.live]),
    );
    const hist = (r: Row | undefined): History | null =>
      r ? { trials: r.trials, inputTokens: r.input_tokens, outputTokens: r.output_tokens, wallS: r.wall_s, costUsd: r.cost_usd } : null;
    const cells: CellInput[] = [];
    for (const c of ordered.configs) {
      for (const t of ordered.tasks) {
        const own = byCell.find((r) => r.config_hash === c.hash && r.task_sha256 === t.sha256);
        const sim = isSimTask(t) ? (own?.sim_cost_usd ?? simByTask.find((r) => r.task_sha256 === t.sha256)?.sim_cost_usd ?? null) : null;
        cells.push({
          config: c.hash,
          task: t.sha256,
          model: c.model,
          harness: c.harness,
          simTurns: isSimTask(t) ? simTurns(t) : null,
          history: hist(own),
          harnessModel: hist(byHarnessModel.find((r) => r.harness === c.harness && r.model === c.model)),
          simCostUsd: sim,
        });
      }
    }
    return { ...ordered, n, simModel: needsSim ? simModel : null, estimate: estimate({ cells, n, prices, simModel: needsSim ? simModel : null, workers }) };
  }

  /** The simulator prompt: the one named, else the highest version of client-sim (D27). */
  private async simPromptFor(body: EstimateRequest, simModel: string | null): Promise<StoredPrompt | null> {
    if (!simModel) return null;
    if (body.sim_prompt_sha256 !== undefined && body.sim_prompt_sha256 !== null) {
      const sha = normalizeSha(body.sim_prompt_sha256);
      if (!sha) throw badRequest('invalid_experiment', 'sim_prompt_sha256 must be sha256:<64 hex>');
      const p = await this.catalogue.prompt(sha);
      if (!p) throw badRequest('unknown_prompt', `no prompt with ${sha}`);
      return p;
    }
    const latest = await this.catalogue.latestPrompt('client-sim');
    if (!latest) throw badRequest('unknown_prompt', 'no client-sim prompt under configs/prompts');
    return latest;
  }

  /**
   * The whole run as it would be created: the plan of both arms, the simulator prompt, the parent
   * (D34), whether arm A reuses the parent's trials, and the estimate of what will actually run.
   */
  private async resolveRun(body: EstimateRequest): Promise<{
    plan: Plan;
    simPrompt: StoredPrompt | null;
    parentId: string | null;
    baseline: (BaselineOutcome & { requested: true }) | null;
    run: Plan;
  }> {
    const plan = await this.plan(body);
    const simPrompt = await this.simPromptFor(body, plan.simModel);
    const parentId = body.parent_experiment_id ?? null;
    if (parentId !== null && typeof parentId !== 'string') throw badRequest('invalid_experiment', 'parent_experiment_id must be an experiment id or null');
    if (body.reuse_baseline !== undefined && body.reuse_baseline !== null && typeof body.reuse_baseline !== 'boolean') {
      throw badRequest('invalid_experiment', 'reuse_baseline must be true or false');
    }
    let parent: ExperimentRow | null = null;
    if (parentId) {
      [parent] = await this.db.query<ExperimentRow>('SELECT * FROM experiments WHERE id = $1', [parentId]);
      if (!parent) throw badRequest('unknown_parent_experiment', `no experiment ${parentId} to be the parent`, 'Name an experiment from GET /experiments, or leave parent_experiment_id out.');
    }
    if (!body.reuse_baseline) return { plan, simPrompt, parentId, baseline: null, run: plan };
    if (!parent) throw badRequest('invalid_experiment', 'reuse_baseline needs parent_experiment_id', 'Name the parent experiment whose arm-A trials to reuse, or leave reuse_baseline out.');
    if (plan.configs.length !== 2) {
      throw badRequest('invalid_experiment', 'reuse_baseline needs two arms: the parent’s arm A and a new arm B', 'Add the new config as arm B, or leave reuse_baseline out.');
    }
    const [armA, armB] = plan.configs;
    // The parent's finished arm-A trials: its own, and any it reused from its own parent.
    const [parentArm] = await this.db.query<{ reused_trial_ids: string[] }>('SELECT reused_trial_ids FROM experiment_arms WHERE experiment_id = $1 AND position = 0', [parent.id]);
    const finished = await this.db.query<{ id: string; task_sha256: string }>(
      `SELECT id, task_sha256 FROM trials
       WHERE status = 'done' AND config_hash = $2 AND task_sha256 = ANY($3) AND (experiment_id = $1 OR id = ANY($4))
       ORDER BY task_sha256, repeat_index, attempt, id`,
      [parent.id, armA.hash, plan.tasks.map((t) => t.sha256), parentArm?.reused_trial_ids ?? []],
    );
    const byTask = new Map<string, string[]>();
    for (const t of finished) byTask.set(t.task_sha256, [...(byTask.get(t.task_sha256) ?? []), t.id]);
    const outcome = decideBaseline({
      parent: {
        id: parent.id,
        armA: parent.config_hashes[0],
        tasks: parent.task_sha256s,
        platformCommit: parent.platform_commit,
        simModel: parent.sim_model,
        simPromptSha256: parent.sim_prompt_sha256,
      },
      armA: armA.hash,
      tasks: plan.tasks.map((t) => t.sha256),
      platformCommit: this.config.platformCommit,
      simModel: plan.simModel,
      simPromptSha256: simPrompt?.sha256 ?? null,
      n: plan.n,
      finished: byTask,
    });
    const run = outcome.applied ? await this.plan({ ...body, config_hashes: [armB.hash] }) : plan;
    return { plan, simPrompt, parentId, baseline: { ...outcome, requested: true }, run };
  }

  async estimate(body: EstimateRequest): Promise<EstimateResponse> {
    const { run, baseline } = await this.resolveRun(body);
    return { ...run.estimate, baseline: baseline ? { applied: baseline.applied, reason: baseline.reason, reused_trials: baseline.trialIds.length } : null };
  }

  async create(body: CreateExperimentRequest): Promise<ExperimentDetail> {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) throw badRequest('invalid_experiment', 'name is required');
    const axis = typeof body.axis === 'string' ? body.axis.trim() : '';
    if (!axis) throw badRequest('invalid_experiment', 'axis is required: the one thing the configs differ on');
    if (typeof body.budget_usd !== 'number' || !Number.isFinite(body.budget_usd) || body.budget_usd <= 0) {
      throw badRequest('invalid_experiment', 'budget_usd must be a number above 0');
    }
    if (body.plan_commit !== undefined && body.plan_commit !== null && typeof body.plan_commit !== 'string') {
      throw badRequest('invalid_experiment', 'plan_commit must be a string or null');
    }
    const { plan, simPrompt, parentId, baseline, run } = await this.resolveRun(body);
    // R10.6: start only runs that can finish. The budget is a safety net, so it must cover
    // the top of the estimate's range, not just the expected cost. With arm A reused (D34),
    // the estimate is of arm B alone.
    if (body.budget_usd < run.estimate.cost_usd.high) {
      throw badRequest(
        'budget_below_estimate',
        `budget_usd ${body.budget_usd} is below the estimate's high end ${run.estimate.cost_usd.high} ` +
          `(expected ${run.estimate.cost_usd.expected}); raise the budget or shrink the run`,
        `Set budget_usd to at least ${run.estimate.cost_usd.high}, or lower n or the number of tasks.`,
      );
    }

    if (body.order_seed !== undefined && body.order_seed !== null && !isSeed(body.order_seed)) {
      throw badRequest('invalid_experiment', 'order_seed must be an integer from 0 to 4294967295', 'Leave order_seed out for a random one, or give the seed of the order to repeat.');
    }
    const seed = isSeed(body.order_seed) ? body.order_seed : newSeed();
    const futility = resolveFutility(body.futility);

    const id = newId('e');
    const slots: { id: string; task: string; config: string; harness: string; repeat: number; seq: number; order: number }[] = [];
    // D32: claims follow a seeded shuffle of (task, repeat) blocks with the arms in a random
    // order inside each block, so the arms alternate and any early batch is a random sample.
    // `seq` stays the slot's place in the plan (repeat, task, config), a stable number for paging.
    // With arm A reused (D34), only arm B's trials are queued.
    const order = new Map(claimOrder(run.tasks.map((t) => t.sha256), run.configs.map((c) => c.hash), run.n, seed).map((s, i) => [`${s.task}|${s.config}|${s.repeat}`, i]));
    let seq = 0;
    for (let r = 0; r < run.n; r += 1) {
      for (const t of run.tasks) {
        for (const c of run.configs) {
          const at = order.get(`${t.sha256}|${c.hash}|${r}`) as number;
          slots.push({ id: newId('t'), task: t.sha256, config: c.hash, harness: c.harness, repeat: r, seq: seq++, order: at });
        }
      }
    }
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO experiments (id, name, axis, config_hashes, task_sha256s, n, sim_model, sim_prompt_sha256,
                                  sim_temperature, sim_max_output_tokens, budget_usd, trial_budget_usd, sim_budget_usd,
                                  platform_commit, plan_commit, estimate, status, order_seed, futility,
                                  parent_experiment_id, reuse_baseline, baseline_decision)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'created', $17, $18, $19, $20, $21)`,
        [
          id,
          name,
          axis,
          plan.configs.map((c) => c.hash),
          plan.tasks.map((t) => t.sha256),
          plan.n,
          plan.simModel,
          simPrompt?.sha256 ?? null,
          plan.simModel ? simTemperature(plan.simModel) : null, // null with a simulator: not sent (D27)
          plan.simModel ? SIM_MAX_OUTPUT_TOKENS : null,
          body.budget_usd,
          run.estimate.budgets.trial_usd,
          run.estimate.budgets.sim_usd,
          this.config.platformCommit,
          body.plan_commit ?? null,
          JSON.stringify(run.estimate),
          seed,
          JSON.stringify(futility),
          parentId,
          baseline !== null,
          baseline?.reason ?? null,
        ],
      );
      await client.query(
        `INSERT INTO trials (id, experiment_id, task_sha256, config_hash, repeat_index, attempt, seq, order_index, harness, status)
         SELECT s.id, $1, s.task, s.config, s.repeat, 1, s.seq, s.ord, s.harness, 'queued'
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[], $8::text[])
              AS s(id, task, config, repeat, seq, ord, harness)`,
        [
          id,
          slots.map((s) => s.id),
          slots.map((s) => s.task),
          slots.map((s) => s.config),
          slots.map((s) => s.repeat),
          slots.map((s) => s.seq),
          slots.map((s) => s.order),
          slots.map((s) => s.harness),
        ],
      );
      await client.query(
        `INSERT INTO experiment_arms (experiment_id, config_hash, arm, position, reused_trial_ids)
         SELECT $1, c.hash, chr(64 + c.ord::int), c.ord::int - 1, CASE WHEN c.ord = 1 THEN $3::text[] ELSE '{}' END
         FROM unnest($2::text[]) WITH ORDINALITY AS c (hash, ord)`,
        [id, plan.configs.map((c) => c.hash), baseline?.applied ? baseline.trialIds : []],
      );
      if (baseline) {
        // D34: which applied, and why, for the events list and the UI.
        await addEvent(client, {
          experimentId: id,
          kind: 'baseline',
          detail: baseline.reason,
          configHash: plan.configs[0].hash,
          data: { parent_experiment_id: parentId, applied: baseline.applied, reused_trials: baseline.trialIds.length },
        });
      }
      // The whole experiment's budget, enforced by LiteLLM across every trial key (a team).
      // Inside the transaction: if LiteLLM refuses, nothing is stored.
      const teamId = await this.litellm.newTeam({ alias: `experiment:${id}`, maxBudgetUsd: body.budget_usd, experimentId: id });
      await client.query('UPDATE experiments SET litellm_team_id = $2 WHERE id = $1', [id, teamId]);
    });
    return this.get(id);
  }

  // ---- lifecycle ----

  /** Starts a created experiment, or resumes a paused one; a running one is left as it is. */
  async start(id: string): Promise<ExperimentDetail> {
    const exp = await this.row(id);
    if (exp.status === 'done' || exp.status === 'cancelled') {
      throw conflict('experiment_finished', `experiment ${id} is ${exp.status} and cannot start again`, 'Create a new experiment, with this one as its parent.');
    }
    if (exp.status === 'paused') return this.resume(id);
    await this.db.tx(async (client) => {
      await client.query(`UPDATE experiments SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = $1 AND status = 'created'`, [id]);
      await finishIfDone(client, id);
    });
    return this.get(id);
  }

  /** D32: stops new claims; trials already running finish and report. A paused one stays paused. */
  async pause(id: string): Promise<ExperimentDetail> {
    const exp = await this.row(id);
    if (exp.status === 'created') throw conflict('experiment_not_started', `experiment ${id} has not started`, 'Start it, or stop it; there is nothing to pause yet.');
    if (exp.status === 'done' || exp.status === 'cancelled') throw conflict('experiment_finished', `experiment ${id} is ${exp.status}`);
    await this.db.tx((client) => pauseExperiment(client, id, 'paused', 'paused by hand: new claims stop; trials already running finish'));
    return this.get(id);
  }

  /** Resumes a paused experiment (whatever paused it); arm pauses are separate (D37). */
  async resume(id: string): Promise<ExperimentDetail> {
    const exp = await this.row(id);
    if (exp.status === 'created') throw conflict('experiment_not_started', `experiment ${id} has not started`, `POST /experiments/${id}/start to start it.`);
    if (exp.status === 'done' || exp.status === 'cancelled') throw conflict('experiment_finished', `experiment ${id} is ${exp.status} and cannot resume`);
    await this.db.tx(async (client) => {
      const { rowCount } = await client.query(`UPDATE experiments SET status = 'running', resumed_at = now() WHERE id = $1 AND status = 'paused'`, [id]);
      if (rowCount) await addEvent(client, { experimentId: id, kind: 'resumed', detail: 'claims resumed' });
      // A pause can come with the last trial: then there is nothing left to claim.
      await finishIfDone(client, id);
    });
    return this.get(id);
  }

  /** Stop (D32), also served as cancel: queued trials become cancelled; claimed and running ones finish and are kept. */
  async cancel(id: string): Promise<ExperimentDetail> {
    const exp = await this.row(id);
    if (exp.status === 'done') throw conflict('experiment_finished', `experiment ${id} is already done`);
    await this.db.tx(async (client) => {
      await client.query(`UPDATE experiments SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status IN ('created', 'running', 'paused')`, [id]);
      await client.query(`UPDATE trials SET status = 'cancelled', finished_at = now() WHERE experiment_id = $1 AND status = 'queued'`, [id]);
    });
    return this.get(id);
  }

  /** The arm row for `configHash` (its hash, or `A`/`B`), or a 404. */
  private async armRow(id: string, configHash: string): Promise<ArmRow> {
    const exp = await this.row(id);
    const hash = normalizeSha(configHash);
    const [arm] = await this.db.query<ArmRow>('SELECT * FROM experiment_arms WHERE experiment_id = $1 AND (config_hash = $2 OR arm = $3)', [exp.id, hash, configHash.toUpperCase()]);
    if (!arm) throw notFound('unknown_arm', `experiment ${id} has no arm ${configHash}`, `Use one of the experiment's config hashes: ${exp.config_hashes.join(', ')}.`);
    return arm;
  }

  /** D37: pauses one arm by hand. Its queued trials wait; the other arm keeps claiming. */
  async pauseArm(id: string, configHash: string): Promise<ExperimentDetail> {
    const arm = await this.armRow(id, configHash);
    const exp = await this.row(id);
    if (exp.status === 'done' || exp.status === 'cancelled') throw conflict('experiment_finished', `experiment ${id} is ${exp.status}`);
    await this.db.tx((client) =>
      pauseArm(client, id, arm.config_hash, 'paused by hand: this arm claims nothing more; its running trials finish', `POST /experiments/${id}/arms/${arm.config_hash}/resume to continue it.`),
    );
    return this.get(id);
  }

  /** D37: resumes a paused arm; its queued trials can be claimed again. */
  async resumeArm(id: string, configHash: string): Promise<ExperimentDetail> {
    const arm = await this.armRow(id, configHash);
    await this.db.tx(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE experiment_arms SET paused_at = NULL, paused_reason = NULL, paused_fix = NULL, resumed_at = now()
         WHERE experiment_id = $1 AND config_hash = $2 AND paused_at IS NOT NULL`,
        [id, arm.config_hash],
      );
      if (rowCount) {
        await addEvent(client, { experimentId: id, kind: 'arm_resumed', detail: `arm ${arm.arm} resumed: its queued trials can be claimed`, configHash: arm.config_hash });
      }
      await finishIfDone(client, id);
    });
    return this.get(id);
  }

  // ---- reads ----

  async row(id: string): Promise<ExperimentRow> {
    const [row] = await this.db.query<ExperimentRow>('SELECT * FROM experiments WHERE id = $1', [id]);
    if (!row) throw notFound('unknown_experiment', `no experiment ${id}`);
    return row;
  }

  private async countsAndSpend(ids: string[]): Promise<Map<string, { counts: ExperimentCounts; spend: number }>> {
    const rows = await this.db.query<{ experiment_id: string; status: TrialStatus; label: string | null; end_state: string | null; n: number; spend: number }>(
      `SELECT experiment_id, status, label, end_state, count(*)::int AS n,
              coalesce(sum(coalesce(cost_usd, 0) + coalesce(sim_cost_usd, 0)), 0)::float8 AS spend
       FROM trials WHERE experiment_id = ANY($1) GROUP BY experiment_id, status, label, end_state`,
      [ids],
    );
    const out = new Map<string, { counts: ExperimentCounts; spend: number }>();
    for (const id of ids) {
      out.set(id, {
        counts: { queued: 0, running: 0, done: 0, infra_failed: 0, abandoned: 0, cancelled: 0, by_label: {}, done_by_end_state: {} },
        spend: 0,
      });
    }
    for (const r of rows) {
      const entry = out.get(r.experiment_id);
      if (!entry) continue;
      const c = entry.counts;
      const key = r.status === 'claimed' ? 'running' : r.status;
      c[key] += r.n;
      if (r.label) c.by_label[r.label] = (c.by_label[r.label] ?? 0) + r.n;
      if (r.status === 'done' && r.end_state) c.done_by_end_state[r.end_state] = (c.done_by_end_state[r.end_state] ?? 0) + r.n;
      entry.spend += r.spend;
    }
    return out;
  }

  private summary(r: ExperimentRow, extra: { counts: ExperimentCounts; spend: number }): ExperimentSummary {
    return {
      id: r.id,
      name: r.name,
      axis: r.axis,
      status: r.status,
      config_hashes: r.config_hashes,
      task_sha256s: r.task_sha256s,
      n: r.n,
      counts: extra.counts,
      spend_usd: Math.round(extra.spend * 1e6) / 1e6,
      estimate: r.estimate,
      budget_usd: r.budget_usd,
      created_at: r.created_at.toISOString(),
    };
  }

  async list(): Promise<ExperimentSummary[]> {
    const rows = await this.db.query<ExperimentRow>('SELECT * FROM experiments ORDER BY created_at DESC, id DESC');
    const extra = await this.countsAndSpend(rows.map((r) => r.id));
    return rows.map((r) => this.summary(r, extra.get(r.id) as { counts: ExperimentCounts; spend: number }));
  }

  async get(id: string): Promise<ExperimentDetail> {
    const r = await this.row(id);
    const extra = (await this.countsAndSpend([id])).get(id) as { counts: ExperimentCounts; spend: number };
    const arms = await this.arms(r);
    const configs = await this.db.query<ConfigRow>(`${CONFIG_SELECT} WHERE c.hash = ANY($1)`, [r.config_hashes]);
    const tasks = await this.db.query<StoredTask>(
      'SELECT sha256, id, version, split, kind, summary, body, client_state_name, NULL AS client_state, client_state_sha256, source_path FROM tasks WHERE sha256 = ANY($1)',
      [r.task_sha256s],
    );
    let sim: ExperimentDetail['sim'] = null;
    if (r.sim_model && r.sim_prompt_sha256) {
      const [p] = await this.db.query<{ id: string; version: string; sha256: string }>('SELECT id, version, sha256 FROM prompts WHERE sha256 = $1', [r.sim_prompt_sha256]);
      if (p) sim = { prompt: { id: p.id, version: p.version, sha256: p.sha256 }, temperature: r.sim_temperature, max_output_tokens: r.sim_max_output_tokens ?? SIM_MAX_OUTPUT_TOKENS };
    }
    return {
      ...this.summary(r, extra),
      sim_model: r.sim_model,
      sim,
      platform_commit: r.platform_commit,
      plan_commit: r.plan_commit,
      order_seed: r.order_seed === null ? null : Number(r.order_seed),
      futility: r.futility,
      parent_experiment_id: r.parent_experiment_id,
      baseline: r.reuse_baseline ? { applied: arms[0]?.reused_trials > 0, reason: r.baseline_decision ?? '', reused_trials: arms[0]?.reused_trials ?? 0 } : null,
      actual: await this.actual(r),
      budgets: { trial_usd: r.trial_budget_usd, sim_usd: r.sim_budget_usd },
      started_at: iso(r.started_at),
      finished_at: iso(r.finished_at),
      paused_at: iso(r.paused_at),
      paused_reason: r.paused_reason,
      arms,
      tasks: r.task_sha256s.map((s) => tasks.find((t) => t.sha256 === s)).filter((t): t is StoredTask => !!t).map((t) => taskView(t)),
      configs: r.config_hashes.map((h) => configs.find((c) => c.hash === h)).filter((c): c is ConfigRow => !!c).map(configView),
      events: await this.events(r),
      judge: await this.judge.view(r.id),
    };
  }

  /** Item 8: spend and time so far, beside the estimate; null until a trial has finished. */
  private async actual(r: ExperimentRow): Promise<ActualSoFar | null> {
    const byArm = await this.db.query<{ config_hash: string; finished: number; remaining: number; reported: number; cost: number; wall_s: number | null; walled: number }>(
      `SELECT config_hash,
              count(*) FILTER (WHERE status IN ('done', 'infra_failed', 'abandoned'))::int AS finished,
              count(*) FILTER (WHERE status IN ('queued', 'claimed', 'running'))::int AS remaining,
              count(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS reported,
              coalesce(sum(coalesce(cost_usd, 0) + coalesce(sim_cost_usd, 0)), 0)::float8 AS cost,
              sum(wall_s)::float8 AS wall_s, count(wall_s)::int AS walled
       FROM trials WHERE experiment_id = $1 GROUP BY config_hash`,
      [r.id],
    );
    const finished = byArm.reduce((s, a) => s + a.finished, 0);
    if (!finished) return null;
    const spent = byArm.reduce((s, a) => s + a.cost, 0);
    const reported = byArm.reduce((s, a) => s + a.reported, 0);
    const walled = byArm.reduce((s, a) => s + a.walled, 0);
    const end = r.finished_at ?? r.cancelled_at ?? new Date();
    const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;
    return {
      finished_trials: finished,
      spend_usd: round(spent, 6),
      cost_per_trial_usd: reported ? round(spent / reported, 6) : null,
      wall_s_per_trial: walled ? round(byArm.reduce((s, a) => s + (a.wall_s ?? 0), 0) / walled, 1) : null,
      elapsed_minutes: r.started_at ? round((end.getTime() - r.started_at.getTime()) / 60_000, 1) : null,
      projected_spend_usd: round(
        projectedSpend(
          spent,
          byArm.map((a) => ({ remaining: a.remaining, meanCost: a.reported ? a.cost / a.reported : null, estimatePerTrial: estimatePerTrial(r.estimate, a.config_hash) })),
        ),
        6,
      ),
    };
  }

  /** Each arm's state and trial counts (D35, D37), arm A first. */
  async arms(r: ExperimentRow): Promise<ArmView[]> {
    const rows = await this.db.query<ArmRow & { config_name: string }>(
      `SELECT a.*, c.name AS config_name FROM experiment_arms a JOIN configs c ON c.hash = a.config_hash WHERE a.experiment_id = $1 ORDER BY a.position`,
      [r.id],
    );
    // An arm reused from the parent (D34) counts the parent's trials it took.
    const counts = await this.db.query<{ config_hash: string; status: TrialStatus; n: number }>(
      `SELECT config_hash, status, count(*)::int AS n FROM trials
       WHERE experiment_id = $1 OR id = ANY($2) GROUP BY config_hash, status`,
      [r.id, rows.flatMap((a) => a.reused_trial_ids)],
    );
    return rows.map((a) => {
      const c = { queued: 0, running: 0, done: 0, infra_failed: 0, abandoned: 0, cancelled: 0 };
      for (const row of counts.filter((x) => x.config_hash === a.config_hash)) c[row.status === 'claimed' ? 'running' : row.status] += row.n;
      const reused = a.reused_trial_ids.length > 0;
      const status: ArmView['status'] = reused
        ? 'complete'
        : a.paused_at
          ? 'paused'
          : r.status === 'created'
            ? 'not_started'
            : c.queued + c.running > 0
              ? 'active'
              : c.cancelled > 0
                ? 'stopped'
                : 'complete';
      return {
        arm: a.arm,
        config_hash: a.config_hash,
        config_name: a.config_name,
        status,
        paused_at: iso(a.paused_at),
        paused_reason: a.paused_reason,
        fix: a.paused_fix,
        counts: c,
        reused_from: reused ? r.parent_experiment_id : null,
        reused_trials: a.reused_trial_ids.length,
      };
    });
  }

  /**
   * The trial rows' own events (claims, failures, re-queues) are derived from them; the run's
   * state changes (pauses, resumes, the baseline decision) are stored in experiment_events.
   */
  private async events(r: ExperimentRow): Promise<ExperimentEvent[]> {
    const events: ExperimentEvent[] = [];
    const armOf = new Map(r.config_hashes.map((h, i) => [h, String.fromCharCode(65 + i)]));
    const add = (at: Date | null, kind: ExperimentEventKind, detail: string, trial: { id: string; attempt: number; config_hash?: string } | null = null): void => {
      const configHash = trial?.config_hash ?? null;
      if (at) {
        events.push({ at: at.toISOString(), kind, trial_id: trial?.id ?? null, attempt: trial?.attempt ?? null, arm: configHash ? (armOf.get(configHash) ?? null) : null, config_hash: configHash, detail });
      }
    };
    const stored = await this.db.query<{ at: Date; kind: ExperimentEventKind; detail: string; config_hash: string | null; trial_id: string | null; attempt: number | null }>(
      'SELECT at, kind, detail, config_hash, trial_id, attempt FROM experiment_events WHERE experiment_id = $1 ORDER BY at, id',
      [r.id],
    );
    for (const s of stored) {
      events.push({ at: s.at.toISOString(), kind: s.kind, trial_id: s.trial_id, attempt: s.attempt, arm: s.config_hash ? (armOf.get(s.config_hash) ?? null) : null, config_hash: s.config_hash, detail: s.detail });
    }
    add(r.created_at, 'created', `${r.config_hashes.length} configs x ${r.task_sha256s.length} tasks x N=${r.n}`);
    add(r.started_at, 'started', 'trials can be claimed');
    add(r.cancelled_at, 'cancelled', 'stopped: queued trials cancelled; claimed ones finish');
    add(r.finished_at, 'finished', 'every trial has finished');
    // Before migration 005 only the latest pause and resume were kept, on the experiment row.
    const pauses: ExperimentEventKind[] = ['paused', 'futility_pause', 'infra_guard_pause', 'spend_guard_pause'];
    if (!stored.some((s) => pauses.includes(s.kind))) add(r.paused_at, 'paused', r.paused_reason ?? 'paused');
    if (!stored.some((s) => s.kind === 'resumed')) add(r.resumed_at, 'resumed', 'claims resumed');
    const trials = await this.db.query<{
      id: string;
      attempt: number;
      status: TrialStatus;
      label: string | null;
      worker_id: string | null;
      claimed_at: Date | null;
      finished_at: Date | null;
      reported_at: Date | null;
      created_at: Date;
      problems: string[];
      task_id: string;
      config_hash: string;
      config_name: string;
    }>(
      `SELECT t.id, t.attempt, t.status, t.label, t.worker_id, t.claimed_at, t.finished_at, t.reported_at, t.created_at,
              t.problems, k.id AS task_id, t.config_hash, c.name AS config_name
       FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256 JOIN configs c ON c.hash = t.config_hash
       WHERE t.experiment_id = $1`,
      [r.id],
    );
    for (const t of trials) {
      const what = `${t.task_id} on ${t.config_name}, attempt ${t.attempt}`;
      add(t.claimed_at, 'claim', `${what} claimed by ${t.worker_id ?? 'unknown'}`, t);
      if (t.attempt > 1) add(t.created_at, 'requeue', `${what} queued`, t);
      if (t.status === 'infra_failed') {
        const kind = t.label === 'infra:budget_net' ? 'budget_trip' : t.label === 'infra:config_error' ? 'config_error' : 'infra_failure';
        add(t.finished_at, kind, `${what}: ${t.label ?? 'infra'}`, t);
      }
      if (t.status === 'abandoned') add(t.finished_at, 'abandoned', `${what}: no heartbeat for 60 s`, t);
      if (t.problems.length) add(t.reported_at, 'file_problem', `${what}: ${t.problems.join('; ')}`, t);
    }
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 1000);
  }

  async trials(id: string, filter: { status?: string; config?: string; task?: string }): Promise<TrialRowSummary[]> {
    await this.row(id);
    const where = ['t.experiment_id = $1'];
    const params: unknown[] = [id];
    if (filter.status) {
      const statuses = filter.status.split(',');
      const bad = statuses.find((s) => !(TRIAL_STATUSES as readonly string[]).includes(s));
      if (bad) throw badRequest('invalid_filter', `${bad} is not a trial status`);
      params.push(statuses);
      where.push(`t.status = ANY($${params.length})`);
    }
    if (filter.config) {
      params.push(normalizeSha(filter.config) ?? filter.config);
      where.push(`t.config_hash = $${params.length}`);
    }
    if (filter.task) {
      params.push(normalizeSha(filter.task) ?? filter.task);
      where.push(`(t.task_sha256 = $${params.length} OR k.id = $${params.length})`);
    }
    const rows = await this.db.query<TrialSummaryRow>(`${TRIAL_SUMMARY_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.seq, t.attempt`, params);
    return rows.map(trialRowSummary);
  }

  /** Why no comparison can be offered yet (D37, D32), or null when every arm is complete. */
  private incompleteReason(r: ExperimentRow, arms: ArmView[]): string | null {
    if (r.status === 'created') return 'the experiment has not been started';
    const paused = arms.filter((a) => a.status === 'paused');
    if (paused.length) return paused.map((a) => `arm ${a.arm} is paused: ${a.paused_reason ?? 'paused'}`).join('; ');
    const stopped = arms.filter((a) => a.status === 'stopped');
    if (stopped.length) {
      return (
        `the experiment was stopped before every trial ran (${stopped.map((a) => `${a.counts.cancelled} of arm ${a.arm}'s trials cancelled`).join(', ')}); ` +
        'a verdict needs the full planned N (D32)'
      );
    }
    if (r.status === 'paused') return `the experiment is paused: ${r.paused_reason ?? 'paused'}`;
    const active = arms.filter((a) => a.status === 'active');
    if (active.length) return active.map((a) => `arm ${a.arm} has ${a.counts.queued + a.counts.running} trials queued or running`).join('; ');
    return null;
  }

  async compare(id: string): Promise<CompareResponse> {
    const r = await this.row(id);
    const arms = await this.arms(r);
    const reason = this.incompleteReason(r, arms);
    if (reason) return { experiment_id: id, status: 'incomplete', reason, arms, rows: [], stats: null };
    const armOf = new Map(arms.map((a) => [a.config_hash, a.arm]));
    const rows = await this.db.query<{
      task: string;
      task_id: string;
      config: string;
      config_name: string;
      trials: number;
      graded: number;
      passed: number;
      infra_failed: number;
      abandoned: number;
    }>(
      `SELECT t.task_sha256 AS task, k.id AS task_id, t.config_hash AS config, c.name AS config_name,
              count(*) FILTER (WHERE t.status = 'done')::int AS trials,
              count(*) FILTER (WHERE t.status = 'done' AND g.n > 0)::int AS graded,
              count(*) FILTER (WHERE t.status = 'done' AND g.n > 0 AND g.n = g.passed)::int AS passed,
              count(*) FILTER (WHERE t.status = 'infra_failed')::int AS infra_failed,
              count(*) FILTER (WHERE t.status = 'abandoned')::int AS abandoned
       FROM trials t
       JOIN tasks k ON k.sha256 = t.task_sha256
       JOIN configs c ON c.hash = t.config_hash
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n, count(*) FILTER (WHERE verdict = 'pass')::int AS passed FROM grades WHERE trial_id = t.id
       ) g ON true
       -- D34: a reused arm A's rows are the parent's trials it took.
       WHERE t.experiment_id = $1 OR t.id IN (SELECT unnest(reused_trial_ids) FROM experiment_arms WHERE experiment_id = $1)
       GROUP BY t.task_sha256, k.id, t.config_hash, c.name`,
      [id],
    );
    const order = (task: string, config: string): number => r.task_sha256s.indexOf(task) * 1000 + r.config_hashes.indexOf(config);
    rows.sort((a, b) => order(a.task, a.config) - order(b.task, b.config));
    return {
      experiment_id: id,
      status: 'complete',
      reason: null,
      arms,
      rows: rows.map((row) => ({ ...row, arm: armOf.get(row.config) ?? '?' })),
      stats: null,
    };
  }
}

export interface TrialSummaryRow {
  id: string;
  experiment_id: string;
  task_sha256: string;
  task_id: string;
  config_hash: string;
  config_name: string;
  harness: string;
  model: string;
  repeat_index: number;
  order_index: number;
  attempt: number;
  status: TrialStatus;
  label: string | null;
  end_state: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_calls: number | null;
  wall_s: number | null;
  worker_id: string | null;
  claimed_at: Date | null;
  finished_at: Date | null;
}

export const TRIAL_SUMMARY_SELECT = `
  SELECT t.id, t.experiment_id, t.task_sha256, k.id AS task_id, t.config_hash, c.name AS config_name, c.harness, c.model,
         t.repeat_index, t.order_index, t.attempt, t.status, t.label, t.end_state, t.cost_usd, t.input_tokens, t.output_tokens,
         t.model_calls, t.wall_s, t.worker_id, t.claimed_at, t.finished_at
  FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256 JOIN configs c ON c.hash = t.config_hash`;

export function trialRowSummary(r: TrialSummaryRow): TrialRowSummary {
  return { ...r, claimed_at: iso(r.claimed_at), finished_at: iso(r.finished_at) };
}

function shaList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('invalid_experiment', `${field} must be a non-empty list`);
  const out = value.map((v) => {
    const sha = normalizeSha(v);
    if (!sha) throw badRequest('invalid_experiment', `${field} holds ${String(v)}, which is not sha256:<64 hex>`);
    return sha;
  });
  if (new Set(out).size !== out.length) throw badRequest('invalid_experiment', `${field} lists the same hash twice`);
  return out;
}

export function isSimTask(t: StoredTask): boolean {
  const sim = t.body.client_sim;
  return typeof sim === 'object' && sim !== null && !Array.isArray(sim);
}

function simTurns(t: StoredTask): number {
  const sim = t.body.client_sim as Record<string, unknown>;
  return typeof sim.max_client_turns === 'number' ? sim.max_client_turns : 1;
}
