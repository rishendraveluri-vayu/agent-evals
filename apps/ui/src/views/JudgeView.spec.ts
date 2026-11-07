import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { AgreementFigures, JudgeTrustResponse } from '../api/types';
import experiments from '../fixtures/experiments.json';
import trustJson from '../fixtures/judge-trust.json';
import tasks from '../fixtures/tasks.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import JudgeView from './JudgeView.vue';
import judgeSource from './JudgeView.vue?raw';

const trust = trustJson as unknown as JudgeTrustResponse;

const judgeNamed = (w: VueWrapper, name: string) => {
  const found = w.findAll('[data-test="judge"]').find((j) => j.get('[data-test="judge-name"]').text() === name);
  if (!found) throw new Error(`no judge ${name}`);
  return found;
};
const row = (judge: ReturnType<typeof judgeNamed>, criterion: string) => judge.get(`[data-test="criterion-row"][data-criterion="${criterion}"]`);

/** The page against a stubbed API. */
function mountWith(body: JudgeTrustResponse) {
  const fetched = routeFetch({
    '/api/judge/trust': body,
    '/api/experiments': experiments,
    '/api/tasks': tasks,
  });
  return { w: mount(JudgeView), ...fetched };
}

describe('JudgeView in fixture mode', () => {
  useFixtures();

  it('lists every judge, a model and a rubric, with its status and its summary in plain words', async () => {
    const w = mount(JudgeView);
    await settle();
    expect(w.get('h1').text()).toBe('Can we trust the judge?');
    const judges = w.findAll('[data-test="judge"]');
    expect(judges.map((j) => j.get('[data-test="judge-name"]').text())).toEqual([
      'Claude Haiku 5.5, rubric advice.v4',
      'Gemini 3.8 Flash, rubric advice.v4',
      'Claude Haiku 5.5, rubric advice.v3',
      'Claude Sonnet 5.5, rubric advice.v4',
    ]);
    // Each judge's own badge is the first on its card, before the per-question ones.
    expect(judges.map((j) => j.get('.judge-head [data-test="trust-label"]').text())).toEqual(['Not trusted', 'Trusted', 'Tuning only', 'Uncalibrated']);
    // The decision-log reference in the API's sentence is left out.
    expect(judges[0].get('[data-test="judge-summary"]').text()).toBe(
      'Tested on 40 held-out labels and it missed the trust bar: read its verdicts as a hint, and look at where it disagrees with people.',
    );
    expect(judges[0].text()).toContain('112 trials judged, in 3 experiments');
    expect(judges[0].get('[data-test="judge-name"] .mono').attributes('title')).toBe('configs/rubrics/advice.v4.md');
  });

  it('says why labelling matters and what kappa is, once, in the head of the page', async () => {
    const w = mount(JudgeView);
    await settle();
    expect(w.get('[data-test="judge-lede"]').text()).toBe(
      'A judge is only as good as its agreement with people. Each one here is measured against human labels on the outputs it graded, one question at a time. Label a few outputs blind and its agreement updates as you go.',
    );
    expect(w.get('[data-test="kappa-note"]').text()).toBe('Kappa is agreement beyond chance: 1 is perfect, 0 is no better than chance.');
    expect(w.text().match(/agreement beyond chance/g)).toHaveLength(1);
  });

  it('gives each question its status, its figures on both sets, and its retest', async () => {
    const w = mount(JudgeView);
    await settle();
    const haiku = judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4');
    const rows = haiku.findAll('[data-test="criterion-row"]');
    expect(rows.map((r) => r.attributes('data-criterion'))).toEqual(['overall', 'fd-tax', 'horizon', 'explains-plainly', 'kind-and-direct']);
    expect(rows.map((r) => r.get('[data-test="trust-label"]').text())).toEqual(['Not trusted', 'Trusted', 'Too few labels', 'Tuning only', 'Uncalibrated']);
    const overall = row(haiku, 'overall');
    expect(overall.get('th').text()).toContain('Would a real client in this situation be well served by this?');
    expect(overall.findAll('[data-test="criterion-heldout"] .block').map((l) => l.text())).toEqual([
      '40 labels, 19 of them "no"',
      'Kappa 0.55 (0.29 to 0.79)',
      "Says yes to 81% of people's yes, no to 74% of their no",
      'Left out: 2 not sure or tied, 1 the judge did not decide',
    ]);
    expect(overall.get('[data-test="criterion-tuning"]').text()).toContain('12 labels, kappa 0.66');
    expect(overall.get('[data-test="criterion-retest"]').text()).toContain('46 of 50 the same (92%)');
    // A question with held-out labels but no interval says so, and what it still needs.
    const horizon = row(haiku, 'horizon');
    expect(horizon.get('[data-test="criterion-heldout"]').text()).toContain('Kappa 0.74, no interval yet');
    expect(horizon.get('[data-test="criterion-needs"]').text()).toBe('Needs 2 more "no" labels on held-out outputs.');
    expect(horizon.get('[data-test="criterion-retest"]').text()).toContain('Not measured yet');
    // Not yet labelled at all: every figure says none.
    const kind = row(haiku, 'kind-and-direct');
    expect(kind.get('[data-test="criterion-heldout"]').text()).toContain('None yet');
    expect(kind.get('[data-test="criterion-tuning"]').text()).toContain('None yet');
  });

  it('lists the reasons a judge is not trusted, in plain words, and only for not trusted', async () => {
    const w = mount(JudgeView);
    await settle();
    const haiku = judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4');
    expect(row(haiku, 'overall').findAll('[data-test="criterion-reasons"] li').map((li) => li.text())).toEqual([
      'Kappa 0.55 is under the bar of 0.6',
      'The lower end of its interval, 0.29, is under 0.4',
      "Arm B's false-pass rate is 0.21 higher than arm A's (interval 0.02 to 0.40), so the judge lets more of one arm's failures through",
    ]);
    // A question with too few labels keeps its reasons to the one thing it needs.
    expect(row(haiku, 'horizon').find('[data-test="criterion-reasons"]').exists()).toBe(false);
    expect(row(haiku, 'fd-tax').find('[data-test="criterion-reasons"]').exists()).toBe(false);
    // Each badge reads its question's sentence out and shows it as a tooltip.
    expect(row(haiku, 'fd-tax').get('[data-test="trust-badge"]').attributes('title')).toBe('Meets the trust bar on 30 held-out labels: its verdicts on this question can be relied on.');
  });

  it("draws each question's held-out kappa with its interval against the bar, and says it in words", async () => {
    const w = mount(JudgeView);
    await settle();
    const haiku = judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4');
    expect(haiku.get('svg[role="img"]').attributes('aria-label')).toBe('Held-out kappa by question, with its interval: overall 0.55 (0.29 to 0.79); fd-tax 0.87 (0.68 to 1.00). The bar is 0.6.');
    // No held-out kappa with an interval: no figure.
    expect(judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v3').find('svg[role="img"]').exists()).toBe(false);
  });

  it("links each judge to calibrate on its newest experiment, in that experiment's label set", async () => {
    const w = mount(JudgeView);
    await settle();
    const link = (name: string) => judgeNamed(w, name).find('[data-test="judge-calibrate"]');
    expect(link('Claude Haiku 5.5, rubric advice.v4').attributes('href')).toBe('#/labels?set=heldout&experiment=exp_heldout&calibrate=1');
    expect(link('Claude Haiku 5.5, rubric advice.v4').text()).toBe('Calibrate this judge');
    // Its newest experiment ran discovery tasks, so the labels go to the tuning set.
    expect(link('Claude Haiku 5.5, rubric advice.v3').attributes('href')).toBe('#/labels?set=tuning&experiment=exp_model&calibrate=1');
    expect(judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4').text()).toContain('Label outputs from Prompt v1 vs v2, held-out, without seeing its verdicts.');
  });

  it('lists where it and people disagree in a fold, even with outputs still to label, under a caution to label first', async () => {
    const w = mount(JudgeView);
    await settle();
    const haiku = judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4');
    const list = haiku.get('[data-test="disagreements"]');
    expect(list.element.tagName).toBe('DETAILS');
    expect(list.attributes('open')).toBeUndefined();
    // 16 disagreements, some on the same output: the sample's lists them on 13 trials.
    expect(list.get('[data-test="disagreements-count"]').text()).toBe('16 disagreements on 13 outputs');
    // The sample's held-out set has 3 outputs to go: they are listed all the same (7 Nov).
    expect(list.get('[data-test="disagreements-caution"]').text()).toBe(
      "If you will label this judge's outputs, label them first: its reasons here can steer the labels you give.",
    );
    expect(list.findAll('[data-test="disagreement"]')).toHaveLength(16);
    expect(list.text()).toContain('Lectures her about the EMI');
  });

  it('explains every badge, with the bar as applied', async () => {
    const w = mount(JudgeView);
    await settle();
    const rows = w.findAll('[data-test="legend-row"]');
    expect(rows.map((r) => r.get('[data-test="trust-label"]').text())).toEqual(['Uncalibrated', 'Tuning only', 'Too few labels', 'Trusted', 'Not trusted']);
    expect(rows[0].text()).toContain('No one has labelled an output this judge graded. Its verdicts are a hint.');
    expect(rows[3].text()).toContain('kappa at least 0.6, the low end of its interval at least 0.4, at least 5 "no" labels from people');
    expect(rows[3].text()).toContain('at least 90% of the time when it grades an output again');
    expect(w.get('[data-test="trust-legend"]').text()).toContain('Held-out labels test the judge');
  });
});

describe('JudgeView against the API', () => {
  it('lists every disagreement held-out first, with the reason, the note and the trial', async () => {
    const { w } = mountWith(trust);
    await settle();
    const haiku = judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4');
    const shown = haiku.findAll('[data-test="disagreement"]');
    // Every one the figures count: 12 held-out and 4 tuning, held-out first.
    expect(shown).toHaveLength(16);
    expect(shown.map((d) => d.get('.dis-head').text().replace(/^.*· /, ''))).toEqual([...Array<string>(12).fill('Held-out label'), ...Array<string>(4).fill('Tuning label')]);
    const first = shown[0];
    expect(first.get('a').attributes('href')).toBe('#/trials/tr_debt-regret-04_b_1');
    expect(first.get('.dis-head').text()).toBe('debt-regret-04 · overall · Held-out label');
    expect(first.get('[data-test="disagreement-verdicts"]').text()).toBe('People said No, the judge said Yes.');
    expect(first.get('[data-test="disagreement-reason"]').text()).toBe("The judge's reason: Direct about the real cost of the phone, and kind in tone.");
    expect(first.get('[data-test="disagreement-note"]').text()).toBe("The label's note: Lectures her about the EMI in the second paragraph.");
    // No note, no line for it.
    expect(shown[1].find('[data-test="disagreement-note"]').exists()).toBe(false);
  });

  it('counts the outputs it disagrees on, an output wrong on two questions once (review 7 Nov, F4)', async () => {
    // Live, Gemini 3.8 Flash on advice.v4: 20 disagreements on 17 trials were called "20 outputs".
    const [haiku] = trust.judges;
    const on = (trial_id: string) => ({ trial_id, task_id: 'draft-convo-consolidation', set: 'heldout' as const, human: 'yes' as const, judge: 'no' as const, judge_reason: null, human_note: null });
    const twice = { ...haiku, criteria: haiku.criteria.map((c, i) => ({ ...c, disagreements: i < 2 ? [on('t_0mw38a1yo6a7e2cbbf94d52f9')] : [] })) };
    const { w } = mountWith({ ...trust, judges: [twice] });
    await settle();
    const list = w.get('[data-test="disagreements"]');
    expect(list.get('[data-test="disagreements-count"]').text()).toBe('2 disagreements on 1 output');
    expect(list.findAll('[data-test="disagreement"]')).toHaveLength(2);
    // One disagreement per output: the count is of outputs alone.
    const once = { ...haiku, criteria: haiku.criteria.map((c, i) => ({ ...c, disagreements: i < 2 ? [on(`t_${i}`)] : [] })) };
    const again = mountWith({ ...trust, judges: [once] }).w;
    await settle();
    expect(again.get('[data-test="disagreements-count"]').text()).toBe('2 outputs');
  });

  it('never asks what is left to label: the list does not wait on it', async () => {
    const { w, calls } = mountWith(trust);
    await settle();
    expect(calls.some((c) => c.url.includes('/labels/queue'))).toBe(false);
    expect(judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4').findAll('[data-test="disagreement"]')).toHaveLength(16);
  });

  it('says so when no judge has graded anything, and still says what the badges mean', async () => {
    const { w } = mountWith({ ...trust, judges: [] });
    await settle();
    expect(w.get('[data-test="judge-empty"] h2').text()).toBe('No judge has graded any output yet.');
    expect(w.findAll('[data-test="judge"]')).toHaveLength(0);
    expect(w.findAll('[data-test="legend-row"]')).toHaveLength(5);
  });

  it('says a judge agrees on everything labelled when its figures count no disagreement, and nothing when it has no labels', async () => {
    const [haiku] = trust.judges;
    const clean = (f: AgreementFigures | null) => f && { ...f, tp: f.tp + f.fn, tn: f.tn + f.fp, fp: 0, fn: 0 };
    const agreeing = { ...haiku, criteria: haiku.criteria.map((c) => ({ ...c, heldout: clean(c.heldout), tuning: clean(c.tuning), disagreements: [] })) };
    const { w } = mountWith({ ...trust, judges: [agreeing, trust.judges[3]] });
    await settle();
    const [first, unlabelled] = w.findAll('[data-test="judge"]');
    expect(first.get('[data-test="no-disagreements"]').text()).toBe('It matches people on every labelled output so far.');
    expect(first.find('[data-test="disagreements"]').exists()).toBe(false);
    expect(unlabelled.find('[data-test="no-disagreements"]').exists()).toBe(false);
  });

  it('links to calibrate after its tasks have a newer version, reading the set from the experiment as it ran', async () => {
    // The task list holds only newer versions, whose hashes match no experiment; exp_heldout's own record keeps its tasks.
    const newer = tasks.map((t) => ({ ...t, sha256: `sha256:${'f'.repeat(63)}${t.id.length % 10}` }));
    const ran = [{ ...tasks[0], split: 'held_out' }];
    routeFetch({ '/api/judge/trust': trust, '/api/experiments': experiments, '/api/tasks': newer, '/api/experiments/exp_heldout': { id: 'exp_heldout', tasks: ran } });
    const w = mount(JudgeView);
    await settle();
    expect(judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4').get('[data-test="judge-calibrate"]').attributes('href')).toBe('#/labels?set=heldout&experiment=exp_heldout&calibrate=1');
    // exp_model's record is not served: with no task to go on, no link.
    expect(judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v3').find('[data-test="judge-calibrate"]').exists()).toBe(false);
  });

  it('never links to calibrate on a shipped example, which is never labelled', async () => {
    const exampled = experiments.map((e) => (e.id === 'exp_heldout' ? { ...e, example: { name: 'x', title: 'Shipped', loaded_at: '2026-11-05T08:00:00.000Z' } } : e));
    routeFetch({ '/api/judge/trust': trust, '/api/experiments': exampled, '/api/tasks': tasks });
    const w = mount(JudgeView);
    await settle();
    // Its next newest experiment, exp_harness, is your own.
    expect(judgeNamed(w, 'Claude Haiku 5.5, rubric advice.v4').get('[data-test="judge-calibrate"]').attributes('href')).toBe('#/labels?set=heldout&experiment=exp_harness&calibrate=1');
  });

  it('says what could not load when the API refuses', async () => {
    routeFetch({});
    const w = mount(JudgeView);
    await settle();
    expect(w.get('[data-test="load-error"]').text()).toContain('Could not load how far to trust each judge');
  });

  it('no longer says the agreement is not shown in this version', () => {
    expect(judgeSource).not.toContain('Not shown in this version');
    expect(judgeSource).not.toContain('judgeAgreement');
  });
});
