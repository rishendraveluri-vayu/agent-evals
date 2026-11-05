import { Inject, Injectable } from '@nestjs/common';
import type {
  AaCalibration,
  ActualSoFar,
  ArmView,
  CompareResponse,
  ProseFiguresArm,
  CompareRow,
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
  GraderSeverity,
  GradingJobStatus,
  GradingOutcome,
  StartExperimentRequest,
  TrialGradingState,
  TrialRowSummary,
  TrialStatus,
} from '../contract';
import { EXPERIMENT_NAME_MAX, GRADER_SEVERITIES, TRIAL_STATUSES } from '../contract';
import { badRequest, conflict, notFound } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { hashCanonical, normalizeSha } from '../common/hashing';
import { type AnalysisResult, STATS_METHOD_VERSION, type TaskInput, type TrialInput, analyse } from '../stats/analysis';
import { newId } from '../common/ids';
import { CatalogueService, type StoredPrompt, type StoredTask, taskView } from '../catalogue/catalogue.service';
import { CONFIG_SELECT, type ConfigRow, configView } from '../configs/configs.service';
import { Db, type Queryable } from '../database/db.service';
import { NOT_EXAMPLE_TRIAL, assertNotExample } from '../examples/example-guard';
import { JudgeService } from '../judge/judge.service';
import { LiteLlmClient } from '../litellm/litellm.client';
import { SIM_MAX_OUTPUT_TOKENS, simTemperature } from '../worker/spec-builder';
import { type CellInput, type History, LIVE_WORKER_S, type Price, estimate, isFakeModel } from './estimate';
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
  // 011: a shipped example (SP7), loaded by POST /examples/:name/load; read-only.
  example_name: string | null;
  example_title: string | null;
  example_loaded_at: Date | null;
  // 012: D44, an A/A calibration run (one config on both arms; arm B's repeats are n to 2n - 1).
  calibration: boolean;
}

/**
 * Which arm a trial ran in (0 is A): by its config's place, or in an A/A calibration run (one
 * config twice, D44) by its repeat, arm B's being n to 2n - 1. The UI's armIndexOf and the
 * export's armOf read it the same way.
 */
export function armIndex(r: Pick<ExperimentRow, 'config_hashes' | 'n' | 'calibration'>, configHash: string, repeatIndex: number): number {
  if (r.calibration) return repeatIndex >= r.n ? 1 : 0;
  return r.config_hashes.indexOf(configHash);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The name every screen shows for an experiment: a shipped example's title (its manifest's), else
 * the experiment's own name. The stored name is never changed: an example keeps the working name
 * it was run under on the machine it came from.
 */
