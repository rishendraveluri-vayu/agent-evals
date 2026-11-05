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
    expect(causeView(null, true)).toBeNull();
    expect(causeView(cause('wrong_tool', ['tool_error']), true)).toEqual({
      kind: 'wrong_tool',
      name: 'Wrong tool',
      reason: 'wrong_tool because',
      contributing: [{ kind: 'tool_error', name: 'Tool error, not recovered', reason: 'tool_error too' }],
      hidden: false,
    });
  });

  it('keeps the judge against your label off the screen while held-out outputs remain to label', () => {
    expect(causeView(cause('wrong_answer', ['judge_vs_label']), false)?.contributing).toEqual([]);
    expect(causeView(cause('wrong_answer', ['judge_vs_label']), true)?.contributing.map((c) => c.kind)).toEqual(['judge_vs_label']);
    const blind = causeView(cause('judge_vs_label', ['wrong_answer']), false)!;
    expect(blind).toMatchObject({ kind: 'judge_vs_label', name: 'A judge check failed', hidden: true });
    expect(blind.reason).not.toContain('your label');
    expect(blind.contributing.map((c) => c.kind)).toEqual(['wrong_answer']);
  });

  it('ends a reason as a sentence once', () => {
    expect(sentence('calculate_emi was never called')).toBe('calculate_emi was never called.');
    expect(sentence('It stopped (Hermes reported "max_steps").')).toBe('It stopped (Hermes reported "max_steps").');
    expect(sentence('cut short…')).toBe('cut short…');
  });
});
