import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { settle, useFixtures } from '../test/helpers';
import ConfigView from './ConfigView.vue';

useFixtures();

describe('ConfigView in fixture mode', () => {
  it('starts from the baseline with the newest prompt and says exactly what changed', async () => {
    const w = mount(ConfigView);
    await settle();
    expect(w.get('[data-test="config-hash"]').text()).toBe('7f3a9c2');
    expect(w.get('[data-test="config-changes"]').text()).toBe('Prompt: v1 to v2');
    expect(w.text()).toContain('2 lines differ from v1');
  });

  it('says how each harness\'s settings are known, in the words the Harnesses page uses, and names configs first', async () => {
    const w = mount(ConfigView);
    await settle();
    const coverage = w.findAll('[data-test="harness-coverage"]').map((c) => c.text());
    expect(coverage[0]).toBe('4 probed, 4 declared');
    expect(coverage).toContain('1 declared, 7 not probed yet');
    const base = w.get('[data-test="base-select"]').element as HTMLSelectElement;
    expect(base.selectedOptions[0]?.text).toBe('Prompt v1 on Hermes · 3b81e04');
    expect(w.find('.tools .pill--pass').exists()).toBe(false);
    expect(w.find('.pill--pass').exists()).toBe(false);
  });

  it('shows the settings a harness does not support as disabled, and never sends them', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    const ownloop = w.findAll('[data-test="harness-radio"]').find((r) => (r.element as HTMLInputElement).value === 'ownloop');
    await ownloop?.setValue(true);
    for (const name of ['memory', 'skills', 'compression']) {
      const row = w.get(`[data-test="setting-${name}"]`);
      expect(row.get('input').attributes('disabled')).toBeDefined();
      expect(row.text()).toContain('Not supported by Own loop');
    }
    expect(w.get('[data-test="setting-temperature"] input').attributes('disabled')).toBeUndefined();
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0];
    expect(body.harness).toBe('ownloop');
    expect(Object.keys(body.settings).sort()).toEqual(['max_output_tokens', 'max_steps', 'parallel_tool_calls', 'temperature', 'timeout_s']);
    expect(w.text()).toContain('Saved as config');
  });

  it('shows how each setting reaches the model and whether it changed behaviour', async () => {
    const w = mount(ConfigView);
    await settle();
    expect(w.get('[data-test="setting-max_output_tokens"]').text()).toContain('max_tokens');
    expect(w.get('[data-test="setting-temperature"]').text()).toContain('Yes, on Claude Haiku 5.5');
    expect(w.get('[data-test="setting-parallel_tool_calls"]').text()).toContain('Not checked yet');
    expect(w.get('[data-test="setting-compression"]').text()).toContain('On (Hermes default)');
  });
});
