/**
 * Request and response types for the control-plane API (docs/api-contract.md).
 *
 * This file has no imports and no runtime dependencies, so the UI can copy it as is
 * (or import it by path) and stay in step with the API. Every path below is served under
 * the `/api` prefix, for example `GET /api/configs`.
 *
 * Contract v2 shapes (spec, result, runner report, span) are carried unchanged; they are
 * typed loosely here as `Json` because their schemas live in `contract/v2/*.schema.json`.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** `sha256:<64 hex>`. Inputs also accept the bare hex. */
export type Sha256 = string;

/** Every 4xx/5xx body. `fix`, when present, says what to change so the request succeeds. */
export interface ApiErrorBody {
  error: string;
  message: string;
  fix?: string;
}

// ---- Settings (contract v2 section 3) ------------------------------------------------

export const SETTING_NAMES = [
  'temperature',
  'max_output_tokens',
  'max_steps',
  'timeout_s',
  'parallel_tool_calls',
  'memory',
  'skills',
  'compression',
] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

export interface Toggle {
  enabled: boolean;
}

/**
 * Resolved settings: an unsupported setting is null (source `unsupported`), and so is one that is
 * not sent (source `harness_default`, D25): the harness's or provider's own default applies.
 */
export interface Settings {
  temperature: number | null;
  max_output_tokens: number | null;
  max_steps: number | null;
  timeout_s: number;
  parallel_tool_calls: boolean | null;
  memory: Toggle | null;
  skills: Toggle | null;
  compression: Toggle | null;
}

export type SettingSource = 'config' | 'platform_default' | 'harness_default' | 'unsupported';
export type SettingsSources = Record<SettingName, SettingSource>;

// ---- Catalogue -----------------------------------------------------------------------

/** GET /harnesses */
export interface HarnessView {
  name: string;
  package: string;
  ref: string;
  python: string | null;
  /** The worker project's version (workers/<dir>/pyproject.toml). */
  adapter_version: string;
  capabilities_sha256: Sha256;
  capabilities: JsonObject;
}

/** GET /prompts */
export interface PromptView {
  id: string;
  version: string;
  sha256: Sha256;
  path: string;
  text: string;
}

export interface ToolsetServer {
  name: string;
  allowed_tools: string[];
}

/** GET /toolsets */
export interface ToolsetView {
  id: string;
  version: string;
  sha256: Sha256;
  servers: ToolsetServer[];
}

export type TaskSplit = 'discovery' | 'held_out';

/** GET /tasks */
export interface TaskView {
  sha256: Sha256;
  id: string;
  version: string;
  split: TaskSplit;
  /** task.json `kind` if set, otherwise `conversation` (has client_sim) or `single_prompt`. */
  kind: string;
  /** task.json `summary` if set, otherwise the first message, cut to 200 characters. */
  summary: string;
  graders: Json[];
  /** Why this task cannot be used in an experiment; empty when it can. */
  problems: string[];
}

/** GET /models: real models only. */
export interface ModelView {
  name: string;
  provider: string | null;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
}

// ---- Configs -------------------------------------------------------------------------

/** POST /configs. `settings` holds only what the config sets; the rest come from defaults. */
export interface CreateConfigRequest {
  name: string;
  harness: string;
  model: string;
  prompt_sha256: Sha256;
  toolset_sha256: Sha256;
  settings?: Partial<Record<SettingName, Json>>;
  harness_options?: JsonObject;
  /** D34: the config this one was forked from. Not part of the hash; the first post records it. */
  parent_hash?: Sha256 | null;
}

export interface VersionRef {
  id: string;
  version: string;
  sha256: Sha256;
}

/** A valid but risky config: the API stores it and says what will happen and how to avoid it. */
export interface ConfigWarning {
  /** `langgraph_model_name_rewrite`: langchain-openai changes the request by the model's name. */
  code: string;
  message: string;
  fix: string;
}

