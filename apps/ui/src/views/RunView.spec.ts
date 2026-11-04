import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { settle, useFixtures } from '../test/helpers';
import RunView from './RunView.vue';

useFixtures();

describe('RunView, setting up a run in fixture mode', () => {
  it('shows trials, cost, time and the smallest detectable difference before anything starts', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
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
  it('shows progress per task, arm and trial, with infra failures apart from agent failures', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="tally"]').text()).toBe('60 done, 8 running, 50 waiting, 2 stopped by the provider and re-queued');
    const grid = w.get('[data-test="run-grid"]');
    expect(grid.findAll('tbody tr')).toHaveLength(12);
    const states = grid.findAll('[data-state]').map((c) => c.attributes('data-state'));
    expect(states).toHaveLength(120);
    expect(states.filter((s) => s === 'infra')).toHaveLength(2);
    expect(grid.text()).toContain('debt-hardship-03, arm B, trial 2: stopped on an infra failure, re-queued');
    expect(w.get('[data-test="events"]').text()).toContain('Started 120 trials, 4 at a time.');
  });
});
