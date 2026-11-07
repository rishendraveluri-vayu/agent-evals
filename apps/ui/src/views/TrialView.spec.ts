import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import trustJson from '../fixtures/judge-trust.json';
import queue from '../fixtures/label-queue.json';
import prompts from '../fixtures/prompts.json';
import trialSpans from '../fixtures/trial-spans.json';
import trial from '../fixtures/trial.json';
import type { JudgeCriterionTrust, JudgeTrustResponse } from '../api/types';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import TrialView from './TrialView.vue';

describe('TrialView in fixture mode', () => {
  useFixtures();

  it('leads with the arm, the trial and the outcome in words', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="trial-title"]').text()).toBe('Arm B, trial 3 of 5');
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed 1 of 3 checks');
    const facts = w.get('[data-test="trial-facts"]').text();
    expect(facts).toContain('Agent answered');
    // Beside the call counts: the simulated client's model, which shapes the conversation too.
    expect(facts).toContain('Hermes counted 3; client Claude Haiku 5.5');
    expect(facts).toContain('5.4 s of it start-up');
    expect(facts).toContain('$0.18');
    expect(facts).toContain('3 agent, 1 client');
    expect(facts).toContain('19,240');
  });

  it('says a trial that does not exist is not found, under a breadcrumb, with a way out', async () => {
    const w = mount(TrialView, { props: { trialId: 't_nope' } });
    await settle();
    expect(w.find('[data-test="load-error"]').exists()).toBe(false);
    const page = w.get('[data-test="not-found"]');
    expect(page.get('nav').text()).toBe('Experiments / Not found');
    expect(page.get('h1').text()).toBe('No trial with that id');
    expect(page.text()).toContain('Nothing is saved as t_nope');
    expect(page.findAll('a').map((a) => a.attributes('href'))).toEqual(['#/experiments', '#/experiments', '#/trials']);
  });

  it('puts the tool calls before the reply and marks what the failed check quoted', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const names = w.findAll('[data-test="tool-call"] summary .mono').map((n) => n.text());
    expect(names).toEqual(['get_client_profile', 'fd_maturity', 'sip_future_value']);
    const messages = w.findAll('[data-test="message"]');
    expect(messages.map((m) => m.find('.bubble-who').text())).toEqual(['Client', 'Agent']);
    expect(messages[1].get('mark').text()).toBe('an FD is the safer choice. ₹5 lakh at 7.1% grows to about ₹7,10,870');
    // The highlight links to the check that quoted it, and says so to a screen reader.
    const quote = messages[1].get('[data-test="quote-link"]');
    expect(quote.attributes('href')).toBe('#grade-1');
    expect(quote.get('.visually-hidden').text()).toBe('Quoted by the judge for fd-tax:');
    expect(w.get('[data-test="mark-key"]').text()).toBe('Highlighted: text the judge quoted for a failed check.');
    expect(w.findAll('[data-test="mark-key"]')).toHaveLength(1);
    const grades = w.findAll('[data-test="grade"]');
    expect(grades).toHaveLength(3);
    expect(grades[1].text()).toContain('fd-tax');
    expect(grades[1].text()).toContain('Fail');
    expect(grades[1].get('[data-test="grade-kind"]').text()).toBe('Judge claude-haiku-5-5, rubric 5123602');
    expect(grades[1].get('[data-test="grade-kind"] .mono').text()).toBe('claude-haiku-5-5');
    expect(grades[0].get('[data-test="grade-kind"]').text()).toBe('Exact match, number');
    const at = w.findAll('[data-test="tool-call"] .at');
    expect(at[0].text()).toMatch(/^at \d+\.\d s$/);
    expect(at[0].attributes('title')).toMatch(/^Started \d+\.\d s in, took \d+\.\d s$/);
  });

  it("lists this task's other trials in this arm, each with how it ended, as links", async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const strip = w.get('[data-test="same-cell"]');
    expect(strip.attributes('aria-label')).toBe('Trials of fd-vs-sip-07 in arm B');
    expect(strip.text()).toMatch(/^Arm B on fd-vs-sip-07:/);
    const items = strip.findAll('li');
    expect(items.length).toBeGreaterThan(1);
    // This trial is named, not linked; the others link to their own pages.
    const current = strip.get('[aria-current="page"]');
    expect(current.text()).toBe('Trial 3');
    const links = strip.findAll('a').map((a) => a.attributes('href'));
    expect(links.every((h) => h?.startsWith('#/trials/tr_fd-vs-sip-07_b_'))).toBe(true);
    expect(links).not.toContain('#/trials/tr_fd-vs-sip-07_b_3');
    for (const li of items) expect(li.text()).toMatch(/(passed|failed|infra failure|not graded|running|not run yet|cancelled)$/);
  });

  it('names the pinned harness and says which check failed and who graded it', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="trial-meta"]').text()).toBe('Prompt v2, config 7f3a9c2, Hermes 6112c2a');
    const failedOn = w.get('[data-test="failed-on"]');
    expect(failedOn.get('a').attributes('href')).toBe('#grade-1');
    const grades = w.findAll('[data-test="grade"]');
    expect(grades[1].attributes('id')).toBe('grade-1');
    // The status pill still reports the grades as they are.
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed 1 of 3 checks');
  });

  it('says where your held-out label disputes the judge, though the sample still has held-out outputs to label', async () => {
    // The sample's held-out queue has 3 outputs to go, and your label on this trial disputes the
    // judge: the page says so all the same (7 Nov).
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-tax (judge; your label passes it)');
    expect(w.get('[data-test="dispute"]').text()).toBe('Your held-out label disagrees with the judge on fd-tax: you said Yes, the judge said No. See judge agreement');
    // Its quotes, rationale and highlight stay.
    const grades = w.findAll('[data-test="grade"]');
    expect(grades[1].find('blockquote').exists()).toBe(true);
    expect(grades[1].text()).toContain('The profile shows a 30% slab');
    expect(w.find('[data-test="hidden-reasons"]').exists()).toBe(false);
    expect(w.find('mark').exists()).toBe(true);
    expect(w.find('[data-test="mark-key"]').exists()).toBe(true);
  });

  it('jumps to the failed check without changing the route, from "Failed on" or the highlight', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' }, attachTo: document.body });
    await settle();
    const before = window.location.hash;
    await w.get('[data-test="failed-on"] a').trigger('click');
    expect(document.activeElement?.id).toBe('grade-1');
    (document.activeElement as HTMLElement).blur();
    await w.get('[data-test="quote-link"]').trigger('click');
    expect(document.activeElement?.id).toBe('grade-1');
    expect(window.location.hash).toBe(before);
    w.unmount();
  });

  it('shows a chevron on every disclosure, after the time on tool rows', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="tool-call"]').classes()).toEqual(expect.arrayContaining(['disclosure', 'tool-call']));
    expect(w.get('.requests > summary').text()).toMatch(/^Model requests \(\d+\)$/);
  });

  it('places the timeline in the story column, under the conversation', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const story = w.get('.story');
    expect(story.find('#timeline').exists()).toBe(true);
    expect(story.find('#convo').exists()).toBe(true);
    expect(w.get('.grading').find('#timeline').exists()).toBe(false);
  });

  it('keeps the settings and files apart from the grading, so a phone can put the story between them', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const grading = w.get('.grading').element;
    const applied = w.get('.applied').element;
    expect(applied.parentElement).toBe(grading.parentElement);
    expect(grading.contains(applied)).toBe(false);
    expect(w.get('.grading').find('#graders').exists()).toBe(true);
    expect(w.get('.grading').findAll('[data-test="grade"]')).toHaveLength(3);
    expect(w.get('.applied').text()).toContain('Settings as applied');
    expect(w.get('.applied').find('[data-test="trial-files"]').exists()).toBe(true);
    expect(w.get('.applied').find('.requests').exists()).toBe(true);
    // The files have their own heading, and the model requests their own row.
    expect(w.get('[data-test="files-title"]').text()).toBe('Files');
    expect(w.get('[data-test="files-title"]').classes()).toContain('sub-title');
    expect(w.get('[data-test="files-title"]').element.nextElementSibling).toBe(w.get('[data-test="trial-files"]').element);
  });

  it('says prompt-cache markers change cost and time, not the reply', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const source = w.get('[data-test="applied-source-prompt_cache_markers"]');
    // D31: cache markers are off in every Hermes config, so the config sets it.
    expect(source.text()).toBe('Config Affects cost and time, not the reply.');
    expect(source.get('.setting-note').text()).toBe('Affects cost and time, not the reply.');
    expect(w.findAll('.setting-note')).toHaveLength(1);
  });

  it('wraps each summary\'s words in one block, with the time inside it, so only the words wrap', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    for (const summary of w.findAll('.story summary')) expect(summary.find('.summary-text').exists()).toBe(true);
    const at = w.find('[data-test="tool-call"] .summary-text .at');
    expect(at.exists()).toBe(true);
  });

  it('draws the timeline with the start-up and shut-down the harness spends around the agent', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.text()).toContain('Hermes start-up');
    expect(w.text()).toContain('Shut down and collect files');
    const rows = w.findAll('[data-test="span-row"]');
    expect(rows).toHaveLength(7);
    await rows[1].trigger('click');
    expect(w.get('[data-test="span-detail"]').text()).toContain('execute_tool get_client_profile');
  });

  it('says plainly when the sample data has no such trial, and which one it has', async () => {
    const w = mount(TrialView, { props: { trialId: 'nope' } });
    await settle();
    expect(w.get('[data-test="not-found"]').text()).toContain('No sample data for trial nope. The sample covers one trial in full');
  });
});

