import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import type { ConfigView as Config } from '../api/types';
import { resetSession } from '../fixtures';
import configs from '../fixtures/configs.json';
import { settle, useFixtures } from '../test/helpers';
import ConfigView from './ConfigView.vue';

useFixtures();
// A config saved by one test is the newest, so the next would start from it: each test starts fresh.
beforeEach(() => resetSession());

const pick = async (w: ReturnType<typeof mount>, value: string) => {
  const radio = w.findAll('[data-test="harness-radio"]').find((r) => (r.element as HTMLInputElement).value === value);
  await radio?.setValue(true);
  await settle();
};

/** The newest sample config is on Gemini Flash; these tests read Claude Haiku 5.5's refusals. */
const haiku = async (w: ReturnType<typeof mount>) => {
  await w.get('[data-test="model-select"]').setValue('claude-haiku-5-5');
  await settle();
};

describe('ConfigView in fixture mode', () => {
  it('starts from the newest config of your own with the newest prompt, and says exactly what changed', async () => {
    const w = mount(ConfigView);
    await settle();
    expect((w.get('[data-test="base-select"]').element as HTMLSelectElement).value).toBe(configs[3].hash);
    expect(w.get('[data-test="config-changes"]').text()).toBe('Prompt: v1 to v2');
    expect(w.text()).toContain('2 lines differ from v1');
    expect(w.find('[data-test="config-hash"]').exists()).toBe(false);
    // The same harness and prompt on Claude Haiku 5.5 is the saved "Prompt v2 on Hermes".
    await haiku(w);
    expect(w.get('[data-test="config-hash"]').text()).toBe('7f3a9c2');
  });

  it('compares settings as the API stores them: a value cleared to its default says what the default is', async () => {
    const w = mount(ConfigView);
    await settle();
    await w.get('#setting-max_output_tokens').setValue('');
    await settle();
    expect(w.get('[data-test="config-changes"]').text()).toBe('Prompt: v1 to v2Max output tokens: 1024 to 8192');
    // Set back to the base value, nothing but the prompt differs again.
    await w.get('#setting-max_output_tokens').setValue('1024');
    await settle();
    expect(w.get('[data-test="config-changes"]').text()).toBe('Prompt: v1 to v2');
  });

  it('says how each harness\'s settings are known, in the words the Harnesses page uses, and names configs first', async () => {
    const w = mount(ConfigView);
    await settle();
    const coverage = w.findAll('[data-test="harness-coverage"]').map((c) => c.text());
    expect(coverage[0]).toBe('4 probed, 4 declared');
    expect(coverage).toContain('1 declared, 7 not probed yet');
    const base = w.get('[data-test="base-select"]').element as HTMLSelectElement;
    expect(base.selectedOptions[0]?.text).toBe('Prompt v1 on Hermes, Gemini Flash · c58e2d1');
    expect(w.find('.tools .pill--pass').exists()).toBe(false);
    expect(w.find('.pill--pass').exists()).toBe(false);
  });

  it('labels every settings cell by its column, so a narrow screen can stack each setting as a block', async () => {
    const w = mount(ConfigView);
    await settle();
    const heads = w.findAll('[data-test="settings-table"] thead th').map((h) => h.text());
    expect(heads).toEqual(['Setting', 'Value', 'If unset', 'Reaches the model as', 'Changes behaviour?']);
    for (const row of w.findAll('[data-test^="setting-"]').filter((r) => r.element.tagName === 'TR')) {
      expect(row.findAll('td').map((td) => td.attributes('data-label') ?? '')).toEqual(['', 'If unset', 'Reaches the model as', 'Changes behaviour?']);
    }
    // No fixed minimum width: the table fits its column, and long call paths wrap.
    expect(w.find('.table-scroll').exists()).toBe(false);
  });

  it('names a new config with its model, and says so plainly when saving returns one that exists', async () => {
    // As the API does for the same content: it answers with the stored config, under its own name.
    const v2 = (configs as unknown as Config[]).find((c) => c.name === 'Prompt v2 on Hermes') as Config;
    const create = vi.spyOn(api, 'createConfig').mockResolvedValueOnce(v2);
    const w = mount(ConfigView);
    await settle();
    // Made from what it holds: the harness, model and prompt, then each setting away from its default.
    expect((w.get('[data-test="config-name"]').element as HTMLInputElement).value).toBe('Hermes, Gemini 3.8 Flash, finance-advisor v2, max output tokens 1024, max steps 12, timeout 180 s');
    // On Claude Haiku 5.5 it is exactly the saved "Prompt v2 on Hermes".
    await haiku(w);
    expect((w.get('[data-test="config-name"]').element as HTMLInputElement).value).toBe('Hermes, Claude Haiku 5.5, finance-advisor v2, max output tokens 1024, max steps 12, timeout 180 s');
    expect(w.get('[data-test="config-name"]').attributes('maxlength')).toBe('120');
    expect(w.get('[data-test="same-as"]').text()).toContain('Same content as “Prompt v2 on Hermes”: saving returns that config, under its own name.');
    await w.get('[data-test="config-name"]').setValue('My better name');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].name).toBe('My better name');
    const notice = w.get('[data-test="config-exists"]').text();
    expect(notice).toContain('This config already exists as “Prompt v2 on Hermes” (7f3a9c2), so nothing new was saved and the name typed here was not used.');
    expect(notice).toContain('A name is only a label');
    expect(w.find('[data-test="open-saved"]').exists()).toBe(true);
  });

  it('says by each field why a value cannot be saved, follows the API on types, and adds upper bounds it says are its own', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    await w.get('#setting-max_steps').setValue('abc');
    await settle();
    expect(w.get('[data-test="problem-max_steps"]').text()).toBe('Max steps must be a whole number from 1 to 200; “abc” is not a number.');
    expect(w.get('#setting-max_steps').attributes('aria-invalid')).toBe('true');
    expect(w.get('#setting-max_steps').attributes('aria-describedby')).toBe('problem-max_steps');
    expect(w.get('[data-test="save-blocked"]').text()).toBe('Not saved yet: Max steps must be a whole number from 1 to 200; “abc” is not a number.');
    expect(w.get('[data-test="save-config"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-test="save-config"]').attributes('aria-describedby')).toBe('save-blocked');
    await w.get('#setting-max_steps').setValue('1000000');
    await settle();
    expect(w.get('[data-test="problem-max_steps"]').text()).toContain('more is almost always a typo');
    await w.get('#setting-max_steps').setValue('12');
    await w.get('#setting-max_output_tokens').setValue('99999999999');
    await w.get('#setting-timeout_s').setValue('86400000');
    await settle();
    expect(w.get('[data-test="problem-max_output_tokens"]').text()).toContain('from 1 to 64,000');
    expect(w.get('[data-test="problem-timeout_s"]').text()).toContain('at most 3,600 (one hour)');
    await w.get('#setting-max_output_tokens').setValue('1024');
    await w.get('#setting-timeout_s').setValue('180');
    await w.get('[data-test="config-name"]').setValue('   ');
    await settle();
    expect(w.get('[data-test="save-blocked"]').text()).toBe('Give the config a name to save it.');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create).not.toHaveBeenCalled();
  });

  it('says so when the address forks a config that is not saved, and starts a new one', async () => {
    const w = mount(ConfigView, { props: { fork: 'sha256:0000000' } });
    await settle();
    expect(w.get('[data-test="fork-missing"]').text()).toBe('No saved config has the id sha256:0000000, so there is nothing to fork. This page starts a new config instead; Configs lists every saved one.');
    expect(w.get('h1').text()).toBe('Define a config');
    expect(w.get('.crumbs').text()).toBe('Experiments / New config');
  });

  it('closes the prompt editor with Escape, and gives focus back to the button that opened it', async () => {
    const w = mount(ConfigView, { attachTo: document.body });
    await settle();
    await w.get('[data-test="new-prompt"]').trigger('click');
    await w.get('[data-test="prompt-draft"]').setValue('A draft that goes.');
    await w.get('[data-test="prompt-draft"]').trigger('keydown', { key: 'Escape' });
    await settle();
    expect(w.find('[data-test="prompt-editor"]').exists()).toBe(false);
    expect(document.activeElement).toBe(w.get('[data-test="new-prompt"]').element);
    w.unmount();
  });

  it('puts focus in the draft when the prompt editor opens, so Escape straight away closes it', async () => {
    const w = mount(ConfigView, { attachTo: document.body });
    await settle();
    await w.get('[data-test="new-prompt"]').trigger('click');
    await settle();
    // The button that opened it is gone; focus is in the draft, not left on the page body.
    expect(document.activeElement).toBe(w.get('[data-test="prompt-draft"]').element);
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(w.find('[data-test="prompt-editor"]').exists()).toBe(false);
    expect(document.activeElement).toBe(w.get('[data-test="new-prompt"]').element);
    w.unmount();
  });

  it('greys out what the harness or the model ignores, with the reason, and never sends it', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    await haiku(w);
    await pick(w, 'ownloop');
    for (const name of ['memory', 'skills', 'compression']) {
      const row = w.get(`[data-test="setting-${name}"]`);
      expect(row.get('input').attributes('disabled')).toBeDefined();
      expect(row.text()).toContain('Not supported by Own loop');
      // The harness by its name, then its own note as a sentence of its own (QA round 3, minor 17).
      expect(row.get(`[data-test="ignored-${name}"]`).text()).toMatch(new RegExp(`^Own loop does not support ${name}(\\. [A-Z].*\\.)?$`));
      expect(row.get(`[data-test="ignored-${name}"]`).text()).not.toMatch(/: off:|::/);
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
    await haiku(w);
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
    await haiku(w);
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
    // Named from what it holds, never the parent's name with ", fork" (QA round 3, M1).
    const name = () => (w.get('[data-test="config-name"]').element as HTMLInputElement).value;
    expect(name()).toBe('Hermes, Claude Haiku 5.5, finance-advisor v1, max output tokens 1024, max steps 12, timeout 180 s');
    await w.get('[data-test="model-select"]').setValue('gemini-3.8-flash');
    await settle();
    expect(w.get('[data-test="config-changes"]').text()).toBe('Model: Claude Haiku 5.5 to Gemini 3.8 Flash');
    // The name follows the change, so the fork never keeps the parent's now-wrong model.
    expect(name()).toBe('Hermes, Gemini 3.8 Flash, finance-advisor v1, max output tokens 1024, max steps 12, timeout 180 s');
    expect(name()).not.toContain('Haiku');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].parent_hash).toBe(parent.hash);
  });
});

