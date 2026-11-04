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
    expect(w.get('[data-test="cell-langgraph-temperature"]').text()).toBe('Not probed yet');
    expect(w.get('[data-test="cell-langgraph-temperature"] span').classes()).toContain('pending');
    expect(w.get('.key').text()).toContain('Not probed yet: no request sent to check it');
    expect(w.get('.key .pending').text()).toBe('Not probed yet');
    expect(w.get('[data-test="cell-adk-temperature"]').text()).toBe('ProbedNot sent unless set. Inert on Gemini 3.8 Flash');
    expect(w.get('[data-test="cell-ownloop-temperature"] span').classes()).toContain('probed');
  });

  it('sets literal identifiers in the known differences in mono, and the words around them in Plex Sans', async () => {
    const w = mount(HarnessesView);
    await settle();
    const line = w.findAll('[data-test="difference-text"]').find((d) => d.text().includes('mcp__finance__'));
    expect(line?.text()).toBe('Tool names reach the model as mcp__finance__<name>, and tool results are wrapped as untrusted content.');
    expect(line?.findAll('.mono').map((m) => m.text())).toEqual(['mcp__finance__<name>']);
  });

  it('has one column per harness and one row per common setting', async () => {
    const w = mount(HarnessesView);
    await settle();
    const table = w.get('[data-test="capability-matrix"]');
    expect(table.findAll('thead th')).toHaveLength(6);
    expect(table.findAll('tbody tr')).toHaveLength(8);
    const lines = table.findAll('[data-test="coverage"]');
    expect(lines.map((p) => p.text())).toEqual(['4 probed, 4 declared', '4 probed, 4 declared', '1 declared, 7 not probed yet', '1 probed, 1 declared, 6 not probed yet', '1 declared, 7 not probed yet']);
    // Plain grey words, not a pill: no outline, no rounded box.
    for (const p of lines) {
      expect(p.classes()).toEqual(['result-detail', 'coverage']);
      expect(p.classes().some((c) => c.startsWith('pill'))).toBe(false);
    }
  });

  it('has a card per harness, with every setting, for screens the table would not fit', async () => {
    const w = mount(HarnessesView);
    await settle();
    const cards = w.findAll('[data-test="harness-card"]');
    expect(cards.map((c) => c.get('h3').text())).toEqual(['Hermes Agent 6112c2a', 'Own loop 0.1.0', 'LangGraph 1.2.16', 'Google ADK 2.12.0', 'OpenAI Agents SDK 0.24.0']);
    for (const card of cards) expect(card.findAll('dt')).toHaveLength(8);
    // The same words as the table's cell.
    expect(w.get('[data-test="card-hermes-max_steps"] dd').text()).toBe(w.get('[data-test="cell-hermes-max_steps"]').text());
    expect(w.get('[data-test="card-hermes-max_steps"] dt').text()).toBe('Max steps');
  });

  it('marks a probed setting with a check and ink, not green', async () => {
    const w = mount(HarnessesView);
    await settle();
    const probed = w.get('[data-test="cell-hermes-max_steps"] .probed');
    expect(probed.find('svg').exists()).toBe(true);
    expect(w.find('.key .probed svg').exists()).toBe(true);
    expect(w.find('.pill--pass').exists()).toBe(false);
  });
});
