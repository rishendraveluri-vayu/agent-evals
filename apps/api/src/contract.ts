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
  /**
   * Whether the provider's key (ANTHROPIC_API_KEY, GEMINI_API_KEY) is set for LiteLLM, as compose
   * tells the API (`ANTHROPIC_KEY_SET`, `GEMINI_KEY_SET`: a flag, never the key). `null` when the
   * API was not told (run outside compose), for a provider it knows no key for, and for `fake/*`.
   */
  key_set: boolean | null;
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
  /**
   * True when the config came with a shipped example (SP7) and no experiment of this database's
   * own uses it. Its prompt or toolset may be older than the catalogue's, so pickers do not
   * default to it. Not part of the hash, and not diffed.
   */
  example_only: boolean;
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
  /**
   * D44: an A/A calibration run, the same config on both arms, to measure this setup's own noise;
   * it should come out "no detectable difference". `config_hashes` must then name one config
   * twice. Without it, the same config twice is refused. Otherwise an ordinary paid run.
   */
  calibration?: boolean | null;
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
  /** Seconds per trial, claim to report (the worker's whole slot, not only the agent's run). */
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
      /** The same with no history on a fake model (`fake/*`), which answers at once. */
      fake_wall_s_per_trial: number;
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
 * D32's futility check, once per arm: when an arm has `after` graded trials, it pauses the
 * experiment if fewer than `min_passed` of them passed. Graded means the trial's current grading
 * outcome (SP4) is `pass` or `fail`; a trial whose grading is `incomplete` or not done yet is not
 * counted. The check runs after each trial report and each grades report.
 */
export interface FutilityRule {
  enabled: boolean;
  after: number;
  min_passed: number;
}

/** POST /experiments */
/** The longest name an experiment may have, in characters (after trimming); a longer one is 400 `invalid_experiment`. */
export const EXPERIMENT_NAME_MAX = 200;

export interface CreateExperimentRequest {
  /** 1 to EXPERIMENT_NAME_MAX characters. */
  name: string;
  axis: string;
  config_hashes: Sha256[];
  task_sha256s: Sha256[];
  n: number;
  sim_model?: string | null;
  budget_usd: number;
  /**
   * The git commit of the analysis plan (docs/experiment.md): 7 to 40 hex characters, stored in
   * lower case. Only the format is checked: the API cannot see git history, so it does not check
   * that the commit exists or holds the plan. Blank or null: none.
   */
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
  /** D44: an A/A calibration run, the same config on both arms (as in EstimateRequest). */
  calibration?: boolean | null;
}

/**
 * POST /experiments/:id/start, optional body. `plan_commit` sets the analysis plan's commit on an
 * experiment that has not started yet (an unstarted one left without it can still be started from
 * its run page); once it has started the plan commit is fixed (409 `plan_commit_locked`).
 */
export interface StartExperimentRequest {
  /** As in CreateExperimentRequest: 7 to 40 hex characters, the format checked only. */
  plan_commit?: string | null;
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
  /** D44: an A/A calibration run (one config on both arms), to measure the setup's own noise. */
  calibration: boolean;
  /**
   * Set when this experiment is a shipped example loaded by POST /examples/:name/load (SP7), so
   * the UI can label it as sample content; null for your own experiments. An example is
   * read-only: nothing runs, re-grades or judges it, and its trials are not counted in spend,
   * estimates or the label queue.
   */
  example: ExampleRef | null;
}

/** Which shipped example an experiment was loaded from (`examples/<name>/manifest.json`). */
export interface ExampleRef {
  name: string;
  /** The manifest's one-line title, to show in place of (or beside) the experiment's name. */
  title: string;
  loaded_at: string;
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
  | 'baseline'
  // POST /experiments/:id/discard: an experiment that never started, marked cancelled.
  | 'discarded';

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
  /** The active LLM judge approval (POST /experiments/:id/judge), or null: no judging approved. */
  judge: JudgeView | null;
}