// The second fresh-clone QA's blocker (5 Nov): after the shipped example is loaded, its configs are
// the newest, and their toolset is one this checkout no longer has.
const CURRENT_TOOLSET = (configs as unknown as Config[])[0].toolset;
const exampleConfig = (over: Partial<Config> = {}): Config => ({
  ...(configs as unknown as Config[])[2],
  hash: `sha256:90a6761${'0'.repeat(57)}`,
  name: 'v2 sim check, ownloop, haiku',
  toolset: { id: 'finance', version: 'all', sha256: `sha256:e8a33031${'0'.repeat(56)}` },
  example_only: true,
  created_at: '2026-11-05T13:59:00.000Z',
  ...over,
});

describe('ConfigView after the shipped example is loaded (QA blocker 1)', () => {
  it('starts a new config from the newest config of your own, never the example’s, and saves it', async () => {
    vi.spyOn(api, 'configs').mockResolvedValue([...(configs as unknown as Config[]), exampleConfig()]);
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    expect((w.get('[data-test="base-select"]').element as HTMLSelectElement).value).toBe(configs[3].hash);
    expect(w.get('[data-test="base-select"] optgroup').attributes('label')).toBe('From the shipped example');
    expect(w.find('[data-test="replaced-note"]').exists()).toBe(false);
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].toolset_sha256).toBe(CURRENT_TOOLSET.sha256);
    // The list says where each config came from, and counts the new one at once.
    expect(w.get('[data-test="saved-configs"]').text()).toContain('from the shipped example');
    expect(w.get('#saved-configs').text()).toBe('Saved configs (6)');
  });

  it('with only the example’s configs, starts from the catalogue’s own prompt and toolset, and saves', async () => {
    vi.spyOn(api, 'configs').mockResolvedValue([exampleConfig()]);
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    expect(w.find('[data-test="save-blocked"]').exists()).toBe(false);
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ harness: 'hermes', toolset_sha256: CURRENT_TOOLSET.sha256 });
    expect(w.find('[data-test="save-error"]').exists()).toBe(false);
  });

  it('forks an example’s config with a plain note and today’s toolset picked, and saves it as its child', async () => {
    const example = exampleConfig();
    vi.spyOn(api, 'configs').mockResolvedValue([...(configs as unknown as Config[]), example]);
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView, { props: { fork: example.hash } });
    await settle();
    expect(w.get('h1').text()).toBe('Fork a config');
    expect(w.get('.lede').text()).toContain('A copy of v2 sim check, ownloop, haiku, from the shipped example.');
    const note = w.get('[data-test="replaced-note"]').text();
    expect(note).toContain('v2 sim check, ownloop, haiku came with the shipped example, made elsewhere with the files of its day.');
    expect(note).toContain('Its toolset, finance all (e8a3303), is not in this checkout, so the current one, finance all, is picked under Tools.');
    expect((w.get('[data-test="toolset-select"]').element as HTMLSelectElement).value).toBe(CURRENT_TOOLSET.sha256);
    expect(w.get('[data-test="toolset-replaced"]').text()).toContain('the tools below are today');
    expect(w.get('[data-test="config-changes"]').text()).toContain('Toolset: finance all (e8a3303) to finance all (e4c1f08)');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ parent_hash: example.hash, toolset_sha256: CURRENT_TOOLSET.sha256 });
  });

  it('never stops a save without saying why: no toolset in the catalogue is named under Save', async () => {
    vi.spyOn(api, 'toolsets').mockResolvedValue([]);
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    expect(w.get('[data-test="save-blocked"]').text()).toBe("Pick a toolset: the one this config started from is not in this checkout's toolsets.");
    expect(w.get('[data-test="save-config"]').attributes('disabled')).toBeDefined();
    await w.get('form').trigger('submit');
    await settle();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('ConfigView says which models need a key (QA major 1)', () => {
  it('marks a model whose key is not set, and still lets the config be saved', async () => {
    vi.spyOn(api, 'models').mockResolvedValue([
      { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false },
      { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: true },
    ]);
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    const options = w.findAll('[data-test="model-select"] option').map((o) => o.text());
    expect(options).toContain('Claude Haiku 5.5 (needs ANTHROPIC_API_KEY in .env)');
    expect(options).toContain('Gemini 3.8 Flash');
    expect(w.find('[data-test="model-needs-key"]').exists()).toBe(false);
    await haiku(w);
    expect(w.get('[data-test="model-needs-key"]').text()).toBe(
      'Claude Haiku 5.5 needs ANTHROPIC_API_KEY in .env, and it is not set, so it cannot run yet. Saving is free and works anyway; before a run, add the key, then run docker compose up -d. A fake model below needs no key.',
    );
    await w.get('[data-test="config-name"]').setValue('Saved without a key');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
  });

  describe('when your newest config is on a model whose key is not set (a builder save without a key)', () => {
    const noHaikuKey = { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false };
    /** The sample configs without the Gemini one, so the newest of your own is on Claude Haiku 5.5. */
    const onHaiku = async () => (await api.configs()).filter((c) => c.model === 'claude-haiku-5-5');

    it('starts a new config on the first model with a key, and says so in one line', async () => {
      vi.spyOn(api, 'configs').mockResolvedValue(await onHaiku());
      vi.spyOn(api, 'models').mockResolvedValue([noHaikuKey, { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: true }]);
      const w = mount(ConfigView);
      await settle();
      expect((w.get('[data-test="model-select"]').element as HTMLSelectElement).value).toBe('gemini-3.8-flash');
      expect(w.get('[data-test="model-swapped"]').text()).toBe('Started on Gemini 3.8 Flash: Claude Haiku 5.5, which the config this one copies uses, needs ANTHROPIC_API_KEY in .env, and it is not set.');
      expect(w.find('[data-test="model-needs-key"]').exists()).toBe(false);
      // Picking the model by hand is a choice: the line goes, and the key line says what it needs.
      await haiku(w);
      expect(w.find('[data-test="model-swapped"]').exists()).toBe(false);
      expect(w.find('[data-test="model-needs-key"]').exists()).toBe(true);
    });

    it('starts on the fake EMI script when no model has a key', async () => {
      vi.spyOn(api, 'configs').mockResolvedValue(await onHaiku());
      vi.spyOn(api, 'models').mockResolvedValue([noHaikuKey, { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: false }]);
      const w = mount(ConfigView);
      await settle();
      expect((w.get('[data-test="model-select"]').element as HTMLSelectElement).value).toBe('fake/finance-emi');
      expect(w.get('[data-test="model-swapped"]').text()).toBe('Started on Fake model finance-emi: Claude Haiku 5.5, which the config this one copies uses, needs ANTHROPIC_API_KEY in .env, and it is not set.');
    });

    it('keeps a fork an exact copy, its model too', async () => {
      const configs = await onHaiku();
      vi.spyOn(api, 'configs').mockResolvedValue(configs);
      vi.spyOn(api, 'models').mockResolvedValue([noHaikuKey]);
      const w = mount(ConfigView, { props: { fork: configs[0].hash } });
      await settle();
      expect((w.get('[data-test="model-select"]').element as HTMLSelectElement).value).toBe('claude-haiku-5-5');
      expect(w.find('[data-test="model-swapped"]').exists()).toBe(false);
    });

    it('changes nothing when the key is set', async () => {
      vi.spyOn(api, 'configs').mockResolvedValue(await onHaiku());
      vi.spyOn(api, 'models').mockResolvedValue([{ ...noHaikuKey, key_set: true }]);
      const w = mount(ConfigView);
      await settle();
      expect((w.get('[data-test="model-select"]').element as HTMLSelectElement).value).toBe('claude-haiku-5-5');
      expect(w.find('[data-test="model-swapped"]').exists()).toBe(false);
    });
  });

  it('starts a config with no saved one on a fake model when no real model can run', async () => {
    vi.spyOn(api, 'configs').mockResolvedValue([]);
    vi.spyOn(api, 'models').mockResolvedValue([{ name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false }]);
    const w = mount(ConfigView);
    await settle();
    expect((w.get('[data-test="model-select"]').element as HTMLSelectElement).value).toBe('fake/finance-emi');
    expect(w.find('[data-test="save-blocked"]').exists()).toBe(false);
  });
});

describe('ConfigView keeps decision-log ids off the settings table', () => {
  it('shows how a setting reaches the model without the adapter’s note numbers', async () => {
    const harnesses = await api.harnesses();
    const hermes = harnesses.find((h) => h.name === 'hermes')!;
    hermes.capabilities.settings.max_output_tokens = { ...hermes.capabilities.settings.max_output_tokens, native: 'max_tokens, raised once on a cut-off reply (D36)' };
    vi.spyOn(api, 'harnesses').mockResolvedValue(harnesses);
    const w = mount(ConfigView);
    await settle();
    const cell = w.get('[data-test="setting-max_output_tokens"] .c-native').text();
    expect(cell).toBe('max_tokens, raised once on a cut-off reply');
  });
});

describe('ConfigView, fresh-clone QA round 3', () => {
  it('says there is nothing of your own to compare with, never "Identical to it." beside a blank picker (minor 2)', async () => {
    vi.spyOn(api, 'configs').mockResolvedValue([exampleConfig()]);
    const w = mount(ConfigView);
    await settle();
    const select = w.get('[data-test="base-select"]').element as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.text).toBe('Nothing yet');
    expect(w.get('[data-test="compare-note"]').text()).toBe('No config of your own to compare with yet. Pick one from the shipped example to see what this one changes.');
    expect(w.text()).not.toContain('Identical to it.');
    expect(w.find('[data-test="config-changes"]').exists()).toBe(false);
  });

  it('keeps the words of the change list after saving a fork, and never lists a change it did not make (minor 3)', async () => {
    const example = exampleConfig({ settings_sources: { ...exampleConfig().settings_sources, parallel_tool_calls: 'platform_default' } });
    vi.spyOn(api, 'configs').mockResolvedValue([...(configs as unknown as Config[]), example]);
    // As the API answered on 5 Nov: the form sends every toggle, so where one came from changed too.
    vi.spyOn(api, 'configDiff').mockResolvedValue([
      { path: 'settings_sources.parallel_tool_calls', a: 'platform_default', b: 'config' },
      { path: 'toolset.sha256', a: example.toolset.sha256, b: CURRENT_TOOLSET.sha256 },
    ]);
    const child: Config = { ...example, hash: `sha256:c4110d${'0'.repeat(58)}`, name: 'the fork', toolset: CURRENT_TOOLSET, example_only: false, parent_hash: example.hash };
    vi.spyOn(api, 'createConfig').mockResolvedValue(child);
    const w = mount(ConfigView, { props: { fork: example.hash } });
    await settle();
    const before = w.get('[data-test="config-changes"]').text();
    expect(before).toContain('Toolset: finance all (e8a3303) to finance all (e4c1f08)');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    const after = w.get('[data-test="config-changes"]');
    expect(after.text()).toBe(before);
    expect(after.text()).not.toMatch(/settings_sources|capabilities_sha256|toolset\.sha256|sha256:/);
    // The saved configs' own fields, behind Details, content only.
    const details = w.get('[data-test="saved-fields"]');
    expect(details.attributes('open')).toBeUndefined();
    expect(details.text()).toContain('toolset.sha256');
    expect(details.text()).not.toContain('settings_sources');
  });

  it('gives a long "reaches the model as" its own full-width row, on request (minor 5)', async () => {
    const w = mount(ConfigView);
    await settle();
    await pick(w, 'adk');
    await w.get('[data-test="model-select"]').setValue('gemini-3.8-flash');
    await settle();
    const harnesses = await api.harnesses();
    const full = harnesses.find((h) => h.name === 'adk')!.capabilities.settings.max_output_tokens.native ?? '';
    expect(full.length).toBeGreaterThan(48);
    const cell = w.get('[data-test="setting-max_output_tokens"] .c-native');
    expect(cell.get('.native').text().length).toBeLessThanOrEqual(48);
    expect(w.find('[data-test="native-full-max_output_tokens"]').exists()).toBe(false);
    await w.get('[data-test="native-more-max_output_tokens"]').trigger('click');
    const row = w.get('[data-test="native-full-max_output_tokens"]');
    expect(row.get('td').attributes('colspan')).toBe('5');
    expect(row.text().replace(/\s+/g, ' ')).toContain(full.replace(/\s+/g, ' '));
    expect(w.get('[data-test="native-more-max_output_tokens"]').attributes('aria-expanded')).toBe('true');
  });

  it('says once that no setting is checked yet, rather than a column of the same words (minor 5)', async () => {
    const w = mount(ConfigView);
    await settle();
    await pick(w, 'langgraph');
    expect(w.findAll('[data-test^="effect-"]').filter((c) => c.attributes('data-test') !== 'effect-note')).toHaveLength(0);
    expect(w.get('[data-test="settings-table"] thead').text()).not.toContain('Changes behaviour?');
    expect(w.get('[data-test="effect-note"]').text()).toMatch(/^Whether each setting changes behaviour on .+ has not been checked yet for LangGraph/);
    expect(w.text().split('Not checked yet').length - 1).toBe(0);
  });
});
