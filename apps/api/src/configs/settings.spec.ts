import { ApiError } from '../common/api-error';
import { PLATFORM_DEFAULTS, checkHarnessOptions, modelRejects, nearestSetting, resolveSettings, unsupportedReasons } from './settings';
import { configWarnings } from './warnings';

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

  it('does not send an unset temperature: null, source harness_default (D25)', () => {
    const { settings, settings_sources } = resolveSettings({}, HERMES, 'hermes', MODEL);
    expect(settings.temperature).toBeNull();
    expect(settings_sources.temperature).toBe('harness_default');
  });

  it('keeps parallel tool calls off when unset (D19), from the platform default', () => {
    const { settings, settings_sources } = resolveSettings({}, HERMES, 'hermes', MODEL);
    expect(settings.parallel_tool_calls).toBe(false);
    expect(settings_sources.parallel_tool_calls).toBe('platform_default');
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
    expect(err.getResponse()).toEqual({ error: 'unsupported_setting', message: expect.stringContaining('memory') as string, fix: expect.any(String) as string });
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

  it('never sends parallel_tool_calls to the local Qwen, which LiteLLM refuses it for (D25, 5 Nov)', () => {
    const QWEN = 'qwen2.5-7b-local';
    const qwen = resolveSettings({ max_steps: 12 }, NO_MEMORY, 'ownloop', QWEN);
    expect(qwen.settings.parallel_tool_calls).toBeNull();
    expect(qwen.settings_sources.parallel_tool_calls).toBe('harness_default');
    for (const parallel_tool_calls of [false, true]) {
      const err = errorOf(() => resolveSettings({ parallel_tool_calls }, NO_MEMORY, 'ownloop', QWEN));
      expect(err.code).toBe('unsupported_setting');
      expect(err.message).toContain('ollama_chat does not support parameters');
    }
    expect(unsupportedReasons(NO_MEMORY, 'ownloop', QWEN).parallel_tool_calls).toBe('Qwen2.5 7B (local Ollama) rejects parallel_tool_calls, so it is not sent and the provider\'s default applies');
    // Every other model keeps D19's default: off, and sent.
    expect(resolveSettings({}, NO_MEMORY, 'ownloop', MODEL).settings.parallel_tool_calls).toBe(false);
    expect(resolveSettings({}, NO_MEMORY, 'ownloop', HAIKU).settings.parallel_tool_calls).toBe(false);
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

describe('fix hints on refused settings (D25 follow-up)', () => {
  const body = (fn: () => unknown) => errorOf(fn).getResponse() as { error: string; message: string; fix?: string };

  it('tells a Haiku 5.5 config with a temperature to leave it unset or pick another model', () => {
    expect(body(() => resolveSettings({ temperature: 0.37 }, HERMES, 'hermes', HAIKU))).toEqual({
      error: 'unsupported_setting',
      message: expect.stringContaining('Claude Haiku 5.5 (claude-haiku-5-5) refuses temperature') as string,
      fix: 'Claude Haiku 5.5 rejects temperature: leave it unset, or pick a model that takes it.',
    });
  });

  it('gives the harness reason and the harnesses that do take the setting', () => {
    const caps = { settings: { ...NO_MEMORY.settings, memory: { supported: false, observed: 'the loop has no memory' } } };
    const b = body(() => resolveSettings({ memory: { enabled: true } }, caps, 'ownloop', MODEL, { memory: ['hermes', 'ownloop'] }));
    expect(b.message).toBe('ownloop does not support memory, so a config cannot set it (the loop has no memory)');
    expect(b.fix).toBe('ownloop ignores memory: leave it unset, or pick a harness that takes it (hermes).');
    expect(body(() => resolveSettings({ memory: { enabled: true } }, caps, 'ownloop', MODEL)).fix).toBe('ownloop ignores memory: leave it unset.');
  });

  it('says what value a bad setting needs', () => {
    expect(body(() => resolveSettings({ max_steps: 0 }, HERMES, 'hermes', MODEL)).fix).toBe('Set max_steps to an integer from 1 to 200, or leave it unset for the default.');
  });

  it('refuses max_steps above 200 and timeout_s above 3600, as the UI does (E9)', () => {
    expect(body(() => resolveSettings({ max_steps: 201 }, HERMES, 'hermes', MODEL)).message).toBe('max_steps must be an integer from 1 to 200');
    expect(body(() => resolveSettings({ timeout_s: 3600.5 }, HERMES, 'hermes', MODEL)).message).toBe('timeout_s must be a number of seconds above 0 and at most 3600');
    expect(body(() => resolveSettings({ max_output_tokens: 1e300 }, HERMES, 'hermes', MODEL)).message).toBe('max_output_tokens must be an integer of at least 1');
    expect(resolveSettings({ max_steps: 200, timeout_s: 3600 }, HERMES, 'hermes', MODEL).settings).toMatchObject({ max_steps: 200, timeout_s: 3600 });
  });

  it('suggests the setting a misspelt name meant, and where other options go', () => {
    expect(body(() => resolveSettings({ temprature: 0.2 }, HERMES, 'hermes', MODEL)).fix).toBe('Did you mean temperature? Rename temprature to temperature.');
    expect(body(() => resolveSettings({ prompt_cache_markers: false }, HERMES, 'hermes', MODEL)).fix).toContain('harness_options');
    expect(nearestSetting('Max_Step')).toBe('max_steps');
    expect(nearestSetting('banana')).toBeNull();
  });

  it('carries a fix on every 400 a refused setting or option can give', () => {
    const cases: (() => unknown)[] = [
      () => resolveSettings([1], HERMES, 'hermes', MODEL),
      () => resolveSettings({ nope: 1 }, HERMES, 'hermes', MODEL),
      () => resolveSettings({ memory: { enabled: false } }, NO_MEMORY, 'ownloop', MODEL),
      () => resolveSettings({ temperature: 0 }, HERMES, 'hermes', HAIKU),
      () => resolveSettings({ temperature: 9 }, HERMES, 'hermes', MODEL),
      () => checkHarnessOptions([], {}, 'hermes'),
      () => checkHarnessOptions({ nope: 1 }, { type: 'object', additionalProperties: false }, 'hermes'),
    ];
    for (const fn of cases) expect(body(fn).fix).toEqual(expect.any(String));
  });
});

describe('unsupportedReasons', () => {
  it('lists what the harness ignores in its own words, and what the model refuses', () => {
    const caps = { settings: { ...NO_MEMORY.settings, skills: { supported: false, observed: 'LangGraph has no skills' } } };
    expect(unsupportedReasons(caps, 'langgraph', HAIKU)).toEqual({
      temperature: "Claude Haiku 5.5 rejects temperature, so it is not sent and the provider's default applies",
      memory: 'langgraph does not support memory',
      skills: 'langgraph does not support skills: LangGraph has no skills',
      compression: 'langgraph does not support compression',
    });
    expect(unsupportedReasons(HERMES, 'hermes', MODEL)).toEqual({});
  });

  it('comes back with every resolved config', () => {
    expect(resolveSettings({}, NO_MEMORY, 'ownloop', MODEL).unsupported).toMatchObject({ memory: expect.any(String) as string });
  });
});

describe('configWarnings', () => {
  it.each([
    ['gpt-5-mini', 'drops any temperature other than 1'],
    ['GPT-5.5', 'drops any temperature other than 1'],
    ['o1-preview', 'sends temperature 1'],
    ['o3', 'role developer'],
    ['gpt-6-luna', 'Responses API'],
    ['my-codex-alias', 'Responses API'],
  ])('warns that LangGraph rewrites the request for %s', (model, change) => {
    const [w, ...rest] = configWarnings('langgraph', model);
    expect(rest).toEqual([]);
    expect(w.code).toBe('langgraph_model_name_rewrite');
    expect(w.message).toMatch(/^LangGraph changes the request for this model name/);
    expect(w.message).toContain(change);
    expect(w.fix).toContain('LiteLLM name');
  });

  it('lists every rule a name hits in one warning', () => {
    const [w] = configWarnings('langgraph', 'o1-mini');
    expect(w.message).toContain('sends temperature 1');
    expect(w.message).toContain('role developer');
  });

  it.each([
    ['langgraph', 'claude-haiku-5-5'],
    ['langgraph', 'gemini-3.8-flash'],
    ['langgraph', 'gpt-5-chat-latest'], // gpt-5-chat takes temperature (base.py:1369)
    ['langgraph', 'openai/gpt-5'], // the rule tests the name as LangGraph gets it
    ['langgraph', 'O3'], // ^o\\d is case-sensitive
    ['ownloop', 'gpt-5-mini'],
    ['hermes', 'o3'],
  ])('does not warn for %s with %s', (harness, model) => {
    expect(configWarnings(harness, model)).toEqual([]);
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
