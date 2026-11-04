import { describe, expect, it } from 'vitest';
import type { ConfigView } from '../api/types';
import configsJson from '../fixtures/configs.json';
import { armValue, armsCheck, autoConfigName, changeWords, changesWords, configChanges, localDiff, runAutoName } from './checks';

const configs = configsJson as unknown as ConfigView[];
// The fixtures, oldest first: v1 on Hermes, v2 on Hermes (the prompt), the own loop (the harness),
// v1 on Hermes with Gemini Flash (the model).
const [v1, v2, ownloop, gemini] = configs;

/** Two own-loop fake configs that differ only in max steps, both auto-named the same way before
 *  QA round 3 ("Prompt v1 on Own loop, Fake model finance-emi"). */
const fakeOwnLoop = (maxSteps: number, hash: string): ConfigView => ({
  ...ownloop,
  hash,
  name: 'Prompt v1 on Own loop, Fake model finance-emi',
  model: 'fake/finance-emi',
  settings: { ...ownloop.settings, max_steps: maxSteps },
});
const ten = fakeOwnLoop(10, 'sha256:2cc0564' + '0'.repeat(57));
const twelve = fakeOwnLoop(12, 'sha256:fb19a82' + '0'.repeat(57));

describe('what two configs differ in, in words (QA round 3, M1)', () => {
  it('names the one thing and both values', () => {
    const [steps] = configChanges(ten, twelve);
    expect(configChanges(ten, twelve)).toHaveLength(1);
    expect(changeWords(steps)).toBe('Max steps 10 vs 12');
    expect([armValue(steps, 'a'), armValue(steps, 'b')]).toEqual(['max steps 10', 'max steps 12']);
    expect(configChanges(v1, v2).map(changeWords)).toEqual(['Prompt v1 vs v2']);
    expect(configChanges(v1, gemini).map(changeWords)).toEqual(['Claude Haiku 5.5 vs Gemini 3.8 Flash']);
    expect(armValue(configChanges(v1, gemini)[0], 'b')).toBe('Gemini 3.8 Flash');
  });

  it('counts a change of harness once, with the settings only one harness takes and its version', () => {
    const changes = configChanges(v1, ownloop);
    expect(changes.map(changeWords)).toEqual(['Hermes Agent vs Own loop']);
  });

  it('says every change in the settings’ own order, a name kept capitalised, the rest lower case', () => {
    const both = { ...twelve, model: 'claude-haiku-5-5', settings: { ...twelve.settings, temperature: 0.3 } };
    expect(changesWords(configChanges(ten, both))).toBe('Fake model finance-emi vs Claude Haiku 5.5, temperature not sent vs 0.3 and max steps 10 vs 12');
  });

  it('never lists bookkeeping: a name, or where a setting came from', () => {
    const renamed = { ...ten, name: 'another name', settings_sources: { ...ten.settings_sources, parallel_tool_calls: 'config' as const } };
    expect(configChanges(ten, renamed)).toEqual([]);
  });

  it('tells two toolsets of one name apart by their hashes, and a harness version by its ref', () => {
    const older = { ...ownloop, toolset: { ...ownloop.toolset, sha256: 'sha256:e8a33031' + '0'.repeat(56) }, capabilities_sha256: 'sha256:0ld0000' + '0'.repeat(57) };
    const changes = configChanges(older, ownloop);
    // The main text names what changed; the hashes stay in the values, for a label or Details.
    expect(changes.map(changeWords)).toEqual(['The Own loop capabilities file', "The finance all toolset's content"]);
    expect(changes.map((c) => armValue(c, 'a'))).toEqual(['Own loop version capabilities 0ld0000', 'toolset all (e8a3303)']);
    expect(changesWords(changes)).toBe("The Own loop capabilities file and the finance all toolset's content");
    const newerRef = { ...ownloop, harness_ref: '7f3a9c2' + '0'.repeat(33) };
    expect(configChanges({ ...ownloop, harness_ref: '6112c2a' + '0'.repeat(33) }, newerRef).map(changeWords)).toEqual(['Own loop version 6112c2a vs 7f3a9c2']);
  });
});