/** GET /configs, GET /configs/:hash, and POST /configs (201 new, 200 already stored). */
export interface ConfigView {
  hash: Sha256;
  name: string;
  harness: string;
  harness_ref: string;
  adapter_version: string;
  capabilities_sha256: Sha256;
  model: string;
  prompt: VersionRef;
  toolset: VersionRef;
  settings: Settings;
  settings_sources: SettingsSources;
  /**
   * Settings this harness or model ignores, each with a reason to show by the greyed-out field:
   * the harness's own words (capabilities.json), or the model's refusal (D25).
   */
  unsupported: Partial<Record<SettingName, string>>;
  warnings: ConfigWarning[];
  harness_options: JsonObject;
  /** D34: the config this one was forked from, or null. */
  parent_hash: Sha256 | null;
  created_at: string;
}

/** GET /configs/:hash: the config and the configs forked from it (D34), oldest first. */
export interface ConfigDetail extends ConfigView {
  children: { hash: Sha256; name: string; created_at: string }[];
}

/** GET /configs/:a/diff/:b */
export interface ConfigDiffEntry {
  path: string;
  a: Json | undefined;
  b: Json | undefined;
}

// ---- Experiments ---------------------------------------------------------------------

/** POST /experiments/estimate */
export interface EstimateRequest {
  config_hashes: Sha256[];
  task_sha256s: Sha256[];
  n: number;
  sim_model?: string | null;
}

export interface CostRange {
  expected: number;
  low: number;
  high: number;
}

export interface EstimateCell {
  config: Sha256;
  task: Sha256;
  model: string;
  /** `history`: the mean of earlier finished trials of this config and task. */
  source: 'history' | 'assumption';
  trials_seen: number;
  input_tokens: number;
  output_tokens: number;
  wall_s: number;
  agent_usd_per_trial: number;
  sim_usd_per_trial: number;
}

export interface Estimate {
  trials: number;
  cost_usd: CostRange;
  minutes: number;
  /** Plain words: where the per-trial tokens and the prices came from. */
  basis: string;
  basis_detail: {
    cells: EstimateCell[];
    prices: Record<string, { input_per_mtok: number; output_per_mtok: number }>;
    assumptions: {
      input_tokens_per_trial: number;
      output_tokens_per_trial: number;
      wall_s_per_trial: number;
      sim_input_tokens_per_call: number;
      sim_output_tokens_per_call: number;
      low_factor: number;
      high_factor: number;
    };
  };
  /** Per-trial LiteLLM key budgets this estimate implies (safety nets, R10.6). */
  budgets: { trial_usd: number; sim_usd: number };
}

/**
 * D32's futility check, once per arm: when an arm has `after` finished trials (status `done`), it
 * pauses the experiment if fewer than `min_passed` of them passed. Until graders exist (SP4),
 * "passed" means label `agent` and end state `answered`.
 */
export interface FutilityRule {
  enabled: boolean;
  after: number;
  min_passed: number;
}

/** POST /experiments */
export interface CreateExperimentRequest {
  name: string;
  axis: string;
  config_hashes: Sha256[];
  task_sha256s: Sha256[];
  n: number;
  sim_model?: string | null;
  budget_usd: number;
  plan_commit?: string | null;
  /** Optional; defaults to the highest version of the `client-sim` prompt (v2 since D27). */
  sim_prompt_sha256?: Sha256 | null;
  /**
   * D32: the seed of the claim-order shuffle, 0 to 2^32 - 1. Optional: a random one is drawn and
   * recorded. The same seed, tasks, configs and N give the same order.
   */
  order_seed?: number | null;
  /** D32: left out (or null) for `{enabled: true, after: 3, min_passed: 1}`; `{enabled: false}` turns it off. */
  futility?: Partial<FutilityRule> | null;
}

export const TRIAL_STATUSES = [
  'queued',
  'claimed',
  'running',
  'done',
  'infra_failed',
  'abandoned',
  'cancelled',
] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

/** `paused` (D32): by hand, the futility check or a guard; `POST .../resume` (or `.../start`) resumes. */
export type ExperimentStatus = 'created' | 'running' | 'paused' | 'done' | 'cancelled';

