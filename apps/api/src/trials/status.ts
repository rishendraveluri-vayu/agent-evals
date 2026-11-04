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
 * Whether a failed attempt (infra label, or a lapsed lease) gets a next attempt: only while
 * the experiment is running and the slot is still under the cap.
 */
export function shouldRequeue(attempt: number, experiment: ExperimentStatus): boolean {
  return experiment === 'running' && attempt < MAX_ATTEMPTS;
}