/** POST /experiments/:id/judge: Rishi's sign-off for real-model judging of one experiment, with a cap (R8). */
export interface JudgeApprovalRequest {
  /** A model LiteLLM serves with a price (GET /models; `fake/*` counts). */
  model: string;
  /** Above 0 and at most 20: the minted key's LiteLLM budget, so judging can never spend more. */
  budget_usd: number;
}

/** POST /experiments/:id/judge, 201. The key itself is never returned to the UI. */
export interface JudgeApprovalResponse {
  experiment_id: string;
  model: string;
  budget_usd: number;
  approved_at: string;
}

/** DELETE /experiments/:id/judge, 200: the key is deleted in LiteLLM, so it stops working at once. */
export interface JudgeRevokeResponse {
  experiment_id: string;
  revoked_at: string;
}

/** The active approval in GET /experiments/:id. Never the key. */
export interface JudgeView {
  model: string;
  budget_usd: number;
  /** What the judge's key has spent, from LiteLLM's spend log; null when LiteLLM could not be read. */
  spend_usd: number | null;
  approved_at: string;
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
  /** The trial's current grading (SP4): true when every required grader passed, false when one failed, else null. */
  passed: boolean | null;
  /** Where grading stands for the run grid and D32's futility check (see TrialGradingState). */
  grading: TrialGradingState;
}

/**
 * A trial row's grading, from its grading jobs (SP4):
 * - `pass`, `fail`, `incomplete`: the outcome of its latest finished grading job (incomplete: a
 *   required grader gave no verdict);
 * - `waiting`: done, and its grading is queued or running, or not queued yet;
 * - `no_graders`: done, and its task has no graders;
 * - `grading_failed`: done, and its last grading job gave up (its lease lapsed 3 times) with no
 *   finished job before it; a regrade queues it again;
 * - `null`: not done (queued, running, an infra failure, cancelled), so there is nothing to grade.
 */
export type TrialGradingState = GradingOutcome | 'waiting' | 'no_graders' | 'grading_failed' | null;

/** GET /experiments/:id/compare */
export interface CompareRow {
  task: Sha256;
  task_id: string;
  /** `A` or `B`. */
  arm: string;
  config: Sha256;
  config_name: string;
  /** Done trials whose outcome is pass: every required grader of the latest grading passed. */
  passed: number;
  /** Done trials with an outcome, pass or fail, from their latest finished grading. */
  graded: number;
  /** Done trials whose latest grading finished without an outcome: a required grader errored, was
   *  not applicable or did not run (the judge, unapproved). Counted apart, never as a pass or fail. */
  incomplete: number;
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
  /** SP6: the verdict and its intervals, once every arm is complete and graded; null otherwise. */
  stats: CompareStats | null;
  /** Why `stats` is null, in plain words (grading still running, one arm, no task decided in both arms); null when it is set. */
  stats_note: string | null;
}

// ---- Statistics (SP6: D10, D41, D42, D43, D44) ---------------------------------------
// docs/design.md, "Statistics", says what each number is and why. Rates are proportions (0 to 1);
// pass-rate differences are percentage points; cost, tokens and seconds are in their own units.

/** An estimate and its 95% interval. */
export interface StatsInterval {
  estimate: number;
  low: number;
  high: number;
}

/**
 * The verdict on B against A (D42, D10). `better`: interval above 0 and p < 0.05. `worse`:
 * interval below 0 and p < 0.05. `equivalent`: the whole interval inside +/- the margin (10
 * points). `no_detectable_difference`: anything else. `held_back`: the pass rate alone says
 * better, but critical failures rose beyond noise, so B is not called better (the guardrail).
 */
export type CompareVerdict = 'better' | 'worse' | 'equivalent' | 'no_detectable_difference' | 'held_back';
export type PassRateVerdict = Exclude<CompareVerdict, 'held_back'>;

/** One arm's trials of a task, or of the tasks in the aggregate. */
export interface StatsArmCounts {
  passed: number;
  /** Decided trials: pass or fail. */
  graded: number;
  /** Done trials with no outcome (a required check gave no verdict): left out, never a pass or fail. */
  incomplete: number;
}