export function experimentTitle(r: Pick<ExperimentRow, 'name' | 'example_name' | 'example_title'>): string {
  return r.example_name !== null && r.example_title ? r.example_title : r.name;
}

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
  /** Every model the run calls (the arms' and, when a task needs one, the simulator's) is `fake/*`. */
  fakeOnly: boolean;
  /** D44: one config on both arms. */
  calibration: boolean;
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
    const calibration = calibrationOf(body);
    const configHashes = calibration ? calibrationHashes(body.config_hashes) : shaList(body.config_hashes, 'config_hashes');
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
    type Row = { trials: number; input_tokens: number; output_tokens: number; wall_s: number | null; slot_s: number | null; cost_usd: number | null };
    // Probes (D33) render a prompt on the fake model; they are never history.
    // Nor are a shipped example's trials (SP7): they are not this database's own runs.
    const finished = `t.status = 'done' AND NOT t.probe AND t.input_tokens IS NOT NULL AND t.output_tokens IS NOT NULL AND t.proxy_complete IS NOT FALSE AND ${NOT_EXAMPLE_TRIAL('t')}`;
    // A trial's time is its worker's slot, claim to report; wall_s (the agent's own run) leaves out
    // starting the trial and uploading its files, about half of a fake trial's slot.
    const means = `count(*)::int AS trials, avg(t.input_tokens)::float8 AS input_tokens, avg(t.output_tokens)::float8 AS output_tokens,
                   avg(t.wall_s)::float8 AS wall_s, avg(extract(epoch FROM (t.finished_at - t.claimed_at)))::float8 AS slot_s,
                   avg(t.cost_usd)::float8 AS cost_usd`;
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
           WHERE t.status = 'done' AND t.sim_cost_usd IS NOT NULL AND e.sim_model = $1 AND t.task_sha256 = ANY($2) AND e.example_name IS NULL
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
      r ? { trials: r.trials, inputTokens: r.input_tokens, outputTokens: r.output_tokens, wallS: r.wall_s, slotS: r.slot_s, costUsd: r.cost_usd } : null;
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
    return {
      ...ordered,
      n,
      simModel: needsSim ? simModel : null,
      estimate: estimate({ cells, n, prices, simModel: needsSim ? simModel : null, workers }),
      fakeOnly: [...prices.keys()].every(isFakeModel),
      calibration,
    };
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
    if (plan.calibration) {
      throw badRequest('invalid_calibration', 'an A/A calibration run cannot reuse a parent\'s trials: both of its arms must run side by side', 'Leave reuse_baseline out.');
    }
    if (!parent) throw badRequest('invalid_experiment', 'reuse_baseline needs parent_experiment_id', 'Name the parent experiment whose arm-A trials to reuse, or leave reuse_baseline out.');
    // SP7: an example's trials stay apart from your own runs, so they are never your arm A.
    if (parent.example_name !== null) {
      throw conflict(
        'example_read_only',
        `experiment ${parent.id} is the shipped example ${parent.example_name}, so its trials cannot be reused as your arm A`,
        'Leave reuse_baseline out: arm A then runs in your own experiment.',
      );
    }
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
    if (name.length > EXPERIMENT_NAME_MAX) {
      throw badRequest('invalid_experiment', `name is ${name.length} characters, longer than the ${EXPERIMENT_NAME_MAX} allowed`, `Shorten the name to ${EXPERIMENT_NAME_MAX} characters or fewer.`);
    }
    const axis = typeof body.axis === 'string' ? body.axis.trim() : '';
    if (!axis) throw badRequest('invalid_experiment', 'axis is required: the one thing the configs differ on');
    if (typeof body.budget_usd !== 'number' || !Number.isFinite(body.budget_usd) || body.budget_usd <= 0) {
      throw badRequest('invalid_experiment', 'budget_usd must be a number above 0');
    }
    const planCommit = planCommitOf(body.plan_commit);
    const { plan, simPrompt, parentId, baseline, run } = await this.resolveRun(body);
    // R10.6: start only runs that can finish. The budget is a safety net, so it must cover
    // the top of the estimate's range, not just the expected cost. With arm A reused (D34),
    // the estimate is of arm B alone. A run on fake models only spends nothing real (their prices
    // are made up for testing), so it is never refused; its budget is raised to the estimate's
    // high end instead, so neither LiteLLM's cap nor the spend guard stops it part-way.
    const budgetUsd = run.fakeOnly ? Math.max(body.budget_usd, run.estimate.cost_usd.high) : body.budget_usd;
    if (!run.fakeOnly && body.budget_usd < run.estimate.cost_usd.high) {
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
    // A41: left out, the futility check is off when nothing in the run spends (fake models only),
    // by the same reading of the run as the budget rule above.
    const futility = resolveFutility(body.futility, { fakeOnly: run.fakeOnly });

    const id = newId('e');
    const slots: { id: string; task: string; config: string; harness: string; repeat: number; seq: number; order: number }[] = [];
    // D32: claims follow a seeded shuffle of (task, repeat) blocks with the arms in a random
    // order inside each block, so the arms alternate and any early batch is a random sample.
    // `seq` stays the slot's place in the plan (repeat, task, config), a stable number for paging.
    // With arm A reused (D34), only arm B's trials are queued.
    // D44: an A/A calibration run has one config on both arms. The shuffle orders arms, so arm B gets
    // its own key; its trials are told apart by repeat_index, which runs from n to 2n - 1.
    const armKeys = run.configs.map((c, i) => (run.calibration && i === 1 ? `${c.hash}#B` : c.hash));
    const order = new Map(claimOrder(run.tasks.map((t) => t.sha256), armKeys, run.n, seed).map((s, i) => [`${s.task}|${s.config}|${s.repeat}`, i]));
    let seq = 0;
    for (let r = 0; r < run.n; r += 1) {
      for (const t of run.tasks) {
        run.configs.forEach((c, i) => {
          const at = order.get(`${t.sha256}|${armKeys[i]}|${r}`) as number;
          const repeat = run.calibration && i === 1 ? run.n + r : r;
          slots.push({ id: newId('t'), task: t.sha256, config: c.hash, harness: c.harness, repeat, seq: seq++, order: at });
        });
      }
    }
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO experiments (id, name, axis, config_hashes, task_sha256s, n, sim_model, sim_prompt_sha256,
                                  sim_temperature, sim_max_output_tokens, budget_usd, trial_budget_usd, sim_budget_usd,
                                  platform_commit, plan_commit, estimate, status, order_seed, futility,
                                  parent_experiment_id, reuse_baseline, baseline_decision, calibration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'created', $17, $18, $19, $20, $21, $22)`,
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
          budgetUsd,
          run.estimate.budgets.trial_usd,
          run.estimate.budgets.sim_usd,
          this.config.platformCommit,
          planCommit,
          JSON.stringify(run.estimate),
          seed,
          JSON.stringify(futility),
          parentId,
          baseline !== null,
          baseline?.reason ?? null,
          plan.calibration,
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
      const teamId = await this.litellm.newTeam({ alias: `experiment:${id}`, maxBudgetUsd: budgetUsd, experimentId: id });
      await client.query('UPDATE experiments SET litellm_team_id = $2 WHERE id = $1', [id, teamId]);
    });
    return this.get(id);
  }

  // ---- lifecycle ----

  /**
   * Starts a created experiment, or resumes a paused one; a running one is left as it is. An
   * unstarted experiment can be given its analysis plan commit here (`plan_commit`), so one left
   * without it can still be started; once it has started the plan commit is fixed.
   */
  async start(id: string, body?: StartExperimentRequest | null): Promise<ExperimentDetail> {
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw badRequest('invalid_experiment', 'the body must be a JSON object or empty');
    }
    const planCommit = planCommitOf(body?.plan_commit);
    const exp = await this.row(id);
    assertNotExample(exp, 'be started');
    if (exp.status === 'done' || exp.status === 'cancelled') {
      throw conflict('experiment_finished', `experiment ${id} is ${exp.status} and cannot start again`, 'Create a new experiment, with this one as its parent.');
    }
    if (planCommit !== null && exp.status !== 'created' && planCommit !== exp.plan_commit) {
      throw conflict(
        'plan_commit_locked',
        `experiment ${id} has started, so its plan commit is fixed${exp.plan_commit ? ` at ${exp.plan_commit}` : ' (none was given)'}`,
        'Leave plan_commit out to resume it, or create a new experiment with the plan commit.',
      );
    }
    if (exp.status === 'paused') return this.resume(id);
    await this.db.tx(async (client) => {
      if (planCommit !== null) await client.query(`UPDATE experiments SET plan_commit = $2 WHERE id = $1 AND status = 'created'`, [id, planCommit]);
      await client.query(`UPDATE experiments SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = $1 AND status = 'created'`, [id]);
      await finishIfDone(client, id);
    });
    return this.get(id);
  }

  /**
   * Discards an experiment that never started: it is marked `cancelled` and its queued trials
   * `cancelled`, as a stop does, and nothing is deleted. Only while it is `created` and none of its
   * trials has been claimed; anything else is a 409, so a started run is never discarded.
   */
  async discard(id: string): Promise<ExperimentDetail> {
    assertNotExample(await this.row(id), 'be discarded');
    await this.db.tx(async (client) => {
      const { rows } = await client.query<{ status: ExperimentStatus; started_at: Date | null }>('SELECT status, started_at FROM experiments WHERE id = $1 FOR UPDATE', [id]);
      const exp = rows[0];
      const { rows: ran } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM trials WHERE experiment_id = $1 AND status <> 'queued'`, [id]);
      if (exp.status === 'done' || exp.status === 'cancelled') {
        throw conflict('experiment_finished', `experiment ${id} is ${exp.status}, so there is nothing to discard`, 'Leave it as it is; its trials are kept either way.');
      }
      if (exp.status !== 'created' || exp.started_at !== null || ran[0].n > 0) {
        throw conflict(
          'experiment_started',
          `experiment ${id} has started (${exp.status}${ran[0].n ? `, ${ran[0].n} trial${ran[0].n === 1 ? '' : 's'} claimed or finished` : ''}), so it cannot be discarded`,
          'Stop it instead: its queued trials are cancelled and the finished ones kept.',
        );
      }
      await client.query(`UPDATE experiments SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [id]);
      await client.query(`UPDATE trials SET status = 'cancelled', finished_at = now() WHERE experiment_id = $1 AND status = 'queued'`, [id]);
      await addEvent(client, { experimentId: id, kind: 'discarded', detail: 'discarded before it started: nothing ran, and nothing was deleted' });
    });
    return this.get(id);
  }

  /** D32: stops new claims; trials already running finish and report. A paused one stays paused. */
  async pause(id: string): Promise<ExperimentDetail> {
    const exp = await this.row(id);
    assertNotExample(exp, 'be paused');
    if (exp.status === 'created') throw conflict('experiment_not_started', `experiment ${id} has not started`, 'Start it, or stop it; there is nothing to pause yet.');
    if (exp.status === 'done' || exp.status === 'cancelled') throw conflict('experiment_finished', `experiment ${id} is ${exp.status}`);
    await this.db.tx((client) => pauseExperiment(client, id, 'paused', 'paused by hand: new claims stop; trials already running finish'));
    return this.get(id);
  }

  /** Resumes a paused experiment (whatever paused it); arm pauses are separate (D37). */
  async resume(id: string): Promise<ExperimentDetail> {
    const exp = await this.row(id);
    assertNotExample(exp, 'be resumed');
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
    assertNotExample(exp, 'be stopped');
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
    // By letter, or by hash: in a calibration run (D44) a hash names both arms, and this takes arm A.
    const [arm] = await this.db.query<ArmRow>('SELECT * FROM experiment_arms WHERE experiment_id = $1 AND (config_hash = $2 OR arm = $3) ORDER BY position LIMIT 1', [
      exp.id,
      hash,
      configHash.toUpperCase(),
    ]);
    if (!arm) throw notFound('unknown_arm', `experiment ${id} has no arm ${configHash}`, `Use one of the experiment's config hashes: ${exp.config_hashes.join(', ')}.`);
    return arm;
  }

  /** D37: pauses one arm by hand. Its queued trials wait; the other arm keeps claiming. */
  async pauseArm(id: string, configHash: string): Promise<ExperimentDetail> {
    const arm = await this.armRow(id, configHash);
    const exp = await this.row(id);
    assertNotExample(exp, 'have an arm paused');
    if (exp.status === 'done' || exp.status === 'cancelled') throw conflict('experiment_finished', `experiment ${id} is ${exp.status}`);
    await this.db.tx((client) =>
      pauseArm(
        client,
        id,
        arm.config_hash,
        'paused by hand: this arm claims nothing more; its running trials finish',
        // D44: in a calibration run the hash names both arms, so the fix names the arm's letter.
        `POST /experiments/${id}/arms/${exp.calibration ? arm.arm : arm.config_hash}/resume to continue it.`,
        null,
        arm.arm,
      ),
    );
    return this.get(id);
  }

  /** D37: resumes a paused arm; its queued trials can be claimed again. */
  async resumeArm(id: string, configHash: string): Promise<ExperimentDetail> {
    const arm = await this.armRow(id, configHash);
    assertNotExample(await this.row(id), 'have an arm resumed');
    await this.db.tx(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE experiment_arms SET paused_at = NULL, paused_reason = NULL, paused_fix = NULL, resumed_at = now()
         WHERE experiment_id = $1 AND arm = $2 AND paused_at IS NOT NULL`,
        [id, arm.arm],
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
      calibration: r.calibration,
      example:
        r.example_name !== null
          ? { name: r.example_name, title: r.example_title ?? r.name, loaded_at: (r.example_loaded_at ?? r.created_at).toISOString() }
          : null,
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
    // D44: a calibration run's arms share one config; `second` says which arm (repeats n to 2n - 1 are B's).
    const counts = await this.db.query<{ config_hash: string; second: boolean; status: TrialStatus; n: number }>(
      `SELECT config_hash, ($3::boolean AND repeat_index >= $4) AS second, status, count(*)::int AS n FROM trials
       WHERE experiment_id = $1 OR id = ANY($2) GROUP BY 1, 2, 3`,
      [r.id, rows.flatMap((a) => a.reused_trial_ids), r.calibration, r.n],
    );
    return rows.map((a) => {
      const c = { queued: 0, running: 0, done: 0, infra_failed: 0, abandoned: 0, cancelled: 0 };
      const mine = counts.filter((x) => x.config_hash === a.config_hash && (!r.calibration || x.second === (a.position === 1)));
      for (const row of mine) c[row.status === 'claimed' ? 'running' : row.status] += row.n;
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
    // D44: in a calibration run one config is both arms, so only a trial's repeat says which.
    const armOf = (configHash: string | null, repeat?: number): string | null => {
      if (!configHash || (r.calibration && repeat === undefined)) return null;
      const i = armIndex(r, configHash, repeat ?? 0);
      return i < 0 ? null : String.fromCharCode(65 + i);
    };
    const add = (at: Date | null, kind: ExperimentEventKind, detail: string, trial: { id: string; attempt: number; config_hash?: string; repeat_index?: number } | null = null): void => {
      const configHash = trial?.config_hash ?? null;
      if (at) {
        events.push({ at: at.toISOString(), kind, trial_id: trial?.id ?? null, attempt: trial?.attempt ?? null, arm: armOf(configHash, trial?.repeat_index), config_hash: configHash, detail });
      }
    };
    const stored = await this.db.query<{ at: Date; kind: ExperimentEventKind; detail: string; config_hash: string | null; trial_id: string | null; attempt: number | null }>(
      'SELECT at, kind, detail, config_hash, trial_id, attempt FROM experiment_events WHERE experiment_id = $1 ORDER BY at, id',
      [r.id],
    );
    for (const s of stored) {
      events.push({ at: s.at.toISOString(), kind: s.kind, trial_id: s.trial_id, attempt: s.attempt, arm: armOf(s.config_hash), config_hash: s.config_hash, detail: s.detail });
    }
    add(r.created_at, 'created', `${r.config_hashes.length} configs x ${r.task_sha256s.length} tasks x N=${r.n}`);
    add(r.started_at, 'started', 'trials can be claimed');
    // A discarded experiment (never started) has its own stored event; it was not stopped mid-run.
    if (!stored.some((s) => s.kind === 'discarded')) add(r.cancelled_at, 'cancelled', 'stopped: queued trials cancelled; claimed ones finish');
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
      repeat_index: number;
    }>(
      `SELECT t.id, t.attempt, t.status, t.label, t.worker_id, t.claimed_at, t.finished_at, t.reported_at, t.created_at,
              t.problems, k.id AS task_id, t.config_hash, c.name AS config_name, t.repeat_index
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
    if (reason) return { experiment_id: id, status: 'incomplete', reason, arms, rows: [], stats: null, stats_note: null, prose_figures: [] };
    const rows = await this.compareRows(r, arms);
    const { stats, note } = await this.statsOf(r, arms);
    const prose_figures = await this.proseFigures(r, arms);
    return { experiment_id: id, status: 'complete', reason: null, arms, rows, stats, stats_note: note, prose_figures };
  }

  /**
   * D61: per arm, how many money figures the done trials' agents wrote without a tool, from the
   * counts the runner puts in each runner report (`checks.amounts`, `checks.derived_in_prose`).
   * A trial whose report lacks them (checks from before D61) is counted as unmeasured.
   */
  private async proseFigures(r: ExperimentRow, arms: ArmView[]): Promise<ProseFiguresArm[]> {
    const armOf = new Map(arms.map((a) => [a.config_hash, a.arm]));
    const rows = await this.db.query<{ config: string; second: boolean; measured: number; unmeasured: number; amounts: number; derived: number }>(
      `SELECT t.config_hash AS config, ($2::boolean AND t.repeat_index >= $3) AS second,
              count(*) FILTER (WHERE m.derived IS NOT NULL)::int AS measured,
              count(*) FILTER (WHERE m.derived IS NULL)::int AS unmeasured,
              coalesce(sum(m.amounts) FILTER (WHERE m.derived IS NOT NULL), 0)::int AS amounts,
              coalesce(sum(m.derived), 0)::int AS derived
       FROM trials t
       CROSS JOIN LATERAL (
         SELECT CASE WHEN jsonb_typeof(t.runner_report -> 'checks' -> 'derived_in_prose') = 'number'
                     AND jsonb_typeof(t.runner_report -> 'checks' -> 'amounts') = 'number'
                THEN (t.runner_report -> 'checks' ->> 'derived_in_prose')::int END AS derived,
                CASE WHEN jsonb_typeof(t.runner_report -> 'checks' -> 'amounts') = 'number'
                THEN (t.runner_report -> 'checks' ->> 'amounts')::int END AS amounts
       ) m
       WHERE t.status = 'done'
         AND (t.experiment_id = $1 OR t.id IN (SELECT unnest(reused_trial_ids) FROM experiment_arms WHERE experiment_id = $1))
       GROUP BY t.config_hash, 2`,
      [r.id, r.calibration, r.n],
    );
    const byArm = new Map<string, ProseFiguresArm>();
    for (const a of arms) {
      byArm.set(a.arm, { arm: a.arm, trials_measured: 0, trials_unmeasured: 0, amounts: 0, derived_in_prose: 0, per_trial: null, share: null });
    }
    for (const row of rows) {
      const arm = r.calibration ? (row.second ? 'B' : 'A') : armOf.get(row.config);
      const out = arm === undefined ? undefined : byArm.get(arm);
      if (!out) continue;
      out.trials_measured += row.measured;
      out.trials_unmeasured += row.unmeasured;
      out.amounts += row.amounts;
      out.derived_in_prose += row.derived;
    }
    return [...byArm.values()].map((a) => ({
      ...a,
      per_trial: a.trials_measured ? a.derived_in_prose / a.trials_measured : null,
      share: a.amounts ? a.derived_in_prose / a.amounts : null,
    }));
  }

  /** Per task and arm: the counts the comparison table shows (and SP6's statistics start from). */
  private async compareRows(r: ExperimentRow, arms: ArmView[]): Promise<CompareRow[]> {
    const armOf = new Map(arms.map((a) => [a.config_hash, a.arm]));
    const rows = await this.db.query<{
      task: string;
      task_id: string;
      config: string;
      config_name: string;
      second: boolean;
      trials: number;
      graded: number;
      passed: number;
      incomplete: number;
      infra_failed: number;
      abandoned: number;
    }>(
      // A trial's outcome is its latest finished grading job's, as on the run grid and the trial
      // page: pass when every required grader passed, fail when one failed, incomplete otherwise
      // (grader format, "The task's outcome"). Older grade versions and optional graders do not count.
      // D44: a calibration run's one config is both arms; `second` is arm B (repeats n to 2n - 1).
      `SELECT t.task_sha256 AS task, k.id AS task_id, t.config_hash AS config, c.name AS config_name,
              ($2::boolean AND t.repeat_index >= $3) AS second,
              count(*) FILTER (WHERE t.status = 'done')::int AS trials,
              count(*) FILTER (WHERE t.status = 'done' AND g.outcome IN ('pass', 'fail'))::int AS graded,
              count(*) FILTER (WHERE t.status = 'done' AND g.outcome = 'pass')::int AS passed,
              count(*) FILTER (WHERE t.status = 'done' AND g.status = 'done' AND (g.outcome IS NULL OR g.outcome = 'incomplete'))::int AS incomplete,
              count(*) FILTER (WHERE t.status = 'infra_failed')::int AS infra_failed,
              count(*) FILTER (WHERE t.status = 'abandoned')::int AS abandoned
       FROM trials t
       JOIN tasks k ON k.sha256 = t.task_sha256
       JOIN configs c ON c.hash = t.config_hash
       LEFT JOIN LATERAL (
         SELECT j.status, j.outcome FROM grading_jobs j
         WHERE j.trial_id = t.id AND j.status IN ('done', 'no_graders') ORDER BY j.created_at DESC, j.id DESC LIMIT 1
       ) g ON true
       -- D34: a reused arm A's rows are the parent's trials it took.
       WHERE t.experiment_id = $1 OR t.id IN (SELECT unnest(reused_trial_ids) FROM experiment_arms WHERE experiment_id = $1)
       GROUP BY t.task_sha256, k.id, t.config_hash, c.name, 5`,
      [r.id, r.calibration, r.n],
    );
    const order = (row: { task: string; config: string; second: boolean }): number =>
      r.task_sha256s.indexOf(row.task) * 1000 + (r.calibration ? Number(row.second) : r.config_hashes.indexOf(row.config));
    rows.sort((a, b) => order(a) - order(b));
    return rows.map(({ second, ...row }) => ({ ...row, arm: r.calibration ? (second ? 'B' : 'A') : (armOf.get(row.config) ?? '?') }));
  }

  // ---- statistics (SP6) ----

  /** Computed statistics, keyed by the experiment and the exact grading they rest on, so a regrade recomputes. */
  private readonly statsCache = new Map<string, AnalysisResult>();

  /**
   * SP6: the verdict and intervals (stats/analysis.ts) from each done trial's current grading. Null,
   * with a note, while grading is still running, for a pilot of one config, or when no task has a
   * decided trial in both arms. Cached by the trials and grading jobs it reads.
   */
  private async statsOf(r: ExperimentRow, arms: ArmView[], withAa = true): Promise<AnalysisResult> {
    if (arms.length < 2) return { stats: null, note: 'A pilot of one config has nothing to compare it with, so there is no verdict.' };
    const trials = await this.db.query<StatsTrialRow>(
      `SELECT t.id, t.task_sha256, t.config_hash, t.repeat_index, t.cost_usd, t.input_tokens, t.output_tokens, t.wall_s,
              t.runner_report -> 'proxy_usage' ->> 'retried_calls' AS retried_calls,
              gd.id AS job_id, gd.status AS job_status, gd.outcome, gd.graders, gd.grade_ids::text[] AS grade_ids,
              gl.status AS latest_status, sp.attempts_known, sp.retried AS span_retried
       FROM trials t
       LEFT JOIN LATERAL (
         SELECT j.id, j.status, j.outcome, j.graders, j.grade_ids FROM grading_jobs j
         WHERE j.trial_id = t.id AND j.status IN ('done', 'no_graders') ORDER BY j.created_at DESC, j.id DESC LIMIT 1
       ) gd ON true
       LEFT JOIN LATERAL (
         SELECT j.status FROM grading_jobs j WHERE j.trial_id = t.id AND j.status <> 'superseded' ORDER BY j.created_at DESC, j.id DESC LIMIT 1
       ) gl ON true
       -- D16: LiteLLM's retries, from each model call's span (the agent's and the simulated client's).
       LEFT JOIN LATERAL (
         SELECT bool_or(s.attributes ->> 'evals.proxy.attempts' ~ '^[0-9]+$') AS attempts_known,
                bool_or(s.attributes ->> 'evals.proxy.attempts' ~ '^[0-9]+$' AND (s.attributes ->> 'evals.proxy.attempts')::int > 1) AS retried
         FROM spans s WHERE s.trial_id = t.id AND s.name LIKE 'chat %'
       ) sp ON true
       WHERE t.status = 'done'
         AND (t.experiment_id = $1 OR t.id IN (SELECT unnest(reused_trial_ids) FROM experiment_arms WHERE experiment_id = $1))
       ORDER BY t.task_sha256, t.repeat_index, t.attempt, t.id`,
      [r.id],
    );
    const waiting = trials.filter((t) => t.latest_status === null || t.latest_status === 'queued' || t.latest_status === 'claimed').length;
    if (waiting) {
      return { stats: null, note: `Grading is still running for ${waiting} of ${trials.length} finished ${trials.length === 1 ? 'trial' : 'trials'}; the verdict waits for every grade.` };
    }
    const key = `${STATS_METHOD_VERSION}|${r.id}|${hashCanonical(trials.map((t) => [t.id, t.job_id]))}`;
    let result = this.statsCache.get(key);
    if (!result) {
      const gradeIds = trials.flatMap((t) => t.grade_ids ?? []);
      const grades = gradeIds.length
        ? await this.db.query<StatsGradeRow>('SELECT trial_id, grader_id, required, verdict FROM grades WHERE id = ANY($1::bigint[]) ORDER BY id', [gradeIds])
        : [];
      const configs = await this.db.query<{ model: string }>('SELECT model FROM configs WHERE hash = ANY($1)', [r.config_hashes.slice(0, 2)]);
      const taskIds = new Map((await this.db.query<{ sha256: string; id: string }>('SELECT sha256, id FROM tasks WHERE sha256 = ANY($1)', [r.task_sha256s])).map((t) => [t.sha256, t.id]));
      result = analyse({ seed: r.id, tasks: statsTasks(r, trials, grades, taskIds), madeUpPrices: configs.some((c) => isFakeModel(c.model)), calibration: r.calibration });
      if (this.statsCache.size >= 200) this.statsCache.delete(this.statsCache.keys().next().value as string);
      this.statsCache.set(key, result);
    }
    if (!result.stats || !withAa || r.calibration) return result;
    return { ...result, stats: { ...result.stats, aa: await this.latestCalibration(r) } };
  }

  /** D44: the latest finished A/A calibration run of either arm's config, with its interval; null when there is none. */
  private async latestCalibration(r: ExperimentRow): Promise<AaCalibration | null> {
    const candidates = await this.db.query<ExperimentRow>(
      `SELECT * FROM experiments
       WHERE calibration AND status = 'done' AND example_name IS NULL AND id <> $2 AND config_hashes[1] = ANY($1)
       ORDER BY finished_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 5`,
      [r.config_hashes.slice(0, 2), r.id],
    );
    for (const c of candidates) {
      const arms = await this.arms(c);
      if (this.incompleteReason(c, arms)) continue;
      const { stats } = await this.statsOf(c, arms, false);
      if (!stats) continue;
      return { experiment_id: c.id, name: experimentTitle(c), config_hash: c.config_hashes[0], finished_at: iso(c.finished_at), diff: stats.diff, verdict: stats.verdict };
    }
    return null;
  }
}

