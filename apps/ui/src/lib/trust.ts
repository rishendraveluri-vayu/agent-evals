/**
 * How far to trust an LLM judge (D83, GET /judge/trust), as the screens say it.
 *
 * A judge is a judge model × rubric. Its trust is worked out per criterion from the human labels on
 * outputs it graded: `uncalibrated` (no label on anything it graded), `tuning_only` (tuning labels
 * only, never tested blind), `too_few` (held-out labels, but not enough human "no" labels for the
 * bar), then `trusted` or `not_trusted` by the trust bar on the held-out labels.
 */
import type { AgreementInterval, JudgeTrust, JudgeTrustStatus, Json, LabelSet } from '../api/types';
import { minus } from './format';

/** The status in two or three words, sentence case: the badge's text. */
export const TRUST_LABELS: Record<JudgeTrustStatus, string> = {
  uncalibrated: 'Uncalibrated',
  tuning_only: 'Tuning only',
  too_few: 'Too few labels',
  trusted: 'Trusted',
  not_trusted: 'Not trusted',
};

export function trustLabel(status: JudgeTrustStatus): string {
  return TRUST_LABELS[status] ?? status;
}

/**
 * The label set to calibrate an experiment's judge in: held-out when any of its tasks is a
 * held-out task (only held-out labels test a judge), else tuning. The API's queue takes trials of
 * held-out tasks for the held-out set and of discovery tasks for tuning.
 */
export function labelSetFor(tasks: readonly { split: string }[]): LabelSet {
  return tasks.some((t) => t.split === 'held_out') ? 'heldout' : 'tuning';
}

const isObj = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A judge grader spec's rubric as the API names it: `configs/rubrics/<id>.<version>.md` for
 *  `{id, version}`, a path as given (the grader's own `rubric_path`). */
export function rubricOf(spec: Json): string | null {
  if (!isObj(spec)) return null;
  const r = spec.rubric;
  if (typeof r === 'string' && r) return r;
  if (isObj(r) && typeof r.id === 'string' && typeof r.version === 'string') return `configs/rubrics/${r.id}.${r.version}.md`;
  return null;
}

/**
 * The judge behind a grade: the one with its model and, when known, its rubric. With the model
 * unknown too (a check not judged, on an experiment with no judge approved), any of the
 * experiment's judges with that rubric. Null unless exactly one judge fits, so a badge never
 * belongs to the wrong judge.
 */
export function judgeFor(judges: readonly JudgeTrust[], model: string | null, rubric: string | null): JudgeTrust | null {
  const fit = judges.filter((j) => (model === null || j.judge_model === model) && (rubric === null || j.rubric === rubric));
  return fit.length === 1 ? fit[0] : null;
}

/** The API's sentences write a negative number with a hyphen ("its interval reaches -0.21"); the
 *  screens use a minus sign, as kappaWords does. A hyphen inside a word ("held-out") stays. */
export function minusSigns(text: string): string {
  return text.replace(/(^|[\s(])-(?=\d)/g, '$1\u2212');
}

/** "0.52", "−0.12", or "not defined". */
export function kappaWords(k: number | null): string {
  // A value that rounds to zero reads "0.00", never "−0.00".
  return k === null ? 'not defined' : minus((Math.abs(k) < 0.005 ? 0 : k).toFixed(2));
}

/** "0.31 to 0.71", or null when the interval is undefined. */
export function intervalWords(i: AgreementInterval | null | undefined): string | null {
  if (!i || i.low === null || i.high === null) return null;
  return `${kappaWords(i.low)} to ${kappaWords(i.high)}`;
}

/** The rubric's file name without its folder and extension: `configs/rubrics/advice.v4.md` → `advice.v4`. */
export function rubricName(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.md$/, '');
}
