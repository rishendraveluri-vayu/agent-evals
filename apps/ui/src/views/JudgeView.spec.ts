import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import agreement from '../fixtures/judge-agreement.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import JudgeView from './JudgeView.vue';
import judgeSource from './JudgeView.vue?raw';

describe('JudgeView in fixture mode', () => {
  useFixtures();

  it('answers the question first, with kappa, its interval and the bar', async () => {
    const w = mount(JudgeView);
    await settle();
    const answer = w.get('[data-test="judge-answer"]').text();
    expect(answer).toContain('Mostly, with one caution');
    expect(answer).toContain(
      "The judge agrees with you on 34 of 40 labelled checks (one output, one question). Cohen's κ is 0.70, above the bar, but the interval runs from 0.47 to 0.88, so its lower end is under 0.6.",
    );
    expect(answer).not.toContain('outputs');
    expect(w.get('[data-test="judge-matrix"]').text()).toMatch(/19\s*agree\s*3\s*too lenient[\s\S]*3\s*too strict\s*15\s*agree/);
    expect(w.text()).toContain('Prompt v1, 20 labels');
    expect(w.text()).toContain('The 6 disagreements');
  });

  it('says the numbers are provisional while held-out outputs remain to label', async () => {
    const w = mount(JudgeView);
    await settle();
    expect(w.get('[data-test="provisional"]').text()).toBe('Provisional: 3 held-out outputs (7 checks) still to label. These numbers will change.');
    expect(w.get('.lede').text()).toBe(
      'Measured on 40 of 47 held-out checks so far, which are never used to tune the rubric. The bar of 0.6 was set before any results came in.',
    );
    // The numbers stay in view while provisional.
    expect(w.find('[data-test="judge-answer"]').exists()).toBe(true);
    expect(w.find('[data-test="judge-matrix"]').exists()).toBe(true);
  });

  it("keeps the judge's reasons closed until the held-out set is labelled, so labelling stays blind", async () => {
    const w = mount(JudgeView);
    await settle();
    expect(w.text()).toContain('The 6 disagreements');
    expect(w.findAll('[data-test="disagreement-row"]')).toHaveLength(0);
    expect(w.get('[data-test="disagreements-later"]').text()).toBe(
      "These open when the held-out set is done (3 to go), so the judge's reasons cannot steer the labels still to come.",
    );
    expect(w.text()).not.toContain(agreement.disagreements[0].evidence);
  });

  it('claims no more about bias than kappa can show, and sets your consistency beside the judge on one measure', async () => {
    const w = mount(JudgeView);
    await settle();
    const note = w.get('[data-test="per-config-note"]').text();
    expect(note).toBe('How often you and the judge agree within each arm. κ does not show which way the judge leans, so a gap here is not evidence for or against bias.');
    expect(w.text()).not.toContain('favoured');
    expect(w.text()).not.toContain('Compare these two');
    expect(w.text()).toContain('Prompt v2, 20 labels');
    const self = w.get('[data-test="self-line"]').text();
    expect(self).toBe(
      'relabelled checks got the same answer (90%, interval 60% to 98%). The judge matched you on 34 of 40 (85%, interval 71% to 93%). 10 relabels are too few to tell that apart from your own consistency.',
    );
    expect(self).not.toContain('ceiling');
    expect(w.text()).toContain('9 of 10');
  });

  it('draws the matrix in neutral greys: no cell carries a pass or fail class or colour', async () => {
    const w = mount(JudgeView);
    await settle();
    const cells = w.findAll('[data-test="matrix-cell"]');
    expect(cells).toHaveLength(4);
    for (const c of cells) expect(c.classes().some((k) => /pass|fail/.test(k))).toBe(false);
    expect(cells.map((c) => c.classes()[0])).toEqual(['agree', 'disagree', 'disagree', 'agree']);
    expect(judgeSource).not.toMatch(/--(pass|fail)(-soft)?\b/);
  });
});

describe('JudgeView once the held-out set is labelled', () => {
  it('opens the disagreements with their evidence', async () => {
    routeFetch({ '/api/judge/agreement?set=heldout': agreement, '/api/configs': [], '/api/experiments': [], '/api/labels/queue?set=heldout': [] });
    const w = mount(JudgeView);
    await settle();
    expect(w.find('[data-test="provisional"]').exists()).toBe(false);
    expect(w.find('[data-test="disagreements-later"]').exists()).toBe(false);
    expect(w.get('.lede').text()).toContain('Measured on the 40 held-out checks, which are never used to tune the rubric.');
    const rows = w.findAll('[data-test="disagreement-row"]');
    expect(rows).toHaveLength(6);
    expect(rows[0].text()).toContain(agreement.disagreements[0].evidence);
  });
});

describe('JudgeView against the API: your consistency beside the judge', () => {
  it('says the judge is below your own consistency when its agreement is under your interval', async () => {
    const self = { same: 39, total: 40 };
    routeFetch({ '/api/judge/agreement?set=heldout': { ...agreement, self }, '/api/configs': [], '/api/experiments': [], '/api/labels/queue?set=heldout': [] });
    const w = mount(JudgeView);
    await settle();
    expect(w.get('[data-test="self-line"]').text()).toBe(
      'relabelled checks got the same answer (98%, interval 87% to 100%). The judge matched you on 34 of 40 (85%, interval 71% to 93%), below your own consistency.',
    );
  });
});

describe('JudgeView before SP5', () => {
  it('says the agreement is not measured yet when the API returns null', async () => {
    routeFetch({ '/api/judge/agreement?set=heldout': null, '/api/configs': [], '/api/experiments': [], '/api/labels/queue?set=heldout': [] });
    const w = mount(JudgeView);
    await settle();
    expect(w.get('[data-test="judge-empty"]').text()).toContain('Not measured yet');
    expect(w.find('[data-test="provisional"]').exists()).toBe(false);
  });
});
