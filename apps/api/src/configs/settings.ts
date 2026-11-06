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
  parallel_tool_calls: false, // D19: a config setting, off by default (D25 covers sampling settings only)
  memory: { enabled: false }, // R3, R10.8: nothing learns unless the config says so
  skills: { enabled: false },
  compression: { enabled: false },
};

/**
 * Settings a model refuses outright, by the model's LiteLLM name, each with its evidence (D25).
 * A config for that model cannot set them (400 `unsupported_setting` naming the model, with a
 * fix), no platform default is filled in for them, and a simulator on that model is not sent them
 * either. `label` is the name people know the model by, for messages and fixes.
 */
export const MODEL_REJECTS: Readonly<Record<string, { label: string; rejects: Partial<Record<SettingName, string>> }>> = {
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5',
    rejects: {
      temperature: 'the provider answered 400 "`temperature` is deprecated for this model" on 4 Nov (request req_011CghaVC7rWXY8fBDCspAvF)',
    },
  },
  'qwen2.5-7b-local': {
    label: 'Qwen2.5 7B (local Ollama)',
    rejects: {
      parallel_tool_calls:
        'LiteLLM answered 400 "ollama_chat does not support parameters: [\'parallel_tool_calls\']" on 5 Nov (trial t_0mw3bp0xibcca9ddea96a2fd8); drop_params stays off, so the field is left out instead',
    },
  },
};

/** Why `model` refuses the setting, or null if it takes it. */
export function modelRejects(model: string, name: SettingName): string | null {
  return MODEL_REJECTS[model]?.rejects[name] ?? null;
}

/** The name people know the model by ("Claude Haiku 5.5"), else its LiteLLM name. */
export function modelLabel(model: string): string {
  return MODEL_REJECTS[model]?.label ?? model;
}

type Caps = { settings?: Record<string, { supported?: unknown; observed?: unknown }> };

function isToggle(v: unknown): v is Toggle {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    typeof (v as Record<string, unknown>).enabled === 'boolean'
  );
}

/**
 * E9 (6 Nov review): the upper bounds, the same as the UI's (apps/ui/src/lib/limits.ts). A value
 * past them is almost always a typo, and a runaway trial costs money.
 */
export const MAX_STEPS = 200;
/** The UI's cap since SP7, the API's since the review's re-check (6 Nov): past it, a typo is likelier than a plan. */
export const MAX_OUTPUT_TOKENS = 64_000;
export const MAX_TIMEOUT_S = 3600;

