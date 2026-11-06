/**
 * What a config's typed values may be, checked before saving so a refusal is said by the field,
 * in words, and Save says why it is off.
 *
 * The lower bounds and types are the API's own (settingProblem in apps/api/src/configs/settings.ts):
 * temperature a number from 0 to 2, max output tokens and max steps whole numbers of at least 1,
 * timeout a number above 0. Since the destructive review (6 Nov) the API also caps max steps at 200
 * and the timeout at 3,600 s, as the UI does; max output tokens has no API cap, so the UI's is its
 * own and its reason says why. A name is capped at NAME_MAX (120) by both.
 */
import type { SettingName } from '../api/types';
import { settingLabel } from './names';

export type NumberSetting = 'temperature' | 'max_output_tokens' | 'max_steps' | 'timeout_s';

interface Limit {
  integer: boolean;
  min: number;
  /** The value must be above `min`, not equal to it (timeout). */
  aboveMin: boolean;
  max: number;
  /** Whether the API itself refuses a value past `max`; when not, the reason says the cap is the UI's. */
  apiMax: boolean;
  /** "a whole number from 1 to 200" */
  words: string;
}

export const SETTING_LIMITS: Record<NumberSetting, Limit> = {
  temperature: { integer: false, min: 0, aboveMin: false, max: 2, apiMax: true, words: 'a number from 0 to 2' },
  max_output_tokens: { integer: true, min: 1, aboveMin: false, max: 64_000, apiMax: true, words: 'a whole number from 1 to 64,000' },
  max_steps: { integer: true, min: 1, aboveMin: false, max: 200, apiMax: true, words: 'a whole number from 1 to 200' },
  timeout_s: { integer: false, min: 0, aboveMin: true, max: 3_600, apiMax: true, words: 'a number of seconds above 0 and at most 3,600 (one hour)' },
};

/** The longest name a config or an agent may have here. */
export const NAME_MAX = 120;

/** A plain decimal: digits, an optional point and fraction, an optional exponent. Not hex, not "Infinity". */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/** Why a typed setting cannot be saved, in words, or null when it can. Empty is unset: the default applies. */
export function settingProblem(name: SettingName, raw: string | undefined | null): string | null {
  const limit = SETTING_LIMITS[name as NumberSetting];
  const value = (raw ?? '').trim();
  if (!limit || !value) return null;
  const label = settingLabel(name);
  const n = Number(value);
  if (!DECIMAL.test(value) || !Number.isFinite(n)) return `${label} must be ${limit.words}; “${value}” is not a number.`;
  if (limit.integer && !Number.isInteger(n)) return `${label} must be ${limit.words}, with no decimals.`;
  if (n < limit.min || (limit.aboveMin && n <= limit.min)) return `${label} must be ${limit.words}.`;
  if (n > limit.max) return limit.apiMax ? `${label} must be ${limit.words}.` : `${label} must be ${limit.words}: more is almost always a typo, and a runaway trial costs money.`;
  return null;
}
