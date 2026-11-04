import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { ClaimResponse, HeartbeatRequest, HeartbeatResponse, ReportResponse, TrialStatus, UploadResponse } from '../contract';
import { ApiError, badRequest, conflict, notFound } from '../common/api-error';
import { normalizeSha } from '../common/hashing';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { newId } from '../common/ids';
import type { StoredTask } from '../catalogue/catalogue.service';
import { CONFIG_SELECT, type ConfigRow, configId } from '../configs/configs.service';
import { Db, type Queryable } from '../database/db.service';
import { type ExperimentRow, finishIfDone, isSimTask } from '../experiments/experiments.service';
import { LiteLlmClient, LiteLlmHttpError, type MintedKey } from '../litellm/litellm.client';
import { FINISHED, HELD, LEASE_S, PAUSES_ARM, SWEEP_INTERVAL_MS, shouldRequeue, statusForLabel } from '../trials/status';
import { MAX_FILE_BYTES, checkFiles, locate, safeRelPath, storeUpload, trialFolder } from '../trials/trial-files';
import { configErrorFix, configErrorReason, parseReport, spanRows, usageOf } from './report';
import { applyRunRules } from '../experiments/rules';
import { pauseArm } from '../experiments/run-state';
import { SIM_REPLIES_FILE, type SimReplyRow, type SimScope, parseSimReplies, simScope } from './sim-cache';
import { clientSummary } from './client-summary';
import { CLIENT_STATE_FILE, SIM_MAX_OUTPUT_TOKENS, buildSpec } from './spec-builder';
import { PROBE_BUDGET_USD, PROBE_FOLDER, PROBE_MODEL } from '../preflight/probe';

interface TrialRow {
  id: string;
  /** Null for a probe trial (D33). */
  experiment_id: string | null;
  probe: boolean;
  task_sha256: string;
  config_hash: string;
  repeat_index: number;
  attempt: number;
  status: TrialStatus;
  worker_id: string | null;
  reported_at: Date | null;
  spec: unknown;
  folder: string | null;
  agent_key_token: string | null;
  sim_key_token: string | null;
  problems: string[];
}

const one = async <T>(q: Queryable, sql: string, params: unknown[]): Promise<T | undefined> =>
  ((await q.query(sql, params)).rows as T[])[0];

/** Where an attempt's files go: under its experiment, or under runs/probes/ for a probe (D33). */
const folderOf = (t: { experiment_id: string | null; id: string; attempt: number; folder?: string | null }): string =>
  t.folder ?? trialFolder(t.experiment_id ?? PROBE_FOLDER, t.id, t.attempt);

/**
 * Every stored simulator reply for this task, simulator model, settings and prompt (D22). An empty
 * reply stored before D26's simulator-failure rule (the 4 Nov Haiku replies) is left out, so a
 * trial reaching that state asks the simulator again instead of failing the same way.
 */
async function simCache(q: Queryable, scope: SimScope): Promise<Record<string, string>> {
  const { rows } = await q.query<{ key: string; reply: string }>(
    `SELECT key, reply FROM sim_replies
     WHERE task_sha256 = $1 AND sim_model = $2 AND temperature IS NOT DISTINCT FROM $3::double precision
       AND max_output_tokens = $4 AND prompt_sha256 = $5 AND reply ~ '\\S'
     ORDER BY created_at, key`,
    [scope.task_sha256, scope.sim_model, scope.temperature, scope.max_output_tokens, scope.prompt_sha256],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.reply]));
}

/** Reads and drops the rest of a refused upload's body, so the worker hears the refusal instead
 *  of a reset connection. */
async function drained(req: IncomingMessage, err: ApiError): Promise<ApiError> {
  if (!req.readableEnded && !req.destroyed) {
    await new Promise<void>((resolve) => {
      req.once('end', resolve);
      req.once('error', () => resolve());
      req.once('close', () => resolve());
      req.resume();
    });
  }
  return err;
}

