/** The Config screen's editors: a new prompt version (POST /prompts) and seeds (D39). */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import { resetSession } from '../fixtures';
import { settle, useFixtures } from '../test/helpers';
import ConfigView from './ConfigView.vue';

useFixtures();

// The fixtures keep this session's writes (a new prompt version, a saved config), and a new config
// starts from the newest saved one, so each test starts from the untouched sample data.
beforeEach(() => resetSession());

const selectedPrompt = (w: ReturnType<typeof mount>) => (w.get('[data-test="prompt-select"]').element as HTMLSelectElement).selectedOptions[0]?.text;

describe('ConfigView, seeds (D39)', () => {
  it('sends no seed for a config without one, so its hash is unchanged', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    await w.get('[data-test="model-select"]').setValue('claude-haiku-5-5');
    await settle();
    // The same content as a saved config without seeds: the same hash.
    expect(w.get('[data-test="config-hash"]').text()).toBe('7f3a9c2');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].seed).toBeUndefined();
  });

  it('seeds memory only when memory is on, one entry per line, and sends it with the config', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    const seeds = w.get('[data-test="seeds"]');
    expect(seeds.text()).toContain('Turn memory on to seed it.');
    expect(seeds.find('[data-test="seed-memory"]').exists()).toBe(false);
    await w.get('#setting-memory').setValue(true);
    await w.get('[data-test="seed-memory"]').setValue('Client is 34 and lives in Pune\n\n  Prefers plain words over jargon  ');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].seed).toEqual({ memory: ['Client is 34 and lives in Pune', 'Prefers plain words over jargon'], skills: [] });
    expect(create.mock.calls[0][0].settings?.memory).toEqual({ enabled: true });
  });

  it('seeds a skill with a name, a description and a body', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    await w.get('#setting-skills').setValue(true);
    await w.get('[data-test="add-skill"]').trigger('click');
    const skill = w.get('[data-test="seed-skill"]');
    const [name, description] = skill.findAll('input');
    await name.setValue('emi-check');
    await description.setValue('Check an EMI with the tool before quoting it');
    await skill.get('textarea').setValue('Call calculate_emi, then quote its number.');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].seed).toEqual({ memory: [], skills: [{ name: 'emi-check', description: 'Check an EMI with the tool before quoting it', body: 'Call calculate_emi, then quote its number.' }] });
  });

  it('shows a refused seed with its fix in the seeds block', async () => {
    vi.spyOn(api, 'createConfig').mockRejectedValueOnce(new ApiError(400, 'invalid_seed', 'seed.skills[0].name must be lower-case letters, digits and hyphens', 'Rename the skill, for example emi-check.'));
    const w = mount(ConfigView);
    await settle();
    await w.get('#setting-skills').setValue(true);
    await w.get('[data-test="add-skill"]').trigger('click');
    await w.get('[data-test="seed-skill"] input').setValue('EMI Check');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    const refusal = w.get('[data-test="refusal-seed"]');
    expect(refusal.attributes('role')).toBe('alert');
    expect(refusal.text()).toContain('seed.skills[0].name must be lower-case letters, digits and hyphens');
    expect(refusal.text()).toContain('Fix: Rename the skill, for example emi-check.');
  });
});

describe('ConfigView, a new prompt version', () => {
  it('starts from the chosen prompt, saves the edit as the next version through POST /prompts, and picks it', async () => {
    const create = vi.spyOn(api, 'createPrompt');
    const w = mount(ConfigView);
    await settle();
    expect(selectedPrompt(w)).toBe('finance-advisor v2');
    await w.get('[data-test="new-prompt"]').trigger('click');
    const editor = w.get('[data-test="prompt-editor"]');
    const draft = editor.get('[data-test="prompt-draft"]');
    expect((draft.element as HTMLTextAreaElement).value).toContain('Read the person before the numbers.');
    // Nothing to save until the text changes.
    expect(editor.get('[data-test="save-prompt"]').attributes('disabled')).toBeDefined();
    expect(editor.get('[data-test="save-prompt"]').text()).toBe('Save as v3');
    const text = `${(draft.element as HTMLTextAreaElement).value}\n- **Name the rupee cost.** Every recommendation names what it costs in rupees.`;
    await draft.setValue(text);
    expect(editor.get('[data-test="prompt-draft-lines"]').text()).toContain('1 line differs from v2.');
    await editor.get('[data-test="save-prompt"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledWith({ id: 'finance-advisor', base_version: 'v2', text });
    expect(selectedPrompt(w)).toBe('finance-advisor v3');
    expect(w.get('[data-test="prompt-saved"]').text()).toContain('Saved as finance-advisor v3 (configs/prompts/finance-advisor.v3.md)');
    // The config now differs from its baseline by the prompt, and has no hash until saved.
    expect(w.get('[data-test="config-changes"]').text()).toBe('Prompt: v1 to v3');
  });

  it('shows a refused version with the API fix, and keeps the draft', async () => {
    vi.spyOn(api, 'createPrompt').mockRejectedValue(new ApiError(409, 'prompt_text_exists', 'the text is already client-sim v2', 'Edit the text, or pick that prompt.'));
    const w = mount(ConfigView);
    await settle();
    await w.get('[data-test="new-prompt"]').trigger('click');
    await w.get('[data-test="prompt-draft"]').setValue('Something else entirely.');
    await w.get('[data-test="save-prompt"]').trigger('click');
    await settle();
    expect(w.get('[data-test="prompt-refusal"]').text()).toBe('the text is already client-sim v2. Edit the text, or pick that prompt.');
    expect((w.get('[data-test="prompt-draft"]').element as HTMLTextAreaElement).value).toBe('Something else entirely.');
  });
});
