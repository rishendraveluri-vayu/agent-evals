/**
 * The types every screen uses.
 *
 * - Request and response shapes are the API's own: ./contract.ts is a verbatim copy of
 *   apps/api/src/contract.ts (contract.spec.ts keeps the two identical), re-exported here.
 * - ./pending.ts adds, as an optional field, the one thing a screen reads that no contract has
 *   yet: a trial row's pass or fail, for the run grid.
 * - Below are the UI's readings of what the contract carries as loose JSON, each typed from the
 *   schema that defines it, and two shapes the contract does not define yet (SP5's agreement and
 *   SP6's stats), each marked PROVISIONAL. Grades and checks.json are read in lib/grading.ts.
 */
import type { ArmView, CompareResponse, HarnessView, LabelCriterion, Sha256 } from './contract';
import './pending';

export * from './contract';

/** An arm's status, as `ArmView.status`. */
export type ArmStatus = ArmView['status'];

// ---------------------------------------------------------------------------------------------
// capabilities.json (contract/v2/capabilities.schema.json), which GET /harnesses carries as JSON

export type EffectStatus = 'effective' | 'inert' | 'not_checked';

/** One setting in capabilities.json (`$defs.setting`). */
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
  settings: Record<string, CapabilitySetting>;
  harness_options_schema: { properties?: Record<string, { type?: string; description?: string }> } & Record<string, unknown>;
  known_differences: string[];
}

/** `GET /harnesses`, with `capabilities` read as the schema defines it. */
export type Harness = Omit<HarnessView, 'capabilities'> & { capabilities: Capabilities };

// ---------------------------------------------------------------------------------------------
// result.json (contract/v2/result.schema.json): the parts the screens read

export interface AppliedSetting {
  value: unknown;
  source: string;
  observed?: string;
}

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
  harness?: { name?: string; version?: string; extra?: Record<string, unknown> };
  applied_settings?: Record<string, AppliedSetting>;
  counts?: { model_calls?: number; tool_calls?: number; tool_errors?: number; malformed_tool_calls?: number };
  timing?: { started_at?: string; ended_at?: string; wall_s?: number };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// GET /experiments/:id/compare: `stats` is SP6's and `null` in the contract until then

export interface Interval {
  estimate: number;
  low: number;
  high: number;
}

/** PROVISIONAL: SP6 owns this shape; the contract types `stats` as null until it exists. It is
 *  what the comparison screen reads. Differences are B minus A, in percentage points for pass rate. */
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

/** The compare response as the screen reads it: the contract's, with SP6's stats once they exist. */
export type Compare = Omit<CompareResponse, 'stats'> & { stats: CompareStats | null };

// ---------------------------------------------------------------------------------------------
// GET /judge/agreement: SP5, which returns null until then

/** PROVISIONAL: SP5 owns this shape. */
export interface JudgeAgreement {
  set: 'tuning' | 'heldout' | 'final';
  labels: number;
  agree: number;
  kappa: Interval;
  bar: number;
  /** Rows are the judge's verdict, columns yours. */
  matrix: { judge_pass_you_pass: number; judge_pass_you_fail: number; judge_fail_you_pass: number; judge_fail_you_fail: number };
  per_config: { config: Sha256; labels: number; kappa: number }[];
  retest: { identical: number; total: number; runs: number; note: string | null } | null;
  self: { same: number; total: number } | null;
  disagreements: { trial_id: string | null; task: string; criterion: string; you: 'yes' | 'no' | 'unsure'; judge: 'pass' | 'fail'; evidence: string }[];
}

// ---------------------------------------------------------------------------------------------
// The blind labelling item as the screen shows it

/** `GET /labels/queue` item after `toBlindItem`: only the fields a blind item may carry. */
export interface BlindItem {
  item_id: string;
  /** NOT IN CONTRACT: the task id names the task, not the arm, so it keeps the item blind. */
  task_id?: string;
  task_summary: string;
  transcript: { role: string; content: string }[];
  tool_calls: { name: string; arguments: unknown; result: unknown; is_error?: boolean | null }[];
  criteria: LabelCriterion[];
  /** D46: these criteria were marked "not sure" before and come back once for a firm answer. */
  second_look: boolean;
}
