import { ApiError } from '../common/api-error';
import { PLATFORM_DEFAULTS, checkHarnessOptions, modelRejects, resolveSettings } from './settings';

const all = (supported: boolean) =>
  Object.fromEntries(
    ['temperature', 'max_output_tokens', 'max_steps', 'timeout_s', 'parallel_tool_calls', 'memory', 'skills', 'compression'].map((n) => [
      n,
      { supported, evidence: 'none' },
    ]),
  );

/** Like the four non-Hermes harnesses: no memory, skills or compression. */
const NO_MEMORY = { settings: { ...all(true), memory: { supported: false }, skills: { supported: false }, compression: { supported: false } } };
const HERMES = { settings: all(true) };

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

const MODEL = 'fake/finance-emi';
const HAIKU = 'claude-haiku-5-5';

describe('resolveSettings', () => {
  it('fills platform defaults for supported settings the config leaves out', () => {
    const { settings, settings_sources } = resolveSettings({ temperature: 0.7 }, HERMES, 'hermes', MODEL);
    expect(settings).toEqual({ ...PLATFORM_DEFAULTS, temperature: 0.7 });
    expect(settings_sources.temperature).toBe('config');
    expect(settings_sources.max_steps).toBe('platform_default');
    expect(settings_sources.memory).toBe('platform_default');
  });

  it('has the D25 platform defaults: 8192 output tokens, 15 steps, 300 s, features off', () => {
    const { settings, settings_sources } = resolveSettings({}, HERMES, 'hermes', MODEL);
    expect(settings).toMatchObject({ max_output_tokens: 8192, max_steps: 15, timeout_s: 300, memory: { enabled: false } });
    expect(settings_sources).toMatchObject({ max_output_tokens: 'platform_default', max_steps: 'platform_default', timeout_s: 'platform_default' });
  });

  it('does not send an unset temperature or parallel_tool_calls: null, source harness_default (D25)', () => {
    const { settings, settings_sources } = resolveSettings({}, HERMES, 'hermes', MODEL);
    expect(settings.temperature).toBeNull();
    expect(settings.parallel_tool_calls).toBeNull();
    expect(settings_sources.temperature).toBe('harness_default');
    expect(settings_sources.parallel_tool_calls).toBe('harness_default');
  });

  it('still takes either when the config sets it, false included', () => {
    const { settings, settings_sources } = resolveSettings({ temperature: 0, parallel_tool_calls: false }, HERMES, 'hermes', MODEL);
    expect(settings).toMatchObject({ temperature: 0, parallel_tool_calls: false });
    expect(settings_sources).toMatchObject({ temperature: 'config', parallel_tool_calls: 'config' });
  });

  it('applies no default to an unsupported setting: it is null with source unsupported', () => {
    const { settings, settings_sources } = resolveSettings({}, NO_MEMORY, 'ownloop', MODEL);
    expect(settings.memory).toBeNull();
    expect(settings.skills).toBeNull();
    expect(settings.compression).toBeNull();
    expect(settings_sources.memory).toBe('unsupported');
    expect(settings.max_steps).toBe(PLATFORM_DEFAULTS.max_steps);
  });

  it('refuses an unsupported setting a config sets, naming it (400 unsupported_setting)', () => {
    const err = errorOf(() => resolveSettings({ memory: { enabled: true } }, NO_MEMORY, 'ownloop', MODEL));
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({ error: 'unsupported_setting', message: expect.stringContaining('memory') as string });
  });

  it('refuses even an unsupported setting set to its "off" value, since the harness cannot honour it', () => {
    expect(errorOf(() => resolveSettings({ compression: { enabled: false } }, NO_MEMORY, 'ownloop', MODEL)).code).toBe('unsupported_setting');
  });

  it('treats null as not set', () => {
    const { settings_sources } = resolveSettings({ memory: null, temperature: null }, NO_MEMORY, 'ownloop', MODEL);
    expect(settings_sources.memory).toBe('unsupported');
    expect(settings_sources.temperature).toBe('harness_default');
  });

  it('refuses a setting the model rejects, naming the model (D25: temperature on Haiku 5.5)', () => {
    for (const temperature of [0.37, 0, 1]) {
      const err = errorOf(() => resolveSettings({ temperature }, HERMES, 'hermes', HAIKU));
      expect(err.getStatus()).toBe(400);
      expect(err.code).toBe('unsupported_setting');
      expect(err.message).toContain(HAIKU);
      expect(err.message).toContain('temperature');
      expect(err.message).toContain('`temperature` is deprecated for this model');
    }
    expect(modelRejects(HAIKU, 'temperature')).toEqual(expect.any(String));
    expect(modelRejects(HAIKU, 'max_output_tokens')).toBeNull();
    expect(modelRejects('gemini-3.8-flash', 'temperature')).toBeNull();
  });

  it('takes a Haiku config that leaves temperature unset, and the same temperature on another model', () => {
    const haiku = resolveSettings({ max_steps: 8 }, HERMES, 'hermes', HAIKU);
    expect(haiku.settings.temperature).toBeNull();
    expect(haiku.settings_sources.temperature).toBe('harness_default');
    expect(haiku.settings.max_steps).toBe(8);
    expect(resolveSettings({ temperature: 0.37 }, HERMES, 'hermes', 'gemini-3.8-flash').settings.temperature).toBe(0.37);
  });

  it('names the harness, not the model, when the harness is what cannot take the setting', () => {
    const noTemp = { settings: { ...HERMES.settings, temperature: { supported: false } } };
    expect(errorOf(() => resolveSettings({ temperature: 0.2 }, noTemp, 'someharness', HAIKU)).message).toContain('someharness does not support temperature');
  });

  it.each([
    ['temperature', 3],
    ['temperature', '0.2'],
    ['max_output_tokens', 0],
    ['max_steps', 2.5],
    ['timeout_s', 0],
    ['parallel_tool_calls', 'no'],
    ['memory', true],
    ['skills', { enabled: true, extra: 1 }],
  ])('refuses %s = %p (400 invalid_setting)', (name, value) => {
    expect(errorOf(() => resolveSettings({ [name]: value }, HERMES, 'hermes', MODEL)).code).toBe('invalid_setting');
  });

  it('refuses a setting name that does not exist', () => {
    expect(errorOf(() => resolveSettings({ temprature: 0.2 }, HERMES, 'hermes', MODEL)).code).toBe('unknown_setting');
  });

  it('refuses settings that are not an object', () => {
    expect(errorOf(() => resolveSettings([1], HERMES, 'hermes', MODEL)).code).toBe('invalid_setting');
  });
});

describe('checkHarnessOptions', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { prompt_cache_markers: { type: 'boolean' } } };

  it('accepts options that fit the adapter schema, and none at all', () => {
    expect(checkHarnessOptions({ prompt_cache_markers: false }, schema, 'hermes')).toEqual({ prompt_cache_markers: false });
    expect(checkHarnessOptions(undefined, schema, 'hermes')).toEqual({});
  });

  it('refuses options outside the schema (400 invalid_harness_options)', () => {
    expect(errorOf(() => checkHarnessOptions({ nope: 1 }, schema, 'hermes')).code).toBe('invalid_harness_options');
    expect(errorOf(() => checkHarnessOptions({ prompt_cache_markers: 'yes' }, schema, 'hermes')).code).toBe('invalid_harness_options');
    expect(errorOf(() => checkHarnessOptions([], schema, 'hermes')).code).toBe('invalid_harness_options');
  });
});
