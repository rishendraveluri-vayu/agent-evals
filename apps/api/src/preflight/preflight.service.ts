import { Inject, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import type { ConflictCheckView, ConflictFinding, RenderedPrompt, RenderedPromptView, StoredFile, TrialStatus } from '../contract';
import { ApiError, conflict } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { newId } from '../common/ids';
import { CatalogueService, type StoredPrompt } from '../catalogue/catalogue.service';
import { type ConfigRow, ConfigsService } from '../configs/configs.service';
import { Db } from '../database/db.service';
import { LiteLlmClient, type MintedKey } from '../litellm/litellm.client';
import { SpendService } from '../spend/spend.service';
import { FINISHED } from '../trials/status';
import { locate } from '../trials/trial-files';
import {
  CHECKER_MAX_TOKENS,
  CHECKER_MODEL,
  CHECKER_PROMPT_ID,
  CHECK_KEY_BUDGET_USD,
  CHECK_KIND,
  CHECK_TIMEOUT_MS,
  type CallCost,
  callCost,
  checkInputSha,
  checkerInput,
  parseFindings,
  replyOf,
  worstCaseUsd,
} from './conflict-check';
import { FIRST_REQUEST_FILE, PROBE_MODEL, PROBE_TASK_BODY, PROBE_TASK_SHA256, PROBE_TASK_SOURCE } from './probe';
import { type RenderOutcome, harnessOwnText, renderFromRequest } from './rendered-prompt';

interface ProbeRow {
  id: string;
  status: TrialStatus;
  label: string | null;
  end_state: string | null;
  folder: string | null;
  files: StoredFile[] | null;
}

interface RenderedRow {
  config_hash: string;
  trial_id: string;
  sha256: string;
  system_text: string;
  tools: string[];
  ours_start: number | null;
  ours_end: number | null;
  harness_text: string;
  normalised: string[];
  caveats: string[];
  created_at: Date;
}

interface CheckRow {
  id: string;
  input_sha256: string;
  rendered_sha256: string;
  checker_sha256: string;
  checker_version: string;
  model: string;
  conflicts: ConflictFinding[];
  notes: string;
  spend_id: string | null;
  created_at: Date;
}

interface CheckInputs {
  cfg: ConfigRow;
  rendered: RenderedPrompt;
  checker: StoredPrompt;
  taskPrompt: string;
  inputSha: string;
}

const PROBE_SELECT = 'SELECT id, status, label, end_state, folder, files FROM trials';

function renderedOf(r: RenderedRow): RenderedPrompt {
  return {
    sha256: r.sha256,
    system_text: r.system_text,
    tools: r.tools,
    ours: r.ours_start === null || r.ours_end === null ? null : { start: r.ours_start, end: r.ours_end },
    harness_text: r.harness_text,
    normalised: r.normalised,
    caveats: r.caveats,
    trial_id: r.trial_id,
    created_at: r.created_at.toISOString(),
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Before a run (D33, D38): the rendered prompt a harness really sends, read from a probe trial on
 * the fake model, and a conflict check of that prompt against ours on Claude Sonnet 5.5, paid from
 * a standing allowance and recorded as system spend.
 */
@Injectable()
export class PreflightService {
  private readonly logger = new Logger(PreflightService.name);
  /** How long to wait for LiteLLM's spend log to show a check's call; rows land about 1 s after it. */
  spendLogWaitMs = 10_000;
  spendLogPollMs = 300;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly catalogue: CatalogueService,
    private readonly configs: ConfigsService,
    private readonly litellm: LiteLlmClient,
    private readonly spend: SpendService,
  ) {}

  // ---- rendered prompt ----

  /**
   * The config's rendered prompt. Stored once per config hash; until then it comes from the
   * config's latest finished probe. With `start`, a new probe is queued when there is none or the
   * last one gave no prompt (at most one live probe per config).
   */
  async renderedPrompt(hashInput: string, start: boolean): Promise<RenderedPromptView> {
    const cfg = await this.configs.row(hashInput);
    const latest = await this.latestProbe(cfg.hash);
    const stored = await this.storedRendered(cfg.hash);
    if (stored) return this.view(cfg.hash, 'ready', latest, true, null, stored);
    let error: string | null = null;
    if (latest && FINISHED.includes(latest.status)) {
      const outcome = await this.readProbe(latest, cfg);
      if (outcome.ok) return this.view(cfg.hash, 'ready', latest, false, null, await this.saveRendered(cfg.hash, latest.id, outcome.rendered));
      error = outcome.error;
    }
    if (start && (!latest || error !== null)) {
      const probe = await this.startProbe(cfg);
      return this.view(cfg.hash, liveStatus(probe.status), probe, false, null, null);
    }
    if (!latest) return this.view(cfg.hash, 'none', null, false, null, null);
    if (error !== null) return this.view(cfg.hash, 'failed', latest, false, error, null);
    return this.view(cfg.hash, liveStatus(latest.status), latest, false, null, null);
  }

  private view(
    configHash: string,
    status: RenderedPromptView['status'],
    probe: ProbeRow | null,
    cached: boolean,
    error: string | null,
    rendered: RenderedPrompt | null,
  ): RenderedPromptView {
    return {
      config_hash: configHash,
      status,
      probe: probe ? { trial_id: probe.id, status: probe.status, label: probe.label, model: PROBE_MODEL } : null,
      cached,
      error,
      rendered,
    };
  }

  private async latestProbe(configHash: string): Promise<ProbeRow | null> {
    const [r] = await this.db.query<ProbeRow>(`${PROBE_SELECT} WHERE probe AND config_hash = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [configHash]);
    return r ?? null;
  }

  private async storedRendered(configHash: string): Promise<RenderedPrompt | null> {
    const [r] = await this.db.query<RenderedRow>('SELECT * FROM rendered_prompts WHERE config_hash = $1', [configHash]);
    return r ? renderedOf(r) : null;
  }

  /** Queues one probe trial for the config's harness, on PROBE_MODEL, outside any experiment. */
  private async startProbe(cfg: ConfigRow): Promise<ProbeRow> {
    await this.db.query(
      `INSERT INTO tasks (sha256, id, version, split, kind, summary, body, client_state_name, client_state, client_state_sha256, source_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, $8) ON CONFLICT (sha256) DO NOTHING`,
      [PROBE_TASK_SHA256, PROBE_TASK_BODY.id, PROBE_TASK_BODY.version, PROBE_TASK_BODY.split, PROBE_TASK_BODY.kind, PROBE_TASK_BODY.summary, JSON.stringify(PROBE_TASK_BODY), PROBE_TASK_SOURCE],
    );
    const [inserted] = await this.db.query<ProbeRow>(
      `INSERT INTO trials (id, experiment_id, probe, task_sha256, config_hash, repeat_index, attempt, seq, order_index, harness, status)
       VALUES ($1, NULL, true, $2, $3, 0, 1, 0, 0, $4, 'queued')
       ON CONFLICT (config_hash) WHERE probe AND status IN ('queued', 'claimed', 'running') DO NOTHING
       RETURNING id, status, label, end_state, folder, files`,
      [newId('t'), PROBE_TASK_SHA256, cfg.hash, cfg.harness],
    );
    return inserted ?? ((await this.latestProbe(cfg.hash)) as ProbeRow);
  }

  /** The rendered prompt from a finished probe's stored first request, or why there is none. */
  private async readProbe(probe: ProbeRow, cfg: ConfigRow): Promise<RenderOutcome> {
    const entry = (probe.files ?? []).find((f) => f.path === FIRST_REQUEST_FILE);
    const ending = `label ${probe.label ?? 'none'}, end state ${probe.end_state ?? 'none'}`;
    if (!entry && probe.status === 'abandoned') return { ok: false, error: 'the probe’s worker stopped sending heartbeats before it reported; probe again' };
    if (!entry) return { ok: false, error: `the probe (${probe.status}, ${ending}) stored no ${FIRST_REQUEST_FILE}, so it never reached the model; see GET /api/trials/${probe.id}` };
    if (entry.ok === false) return { ok: false, error: `the probe’s ${FIRST_REQUEST_FILE} was not stored intact (${entry.problem ?? 'hash mismatch'})` };
    const file = probe.folder ? await locate(this.config.runsDir, probe.folder, FIRST_REQUEST_FILE) : null;
    if (!file) return { ok: false, error: `the probe’s ${FIRST_REQUEST_FILE} is missing from its folder` };
    let request: unknown;
    try {
      request = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch {
      return { ok: false, error: `the probe’s ${FIRST_REQUEST_FILE} is not JSON` };
    }
    const outcome = renderFromRequest(request, await this.promptText(cfg.prompt_sha256), PROBE_MODEL);
    if (outcome.ok && probe.label !== 'agent') {
      outcome.rendered.caveats.push(`The probe ended ${ending}; its first request is still exactly what the model was sent.`);
    }
    return outcome;
  }

  private async saveRendered(configHash: string, trialId: string, r: Extract<RenderOutcome, { ok: true }>['rendered']): Promise<RenderedPrompt> {
    await this.db.query(
      `INSERT INTO rendered_prompts (config_hash, trial_id, sha256, system_text, tools, ours_start, ours_end, harness_text, normalised, caveats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (config_hash) DO NOTHING`,
      [configHash, trialId, r.sha256, r.system_text, JSON.stringify(r.tools), r.ours?.start ?? null, r.ours?.end ?? null, r.harness_text, JSON.stringify(r.normalised), JSON.stringify(r.caveats)],
    );
    return (await this.storedRendered(configHash)) as RenderedPrompt;
  }

  private async promptText(sha256: string): Promise<string> {
    const [p] = await this.db.query<{ text: string }>('SELECT text FROM prompts WHERE sha256 = $1', [sha256]);
    if (!p) throw new ApiError(500, 'missing_prompt', `prompt ${sha256} is not stored`);
    return p.text;
  }

  // ---- conflict check ----

  /** The stored check for the config's current input, or null when none is stored yet. */
  async storedCheck(hashInput: string): Promise<ConflictCheckView | null> {
    const i = await this.checkInputs(hashInput);
    const hit = await this.cachedCheck(i);
    return hit ? this.checkView(i, hit, true) : null;
  }

  /**
   * Runs the conflict check once per input (rendered prompt, our prompt, settings), checker
   * version and model; a stored result is returned without a call. One check runs at a time, so
   * two requests for the same prompt never both pay.
   */
  async conflictCheck(hashInput: string): Promise<ConflictCheckView> {
    const i = await this.checkInputs(hashInput);
    const hit = await this.cachedCheck(i);
    if (hit) return this.checkView(i, hit, true);
    if (!harnessOwnText(i.rendered.harness_text)) {
      return {
        ...this.baseView(i),
        conflicts: [],
        notes: 'The harness sends our task prompt as the whole system prompt and adds no text of its own, so there is nothing to conflict with. No call was made.',
        cost_usd: 0,
        cached: false,
        skipped: 'no_harness_text',
        spend_id: null,
        checked_at: new Date().toISOString(),
        allowance: await this.spend.allowance(CHECK_KIND),
      };
    }
    if (i.rendered.ours === null) {
      throw conflict('task_prompt_not_located', 'our task prompt was not found verbatim in the rendered prompt, so the harness text cannot be separated from it; see the rendered prompt’s caveats');
    }
    return this.spend.exclusive(CHECK_KIND, async () => {
      const again = await this.cachedCheck(i);
      return again ? this.checkView(i, again, true) : this.runCheck(i);
    });
  }

  private async checkInputs(hashInput: string): Promise<CheckInputs> {
    const cfg = await this.configs.row(hashInput);
    const rendered = await this.storedRendered(cfg.hash);
    if (!rendered) {
      throw conflict('rendered_prompt_required', `config ${cfg.hash} has no rendered prompt yet; POST /api/configs/${cfg.hash}/rendered-prompt and wait for status ready`);
    }
    const checker = await this.catalogue.latestPrompt(CHECKER_PROMPT_ID);
    if (!checker) throw new ApiError(500, 'no_checker_prompt', `configs/prompts/${CHECKER_PROMPT_ID}.v<n>.md is missing`);
    return {
      cfg,
      rendered,
      checker,
      taskPrompt: await this.promptText(cfg.prompt_sha256),
      inputSha: checkInputSha({ renderedSha256: rendered.sha256, promptSha256: cfg.prompt_sha256, settings: cfg.settings }),
    };
  }

  private async cachedCheck(i: CheckInputs): Promise<CheckRow | undefined> {
    const [r] = await this.db.query<CheckRow>('SELECT * FROM conflict_checks WHERE input_sha256 = $1 AND checker_sha256 = $2 AND model = $3', [
      i.inputSha,
      i.checker.sha256,
      CHECKER_MODEL,
    ]);
    return r;
  }

  private baseView(i: CheckInputs): Pick<ConflictCheckView, 'config_hash' | 'rendered_sha256' | 'input_sha256' | 'checker' | 'model'> {
    return {
      config_hash: i.cfg.hash,
      rendered_sha256: i.rendered.sha256,
      input_sha256: i.inputSha,
      checker: { id: i.checker.id, version: i.checker.version, sha256: i.checker.sha256 },
      model: CHECKER_MODEL,
    };
  }

  private async checkView(i: CheckInputs, row: CheckRow, cached: boolean): Promise<ConflictCheckView> {
    return {
      ...this.baseView(i),
      conflicts: row.conflicts,
      notes: row.notes,
      cost_usd: row.spend_id ? await this.spend.cost(row.spend_id) : null,
      cached,
      skipped: null,
      spend_id: row.spend_id,
      checked_at: row.created_at.toISOString(),
      allowance: await this.spend.allowance(CHECK_KIND),
    };
  }

  /** One paid call: reserve the worst case, call with a minted key, settle from the spend log, store the findings. */
  private async runCheck(i: CheckInputs): Promise<ConflictCheckView> {
    const price = await this.litellm.findModel(CHECKER_MODEL);
    if (!price || price.inputPerToken === null || price.outputPerToken === null) {
      throw new ApiError(503, 'checker_model_unavailable', `LiteLLM serves no priced ${CHECKER_MODEL}; see services/litellm/config.yaml`);
    }
    const system = i.checker.text;
    const user = checkerInput(i.rendered.harness_text, i.taskPrompt, i.cfg.settings);
    const reservedUsd = worstCaseUsd(system.length + user.length, { inputPerToken: price.inputPerToken, outputPerToken: price.outputPerToken });
    const ref = `config:${i.cfg.hash}`;
    const { id: spendId } = await this.spend.reserve({ kind: CHECK_KIND, model: CHECKER_MODEL, ref, reservedUsd });

    let key: MintedKey | null = null;
    let response: Awaited<ReturnType<LiteLlmClient['chat']>> | null = null;
    let failure: string | null = null;
    try {
      key = await this.litellm.generateSystemKey({
        alias: `system:${CHECK_KIND}:${spendId}`,
        model: CHECKER_MODEL,
        maxBudgetUsd: CHECK_KEY_BUDGET_USD,
        metadata: { kind: CHECK_KIND, spend_id: spendId, ref },
      });
      // D38: temperature not sent, thinking at the model's default; max_tokens covers thinking too.
      response = await this.litellm.chat(
        key.key,
        { model: CHECKER_MODEL, max_tokens: CHECKER_MAX_TOKENS, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
        CHECK_TIMEOUT_MS,
      );
    } catch (err) {
      failure = message(err);
    }
    const cost: CallCost = key
      ? callCost(await this.spendRows(key.token), response ?? { body: null, responseCostUsd: null })
      : { costUsd: 0, source: 'no_call', inputTokens: null, outputTokens: null, requestId: null };
    if (key) await this.litellm.deleteKeys([key.token]).catch((err: unknown) => this.logger.warn(`could not revoke the ${CHECK_KIND} key ${spendId}: ${message(err)}`));

    const fail = async (code: string, why: string): Promise<never> => {
      await this.spend.settle(spendId, { ok: false, cost, error: why });
      throw new ApiError(502, code, `${why} (recorded as system spend ${spendId}${cost.costUsd === null ? '' : `, $${cost.costUsd}`})`);
    };
    if (failure !== null || !response) return fail('checker_call_failed', `the ${CHECKER_MODEL} call failed: ${failure ?? 'no reply'}`);
    if (response.status !== 200) return fail('checker_call_failed', `LiteLLM answered ${response.status}: ${response.text.slice(0, 300)}`);
    const reply = replyOf(response.body);
    if (reply.text === null) return fail('checker_output_invalid', `the reply has no text (finish reason ${reply.finishReason ?? 'none'})`);
    const parsed = parseFindings(reply.text);
    if (!parsed.ok) {
      const cut = reply.finishReason === 'length' ? `; the reply was cut off at max_tokens ${CHECKER_MAX_TOKENS}, which thinking counts towards` : '';
      return fail('checker_output_invalid', `the checker’s reply is not usable: ${parsed.error}${cut}. Reply starts: ${reply.text.slice(0, 200)}`);
    }
    await this.spend.settle(spendId, { ok: true, cost, error: null });
    await this.db.query(
      `INSERT INTO conflict_checks (id, input_sha256, rendered_sha256, checker_sha256, checker_version, model, config_hash, conflicts, notes, raw_reply, spend_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (input_sha256, checker_sha256, model) DO NOTHING`,
      [`cc_${spendId.slice(3)}`, i.inputSha, i.rendered.sha256, i.checker.sha256, i.checker.version, CHECKER_MODEL, i.cfg.hash, JSON.stringify(parsed.findings.conflicts), parsed.findings.notes, reply.text, spendId],
    );
    return this.checkView(i, (await this.cachedCheck(i)) as CheckRow, false);
  }

  /** The key's spend-log rows, waiting up to spendLogWaitMs for the first to land. Errors read as none. */
  private async spendRows(token: string): Promise<unknown[]> {
    const deadline = Date.now() + this.spendLogWaitMs;
    for (;;) {
      const rows = await this.litellm.spendLogs(token).catch(() => [] as unknown[]);
      if (rows.length || Date.now() >= deadline) return rows;
      await new Promise((r) => setTimeout(r, this.spendLogPollMs));
    }
  }
}

function liveStatus(status: TrialStatus): RenderedPromptView['status'] {
  return status === 'queued' ? 'queued' : 'running';
}