/** One done trial as the statistics read it. */
interface StatsTrialRow {
  id: string;
  task_sha256: string;
  config_hash: string;
  repeat_index: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  wall_s: number | null;
  retried_calls: string | null;
  job_id: string | null;
  job_status: GradingJobStatus | null;
  outcome: GradingOutcome | null;
  /** The grader specs the job froze, from the task file it graded with: [{spec, spec_sha256}]. */
  graders: { spec?: { id?: unknown; severity?: unknown } }[] | null;
  grade_ids: string[] | null;
  latest_status: GradingJobStatus | null;
  attempts_known: boolean | null;
  span_retried: boolean | null;
}

interface StatsGradeRow {
  trial_id: string;
  grader_id: string;
  required: boolean;
  verdict: string | null;
}

/**
 * The analysis input from the trial rows: per task, in the experiment's order, each done trial's
 * arm, outcome, grades with each grader's severity (read from the grader specs of the grading that
 * produced them, i.e. the task file it graded with), cost, tokens, time, and whether LiteLLM
 * retried one of its model calls (D16).
 */
export function statsTasks(r: Pick<ExperimentRow, 'task_sha256s' | 'config_hashes' | 'n' | 'calibration'>, trials: StatsTrialRow[], grades: StatsGradeRow[], taskIds: Map<string, string>): TaskInput[] {
  const byTrial = new Map<string, StatsGradeRow[]>();
  for (const g of grades) byTrial.set(g.trial_id, [...(byTrial.get(g.trial_id) ?? []), g]);
  return r.task_sha256s.map((task) => ({
    task,
    task_id: taskIds.get(task) ?? task,
    trials: trials
      .filter((t) => t.task_sha256 === task)
      .flatMap((t): TrialInput[] => {
        const arm = armIndex(r, t.config_hash, t.repeat_index);
        if (arm !== 0 && arm !== 1) return [];
        const severity = new Map<string, GraderSeverity>();
        for (const g of t.graders ?? []) {
          const sev = g.spec?.severity;
          if (typeof g.spec?.id === 'string' && (GRADER_SEVERITIES as readonly unknown[]).includes(sev)) severity.set(g.spec.id, sev as GraderSeverity);
        }
        const retriedCalls = t.retried_calls !== null && /^[0-9]+$/.test(t.retried_calls) ? Number(t.retried_calls) : null;
        const retried = t.span_retried || (retriedCalls ?? 0) > 0 ? true : retriedCalls !== null || t.attempts_known ? false : null;
        return [
          {
            trial_id: t.id,
            arm: arm === 0 ? 'A' : 'B',
            outcome: t.job_status === 'done' && (t.outcome === 'pass' || t.outcome === 'fail') ? t.outcome : 'incomplete',
            grades: (byTrial.get(t.id) ?? []).map((g) => ({ grader_id: g.grader_id, required: g.required, verdict: g.verdict, severity: severity.get(g.grader_id) ?? null })),
            cost_usd: t.cost_usd,
            tokens: t.input_tokens === null && t.output_tokens === null ? null : (t.input_tokens ?? 0) + (t.output_tokens ?? 0),
            wall_s: t.wall_s,
            retried,
          },
        ];
      }),
  }));
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
  /** The latest finished grading job (done or no_graders), as GET /trials/:id's `grading.current`. */
  graded_status: GradingJobStatus | null;
  graded_passed: boolean | null;
  graded_outcome: GradingOutcome | null;
  /** The latest grading job that was not superseded, finished or not. */
  latest_job_status: GradingJobStatus | null;
}

