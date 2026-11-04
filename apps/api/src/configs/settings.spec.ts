import { ApiError } from '../common/api-error';
import { PLATFORM_DEFAULTS, checkHarnessOptions, resolveSettings } from './settings';

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

describe('resolveSettings', () => {
  it('fills platform defaults for supported settings the config leaves out', () => {
    const { settings, settings_sources } = resolveSettings({ temperature: 0.7 }, HERMES, 'hermes');
    expect(settings).toEqual({ ...PLATFORM_DEFAULTS, temperature: 0.7 });
    expect(settings_sources.temperature).toBe('config');
    expect(settings_sources.max_steps).toBe('platform_default');
    expect(settings_sources.memory).toBe('platform_default');
  });

  it('applies no default to an unsupported setting: it is null with source unsupported', () => {
    const { settings, settings_sources } = resolveSettings({}, NO_MEMORY, 'ownloop');
    expect(settings.memory).toBeNull();
    expect(settings.skills).toBeNull();
    expect(settings.compression).toBeNull();
    expect(settings_sources.memory).toBe('unsupported');
    expect(settings.temperature).toBe(PLATFORM_DEFAULTS.temperature);
  });

  it('refuses an unsupported setting a config sets, naming it (400 unsupported_setting)', () => {
    const err = errorOf(() => resolveSettings({ memory: { enabled: true } }, NO_MEMORY, 'ownloop'));
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({ error: 'unsupported_setting', message: expect.stringContaining('memory') as string });
  });

  it('refuses even an unsupported setting set to its "off" value, since the harness cannot honour it', () => {
    expect(errorOf(() => resolveSettings({ compression: { enabled: false } }, NO_MEMORY, 'ownloop')).code).toBe('unsupported_setting');
  });

  it('treats null as not set', () => {
    const { settings_sources } = resolveSettings({ memory: null, temperature: null }, NO_MEMORY, 'ownloop');
    expect(settings_sources.memory).toBe('unsupported');
    expect(settings_sources.temperature).toBe('platform_default');
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
    expect(errorOf(() => resolveSettings({ [name]: value }, HERMES, 'hermes')).code).toBe('invalid_setting');
  });

  it('refuses a setting name that does not exist', () => {
    expect(errorOf(() => resolveSettings({ temprature: 0.2 }, HERMES, 'hermes')).code).toBe('unknown_setting');
  });

  it('refuses settings that are not an object', () => {
    expect(errorOf(() => resolveSettings([1], HERMES, 'hermes')).code).toBe('invalid_setting');
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
