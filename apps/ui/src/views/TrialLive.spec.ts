/**
 * The Trial page on the headline's real trials, as the live API returned them on 7 Nov (trimmed
 * GET responses in test/live-trials.json): what browser QA found wrong that day, and how it reads
 * now. No human label is copied; a test that needs one adds a synthetic one and says so.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import live from '../test/live-trials.json';
import { routeFetch, settle } from '../test/helpers';
import TrialView from './TrialView.vue';

/** ₹5,500 has no source; months-with-extra failed on a regex; the judge passed it (optional). */
const PHONE = 't_0mw38a1yn845728704a225ae4';
/** The judge's optional overall failed; its only quote is for asks-deciding-fact, answered yes. */
const OFFER = 't_0mw38a1yo6a7e2cbbf94d52f9';

type Trial = (typeof live.trials)[keyof typeof live.trials];
const EXP = live.experiment.id;

function mountLive(id: keyof typeof live.trials, over: { trial?: Partial<Record<keyof Trial, unknown>>; trust?: unknown } = {}) {
  const spans = (live.spans as Record<string, unknown[]>)[id] ?? [];
  const checks = (live.checks as Record<string, unknown>)[id];
  const routes = routeFetch({
    [`/api/trials/${id}`]: { ...live.trials[id], ...over.trial },
    [`/api/trials/${id}/spans`]: spans,
    ...(checks ? { [`/api/trials/${id}/files/checks.json`]: checks } : {}),
    [`/api/experiments/${EXP}`]: live.experiment,
    [`/api/experiments/${EXP}/trials`]: [],
    [`/api/judge/trust?experiment=${EXP}`]: over.trust ?? live.trust,
    '/api/prompts': [],
  });
  return { w: mount(TrialView, { props: { trialId: id } }), ...routes };
}

describe('TrialView on live trials: files', () => {
  it('counts the model requests, not their request and response files together', async () => {
    const { w } = mountLive(OFFER);
    await settle();
    const requests = w.get('[data-test="model-requests"]');
    // 22 calls, each stored as a request and a response.
    expect(live.trials[OFFER].files.filter((f) => f.path.startsWith('artifacts/proxy/'))).toHaveLength(44);
    expect(requests.get('summary').text()).toBe('Model requests (22)');
    const rows = requests.findAll('[data-test="model-call"]');
    expect(rows).toHaveLength(22);
    expect(rows[0].text()).toBe('artifacts/proxy/0001.request.json, response');
    expect(rows[0].findAll('a').map((a) => a.attributes('href'))).toEqual([
      `/api/trials/${OFFER}/files/artifacts/proxy/0001.request.json`,
      `/api/trials/${OFFER}/files/artifacts/proxy/0001.response.json`,
    ]);
    // The other files are listed apart, as before.
    expect(w.get('[data-test="trial-files"]').text()).toContain('checks.json');
  });
});

const gradeNamed = (w: ReturnType<typeof mountLive>['w'], name: string) => {
  const g = w.findAll('[data-test="grade"]').find((x) => x.find('.grade-head .strong').text() === name);
  if (!g) throw new Error(`no grade ${name}`);
  return g;
};

describe('TrialView on live trials: the outcome and the optional judge', () => {
  it('counts required checks in the header and tags the optional judge as not counted', async () => {
    // Trial 1 of the same task and arm: every required check passed; the optional judge failed.
    const { w } = mountLive(OFFER, { trial: { grades: live.grades.t_0mw38a1ynef3e074be7a32d88 } });
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Passed all 3 required checks');
    const grades = w.findAll('[data-test="grade"]');
    expect(grades).toHaveLength(4);
    expect(grades.map((g) => g.find('[data-test="grade-optional"]').exists())).toEqual([false, false, false, true]);
    const judge = gradeNamed(w, 'overall');
    expect(judge.get('[data-test="grade-optional"]').text()).toBe('optional, not counted');
    // Its Fail is outlined: it did not fail the trial.
    expect(judge.get('[data-test="grade-verdict"]').text()).toBe('Fail');
    expect(judge.get('[data-test="grade-verdict"]').classes()).toContain('pill--outline');
    expect(judge.get('[data-test="grade-verdict"]').classes()).not.toContain('pill--fail');
    expect(w.find('[data-test="failed-on"]').exists()).toBe(false);
  });

  it('says how many required checks failed, and names only those', async () => {
    const { w } = mountLive(OFFER);
    await settle();
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed 1 of 3 required checks');
    expect(w.get('[data-test="failed-on"]').text()).toBe('Failed on: every-amount-from-a-tool');
    expect(gradeNamed(w, 'every-amount-from-a-tool').get('[data-test="grade-verdict"]').classes()).toContain('pill--fail');
  });
});