/** A task in the aggregate (both arms have a decided trial). */
export interface StatsTask {
  task: Sha256;
  task_id: string;
  a: StatsArmCounts;
  b: StatsArmCounts;
  /** B minus A in points, with Newcombe's 95% interval for two independent proportions (not corrected). */
  diff: StatsInterval;
  /** Fisher's exact test, two-sided. */
  p_value: number;
  /** The Benjamini-Hochberg adjusted p-value over the tasks in the aggregate. */
  q_value: number;
  /** D41: beyond noise after Benjamini-Hochberg at q = 0.05. A pointer to look at, not a verdict. */
  beyond_noise: boolean;
}

/** A task left out of the aggregate: an arm has no decided trial. */
export interface StatsExcludedTask {
  task: Sha256;
  task_id: string;
  a: StatsArmCounts;
  b: StatsArmCounts;
  why: string;
}

/** D10: B is never called better while its critical failures rose beyond noise. */
export interface CriticalGuardrail {
  /**
   * `no_critical_checks`: no required check in these tasks is marked critical, so nothing is
   * claimed about safety. `no_decided_trials`: there are such checks, but no task with one has a
   * decided trial in both arms. `rose`: B's critical-failure rate is higher and its interval lies
   * above 0. `did_not_rise`: otherwise.
   */
  status: 'no_critical_checks' | 'no_decided_trials' | 'rose' | 'did_not_rise';
  /** The required critical checks, as `task_id/grader_id`. */
  checks: string[];
  /** Tasks in its aggregate: those with a critical check and a decided trial in both arms. */
  tasks: number;
  /** Per arm: the mean over those tasks of the share of decided trials where a critical check failed. */
  a: { rate: number; failed: number; graded: number } | null;
  b: { rate: number; failed: number; graded: number } | null;
  /** B minus A in points, the same task bootstrap as the pass rate. */
  diff: StatsInterval | null;
  /** True when the pass rate alone says better and this blocks it (verdict `held_back`). */
  blocks_better: boolean;
  text: string;
}

export interface RegressionGrader {
  grader_id: string;
  required: boolean;
  severity: GraderSeverity | null;
  /** This check's own pass or fail verdicts on the task's done trials, per arm. */
  a: { passed: number; graded: number };
  b: { passed: number; graded: number };
}

export interface RegressionTrial {
  trial_id: string;
  arm: 'A' | 'B';
  /** The required checks that failed on it. */
  failed_graders: string[];
  /** Reserved for the failure-cause step (the brief's stretch item 7: wrong tool, made-up tool arguments, gave up early, ran out of steps, grader disagrees with the human label). Not filled yet. */
  cause?: string | null;
}

/** D10: a task where B dropped (its difference is below 0) or a check's pass rate fell from A to B. */
export interface Regression {
  task: Sha256;
  task_id: string;
  a: StatsArmCounts;
  b: StatsArmCounts;
  /** As StatsTask; null when the task is not in the aggregate (an arm has no decided trial). */
  diff: StatsInterval | null;
  beyond_noise: boolean;
  /** A check marked critical got worse. Critical ones come first. */
  critical: boolean;
  /** The checks whose pass rate fell, critical first. */
  graders: RegressionGrader[];
  /** The task's failed trials, arm B first. */
  failed_trials: RegressionTrial[];
}

/** Cost, tokens and time next to quality: the same task bootstrap, with no verdict. */
export interface CostStat {
  /** cost_usd: LiteLLM's recorded cost of the agent's calls. tokens: input plus output. wall_s: the trial's run time. */
  metric: 'cost_usd' | 'tokens' | 'wall_s';
  /** Tasks with a value in both arms. */
  tasks: number;
  /** Mean over those tasks of each arm's mean per trial. */
  a: number;
  b: number;
  /** B minus A, in the metric's unit. */
  diff: StatsInterval;
  /** (B - A) / A in percent; null when A's mean is 0. */
  relative: StatsInterval | null;
  /** Trials with a value, per arm. */
  trials: { a: number; b: number };
  /** wall_s: trials left out because LiteLLM retried one of their model calls, whose backoff waits would inflate the time. */
  left_out_retried?: { a: number; b: number };
  /** wall_s: trials kept whose record does not say whether a call was retried (recorded before 4 Nov, or no LiteLLM record). */
  retries_unknown?: { a: number; b: number };
  /** cost_usd: an arm ran on a fake model, whose prices are made up for testing. */
  made_up_prices?: boolean;
}

