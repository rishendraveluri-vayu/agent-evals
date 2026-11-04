import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import JudgeView from './JudgeView.vue';

describe('JudgeView in fixture mode', () => {
  useFixtures();

  it('answers the question first, with kappa, its interval and the bar', async () => {
    const w = mount(JudgeView);
    await settle();
    const answer = w.get('[data-test="judge-answer"]').text();
    expect(answer).toContain('Mostly, with one caution');
    expect(answer).toContain("The judge agrees with you on 34 of 40 outputs. Cohen's κ is 0.70, above the bar, but the interval runs from 0.47 to 0.88, so its lower end is under 0.6.");
    expect(w.get('[data-test="judge-matrix"]').text()).toMatch(/19\s*agree\s*3\s*too lenient[\s\S]*3\s*too strict\s*15\s*agree/);
    expect(w.text()).toContain('Prompt v1, 20 labels');
    expect(w.text()).toContain('The 6 disagreements');
  });
});

describe('JudgeView before SP5', () => {
  it('says the agreement is not measured yet when the API returns null', async () => {
    routeFetch({ '/api/judge/agreement?set=heldout': null, '/api/configs': [], '/api/experiments': [] });
    const w = mount(JudgeView);
    await settle();
    expect(w.get('[data-test="judge-empty"]').text()).toContain('Not measured yet');
  });
});
