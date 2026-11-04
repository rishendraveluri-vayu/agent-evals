import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { settle, useFixtures } from '../test/helpers';
import RunView from './RunView.vue';

useFixtures();

describe('RunView, setting up a run in fixture mode', () => {
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
    expect(legend.findAll('.legend-item').map((i) => i.text())).toEqual(['Pass', 'Fail', 'Running', 'Waiting', '!Infra, re-queued']);
    expect(legend.findAll('.cell').map((c) => c.classes().find((k) => k.startsWith('cell--')))).toEqual(['cell--pass', 'cell--fail', 'cell--running', 'cell--waiting', 'cell--infra']);
    const grid = w.get('[data-test="run-grid"]');
    expect(grid.findAll('[data-state="fail"]').length).toBeGreaterThan(0);
    expect(grid.findAll('[data-state="running"]').length).toBe(8);
  });
});
