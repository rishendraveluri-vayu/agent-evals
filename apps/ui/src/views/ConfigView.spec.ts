import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import type { ConfigView as Config } from '../api/types';
import configs from '../fixtures/configs.json';
import { settle, useFixtures } from '../test/helpers';
import ConfigView from './ConfigView.vue';

useFixtures();

const pick = async (w: ReturnType<typeof mount>, value: string) => {
  const radio = w.findAll('[data-test="harness-radio"]').find((r) => (r.element as HTMLInputElement).value === value);
  await radio?.setValue(true);
  await settle();
};

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

  it('greys out what the harness or the model ignores, with the reason, and never sends it', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    await pick(w, 'ownloop');
    for (const name of ['memory', 'skills', 'compression']) {
      const row = w.get(`[data-test="setting-${name}"]`);
      expect(row.get('input').attributes('disabled')).toBeDefined();
      expect(row.text()).toContain('Not supported by Own loop');
      expect(row.get(`[data-test="ignored-${name}"]`).text()).toMatch(new RegExp(`^ownloop does not support ${name}`));
    }
    // Claude Haiku 5.5 refuses temperature (D25): greyed on every harness, with the API's reason.
    const temp = w.get('[data-test="setting-temperature"]');
    expect(temp.get('input').attributes('disabled')).toBeDefined();
    expect(temp.get('[data-test="ignored-temperature"]').text()).toBe("Claude Haiku 5.5 rejects temperature, so it is not sent and the provider's default applies");
    expect(temp.classes()).toContain('row--unsupported');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0];
    expect(body.harness).toBe('ownloop');
    expect(Object.keys(body.settings ?? {}).sort()).toEqual(['max_output_tokens', 'max_steps', 'parallel_tool_calls', 'timeout_s']);
    expect(body.parent_hash).toBeUndefined();
    expect(w.text()).toContain('Saved as config');
    expect(w.get('[data-test="open-saved"]').attributes('href')).toMatch(/^#\/configs\/sha256%3A/);
  });

  it('sends memory, skills and compression as {enabled}, the contract shape', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    await w.get('#setting-memory').setValue(true);
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    const settings = create.mock.calls[0][0].settings ?? {};
    expect(settings.memory).toEqual({ enabled: true });
    expect(settings.skills).toEqual({ enabled: false });
    expect(settings.parallel_tool_calls).toBe(false);
  });

  it('shows how each setting reaches the model, what happens when it is unset, and whether it changed behaviour', async () => {
    const w = mount(ConfigView);
    await settle();
    expect(w.get('[data-test="setting-max_output_tokens"]').text()).toContain('max_tokens');
    expect(w.get('[data-test="setting-max_output_tokens"]').text()).toContain('Platform default, 8,192');
    expect(w.get('[data-test="setting-parallel_tool_calls"]').text()).toContain('Not checked yet');
    expect(w.get('[data-test="setting-compression"]').text()).toContain('Off (Hermes default is on)');
    expect(w.get('[data-test="setting-temperature"]').text()).toContain('Not sent: Claude Haiku 5.5 refuses it');
    await w.get('[data-test="model-select"]').setValue('gemini-3.8-flash');
    await settle();
    expect(w.get('[data-test="setting-temperature"] input').attributes('disabled')).toBeUndefined();
    expect(w.get('[data-test="setting-temperature"]').text()).toContain('Yes, on Gemini 3.8 Flash');
  });

  it('answers "Changes behaviour?" in words with an icon each, never as identical pills', async () => {
    const w = mount(ConfigView);
    await settle();
    const cells = w.findAll('[data-test^="effect-"]');
    expect(cells).toHaveLength(8);
    for (const c of cells) expect(c.find('.pill').exists()).toBe(false);
    const kind = (k: string) => cells.filter((c) => c.get('.effect').attributes('data-effect') === k);
    // A change seen: ink, with the check mark used for Probed on the Harnesses page.
    const yes = kind('yes');
    expect(yes.map((c) => c.text())).toEqual(['Yes, on Claude Haiku 5.5', 'Yes, on Claude Haiku 5.5']);
    for (const c of yes) {
      expect(c.find('svg.icon').exists()).toBe(true);
      expect(c.get('svg.icon').attributes('width')).toBe('12');
      expect(c.get('svg.icon').attributes('aria-hidden')).toBe('true');
    }
    // Not checked: plain grey words, no icon.
    const todo = kind('todo');
    expect(todo).toHaveLength(4);
    for (const c of todo) {
      expect(c.text()).toBe('Not checked yet');
      expect(c.find('svg').exists()).toBe(false);
    }
    expect(w.get('[data-test="effect-timeout_s"]').text()).toBe('Not applicable');
    expect(w.find('[data-test="effect-timeout_s"] svg').exists()).toBe(false);
    // Temperature is ignored on Haiku, so there is nothing to say about its effect.
    expect(w.get('[data-test="effect-temperature"]').text()).toBe('–');
  });

  it('marks a setting with no change seen with the alert icon and weight 500, as the main page does', async () => {
    const w = mount(ConfigView);
    await settle();
    await pick(w, 'adk');
    await w.get('[data-test="model-select"]').setValue('gemini-3.8-flash');
    await settle();
    const temp = w.get('[data-test="effect-temperature"] .effect');
    expect(temp.text()).toBe('No change seen on Gemini 3.8 Flash');
    expect(temp.attributes('data-effect')).toBe('no');
    expect(temp.classes()).toContain('effect--no');
    expect(temp.get('svg.icon').attributes('width')).toBe('14');
    expect(temp.find('.pill').exists()).toBe(false);
  });

  it('lists the saved configs, each opening its own page', async () => {
    const w = mount(ConfigView);
    await settle();
    // Newest first; configs saved by earlier tests in this file are in the session store too.
    const links = w.findAll('[data-test="saved-configs"] li a');
    expect(links.map((l) => l.text())).toEqual(expect.arrayContaining(['Prompt v1 on Hermes', 'Prompt v2 on Hermes', 'Own loop, prompt v1', 'Prompt v1 on Hermes, Gemini Flash']));
    const gemini = links.find((l) => l.text() === 'Prompt v1 on Hermes, Gemini Flash');
    expect(gemini?.attributes('href')).toMatch(/^#\/configs\/sha256%3Ac58e2d1/);
    expect(links.at(-1)?.text()).toBe('Prompt v1 on Hermes');
  });
});