describe("TrialView on live trials: the judge's answers", () => {
  it('shows each quote under its own question and answer, with the reason the judge gave for it', async () => {
    const { w } = mountLive(OFFER);
    await settle();
    const judge = gradeNamed(w, 'overall');
    expect(judge.get('[data-test="grade-kind"]').text()).toBe('Judge gemini-3.8-flash, rubric advice.v4, grader version 6e96644');
    const rows = judge.findAll('[data-test="judge-criterion"]');
    expect(rows.map((r) => [r.get('.mono').text(), r.get('[data-test="criterion-answer"]').text()])).toEqual([
      ['overall', ', answered no'],
      ['explains-plainly', ', answered no'],
      ['asks-deciding-fact', ', answered yes'],
    ]);
    // overall quoted nothing; the one quote is asks-deciding-fact's, under its yes.
    expect(rows[0].find('[data-test="grade-quote"]').exists()).toBe(false);
    expect(rows[1].find('[data-test="grade-quote"]').exists()).toBe(false);
    expect(rows[2].get('[data-test="grade-quote"]').text()).toMatch(/^“Before you decide, please send me the offer's:/);
    expect(judge.findAll('[data-test="grade-quote"]')).toHaveLength(1);
    // Each question's reason, in the judge's words.
    expect(rows.map((r) => r.get('[data-test="criterion-reason"]').text())).toEqual([
      "The advisor assumed a lower loan amount of ₹84,250 instead of clarifying the client's ₹1 lakh figure, leading to confusing comparisons and shifting fee calculations.",
      'The advisor created confusion by repeatedly switching between the ₹84,250 and ₹1 lakh loan balances and introducing assumed fee adjustments without explaining them plainly.',
      'The advisor explicitly asked for the loan amount, interest rate, tenure, and upfront charges before proceeding.',
    ]);
  });

  it('never highlights a quote the judge gave for a "yes" as evidence of a failure', async () => {
    const { w } = mountLive(OFFER);
    await settle();
    const marked = w.findAll('[data-test="quote-link"]').map((q) => q.text());
    expect(marked.some((t) => t.includes('Before you decide'))).toBe(false);
    expect(marked.some((t) => t.includes('for overall'))).toBe(false);
  });

  it('says when the grader did not find a quote word for word', async () => {
    const { w } = mountLive(PHONE);
    await settle();
    const buffer = gradeNamed(w, 'overall')
      .findAll('[data-test="judge-criterion"]')
      .find((r) => r.get('.mono').text() === 'keeps-buffer');
    expect(buffer?.get('[data-test="grade-quote"]').text()).toMatch(/^“Keep the ₹2,000 savings transfer for now\./);
    expect(buffer?.get('[data-test="quote-not-found"]').text()).toBe('The grader did not find this quote word for word in the conversation.');
  });
});

describe('TrialView on live trials: why it failed', () => {
  it('keeps the header short, never cut inside a pattern, and the full reason with its patterns in the card', async () => {
    const { w } = mountLive(PHONE);
    await settle();
    const cause = w.get('[data-test="trial-cause"]');
    expect(cause.get('p').text()).toBe('Why it failed: Figure with no source. ₹5,500 has no tool result, client-file number or message behind it (1 of 68 figures).');
    expect(cause.get('[data-test="trial-cause-also"]').text()).toBe(
      'Also wrong answer: months-with-extra failed, though list_debts and debt_payoff_plan were called: 2 number(s) within ±0 of 12, but none next to a month word.',
    );
    expect(cause.text()).not.toContain('/');
    const reason = gradeNamed(w, 'months-with-extra').get('[data-test="grade-reason"]');
    expect(reason.text()).toBe(live.trials[PHONE].grades.find((g) => g.grader_id === 'months-with-extra')?.reason);
    expect(reason.findAll('[data-test="reason-pattern"]').map((p) => p.text())).toEqual([
      '/months?\\b|mos?\\b|EMIs?\\b|instal?l?ments?\\b/',
      '/\\bmonths?(?:\\s+(?:down\\s+|drops?\\s+|falls?\\s+)?to)?|\\bmonths?\\b[^\\n|]*\\|(?:[^\\n|]*\\|)*?/',
    ]);
  });
});

describe('TrialView on live trials: tool calls', () => {
  it("shows a tool's result as laid-out JSON, never as an escaped string", async () => {
    const { w } = mountLive(PHONE);
    await settle();
    const call = w.findAll('[data-test="tool-call"]').find((t) => t.get('summary .mono').text() === 'list_debts');
    if (!call) throw new Error('no list_debts call');
    const [args, result] = call.findAll('pre.code-block').map((p) => p.text());
    expect(args).toBe('{}');
    expect(result).not.toContain('\\"');
    expect(result.startsWith('{\n  "result": {\n    "client_on_file": true,')).toBe(true);
    // The tool's numbers as it wrote them, two decimals and all.
    expect(result).toContain('"total_balance": 111637.62,');
    expect(result).toContain('"lender": "Tungabhadra Finance (fictional)",');
  });
});
