/**
 * The types every screen uses.
 *
 * - Request and response shapes are the API's own: ./contract.ts is a verbatim copy of
 *   apps/api/src/contract.ts (contract.spec.ts keeps the two identical), re-exported here.
 * - ./pending.ts adds, as an optional field, the one thing a screen reads that no contract has
 *   yet: a trial row's pass or fail, for the run grid.
 * - Below are the UI's readings of what the contract carries as loose JSON, each typed from the
 *   schema that defines it, and one shape the contract does not define yet (SP5's agreement),
 *   marked PROVISIONAL. SP6's statistics are the contract's own (CompareStats). Grades and
 *   checks.json are read in lib/grading.ts.
 */
import type { ArmView, CompareResponse, HarnessView, LabelCriterion, Sha256, StatsInterval } from './contract';
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
// GET /experiments/:id/compare: SP6's statistics are the contract's (CompareStats)

/** An estimate and its 95% interval: differences are B minus A, in points for pass rate. */
export type Interval = StatsInterval;

/** The compare response as the screens read it. */
export type Compare = CompareResponse;

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

// ---------------------------------------------------------------------------------------------
// D83: how far to trust an LLM judge, from humans' labels (GET /judge/trust)

/**
 * A judge's trust on one criterion, per judge model × rubric × criterion (D83):
 * - `uncalibrated`: no human label on any output this judge graded; its verdicts are a hint.
 * - `tuning_only`: labels only in the tuning set; agreement shown, never tested blind.
 * - `too_few`: held-out labels exist, but D8 cannot be applied yet (fewer than D77's 5 human "no"
 *   labels, or kappa or its interval undefined).
 * - `trusted` / `not_trusted`: D8 applied on the held-out labels.
 */
export type JudgeTrustStatus = 'uncalibrated' | 'tuning_only' | 'too_few' | 'trusted' | 'not_trusted';

/** A percentile bootstrap interval; both ends null when undefined (D77: over 5% of resamples undefined). */
export interface AgreementInterval {
  low: number | null;
  high: number | null;
  undefined_share: number | null;
}

/** Judge against humans on one criterion in one label set. Positive = "yes" (pass). */
export interface AgreementFigures {
  /** Pairs with a firm human yes/no (raters' majority; ties and "unsure" left out) and a judge yes/no. */
  n: number;
  /** judge yes & human yes */
  tp: number;
  /** judge yes & human no (a false pass) */
  fp: number;
  /** judge no & human yes (a false fail) */
  fn: number;
  /** judge no & human no */
  tn: number;
  agreement: number | null;
  kappa: number | null;
  kappa_interval: AgreementInterval;
  sensitivity: number | null;
  specificity: number | null;
  /** fp + tn: the human "no" labels used (D77 needs 5 for D8). */
  human_no: number;
  /** Labelled items left out: human unsure or a raters' tie. */
  human_left_out: number;
  /** Labelled items where the judge gave no yes or no (error, not judged). */
  judge_undecided: number;
  /** D8: arm B's false-pass rate minus arm A's, for the experiment with the most labelled pairs on both arms; null when no experiment has human "no" labels on both arms. */
  false_pass_gap: { experiment_id: string; estimate: number | null; interval: AgreementInterval; includes_zero: boolean | null } | null;
}

export interface JudgeCriterionTrust {
  criterion: string;
  /** The criterion's question, from the judge grader's spec (first seen); null if unknown. */
  text: string | null;
  status: JudgeTrustStatus;
  /** One plain sentence for screens: what the status means and what to do next. */
  summary: string;
  heldout: AgreementFigures | null;
  tuning: AgreementFigures | null;
  /** D8 on the held-out pairs (null when there are none): trusted, and why not. */
  d8: { trusted: boolean; reasons: string[] } | null;
  /** D8's test-retest: identical verdicts between the two latest gradings of the same trial by this judge; null when no trial was judged twice. */
  retest: { identical: number; total: number; share: number | null } | null;
  /** Held-out human "no" labels still needed before D8 can be applied (D77), else null. */
  needs_human_no: number | null;
  /** Where judge and humans disagree, held-out first; never more than 50. */
  disagreements: {
    trial_id: string;
    task_id: string;
    set: 'tuning' | 'heldout';
    human: 'yes' | 'no';
    judge: 'yes' | 'no';
    /** The judge's quote or reason for this criterion, if it gave one. */
    judge_reason: string | null;
    /** The human's note on this label, if any. */
    human_note: string | null;
  }[];
}

export interface JudgeTrust {
  judge_model: string;
  /** The rubric's path, e.g. `configs/rubrics/advice.v4.md`. */
  rubric: string;
  /** Experiments with at least one current judge grade from this judge, newest first. */
  experiments: string[];
  /** Trials with a current judge grade from this judge. */
  trials_judged: number;
  criteria: JudgeCriterionTrust[];
  /** Its `overall` criterion's status if it has one, else the least trusted criterion's. */
  status: JudgeTrustStatus;
  summary: string;
}

export interface JudgeTrustResponse {
  /** D8 and D77 as applied. */
  bar: { kappa: number; kappa_low: number; retest: number; min_human_no: number; max_undefined_share: number; resamples: number; human_unsure: 'exclude' };
  /** Every judge (model × rubric) with a current judge grade; filtered to an experiment's judges with `?experiment=`. Trust is always computed over all labels. */
  judges: JudgeTrust[];
}
