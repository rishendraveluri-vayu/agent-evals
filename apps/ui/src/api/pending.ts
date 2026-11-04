/**
 * Fields the run-controls and lineage API adds (D25 fixes, D32, D34, D35, D37), which is being
 * built on another branch and is not in `apps/api/src/contract.ts` on main yet. They are copied
 * from that branch's contract and added to the real types here as OPTIONAL fields, through
 * TypeScript module augmentation, so every screen reads them when the API sends them and works
 * without them today.
 *
 * When that contract lands: copy the new contract.ts over ./contract.ts (contract.spec.ts fails
 * until you do), then delete what it now declares from this file. A field declared in both with
 * different optionality is a type error, so nothing is left half-merged.
 */
import type { Sha256 } from './contract';

/** A valid but risky config: the API stores it and says what will happen and how to avoid it. */
export interface ConfigWarning {
  /** `langgraph_model_name_rewrite`: langchain-openai changes the request by the model's name. */
  code: string;
  message: string;
  fix: string;
}

/** D32's futility check, once per arm. */
export interface FutilityRule {
  enabled: boolean;
  after: number;
  min_passed: number;
}

/** D34: whether arm A reuses the parent's trials, and why; null when reuse was not asked for. */
export interface BaselineDecision {
  applied: boolean;
  reason: string;
  reused_trials: number;
}

/** Item 8: what the run actually cost and took so far. */
export interface ActualSoFar {
  finished_trials: number;
  spend_usd: number;
  cost_per_trial_usd: number | null;
  wall_s_per_trial: number | null;
  elapsed_minutes: number | null;
  projected_spend_usd: number;
}

export type ArmStatus = 'not_started' | 'active' | 'paused' | 'stopped' | 'complete';

/** One arm of an experiment (D35, D37). */
export interface ArmView {
  arm: string;
  config_hash: Sha256;
  config_name: string;
  status: ArmStatus;
  paused_at: string | null;
  paused_reason: string | null;
  /** How to fix what paused the arm (D37). */
  fix: string | null;
  counts: { queued: number; running: number; done: number; infra_failed: number; abandoned: number; cancelled: number };
  reused_from: string | null;
  reused_trials: number;
}

/** The event kinds the run-controls API adds to `ExperimentEventKind`. */
export type PendingEventKind =
  | 'arm_paused'
  | 'arm_resumed'
  | 'futility_pause'
  | 'infra_guard_pause'
  | 'spend_guard_pause'
  | 'baseline';

declare module './contract' {
  interface ApiErrorBody {
    /** What to change so the request succeeds (every refused setting has one). */
    fix?: string;
  }

  interface CreateConfigRequest {
    /** D34: the config this one was forked from. */
    parent_hash?: Sha256 | null;
  }

  interface ConfigView {
    /** Settings this harness or model ignores, each with the reason to show by the greyed field. */
    unsupported?: Partial<Record<SettingName, string>>;
    warnings?: ConfigWarning[];
    /** D34: the config this one was forked from, or null. */
    parent_hash?: Sha256 | null;
    /** GET /configs/:hash only: the configs forked from it, oldest first. */
    children?: { hash: Sha256; name: string; created_at: string }[];
  }

  interface CreateExperimentRequest {
    order_seed?: number | null;
    futility?: Partial<FutilityRule> | null;
    parent_experiment_id?: string | null;
    reuse_baseline?: boolean | null;
  }

  interface ExperimentEvent {
    /** The arm the event is about (`A` or `B`), or null for the whole experiment. */
    arm?: string | null;
    config_hash?: Sha256 | null;
  }

  interface ExperimentDetail {
    order_seed?: number | null;
    futility?: FutilityRule | null;
    parent_experiment_id?: string | null;
    baseline?: BaselineDecision | null;
    actual?: ActualSoFar | null;
    /** Arm A, then arm B. */
    arms?: ArmView[];
  }

  interface TrialRowSummary {
    /** D32: the trial's place in the claim order. */
    order_index?: number;
    /** `A` or `B`. */
    arm?: string;
    /**
     * NOT IN ANY CONTRACT: whether every grade passed, null when not graded. The run grid colours
     * a cell by it; until the API sends it, a done trial shows as "done, not graded".
     */
    passed?: boolean | null;
  }
}
