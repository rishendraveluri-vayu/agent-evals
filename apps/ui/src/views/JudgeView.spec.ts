import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import agreement from '../fixtures/judge-agreement.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import JudgeView from './JudgeView.vue';
import judgeSource from './JudgeView.vue?raw';

/** A no-break space: κ keeps its value. */
const nb = '\u00a0';

describe('JudgeView in fixture mode', () => {
  useFixtures();

  it('answers the question first, with kappa, its interval and the bar', async () => {
    const w = mount(JudgeView);
    await settle();
    const answer = w.get('[data-test="judge-answer"]').text();
    // Held-out checks remain to label, so the answer says it holds so far.
    expect(w.get('#answer').text()).toBe('Mostly so far, with one caution');
    expect(answer).toContain(
      "The judge agrees with you on 34 of 40 labelled checks (one output, one question). Cohen's κ is 0.70, above the bar, but the interval runs from 0.47 to 0.88, so its lower end is under 0.6.",
    );
    expect(answer).not.toContain('outputs');
    expect(w.get('[data-test="judge-matrix"]').text()).toMatch(/19\s*agree\s*3\s*too lenient[\s\S]*3\s*too strict\s*15\s*agree/);
    expect(w.findAll('[data-test="per-config-row"]').map((r) => r.text())).toEqual([`Prompt v1 · κ${nb}0.73 · 20 checks`, `Prompt v2 · κ${nb}0.66 · 20 checks`]);
    expect(w.text()).toContain('The 6 disagreements');
  });

  it('says the numbers are provisional while held-out outputs remain to label', async () => {
    const w = mount(JudgeView);
    await settle();
    const provisional = w.get('[data-test="provisional"]');
    expect(provisional.text()).toBe('Provisional: 3 held-out outputs (7 checks) still to label. These numbers will change.');
    // The shared caveat line, with its icon, under the lede.
    expect(provisional.classes()).toEqual(['caveat']);
    expect(provisional.find('svg.icon').exists()).toBe(true);
    expect(w.get('.lede').element.nextElementSibling).toBe(provisional.element);
    expect(judgeSource).not.toMatch(/^\.provisional\b/m);
    expect(w.get('.lede').text()).toBe(
      'Measured on 40 of 47 held-out checks so far, which are never used to tune the rubric. The bar is 0.6.',
    );
    // The caveat opens with its point, in ink at medium weight.
    expect(provisional.get('strong.caveat-lead').text()).toBe('Provisional:');
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
    expect(note).toBe(
      "Cohen's κ within each arm, 20 checks each. No interval is given per arm, and at this size the gap between 0.73 and 0.66 says little. κ also cannot show which arm the judge is lenient on: the 3 too-lenient and 3 too-strict checks are not split by arm here.",
    );
    // The retired note, spelt in parts so a search of the source finds none.
    expect(w.text()).not.toContain(['How often you', 'and the judge agree'].join(' '));
    expect(w.text()).not.toContain('favoured');
    expect(w.text()).not.toContain('Compare these two');
    // Regular weight: no figure on these rows is set in bold.
    for (const r of w.findAll('[data-test="per-config-row"]')) expect(r.find('.strong').exists()).toBe(false);
    // The retest figure comes with its interval, as your own relabels do.
    expect(w.get('[data-test="retest-line"]').text()).toBe('checks got the same verdict in all 3 runs (96%, interval 91% to 98%). The 5 that flipped were all on "kind and direct".');
    expect(w.text()).toContain('115 of 120');
    expect(w.get('.meaning').text()).toBe(
      "What this means for results: a difference on tasks that need the judge's pass is weaker evidence than one on code-graded tasks. Read those task rows with that in mind.",
    );
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

describe('JudgeView against the API: the answer while labels remain and once they are done', () => {
  const clearing = { ...agreement, kappa: { estimate: 0.8, low: 0.65, high: 0.92 } };
  const queued = [{ item_id: 'lq_1', task_summary: '', transcript: [{ role: 'assistant', content: 'Answer.' }], tool_calls: [], criteria: ['First?'] }];

  it('says "Yes so far" while held-out checks remain, even when the whole interval clears the bar', async () => {
    routeFetch({ '/api/judge/agreement?set=heldout': clearing, '/api/configs': [], '/api/experiments': [], '/api/labels/queue?set=heldout': queued });
    const w = mount(JudgeView);
    await settle();
    expect(w.get('#answer').text()).toBe('Yes so far');
  });

  it('says "Yes, on this evidence" once every held-out check is labelled', async () => {
    routeFetch({ '/api/judge/agreement?set=heldout': clearing, '/api/configs': [], '/api/experiments': [], '/api/labels/queue?set=heldout': [] });
    const w = mount(JudgeView);
    await settle();
    expect(w.get('#answer').text()).toBe('Yes, on this evidence');
  });

  it('keeps "Mostly, with one caution" once labelled when the interval reaches under the bar', async () => {
    routeFetch({ '/api/judge/agreement?set=heldout': agreement, '/api/configs': [], '/api/experiments': [], '/api/labels/queue?set=heldout': [] });
    const w = mount(JudgeView);
    await settle();
    expect(w.get('#answer').text()).toBe('Mostly, with one caution');
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

describe('JudgeView against the API: arms with different numbers of checks', () => {
  it('gives each count, and the matrix counts that are not split by arm', async () => {
    const per_config = [{ ...agreement.per_config[0] }, { ...agreement.per_config[1], labels: 18 }];
    const matrix = { ...agreement.matrix, judge_pass_you_fail: 4, judge_fail_you_pass: 2 };
    routeFetch({ '/api/judge/agreement?set=heldout': { ...agreement, per_config, matrix }, '/api/configs': [], '/api/experiments': [], '/api/labels/queue?set=heldout': [] });
    const w = mount(JudgeView);
    await settle();
    const note = w.get('[data-test="per-config-note"]').text();
    expect(note).toContain("Cohen's κ within each arm, 20 and 18 checks.");
    expect(note).toContain('the 4 too-lenient and 2 too-strict checks are not split by arm here.');
    expect(w.findAll('[data-test="per-config-row"]')[1].text()).toContain('18 checks');
  });
});

describe('JudgeView before SP5', () => {
  it('says the agreement is not measured yet when the API returns null', async () => {
    routeFetch({ '/api/judge/agreement?set=heldout': null, '/api/configs': [], '/api/experiments': [], '/api/labels/queue?set=heldout': [] });
    const w = mount(JudgeView);
    await settle();
    const empty = w.get('[data-test="judge-empty"]').text();
    expect(empty).toContain('Not shown in this version');
    // Not "has not reported yet", which reads as pending: this version does not show it at all.
    expect(empty).not.toContain('reported');
    expect(w.get('.lede').text()).not.toMatch(/^Measured/);
    expect(w.find('[data-test="provisional"]').exists()).toBe(false);
  });
});
