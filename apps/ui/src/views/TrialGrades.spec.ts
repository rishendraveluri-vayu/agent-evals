/** The Trial page's grades (SP4 shape) and number check (checks.json), against a stubbed API. */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import prompts from '../fixtures/prompts.json';
import trustJson from '../fixtures/judge-trust.json';
import queue from '../fixtures/label-queue.json';
import checks from '../fixtures/trial-checks.json';
import trialSpans from '../fixtures/trial-spans.json';
import trial from '../fixtures/trial.json';
import { provenanceOf } from '../lib/grading';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import TrialView from './TrialView.vue';

const ID = 'tr_fd-vs-sip-07_b_3';
type Over = {
  grades?: unknown[];
  grading?: unknown;
  checks?: unknown;
  files?: { path: string; bytes: number; sha256: string; ok: boolean }[];
  result?: Record<string, unknown>;
  experiment?: Record<string, unknown>;
  /** GET /judge/trust?experiment=exp_heldout's judges; not served when left out. */
  trust?: unknown[];
  queue?: unknown[];
  task?: Record<string, unknown>;
};
function mountWith(over: Over = {}) {
  const files = over.files ?? trial.files;
  routeFetch({
    [`/api/trials/${ID}`]: { ...trial, grades: over.grades ?? trial.grades, grading: over.grading ?? trial.grading, files, result: over.result ?? trial.result, task: { ...trial.task, ...over.task } },
    [`/api/trials/${ID}/spans`]: trialSpans,
    [`/api/trials/${ID}/files/checks.json`]: over.checks ?? checks,
    '/api/judge/agreement?set=heldout': null,
    // Nothing still to label, so the judge's reasons show.
    '/api/labels/queue?set=heldout': over.queue ?? [],
    ...(over.trust ? { '/api/judge/trust?experiment=exp_heldout': { ...trustJson, judges: over.trust } } : {}),
    '/api/experiments/exp_heldout': over.experiment ?? (details as Record<string, unknown>).exp_heldout,
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
    expect(verdicts).toEqual(['Pass', 'Not judged', 'Grader error']);
    expect(w.findAll('[data-test="grade"]')[2].get('[data-test="grade-reason"]').text()).toBe('unit_test timed out after 10 s');
    // Neither green nor red for a check that did not decide.
    expect(w.findAll('[data-test="grade-verdict"]')[1].classes()).toContain('pill--outline');
  });

  it('points a judge check that was never judged to the judge panel, in plain words', async () => {
    const [first, second] = trial.grades;
    const reason = 'judging is not approved for this experiment (R8), so the judge was not called and nothing was spent; approve it with a model and budget, then regrade';
    const w = mountWith({ grades: [{ ...first, verdict: 'pass' }, { ...second, verdict: 'not_implemented', score: null, reason, evidence: [] }] });
    await settle();
    const grade = w.findAll('[data-test="grade"]')[1];
    expect(grade.get('[data-test="grade-verdict"]').text()).toBe('Not judged');
    const words = grade.get('[data-test="not-judged"]');
    expect(words.text()).toBe(
      "Not judged: judging is not approved for this experiment, so the judge was not called and nothing was spent. Approving it is a paid step, on the comparison page's judge panel; the regrade that follows fills this in.",
    );
    expect(words.get('a').attributes('href')).toBe('#/experiments/exp_heldout?panel=judge');
    expect(grade.text()).not.toContain('R8');
    expect(grade.find('[data-test="grade-reason"]').exists()).toBe(false);
  });

  it('lists every failed check with a comma straight after each, never a space before it', async () => {
    const [first, second] = trial.grades;
    const w = mountWith({ grades: [{ ...first, verdict: 'fail' }, { ...second, verdict: 'fail' }] });
    await settle();
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: fd-maturity, fd-tax (judge)');
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

  it('says there is no number check when the trial has no checks.json, and why, never that grading brings one', async () => {
    const w = mountWith({ files: trial.files.filter((f) => f.path !== 'checks.json') });
    await settle();
    expect(w.find('[data-test="number-check"]').exists()).toBe(false);
    expect(w.get('[data-test="no-number-check"]').text()).toBe(
      'No number check: this trial has no checks.json. The runner writes one after each trial; trials from before it did, and any whose check failed, have none.',
    );
  });

  it("reads the runner's checks.json (contract v2), as every trial since 4 Nov has it", async () => {
    // As evals_adapter.checks writes it: every amount with where it was found, and the count.
    const v2 = {
      contract_version: '2',
      trial_id: ID,
      amounts: [
        { turn: 0, text: '₹7,10,870', value: 710870, supported_by: 'tool', match: { value: 710870.12, where: 'tool:fd_maturity', how: 'rounded', precision: 1 } },
        { turn: 0, text: '₹5 lakh', value: 500000, supported_by: 'user', match: { value: 500000, where: 'task:0', how: 'exact', precision: 100000 } },
        { turn: 0, text: '₹4 lakh', value: 400000, supported_by: null, match: null },
        // Since checks 0.5.0 (review G3) the simulated client's words are their own kind.
        { turn: 1, text: '₹3,000', value: 3000, supported_by: 'client_sim', match: { value: 3000, where: 'client_sim:1', how: 'exact', precision: 1 } },
      ],
      unsupported: 1,
      tools_called: ['get_client_profile', 'fd_maturity'],
      required_tools: null,
    };
    const w = mountWith({ checks: v2 });
    await settle();
    expect(w.find('[data-test="no-number-check"]').exists()).toBe(false);
    const check = w.get('[data-test="number-check"]');
    expect(check.text()).toContain("1 of 4 amounts in the answer comes from no tool result and not from the client's own words.");
    expect(check.text()).toContain("₹3,000 from the simulated client's message");
    expect(check.findAll('[data-test="unsupported-list"] li').map((li) => li.text())).toEqual(['₹4 lakh no source found']);
    expect(check.text()).toContain("₹7,10,870 from fd_maturity's result");
    expect(check.text()).toContain("₹5 lakh from the client's message");
    expect(w.findAll('[data-test="unsupported-amount"]').map((m) => m.text())).toEqual(['Amount with no source found: ₹4 lakh']);
    expect(w.find('[data-test="unsupported-note"]').exists()).toBe(false);
  });

  it('says why an amount from an arithmetic tool does not count (D56)', async () => {
    // As the runner writes it since D56: add's inputs came from list_debts, round's did not.
    const d56 = {
      contract_version: '2',
      trial_id: ID,
      amounts: [
        { turn: 0, text: '₹23,120', value: 23120, supported_by: 'tool', match: { value: 23120, where: 'tool:add', how: 'exact', precision: 1, call: 1 }, rejected: null },
        {
          turn: 0,
          text: '₹3,000',
          value: 3000,
          supported_by: null,
          match: null,
          rejected: { value: 3000, where: 'tool:round', how: 'exact', precision: 1, call: 2, reason: "round's input 2,950 is not supported" },
        },
      ],
      unsupported: 1,
      tools_called: ['list_debts', 'add', 'round'],
      required_tools: null,
      arithmetic: [],
    };
    const w = mountWith({ checks: d56 });
    await settle();
    const check = w.get('[data-test="number-check"]');
    expect(check.findAll('[data-test="unsupported-list"] li').map((li) => li.text())).toEqual([
      "₹3,000 no source found: it matches round's result, but round's input 2,950 is not supported",
    ]);
    expect(check.text()).toContain("₹23,120 from add's result");
    expect(provenanceOf(d56)?.amounts.map((a) => a.note)).toEqual([null, "it matches round's result, but round's input 2,950 is not supported"]);
  });

  it('says when checks.json is there but cannot be read', async () => {
    const w = mountWith({ checks: { contract_version: '3', something: 'else' } });
    await settle();
    expect(w.get('[data-test="no-number-check"]').text()).toBe('No number check shown: this trial’s checks.json could not be read.');
  });

  it('reads each checks.json shape the provenance grader reads (A14)', () => {
    expect(provenanceOf({ number_provenance: { unsupported: [{ text: '₹11.59 lakh', value: 1159000 }] } })?.unsupported.map((a) => a.text)).toEqual(['₹11.59 lakh']);
    expect(provenanceOf({ checks: [{ id: 'number_provenance', unsupported: ['₹11.59 lakh'] }] })?.unsupportedCount).toBe(1);
    expect(provenanceOf({ number_provenance: { unsupported_count: 0 } })).toMatchObject({ unsupportedCount: 0, amounts: [] });
    expect(provenanceOf({ something_else: true })).toBeNull();
    // Contract v2: no amounts at all is an answer too, with a total of 0.
    expect(provenanceOf({ contract_version: '2', trial_id: 't', amounts: [], unsupported: 0, tools_called: [], required_tools: null })).toMatchObject({ total: 0, unsupportedCount: 0 });
  });
});

describe('TrialView: an agent reply as the model wrote it', () => {
  const reply = (content: string) => ({
    ...trial.result,
    conversation: { ...trial.result.conversation, transcript: [trial.result.conversation.transcript[0], { role: 'assistant', content, source: 'agent' }] },
  });

  it('shows its Markdown as bold, italics and bullets, never the asterisks', async () => {
    const w = mountWith({ grades: [], checks: {}, result: reply('To run the numbers, could you share:\n\n1. **Loan terms:** the rate and *tenure*.\n- **Monthly income**, and any EMIs.\n\nUse mcp__finance__list_debts and 5 * 3 as written.') });
    await settle();
    const agent = w.findAll('[data-test="message"]')[1];
    expect(agent.text()).not.toContain('**');
    expect(agent.findAll('strong').map((b) => b.text())).toEqual(['Loan terms:', 'Monthly income']);
    expect(agent.get('em').text()).toBe('tenure');
    expect(agent.text()).toContain('• Monthly income, and any EMIs.');
    expect(agent.text()).toContain('1. Loan terms: the rate and tenure.');
    // Underscores inside a name and a lone asterisk are left as written.
    expect(agent.text()).toContain('Use mcp__finance__list_debts and 5 * 3 as written.');
  });

  it('keeps any markup in a reply as text: nothing it holds becomes an element', async () => {
    const evil = '**<script>alert(1)</script>** and <img src=x onerror="alert(2)"> and *<b>bold?</b>*';
    const w = mountWith({ grades: [], checks: {}, result: reply(evil) });
    await settle();
    const agent = w.findAll('[data-test="message"]')[1];
    expect(agent.find('script').exists()).toBe(false);
    expect(agent.find('img').exists()).toBe(false);
    expect(agent.find('b').exists()).toBe(false);
    expect(agent.get('strong').text()).toBe('<script>alert(1)</script>');
    expect(agent.get('em').text()).toBe('<b>bold?</b>');
    expect(agent.text()).toContain('<img src=x onerror="alert(2)">');
  });
});

describe('TrialView: the facts around a trial, as the live API gives them', () => {
  it('gives the timeout its unit, and drops a decision-log label from what the adapter observed', async () => {
    const applied = { ...trial.result.applied_settings, timeout_s: { value: 420, source: 'config' }, api_max_retries: { value: 1, source: 'platform_default', observed: 'R10.11: one attempt' } };
    const w = mountWith({ result: { ...trial.result, applied_settings: applied } });
    await settle();
    const rows = w.findAll('[data-test="applied"] tr').map((r) => r.text());
    expect(rows.find((r) => r.startsWith('Timeout'))).toContain('420 s');
    const retries = w.get('[data-test="applied-source-api_max_retries"]').text();
    expect(retries).toBe('Platform default, one attempt');
  });

  it('names a harness arm once, with its pinned version', async () => {
    const detail = (details as Record<string, Record<string, unknown> & { configs: Record<string, unknown>[] }>).exp_heldout;
    // A harness experiment: arm A on the own loop, arm B (this trial's) on Hermes.
    const configs = detail.configs.map((c, i) => (i ? { ...c, prompt: detail.configs[0].prompt } : { ...c, harness: 'ownloop', harness_ref: '0.1.0' }));
    const w = mountWith({ experiment: { ...detail, axis: 'harness', configs } });
    await settle();
    expect(w.get('[data-test="trial-meta"]').text()).toBe('Hermes Agent 6112c2a, config 7f3a9c2');
  });

  it('never names two arms alike: with one harness in both, the arm is named by what does differ', async () => {
    const detail = (details as Record<string, Record<string, unknown>>).exp_heldout;
    const w = mountWith({ experiment: { ...detail, axis: 'harness' } });
    await settle();
    expect(w.get('[data-test="trial-meta"]').text()).toBe('Prompt finance-advisor v2, config 7f3a9c2, Hermes 6112c2a');
  });

  it('names a shipped example by its title, and sends no one to a judge panel it does not have', async () => {
    const detail = (details as Record<string, Record<string, unknown>>).exp_heldout;
    const example = { name: 'harness-ownloop-vs-hermes-haiku', title: 'Draft stand-in: own loop vs Hermes on Claude Haiku 5.5 (15 draft tasks, one trial each)', loaded_at: '2026-11-05T08:00:00.000Z' };
    const [first, second] = trial.grades;
    const reason = 'judging is not approved for this experiment (R8), so the judge was not called and nothing was spent';
    const w = mountWith({
      experiment: { ...detail, name: 'Label batch 1: open coding (R8, approved: 30 trials, cap $2)', example },
      grades: [{ ...first, verdict: 'pass' }, { ...second, verdict: 'not_implemented', score: null, reason, evidence: [] }],
    });
    await settle();
    expect(w.get('nav.crumbs').text()).toContain(example.title);
    expect(w.text()).not.toContain('Label batch 1');
    const words = w.get('[data-test="not-judged"]');
    expect(words.text()).toContain('judging does not apply to a shipped example');
    expect(words.find('a').exists()).toBe(false);
    expect(w.find('a[href*="panel=judge"]').exists()).toBe(false);
  });
});

/** D83: how far to trust the judge behind each judge check, matched by its model and its rubric. */
describe('TrialView judge trust', () => {
  const [haikuV4, , haikuV3] = trustJson.judges;
  const judgeOf = (w: ReturnType<typeof mountWith>, name: string) => {
    const g = w.findAll('[data-test="grade"]').find((x) => x.find('.grade-head .strong').text() === name);
    if (!g) throw new Error(`no grade ${name}`);
    return g;
  };

  describe('in fixture mode', () => {
    useFixtures();

    it("shows each question's trust badge beside the judge's answer, and links to the judge page", async () => {
      const w = mount(TrialView, { props: { trialId: ID } });
      await settle();
      const tax = judgeOf(w, 'fd-tax').get('[data-test="grade-trust"]');
      const rows = tax.findAll('[data-test="grade-trust-criterion"]');
      expect(rows.map((r) => [r.get('.mono').text(), r.get('[data-test="grade-trust-answer"]').text(), r.get('[data-test="trust-label"]').text()])).toEqual([['fd-tax', ', answered no', 'Trusted']]);
      expect(tax.get('[data-test="trust-badge"]').attributes('title')).toBe('Meets the trust bar on 30 held-out labels: its verdicts on this question can be relied on.');
      expect(tax.get('[data-test="grade-trust-link"]').attributes('href')).toBe('#/labels/judge');
      const horizon = judgeOf(w, 'horizon').get('[data-test="grade-trust"]');
      expect(horizon.get('[data-test="grade-trust-answer"]').text()).toBe(', answered yes');
      expect(horizon.get('[data-test="trust-label"]').text()).toBe('Too few labels');
      // A code-graded check has no judge, so no trust line.
      expect(judgeOf(w, 'fd-maturity').find('[data-test="grade-trust"]').exists()).toBe(false);
    });
  });

  describe('against the API', () => {
    it('tells two rubrics of one judge model apart by the rubric the grade records', async () => {
      const w = mountWith({ trust: [haikuV3, haikuV4] });
      await settle();
      expect(judgeOf(w, 'fd-tax').get('[data-test="trust-label"]').text()).toBe('Trusted');
    });

    it('shows no badge rather than a wrong one when the grade does not say which rubric it used', async () => {
      const [first, second, third] = trial.grades;
      const bare = (g: typeof second) => ({ ...g, evidence: (g.evidence as Record<string, unknown>[]).filter((e) => e.source !== 'judge_call') });
      const w = mountWith({ trust: [haikuV3, haikuV4], grades: [first, bare(second), bare(third)] });
      await settle();
      expect(w.find('[data-test="grade-trust"]').exists()).toBe(false);
    });

    it("finds the rubric in the task's grader spec when the grade does not carry it", async () => {
      const [first, second, third] = trial.grades;
      const bare = (g: typeof second) => ({ ...g, evidence: (g.evidence as Record<string, unknown>[]).filter((e) => e.source !== 'judge_call') });
      const detail = (details as Record<string, { tasks: { sha256: string; graders: unknown[] }[] }>).exp_heldout;
      const tasks = detail.tasks.map((t) => (t.sha256 === trial.task.sha256 ? { ...t, graders: [{ id: 'fd-tax', type: 'judge', rubric: { id: 'advice', version: 'v4' } }] } : t));
      const w = mountWith({ trust: [haikuV3, haikuV4], grades: [first, bare(second), bare(third)], experiment: { ...detail, tasks } });
      await settle();
      expect(judgeOf(w, 'fd-tax').get('[data-test="trust-label"]').text()).toBe('Trusted');
      expect(judgeOf(w, 'horizon').find('[data-test="grade-trust"]').exists()).toBe(false);
    });

    it("gives a check that was never judged the judge's own status, in plain words", async () => {
      const [first, second] = trial.grades;
      const reason = 'judging is not approved for this experiment, so the judge was not called and nothing was spent';
      const w = mountWith({ trust: [haikuV4], grades: [first, { ...second, verdict: 'not_implemented', score: null, reason, evidence: [], judge_model: null }] });
      await settle();
      const tax = judgeOf(w, 'fd-tax');
      expect(tax.find('[data-test="not-judged"]').exists()).toBe(true);
      const line = tax.get('[data-test="grade-trust-line"]');
      expect(line.get('[data-test="trust-label"]').text()).toBe('Not trusted');
      expect(line.text()).toContain('Tested on 40 held-out labels and it missed the trust bar: read its verdicts as a hint');
      expect(line.text()).not.toContain('D8');
      expect(tax.find('[data-test="grade-trust-criterion"]').exists()).toBe(false);
    });

    it("keeps the badges but not the judge's answers while the task's held-out outputs are still to label", async () => {
      const w = mountWith({ trust: [haikuV4], queue: queue.heldout, task: { id: 'distress-12' } });
      await settle();
      const tax = judgeOf(w, 'fd-tax');
      expect(tax.find('[data-test="hidden-reasons"]').exists()).toBe(true);
      expect(tax.get('[data-test="trust-label"]').text()).toBe('Trusted');
      expect(tax.find('[data-test="grade-trust-answer"]').exists()).toBe(false);
    });

    it('shows no trust line when the trust could not be read', async () => {
      const w = mountWith();
      await settle();
      expect(w.find('[data-test="grade-trust"]').exists()).toBe(false);
    });
  });
});
