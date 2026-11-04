import type { ExperimentStatus, TrialStatus } from '../contract';

/**
 * The trial status machine (R14). Only the API changes status. Each row is one attempt;
 * a re-run is a new row with the next attempt number, so a finished row never changes again.
 *
 *   queued -> claimed -> running -> done | infra_failed | abandoned
 *   claimed -> done | infra_failed | abandoned   (a report or lapse before the first heartbeat)
 *   queued -> cancelled                          (the experiment was cancelled)
 */
const NEXT: Record<TrialStatus, readonly TrialStatus[]> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['running', 'done', 'infra_failed', 'abandoned'],
  running: ['done', 'infra_failed', 'abandoned'],
  done: [],
  infra_failed: [],
  abandoned: [],
  cancelled: [],
};

/** D16: a slot is re-queued once, never twice, so it has at most two attempts. */
export const MAX_ATTEMPTS = 2;

/** No heartbeat for this long and the claim lapses (R14). */
export const LEASE_S = 60;
/** How often the API looks for lapsed leases. */
export const SWEEP_INTERVAL_MS = 10_000;

/** Statuses a worker may still heartbeat or report from. */
export const HELD: readonly TrialStatus[] = ['claimed', 'running'];
/** Statuses that mean the attempt is over. */
export const FINISHED: readonly TrialStatus[] = ['done', 'infra_failed', 'abandoned', 'cancelled'];

export function canTransition(from: TrialStatus, to: TrialStatus): boolean {
  return NEXT[from].includes(to);
}

const LABEL = /^(agent|infra:[a-z][a-z0-9_]*)$/;

export function isLabel(label: unknown): label is string {
  return typeof label === 'string' && LABEL.test(label);
}

/** `agent` is a quality outcome (done); any `infra:*` label is not (infra_failed). */
export function statusForLabel(label: string): 'done' | 'infra_failed' {
  if (!isLabel(label)) throw new Error(`unknown runner label ${String(label)}`);
  return label === 'agent' ? 'done' : 'infra_failed';
}

/**
 * Labels whose attempt is never re-queued (D26): a config error would fail the same way again,
 * and a budget stop is a safety net to investigate, not a fault to retry (R10.6).
 */
export const NEVER_REQUEUED: readonly string[] = ['infra:config_error', 'infra:budget_net'];

/** D26: the label that pauses the experiment, so nothing more is claimed until it is fixed. */
export const PAUSES_EXPERIMENT = 'infra:config_error';

/**
 * Whether a failed attempt (an infra label, or a lapsed lease with `label` null) gets a next
 * attempt: only while the experiment is running or paused (a paused experiment's new attempt
 * waits, queued, until it resumes), the slot is still under the cap, and the label is one that
 * is re-queued (D16, D26).
 */
export function shouldRequeue(attempt: number, experiment: ExperimentStatus, label: string | null = null): boolean {
  if (label !== null && NEVER_REQUEUED.includes(label)) return false;
  return (experiment === 'running' || experiment === 'paused') && attempt < MAX_ATTEMPTS;
}
