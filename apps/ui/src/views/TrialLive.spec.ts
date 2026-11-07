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
