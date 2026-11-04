import Ajv2020 from 'ajv/dist/2020';
import type { JsonObject, SettingName, Settings, SettingsSources, Toggle } from '../contract';
import { SETTING_NAMES } from '../contract';
import { badRequest } from '../common/api-error';

/**
 * Platform defaults (D25, 4 Nov), applied only to settings the harness supports (contract v2
 * section 3). A null default means "not sent": the setting stays null in the spec with source
 * `harness_default`, the adapter leaves it out of every request, and the harness's or provider's
 * own default applies, which the trial records in `applied_settings`.
 */
export const PLATFORM_DEFAULTS: Settings = {
  temperature: null, // D25: not sent
  max_output_tokens: 8192, // D25
  max_steps: 15,
  timeout_s: 300,
  parallel_tool_calls: null, // D25: not sent
  memory: { enabled: false }, // R3, R10.8: nothing learns unless the config says so
  skills: { enabled: false },
  compression: { enabled: false },
};

/**
 * Settings a model refuses outright, by the model's LiteLLM name, each with its evidence (D25).
 * A config for that model cannot set them (400 `unsupported_setting` naming the model), no
 * platform default is filled in for them, and a simulator on that model is not sent them either.
 */
export const MODEL_REJECTS: Readonly<Record<string, Partial<Record<SettingName, string>>>> = {
  'claude-haiku-5-5': {
    temperature: 'the provider answered 400 "`temperature` is deprecated for this model" on 4 Nov (request req_011CghaVC7rWXY8fBDCspAvF)',
  },
};

/** Why `model` refuses the setting, or null if it takes it. */
export function modelRejects(model: string, name: SettingName): string | null {
  return MODEL_REJECTS[model]?.[name] ?? null;
}

type Caps = { settings?: Record<string, { supported?: unknown }> };

function isToggle(v: unknown): v is Toggle {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    typeof (v as Record<string, unknown>).enabled === 'boolean'
  );
}

/** Why a value is not valid for a setting, or null if it is. */
export function settingProblem(name: SettingName, v: unknown): string | null {
  switch (name) {
    case 'temperature':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2 ? null : 'a number from 0 to 2';
    case 'max_output_tokens':
    case 'max_steps':
      return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? null : 'an integer of at least 1';
    case 'timeout_s':
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? null : 'a number above 0';
    case 'parallel_tool_calls':
      return typeof v === 'boolean' ? null : 'true or false';
    case 'memory':
    case 'skills':
    case 'compression':
      return isToggle(v) ? null : '{"enabled": true|false}';
  }
}

export function supports(caps: Caps, name: SettingName): boolean {
  return caps.settings?.[name]?.supported === true;
}

/**
 * Checks what a config sets against the harness's capabilities and the model, then fills the
 * full set. A setting the config leaves out (or sets to null):
 * - is null with source `unsupported` if the harness cannot take it;
 * - is null with source `harness_default` (not sent, D25) if its platform default is null or the
 *   model refuses it;
 * - otherwise takes the platform default.
 * Setting one the harness cannot take, or one the model refuses, is a 400 `unsupported_setting`
 * naming the harness or the model (R10.4, D25).
 */
export function resolveSettings(
  given: unknown,
  caps: Caps,
  harness: string,
  model: string,
): { settings: Settings; settings_sources: SettingsSources } {
  if (given !== undefined && given !== null && (typeof given !== 'object' || Array.isArray(given))) {
    throw badRequest('invalid_setting', 'settings must be an object');
  }
  const input = (given ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(SETTING_NAMES as readonly string[]).includes(key)) {
      throw badRequest('unknown_setting', `${key} is not a setting; the settings are ${SETTING_NAMES.join(', ')}`);
    }
  }
  const settings = {} as Record<SettingName, unknown>;
  const sources = {} as SettingsSources;
  for (const name of SETTING_NAMES) {
    const value = input[name];
    const set = value !== undefined && value !== null;
    const rejected = modelRejects(model, name);
    if (set && !supports(caps, name)) {
      throw badRequest('unsupported_setting', `${harness} does not support ${name}, so a config cannot set it`);
    }
    if (set && rejected) {
      throw badRequest('unsupported_setting', `${model} refuses ${name}: ${rejected}. Leave ${name} unset for ${model}`);
    }
    if (set) {
      const problem = settingProblem(name, value);
      if (problem) throw badRequest('invalid_setting', `${name} must be ${problem}`);
    }
    if (!supports(caps, name)) {
      settings[name] = null;
      sources[name] = 'unsupported';
    } else if (set) {
      settings[name] = value;
      sources[name] = 'config';
    } else if (PLATFORM_DEFAULTS[name] === null || rejected) {
      settings[name] = null;
      sources[name] = 'harness_default';
    } else {
      settings[name] = PLATFORM_DEFAULTS[name];
      sources[name] = 'platform_default';
    }
  }
  return { settings: settings as unknown as Settings, settings_sources: sources };
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

/** Validates harness_options against the adapter's harness_options_schema (400 if not). */
export function checkHarnessOptions(options: unknown, schema: unknown, harness: string): JsonObject {
  const value = options ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('invalid_harness_options', 'harness_options must be an object');
  if (typeof schema !== 'object' || schema === null) return value as JsonObject;
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).join('; ');
    throw badRequest('invalid_harness_options', `harness_options do not fit ${harness}'s schema: ${why}`);
  }
  return value as JsonObject;
}
