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

// ---- Seeds (contract v2 spec `seed`) -------------------------------------------------

/** A seeded skill, which the adapter writes in its harness's own form (Hermes: skills/<name>/SKILL.md). */
export interface SeedSkill {
  /** Lower-case letters, digits and hyphens, starting with a letter or digit. */
  name: string;
  description: string;
  body: string;
}

/** Config-given starting state, never learned state (R10.8). Both lists are empty for no seed. */
export interface Seed {
  /** Memory entries, in order; each at least one character. */
  memory: string[];
  skills: SeedSkill[];
}

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

/** POST /prompts: a new version of an existing prompt, written as configs/prompts/<id>.v<n>.md. */
export interface CreatePromptRequest {
  /** An existing prompt id, as in GET /prompts. */
  id: string;
  /** The version the text was edited from (an existing version of `id`), named in the file's header. */
  base_version: string;
  /** The prompt text, at most 50 KB (UTF-8). */
  text: string;
}

/** POST /prompts: 201 with the new version, or 200 with an existing version of the same text. */
export interface CreatedPrompt {
  id: string;
  version: string;
  sha256: Sha256;
  path: string;
}

export interface ToolsetServer {
  name: string;
  allowed_tools: string[];
}

/** One published tool: what the model is shown. */
export interface ToolsetTool {
  name: string;
  description: string | null;
  input_schema: Json;
}

/** GET /toolsets */
export interface ToolsetView {
  id: string;
  version: string;
  /** Covers id, version, servers and manifest, as canonical JSON (since 4 Nov; names only before). */
  sha256: Sha256;
  servers: ToolsetServer[];
  /** Per server: its version and each allowed tool's name, description and input schema. */
  manifest: { server: string; server_version: string; tools: ToolsetTool[] }[];
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
  /**
   * Seeded memory and skills (D39), in contract v2's seed shape; either list may be left out.
   * Part of the hash when not empty. Needs the harness to support the feature and the config to
   * turn it on.
   */
  seed?: { memory?: string[]; skills?: SeedSkill[] } | null;
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
  /** What every trial of this config starts with: both lists empty when nothing is seeded. */
  seed: Seed;
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
  /** Optional; defaults to the highest version of the `client-sim` prompt. */
  sim_prompt_sha256?: Sha256 | null;
  /** D34: the experiment this one follows from. */
  parent_experiment_id?: string | null;
  /** D34: reuse the parent's arm-A trials when nothing that matters differs (see BaselineDecision). */
  reuse_baseline?: boolean | null;
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
  /**
   * Where the per-trial tokens, cost and time came from (item 8): earlier finished trials of the same
   * config and task, else of the same harness and model, else the docs/cost.md assumptions.
   */
  source: 'config_task' | 'harness_model' | 'assumption';
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
    /** Per harness: live workers seen in the last 60 s, and how many the time assumes (at least 1). */
    workers?: Record<string, { live: number; used: number }>;
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
  /** Optional; defaults to the highest version of the `client-sim` prompt (v4 since 4 Nov). */
  sim_prompt_sha256?: Sha256 | null;
  /**
   * D32: the seed of the claim-order shuffle, 0 to 2^32 - 1. Optional: a random one is drawn and
   * recorded. The same seed, tasks, configs and N give the same order.
   */
  order_seed?: number | null;
  /** D32: left out (or null) for `{enabled: true, after: 3, min_passed: 1}`; `{enabled: false}` turns it off. */
  futility?: Partial<FutilityRule> | null;
  /** D34: the experiment this one follows from. */
  parent_experiment_id?: string | null;
  /** D34: reuse the parent's arm-A trials as arm A when nothing that matters differs. */
  reuse_baseline?: boolean | null;
}

/** POST /experiments/estimate: the estimate of what would run, and the baseline decision (D34). */
export interface EstimateResponse extends Estimate {
  baseline: BaselineDecision | null;
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
  /**
   * Trial rows of this arm, by status (`running` includes claimed): this experiment's, or for an
   * arm reused from the parent (D34), the parent's trials it took.
   */
  counts: { queued: number; running: number; done: number; infra_failed: number; abandoned: number; cancelled: number };
  /** D34: the parent experiment whose finished trials this arm reuses, or null if it runs its own. */
  reused_from: string | null;
  reused_trials: number;
}

