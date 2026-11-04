import Ajv2020 from 'ajv/dist/2020';
import type { JsonObject, SettingName, Settings, SettingsSources, Toggle } from '../contract';
import { SETTING_NAMES } from '../contract';
import { badRequest } from '../common/api-error';

/**
 * Platform defaults, applied only to settings the harness supports (contract v2 section 3).
 * Not yet a decision of Rishi's: these are the values of the contract's own spec example
 * (docs/adapter-contract.md section 3), the closest thing the docs have to defaults.
 */
export const PLATFORM_DEFAULTS: Settings = {
  temperature: 0.2,
  max_output_tokens: 1024,
  max_steps: 15,
  timeout_s: 300,
  parallel_tool_calls: false, // D19
  memory: { enabled: false }, // R3, R10.8: nothing learns unless the config says so
  skills: { enabled: false },
  compression: { enabled: false },
};

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
 * Checks what a config sets against the harness's capabilities, then fills the full set.
 * A setting the config leaves out (or sets to null) takes the platform default if the harness
 * supports it, and is null with source `unsupported` if not. Setting an unsupported one is a
 * 400 `unsupported_setting` naming it (R10.4).
 */
export function resolveSettings(
  given: unknown,
  caps: Caps,
  harness: string,
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
    if (set && !supports(caps, name)) {
      throw badRequest('unsupported_setting', `${harness} does not support ${name}, so a config cannot set it`);
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
