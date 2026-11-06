import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import configs from '../fixtures/configs.json';
import prompts from '../fixtures/prompts.json';
import toolsets from '../fixtures/toolsets.json';
import { settle, useFixtures } from '../test/helpers';
import BuildView from './BuildView.vue';

useFixtures();

const V2 = prompts.find((p) => p.version === 'v2')!;
const V1 = prompts.find((p) => p.version === 'v1')!;
const OWN_LOOP = configs.find((c) => c.name === 'Own loop, prompt v1')!;

let w: VueWrapper | null = null;
afterEach(() => {
  w?.unmount();
  w = null;
  vi.restoreAllMocks();
});

async function open() {
  w = mount(BuildView, { attachTo: document.body });
  await settle();
  return w;
}

async function pickHarness(view: VueWrapper, name: string) {
  await view.get(`[data-test="harness-${name}"] input`).setValue(true);
  await settle();
}

async function setNumber(view: VueWrapper, name: string, value: string) {
  await view.get(`#build-${name}`).setValue(value);
  await settle();
}

describe('Build an agent, in fixture mode', () => {
  it('offers one card per harness and marks the one chosen, with the name following the choices', async () => {
    const view = await open();
    const cards = view.findAll('[data-test^="harness-"][class~="tile"]');
    expect(cards.map((c) => c.attributes('data-test'))).toEqual(['harness-hermes', 'harness-ownloop', 'harness-langgraph', 'harness-adk', 'harness-openai-agents']);
    expect(view.get('[data-test="harness-hermes"]').classes()).toContain('tile--on');
    expect(view.get('[data-test="harness-ownloop"]').text()).toContain('Adds nothing: the vanilla baseline.');
    expect((view.get('[data-test="agent-name"]').element as HTMLInputElement).value).toBe('Hermes, Claude Haiku 5.5, finance-advisor v2');
    await pickHarness(view, 'ownloop');
    expect(view.get('[data-test="harness-ownloop"]').classes()).toContain('tile--on');
    expect(view.get('[data-test="harness-hermes"]').classes()).not.toContain('tile--on');
    expect(view.get('[data-test="build-summary"]').text()).toContain('Agent type Own loop');
    expect((view.get('[data-test="agent-name"]').element as HTMLInputElement).value).toBe('Own loop, Claude Haiku 5.5, finance-advisor v2');
    // A name typed by hand is kept when a choice changes.
    await view.get('[data-test="agent-name"]').setValue('My agent');
    await pickHarness(view, 'langgraph');
    expect((view.get('[data-test="agent-name"]').element as HTMLInputElement).value).toBe('My agent');
  });

  it('opens a harness note from its i button, closes it with Escape and puts focus back', async () => {
    const view = await open();
    const button = view.get('[data-test="harness-hermes"] [data-test="info-button"]');
    const note = view.get('[data-test="harness-hermes"] [data-test="info-note"]');
    expect(button.element.tagName).toBe('BUTTON');
    expect(button.attributes('aria-label')).toBe('About Hermes Agent');
    expect(button.attributes('aria-expanded')).toBe('false');
    expect(button.attributes('aria-controls')).toBe(note.attributes('id'));
    expect((note.element as HTMLElement).style.display).toBe('none');
    // The i is outside the card's label: opening the note does not pick the harness.
    await pickHarness(view, 'ownloop');
    (button.element as HTMLButtonElement).focus();
    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('true');
    expect((note.element as HTMLElement).style.display).toBe('');
    expect(view.get('[data-test="harness-ownloop"]').classes()).toContain('tile--on');
    expect(note.text()).toContain('About 4,500 characters of its own around yours');
    expect(note.get('[data-test="note-memory"]').text()).toBe('Memory, skills and compression, off unless turned on.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(button.attributes('aria-expanded')).toBe('false');
    expect((note.element as HTMLElement).style.display).toBe('none');
    expect(document.activeElement).toBe(button.element);
  });

  it('says what each harness adds to the prompt and what memory it has, from the guide and its capabilities', async () => {
    const view = await open();
    const own = view.get('[data-test="harness-ownloop"] [data-test="info-note"]');
    expect(own.text()).toContain('Nothing: your prompt is the whole system prompt.');
    expect(own.get('[data-test="note-memory"]').text()).toBe('None.');
    expect(view.get('[data-test="harness-adk"] [data-test="info-note"]').text()).toContain('every tool description fenced');
  });

  it('closes an open note on a click outside it, without moving focus there', async () => {
    const view = await open();
    const button = view.get('[data-test="harness-adk"] [data-test="info-button"]');
    await button.trigger('click');
    expect(button.attributes('aria-expanded')).toBe('true');
    view.get('h1').element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(button.attributes('aria-expanded')).toBe('false');
  });

  it('lists real models only, each with its price, and says plainly that running one costs money', async () => {
    const view = await open();
    const radios = view.findAll('[data-test="model-radio"]').map((r) => (r.element as HTMLInputElement).value);
    expect(radios).toEqual(['claude-haiku-5-5', 'gemini-3.8-flash']);
    expect(radios.some((m) => m.startsWith('fake/'))).toBe(false);
    expect(view.text().toLowerCase()).not.toContain('fake');
    expect(view.get('[data-test="model-claude-haiku-5-5"]').text()).toContain('$0.10 in, $0.50 out per million tokens');
    const note = view.get('[data-test="model-cost-note"]');
    expect(note.text()).toContain('costs money');
    expect(note.text()).toContain('ANTHROPIC_API_KEY');
    expect(note.text()).toContain('the Run screen shows the trials, models and cost before anything starts');
    await view.get('[data-test="model-gemini-3.8-flash"] input').setValue(true);
    await settle();
    expect(view.get('[data-test="model-cost-note"]').text()).toContain('GEMINI_API_KEY');
  });

  it('greys out a setting the harness cannot honour, with the reason, and never sends it', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const view = await open();
    expect(view.get('#build-memory').attributes('disabled')).toBeUndefined();
    await pickHarness(view, 'ownloop');
    const memory = view.get('[data-test="setting-memory"]');
    expect(memory.get('input').attributes('disabled')).toBeDefined();
    expect(memory.classes()).toContain('setting--off');
    expect(memory.get('[data-test="reason-memory"]').text()).toBe('Own loop does not support memory');
    expect(memory.text()).toContain('Not available');
    // Each setting has its own i, saying what it does in a line.
    const steps = view.get('[data-test="setting-max_steps"] [data-test="info-button"]');
    expect(steps.attributes('aria-label')).toBe('About max steps');
    expect(view.get('[data-test="setting-max_steps"] [data-test="info-note"]').text()).toBe('The most model calls the agent may make in one trial; it stops there. Default 15.');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0][0];
    expect(body.harness).toBe('ownloop');
    expect(body.settings).toEqual({});
  });

  it('saves through POST /configs with the choices, and only the settings it set', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const view = await open();
    await setNumber(view, 'max_steps', '9');
    await view.get('#build-memory').setValue(true);
    await view.get('#build-parallel_tool_calls').setValue(true);
    await settle();
    await view.get('[data-test="agent-name"]').setValue('  Hermes with memory  ');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual({
      name: 'Hermes with memory',
      harness: 'hermes',
      model: 'claude-haiku-5-5',
      prompt_sha256: V2.sha256,
      toolset_sha256: toolsets[0].sha256,
      settings: { max_steps: 9, parallel_tool_calls: true, memory: { enabled: true } },
    });
    expect(view.get('[data-test="saved-status"]').text()).toMatch(/^Saved as Hermes with memory, [0-9a-f]{7}\.$/);
  });

  it('never gives an agent a validation toolset (D70), wherever it is listed', async () => {
    const full = { ...toolsets[0], manifest: [], description: 'Every finance tool.', validation_only: false };
    const broken = { ...full, id: 'finance-no-calculators', version: 'v3', sha256: `sha256:34e53515${'0'.repeat(56)}`, validation_only: true };
    vi.spyOn(api, 'toolsets').mockResolvedValue([broken, full]);
    const create = vi.spyOn(api, 'createConfig');
    const view = await open();
    await view.get('[data-test="agent-name"]').setValue('Plain agent');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].toolset_sha256).toBe(full.sha256);
  });

  it('refuses a number that is not one, and says which step to fix', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const view = await open();
    await setNumber(view, 'timeout_s', 'soon');
    expect(view.get('[data-test="save-blocked"]').text()).toBe('Step 4: Timeout must be a number of seconds above 0 and at most 3,600 (one hour); “soon” is not a number.');
    expect(view.get('[data-test="problem-timeout_s"]').text()).toBe('Timeout must be a number of seconds above 0 and at most 3,600 (one hour); “soon” is not a number.');
    expect(view.get('#build-timeout_s').attributes('aria-invalid')).toBe('true');
    expect(view.get('[data-test="save-agent"]').attributes('disabled')).toBeDefined();
    expect(view.get('[data-test="save-agent"]').attributes('aria-describedby')).toBe('build-save-blocked');
    await view.get('form').trigger('submit');
    await settle();
    expect(create).not.toHaveBeenCalled();
  });

  it('follows the API on whole numbers and adds an upper bound it says is its own', async () => {
    const view = await open();
    await setNumber(view, 'max_steps', '2.5');
    expect(view.get('[data-test="problem-max_steps"]').text()).toBe('Max steps must be a whole number from 1 to 200, with no decimals.');
    await setNumber(view, 'max_steps', '0');
    expect(view.get('[data-test="problem-max_steps"]').text()).toBe('Max steps must be a whole number from 1 to 200.');
    await setNumber(view, 'max_steps', '1000000');
    expect(view.get('[data-test="problem-max_steps"]').text()).toBe('Max steps must be a whole number from 1 to 200.');
    await setNumber(view, 'max_steps', '200');
    expect(view.find('[data-test="problem-max_steps"]').exists()).toBe(false);
    await setNumber(view, 'max_output_tokens', '99999999999');
    expect(view.get('[data-test="problem-max_output_tokens"]').text()).toContain('a whole number from 1 to 64,000');
    await setNumber(view, 'max_output_tokens', '64000');
    await setNumber(view, 'timeout_s', '86400000');
    expect(view.get('[data-test="problem-timeout_s"]').text()).toContain('at most 3,600 (one hour)');
    await setNumber(view, 'timeout_s', '0.5');
    expect(view.find('[data-test="problem-timeout_s"]').exists()).toBe(false);
    expect(view.get('[data-test="save-agent"]').attributes('disabled')).toBeUndefined();
  });

  it('caps the name and says why Save is off when it is empty', async () => {
    const view = await open();
    expect(view.get('[data-test="agent-name"]').attributes('maxlength')).toBe('120');
    await view.get('[data-test="agent-name"]').setValue('   ');
    await settle();
    expect(view.get('[data-test="save-blocked"]').text()).toBe('Give the agent a name to save it.');
    expect(view.get('[data-test="save-agent"]').attributes('disabled')).toBeDefined();
  });

  it('shows the API refusal and its fix when saving fails', async () => {
    vi.spyOn(api, 'createConfig').mockRejectedValueOnce(new ApiError(400, 'unsupported_setting', 'hermes does not support max_steps', 'Leave it unset.'));
    const view = await open();
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(view.get('[data-test="save-error"]').text()).toContain('hermes does not support max_steps');
    expect(view.get('[data-test="save-error"]').text()).toContain('Leave it unset.');
    expect(view.find('[data-test="next-steps"]').exists()).toBe(false);
  });

  it('after saving, links to the preview, to a run against the one baseline that differs in one thing, and to all settings', async () => {
    const view = await open();
    expect(view.get('[data-test="all-settings"]').attributes('href')).toBe('#/configs');
    // LangGraph with prompt v1 and the sample baseline's numbers: only the harness differs from
    // "Prompt v1 on Hermes" and from "Own loop, prompt v1"; the newer of the two is the baseline.
    await pickHarness(view, 'langgraph');
    await view.get('[data-test="prompt-select"]').setValue(V1.sha256);
    await setNumber(view, 'max_steps', '12');
    await setNumber(view, 'max_output_tokens', '1024');
    await setNumber(view, 'timeout_s', '180');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    const status = view.get('[data-test="saved-status"]').text();
    const hash = /([0-9a-f]{7})\.$/.exec(status)?.[1];
    expect(hash).toBeTruthy();
    const preview = view.get('[data-test="next-preview"]');
    expect(preview.text()).toBe('See what reaches the model');
    expect(preview.attributes('href')).toMatch(new RegExp(`^#/configs/sha256%3A${hash}`));
    expect(view.get('[data-test="next-steps"]').text()).toContain('A free preview of exactly what the model receives');
    const evaluate = view.get('[data-test="next-evaluate"]').attributes('href') ?? '';
    const q = new URLSearchParams(evaluate.split('?')[1]);
    expect(evaluate.startsWith('#/run?')).toBe(true);
    expect(q.get('a')).toBe(OWN_LOOP.hash);
    expect(q.get('b')).toMatch(new RegExp(`^sha256:${hash}`));
    expect(view.get('[data-test="next-evaluate-words"]').text()).toContain('Against Own loop, prompt v1, which differs from it only in the harness (Own loop 0.1.0 vs LangGraph 1.2.16): that agent is arm A, the baseline, and this one arm B, the agent being tried.');
    expect(view.get('[data-test="all-settings"]').attributes('href')).toBe(`#/configs?fork=${encodeURIComponent(q.get('b') ?? '')}`);
    // A different choice is a different agent: the next steps wait for it to be saved.
    await pickHarness(view, 'adk');
    expect(view.find('[data-test="next-steps"]').exists()).toBe(false);
    expect(view.get('[data-test="all-settings"]').attributes('href')).toBe('#/configs');
  });

  it('with no saved agent one change away, says a comparison needs a baseline and links to fork this agent, never a dead-end run', async () => {
    const view = await open();
    // Harness, model and steps all differ from every saved agent.
    await pickHarness(view, 'openai-agents');
    await view.get('[data-test="model-gemini-3.8-flash"] input').setValue(true);
    await setNumber(view, 'max_steps', '7');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    const fork = view.get('[data-test="next-fork"]');
    expect(fork.text()).toBe('Fork it to try one change');
    expect(fork.attributes('href')).toMatch(/^#\/configs\?fork=sha256%3A/);
    const words = view.get('[data-test="next-evaluate-words"]').text();
    expect(words).toContain('A comparison needs two agents that differ in just one thing');
    // The words say what the fork's "Save and set up a run" does: this agent is A, the fork B (QA round 3, minor 13).
    expect(words).toContain('Fork it, change one setting, the prompt or the model, and press Save and set up a run: this agent is then arm A, the baseline, and the fork arm B, the change being tried.');
    expect(words).not.toContain('evaluate the fork against this one');
    expect(words).not.toMatch(/sha256|capabilities/);
    // A pilot is still one click away: this agent alone, with no arm A picked for it.
    const evaluate = view.get('[data-test="next-evaluate"]').attributes('href') ?? '';
    const q = new URLSearchParams(evaluate.split('?')[1]);
    expect(q.get('a')).toBeNull();
    expect(q.get('b')).toMatch(/^sha256:/);
  });

  it('never takes a shipped example’s agent as the baseline, the QA’s dead end after loading the example', async () => {
    const example = { ...OWN_LOOP, hash: `sha256:90a6761${'0'.repeat(57)}`, name: 'v2 sim check, ownloop, haiku', capabilities_sha256: 'sha256:old', example_only: true };
    vi.spyOn(api, 'configs').mockResolvedValue([example] as never);
    const view = await open();
    await pickHarness(view, 'ownloop');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(view.find('[data-test="next-fork"]').exists()).toBe(true);
    expect(view.get('[data-test="next-evaluate"]').attributes('href')).not.toContain('90a6761');
  });

  it('says on each model that needs a key it lacks, keeps saving free, and points a keyless reviewer to the free route', async () => {
    vi.spyOn(api, 'models').mockResolvedValue([
      { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false },
      { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: false },
    ]);
    const view = await open();
    expect(view.get('[data-test="model-claude-haiku-5-5"] [data-test="needs-key"]').text()).toBe('needs ANTHROPIC_API_KEY in .env');
    expect(view.get('[data-test="model-gemini-3.8-flash"] [data-test="needs-key"]').text()).toBe('needs GEMINI_API_KEY in .env');
    expect(view.get('[data-test="model-cost-note"]').text()).toContain('ANTHROPIC_API_KEY is not set in .env, so this model cannot run yet. Saving is free and works anyway; before a run, add the key, then run docker compose up -d.');
    const noKeys = view.get('[data-test="no-keys"]');
    // As the README says: fake models need no key, but they are for testing the platform (round 3).
    expect(noKeys.text()).toContain('Fake models run without a key, from the full Config screen, but they make the same scripted calls whatever the task, so most trials fail: they exist to test the platform, not to judge an agent.');
    expect(noKeys.get('a').attributes('href')).toBe('#/configs');
    expect(view.get('[data-test="save-agent"]').attributes('disabled')).toBeUndefined();
    // Models are listed, so it never also says there are none (fresh-clone review, G1).
    expect(view.find('[data-test="no-models"]').exists()).toBe(false);
  });

  it('counts the keyless local model as unknown, not runnable, and says what it needs', async () => {
    vi.spyOn(api, 'models').mockResolvedValue([
      { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false },
      { name: 'qwen2.5-7b-local', provider: 'ollama_chat', input_per_mtok: 0, output_per_mtok: 0, key_set: null },
    ]);
    const view = await open();
    const note = view.get('[data-test="no-keys"]').text();
    expect(note).toContain('so no hosted model can run yet');
    expect(note).toContain('needs no key, but it runs only once its compose profile is up');
    expect(view.find('[data-test="no-models"]').exists()).toBe(false);
  });

  it('with a key set, shows neither the keyless note nor the no-models line', async () => {
    vi.spyOn(api, 'models').mockResolvedValue([
      { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: true },
      { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: false },
    ]);
    const view = await open();
    expect(view.find('[data-test="no-keys"]').exists()).toBe(false);
    expect(view.find('[data-test="no-models"]').exists()).toBe(false);
  });

  it('has one field per setting: no stray checkbox beside a number, and no id twice', async () => {
    const view = await open();
    for (const name of ['max_steps', 'max_output_tokens', 'timeout_s']) {
      const box = view.get(`[data-test="setting-${name}"]`);
      expect(box.findAll('input[type="checkbox"]')).toHaveLength(0);
      expect(box.find('.toggle').exists()).toBe(false);
    }
    for (const name of ['parallel_tool_calls', 'memory']) expect(view.get(`[data-test="setting-${name}"]`).findAll('input[type="checkbox"]')).toHaveLength(1);
    const ids = [...document.querySelectorAll('[data-test="build-form"] [id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says so when the same agent was saved before, instead of claiming a new one', async () => {
    const view = await open();
    await pickHarness(view, 'ownloop');
    await view.get('[data-test="model-gemini-3.8-flash"] input').setValue(true);
    await settle();
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(view.get('[data-test="saved-status"]').text()).toMatch(/^Saved as Own loop, Gemini 3.8 Flash, finance-advisor v2/);
    await view.get('[data-test="agent-name"]').setValue('Same agent again');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    // The name typed the second time is dropped by the API: the page says so, and why.
    expect(view.get('[data-test="saved-status"]').text()).toMatch(
      /^This agent already exists as “Own loop, Gemini 3\.8 Flash, finance-advisor v2” \([0-9a-f]{7}\), so nothing new was saved and the name typed here was not used\. A name is only a label/,
    );
  });

  it('writes a new prompt as the next version through POST /prompts, then uses it', async () => {
    const createPrompt = vi.spyOn(api, 'createPrompt');
    const create = vi.spyOn(api, 'createConfig');
    const view = await open();
    expect(view.get('[data-test="prompt-text"]').text()).toContain('You are a personal finance advisor');
    await view.get('[data-test="prompt-mode-write"]').trigger('click');
    expect(view.get('[data-test="prompt-mode-write"]').attributes('aria-pressed')).toBe('true');
    const draft = view.get('[data-test="prompt-draft"]');
    expect((draft.element as HTMLTextAreaElement).value).toBe(V2.text);
    expect(view.get('[data-test="save-prompt"]').attributes('disabled')).toBeDefined();
    expect(view.get('[data-test="save-blocked"]').text()).toBe('Save your prompt first, or go back to a saved one (step 3).');
    await draft.setValue(`${V2.text}\n\nAlways end with one next step.`);
    expect(view.get('[data-test="save-prompt"]').text()).toBe('Save prompt as v3');
    await view.get('[data-test="save-prompt"]').trigger('click');
    await settle();
    expect(createPrompt).toHaveBeenCalledWith({ id: 'finance-advisor', base_version: 'v2', text: `${V2.text}\n\nAlways end with one next step.` });
    expect(view.get('[data-test="prompt-saved"]').text()).toBe('Saved as finance-advisor v3 and picked for this agent.');
    expect(view.get('[data-test="prompt-text"]').text()).toContain('Always end with one next step.');
    expect((view.get('[data-test="agent-name"]').element as HTMLInputElement).value).toBe('Hermes, Claude Haiku 5.5, finance-advisor v3');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    const v3 = (await api.prompts()).find((p) => p.id === 'finance-advisor' && p.version === 'v3');
    expect(create.mock.calls[0][0].prompt_sha256).toBe(v3?.sha256);
    expect(v3?.sha256).toMatch(/^sha256:/);
  });
});

describe('Build an agent, fresh-clone QA round 3', () => {
  it('names the agent from what it holds, a changed setting included (M1)', async () => {
    const view = await open();
    await pickHarness(view, 'ownloop');
    const name = () => (view.get('[data-test="agent-name"]').element as HTMLInputElement).value;
    expect(name()).toMatch(/^Own loop, .+, finance-advisor v\d+$/);
    await setNumber(view, 'max_steps', '12');
    expect(name()).toMatch(/^Own loop, .+, finance-advisor v\d+, max steps 12$/);
    await view.get('[data-test="agent-name"]').setValue('Mine');
    await setNumber(view, 'max_steps', '10');
    expect(name()).toBe('Mine');
  });

  it('makes this agent arm A and its fork arm B when the baseline is a fork of it, and says so (minor 13)', async () => {
    const base = configs.find((c) => c.name === 'Prompt v1 on Hermes')!;
    const mine = { ...base, hash: `sha256:a11ce${'0'.repeat(59)}`, name: 'mine', parent_hash: null, created_at: '2026-11-05T14:00:00.000Z' };
    const fork = { ...mine, hash: `sha256:f0f0f${'0'.repeat(59)}`, name: 'the fork', model: 'gemini-3.8-flash', parent_hash: mine.hash, created_at: '2026-11-05T14:05:00.000Z' };
    vi.spyOn(api, 'createConfig').mockResolvedValue(mine as never);
    const view = await open();
    vi.spyOn(api, 'configs').mockResolvedValue([mine, fork] as never);
    await view.get('[data-test="agent-name"]').setValue('mine');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    const q = new URLSearchParams((view.get('[data-test="next-evaluate"]').attributes('href') ?? '').split('?')[1]);
    expect(q.get('a')).toBe(mine.hash);
    expect(q.get('b')).toBe(fork.hash);
    expect(view.get('[data-test="next-evaluate-words"]').text()).toContain(
      'Against the fork, a fork of this agent that differs from it only in the model (Claude Haiku 5.5 vs Gemini 3.8 Flash): this agent is arm A, the baseline, and the fork arm B, the change being tried.',
    );
  });

  it('says why a setting is greyed out in sentences, never "memory: off: the Runner …" (minor 17)', async () => {
    const harnesses = await api.harnesses();
    const adk = harnesses.find((h) => h.name === 'adk')!;
    adk.capabilities.settings.memory = { ...adk.capabilities.settings.memory, supported: false, observed: 'off: the Runner gets no memory service, so nothing is stored or recalled. ADK has memory services; the adapter does not wire them yet' };
    vi.spyOn(api, 'harnesses').mockResolvedValue(harnesses);
    const view = await open();
    await pickHarness(view, 'adk');
    expect(view.get('[data-test="reason-memory"]').text()).toBe(
      'Google ADK does not support memory. The Runner gets no memory service, so nothing is stored or recalled. ADK has memory services; the adapter does not wire them yet.',
    );
  });
});

describe('Build an agent keeps its choices across a link away and Back (destructive review U4)', () => {
  it('finds every choice and an unsaved prompt draft as they were after the page is left and opened again', async () => {
    let view = await open();
    await pickHarness(view, 'langgraph');
    await view.get('[data-test="model-gemini-3.8-flash"] input').setValue(true);
    await view.get('[data-test="prompt-select"]').setValue(V1.sha256);
    await setNumber(view, 'max_steps', '9');
    await view.get('#build-parallel_tool_calls').setValue(true);
    await view.get('[data-test="agent-name"]').setValue('Kept by hand');
    await view.get('[data-test="agent-name"]').trigger('input');
    await view.get('[data-test="prompt-mode-write"]').trigger('click');
    await settle();
    await view.get('[data-test="prompt-draft"]').setValue(`${V1.text}\nA line of my own.`);
    await settle();
    // The i's link to the Harnesses page, then Back: the page is made again from nothing.
    view.unmount();
    view = await open();
    expect(view.get('[data-test="harness-langgraph"]').classes()).toContain('tile--on');
    expect((view.get('[data-test="model-gemini-3.8-flash"] input').element as HTMLInputElement).checked).toBe(true);
    expect((view.get('#build-max_steps').element as HTMLInputElement).value).toBe('9');
    expect((view.get('#build-parallel_tool_calls').element as HTMLInputElement).checked).toBe(true);
    expect((view.get('[data-test="agent-name"]').element as HTMLInputElement).value).toBe('Kept by hand');
    expect((view.get('[data-test="prompt-draft"]').element as HTMLTextAreaElement).value).toBe(`${V1.text}\nA line of my own.`);
    expect(view.get('[data-test="prompt-editor"]').text()).toContain(`Your prompt, from ${V1.id} v1`);
  });

  it('keeps the saved panel too, so Back from the preview still offers what comes next', async () => {
    let view = await open();
    await pickHarness(view, 'ownloop');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(view.find('[data-test="next-steps"]').exists()).toBe(true);
    const status = view.get('[data-test="saved-status"]').text();
    view.unmount();
    view = await open();
    expect(view.get('[data-test="harness-ownloop"]').classes()).toContain('tile--on');
    expect(view.get('[data-test="saved-status"]').text()).toBe(status);
  });

  it('starts fresh, without an error, when storage holds something unreadable or is blocked', async () => {
    window.sessionStorage.setItem('agent-evals-build', '{not json');
    let view = await open();
    expect(view.get('[data-test="harness-hermes"]').classes()).toContain('tile--on');
    view.unmount();
    window.sessionStorage.setItem('agent-evals-build', JSON.stringify({ harness: 'gone', model: 42, prompt: 'sha256:gone', numbers: [], toggles: null }));
    view = await open();
    expect(view.get('[data-test="harness-hermes"]').classes()).toContain('tile--on');
    expect((view.get('[data-test="model-claude-haiku-5-5"] input').element as HTMLInputElement).checked).toBe(true);
    view.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    view = await open();
    await pickHarness(view, 'adk');
    expect(view.get('[data-test="harness-adk"]').classes()).toContain('tile--on');
  });
});

describe('Build an agent while LiteLLM is down (destructive review U8)', () => {
  it('still shows every step when only the models fail, says why in words, and lists them on Try again', async () => {
    const litellm = new ApiError(502, 'litellm_unavailable', 'LiteLLM, the proxy every model call goes through, is not answering', 'Start it with docker compose up -d litellm, then try again.');
    const models = vi.spyOn(api, 'models').mockRejectedValueOnce(litellm);
    const view = await open();
    expect(view.find('[data-test="load-error"]').exists()).toBe(false);
    expect(view.findAll('fieldset.step')).toHaveLength(5);
    const problem = view.get('[data-test="models-problem"]');
    expect(problem.text()).toContain('The models could not be listed, so none can be picked yet: LiteLLM, the proxy every model call goes through, is not answering. Start it with docker compose up -d litellm');
    expect(view.find('[data-test="no-models"]').exists()).toBe(false);
    expect(view.find('[data-test="model-radio"]').exists()).toBe(false);
    expect(view.get('[data-test="save-blocked"]').text()).toBe('The models could not be listed: try again in step 2 once they answer.');
    // The other steps work meanwhile.
    await pickHarness(view, 'ownloop');
    expect(view.get('[data-test="harness-ownloop"]').classes()).toContain('tile--on');
    await view.get('[data-test="models-retry"]').trigger('click');
    await settle();
    expect(models).toHaveBeenCalledTimes(2);
    expect(view.find('[data-test="models-problem"]').exists()).toBe(false);
    expect((view.get('[data-test="model-claude-haiku-5-5"] input').element as HTMLInputElement).checked).toBe(true);
    expect(view.get('[data-test="harness-ownloop"]').classes()).toContain('tile--on');
    expect(view.find('[data-test="save-blocked"]').exists()).toBe(false);
  });

  it('offers to try again when the whole page fails to load', async () => {
    const harnesses = vi.spyOn(api, 'harnesses').mockRejectedValueOnce(new ApiError(502, 'http_502', 'The API is not answering (HTTP 502): check that the stack is running (docker compose ps), then try again'));
    const view = await open();
    expect(view.get('[data-test="load-error"]').text()).toContain('The API is not answering (HTTP 502)');
    await view.get('[data-test="load-retry"]').trigger('click');
    await settle();
    expect(harnesses).toHaveBeenCalledTimes(2);
    expect(view.find('[data-test="load-error"]').exists()).toBe(false);
    expect(view.get('[data-test="harness-hermes"]').classes()).toContain('tile--on');
  });
});

describe('Build an agent during a slow save (destructive review U13)', () => {
  it('locks every choice until the save answers, so the saved panel names what was sent', async () => {
    let answer: (c: never) => void = () => undefined;
    const pending = new Promise<never>((resolve) => {
      answer = resolve;
    });
    const create = vi.spyOn(api, 'createConfig').mockReturnValue(pending);
    const view = await open();
    await pickHarness(view, 'ownloop');
    await view.get('[data-test="agent-name"]').setValue('Slow one');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    const steps = view.findAll('fieldset.step');
    expect(steps).toHaveLength(5);
    for (const step of steps) expect(step.attributes('disabled')).toBeDefined();
    expect(view.get('[data-test="model-gemini-3.8-flash"] input').element.matches(':disabled')).toBe(true);
    expect(view.get('[data-test="agent-name"]').element.matches(':disabled')).toBe(true);
    // A second press while it is on its way sends nothing more.
    await view.get('form').trigger('submit');
    expect(create).toHaveBeenCalledTimes(1);
    answer({ ...OWN_LOOP, name: 'Slow one' } as never);
    await settle();
    for (const step of view.findAll('fieldset.step')) expect(step.attributes('disabled')).toBeUndefined();
    expect(view.get('[data-test="saved-status"]').text()).toContain('Slow one');
  });
});

describe('Build an agent on a fresh database with no key (destructive review U1)', () => {
  const KEYLESS = [
    { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false },
    { name: 'claude-sonnet-5-5', provider: 'anthropic', input_per_mtok: 1, output_per_mtok: 5, key_set: false },
    { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: false },
    { name: 'qwen2.5-7b-local', provider: 'ollama_chat', input_per_mtok: 0, output_per_mtok: 0, key_set: null },
  ];

  function freshKeyless() {
    vi.spyOn(api, 'models').mockResolvedValue(KEYLESS);
    vi.spyOn(api, 'configs').mockResolvedValue([]);
  }

  it('starts on a hosted model, not the local one whose key_set is null, and saves without parallel tool calls', async () => {
    freshKeyless();
    const create = vi.spyOn(api, 'createConfig');
    const view = await open();
    expect((view.get('[data-test="model-claude-haiku-5-5"] input').element as HTMLInputElement).checked).toBe(true);
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe('claude-haiku-5-5');
    expect(create.mock.calls[0][0].settings).not.toHaveProperty('parallel_tool_calls');
    expect(view.find('[data-test="save-error"]').exists()).toBe(false);
  });

  it('says the local model is free and needs no key, never that it costs money, and saves it without parallel tool calls', async () => {
    freshKeyless();
    const create = vi.spyOn(api, 'createConfig');
    const view = await open();
    expect(view.get('[data-test="model-qwen2.5-7b-local"]').text()).toContain('Free: runs on this machine, needs no key');
    expect(view.find('[data-test="model-qwen2.5-7b-local"] [data-test="needs-key"]').exists()).toBe(false);
    await view.get('[data-test="model-qwen2.5-7b-local"] input').setValue(true);
    await settle();
    const note = view.get('[data-test="model-cost-note"]').text();
    expect(note).toContain('it costs nothing per token and needs no key');
    expect(note).toContain('docker compose --profile local-model up -d ollama');
    expect(note).not.toContain('costs money');
    expect(note).not.toContain('API key');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].model).toBe('qwen2.5-7b-local');
    expect(create.mock.calls[0][0].settings).not.toHaveProperty('parallel_tool_calls');
  });

  it('sends parallel tool calls only when ticked, and greys it out after the model refuses it', async () => {
    freshKeyless();
    const refusal = new ApiError(
      400,
      'unsupported_setting',
      'Qwen2.5 7B (local Ollama) (qwen2.5-7b-local) refuses parallel_tool_calls: LiteLLM answered 400. Leave parallel_tool_calls unset for qwen2.5-7b-local',
      'Qwen2.5 7B (local Ollama) rejects parallel_tool_calls: leave it unset, or pick a model that takes it.',
    );
    const create = vi.spyOn(api, 'createConfig').mockRejectedValueOnce(refusal);
    const view = await open();
    await view.get('[data-test="model-qwen2.5-7b-local"] input').setValue(true);
    await view.get('#build-parallel_tool_calls').setValue(true);
    await settle();
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].settings).toEqual({ parallel_tool_calls: true, memory: { enabled: false } });
    expect(view.get('[data-test="save-error"]').text()).toContain('leave it unset, or pick a model that takes it');
    // Learnt: the setting is now greyed out with the model's reason, and the next save leaves it out.
    expect(view.get('#build-parallel_tool_calls').attributes('disabled')).toBeDefined();
    expect(view.get('[data-test="reason-parallel_tool_calls"]').text()).toContain('rejects parallel_tool_calls');
    await view.get('[data-test="save-agent"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].settings).toEqual({ memory: { enabled: false } });
  });
});