describe('ConfigView, a refused setting', () => {
  it('shows the API refusal and its fix by the field it is about, and greys the field from then on', async () => {
    const create = vi.spyOn(api, 'createConfig').mockRejectedValueOnce(
      new ApiError(400, 'unsupported_setting', 'Gemini 3.8 Flash (gemini-3.8-flash) refuses max_steps: the provider said so. Leave max_steps unset for gemini-3.8-flash', 'Gemini 3.8 Flash rejects max_steps: leave it unset, or pick a model that takes it.'),
    );
    const w = mount(ConfigView);
    await settle();
    await w.get('[data-test="model-select"]').setValue('gemini-3.8-flash');
    await settle();
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    const refusal = w.get('[data-test="refusal-max_steps"]');
    expect(refusal.attributes('role')).toBe('alert');
    expect(refusal.text()).toContain('The API refused max steps: Gemini 3.8 Flash (gemini-3.8-flash) refuses max_steps');
    expect(refusal.get('[data-test="refusal-fix"]').text()).toBe('Fix: Gemini 3.8 Flash rejects max_steps: leave it unset, or pick a model that takes it.');
    // The refusal sits directly under the field's own row.
    const row = w.get('[data-test="setting-max_steps"]').element;
    expect(row.nextElementSibling?.contains(refusal.element)).toBe(true);
    expect(w.get('#setting-max_steps').attributes('aria-describedby')).toBe('refusal-max_steps');
    expect(w.get('[data-test="save-error"]').text()).toBe('Not saved: the API refused max steps. See the field for how to fix it.');
    // A model's refusal holds for the model: the field is greyed with the fix as its reason.
    expect(w.get('#setting-max_steps').attributes('disabled')).toBeDefined();
    expect(w.get('[data-test="ignored-max_steps"]').text()).toBe('Gemini 3.8 Flash rejects max_steps: leave it unset, or pick a model that takes it.');
  });

  it('shows a refusal it cannot place on a field, with its fix, in the summary', async () => {
    vi.spyOn(api, 'createConfig').mockRejectedValueOnce(new ApiError(400, 'same_as_parent', 'this fork is identical to its parent', 'Change the one thing this fork is meant to test.'));
    const w = mount(ConfigView);
    await settle();
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(w.get('[data-test="save-error"]').text()).toBe('this fork is identical to its parent Fix: Change the one thing this fork is meant to test.');
  });
});

describe('ConfigView, warnings', () => {
  it('shows a warning the API gives for this harness and model, with how to avoid it', async () => {
    const warning = {
      code: 'langgraph_model_name_rewrite',
      message: 'LangGraph changes the request for this model name (gpt-5-mini): a gpt-5 name drops any temperature other than 1.',
      fix: 'Serve the model under a LiteLLM name that does not start with gpt-5, gpt-6, o1 or o<digit> and does not contain codex, or run it on another harness.',
    };
    const saved = { ...(configs[0] as unknown as Config), harness: 'langgraph', model: 'gemini-3.8-flash', warnings: [warning] };
    vi.spyOn(api, 'configs').mockResolvedValue([...(configs as unknown as Config[]), saved]);
    const w = mount(ConfigView);
    await settle();
    expect(w.find('[data-test="config-warning"]').exists()).toBe(false);
    await pick(w, 'langgraph');
    await w.get('[data-test="model-select"]').setValue('gemini-3.8-flash');
    await settle();
    const shown = w.get('[data-test="config-warning"]');
    expect(shown.attributes('role')).toBe('note');
    expect(shown.text()).toContain('LangGraph changes the request for this model name');
    expect(shown.text()).toContain('How to avoid it: Serve the model under a LiteLLM name');
  });
});

describe('ConfigView, forking a config', () => {
  it('starts as an exact copy, names the parent, and sends parent_hash on save', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const parent = (configs as unknown as Config[])[0];
    const w = mount(ConfigView, { props: { fork: parent.hash } });
    await settle();
    expect(w.get('h1').text()).toBe('Fork a config');
    expect(w.get('.lede a').attributes('href')).toBe(`#/configs/${encodeURIComponent(parent.hash)}`);
    // An exact copy: the same prompt (not the newest), so nothing differs yet.
    expect(w.get('[data-test="config-hash"]').text()).toBe('3b81e04');
    expect((w.get('[data-test="config-name"]').element as HTMLInputElement).value).toBe('Prompt v1 on Hermes, fork');
    await w.get('[data-test="model-select"]').setValue('gemini-3.8-flash');
    await settle();
    expect(w.get('[data-test="config-changes"]').text()).toBe('Model: Claude Haiku 5.5 to Gemini 3.8 Flash');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].parent_hash).toBe(parent.hash);
  });
});