describe("TrialView against the API: the judge's reasons and your label, with outputs still to label", () => {
  type Detail = { tasks: { id: string; sha256: string }[] };
  const heldout = (details as unknown as Record<string, Detail>).exp_heldout;
  /** The trial's task, as GET /trials/:id carries it: the task's id and sha256. */
  const sha = (id: string) => ({ id, sha256: heldout.tasks.find((t) => t.id === id)?.sha256 ?? '' });
  type Disagreement = JudgeCriterionTrust['disagreements'][number];
  const sample = trustJson as unknown as JudgeTrustResponse;
  /** The judge-trust reply for exp_heldout's judges, with the given criteria's disagreements in
   *  place of the sample's. */
  const trustFor = (by: Record<string, Disagreement[]> = {}): JudgeTrustResponse => ({
    ...sample,
    judges: sample.judges
      .filter((j) => j.experiments.includes('exp_heldout'))
      .map((j) => ({ ...j, criteria: j.criteria.map((c) => (by[c.criterion] ? { ...c, disagreements: by[c.criterion] } : c)) })),
  });
  const onFd = (over: Partial<Disagreement>): Disagreement => ({ trial_id: 'tr_fd-vs-sip-07_b_3', task_id: 'fd-vs-sip-07', set: 'heldout', human: 'yes', judge: 'no', judge_reason: null, human_note: null, ...over });
  function routes(over: { trialId?: string; task?: { id: string; sha256: string }; queue?: unknown; trust?: JudgeTrustResponse }) {
    const id = over.trialId ?? 'tr_fd-vs-sip-07_b_3';
    return routeFetch({
      [`/api/trials/${id}`]: { ...trial, id, task: over.task ? { ...trial.task, ...over.task } : trial.task },
      [`/api/trials/${id}/spans`]: trialSpans,
      // The disputes come from the judges' trust (D83), the one place that lists them.
      '/api/judge/trust?experiment=exp_heldout': over.trust ?? trustFor(),
      '/api/labels/queue?set=heldout': over.queue ?? queue.heldout,
      '/api/experiments/exp_heldout': heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
  }

  it("shows the judge's reasons on a task with outputs still to label, beside its verdicts", async () => {
    // distress-12 has an output in the held-out queue: its judge's quotes, rationale and highlight
    // show all the same (7 Nov).
    routes({ trialId: 'tr_distress-12_b_3', task: sha('distress-12') });
    const w = mount(TrialView, { props: { trialId: 'tr_distress-12_b_3' } });
    await settle();
    const grades = w.findAll('[data-test="grade"]');
    expect(grades).toHaveLength(3);
    for (const [g, rubric] of [[grades[1], '5123602'], [grades[2], '728a3f4']] as const) {
      // The rubric's version is a sha256, shown short.
      expect(g.get('[data-test="grade-kind"]').text()).toBe(`Judge claude-haiku-5-5, rubric ${rubric}`);
      expect(g.find('.pill').exists()).toBe(true);
      expect(g.find('[data-test="grade-reason"]').exists()).toBe(true);
    }
    expect(grades[1].get('.pill').text()).toBe('Fail');
    expect(grades[1].find('blockquote').exists()).toBe(true);
    expect(grades[1].text()).toContain('The profile shows a 30% slab');
    expect(w.find('[data-test="hidden-reasons"]').exists()).toBe(false);
    // The highlight in the transcript, and its key.
    expect(w.find('mark').exists()).toBe(true);
    expect(w.find('[data-test="quote-link"]').exists()).toBe(true);
    expect(w.find('[data-test="mark-key"]').exists()).toBe(true);
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed 1 of 3 checks');
  });

  it('never asks what is left to label: nothing on the page waits on it', async () => {
    const { calls } = routes({ trialId: 'tr_distress-12_b_3', task: sha('distress-12') });
    const w = mount(TrialView, { props: { trialId: 'tr_distress-12_b_3' } });
    await settle();
    expect(calls.some((c) => c.url.includes('/labels/queue'))).toBe(false);
    expect(w.find('[data-test="grade-quote"]').exists()).toBe(true);
  });

  it("says where your label disputes the judge, from the judge's trust, while outputs remain to label", async () => {
    const { calls } = routes({});
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    // SP5's GET /judge/agreement is gone (7 Nov): only the trust reply is asked.
    expect(calls.some((c) => c.url.startsWith('/api/judge/agreement'))).toBe(false);
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-tax (judge; your label passes it)');
    const grades = w.findAll('[data-test="grade"]');
    const dispute = grades[1].get('[data-test="dispute"]');
    expect(dispute.text()).toBe('Your held-out label disagrees with the judge on fd-tax: you said Yes, the judge said No. See judge agreement');
    expect(dispute.get('.mono').text()).toBe('fd-tax');
    expect(dispute.get('a').attributes('href')).toBe('#/labels/judge');
    // The question your label disputes is marked in the trust list; horizon's dispute is another trial's.
    expect(grades[1].get('[data-test="grade-trust-dispute"]').text()).toBe(', your label: yes');
    expect(grades[2].find('[data-test="dispute"]').exists()).toBe(false);
    expect(grades[2].find('[data-test="grade-trust-dispute"]').exists()).toBe(false);
    expect(w.find('mark').exists()).toBe(true);
    expect(w.find('[data-test="hidden-reasons"]').exists()).toBe(false);
  });

  it('names the set and both answers for each disputed question, and says "your label: no" when no dispute passes the check', async () => {
    routes({ trust: trustFor({ 'fd-tax': [onFd({ set: 'tuning', human: 'no', judge: 'yes' })] }) });
    let w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-tax (judge; your label: no)');
    expect(w.get('[data-test="dispute"]').text()).toBe('Your tuning label disagrees with the judge on fd-tax: you said No, the judge said Yes. See judge agreement');
    expect(w.get('[data-test="grade-trust-dispute"]').text()).toBe(', your label: no');
    // Another trial's disagreement is not this one's.
    routes({ trust: trustFor({ 'fd-tax': [onFd({ trial_id: 'tr_fd-vs-sip-07_b_4' })] }) });
    w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-tax (judge)');
    expect(w.find('[data-test="dispute"]').exists()).toBe(false);
    expect(w.find('[data-test="grade-trust-dispute"]').exists()).toBe(false);
  });

  it('lists every question a check is disputed on in one line', async () => {
    const [first, second, third] = trial.grades;
    const evidence = [
      { criterion: 'overall', required: true, verdict: 'yes', quote: 'an FD is the safer choice', source: 'final_answer' },
      ...(second.evidence as Record<string, unknown>[]),
    ];
    const tr = 'tr_fd-vs-sip-07_b_3';
    const trust = trustFor({ overall: [onFd({ human: 'no', judge: 'yes' })], 'fd-tax': [onFd({})] });
    routeFetch({
      [`/api/trials/${tr}`]: { ...trial, grades: [first, { ...second, evidence }, third] },
      [`/api/trials/${tr}/spans`]: trialSpans,
      '/api/judge/trust?experiment=exp_heldout': trust,
      '/api/experiments/exp_heldout': heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
    const w = mount(TrialView, { props: { trialId: tr } });
    await settle();
    expect(w.get('[data-test="dispute"]').text()).toBe(
      'Your held-out labels disagree with the judge on 2 questions: overall (you said No, the judge said Yes); fd-tax (you said Yes, the judge said No). See judge agreement',
    );
    expect(w.findAll('[data-test="grade-trust-dispute"]').map((d) => d.text())).toEqual([', your label: no', ', your label: yes']);
    // It passes fd-tax, but its "no" on overall fails the check all the same (review 7 Nov, F2).
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-tax (judge; your label: no)');
  });
});

describe('TrialView against the API: "Failed on" and what your label says of a failed judge check', () => {
  // Shaped like the headline's live trials (GET /trials/:id, /judge/trust, 7 Nov); every label here is synthetic.
  const ID = 'tr_fd-vs-sip-07_b_3';
  const RUBRIC = 'configs/rubrics/advice.v4.md';
  const CRITERIA = ['overall', 'keep-cash', 'explains-plainly'];
  type Answer = 'yes' | 'no';
  const judgeGrade = (required: boolean, answers: Record<string, Answer>) => ({
    id: 902,
    grader_id: 'overall',
    grader_version: 'sha256:6e96644016030aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'judge',
    type: 'judge',
    required,
    verdict: Object.values(answers).includes('no') ? 'fail' : 'pass',
    score: 0,
    reason: 'judge: fail',
    evidence: [
      ...CRITERIA.map((criterion) => ({ criterion, required: true, verdict: answers[criterion], quote: '', reason: `${criterion}: ${answers[criterion]}.`, source: 'judge', quote_found: false })),
      { source: 'judge_call', model: 'gemini-3.8-flash', rubric: RUBRIC, status: 200 },
    ],
    judge_model: 'gemini-3.8-flash',
    run_index: 0,
    created_at: '2026-11-06T16:09:26.767Z',
  });
  const provenance = (verdict: 'pass' | 'fail') => ({
    id: 901,
    grader_id: 'every-amount-from-a-tool',
    grader_version: 'sha256:e812aa305a830aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'state',
    type: 'provenance',
    required: true,
    verdict,
    score: verdict === 'pass' ? 1 : 0,
    reason: verdict === 'pass' ? 'every figure has a tool result behind it' : '₹1,06,000 has no tool result behind it (1 of 61 figures)',
    evidence: [],
    judge_model: null,
    run_index: 0,
    created_at: '2026-11-06T16:09:26.767Z',
  });
  /** The judge's trust, with a disagreement on this trial for each question given: [human, judge]. A
   *  question the label agrees on lists none, as the API's does. */
  const trust = (disputes: Record<string, [Answer, Answer]>): JudgeTrustResponse => ({
    bar: (trustJson as unknown as JudgeTrustResponse).bar,
    judges: [
      {
        judge_model: 'gemini-3.8-flash',
        rubric: RUBRIC,
        experiments: ['exp_heldout'],
        trials_judged: 200,
        status: 'not_trusted',
        summary: 'Not trusted: kappa 0.00 on 40 held-out labels is below 0.6.',
        criteria: CRITERIA.map(
          (criterion): JudgeCriterionTrust => ({
            criterion,
            text: null,
            status: 'too_few',
            summary: '4 held-out labels so far.',
            heldout: null,
            tuning: null,
            d8: null,
            retest: null,
            needs_human_no: 5,
            disagreements: disputes[criterion]
              ? [{ trial_id: ID, task_id: 'fd-vs-sip-07', set: 'heldout', human: disputes[criterion][0], judge: disputes[criterion][1], judge_reason: null, human_note: null }]
              : [],
          }),
        ),
      },
    ],
  });
  function mountWith(grades: unknown[], judges: JudgeTrustResponse) {
    routeFetch({
      [`/api/trials/${ID}`]: { ...trial, grades },
      [`/api/trials/${ID}/spans`]: trialSpans,
      [`/api/trials/${ID}/files/checks.json`]: { contract_version: '2', amounts: [] },
      '/api/judge/trust?experiment=exp_heldout': judges,
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
    return mount(TrialView, { props: { trialId: ID } });
  }
  const failedTwice = { overall: 'no', 'keep-cash': 'no', 'explains-plainly': 'yes' } as const;

  it('says your label passes the questions it disputes, not the check, when the judge failed it on others too', async () => {
    // Live: the judge said no on overall and keep-cash; the label agrees on overall and passes keep-cash.
    const w = mountWith([provenance('pass'), judgeGrade(true, failedTwice)], trust({ 'keep-cash': ['yes', 'no'] }));
    await settle();
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: overall (judge; your label passes keep-cash but not overall)');
  });

  it('says your label passes the check only when it passes every question the judge failed it on', async () => {
    const w = mountWith([provenance('pass'), judgeGrade(true, failedTwice)], trust({ overall: ['yes', 'no'], 'keep-cash': ['yes', 'no'] }));
    await settle();
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: overall (judge; your label passes it)');
  });

  it('names only the required checks that failed: an optional judge check decided nothing, so it stays in the grades alone', async () => {
    // Live: every judge check on the headline is optional, and the trial failed on provenance.
    const w = mountWith([provenance('fail'), judgeGrade(false, failedTwice)], trust({ 'keep-cash': ['yes', 'no'] }));
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed its one check');
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: every-amount-from-a-tool');
    const grades = w.findAll('[data-test="grade"]');
    expect(grades).toHaveLength(2);
    expect(grades[1].get('[data-test="grade-verdict"]').text()).toBe('Fail');
    expect(grades[1].get('[data-test="dispute"]').text()).toBe('Your held-out label disagrees with the judge on keep-cash: you said Yes, the judge said No. See judge agreement');
  });
});

describe('TrialView against the API: the outcome in words, and the simulated client', () => {
  type Detail = Record<string, unknown> & { sim_model: string | null };
  const heldout = (details as unknown as Record<string, Detail>).exp_heldout;
  const grade = trial.grades[0];
  function mountWith(over: { grades?: unknown[]; simModel?: string | null; trial?: Record<string, unknown>; experiment?: Record<string, unknown> }) {
    routeFetch({
      '/api/trials/tr_fd-vs-sip-07_b_3': { ...trial, grades: over.grades ?? trial.grades, ...over.trial },
      '/api/trials/tr_fd-vs-sip-07_b_3/spans': trialSpans,
      '/api/labels/queue?set=heldout': queue.heldout,
      '/api/experiments/exp_heldout': { ...heldout, sim_model: over.simModel === undefined ? heldout.sim_model : over.simModel, ...over.experiment },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
    return mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
  }

  it('says "Passed all 3 checks", and "its one check" when there is one', async () => {
    const pass = { ...grade, verdict: 'pass' };
    let w = mountWith({ grades: [pass, { ...pass, grader_id: 'g2' }, { ...pass, grader_id: 'g3' }] });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Passed all 3 checks');
    w = mountWith({ grades: [pass] });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Passed its one check');
    w = mountWith({ grades: [{ ...grade, verdict: 'fail' }] });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed its one check');
  });

  it('leaves the client model out of the call counts when the experiment has none', async () => {
    const w = mountWith({ simModel: null });
    await settle();
    const facts = w.get('[data-test="trial-facts"]').text();
    expect(facts).toContain('Hermes counted 3');
    expect(facts).not.toContain('client Claude');
  });

  it('names the adapter code and the platform commit the trial ran on, short, with the full values in titles (D85)', async () => {
    const code = `sha256:b81f0e5${'c2'.repeat(28)}9`;
    const commit = 'c4d2e19a7b3f0e8d6c5b4a39281706f5e4d3c2b1';
    const w = mountWith({ trial: { adapter_sha256: code }, experiment: { platform_commit: commit } });
    await settle();
    const line = w.get('[data-test="trial-code"]');
    expect(line.text()).toBe('Adapter code b81f0e5, platform commit c4d2e19');
    expect(line.get('[data-test="adapter-code"]').attributes('title')).toBe(code);
    expect(line.get('[data-test="platform-commit"]').attributes('title')).toBe(commit);
    // Beside the arm and config line, which is unchanged.
    expect(w.get('[data-test="trial-meta"]').text()).toBe('Prompt v2, config 7f3a9c2, Hermes 6112c2a');
  });

  it('says a trial from before 7 Nov recorded no adapter code, and so for a missing platform commit', async () => {
    let w = mountWith({ trial: { adapter_sha256: null } });
    await settle();
    expect(w.get('[data-test="trial-code"]').text()).toBe('Adapter code not recorded (trials before 7 Nov), platform commit c4d2e19');
    expect(w.find('[data-test="adapter-code"]').exists()).toBe(false);
    expect(w.get('[data-test="adapter-code-missing"]').text()).toBe('not recorded (trials before 7 Nov)');
    w = mountWith({ trial: { adapter_sha256: null }, experiment: { platform_commit: null } });
    await settle();
    expect(w.get('[data-test="trial-code"]').text()).toBe('Adapter code not recorded (trials before 7 Nov), platform commit not recorded');
    // An attempt not claimed yet ran no code: only the platform commit is named.
    w = mountWith({ trial: { adapter_sha256: null, status: 'queued', timing: { ...trial.timing, claimed_at: null } } });
    await settle();
    expect(w.get('[data-test="trial-code"]').text()).toBe('Platform commit c4d2e19');
  });
});

describe('TrialView against the API: an attempt stopped on infra (U6)', () => {
  type Row = { id: string; status: string; label: string | null };
  const heldout = (details as unknown as Record<string, Record<string, unknown>>).exp_heldout;
  const rows = (experimentTrials as unknown as Record<string, Row[]>).exp_heldout;
  // The second repeat of fd-vs-sip-07 in arm B, attempt 1, abandoned: its worker went quiet.
  const abandoned = { ...trial, id: 'tr_fd-vs-sip-07_b_2', repeat_index: 1, attempt: 1, status: 'abandoned', label: null, end_state: null, grades: [], cause: null };
  function mountWith(siblings: Row[], status = 'done') {
    routeFetch({
      '/api/trials/tr_fd-vs-sip-07_b_2': abandoned,
      '/api/trials/tr_fd-vs-sip-07_b_2/spans': [],
      '/api/labels/queue?set=heldout': queue.heldout,
      '/api/experiments/exp_heldout': { ...heldout, status },
      '/api/experiments/exp_heldout/trials': siblings,
      '/api/prompts': prompts,
    });
    return mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_2' } });
  }
  const marked = rows.map((t) => (t.id === 'tr_fd-vs-sip-07_b_2' ? { ...t, status: 'abandoned', label: null } : t));

  it('counts an abandoned attempt as an infra failure, never "not graded yet", and names the re-run that passed', async () => {
    const w = mountWith(marked);
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Infra failure: its worker stopped sending heartbeats, not graded');
    const facts = w.get('[data-test="trial-facts"]').text();
    expect(facts).toContain('Counted asInfra failureIts worker stopped sending heartbeats; re-run as attempt 2, which passed');
    expect(facts).not.toContain('Not an infra failure');
    expect(w.text()).toContain('Infra failures are not graded: they say nothing about the agent.');
    expect(w.text()).not.toContain('Not graded yet');
  });

  it('says it was not re-run when a finished run has no next attempt, and not yet while the run goes on', async () => {
    const without = marked.filter((t) => t.id !== 'tr_fd-vs-sip-07_b_2_attempt2');
    let w = mountWith(without);
    await settle();
    expect(w.get('[data-test="trial-facts"]').text()).toContain('Its worker stopped sending heartbeats; not re-run');
    expect(w.get('[data-test="trial-facts"]').text()).not.toContain('not re-run yet');
    w = mountWith(without, 'running');
    await settle();
    expect(w.get('[data-test="trial-facts"]').text()).toContain('Its worker stopped sending heartbeats; not re-run yet');
  });
});

describe('TrialView against the API: the failure cause (D64)', () => {
  const heldout = (details as Record<string, unknown>).exp_heldout;
  function mountWith(cause: unknown, labels: unknown = queue.heldout, over: Record<string, unknown> = {}) {
    routeFetch({
      '/api/trials/tr_fd-vs-sip-07_b_3': { ...trial, cause, ...over },
      '/api/trials/tr_fd-vs-sip-07_b_3/spans': trialSpans,
      '/api/labels/queue?set=heldout': labels,
      '/api/experiments/exp_heldout': heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
    return mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
  }

  it('says why it failed under the checks it failed, with the reason and every other cause that fits', async () => {
    const w = mountWith({
      cause: 'wrong_tool',
      reason: 'fd_maturity was never called; calculate_emi was',
      contributing: [{ cause: 'unsupported_figure', reason: '₹7,10,870 has no tool result, client-file number or message behind it (1 of 4 figures)' }],
      rules_version: 'causes-1',
    });
    await settle();
    const cause = w.get('[data-test="trial-cause"]');
    expect(cause.get('p').text()).toBe('Why it failed: Wrong tool. fd_maturity was never called; calculate_emi was.');
    expect(cause.get('[data-test="trial-cause-also"]').text()).toBe('Also figure with no source: ₹7,10,870 has no tool result, client-file number or message behind it (1 of 4 figures).');
    expect(inOrderOf(w, '[data-test="failed-on"]', '[data-test="trial-cause"]')).toBe(true);
  });

  it('names the judge against your label as the cause while held-out outputs remain to label', async () => {
    const judgeVsLabel = { cause: 'judge_vs_label', reason: 'On fd-tax the judge said no and the human label says yes', contributing: [{ cause: 'other', reason: 'fd-tax failed' }], rules_version: 'causes-1' };
    const w = mountWith(judgeVsLabel);
    await settle();
    expect(w.get('[data-test="trial-cause-name"]').text()).toBe('Judge disagrees with your label');
    expect(w.get('[data-test="trial-cause"] p').text()).toBe('Why it failed: Judge disagrees with your label. On fd-tax the judge said no and the human label says yes.');
    expect(w.get('[data-test="trial-cause-also"]').text()).toBe('Also other: fd-tax failed.');
  });

  it('lists the judge against your label among the other causes too', async () => {
    const w = mountWith({
      cause: 'wrong_tool',
      reason: 'fd_maturity was never called; calculate_emi was',
      contributing: [{ cause: 'judge_vs_label', reason: 'On fd-tax the judge said no and the human label says yes' }],
      rules_version: 'causes-1',
    });
    await settle();
    expect(w.get('[data-test="trial-cause-also"]').text()).toBe('Also judge disagrees with your label: On fd-tax the judge said no and the human label says yes.');
  });

  it('says why a trial stopped short even when its checks passed, and shows nothing for a trial with no cause', async () => {
    const steps = { cause: 'ran_out_of_steps', reason: 'Stopped at the step limit after 17 model calls (its limit is 15); Hermes asks for a summary at the limit, and that summary is the answer that was graded', contributing: [], rules_version: 'causes-1' };
    let w = mountWith(steps, queue.heldout, { grades: trial.grades.map((g) => ({ ...g, verdict: 'pass' })), end_state: 'step_limit' });
    await settle();
    expect(w.get('[data-test="trial-cause"]').text()).toMatch(/^Why it stopped short: Ran out of steps\. Stopped at the step limit after 17 model calls/);
    w = mountWith(null);
    await settle();
    expect(w.find('[data-test="trial-cause"]').exists()).toBe(false);
  });
});

/** The second element comes after the first in the document. */
function inOrderOf(w: ReturnType<typeof mount>, first: string, second: string): boolean {
  return !!(w.get(first).element.compareDocumentPosition(w.get(second).element) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('TrialView against the folder-based endpoints', () => {
  it('still reads a gate run from GET /trials/:id and /spans in the folder store shape', async () => {
    const summary = {
      trialId: 'gate-1', harness: 'ownloop', model: 'fake/x', taskId: 'emi-basic-01', configHash: null, promptVersion: 'v1', toolsetVersion: '1',
      label: 'agent', endState: 'answered', startedAt: null, wallS: 0.8, proxyCalls: 2, proxyCostUsd: 0.0026, proxyInputTokens: 2410, proxyOutputTokens: 96,
      proxyComplete: true, harnessCalls: 2, toolCalls: 1, toolErrors: 0, malformedToolCalls: 0, agentTurns: 1, clientTurns: 0,
    };
    const span = (id: string, parent: string | null, name: string, start: number, end: number, attributes = {}) => ({
      spanId: id, parentSpanId: parent, name, kind: 1, startNs: String(start * 1_000_000), endNs: String(end * 1_000_000), statusCode: 1, statusMessage: null, attributes, events: [],
    });
    const { calls } = routeFetch({
      '/api/trials/gate-1': {
        summary,
        spec: null,
        result: { conversation: { transcript: [{ role: 'user', content: 'EMI?', source: 'task' }, { role: 'assistant', content: 'Rs 8,997.26.', source: 'agent' }] }, counts: { model_calls: 2 } },
        report: null,
      },
      '/api/trials/gate-1/spans': [
        span('a', null, 'invoke_agent ownloop', 0, 800),
        span('b', 'a', 'agent.turn', 10, 700),
        span('c', 'b', 'chat fake/x', 20, 100, { 'evals.role': 'agent' }),
        span('d', 'b', 'execute_tool calculate_emi', 110, 120, { 'gen_ai.tool.name': 'calculate_emi', 'evals.tool.arguments': '{"principal": 1000000}', 'evals.tool.result': '{"emi": "8997.26"}' }),
      ],
    });
    const w = mount(TrialView, { props: { trialId: 'gate-1' } });
    await settle();
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(['/api/trials/gate-1', '/api/trials/gate-1/spans']));
    expect(w.get('[data-test="trial-title"]').text()).toBe('Own loop on emi-basic-01');
    expect(w.findAll('[data-test="message"]')).toHaveLength(2);
    expect(w.get('[data-test="tool-call"]').text()).toContain('calculate_emi');
    expect(w.get('[data-test="trial-files"] a').attributes('href')).toBe('/api/trials/gate-1/files/result.json');
  });
});

describe('TrialView against the API: memory and skills (brief item 6)', () => {
  type Detail = Record<string, unknown>;
  const heldout = (details as unknown as Record<string, Detail>).exp_heldout;
  const on = { value: { enabled: true }, source: 'config' };
  const ev = (name: string, at: string, attrs: Record<string, string>) => ({
    name,
    timeUnixNano: at,
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: v } })),
  });
  function mountWith(memorySkillsOn: boolean, events: unknown[]) {
    const [root, ...rest] = trialSpans as unknown as Record<string, unknown>[];
    const applied = { ...trial.result.applied_settings, ...(memorySkillsOn ? { memory: on, skills: on } : {}) };
    routeFetch({
      '/api/trials/tr_fd-vs-sip-07_b_3': { ...trial, result: { ...trial.result, applied_settings: applied } },
      '/api/trials/tr_fd-vs-sip-07_b_3/spans': [{ ...root, events }, ...rest],
      '/api/labels/queue?set=heldout': queue.heldout,
      '/api/experiments/exp_heldout': heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/prompts': prompts,
    });
    return mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
  }

  it('lists what was read from memory, written to it and which skills were loaded, in time order', async () => {
    const w = mountWith(true, [
      ev('evals.skill.load', '1793878280000000000', { 'evals.skill.name': 'emi-playbook' }),
      ev('evals.memory.read', '1793878273000000000', { 'evals.memory.target': 'memory', 'evals.memory.entries': '2', 'evals.memory.content': 'Salary on the 1st.\n§\nNo new loans.' }),
      ev('evals.memory.write', '1793878290000000000', { 'evals.memory.target': 'user', 'evals.memory.action': 'add', 'evals.memory.content': 'Prefers EMIs under Rs 20,000.' }),
      ev('evals.compression', '1793878291000000000', {}),
    ]);
    await settle();
    const items = w.get('[data-test="memory-skills"]').findAll('li');
    expect(items.map((i) => i.get('.memory-skills__title').text())).toEqual([
      'Memory read into the prompt at the start: 2 entries',
      'Skill loaded: emi-playbook',
      'Memory written (user profile): add',
    ]);
    expect(items[0].get('.memory-skills__detail').text()).toBe('Salary on the 1st.\n§\nNo new loans.');
    expect(w.text()).toContain('Memory events: 2. Skill events: 1. They are listed under Memory and skills.');
  });

  it('says so when memory or skills were on but nothing was read, written or loaded', async () => {
    const w = mountWith(true, []);
    await settle();
    expect(w.get('[data-test="memory-skills"]').text()).toContain('Memory or skills were on, but the agent read no memory and loaded or wrote no skill.');
  });

  it('shows no such section when both are off', async () => {
    const w = mountWith(false, []);
    await settle();
    expect(w.find('[data-test="memory-skills"]').exists()).toBe(false);
    expect(w.text()).toContain('No memory was read or written and no skills were loaded: both are off in this config.');
  });
});