/** Counts are trial rows (one row per attempt). `running` includes claimed rows. */
export interface ExperimentCounts {
  queued: number;
  running: number;
  done: number;
  infra_failed: number;
  abandoned: number;
  cancelled: number;
  /** Reported rows by runner label (`agent`, `infra:provider_error`, ...). */
  by_label: Record<string, number>;
  /** Done rows by end state (`answered`, `step_limit`, ...). */
  done_by_end_state: Record<string, number>;
}

/** GET /experiments rows; POST /experiments returns the detail below. */
export interface ExperimentSummary {
  id: string;
  name: string;
  axis: string;
  status: ExperimentStatus;
  config_hashes: Sha256[];
  task_sha256s: Sha256[];
  n: number;
  counts: ExperimentCounts;
  spend_usd: number;
  estimate: Estimate;
  budget_usd: number;
  created_at: string;
}

export type ExperimentEventKind =
  | 'created'
  | 'started'
  | 'cancelled'
  | 'finished'
  | 'claim'
  | 'infra_failure'
  | 'requeue'
  | 'abandoned'
  | 'budget_trip'
  | 'config_error'
  | 'paused'
  | 'resumed'
  | 'file_problem'
  // D37: an arm paused (its config error, or by hand) and resumed.
  | 'arm_paused'
  | 'arm_resumed'
  // D32: the experiment paused by the futility check or a guard.
  | 'futility_pause'
  | 'infra_guard_pause'
  | 'spend_guard_pause'
  // D34: whether arm A reuses the parent's trials, and why.
  | 'baseline';

export interface ExperimentEvent {
  at: string;
  kind: ExperimentEventKind;
  trial_id: string | null;
  attempt: number | null;
  /** The arm the event is about (`A` or `B`), or null for the whole experiment. */
  arm: string | null;
  config_hash: Sha256 | null;
  detail: string;
}

/**
 * One arm of an experiment (D35, D37). `status`:
 * - `not_started`: the experiment has not been started;
 * - `active`: trials still queued or running (claims also wait while the whole experiment is paused);
 * - `paused`: this arm claims nothing until it is resumed (`paused_reason`, `fix`);
 * - `stopped`: the experiment was stopped, so some of this arm's trials were cancelled;
 * - `complete`: every slot has a final attempt (done, or an infra failure that is not re-queued).
 */
export interface ArmView {
  arm: string;
  config_hash: Sha256;
  config_name: string;
  status: 'not_started' | 'active' | 'paused' | 'stopped' | 'complete';
  paused_at: string | null;
  paused_reason: string | null;
  /** How to fix what paused the arm (D37), for the UI to show next to the reason. */
  fix: string | null;
  /** Trial rows of this arm in this experiment, by status (`running` includes claimed). */
  counts: { queued: number; running: number; done: number; infra_failed: number; abandoned: number; cancelled: number };
}

/** GET /experiments/:id (and the POST /experiments response). */
export interface ExperimentDetail extends ExperimentSummary {
  sim_model: string | null;
  /** `temperature` null: not sent, the model's default applies (D27; Haiku 5.5 refuses any). */
  sim: { prompt: VersionRef; temperature: number | null; max_output_tokens: number } | null;
  platform_commit: string | null;
  plan_commit: string | null;
  /** D32: the seed the claim order was shuffled from; null for experiments made before it. */
  order_seed: number | null;
  /** D32: the futility rule as resolved at creation; null for experiments made before it (no check). */
  futility: FutilityRule | null;
  budgets: { trial_usd: number; sim_usd: number };
  started_at: string | null;
  finished_at: string | null;
  /**
   * When and why the whole experiment last paused (by hand, the futility check or a guard, D32);
   * null if never. A config error pauses only its arm (D37): see `arms`.
   */
  paused_at: string | null;
  paused_reason: string | null;
  /** Arm A, then arm B (one arm for a pilot). */
  arms: ArmView[];
  tasks: TaskView[];
  configs: ConfigView[];
  /** Newest first. */
  events: ExperimentEvent[];
}

/** GET /experiments/:id/trials?status=&config=&task= */
export interface TrialRowSummary {
  id: string;
  experiment_id: string;
  task_sha256: Sha256;
  task_id: string;
  config_hash: Sha256;
  config_name: string;
  harness: string;
  model: string;
  repeat_index: number;
  /** D32: the trial's place in the claim order (a re-queued attempt keeps its slot's). */
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
  claimed_at: string | null;
  finished_at: string | null;
}