export const TRIAL_SUMMARY_SELECT = `
  SELECT t.id, t.experiment_id, t.task_sha256, k.id AS task_id, t.config_hash, c.name AS config_name, c.harness, c.model,
         t.repeat_index, t.order_index, t.attempt, t.status, t.label, t.end_state, t.cost_usd, t.input_tokens, t.output_tokens,
         t.model_calls, t.wall_s, t.worker_id, t.claimed_at, t.finished_at,
         gd.status AS graded_status, gd.passed AS graded_passed, gd.outcome AS graded_outcome, gl.status AS latest_job_status
  FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256 JOIN configs c ON c.hash = t.config_hash
  LEFT JOIN LATERAL (
    SELECT j.status, j.passed, j.outcome FROM grading_jobs j
    WHERE j.trial_id = t.id AND j.status IN ('done', 'no_graders') ORDER BY j.created_at DESC, j.id DESC LIMIT 1
  ) gd ON true
  LEFT JOIN LATERAL (
    SELECT j.status FROM grading_jobs j WHERE j.trial_id = t.id AND j.status <> 'superseded' ORDER BY j.created_at DESC, j.id DESC LIMIT 1
  ) gl ON true`;

/** Where a trial's grading stands (contract TrialGradingState): its current outcome, or why there is none. */
export function gradingState(r: Pick<TrialSummaryRow, 'status' | 'graded_status' | 'graded_outcome' | 'latest_job_status'>): TrialGradingState {
  if (r.status !== 'done') return null;
  if (r.graded_status === 'done') return r.graded_outcome ?? 'incomplete';
  if (r.graded_status === 'no_graders') return 'no_graders';
  if (r.latest_job_status === 'failed') return 'grading_failed';
  return 'waiting';
}