/** Item 8: actual spend and time of an experiment's trials so far (reused trials are the parent's, not counted). */
export interface ActualSoFar {
  /** Trials that ended: done, infra_failed or abandoned. */
  finished_trials: number;
  spend_usd: number;
  /** Mean agent plus simulator cost of the trials with a recorded cost. */
  cost_per_trial_usd: number | null;
  wall_s_per_trial: number | null;
  /** From the start to the finish (or now). */
  elapsed_minutes: number | null;
  /** Spend so far plus the queued and running trials at their arm's cost so far (the spend guard's number). */
  projected_spend_usd: number;
}

/** D34: whether arm A reuses the parent's trials, and why; null when reuse was not asked for. */
export interface BaselineDecision {
  applied: boolean;
  /** "arm A reuses 6 finished trials of e_... " or "arm A runs again: the platform commit differs (...)". */
  reason: string;
  reused_trials: number;
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
  /** D34: the parent experiment, or null. */
  parent_experiment_id: string | null;
  baseline: BaselineDecision | null;
  /** Item 8: what the run actually cost and took so far, to read next to `estimate`; null until a trial finishes. */
  actual: ActualSoFar | null;
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

/** SP4 (docs/proposals/grader-format.md, a draft for Rishi). */
export type GradeVerdict = 'pass' | 'fail' | 'not_applicable' | 'error' | 'not_implemented';
/** The data model's coarse family: exact (number, regex), state (tool calls, end state,
 *  provenance, required_tools), unit (unit_test), judge; invalid for a spec naming no known type. */
export type GradeKind = 'exact' | 'unit' | 'state' | 'judge' | 'invalid';
export type GradingOutcome = 'pass' | 'fail' | 'incomplete';
export type GradingJobStatus = 'queued' | 'claimed' | 'done' | 'failed' | 'superseded' | 'no_graders';

export interface Grade {
  id: number;
  grader_id: string;
  /** sha256 of the grader spec (and its file) plus the framework version. */
  grader_version: string;
  kind: GradeKind;
  /** The grader type: number, tool_called, regex_absent, unit_test, judge, ... */
  type: string | null;
  required: boolean;
  verdict: GradeVerdict | null;
  score: number | null;
  reason: string | null;
  /** [{source, quote?, span_id?, ...}]: each quote is verbatim from its source. */
  evidence: Json;
  judge_model: string | null;
  run_index: number;
  created_at: string;
}

/** One grading job of a trial, as GET /trials/:id shows it. */
export interface TrialGradingJob {
  job_id: string;
  status: GradingJobStatus;
  reason: 'trial_done' | 'regrade';
  grader_source: 'catalogue' | 'trial_task';
  source_note: string | null;
  task_sha256: Sha256;
  framework_version: string | null;
  /** True when every required grader passed, false when one failed, null when incomplete. */
  passed: boolean | null;
  outcome: GradingOutcome | null;
  error: string | null;
  queued_at: string;
  graded_at: string | null;
}

export interface TrialGrading {
  /** The job whose grades are shown: the latest finished one. Null until first graded. */
  current: TrialGradingJob | null;
  /** A newer job, queued or claimed (a regrade on its way), if any. */
  pending: TrialGradingJob | null;
}

/** POST /grader/claim, 200 (204 when nothing needs grading). */
export interface GraderClaimResponse {
  job_id: string;
  /** How many times this job has been claimed; a report must name it. */
  attempt: number;
  trial_id: string;
  lease_s: number;
  task: { id: string; sha256: Sha256; grader_source: 'catalogue' | 'trial_task'; note: string | null };
  graders: { spec: Json; spec_sha256: Sha256 }[];
  grader_files: Record<string, { sha256: Sha256; base64: string } | null>;
  /** Download each file with GET /trials/:id/files/<path> and check it against this manifest. */
  trial: { files: StoredFile[]; end_state: string | null; label: string | null };
}

/** POST /grader/trials/:id/grades */
export interface GradesReportResponse {
  job_id: string;
  trial_id: string;
  status: 'done';
  duplicate: boolean;
  passed: boolean | null;
  outcome: GradingOutcome;
  grades_stored: number;
  grades_reused: number;
}

/** POST /experiments/:id/regrade */
export interface RegradeResponse {
  experiment_id: string;
  /** Done trials considered. */
  trials: number;
  queued: number;
  /** Trials whose task has no graders: recorded, nothing to claim. */
  no_graders: number;
  /** Queued jobs replaced by these ones before anyone claimed them. */
  superseded: number;
  /** How many took their graders from the trial's own task, since the task changed beyond its graders. */
  from_trial_task: number;
}

/** GET /trials/:id for a trial made in an experiment, or a probe trial (D33: `experiment_id` null, `probe` true). */
export interface TrialView {
  id: string;
  experiment_id: string | null;
  /** A probe trial renders a config's prompt on the fake model; it is never counted in experiment results. */
  probe: boolean;
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
  /** The grades of the latest finished grading job (SP4); older versions stay in the database. */
  grades: Grade[];
  grading: TrialGrading;
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
  /** Null for a probe trial (D33), which belongs to no experiment. */
  experiment_id: string | null;
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

// ---- Pre-run checks and spend (D33, D38) -----------------------------------------------

/**
 * POST /configs/:hash/rendered-prompt starts a probe trial when there is no rendered prompt and
 * no live probe (or the last probe failed); GET only reads. `none` is GET's answer before any
 * probe; `queued` and `running` come with 202 from POST.
 */
export type RenderedPromptStatus = 'none' | 'queued' | 'running' | 'ready' | 'failed';

export interface RenderedPrompt {
  /** sha256 of `system_text`. */
  sha256: Sha256;
  /** The system message(s) of the first request, with the date line and the probe model normalised. */
  system_text: string;
  /** Tool names in the request's order. */
  tools: string[];
  /** Our task prompt's place in `system_text`: UTF-16 offsets (JavaScript string indices), end exclusive. Null if not found verbatim. */
  ours: { start: number; end: number } | null;
  /** `system_text` with our task prompt replaced by `<<OUR TASK PROMPT>>`. */
  harness_text: string;
  normalised: string[];
  /** Why the text may differ from what the real model will get. */
  caveats: string[];
  /** The probe trial it was read from (GET /trials/:id shows its trace). */
  trial_id: string;
  created_at: string;
}

export interface RenderedPromptView {
  config_hash: Sha256;
  status: RenderedPromptStatus;
  probe: { trial_id: string; status: TrialStatus; label: string | null; model: string } | null;
  /** True when the rendered prompt was already stored for this config, so nothing ran. */
  cached: boolean;
  /** Why the last probe gave no rendered prompt (status `failed`). */
  error: string | null;
  rendered: RenderedPrompt | null;
}

export type ConflictSeverity = 'high' | 'medium' | 'low';

export interface ConflictFinding {
  harness_says: string;
  we_say: string;
  why_it_matters: string;
  severity: ConflictSeverity;
}

export interface AllowanceView {
  kind: string;
  limit_usd: number;
  /** Settled costs plus the worst-case reservation of any call not settled yet. */
  used_usd: number;
  remaining_usd: number;
  calls: number;
  /** D38: past half, Claude tells Rishi. */
  half_reached: boolean;
}

/** POST /configs/:hash/conflict-check, and GET for the stored result without a call. */
export interface ConflictCheckView {
  config_hash: Sha256;
  rendered_sha256: Sha256;
  /** Hash of everything the checker is given: the rendered prompt, our prompt and the settings. */
  input_sha256: Sha256;
  checker: VersionRef;
  model: string;
  conflicts: ConflictFinding[];
  notes: string;
  /** What the check cost when it ran (null if LiteLLM never reported it); 0 when skipped. */
  cost_usd: number | null;
  /** True when this request returned a stored result and made no call. */
  cached: boolean;
  /** `no_harness_text`: the harness adds no system text of its own, so no call was made. */
  skipped: 'no_harness_text' | null;
  spend_id: string | null;
  checked_at: string;
  allowance: AllowanceView;
}

/** GET /spend: trial spend and the platform's own calls, separately (D38). */
export interface SpendView {
  /** Experiment trials, agent and simulator calls. Probe trials (fake model) are not counted. */
  trials_usd: number;
  /** Platform-made calls with a known cost. */
  system_usd: number;
  total_usd: number;
  system_by_kind: Record<string, { usd: number; calls: number }>;
  allowances: AllowanceView[];
}

/** GET /spend/system: one row per platform-made call, newest first. */
export interface SystemSpendRow {
  id: string;
  kind: string;
  model: string;
  status: 'pending' | 'done' | 'failed';
  reserved_usd: number;
  cost_usd: number | null;
  /** Where `cost_usd` came from; `no_call` means the key was never minted, so nothing was sent. Null while pending. */
  cost_source: 'spend_log' | 'response_header' | 'unknown' | 'no_call' | null;
  input_tokens: number | null;
  output_tokens: number | null;
  ref: string;
  error: string | null;
  created_at: string;
  settled_at: string | null;
}
