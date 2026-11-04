import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { ExperimentDetail, ExperimentTrial } from '../api/types';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import RunView from './RunView.vue';

describe('RunView, setting up a run in fixture mode', () => {
  useFixtures();

  it('names each config first in the arm pickers, then its short hash', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    const selected = (sel: string) => (w.get(sel).element as HTMLSelectElement).selectedOptions[0]?.text;
    expect(selected('[data-test="arm-a"]')).toBe('Prompt v1 on Hermes · 3b81e04');
    expect(selected('[data-test="arm-b"]')).toBe('Prompt v2 on Hermes · 7f3a9c2');
    for (const o of w.findAll('[data-test="arm-a"] option')) expect(o.text()).toMatch(/^[A-Z].* · [0-9a-f]{7}$/);
  });

  it('names the checks that stand in the way under a disabled Start', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    expect(w.get('[data-test="start-helper"]').text()).toBe('1 check is not passing: No analysis plan commit yet.');
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    await settle();
    expect(w.find('[data-test="start-helper"]').exists()).toBe(false);
  });

  it('shows trials, cost, time and the smallest detectable difference before anything starts', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    expect(w.get('[data-test="run-title"]').text()).toBe('Check and run');
    expect(w.find('.lede').exists()).toBe(true);
    expect(w.find('[data-test="run-actions"]').exists()).toBe(false);
    const plan = w.get('[data-test="plan"]').text();
    expect(plan).toContain('120');
    expect(plan).toContain('12 tasks × 2 arms × 5 trials');
    expect(plan).toContain('$21.30');
    expect(plan).toContain('Likely $16.00 to $27.00');
    expect(plan).toContain('10 points');
  });

  it('will not start until every check passes', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    const checks = w.findAll('[data-test="check"]').map((c) => c.text());
    expect(checks[0]).toContain('Only the system prompt differs between the arms');
    expect(checks.some((c) => c.includes('No analysis plan commit yet') && c.includes('Check failed'))).toBe(true);
    expect(w.get('[data-test="start"]').attributes('disabled')).toBeDefined();
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    await settle();
    expect(w.findAll('[data-test="check"]').every((c) => c.text().includes('Check passed'))).toBe(true);
    expect(w.get('[data-test="start"]').attributes('disabled')).toBeUndefined();
    expect(w.get('[data-test="start"]').text()).toBe('Start 120 trials');
  });

  it('re-estimates when the number of trials changes', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    await w.get('[data-test="n-input"]').setValue('10');
    await settle();
    expect(w.get('[data-test="plan"]').text()).toContain('240');
  });
});