export function trialRowSummary(r: TrialSummaryRow): TrialRowSummary {
  const grading = gradingState(r);
  return {
    id: r.id,
    experiment_id: r.experiment_id,
    task_sha256: r.task_sha256,
    task_id: r.task_id,
    config_hash: r.config_hash,
    config_name: r.config_name,
    harness: r.harness,
    model: r.model,
    repeat_index: r.repeat_index,
    order_index: r.order_index,
    attempt: r.attempt,
    status: r.status,
    label: r.label,
    end_state: r.end_state,
    cost_usd: r.cost_usd,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    model_calls: r.model_calls,
    wall_s: r.wall_s,
    worker_id: r.worker_id,
    claimed_at: iso(r.claimed_at),
    finished_at: iso(r.finished_at),
    passed: grading === 'pass' || grading === 'fail' ? r.graded_passed : null,
    grading,
  };
}

/** A git commit hash as `git rev-parse` prints it, short or full. */
export const PLAN_COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * The analysis plan's commit from a request: null when left out or blank, else 7 to 40 hex
 * characters, kept in lower case. Only the format is checked: the API cannot see git history, so
 * whether the commit exists or holds docs/experiment.md is the person's word.
 */
export function planCommitOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw badRequest('invalid_experiment', 'plan_commit must be a string or null');
  const commit = raw.trim().toLowerCase();
  if (!commit) return null;
  if (!PLAN_COMMIT.test(commit)) {
    throw badRequest(
      'invalid_plan_commit',
      `"${raw.trim().slice(0, 60)}" is not a git commit hash: a plan commit is 7 to 40 characters, each 0-9 or a-f`,
      'Commit docs/experiment.md first, then give the commit as `git rev-parse --short HEAD` prints it, or leave the plan commit empty.',
    );
  }
  return commit;
}

