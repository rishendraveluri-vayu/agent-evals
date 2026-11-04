/**
 * Request and response types for the control-plane API, written from docs/api-contract.md
 * (4 Nov). They stand in until the API's own contract types are merged; swap the imports then.
 *
 * Where the contract names a field but not its shape, the type here is marked PROVISIONAL and
 * is the UI's reading of it. Where a screen needs something the contract does not carry yet,
 * the field is optional and marked NOT IN CONTRACT; screens render without it.
 */

/** `sha256:<hex>` */
export type Sha256 = string;

// ---------------------------------------------------------------------------------------------
// Catalogue

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

export type EffectStatus = 'effective' | 'inert' | 'not_checked';

/** One setting in capabilities.json (contract v2, capabilities.schema.json `$defs.setting`). */
export interface CapabilitySetting {
  supported: boolean;
  native?: string;
  default?: unknown;
  /** `probe:<date>`, `declared:<reason>` or `none`. */
  evidence: string;
  extra_calls_at_limit?: number;
  observed?: string;
  /** D24 effect checks, keyed by model name. */
  effect?: Record<string, { status: EffectStatus; evidence: string }>;
}

export interface Capabilities {
  contract_version: '2';
  harness: string;
  version: { package: string; ref: string };
  model_api_formats: ('openai_chat' | 'anthropic_messages')[];
  settings: Record<SettingName, CapabilitySetting>;
  harness_options_schema: { properties?: Record<string, { type?: string; description?: string }> } & Record<string, unknown>;
  known_differences: string[];
}

/** `GET /harnesses` */
export interface Harness {
  name: string;
  package: string;
  ref: string;
  python: string;
  capabilities: Capabilities;
}

/** `GET /prompts` */
export interface Prompt {
  id: string;
  version: string;
  sha256: Sha256;
  path: string;
  text: string;
}

/** `GET /toolsets` */
export interface Toolset {
  id: string;
  version: string;
  sha256: Sha256;
  servers: { name: string; allowed_tools: string[] }[];
}

/** One entry of a task's `graders`. PROVISIONAL: the grader format is [Rishi designs] in SP4. */
export interface GraderSpec {
  kind?: string;
  id?: string;
  [key: string]: unknown;
}

/** `GET /tasks` */
export interface TaskInfo {
  sha256: Sha256;
  id: string;
  version: string;
  split: string;
  kind: string;
  summary: string;
  graders: GraderSpec[];
}

/** `GET /models` */
export interface ModelInfo {
  name: string;
  provider: string;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
}

// ---------------------------------------------------------------------------------------------
// Configs

export type SettingValue = number | boolean;
export type Settings = Partial<Record<SettingName, SettingValue>>;

/** `POST /configs` */
export interface ConfigCreate {
  name: string;
  harness: string;
  model: string;
  prompt_sha256: Sha256;
  toolset_sha256: Sha256;
  settings: Settings;
  harness_options: Record<string, unknown>;
}

/** A versioned file a config points at. PROVISIONAL: the contract names `prompt` and `toolset`
 *  on a config without their shape. */
export interface VersionRef {
  id: string;
  version: string;
  sha256: Sha256;
}

/** `GET /configs`, `GET /configs/:hash` */
export interface Config {
  hash: Sha256;
  name: string;
  harness: string;
  harness_ref: string;
  model: string;
  prompt: VersionRef;
  toolset: VersionRef;
  settings: Settings;
  settings_sources: Record<string, string>;
  harness_options: Record<string, unknown>;
  created_at: string;
}

/** `GET /configs/:a/diff/:b` */
export interface ConfigDiffEntry {
  path: string;
  a: unknown;
  b: unknown;
}

// ---------------------------------------------------------------------------------------------
// Experiments

/** `POST /experiments/estimate` */
export interface EstimateRequest {
  config_hashes: Sha256[];
  task_sha256s: Sha256[];
  n: number;
  sim_model: string | null;
}