/** GET /experiments/:id/compare */
export interface CompareRow {
  task: Sha256;
  task_id: string;
  /** `A` or `B`. */
  arm: string;
  config: Sha256;
  config_name: string;
  /** Agent-labelled trials whose every grade passed. */
  passed: number;
  /** Agent-labelled trials with at least one grade. */
  graded: number;
  /** Agent-labelled (gradable) trials. */
  trials: number;
  infra_failed: number;
  abandoned: number;
}

/**
 * D37, D32: no comparison until every arm is complete. While `status` is `incomplete`, `reason`
 * says why (an arm paused, trials left, a stop) and `rows` is empty, so nobody reads a verdict off
 * a partial run; `arms` shows each arm's progress either way.
 */
export interface CompareResponse {
  experiment_id: string;
  status: 'complete' | 'incomplete';
  reason: string | null;
  arms: ArmView[];
  rows: CompareRow[];
  /** SP6. Null until the stats exist. */
  stats: null;
}

// ---- Trials --------------------------------------------------------------------------

export interface StoredFile {
  path: string;
  bytes: number;
  /** `sha256:<hex>`, whichever form the report used. */
  sha256: string;
  /** The API holds the file (uploaded by the worker) with this size and hash. */
  ok?: boolean;
  problem?: string;
}

export interface Grade {
  id: number;
  grader_id: string;
  grader_version: string;
  kind: 'exact' | 'unit' | 'state' | 'judge';
  verdict: string | null;
  score: number | null;
  evidence: Json;
  judge_model: string | null;
  run_index: number;
  created_at: string;
}

/** GET /trials/:id for a trial made in an experiment. */
export interface TrialView {
  id: string;
  experiment_id: string;
  task: { sha256: Sha256; id: string; version: string; split: TaskSplit; kind: string; summary: string };
  config: {
    hash: Sha256;
    name: string;
    harness: string;
    harness_ref: string;
    model: string;
    prompt: VersionRef;
    toolset: VersionRef;
  };
  repeat_index: number;
  attempt: number;
  status: TrialStatus;
  label: string | null;
  end_state: string | null;
  spec: Json;
  result: Json;
  runner_report: Json;
  usage: {
    model_calls: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cost_usd: number | null;
    sim_cost_usd: number | null;
    complete: boolean | null;
  } | null;
  timing: {
    created_at: string;
    claimed_at: string | null;
    heartbeat_at: string | null;
    finished_at: string | null;
    started_at: string | null;
    ended_at: string | null;
    wall_s: number | null;
  };
  worker_id: string | null;
  files: StoredFile[];
  grades: Grade[];
  problems: string[];
}

// ---- Folder trials (gate and smoke runs outside an experiment, FileTrialStore) ----------

/** GET /trials rows: folder trials only, each with `experiment_id: null`. */
export interface FolderTrialSummary {
  experiment_id: null;
  trialId: string;
  harness: string;
  model: string | null;
  taskId: string | null;
  configHash: string | null;
  promptVersion: string | null;
  toolsetVersion: string | null;
  label: string;
  endState: string | null;
  startedAt: string | null;
  wallS: number | null;
  proxyCalls: number | null;
  proxyCostUsd: number | null;
  proxyInputTokens: number | null;
  proxyOutputTokens: number | null;
  proxyComplete: boolean | null;
  harnessCalls: number | null;
  toolCalls: number | null;
  toolErrors: number | null;
  malformedToolCalls: number | null;
  agentTurns: number | null;
  clientTurns: number | null;
}

/** GET /trials/:id for a folder trial. */
export interface FolderTrialDetail {
  experiment_id: null;
  summary: FolderTrialSummary;
  spec: Json;
  result: Json;
  report: Json;
}

/**
 * GET /trials/:id/spans for a folder trial: attributes as plain objects. For an experiment
 * trial the same path returns contract v2 spans (OTLP JSON) unchanged, as the contract says.
 */
