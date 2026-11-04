import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { ClaimResponse, HeartbeatRequest, HeartbeatResponse, ReportResponse, TrialStatus } from '../contract';
import { ApiError, badRequest, conflict, notFound } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { newId } from '../common/ids';
import type { StoredTask } from '../catalogue/catalogue.service';
import { CONFIG_SELECT, type ConfigRow, configId } from '../configs/configs.service';
import { Db, type Queryable } from '../database/db.service';
import { type ExperimentRow, finishIfDone, isSimTask } from '../experiments/experiments.service';
import { LiteLlmClient, LiteLlmHttpError, type MintedKey } from '../litellm/litellm.client';
import { FINISHED, HELD, LEASE_S, SWEEP_INTERVAL_MS, shouldRequeue, statusForLabel } from '../trials/status';
import { checkFiles, trialFolder } from '../trials/trial-files';
import { parseReport, spanRows, usageOf } from './report';
import { CLIENT_STATE_FILE, SIM_MAX_OUTPUT_TOKENS, SIM_TEMPERATURE, buildSpec } from './spec-builder';

interface TrialRow {
  id: string;
  experiment_id: string;
  task_sha256: string;
  config_hash: string;
  repeat_index: number;
  attempt: number;
  status: TrialStatus;
  worker_id: string | null;
  reported_at: Date | null;
  folder: string | null;
  agent_key_token: string | null;
  sim_key_token: string | null;
  problems: string[];
}

const one = async <T>(q: Queryable, sql: string, params: unknown[]): Promise<T | undefined> =>
  ((await q.query(sql, params)).rows as T[])[0];

/** Queues the slot's next attempt, if the cap and the experiment allow it (D16). */
async function requeue(q: Queryable, trialId: string, attempt: number, experimentStatus: ExperimentRow['status']): Promise<string | null> {
  if (!shouldRequeue(attempt, experimentStatus)) return null;
  const next = await one<{ id: string }>(
    q,
    `INSERT INTO trials (id, experiment_id, task_sha256, config_hash, repeat_index, attempt, seq, harness, status)
     SELECT $2, experiment_id, task_sha256, config_hash, repeat_index, attempt + 1, seq, harness, 'queued'
     FROM trials WHERE id = $1
     ON CONFLICT (experiment_id, task_sha256, config_hash, repeat_index, attempt) DO NOTHING
     RETURNING id`,
    [trialId, newId('t')],
  );
  return next?.id ?? null;
}