export interface Estimate {
  trials: number;
  cost_usd: { expected: number; low: number; high: number };
  minutes: number;
  basis: string;
  /** NOT IN CONTRACT YET: SP6 adds it. The smallest difference in points the run detects with
   *  the given power. */
  min_detectable_effect?: { points: number; power: number } | null;
  /** NOT IN CONTRACT: how many trials run at once, for the time estimate's note. */
  concurrency?: number;
}

/** `POST /experiments` */
export interface ExperimentCreate {
  name: string;
  axis: string;
  config_hashes: Sha256[];
  task_sha256s: Sha256[];
  n: number;
  sim_model: string | null;
  budget_usd: number;
  plan_commit: string;
}

/** PROVISIONAL: the contract does not list experiment statuses. The UI knows created, running,
 *  done and cancelled, and shows any other value as it comes. */
export type ExperimentStatus = string;

/** `counts` on an experiment. The contract says done "is split by label"; it is read here as
 *  either a number or a map of label to count. */
export interface TrialCounts {
  queued: number;
  running: number;
  done: number | Record<string, number>;
  infra_failed: number;
  abandoned: number;
  cancelled: number;
}

/** `GET /experiments` */
export interface Experiment {
  id: string;
  name: string;
  axis: string;
  status: ExperimentStatus;
  config_hashes: Sha256[];
  n: number;
  counts: TrialCounts;
  spend_usd: number;
  estimate: Estimate | null;
  created_at: string;
  /** NOT IN CONTRACT on the list; set on create. */
  task_sha256s?: Sha256[];
  budget_usd?: number;
  plan_commit?: string;
  platform_commit?: string;
  sim_model?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}

/** One entry of `events`. PROVISIONAL: the contract lists the kinds (claims, infra failures,
 *  re-queues, budget trips) but not the shape. */
export interface ExperimentEvent {
  at: string;
  kind: string;
  trial_id?: string | null;
  message: string;
}

/** `GET /experiments/:id` */
export interface ExperimentDetail extends Experiment {
  tasks: TaskInfo[];
  configs: Config[];
  events: ExperimentEvent[];
}

/** PROVISIONAL: the trial status machine in docs/proposals/data-model.md. */
export type TrialStatus = 'queued' | 'claimed' | 'running' | 'done' | 'infra_failed' | 'abandoned' | 'cancelled';