/** Queues the slot's next attempt, if the cap, the label and the experiment allow it (D16, D26). */
async function requeue(q: Queryable, trialId: string, attempt: number, experimentStatus: ExperimentRow['status'], label: string | null): Promise<string | null> {
  if (!shouldRequeue(attempt, experimentStatus, label)) return null;
  const next = await one<{ id: string }>(
    q,
    `INSERT INTO trials (id, experiment_id, task_sha256, config_hash, repeat_index, attempt, seq, order_index, harness, status)
     SELECT $2, experiment_id, task_sha256, config_hash, repeat_index, attempt + 1, seq, order_index, harness, 'queued'
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
    // Item 8: a worker that asks for work is live, whether or not it gets any.
    await this.seen(workerId, harness);
    return this.db.tx(async (client) => {
      // A probe trial (D33) has no experiment and goes first: it is a short pre-run check.
      const t = await one<TrialRow>(
        client,
        `UPDATE trials SET status = 'claimed', worker_id = $2, claimed_at = now(), heartbeat_at = now()
         WHERE id = (
           SELECT t.id FROM trials t LEFT JOIN experiments e ON e.id = t.experiment_id
           WHERE t.status = 'queued' AND t.harness = $1 AND (t.probe OR e.status = 'running')
             -- D37: a paused arm's trials wait; the other arm keeps claiming. A probe has no arm.
             AND NOT EXISTS (SELECT 1 FROM experiment_arms a
                             WHERE a.experiment_id = t.experiment_id AND a.config_hash = t.config_hash AND a.paused_at IS NOT NULL)
           -- Probes first (D33), then each experiment in its seeded claim order (D32).
           ORDER BY t.probe DESC, e.started_at, e.id, t.order_index, t.attempt, t.created_at
           LIMIT 1
           FOR UPDATE OF t SKIP LOCKED)
         RETURNING id, experiment_id, probe, task_sha256, config_hash, repeat_index, attempt`,
        [harness, workerId],
      );
      if (!t) return null;
      const exp = t.experiment_id ? ((await one<ExperimentRow>(client, 'SELECT * FROM experiments WHERE id = $1', [t.experiment_id])) as ExperimentRow) : null;
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
        if (!exp) throw new ApiError(500, 'probe_with_simulator', `probe ${t.id} has a simulated-client task`);
        const simPrompt = await one<{ id: string; version: string; sha256: string; text: string }>(client, 'SELECT * FROM prompts WHERE sha256 = $1', [exp.sim_prompt_sha256]);
        if (!exp.sim_model || !simPrompt) throw new ApiError(500, 'experiment_without_simulator', `experiment ${exp.id} has a simulated-client task but no simulator`);
        sim = {
          model: exp.sim_model,
          // Null is "not sent" (D27), so there is no fallback: the experiment stored its choice.
          temperature: exp.sim_temperature,
          maxOutputTokens: exp.sim_max_output_tokens ?? SIM_MAX_OUTPUT_TOKENS,
          prompt: simPrompt,
        };
      }
      // A probe runs the config as it is, except on the fake model, so it costs nothing (D33).
      const model = exp ? cfg.model : PROBE_MODEL;
      const budgets = exp ? { trial_usd: exp.trial_budget_usd, sim_usd: exp.sim_budget_usd } : { trial_usd: PROBE_BUDGET_USD, sim_usd: 0 };
      const spec = buildSpec({
        trial: { id: t.id, experimentId: t.experiment_id, repeatIndex: t.repeat_index, attempt: t.attempt },
        config: {
          id: configId(cfg.hash),
          hash: cfg.hash,
          model,
          apiFormat: cfg.api_format,
          settings: cfg.settings,
          settingsSources: cfg.settings_sources,
          harnessOptions: cfg.harness_options,
          seed: cfg.seed,
        },
        task: { id: task.id, sha256: task.sha256, split: exp ? task.split : null, body: task.body, clientSummary: withSim ? clientSummary(task.client_state) : null },
        prompt,
        toolset,
        sim,
        modelBaseUrl,
      });
      const folder = folderOf(t);
      const minted: MintedKey[] = [];
      try {
        const agent = await this.litellm.generateKey({
          trialId: t.id,
          role: 'agent',
          model,
          maxBudgetUsd: budgets.trial_usd,
          teamId: exp?.litellm_team_id ?? null,
          experimentId: exp?.id ?? null,
          probe: !exp,
        });
        minted.push(agent);
        let simKey: MintedKey | null = null;
        if (sim && exp) {
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
        const scope = simScope(task.sha256, spec);
        return {
          trial_id: t.id,
          attempt: t.attempt,
          experiment_id: t.experiment_id,
          spec,
          state_files: stateFiles,
          keys: { model: agent.key, sim: simKey?.key ?? null },
          budgets,
          lease_s: LEASE_S,
          folder,
          sim_cache: scope ? await simCache(client, scope) : null,
        };
      } catch (err) {
        await this.litellm.deleteKeys(minted.map((k) => k.token)).catch(() => undefined);
        throw err;
      }
    });
  }

  /** Records that a worker of this harness is alive now (the estimate's live workers, item 8). */
  private async seen(workerId: string, harness: string): Promise<void> {
    await this.db.query(
      `INSERT INTO workers (worker_id, harness, last_seen_at) VALUES ($1, $2, now())
       ON CONFLICT (worker_id) DO UPDATE SET harness = EXCLUDED.harness, last_seen_at = now()`,
      [workerId, harness],
    );
  }

  // ---- heartbeat ----

  async heartbeat(id: string, body: unknown): Promise<HeartbeatResponse> {
    const b = (body ?? {}) as Partial<HeartbeatRequest>;
    if (typeof b.worker_id !== 'string' || typeof b.attempt !== 'number') {
      throw badRequest('invalid_heartbeat', 'worker_id and attempt are required');
    }
    const kept = await this.db.query<{ harness: string }>(
      `UPDATE trials SET heartbeat_at = now(), status = 'running'
       WHERE id = $1 AND attempt = $2 AND worker_id = $3 AND status IN ('claimed', 'running') RETURNING harness`,
      [id, b.attempt, b.worker_id],
    );
    if (kept.length) {
      await this.seen(b.worker_id, kept[0].harness);
      return { lease_s: LEASE_S };
    }
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

  // ---- files ----

  /**
   * Stores one file of an attempt's out/ folder under runs/ (worker protocol step 4). Only the worker
   * holding the attempt may add files; after its report it may only send the same bytes again.
   * Path traversal, a missing or wrong hash and files over MAX_FILE_BYTES are refused.
   */
  async upload(
    id: string,
    rel: string,
    query: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
    body: IncomingMessage,
  ): Promise<UploadResponse> {
    const header = (name: string): string | undefined => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const type = (header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/octet-stream') {
      throw await drained(body, new ApiError(415, 'unsupported_media_type', 'send the file as Content-Type: application/octet-stream'));
    }
    const length = header('content-length');
    if (length === undefined || !/^[0-9]+$/.test(length)) throw await drained(body, new ApiError(411, 'length_required', 'an upload needs a Content-Length'));
    if (Number(length) > MAX_FILE_BYTES) throw new ApiError(413, 'file_too_large', `${rel} is ${length} bytes; the limit is ${MAX_FILE_BYTES}`);
    const sha256 = normalizeSha(header('x-content-sha256'));
    if (!sha256) throw await drained(body, badRequest('invalid_upload', 'X-Content-Sha256 must be sha256:<hex> or 64 hex digits'));
    const workerId = typeof query.worker_id === 'string' ? query.worker_id : '';
    const attempt = typeof query.attempt === 'string' && /^[1-9][0-9]{0,8}$/.test(query.attempt) ? Number(query.attempt) : null;
    if (!workerId || attempt === null) throw await drained(body, badRequest('invalid_upload', 'the worker_id and attempt query parameters are required'));
    if (!safeRelPath(rel)) throw await drained(body, badRequest('invalid_path', `${JSON.stringify(rel)} is not a plain relative path inside the trial folder`));

    const [t] = await this.db.query<TrialRow>('SELECT * FROM trials WHERE id = $1', [id]);
    if (!t) throw await drained(body, notFound('unknown_trial', `no trial ${id}`));
    if (t.attempt !== attempt) throw await drained(body, conflict('attempt_mismatch', `trial ${id} is attempt ${t.attempt}, not ${attempt}`));
    const reported = t.reported_at !== null;
    if (t.worker_id !== workerId || (!reported && !HELD.includes(t.status))) {
      throw await drained(body, conflict('claim_lost', `trial ${id} is ${t.status} and no longer held by ${workerId}`));
    }
    const folder = folderOf(t);
    return storeUpload(this.config.runsDir, folder, rel, body, sha256, { allowNew: !reported });
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
    const folder = folderOf(trial);
    const files = await checkFiles(this.config.runsDir, folder, body.files);
    const { rows: spans, problems } = spanRows(body.spans);
    const bad = files.filter((f) => !f.ok);
    if (bad.length) problems.push(`${bad.length} of ${files.length} files not uploaded or different from what the API stored under ${folder}`);
    const sim = await this.simReplies(trial, folder, files, problems);
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
      let simStored = 0;
      if (sim && sim.rows.length) {
        const res = await client.query(
          `INSERT INTO sim_replies (key, task_sha256, sim_model, temperature, max_output_tokens, prompt_sha256, reply, usage, trial_id)
           SELECT r.key, $2, $3, $4, $5, $6, r.reply, r.usage, $1
           FROM jsonb_to_recordset($7::jsonb) AS r(key text, reply text, usage jsonb)
           ON CONFLICT (key) DO NOTHING`,
          [id, sim.scope.task_sha256, sim.scope.sim_model, sim.scope.temperature, sim.scope.max_output_tokens, sim.scope.prompt_sha256, JSON.stringify(sim.rows)],
        );
        simStored = res.rowCount ?? 0;
      }
      let requeued: string | null = null;
      // A probe (no experiment) is never re-queued and pauses nothing: POST rendered-prompt probes again.
      const experimentId = locked.experiment_id;
      if (experimentId === null) return { stored, requeued, simStored };
      if (status === 'infra_failed') {
        const exp = (await one<{ status: ExperimentRow['status'] }>(client, 'SELECT status FROM experiments WHERE id = $1', [experimentId]))!;
        requeued = await requeue(client, id, locked.attempt, exp.status, label);
      }
      if (label === PAUSES_ARM) {
        // D26, amended by D37: the setup is wrong (a key, the model, a refused setting), so every
        // later trial of this config would fail the same way. Its arm stops claiming until someone
        // fixes it and resumes the arm; the other arm keeps running.
        const where = await one<{ task_id: string; config_name: string }>(
          client,
          'SELECT k.id AS task_id, c.name AS config_name FROM tasks k, configs c WHERE k.sha256 = $1 AND c.hash = $2',
          [locked.task_sha256, locked.config_hash],
        );
        const reason = `${where?.task_id ?? locked.task_sha256} on ${where?.config_name ?? locked.config_hash}, attempt ${locked.attempt}: ${configErrorReason(body.result, body.runner_report)}`;
        await pauseArm(client, experimentId, locked.config_hash, reason, configErrorFix(body.runner_report), { id, attempt: locked.attempt });
      }
      await finishIfDone(client, experimentId);
      // D32: the futility check and the guards, which may pause the experiment for review.
      await applyRunRules(client, experimentId);
      return { stored, requeued, simStored };
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
      sim_replies_stored: outcome.simStored,
      problems,
    };
  }

  /**
   * The new simulator replies a simulated-client trial reported in out/sim_replies.jsonl, to store
   * for later trials (D22). Only a file the API holds intact is read; anything it cannot use is
   * noted in `problems` and left out of the cache.
   */
  private async simReplies(
    trial: TrialRow,
    folder: string,
    files: { path: string; ok?: boolean }[],
    problems: string[],
  ): Promise<{ scope: SimScope; rows: SimReplyRow[] } | null> {
    const scope = simScope(trial.task_sha256, trial.spec);
    const entry = files.find((f) => f.path === SIM_REPLIES_FILE);
    if (!scope || !entry) return null;
    const file = entry.ok ? await locate(this.config.runsDir, folder, SIM_REPLIES_FILE) : null;
    if (!file) {
      problems.push(`${SIM_REPLIES_FILE} was not stored intact; its simulator replies are not cached`);
      return null;
    }
    const parsed = parseSimReplies(await fs.readFile(file, 'utf8'), scope.sim_model);
    problems.push(...parsed.problems);
    return { scope, rows: parsed.rows };
  }

  private async duplicate(trial: TrialRow): Promise<ReportResponse> {
    const [next] = await this.db.query<{ id: string }>(
      `SELECT id FROM trials WHERE experiment_id = $1 AND task_sha256 = $2 AND config_hash = $3 AND repeat_index = $4 AND attempt = $5`,
      [trial.experiment_id, trial.task_sha256, trial.config_hash, trial.repeat_index, trial.attempt + 1],
    );
    const [count] = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM spans WHERE trial_id = $1', [trial.id]);
    const [sim] = await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM sim_replies WHERE trial_id = $1', [trial.id]);
    return {
      trial_id: trial.id,
      attempt: trial.attempt,
      status: trial.status,
      duplicate: true,
      requeued_trial_id: next?.id ?? null,
      spans_stored: count?.n ?? 0,
      sim_replies_stored: sim?.n ?? 0,
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
      const { rows } = await client.query<{ id: string; experiment_id: string | null; attempt: number; status: ExperimentRow['status'] | null }>(
        `WITH lapsed AS (
           UPDATE trials SET status = 'abandoned', finished_at = now()
           WHERE id IN (
             SELECT id FROM trials
             WHERE status IN ('claimed', 'running') AND heartbeat_at < now() - make_interval(secs => $1::double precision)
             FOR UPDATE SKIP LOCKED)
           RETURNING id, experiment_id, attempt)
         SELECT l.id, l.experiment_id, l.attempt, e.status FROM lapsed l LEFT JOIN experiments e ON e.id = l.experiment_id`,
        [LEASE_S],
      );
      const requeued: string[] = [];
      for (const r of rows) {
        // A lapsed probe (no experiment) is not re-queued; POST rendered-prompt probes again.
        const next = r.status === null ? null : await requeue(client, r.id, r.attempt, r.status, null);
        if (next) requeued.push(next);
      }
      for (const exp of new Set(rows.map((r) => r.experiment_id))) {
        if (exp === null) continue; // a probe
        await finishIfDone(client, exp);
        await applyRunRules(client, exp); // D32: an abandoned attempt counts for the infra guard
      }
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
