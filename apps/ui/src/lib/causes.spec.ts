import { describe, expect, it } from 'vitest';
import { CAUSE_KINDS, type TrialCause } from '../api/types';
import { CAUSE_NAME, CAUSE_RULE, causeView, causeWord, sentence } from './causes';

const INTERNAL = /\b(?:R\d+[a-z]?|D\d{2}|SP\d|A\d{1,2})\b/;

describe('failure causes in words (D64)', () => {
  const cause = (kind: TrialCause['cause'], contributing: TrialCause['cause'][] = []): TrialCause => ({
    cause: kind,
    reason: `${kind} because`,
    contributing: contributing.map((c) => ({ cause: c, reason: `${c} too` })),
    rules_version: 'causes-1',
  });

  it('names every cause the API can give, with a one-sentence rule and no decision-log number', () => {
    for (const k of CAUSE_KINDS) {
      expect(CAUSE_NAME[k]).toBeTruthy();
      expect(CAUSE_RULE[k]).toMatch(/^[A-Z].*\.$/);
      expect(`${CAUSE_NAME[k]} ${CAUSE_RULE[k]}`).not.toMatch(INTERNAL);
    }
    expect(causeWord('wrong_tool')).toBe('wrong tool');
    expect(causeWord('judge_vs_label')).toBe('judge disagrees with your label');
  });

  it('shows a cause with its contributing ones, and nothing for a trial without one', () => {
    expect(causeView(null)).toBeNull();
    expect(causeView(cause('wrong_tool', ['tool_error']))).toEqual({
      kind: 'wrong_tool',
      name: 'Wrong tool',
      reason: 'wrong_tool because',
      contributing: [{ kind: 'tool_error', name: 'Tool error, not recovered', reason: 'tool_error too' }],
    });
  });

  it('names the judge against your label, primary or contributing, with nothing held back (7 Nov)', () => {
    expect(causeView(cause('wrong_answer', ['judge_vs_label']))?.contributing).toEqual([{ kind: 'judge_vs_label', name: 'Judge disagrees with your label', reason: 'judge_vs_label too' }]);
    const primary = causeView(cause('judge_vs_label', ['wrong_answer']))!;
    expect(primary).toMatchObject({ kind: 'judge_vs_label', name: 'Judge disagrees with your label', reason: 'judge_vs_label because' });
    expect(primary.contributing.map((c) => c.kind)).toEqual(['wrong_answer']);
  });

  it('ends a reason as a sentence once', () => {
    expect(sentence('calculate_emi was never called')).toBe('calculate_emi was never called.');
    expect(sentence('It stopped (Hermes reported "max_steps").')).toBe('It stopped (Hermes reported "max_steps").');
    expect(sentence('cut short…')).toBe('cut short…');
  });
});
