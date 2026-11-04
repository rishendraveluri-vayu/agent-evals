import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { settle, useFixtures } from '../test/helpers';
import HarnessesView from './HarnessesView.vue';

useFixtures();

describe('HarnessesView in fixture mode', () => {
  it('shows each capability cell with its evidence and what was observed', async () => {
    const w = mount(HarnessesView);
    await settle();
    expect(w.get('[data-test="cell-hermes-max_steps"]').text()).toBe('Probed2 extra calls at the limit; it counts only its own');
    expect(w.get('[data-test="cell-hermes-memory"]').text()).toBe('DeclaredOff unless the config turns it on');
    expect(w.get('[data-test="cell-ownloop-compression"]').text()).toBe('Not supportedAlways sends the full history');
    expect(w.get('[data-test="cell-langgraph-temperature"]').text()).toBe('Probe pending');
    expect(w.get('[data-test="cell-adk-temperature"]').text()).toBe('ProbedNot sent unless set. Inert on Claude Haiku 5.5');
    expect(w.get('[data-test="cell-ownloop-temperature"] span').classes()).toContain('probed');
  });

  it('has one column per harness and one row per common setting', async () => {
    const w = mount(HarnessesView);
    await settle();
    const table = w.get('[data-test="capability-matrix"]');
    expect(table.findAll('thead th')).toHaveLength(6);
    expect(table.findAll('tbody tr')).toHaveLength(8);
    expect(table.text()).toContain('8 of 8 checked');
    expect(table.text()).toContain('1 of 8 checked');
  });
});
