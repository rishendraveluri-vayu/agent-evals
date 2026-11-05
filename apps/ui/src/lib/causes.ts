import { CAUSE_KINDS, type CauseKind, type TrialCause } from '../api/types';

/**
 * D64's failure causes in the words the screens use. The API decides each cause by rule
 * (apps/api/src/causes/causes.ts); these are only its names and a one-sentence rule each, which
 * the comparison's "How causes are decided" lists.
 */

export const CAUSE_NAME: Record<CauseKind, string> = {
  ran_out_of_steps: 'Ran out of steps',
  judge_vs_label: 'Judge disagrees with your label',
  wrong_tool: 'Wrong tool',
  gave_up_early: 'Gave up early',
  made_up_arguments: 'Made-up tool arguments',
  tool_error: 'Tool error, not recovered',
  unsupported_figure: 'Figure with no source',
  wrong_answer: 'Wrong answer',
  other: 'Other',
};

export const CAUSE_RULE: Record<CauseKind, string> = {
  ran_out_of_steps: 'It stopped at the step limit, the output cap or the time limit.',
  judge_vs_label: 'On a check you labelled, the judge’s verdict differs from your label.',
  wrong_tool: 'A tool the task needs was never called and another tool was, or a tool a check forbids was called.',
  gave_up_early: 'It answered without calling a tool the task needs, and called nothing in its place.',
  made_up_arguments: 'It called the tool the task needs, but with arguments no source supports.',
  tool_error: 'A tool returned an error and was not called successfully after it.',
  unsupported_figure: 'A money figure in the reply has no tool result, client-file number or message behind it.',
  wrong_answer: 'A check on the answer (a number, a pattern or a test) failed though the right tools were called.',
  other: 'The agent or the harness ended in an error (tried second, right after running out of steps), or no rule above fits.',
};

/** The causes in the order the rules are tried. */
export const CAUSE_ORDER: readonly CauseKind[] = CAUSE_KINDS;

export interface CauseLine {
  kind: CauseKind;
  name: string;
  reason: string;
}

export interface CauseView extends CauseLine {
  contributing: CauseLine[];
  /** The primary cause is the judge against your label, and labelling is still blind. */
  hidden: boolean;
}

/** Ends a reason as a sentence: with a full stop, unless it already ends on one. */
export const sentence = (text: string): string => (/[.!?…]["”)]?$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * A trial's cause as a screen shows it. While held-out outputs remain to label, where the judge and
 * your labels part ways stays off every screen (as elsewhere), so a contributing judge-vs-label
 * is left out, and a primary one says only that a judge check failed.
 */
export function causeView(cause: TrialCause | null | undefined, labelsDone: boolean): CauseView | null {
  if (!cause) return null;
  const line = (kind: CauseKind, reason: string): CauseLine => ({ kind, name: CAUSE_NAME[kind] ?? kind, reason });
  const contributing = cause.contributing.filter((c) => labelsDone || c.cause !== 'judge_vs_label').map((c) => line(c.cause, c.reason));
  if (cause.cause === 'judge_vs_label' && !labelsDone) {
    return { kind: cause.cause, name: 'A judge check failed', reason: 'How it compares with the human labels is shown once the held-out outputs are labelled', contributing, hidden: true };
  }
  return { ...line(cause.cause, cause.reason), contributing, hidden: false };
}

/** A cause's name in lower case, for the middle of a sentence ("failed, wrong tool"). */
export const causeWord = (kind: CauseKind): string => {
  const name = CAUSE_NAME[kind] ?? kind;
  return kind === 'judge_vs_label' ? 'judge disagrees with your label' : name.charAt(0).toLowerCase() + name.slice(1);
};