/** `GET /experiments/:id/trials` entry. PROVISIONAL: the contract says "trial summaries". */
export interface ExperimentTrial {
  id: string;
  /** Task sha256 (or id). */
  task: string;
  /** Config hash. */
  config: Sha256;
  repeat_index: number;
  attempt: number;
  status: TrialStatus;
  label: string | null;
  end_state: string | null;
  /** From the grades: true when every check passed, null when not graded. */
  passed: boolean | null;
  cost_usd: number | null;
  wall_s: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

/** `GET /experiments/:id/compare` row: one task and one arm. */
export interface CompareRow {
  /** Task sha256 (or id). */
  task: string;
  /** Config hash. */
  config: Sha256;
  passed: number;
  graded: number;
  trials: number;
}

/** A point estimate with its interval. */
export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

/** PROVISIONAL: `stats` is null until SP6, which owns this shape. This is what the compare
 *  screen reads. Differences are B minus A, in percentage points for pass rate. */
export interface CompareStats {
  measure: 'pass_rate';
  level: number;
  a: { rate: number; passed: number; graded: number };
  b: { rate: number; passed: number; graded: number };
  diff: Interval;
  p_value: number | null;
  method: string;
  verdict: 'better' | 'worse' | 'no_clear_difference';
  tasks: { task: string; diff: Interval; significant: boolean }[];
  correction: string | null;
  aa: { experiment_id: string; diff: Interval } | null;
  costs: { metric: 'cost_usd' | 'wall_s' | 'tokens'; a: number; b: number; diff: Interval; relative: Interval | null }[];
  judge: { kappa: number; low: number; high: number; bar: number; tasks: number } | null;
}

/** `GET /experiments/:id/compare` */
export interface Compare {
  rows: CompareRow[];
  stats: CompareStats | null;
}

// ---------------------------------------------------------------------------------------------
// Trials

/** A grade. PROVISIONAL: from the `grades` table in docs/proposals/data-model.md. */
export interface Grade {
  grader_id: string;
  grader_version: string;
  kind: string;
  /** The check, in words. */
  name: string;
  verdict: 'pass' | 'fail';
  score: number | null;
  evidence: string[];
  rationale: string | null;
  judge_model: string | null;
  run_index: number;
}

/** LiteLLM's numbers for one trial. PROVISIONAL. */
export interface TrialUsage {
  calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  complete: boolean | null;
  /** Simulator calls, kept apart from the agent's. */
  sim_calls?: number | null;
}

export interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** `GET /trials/:id` for a trial recorded in an experiment. */
export interface Trial {
  id: string;
  experiment_id: string | null;
  task: string;
  config: Sha256;
  repeat_index: number;
  attempt: number;
  status: TrialStatus;
  label: string | null;
  end_state: string | null;
  result: TrialResult | null;
  runner_report: Record<string, unknown> | null;
  usage: TrialUsage | null;
  timing: { started_at?: string | null; ended_at?: string | null; wall_s?: number | null; startup_s?: number | null } | null;
  files: FileEntry[];
  grades: Grade[];
}

/** The parts of contract v2 result.json the UI reads. */
export interface TrialResult {
  end_state?: string;
  end_detail?: Record<string, unknown>;
  final_answer?: string | null;
  conversation?: {
    agent_turns?: number;
    client_turns?: number;
    ended_by?: string | null;
    transcript?: { role: string; content: string; source?: string }[];
  };
  harness?: { name?: string; version?: string };
  applied_settings?: Record<string, { value: unknown; source: string; observed?: string }>;
  counts?: { model_calls?: number; tool_calls?: number; tool_errors?: number; malformed_tool_calls?: number };
  timing?: { started_at?: string; ended_at?: string; wall_s?: number };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// Labels and the judge

export type LabelSet = 'tuning' | 'heldout' | 'final';
export type LabelValue = 'yes' | 'no' | 'unsure';

/** A criterion on a blind item. PROVISIONAL: a plain string is read as its own id. */
export type Criterion = string | { id: string; question: string };

/** `GET /labels/queue?set=` item. Blind: no harness, model, arm, timing, cost or grade. */
export interface BlindItem {
  item_id: string;
  /** NOT IN CONTRACT: the task id names the task, not the arm, so it keeps the item blind. */
  task_id?: string;
  task_summary: string;
  transcript: { role: string; content: string }[];
  tool_calls: { name: string; arguments: unknown; result: unknown }[];
  criteria: Criterion[];
}

/** `POST /labels` */
export interface LabelCreate {
  item_id: string;
  set: LabelSet;
  criterion: string;
  value: LabelValue;
  note: string;
}

/** PROVISIONAL: `GET /judge/agreement` is SP5 and returns null until then. */
export interface JudgeAgreement {
  set: LabelSet;
  labels: number;
  agree: number;
  kappa: Interval;
  bar: number;
  /** Rows are the judge's verdict, columns yours. */
  matrix: { judge_pass_you_pass: number; judge_pass_you_fail: number; judge_fail_you_pass: number; judge_fail_you_fail: number };
  per_config: { config: Sha256; labels: number; kappa: number }[];
  retest: { identical: number; total: number; runs: number; note: string | null } | null;
  self: { same: number; total: number } | null;
  disagreements: { trial_id: string | null; task: string; criterion: string; you: LabelValue; judge: 'pass' | 'fail'; evidence: string }[];
}

// ---------------------------------------------------------------------------------------------
// Errors

/** `{"error": "<code>", "message": "<plain words>"}` */
export interface ApiErrorBody {
  error: string;
  message: string;
}