describe('the Run screen’s check of the arms, in words (QA round 3, minor 4)', () => {
  it('says the change and both values, with the field paths only in Details', () => {
    const check = armsCheck(localDiff(ten, twelve), false, [ten, twelve]);
    expect(check).toMatchObject({ ok: true, title: 'Only the max steps setting differs between the arms', detail: 'Checked from the two saved configs: Max steps 10 vs 12. Nothing else differs.' });
    expect(check.detail).not.toMatch(/settings\.|_/);
    expect(check.raw).toBe('settings.max_steps: 10 to 12');
  });

  it('says a harness change brings its version and settings, never listing their paths', () => {
    const check = armsCheck(localDiff(v1, ownloop), false, [v1, ownloop]);
    expect(check.detail).toBe('Checked from the two saved configs: Hermes Agent vs Own loop, with the harness version and any setting only one of the two takes, which come with the harness. Nothing else differs.');
    expect(check.detail).not.toMatch(/capabilities_sha256|harness_ref|settings\.|\{/);
    expect(check.raw).toContain('capabilities_sha256');
  });
});

describe('a run’s default name says what differs, never "X vs X" (QA round 3, M1)', () => {
  it('names the one change and what the arms share', () => {
    expect(runAutoName(ten, twelve, '15 tasks')).toBe('Max steps 10 vs 12 on Own loop with Fake model finance-emi, 15 tasks');
    expect(runAutoName(v1, v2, 'held-out')).toBe('Prompt v1 vs v2 on Hermes with Claude Haiku 5.5, held-out');
    expect(runAutoName(v1, gemini, 'all tasks')).toBe('Claude Haiku 5.5 vs Gemini 3.8 Flash on Hermes, all tasks');
    expect(runAutoName(v1, ownloop, 'all tasks')).toBe('Hermes Agent vs Own loop on Claude Haiku 5.5, all tasks');
  });

  it('names arms that differ in more than one thing by their configs, or by every change when the names are the same', () => {
    expect(runAutoName(v2, gemini, '3 tasks')).toBe('Prompt v2 on Hermes vs Prompt v1 on Hermes, Gemini Flash, 3 tasks');
    const both = { ...twelve, settings: { ...twelve.settings, temperature: 0.3 } };
    const name = runAutoName(ten, both, '15 tasks');
    expect(name).toBe('Temperature not sent vs 0.3 and max steps 10 vs 12 on Own loop with Fake model finance-emi, 15 tasks');
    expect(name).not.toContain(' vs Prompt v1 on Own loop');
  });

  it('names one arm by its config, and keeps to the API’s 200 characters', () => {
    expect(runAutoName(v1, undefined, 'held-out')).toBe('Prompt v1 on Hermes, held-out');
    const long = { ...v1, name: 'N'.repeat(150) };
    const other = { ...v2, name: 'M'.repeat(150) };
    const name = runAutoName(long, { ...other, model: 'gemini-3.8-flash' }, '15 tasks');
    expect(name.length).toBe(200);
    expect(name.endsWith('…')).toBe(true);
  });
});

describe('a config’s auto-name tells it from its relatives (QA round 3, M1)', () => {
  const content = (c: ConfigView) => ({ harness: c.harness, model: c.model, prompt: c.prompt, settings: c.settings, harness_options: c.harness_options, seed: c.seed, toolset: c.toolset });

  it('says the harness, model and prompt, then each setting away from the platform default', () => {
    expect(autoConfigName({ harness: 'ownloop', model: 'fake/finance-emi', prompt: { id: 'finance-advisor', version: 'v1' }, settings: { max_steps: 15, memory: { enabled: false } } })).toBe(
      'Own loop, Fake model finance-emi, finance-advisor v1',
    );
    expect(autoConfigName(content(twelve), ten)).toBe('Own loop, Fake model finance-emi, finance-advisor v1, max output tokens 1,024, max steps 12, timeout 180 s');
    expect(autoConfigName(content(ten), twelve)).not.toBe(autoConfigName(content(twelve), ten));
  });

  it('follows the content: a fork moved to another model or prompt never keeps its parent’s words', () => {
    const fork = { ...content(v1), model: 'claude-sonnet-5-5' };
    expect(autoConfigName(fork, v1)).toMatch(/^Hermes, Claude Sonnet 5\.5, finance-advisor v1/);
    expect(autoConfigName({ ...content(v1), prompt: v2.prompt }, v1)).toMatch(/^Hermes, Claude Haiku 5\.5, finance-advisor v2/);
  });

  it('says a toggle that is on, a seed, and a toolset that differs from the relative', () => {
    const plain = { harness: 'hermes', model: 'claude-haiku-5-5', prompt: v1.prompt, settings: { memory: { enabled: true } }, seed: { memory: ['Prefers Hindi terms'], skills: [] }, toolset: { id: 'finance', version: 'v2', sha256: 'sha256:other' } };
    expect(autoConfigName(plain, v1)).toBe('Hermes, Claude Haiku 5.5, finance-advisor v1, memory on, seeded with 1 memory entry, toolset finance v2');
    // Past 120 characters, the settings it shares with the relative go first (here max output
    // tokens, max steps and timeout, which v1 sets too).
    const seeded = { ...plain, settings: { ...v1.settings, memory: { enabled: true } } };
    expect(autoConfigName(seeded, v1)).toBe('Hermes, Claude Haiku 5.5, finance-advisor v1, memory on, seeded with 1 memory entry, toolset finance v2');
  });

  it('keeps to NAME_MAX, leaving out what the relative shares first', () => {
    const busy = { ...content(v1), harness: 'openai-agents', model: 'gemini-3.8-flash', prompt: { id: 'finance-advisor-with-a-long-name', version: 'v12' }, settings: { ...v1.settings, temperature: 0.7, parallel_tool_calls: true, max_output_tokens: 4096, max_steps: 40, timeout_s: 900 } };
    const name = autoConfigName(busy, { ...v1, settings: { ...v1.settings, temperature: 0.7, parallel_tool_calls: true, max_output_tokens: 4096, timeout_s: 900 } });
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name).toContain('max steps 40');
    expect(name).not.toContain('timeout');
  });
});
