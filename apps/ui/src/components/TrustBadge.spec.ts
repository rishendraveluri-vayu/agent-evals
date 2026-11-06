import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { JudgeTrust, JudgeTrustStatus } from '../api/types';
import { intervalWords, judgeFor, kappaWords, labelSetFor, rubricName, rubricOf, trustLabel } from '../lib/trust';
import trustSource from './TrustBadge.vue?raw';
import TrustBadge from './TrustBadge.vue';

const STATUSES: [JudgeTrustStatus, string][] = [
  ['uncalibrated', 'Uncalibrated'],
  ['tuning_only', 'Tuning only'],
  ['too_few', 'Too few labels'],
  ['trusted', 'Trusted'],
  ['not_trusted', 'Not trusted'],
];

describe('TrustBadge', () => {
  it.each(STATUSES)('says %s in words: "%s"', (status, words) => {
    const w = mount(TrustBadge, { props: { status } });
    expect(w.get('[data-test="trust-label"]').text()).toBe(words);
    expect(w.get('[data-test="trust-badge"]').attributes('data-status')).toBe(status);
    expect(w.classes()).toContain(`trust-badge--${status}`);
    expect(trustLabel(status)).toBe(words);
  });

  it('marks trusted with a tick and not trusted with an alert, so the meaning never rests on colour', () => {
    expect(mount(TrustBadge, { props: { status: 'trusted' } }).find('svg.icon').exists()).toBe(true);
    expect(mount(TrustBadge, { props: { status: 'not_trusted' } }).find('svg.icon').exists()).toBe(true);
    for (const status of ['uncalibrated', 'tuning_only', 'too_few'] as const) expect(mount(TrustBadge, { props: { status } }).find('svg').exists()).toBe(false);
  });

  it('carries the summary as its tooltip and reads it out, in plain words', () => {
    const w = mount(TrustBadge, { props: { status: 'not_trusted', summary: 'Tested on 40 held-out labels and it missed the trust bar (D8).' } });
    expect(w.attributes('title')).toBe('Tested on 40 held-out labels and it missed the trust bar.');
    expect(w.get('.visually-hidden').text()).toBe(': Tested on 40 held-out labels and it missed the trust bar.');
    expect(w.text()).toBe('Not trusted: Tested on 40 held-out labels and it missed the trust bar.');
    const bare = mount(TrustBadge, { props: { status: 'trusted' } });
    expect(bare.attributes('title')).toBeUndefined();
    expect(bare.find('.visually-hidden').exists()).toBe(false);
  });

  it('never takes the pass green or fail red: trust is about the judge, not an outcome', () => {
    expect(trustSource).not.toMatch(/--(pass|fail)(-soft)?\b/);
    expect(trustSource).toMatch(/\.trust-badge--not_trusted \{[^}]*var\(--warning\)/);
  });
});

describe('judge trust words', () => {
  const judge = (judge_model: string, rubric: string) => ({ judge_model, rubric }) as JudgeTrust;
  const haikuV4 = judge('claude-haiku-5-5', 'configs/rubrics/advice.v4.md');
  const haikuV3 = judge('claude-haiku-5-5', 'configs/rubrics/advice.v3.md');
  const gemini = judge('gemini-3.8-flash', 'configs/rubrics/advice.v4.md');

  it('finds the judge behind a grade by model, and by rubric when it is known, and never guesses', () => {
    expect(judgeFor([haikuV4, gemini], 'claude-haiku-5-5', null)).toBe(haikuV4);
    expect(judgeFor([haikuV4, haikuV3, gemini], 'claude-haiku-5-5', 'configs/rubrics/advice.v3.md')).toBe(haikuV3);
    // Two rubrics on one model and no rubric to tell them apart: no badge rather than a wrong one.
    expect(judgeFor([haikuV4, haikuV3], 'claude-haiku-5-5', null)).toBeNull();
    // A check not judged, with no model known: the experiment's only judge on that rubric.
    expect(judgeFor([haikuV4], null, null)).toBe(haikuV4);
    expect(judgeFor([haikuV4, gemini], null, 'configs/rubrics/advice.v4.md')).toBeNull();
    expect(judgeFor([haikuV4], 'gemini-3.8-flash', null)).toBeNull();
  });

  it('reads a rubric as the grader names it', () => {
    expect(rubricOf({ type: 'judge', rubric: 'configs/rubrics/advice.v1.md' })).toBe('configs/rubrics/advice.v1.md');
    expect(rubricOf({ type: 'judge', rubric: { id: 'advice', version: 'v4' } })).toBe('configs/rubrics/advice.v4.md');
    expect(rubricOf({ type: 'judge' })).toBeNull();
    expect(rubricOf('advice')).toBeNull();
    expect(rubricName('configs/rubrics/advice.v4.md')).toBe('advice.v4');
  });

  it('calibrates in the held-out set when any task is held-out, else in tuning', () => {
    expect(labelSetFor([{ split: 'held_out' }, { split: 'held_out' }])).toBe('heldout');
    expect(labelSetFor([{ split: 'discovery' }, { split: 'held_out' }])).toBe('heldout');
    expect(labelSetFor([{ split: 'discovery' }])).toBe('tuning');
    expect(labelSetFor([])).toBe('tuning');
  });

  it('writes kappa with a true minus, and says when it or its interval is undefined', () => {
    expect(kappaWords(0.5477)).toBe('0.55');
    expect(kappaWords(-0.12)).toBe('−0.12');
    expect(kappaWords(null)).toBe('not defined');
    expect(intervalWords({ low: 0.29, high: 0.79, undefined_share: 0 })).toBe('0.29 to 0.79');
    expect(intervalWords({ low: null, high: null, undefined_share: 0.08 })).toBeNull();
  });
});