describe('RunView, a running experiment in fixture mode', () => {
  useFixtures();

  it('shows progress per task, arm and trial, with infra failures apart from agent failures', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="tally"]').text()).toBe('60 done, 8 running, 50 waiting, 2 stopped by the provider and re-queued, about 19 min left');
    const grid = w.get('[data-test="run-grid"]');
    expect(grid.findAll('tbody tr')).toHaveLength(12);
    const states = grid.findAll('[data-state]').map((c) => c.attributes('data-state'));
    expect(states).toHaveLength(120);
    expect(states.filter((s) => s === 'infra')).toHaveLength(2);
    expect(grid.text()).toContain('debt-hardship-03, arm B, trial 2: stopped on an infra failure, re-queued');
    expect(w.get('[data-test="events"]').text()).toContain('Started 120 trials, 4 at a time.');
  });

  it('leads with its progress: the count in the title, then the grid, then what was planned and checked', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="run-title"]').text()).toBe('Running: 60 of 120 trials done');
    expect(w.find('.lede').exists()).toBe(false);
    const actions = w.get('[data-test="run-actions"]');
    expect(actions.get('[data-test="cancel"]').text()).toBe('Cancel the waiting trials');
    expect(actions.text()).toContain('Running trials finish; waiting ones are marked cancelled and kept.');
    const before = (first: string, then: string) => !!(w.get(first).element.compareDocumentPosition(w.get(then).element) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before('[data-test="run-grid"]', '[data-test="plan"]')).toBe(true);
    expect(before('[data-test="plan"]', '[data-test="checks-details"]')).toBe(true);
    expect(before('[data-test="checks-details"]', '[data-test="diff-details"]')).toBe(true);
    expect(w.get('#planned').text()).toBe('Planned');
    expect(w.get('[data-test="run-arms"]').text()).toContain('A: Own loop');
    expect(w.text()).toContain('LiteLLM stops all spending at $40');
  });

  it('keeps the checks and the arm diff closed, with what they hold in the summary', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    const checks = w.get('[data-test="checks-details"]');
    expect(checks.attributes('open')).toBeUndefined();
    expect(checks.get('summary').text()).toMatch(/^Checked before the start: \d+ of \d+ passed, plan 3e1a9f0$/);
    expect(checks.findAll('[data-test="check"]').length).toBeGreaterThan(0);
    const diff = w.get('[data-test="diff-details"]');
    expect(diff.attributes('open')).toBeUndefined();
    expect(diff.get('summary').text()).toMatch(/^How the two arms differ: \d+ fields?$/);
  });

  it('gives pass and fail cells equal weight and reads the legend in order', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    const legend = w.get('[data-test="grid-legend"]');
    expect(legend.findAll('.legend-item').map((i) => i.text())).toEqual(['Pass', 'Fail', 'Running', 'Waiting', '!Infra, re-queued', 'Re-run after infra', '!Infra, gave up']);
    expect(legend.findAll('.cell').map((c) => c.classes().find((k) => k.startsWith('cell--')))).toEqual(['cell--pass', 'cell--fail', 'cell--running', 'cell--waiting', 'cell--infra', 'cell--pass', 'cell--abandoned']);
    expect(legend.findAll('.cell')[5].classes()).toContain('cell--retried');
    const grid = w.get('[data-test="run-grid"]');
    expect(grid.findAll('[data-state="fail"]').length).toBeGreaterThan(0);
    expect(grid.findAll('[data-state="running"]').length).toBe(8);
  });
});

describe('RunView, a finished run in fixture mode', () => {
  useFixtures();

  it('keeps the infra history: retried slots carry a ring and the tally still counts the stops', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const tally = w.get('[data-test="tally"]').text();
    expect(tally).toContain('2 stopped by the provider: 2 re-run');
    expect(tally).not.toContain('re-queued');
    expect(tally).not.toContain('left');
    const retried = w.findAll('[data-test="run-grid"] [data-retried="true"]');
    expect(retried).toHaveLength(2);
    for (const c of retried) {
      expect(c.classes()).toContain('cell--retried');
      expect(c.attributes('data-state')).toBe('pass');
      expect(c.get('.visually-hidden').text()).toMatch(/: passed, after an infra failure$/);
    }
    expect(w.get('[data-test="run-grid"]').text()).toContain('debt-hardship-03, arm B, trial 2: passed, after an infra failure');
  });
});

describe('RunView against the API, with a slot that gave up', () => {
  it('says the slot gave up, never that it was re-queued, and splits the tally', async () => {
    const detail = { ...(details as Record<string, ExperimentDetail>).exp_harness, status: 'done' };
    const trials = ((experimentTrials as Record<string, ExperimentTrial[]>).exp_harness)
      .filter((t) => t.id !== 'th_fd-vs-sip-07_b_2_attempt2')
      .map((t) => {
        if (t.id === 'th_fd-vs-sip-07_b_2') return { ...t, status: 'abandoned' };
        if (t.id === 'th_debt-hardship-03_b_2_attempt2') return { ...t, status: 'done', label: 'agent', passed: false };
        return t;
      });
    routeFetch({ '/api/experiments/exp_harness': detail, '/api/experiments/exp_harness/trials': trials, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="tally"]').text()).toContain('2 stopped by the provider: 1 re-run, 1 gave up');
    const grid = w.get('[data-test="run-grid"]');
    const gaveUp = grid.findAll('[data-state="abandoned"]');
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0].text()).toContain('!');
    expect(gaveUp[0].get('.visually-hidden').text()).toBe('fd-vs-sip-07, arm B, trial 2: infra failure, gave up after 1 attempt');
    expect(gaveUp[0].text()).not.toContain('re-queued');
    const failedAfter = grid.findAll('[data-retried="true"]');
    expect(failedAfter.map((c) => c.attributes('data-state'))).toEqual(['fail']);
    expect(failedAfter[0].get('.visually-hidden').text()).toContain('failed, after an infra failure');
  });
});