function shaList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest('invalid_experiment', `${field} must be a non-empty list`);
  const out = value.map((v) => {
    const sha = normalizeSha(v);
    if (!sha) throw badRequest('invalid_experiment', `${field} holds ${String(v)}, which is not sha256:<64 hex>`);
    return sha;
  });
  if (new Set(out).size !== out.length) {
    // A30: the same config twice is refused in plain words, unless the run is marked as an A/A calibration (D44).
    const hint = field === 'config_hashes' ? 'Pick a different config for one arm, or mark the run as an A/A calibration (calibration: true) to measure the setup\'s own noise.' : undefined;
    throw badRequest('invalid_experiment', `${field} lists the same hash twice`, hint);
  }
  return out;
}

/** D44: `calibration`, true or false; left out or null is false. */
export function calibrationOf(body: { calibration?: unknown }): boolean {
  const c = body.calibration;
  if (c === undefined || c === null) return false;
  if (typeof c !== 'boolean') throw badRequest('invalid_experiment', 'calibration must be true or false');
  return c;
}

/** D44: a calibration run names one config twice, arm A and arm B. */
function calibrationHashes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw badRequest('invalid_calibration', 'an A/A calibration run names one config twice, for arm A and arm B', 'Send config_hashes as [h, h], or leave calibration out for an ordinary run.');
  }
  const [a, b] = value.map((v) => normalizeSha(v));
  if (!a || !b) throw badRequest('invalid_experiment', `config_hashes holds ${String(a ? value[1] : value[0])}, which is not sha256:<64 hex>`);
  if (a !== b) {
    throw badRequest('invalid_calibration', 'an A/A calibration run puts the same config on both arms; these are two different configs', 'Name one config twice, or leave calibration out to compare two configs.');
  }
  return [a, b];
}

export function isSimTask(t: StoredTask): boolean {
  const sim = t.body.client_sim;
  return typeof sim === 'object' && sim !== null && !Array.isArray(sim);
}

function simTurns(t: StoredTask): number {
  const sim = t.body.client_sim as Record<string, unknown>;
  return typeof sim.max_client_turns === 'number' ? sim.max_client_turns : 1;
}
