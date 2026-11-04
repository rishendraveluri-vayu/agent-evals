/** A run's pauses and events in words (D26, D32, D37): what stopped it, which arm, and what to do. */
import type { ExperimentEvent, ExperimentEventKind } from '../api/types';
import { plainText } from './format';

/** The kinds that pause the whole experiment. */
export const EXPERIMENT_PAUSES: ExperimentEventKind[] = ['paused', 'futility_pause', 'infra_guard_pause', 'spend_guard_pause'];

/** "futility check (D32): arm B passed 0 of its first 3 graded trials, fewer than ..." becomes
 *  "the futility check: arm B passed 0 of its first 3 graded trials": what paused it, in a
 *  phrase short enough for a list. The full reason is always shown where there is room. */
export function pauseCause(reason: string): string {
  const r = reason.trim();
  const rule = r.match(/^(futility check|infra guard|spend guard) \(D32\):\s*([^,.;(]+)/);
  if (rule) return `the ${rule[1]}: ${rule[2].trim()}`;
  const config = r.match(/infra:config_error \(LiteLLM status (\w+)\)/);
  if (config) return `a config error (LiteLLM status ${config[1]})`;
  if (/^paused by hand/.test(r)) return 'paused by hand';
  const head = r.split(/[.;:](\s|$)/)[0];
  return head.length > 120 ? `${head.slice(0, 117)}...` : head;
}

export type EventTone = 'pause' | 'resume' | 'infra' | 'plain';

export interface EventView {
  at: string;
  /** "Paused by the futility check", "Arm B paused" */
  title: string;
  /** The API's own words. */
  detail: string;
  tone: EventTone;
  /** `A`, `B`, or null for the whole experiment. */
  arm: string | null;
  trialId: string | null;
}

const TITLES: Record<string, string> = {
  created: 'Created',
  started: 'Started',
  cancelled: 'Stopped',
  finished: 'Finished',
  claim: 'Trial claimed',
  infra_failure: 'Infra failure',
  requeue: 'Re-queued',
  abandoned: 'Abandoned: no heartbeat',
  budget_trip: 'Budget safety net tripped',
  config_error: 'Config error',
  paused: 'Paused',
  resumed: 'Resumed',
  file_problem: 'File problem',
  arm_paused: 'Arm paused',
  arm_resumed: 'Arm resumed',
  futility_pause: 'Paused by the futility check',
  infra_guard_pause: 'Paused by the infra guard',
  spend_guard_pause: 'Paused by the spend guard',
  baseline: 'Baseline decision',
};

export function eventView(e: ExperimentEvent): EventView {
  const kind = e.kind as string;
  let title = TITLES[kind] ?? kind.replace(/_/g, ' ');
  if (e.arm && (kind === 'arm_paused' || kind === 'arm_resumed')) title = `Arm ${e.arm} ${kind === 'arm_paused' ? 'paused' : 'resumed'}`;
  else if (kind === 'paused' && /^paused by hand/.test(e.detail)) title = 'Paused by hand';
  const tone: EventTone = (EXPERIMENT_PAUSES as string[]).includes(kind) || kind === 'arm_paused' || kind === 'budget_trip'
    ? 'pause'
    : kind === 'resumed' || kind === 'arm_resumed' || kind === 'started'
      ? 'resume'
      : kind === 'infra_failure' || kind === 'config_error' || kind === 'abandoned' || kind === 'file_problem'
        ? 'infra'
        : 'plain';
  // The API's detail names its decision-log entries; the screen leaves them out.
  return { at: e.at, title, detail: plainText(e.detail), tone, arm: e.arm ?? null, trialId: e.trial_id };
}
