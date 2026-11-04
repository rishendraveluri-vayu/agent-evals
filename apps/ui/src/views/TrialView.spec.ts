import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import TrialView from './TrialView.vue';

describe('TrialView in fixture mode', () => {
  useFixtures();

  it('leads with the arm, the trial and the outcome in words', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    expect(w.get('[data-test="trial-title"]').text()).toBe('Arm B, trial 3 of 5');
    expect(w.get('[data-test="trial-outcome"]').text()).toBe('Failed: 2 of 3 checks passed');
    const facts = w.get('[data-test="trial-facts"]').text();
    expect(facts).toContain('Agent answered');
    expect(facts).toContain('5.4 s of it start-up');
    expect(facts).toContain('$0.18');
    expect(facts).toContain('3 agent, 1 client');
    expect(facts).toContain('19,240');
  });

  it('puts the tool calls before the reply and marks what the failed check quoted', async () => {
    const w = mount(TrialView, { props: { trialId: 'tr_fd-vs-sip-07_b_3' } });
    await settle();
    const names = w.findAll('[data-test="tool-call"] summary .mono').map((n) => n.text());
    expect(names).toEqual(['get_client_profile', 'fd_maturity', 'sip_future_value']);
    const messages = w.findAll('[data-test="message"]');
    expect(messages.map((m) => m.find('.bubble-who').text())).toEqual(['Client', 'Agent']);
    expect(messages[1].get('mark').text()).toBe('an FD is the safer choice. ₹5 lakh at 7.1% grows to about ₹7,10,870');
    const grades = w.findAll('[data-test="grade"]');
    expect(grades).toHaveLength(3);
    expect(grades[1].text()).toContain('Accounts for tax on FD interest');
    expect(grades[1].text()).toContain('Fail');
    expect(grades[1].text()).toContain('Judge, rubric v3');
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

  it('says plainly when the sample data has no such trial', async () => {
    const w = mount(TrialView, { props: { trialId: 'nope' } });
    await settle();
    expect(w.get('[data-test="load-error"]').text()).toContain('No sample data for trial nope');
  });
});

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
