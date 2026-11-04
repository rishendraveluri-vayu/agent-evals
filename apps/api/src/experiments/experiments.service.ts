import { Inject, Injectable } from '@nestjs/common';
import type {
  CompareResponse,
  CreateExperimentRequest,
  Estimate,
  EstimateRequest,
  ExperimentCounts,
  ExperimentDetail,
  ExperimentEvent,
  ExperimentEventKind,
  ExperimentStatus,
  ExperimentSummary,
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
import { LiteLlmClient } from '../litellm/litellm.client';
import { SIM_MAX_OUTPUT_TOKENS, simTemperature } from '../worker/spec-builder';
import { type CellInput, type Price, estimate } from './estimate';

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
  ) {}

  // ---- planning ----

  private async plan(body: EstimateRequest): Promise<Plan> {
    if (typeof body !== 'object' || body === null) throw badRequest('invalid_experiment', 'the body must be a JSON object');
    const configHashes = shaList(body.config_hashes, 'config_hashes');
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

    const history = await this.db.query<{
      config_hash: string;
      task_sha256: string;
      trials: number;
      input_tokens: number;
      output_tokens: number;
      wall_s: number | null;
      sim_cost_usd: number | null;
    }>(
      `SELECT config_hash, task_sha256, count(*)::int AS trials, avg(input_tokens)::float8 AS input_tokens,
              avg(output_tokens)::float8 AS output_tokens, avg(wall_s)::float8 AS wall_s, avg(sim_cost_usd)::float8 AS sim_cost_usd
       FROM trials
       WHERE status = 'done' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND proxy_complete IS NOT FALSE
         AND config_hash = ANY($1) AND task_sha256 = ANY($2)
       GROUP BY config_hash, task_sha256`,
      [configHashes, taskShas],
    );
    const cells: CellInput[] = [];
    for (const c of ordered.configs) {
      for (const t of ordered.tasks) {
        const h = history.find((r) => r.config_hash === c.hash && r.task_sha256 === t.sha256);
        cells.push({
          config: c.hash,
          task: t.sha256,
          model: c.model,
          harness: c.harness,
          simTurns: isSimTask(t) ? simTurns(t) : null,
          history: h
            ? { trials: h.trials, inputTokens: h.input_tokens, outputTokens: h.output_tokens, wallS: h.wall_s, simCostUsd: isSimTask(t) ? h.sim_cost_usd : null }
            : null,
        });
      }
    }
    return { ...ordered, n, simModel: needsSim ? simModel : null, estimate: estimate({ cells, n, prices, simModel: needsSim ? simModel : null }) };
  }

  async estimate(body: EstimateRequest): Promise<Estimate> {
    return (await this.plan(body)).estimate;
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
    const plan = await this.plan(body);
    // R10.6: start only runs that can finish. The budget is a safety net, so it must cover
    // the top of the estimate's range, not just the expected cost.
    if (body.budget_usd < plan.estimate.cost_usd.high) {
      throw badRequest(
        'budget_below_estimate',
        `budget_usd ${body.budget_usd} is below the estimate's high end ${plan.estimate.cost_usd.high} ` +
          `(expected ${plan.estimate.cost_usd.expected}); raise the budget or shrink the run`,
      );
    }
    let simPrompt: StoredPrompt | null = null;
    if (plan.simModel) {
      if (body.sim_prompt_sha256 !== undefined && body.sim_prompt_sha256 !== null) {
        const sha = normalizeSha(body.sim_prompt_sha256);
        if (!sha) throw badRequest('invalid_experiment', 'sim_prompt_sha256 must be sha256:<64 hex>');
        simPrompt = await this.catalogue.prompt(sha);
        if (!simPrompt) throw badRequest('unknown_prompt', `no prompt with ${sha}`);
      } else {
        simPrompt = await this.catalogue.latestPrompt('client-sim');
        if (!simPrompt) throw badRequest('unknown_prompt', 'no client-sim prompt under configs/prompts');
      }
    }

    const id = newId('e');
    const slots: { id: string; task: string; config: string; harness: string; repeat: number; seq: number }[] = [];
    let seq = 0;
    // Repeat-major, then task, then config: the arms are interleaved in claim order, so a
    // cancel or a budget trip part-way leaves the arms balanced.
    for (let r = 0; r < plan.n; r += 1) {
      for (const t of plan.tasks) {
        for (const c of plan.configs) {
          slots.push({ id: newId('t'), task: t.sha256, config: c.hash, harness: c.harness, repeat: r, seq: seq++ });
        }
      }
    }
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO experiments (id, name, axis, config_hashes, task_sha256s, n, sim_model, sim_prompt_sha256,
                                  sim_temperature, sim_max_output_tokens, budget_usd, trial_budget_usd, sim_budget_usd,
                                  platform_commit, plan_commit, estimate, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'created')`,
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
          plan.estimate.budgets.trial_usd,
          plan.estimate.budgets.sim_usd,
          this.config.platformCommit,
          body.plan_commit ?? null,
          JSON.stringify(plan.estimate),
        ],
      );
      await client.query(
        `INSERT INTO trials (id, experiment_id, task_sha256, config_hash, repeat_index, attempt, seq, harness, status)
         SELECT s.id, $1, s.task, s.config, s.repeat, 1, s.seq, s.harness, 'queued'
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::text[])
              AS s(id, task, config, repeat, seq, harness)`,
        [id, slots.map((s) => s.id), slots.map((s) => s.task), slots.map((s) => s.config), slots.map((s) => s.repeat), slots.map((s) => s.seq), slots.map((s) => s.harness)],
      );
      // The whole experiment's budget, enforced by LiteLLM across every trial key (a team).
      // Inside the transaction: if LiteLLM refuses, nothing is stored.
      const teamId = await this.litellm.newTeam({ alias: `experiment:${id}`, maxBudgetUsd: body.budget_usd, experimentId: id });
      await client.query('UPDATE experiments SET litellm_team_id = $2 WHERE id = $1', [id, teamId]);
    });
    return this.get(id);
  }

  // ---- lifecycle ----

  /** Starts a created experiment, or resumes a paused one (D26); a running one is left as it is. */
  async start(id: string): Promise<ExperimentDetail> {
    const exp = await this.row(id);
    if (exp.status === 'done' || exp.status === 'cancelled') {
      throw conflict('experiment_finished', `experiment ${id} is ${exp.status} and cannot start again`);
    }
    await this.db.tx(async (client) => {
      await client.query(`UPDATE experiments SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = $1 AND status = 'created'`, [id]);
      await client.query(`UPDATE experiments SET status = 'running', resumed_at = now() WHERE id = $1 AND status = 'paused'`, [id]);
      // A pause can come with the last trial: then there is nothing left to claim.
      await finishIfDone(client, id);
    });
    return this.get(id);
  }

  /** Queued trials become cancelled; claimed and running ones finish and are kept. */
  async cancel(id: string): Promise<ExperimentDetail> {
    const exp = await this.row(id);
    if (exp.status === 'done') throw conflict('experiment_finished', `experiment ${id} is already done`);
    await this.db.tx(async (client) => {
      await client.query(`UPDATE experiments SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status IN ('created', 'running', 'paused')`, [id]);
      await client.query(`UPDATE trials SET status = 'cancelled', finished_at = now() WHERE experiment_id = $1 AND status = 'queued'`, [id]);
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
      budgets: { trial_usd: r.trial_budget_usd, sim_usd: r.sim_budget_usd },
      started_at: iso(r.started_at),
      finished_at: iso(r.finished_at),
      paused_at: iso(r.paused_at),
      paused_reason: r.paused_reason,
      tasks: r.task_sha256s.map((s) => tasks.find((t) => t.sha256 === s)).filter((t): t is StoredTask => !!t).map((t) => taskView(t)),
      configs: r.config_hashes.map((h) => configs.find((c) => c.hash === h)).filter((c): c is ConfigRow => !!c).map(configView),
      events: await this.events(r),
    };
  }

  /** Derived from the trial rows and the experiment's own times, so nothing extra is stored. */
  private async events(r: ExperimentRow): Promise<ExperimentEvent[]> {
    const events: ExperimentEvent[] = [];
    const add = (at: Date | null, kind: ExperimentEventKind, detail: string, trial: { id: string; attempt: number } | null = null): void => {
      if (at) events.push({ at: at.toISOString(), kind, trial_id: trial?.id ?? null, attempt: trial?.attempt ?? null, detail });
    };
    add(r.created_at, 'created', `${r.config_hashes.length} configs x ${r.task_sha256s.length} tasks x N=${r.n}`);
    add(r.started_at, 'started', 'trials can be claimed');
    add(r.cancelled_at, 'cancelled', 'queued trials cancelled; claimed ones finish');
    add(r.finished_at, 'finished', 'every trial has finished');
    // The latest pause and resume only: a second pause overwrites the first's time and reason.
    add(r.paused_at, 'paused', r.paused_reason ?? 'paused');
    add(r.resumed_at, 'resumed', 'claims resumed');
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
      config_name: string;
    }>(
      `SELECT t.id, t.attempt, t.status, t.label, t.worker_id, t.claimed_at, t.finished_at, t.reported_at, t.created_at,
              t.problems, k.id AS task_id, c.name AS config_name
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

  async compare(id: string): Promise<CompareResponse> {
    const r = await this.row(id);
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
       WHERE t.experiment_id = $1
       GROUP BY t.task_sha256, k.id, t.config_hash, c.name`,
      [id],
    );
    const order = (task: string, config: string): number => r.task_sha256s.indexOf(task) * 1000 + r.config_hashes.indexOf(config);
    rows.sort((a, b) => order(a.task, a.config) - order(b.task, b.config));
    return { experiment_id: id, rows, stats: null };
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
         t.repeat_index, t.attempt, t.status, t.label, t.end_state, t.cost_usd, t.input_tokens, t.output_tokens,
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