/** D44: the latest finished A/A calibration run of either arm's config. */
export interface AaCalibration {
  experiment_id: string;
  name: string;
  config_hash: Sha256;
  finished_at: string | null;
  /** B minus A in points: what the setup's own noise looks like. */
  diff: StatsInterval;
  verdict: CompareVerdict;
}

export interface CompareStats {
  /** Bumped when a change to the method can move a number. */
  method_version: string;
  measure: 'pass_rate';
  /** 0.95 (D43). */
  level: number;
  /** 0.05 (D43). */
  alpha: number;
  /** D42: the equivalence margin, in points. */
  margin_points: number;
  method: 'paired_task_bootstrap';
  /** Bootstrap resamples (10,000). */
  resamples: number;
  /** What seeds the random streams: the experiment id, so the same data always gives the same numbers. */
  seed: string;
  /** Over the tasks in the aggregate: `rate` is the mean of the per-task pass rates (equal weight per task); the counts are pooled. */
  a: StatsArmCounts & { rate: number };
  b: StatsArmCounts & { rate: number };
  /** Mean over tasks of B minus A, in points, with the task bootstrap's 95% interval (D10). */
  diff: StatsInterval;
  /** The paired sign-flip permutation test on the per-task differences, two-sided. */
  p_value: number;
  test: { name: 'sign_flip'; exact: boolean; flips: number };
  verdict: CompareVerdict;
  /** The verdict from the pass rate alone, before the critical guardrail. */
  pass_rate_verdict: PassRateVerdict;
  /** The verdict in one or two plain sentences. */
  verdict_text: string;
  /** For no_detectable_difference: the largest difference, in points, the interval does not rule out. */
  not_ruled_out_points: number | null;
  /** The tasks in the aggregate, in the experiment's order. */
  tasks: StatsTask[];
  excluded_tasks: StatsExcludedTask[];
  correction: 'benjamini_hochberg';
  critical: CriticalGuardrail;
  regressions: Regression[];
  costs: CostStat[];
  /** D44, on an ordinary A/B: the latest A/A calibration of either config; null when there is none. */
  aa: AaCalibration | null;
  /** D44, on a calibration run itself: whether it came out as it should (no difference found). */
  calibration: { as_expected: boolean; text: string } | null;
  /** SP5's judge agreement on held-out labels, for the caveat when the verdict rests on the judge; null until SP5 reports it. */
  judge: { kappa: number; low: number; high: number; bar: number; tasks: number } | null;
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
/** D10: a grader spec's optional `severity`, set by the task's author. It never changes a verdict;
 *  the comparison reads it (the critical-failure guardrail, the regression list's order). */
export const GRADER_SEVERITIES = ['critical', 'major', 'minor'] as const;
export type GraderSeverity = (typeof GRADER_SEVERITIES)[number];
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
  /** `summary`: the trial's task summary, the one the blind labelling screen shows; null if unknown. */
  task: { id: string; sha256: Sha256; grader_source: 'catalogue' | 'trial_task'; note: string | null; summary: string | null };
  graders: { spec: Json; spec_sha256: Sha256 }[];
  /**
   * Each grader's files, keyed as in its spec hash: a unit_test's file by its name next to
   * task.json (`grader.py`), a judge's rubric by its repo path (`configs/rubrics/<id>.<version>.md`).
   * Null when the file is missing or unknown.
   */
  grader_files: Record<string, { sha256: Sha256; base64: string } | null>;
  /** Download each file with GET /trials/:id/files/<path> and check it against this manifest. */
  trial: { files: StoredFile[]; end_state: string | null; label: string | null };
  /** LiteLLM access for the judge when the trial's experiment has an active approval, else null. Read at claim time. */
  judge: JudgeAccess | null;
}

