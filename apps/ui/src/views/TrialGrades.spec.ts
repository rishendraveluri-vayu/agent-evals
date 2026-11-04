/** The Trial page's grades (SP4 shape) and number check (checks.json), against a stubbed API. */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import prompts from '../fixtures/prompts.json';
import checks from '../fixtures/trial-checks.json';
import trialSpans from '../fixtures/trial-spans.json';
import trial from '../fixtures/trial.json';
import { provenanceOf } from '../lib/grading';
import { routeFetch, settle } from '../test/helpers';
import TrialView from './TrialView.vue';

const ID = 'tr_fd-vs-sip-07_b_3';
type Over = { grades?: unknown[]; grading?: unknown; checks?: unknown; files?: { path: string; bytes: number; sha256: string; ok: boolean }[] };
function mountWith(over: Over = {}) {
  const files = over.files ?? trial.files;
  routeFetch({
    [`/api/trials/${ID}`]: { ...trial, grades: over.grades ?? trial.grades, grading: over.grading ?? trial.grading, files },
    [`/api/trials/${ID}/spans`]: trialSpans,
    [`/api/trials/${ID}/files/checks.json`]: over.checks ?? checks,
    '/api/judge/agreement?set=heldout': null,
    // Nothing still to label, so the judge's reasons show.
    '/api/labels/queue?set=heldout': [],
    '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
    '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
    '/api/prompts': prompts,
  });
  return mount(TrialView, { props: { trialId: ID } });
}

describe('TrialView grades', () => {
  it('shows each grade with its verdict, its reason and its quoted evidence, and the outcome by required checks', async () => {
    const w = mountWith();
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed 1 of 3 checks');
    const grades = w.findAll('[data-test="grade"]');
    expect(grades).toHaveLength(3);
    expect(grades.map((g) => g.get('[data-test="grade-verdict"]').text())).toEqual(['Pass', 'Fail', 'Pass']);
    expect(grades[0].get('[data-test="grade-reason"]').text()).toBe('found ₹7,10,870, within ±1 of 710870 (fd_maturity maturity_rupees)');
    // A quote from a tool result is listed with its source; one from the answer is quoted there.
    expect(grades[0].get('[data-test="grade-evidence"]').text()).toBe('From fd_maturity\'s result"maturity_rupees": 710870');
    expect(grades[0].get('[data-test="grade-quote"]').text()).toBe('“₹7,10,870”');
    expect(grades[1].get('[data-test="grade-reason"]').text()).toContain('The profile shows a 30% slab');
    expect(grades[1].get('[data-test="grade-quote"]').text()).toBe('“an FD is the safer choice. ₹5 lakh at 7.1% grows to about ₹7,10,870”');
    // Only the failed check's quote is highlighted in the reply.
    expect(w.findAll('[data-test="quote-link"]')).toHaveLength(1);
  });

  it('says a trial is incomplete, never passed, when a required check could not decide', async () => {
    const [first, second, third] = trial.grades;
    const w = mountWith({
      grades: [
        { ...first, verdict: 'pass' },
        { ...second, verdict: 'not_implemented', score: null, reason: 'the judge is not built yet (SP5)', evidence: [] },
        { ...third, verdict: 'error', score: null, reason: 'unit_test timed out after 10 s', evidence: [] },
      ],
    });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Incomplete: 2 of 3 checks undecided');
    const verdicts = w.findAll('[data-test="grade-verdict"]').map((v) => v.text());
    expect(verdicts).toEqual(['Pass', 'Not built yet', 'Grader error']);
    expect(w.findAll('[data-test="grade"]')[2].get('[data-test="grade-reason"]').text()).toBe('unit_test timed out after 10 s');
    // Neither green nor red for a check that did not decide.
    expect(w.findAll('[data-test="grade-verdict"]')[1].classes()).toContain('pill--outline');
  });

  it('leaves a check that is not required out of the outcome, and says so', async () => {
    const [first, second] = trial.grades;
    const w = mountWith({ grades: [{ ...first, verdict: 'pass' }, { ...second, required: false, kind: 'state', type: 'regex_absent', judge_model: null, verdict: 'fail' }] });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Passed its one check');
    expect(w.findAll('[data-test="grade-kind"]')[1].text()).toBe('State check, regex absent, not required');
  });

  it('says "not graded yet", and that grading is queued when it is', async () => {
    let w = mountWith({ grades: [], grading: { current: null, pending: null } });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Not graded yet');
    expect(w.get('[data-test="not-graded"]').text()).toBe('Not graded yet. Grading runs as its own step after the trial.');
    const pending = { ...trial.grading.current, status: 'queued', passed: null, outcome: null, graded_at: null };
    w = mountWith({ grades: [], grading: { current: null, pending } });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Grading queued');
    expect(w.get('[data-test="not-graded"]').text()).toContain('Grading is queued');
  });
});

describe('TrialView number check', () => {
  it('highlights in the answer each amount no tool result or client message supports, and counts them', async () => {
    const w = mountWith();
    await settle();
    const marks = w.findAll('[data-test="unsupported-amount"]');
    expect(marks.map((m) => m.text())).toEqual(['Amount with no source found: ₹4 lakh', 'Amount with no source found: ₹1 lakh']);
    expect(w.get('[data-test="amount-key"]').text()).toContain('amounts the number check found no source for');
    const check = w.get('[data-test="number-check"]');
    expect(check.text()).toContain('2 of 8 amounts in the answer come from no tool result and not from the client’s own words.'.replace('’', "'"));
    expect(check.findAll('[data-test="unsupported-list"] li').map((li) => li.text())).toEqual(['₹4 lakh no source found', '₹1 lakh no source found']);
  });

  it('says every amount has a source when the check found none without', async () => {
    const w = mountWith({ checks: { number_provenance: { unsupported: [], total: 5 } } });
    await settle();
    expect(w.get('[data-test="number-check"]').text()).toContain('Every amount (5) in the answer comes from a tool result');
    expect(w.find('[data-test="unsupported-amount"]').exists()).toBe(false);
  });

  it('says there is no number check yet when the trial has no checks.json', async () => {
    const w = mountWith({ files: trial.files.filter((f) => f.path !== 'checks.json') });
    await settle();
    expect(w.find('[data-test="number-check"]').exists()).toBe(false);
    expect(w.get('[data-test="no-number-check"]').text()).toBe('No number check for this trial yet: it comes with grading (checks.json).');
  });

  it('reads each checks.json shape the provenance grader reads (A14)', () => {
    expect(provenanceOf({ number_provenance: { unsupported: [{ text: '₹11.59 lakh', value: 1159000 }] } })?.unsupported.map((a) => a.text)).toEqual(['₹11.59 lakh']);
    expect(provenanceOf({ checks: [{ id: 'number_provenance', unsupported: ['₹11.59 lakh'] }] })?.unsupportedCount).toBe(1);
    expect(provenanceOf({ number_provenance: { unsupported_count: 0 } })).toMatchObject({ unsupportedCount: 0, amounts: [] });
    expect(provenanceOf({ something_else: true })).toBeNull();
  });
});