/**
 * The worker protocol (D2): claim, heartbeat, report, and the lease sweep. Every status change
 * happens here, in a transaction, with the trial row locked.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly litellm: LiteLlmClient,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.db.configured) return;
    this.timer = setInterval(() => void this.sweepQuietly(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sweepQuietly(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.warn(`lease sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  // ---- claim ----

  /**
   * Claims the next queued trial for the harness, builds its spec and mints its keys, all in
   * one transaction: if minting fails the claim rolls back and the trial stays queued.
   * SKIP LOCKED means two workers never get the same trial. Null when nothing is queued.
   */
  async claim(body: unknown): Promise<ClaimResponse | null> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.worker_id !== 'string' || !b.worker_id) throw badRequest('invalid_claim', 'worker_id is required');
    if (typeof b.harness !== 'string' || !b.harness) throw badRequest('invalid_claim', 'harness is required');
    const workerId = b.worker_id;
    const harness = b.harness;
    const modelBaseUrl = this.litellm.workerBaseUrl; // fails early when LiteLLM is not configured
    return this.db.tx(async (client) => {
      const t = await one<TrialRow>(
        client,
        `UPDATE trials SET status = 'claimed', worker_id = $2, claimed_at = now(), heartbeat_at = now()
         WHERE id = (
           SELECT t.id FROM trials t JOIN experiments e ON e.id = t.experiment_id
           WHERE t.status = 'queued' AND t.harness = $1 AND e.status = 'running'
           ORDER BY e.started_at, e.id, t.seq, t.attempt
           LIMIT 1
           FOR UPDATE OF t SKIP LOCKED)
         RETURNING id, experiment_id, task_sha256, config_hash, repeat_index, attempt`,
        [harness, workerId],
      );
      if (!t) return null;
      const exp = (await one<ExperimentRow>(client, 'SELECT * FROM experiments WHERE id = $1', [t.experiment_id])) as ExperimentRow;
      const cfg = (await one<ConfigRow>(client, `${CONFIG_SELECT} WHERE c.hash = $1`, [t.config_hash])) as ConfigRow;
      const task = (await one<StoredTask>(client, 'SELECT * FROM tasks WHERE sha256 = $1', [t.task_sha256])) as StoredTask;
      const prompt = (await one<{ id: string; version: string; sha256: string; text: string }>(client, 'SELECT * FROM prompts WHERE sha256 = $1', [cfg.prompt_sha256]))!;
      const toolset = (await one<{ id: string; version: string; sha256: string; servers: { name: string; allowed_tools: string[] }[] }>(
        client,
        'SELECT * FROM toolsets WHERE sha256 = $1',
        [cfg.toolset_sha256],
      ))!;
      const withSim = isSimTask(task);
      let sim = null;
      if (withSim) {
        const simPrompt = await one<{ id: string; version: string; sha256: string; text: string }>(client, 'SELECT * FROM prompts WHERE sha256 = $1', [exp.sim_prompt_sha256]);
        if (!exp.sim_model || !simPrompt) throw new ApiError(500, 'experiment_without_simulator', `experiment ${exp.id} has a simulated-client task but no simulator`);
        sim = {
          model: exp.sim_model,
          temperature: exp.sim_temperature ?? SIM_TEMPERATURE,
          maxOutputTokens: exp.sim_max_output_tokens ?? SIM_MAX_OUTPUT_TOKENS,
          prompt: simPrompt,
        };
      }
      const spec = buildSpec({
        trial: { id: t.id, experimentId: t.experiment_id, repeatIndex: t.repeat_index, attempt: t.attempt },
        config: {
          id: configId(cfg.hash),
          hash: cfg.hash,
          model: cfg.model,
          apiFormat: cfg.api_format,
          settings: cfg.settings,
          settingsSources: cfg.settings_sources,
          harnessOptions: cfg.harness_options,
        },
        task: { id: task.id, sha256: task.sha256, split: task.split, body: task.body },
        prompt,
        toolset,
        sim,
        modelBaseUrl,
      });
      const folder = trialFolder(t.experiment_id, t.id, t.attempt);
      const minted: MintedKey[] = [];
      try {
        const agent = await this.litellm.generateKey({
          trialId: t.id,
          role: 'agent',
          model: cfg.model,
          maxBudgetUsd: exp.trial_budget_usd,
          teamId: exp.litellm_team_id,
          experimentId: exp.id,
        });
        minted.push(agent);
        let simKey: MintedKey | null = null;
        if (sim) {
          simKey = await this.litellm.generateKey({
            trialId: t.id,
            role: 'sim',
            model: sim.model,
            maxBudgetUsd: exp.sim_budget_usd,
            teamId: exp.litellm_team_id,
            experimentId: exp.id,
          });
          minted.push(simKey);
        }
        await client.query('UPDATE trials SET spec = $2, agent_key_token = $3, sim_key_token = $4, folder = $5 WHERE id = $1', [
          t.id,
          JSON.stringify(spec),
          agent.token,
          simKey?.token ?? null,
          folder,
        ]);
        const stateFiles: Record<string, string> = {};
        if (task.client_state) stateFiles[CLIENT_STATE_FILE] = task.client_state.toString('base64');
        return {
          trial_id: t.id,
          attempt: t.attempt,
          experiment_id: t.experiment_id,
          spec,
          state_files: stateFiles,
          keys: { model: agent.key, sim: simKey?.key ?? null },
          budgets: { trial_usd: exp.trial_budget_usd, sim_usd: exp.sim_budget_usd },
          lease_s: LEASE_S,
          folder,
        };
      } catch (err) {
        await this.litellm.deleteKeys(minted.map((k) => k.token)).catch(() => undefined);
        throw err;
      }
    });
  }

  // ---- heartbeat ----

  async heartbeat(id: string, body: unknown): Promise<HeartbeatResponse> {
    const b = (body ?? {}) as Partial<HeartbeatRequest>;
    if (typeof b.worker_id !== 'string' || typeof b.attempt !== 'number') {
      throw badRequest('invalid_heartbeat', 'worker_id and attempt are required');
    }
    const kept = await this.db.query(
      `UPDATE trials SET heartbeat_at = now(), status = 'running'
       WHERE id = $1 AND attempt = $2 AND worker_id = $3 AND status IN ('claimed', 'running') RETURNING id`,
      [id, b.attempt, b.worker_id],
    );
    if (kept.length) return { lease_s: LEASE_S };
    const [exists] = await this.db.query('SELECT 1 FROM trials WHERE id = $1', [id]);
    if (!exists) throw notFound('unknown_trial', `no trial ${id}`);
    throw conflict('claim_lost', `trial ${id} attempt ${b.attempt} is no longer held by ${b.worker_id}; stop it and report nothing`);
  }

  // ---- calls ----

  async calls(id: string, role: string | undefined): Promise<unknown[]> {
    if (role !== 'agent' && role !== 'sim') throw badRequest('invalid_role', 'role must be agent or sim');
    const [t] = await this.db.query<{ agent_key_token: string | null; sim_key_token: string | null }>(
      'SELECT agent_key_token, sim_key_token FROM trials WHERE id = $1',
      [id],
    );
    if (!t) throw notFound('unknown_trial', `no trial ${id}`);
    const token = role === 'agent' ? t.agent_key_token : t.sim_key_token;
    if (!token) throw notFound('no_key', `trial ${id} has no ${role} key`);
    return this.litellm.spendLogs(token);
  }

  // ---- report ----

  async report(id: string, raw: unknown): Promise<ReportResponse> {
    const body = parseReport(raw);
    const [trial] = await this.db.query<TrialRow>('SELECT * FROM trials WHERE id = $1', [id]);
    if (!trial) throw notFound('unknown_trial', `no trial ${id}`);
    if (body.attempt !== trial.attempt) {
      throw conflict('attempt_mismatch', `trial ${id} is attempt ${trial.attempt}, not ${body.attempt}`);
    }
    if (trial.reported_at) return this.duplicate(trial);
    if (!HELD.includes(trial.status) || trial.worker_id !== body.worker_id) {
      throw conflict('claim_lost', `trial ${id} is ${trial.status} and no longer held by ${body.worker_id}`);
    }
    if (typeof body.runner_report.trial_id === 'string' && body.runner_report.trial_id !== id) {
      throw badRequest('report_mismatch', `the runner report is for ${body.runner_report.trial_id}, not ${id}`);
    }
    const folder = trial.folder ?? trialFolder(trial.experiment_id, trial.id, trial.attempt);
    const files = await checkFiles(this.config.runsDir, folder, body.files);
    const { rows: spans, problems } = spanRows(body.spans);
    const bad = files.filter((f) => !f.ok);
    if (bad.length) problems.push(`${bad.length} of ${files.length} files missing or different on the runs volume under ${folder}`);
    const label = body.runner_report.label as string;
    const status = statusForLabel(label);
    const usage = usageOf(body.runner_report, body.result, spans);

    const outcome = await this.db.tx(async (client) => {
      const locked = (await one<TrialRow>(client, 'SELECT * FROM trials WHERE id = $1 FOR UPDATE', [id])) as TrialRow;
      if (locked.reported_at) return null; // a concurrent duplicate won the race
      if (!HELD.includes(locked.status) || locked.worker_id !== body.worker_id) {
        throw conflict('claim_lost', `trial ${id} is ${locked.status} and no longer held by ${body.worker_id}`);
      }
      await client.query(
        `UPDATE trials SET status = $2, finished_at = now(), reported_at = now(), label = $3, end_state = $4,
                runner_report = $5, result = $6, cost_usd = $7, sim_cost_usd = $8, input_tokens = $9, output_tokens = $10,
                model_calls = $11, proxy_complete = $12, wall_s = $13, files = $14, problems = $15, folder = $16
         WHERE id = $1`,
        [
          id,
          status,
          label,
          usage.end_state,
          JSON.stringify(body.runner_report),
          body.result === null ? null : JSON.stringify(body.result),
          usage.cost_usd,
          usage.sim_cost_usd,
          usage.input_tokens,
          usage.output_tokens,
          usage.model_calls,
          usage.proxy_complete,
          usage.wall_s,
          JSON.stringify(files),
          JSON.stringify(problems),
          folder,
        ],
      );
      let stored = 0;
      if (spans.length) {
        const res = await client.query(
          `INSERT INTO spans (trial_id, span_id, parent_span_id, name, kind, start_ns, end_ns, status_code, attributes, raw)
           SELECT $1, s.span_id, s.parent_span_id, s.name, s.kind, s.start_ns, s.end_ns, s.status_code, s.attributes, s.raw
           FROM jsonb_to_recordset($2::jsonb) AS s(span_id text, parent_span_id text, name text, kind smallint,
                start_ns numeric, end_ns numeric, status_code smallint, attributes jsonb, raw jsonb)
           ON CONFLICT (trial_id, span_id) DO NOTHING`,
          [id, JSON.stringify(spans)],
        );
        stored = res.rowCount ?? 0;
      }
      let requeued: string | null = null;
      if (status === 'infra_failed') {
        const exp = (await one<{ status: ExperimentRow['status'] }>(client, 'SELECT status FROM experiments WHERE id = $1', [locked.experiment_id]))!;
        requeued = await requeue(client, id, locked.attempt, exp.status);
      }
      await finishIfDone(client, locked.experiment_id);
      return { stored, requeued };
    });
    if (!outcome) return this.duplicate((await this.db.query<TrialRow>('SELECT * FROM trials WHERE id = $1', [id]))[0]);
    await this.revoke([{ id, agent_key_token: trial.agent_key_token, sim_key_token: trial.sim_key_token }]);
    return {
      trial_id: id,
      attempt: trial.attempt,
      status,
      duplicate: false,
      requeued_trial_id: outcome.requeued,
      spans_stored: outcome.stored,
      problems,
    };
  }

  private async duplicate(trial: TrialRow): Promise<ReportResponse> {
    const [next] = await this.db.query<{ id: string }>(
      `SELECT id FROM trials WHERE experiment_id = $1 AND task_sha256 = $2 AND config_hash = $3 AND repeat_index = $4 AND attempt = $5`,
      [trial.experiment_id, trial.task_sha256, trial.config_hash, trial.repeat_index, trial.attempt + 1],
    );
    const [count] = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM spans WHERE trial_id = $1', [trial.id]);
    return {
      trial_id: trial.id,
      attempt: trial.attempt,
      status: trial.status,
      duplicate: true,
      requeued_trial_id: next?.id ?? null,
      spans_stored: count?.n ?? 0,
      problems: trial.problems,
    };
  }

  // ---- lapsed leases and keys ----

  /**
   * Marks every claim with no heartbeat for LEASE_S as abandoned, queues the slot's next attempt
   * under the same cap, then revokes keys that are still live. Returns what it changed.
   */
  async sweep(): Promise<{ abandoned: string[]; requeued: string[] }> {
    const changed = await this.db.tx(async (client) => {
      const { rows } = await client.query<{ id: string; experiment_id: string; attempt: number; status: ExperimentRow['status'] }>(
        `WITH lapsed AS (
           UPDATE trials SET status = 'abandoned', finished_at = now()
           WHERE id IN (
             SELECT id FROM trials
             WHERE status IN ('claimed', 'running') AND heartbeat_at < now() - make_interval(secs => $1::double precision)
             FOR UPDATE SKIP LOCKED)
           RETURNING id, experiment_id, attempt)
         SELECT l.id, l.experiment_id, l.attempt, e.status FROM lapsed l JOIN experiments e ON e.id = l.experiment_id`,
        [LEASE_S],
      );
      const requeued: string[] = [];
      for (const r of rows) {
        const next = await requeue(client, r.id, r.attempt, r.status);
        if (next) requeued.push(next);
      }
      for (const exp of new Set(rows.map((r) => r.experiment_id))) await finishIfDone(client, exp);
      return { abandoned: rows.map((r) => r.id), requeued };
    });
    if (changed.abandoned.length) this.logger.warn(`abandoned lapsed trials: ${changed.abandoned.join(', ')}`);
    const pending = await this.db.query<{ id: string; agent_key_token: string | null; sim_key_token: string | null }>(
      `SELECT id, agent_key_token, sim_key_token FROM trials
       WHERE keys_revoked_at IS NULL AND agent_key_token IS NOT NULL AND status = ANY($1) ORDER BY finished_at LIMIT 200`,
      [FINISHED],
    );
    await this.revoke(pending);
    return changed;
  }

  /** Best effort: a key LiteLLM no longer has counts as revoked; an unreachable LiteLLM is retried by the sweep. */
  private async revoke(rows: { id: string; agent_key_token: string | null; sim_key_token: string | null }[]): Promise<void> {
    for (const r of rows) {
      const tokens = [r.agent_key_token, r.sim_key_token].filter((t): t is string => !!t);
      if (!tokens.length) continue;
      try {
        try {
          await this.litellm.deleteKeys(tokens);
        } catch (err) {
          if (!(err instanceof LiteLlmHttpError) || err.upstreamStatus >= 500) throw err;
          // Some key is already gone: delete the rest one by one, ignoring the missing ones.
          for (const token of tokens) {
            await this.litellm.deleteKeys([token]).catch((e: unknown) => {
              if (!(e instanceof LiteLlmHttpError) || e.upstreamStatus >= 500) throw e;
            });
          }
        }
        await this.db.query('UPDATE trials SET keys_revoked_at = now() WHERE id = $1', [r.id]);
      } catch (err) {
        this.logger.warn(`could not revoke keys of ${r.id} yet: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