/** The judge's access in a grading claim: one experiment's key, limited to one model and capped at its budget. */
export interface JudgeAccess {
  /** LiteLLM's OpenAI-compatible base URL as workers reach it, the same as a trial spec's `model.base_url` (ends in /v1). */
  base_url: string;
  api_key: string;
  model: string;
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

// ---- experiment bundles and shipped examples (SP7) ----

/** The tables an experiment bundle carries, in the order they are inserted. */
export const BUNDLE_TABLES = [
  'prompts',
  'toolsets',
  'tasks',
  'configs',
  'experiments',
  'experiment_arms',
  'experiment_events',
  'trials',
  'spans',
  'grading_jobs',
  'grades',
] as const;
export type BundleTable = (typeof BUNDLE_TABLES)[number];

/**
 * GET /experiments/:id/bundle: every row needed to recreate one experiment elsewhere, read-only
 * (scripts/export_example.py writes it to examples/<name>/). Rows are the tables' own columns as
 * Postgres's to_jsonb writes them (`tasks.client_state` is hex: a backslash, `x`, hex digits),
 * except: `spans` rows are `{trial_id, raw}`, since the other columns are read from `raw`;
 * `experiment_events` rows have no `id`; and a trial's LiteLLM key tokens and the experiment's
 * LiteLLM team are left out. `configs` holds the experiment's configs and the configs they were
 * forked from. The trials' files are fetched one by one with GET /trials/:id/files/<path>, as
 * listed in `trials[].files`.
 */
export interface ExperimentBundle {
  format: 'agent-evals-bundle';
  format_version: 1;
  /** The latest migration this database has applied, e.g. `011_examples`. */
  schema_version: string;
  exported_at: string;
  experiment_id: string;
  tables: Record<BundleTable, JsonObject[]>;
}

/** What a shipped example holds, from its manifest. */
export interface ExampleCounts {
  configs: number;
  tasks: number;
  trials: number;
  spans: number;
  grades: number;
  files: number;
}

/** GET /examples: one entry per `examples/<name>/manifest.json` the API can read. */
export interface ExampleView {
  /** The folder name: lower-case letters, digits and hyphens. */
  name: string;
  title: string;
  description: string;
  experiment_id: string;
  /** True once this database holds the example (POST /examples/:name/load). */
  loaded: boolean;
  /** When the experiment was created, on the machine it was exported from. */
  created_at: string;
  counts: ExampleCounts;
}

/** POST /examples/:name/load, 200. `created: false`: it was already loaded and nothing changed. */
export interface LoadExampleResponse {
  name: string;
  experiment_id: string;
  created: boolean;
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
  /**
   * D46: true when these criteria were all marked "unsure" before and come back once for a firm
   * answer. Second-look items follow every fresh item in the queue.
   */
  second_look: boolean;
}

/** POST /labels */
export interface CreateLabelRequest {
  item_id: string;
  set: LabelSet;
  criterion: string;
  value: LabelValue;
  note?: string | null;
  /** D46: the answer on a second look at a criterion labelled "unsure" in this set before. */
  second_look?: boolean;
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
  /** D46: present and true only on a second-look answer. */
  second_look?: boolean;
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

/** POST /configs/:hash/conflict-check, and GET for the stored result without a call (GET answers `null` when none is stored). */
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

/** GET /spend: trial spend, the platform's own calls and the LLM judge, separately (D38). */
export interface SpendView {
  /**
   * Experiment trials' real spend: agent calls on a real model, and simulator calls on a real
   * model. Calls to fake models (`fake/*`), probe trials and shipped examples are not counted.
   */
  trials_usd: number;
  /**
   * The made-up prices LiteLLM counted for experiment trials' calls to fake models (`fake/*`).
   * Not money: kept apart, and not in `total_usd`.
   */
  fake_trials_usd: number;
  /** Platform-made calls with a known cost. */
  system_usd: number;
  /** The LLM judge's calls across every approval, revoked ones included, from LiteLLM's spend log; null when it could not be read. */
  judge_usd: number | null;
  /** Judge approvals ever made, revoked ones included. */
  judge_approvals: number;
  /** Real trial spend, system and judge spend (the judge only when known); never fake prices. */
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