/** Why a value is not valid for a setting, or null if it is. */
export function settingProblem(name: SettingName, v: unknown): string | null {
  switch (name) {
    case 'temperature':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2 ? null : 'a number from 0 to 2';
    case 'max_output_tokens':
      return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_OUTPUT_TOKENS ? null : `an integer from 1 to ${MAX_OUTPUT_TOKENS}`;
    case 'max_steps':
      return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_STEPS ? null : `an integer from 1 to ${MAX_STEPS}`;
    case 'timeout_s':
      return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TIMEOUT_S ? null : `a number of seconds above 0 and at most ${MAX_TIMEOUT_S}`;
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

/** The harness's own words for why it cannot take a setting (capabilities.json `observed`). */
function harnessReason(caps: Caps, name: SettingName): string | null {
  const observed = caps.settings?.[name]?.observed;
  return typeof observed === 'string' && observed.trim() ? observed.trim() : null;
}

/**
 * Every setting this harness and model ignore, with a reason the UI can show next to the greyed
 * field: the harness's own words from its capabilities file, or the model's refusal (D25).
 */
export function unsupportedReasons(caps: Caps, harness: string, model: string): Partial<Record<SettingName, string>> {
  const out: Partial<Record<SettingName, string>> = {};
  for (const name of SETTING_NAMES) {
    if (!supports(caps, name)) {
      const why = harnessReason(caps, name);
      out[name] = why ? `${harness} does not support ${name}: ${why}` : `${harness} does not support ${name}`;
    } else if (modelRejects(model, name)) {
      out[name] = `${modelLabel(model)} rejects ${name}, so it is not sent and the provider's default applies`;
    }
  }
  return out;
}

/** Edit distance, for suggesting the setting a misspelt name meant. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** The setting a misspelt name most likely meant: within two edits, else null. */
export function nearestSetting(key: string): SettingName | null {
  let best: SettingName | null = null;
  let bestDistance = 3;
  for (const name of SETTING_NAMES) {
    const d = editDistance(key.toLowerCase(), name);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Checks what a config sets against the harness's capabilities and the model, then fills the
 * full set. A setting the config leaves out (or sets to null):
 * - is null with source `unsupported` if the harness cannot take it;
 * - is null with source `harness_default` (not sent, D25) if its platform default is null or the
 *   model refuses it;
 * - otherwise takes the platform default.
 * Setting one the harness cannot take, or one the model refuses, is a 400 `unsupported_setting`
 * naming the harness or the model (R10.4, D25). Every refusal carries a `fix`. `elsewhere` names,
 * per setting, the harnesses that do take it, so the fix can offer them.
 */
export function resolveSettings(
  given: unknown,
  caps: Caps,
  harness: string,
  model: string,
  elsewhere: Partial<Record<SettingName, string[]>> = {},
): { settings: Settings; settings_sources: SettingsSources; unsupported: Partial<Record<SettingName, string>> } {
  if (given !== undefined && given !== null && (typeof given !== 'object' || Array.isArray(given))) {
    throw badRequest('invalid_setting', 'settings must be an object', 'Send settings as an object of only the ones you set, such as {"max_steps": 10}.');
  }
  const input = (given ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(SETTING_NAMES as readonly string[]).includes(key)) {
      const near = nearestSetting(key);
      throw badRequest(
        'unknown_setting',
        `${key} is not a setting; the settings are ${SETTING_NAMES.join(', ')}`,
        near ? `Did you mean ${near}? Rename ${key} to ${near}.` : `Remove ${key}; options for one harness go in harness_options.`,
      );
    }
  }
  const settings = {} as Record<SettingName, unknown>;
  const sources = {} as SettingsSources;
  for (const name of SETTING_NAMES) {
    const value = input[name];
    const set = value !== undefined && value !== null;
    const rejected = modelRejects(model, name);
    if (set && !supports(caps, name)) {
      const why = harnessReason(caps, name);
      const others = (elsewhere[name] ?? []).filter((h) => h !== harness);
      throw badRequest(
        'unsupported_setting',
        `${harness} does not support ${name}, so a config cannot set it${why ? ` (${why})` : ''}`,
        `${harness} ignores ${name}: leave it unset${others.length ? `, or pick a harness that takes it (${others.join(', ')})` : ''}.`,
      );
    }
    if (set && rejected) {
      const label = modelLabel(model);
      throw badRequest(
        'unsupported_setting',
        `${label} (${model}) refuses ${name}: ${rejected}. Leave ${name} unset for ${model}`,
        `${label} rejects ${name}: leave it unset, or pick a model that takes it.`,
      );
    }
    if (set) {
      const problem = settingProblem(name, value);
      if (problem) throw badRequest('invalid_setting', `${name} must be ${problem}`, `Set ${name} to ${problem}, or leave it unset for the default.`);
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
  return { settings: settings as unknown as Settings, settings_sources: sources, unsupported: unsupportedReasons(caps, harness, model) };
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

/** Validates harness_options against the adapter's harness_options_schema (400 if not). */
export function checkHarnessOptions(options: unknown, schema: unknown, harness: string): JsonObject {
  const value = options ?? {};
  const fix = `Make harness_options fit ${harness}'s harness_options_schema (GET /harnesses), or leave them out.`;
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('invalid_harness_options', 'harness_options must be an object', fix);
  if (typeof schema !== 'object' || schema === null) return value as JsonObject;
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).join('; ');
    throw badRequest('invalid_harness_options', `harness_options do not fit ${harness}'s schema: ${why}`, fix);
  }
  return value as JsonObject;
}