export interface FolderSpanView {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startNs: string;
  endNs: string;
  statusCode: number;
  statusMessage: string | null;
  attributes: Record<string, unknown>;
  events: { name: string; timeNs: string; attributes: Record<string, unknown> }[];
}

// ---- Worker protocol (D2) --------------------------------------------------------------

/** POST /worker/claim. 204 when nothing is queued for the harness. */
export interface ClaimRequest {
  worker_id: string;
  harness: string;
}

export interface ClaimResponse {
  trial_id: string;
  attempt: number;
  experiment_id: string;
  /** A complete contract v2 spec; `model.base_url` is LiteLLM as seen from the worker. */
  spec: JsonObject;
  /** File name in /trial/state to base64 content. */
  state_files: Record<string, string>;
  /** LiteLLM virtual keys for this trial; `sim` is null without a client simulator. */
  keys: { model: string; sim: string | null };
  budgets: { trial_usd: number; sim_usd: number };
  lease_s: number;
  /** Where the API stores this attempt's uploaded files, relative to runs/. Workers never see runs/. */
  folder: string;
  /**
   * D22: every simulator reply stored so far for this task, simulator model, settings and prompt,
   * as `{cache_key: reply}` (keys from evals_adapter.sim.cache_key). Null without a simulator.
   */
  sim_cache: Record<string, string> | null;
}

/** POST /worker/trials/:id/heartbeat. 409 `claim_lost` means stop and report nothing. */
export interface HeartbeatRequest {
  worker_id: string;
  attempt: number;
}

export interface HeartbeatResponse {
  lease_s: number;
}

/**
 * PUT /worker/trials/:id/files/*path?worker_id=&attempt= with the raw bytes
 * (`Content-Type: application/octet-stream`, `Content-Length`, and `X-Content-Sha256` as
 * `sha256:<hex>` or bare hex). 201 when stored, 200 when the same bytes were already stored.
 */
export interface UploadResponse {
  path: string;
  bytes: number;
  sha256: Sha256;
  duplicate: boolean;
}

/** POST /worker/trials/:id/report */
export interface ReportRequest {
  worker_id: string;
  attempt: number;
  runner_report: JsonObject;
  result: JsonObject | null;
  spans: JsonObject[];
  /**
   * Every file of the trial's out/ folder, each already uploaded (PUT .../files/*path). The API
   * checks each against what it stored. `sha256` may be `sha256:<hex>` or bare hex.
   */
  files: { path: string; bytes: number; sha256: string }[];
}

export interface ReportResponse {
  trial_id: string;
  attempt: number;
  status: TrialStatus;
  /** True when this attempt had already been reported; nothing changed. */
  duplicate: boolean;
  /** The attempt queued after this one (infra failure on attempt 1), if any. */
  requeued_trial_id: string | null;
  spans_stored: number;
  /** New simulator replies from out/sim_replies.jsonl now in the cache (D22); 0 for repeats. */
  sim_replies_stored: number;
  problems: string[];
}

// ---- Labels (SP5) ----------------------------------------------------------------------

export const LABEL_SETS = ['tuning', 'heldout', 'final'] as const;
export type LabelSet = (typeof LABEL_SETS)[number];
export type LabelValue = 'yes' | 'no' | 'unsure';

export interface LabelCriterion {
  id: string;
  text: string;
}

/** GET /labels/queue?set= : blind, so no harness, model, arm, timing, cost or grade. */
export interface LabelQueueItem {
  item_id: string;
  task_summary: string;
  transcript: { role: string; content: string }[];
  tool_calls: { name: string; arguments: string | null; result: string | null; is_error: boolean | null }[];
  criteria: LabelCriterion[];
}

/** POST /labels */
export interface CreateLabelRequest {
  item_id: string;
  set: LabelSet;
  criterion: string;
  value: LabelValue;
  note?: string | null;
}

/** The line appended to labels/<set>.jsonl, and the POST /labels response. */
export interface LabelLine {
  item_id: string;
  trial_id: string;
  set: LabelSet;
  criterion: string;
  value: LabelValue;
  note: string | null;
  labelled_at: string;
}
