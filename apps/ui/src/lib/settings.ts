/** Settings in words: a value as the config holds it, and where it came from (R11b). */
import type { CapabilitySetting, ConfigView, SettingName, SettingSource } from '../api/types';
import { text } from '../trials';

/** Memory, skills and compression are `{enabled}` in the contract. */
export function toggleValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { enabled?: unknown }).enabled === 'boolean') return (value as { enabled: boolean }).enabled;
  return null;
}

export function settingValue(name: SettingName, value: unknown): string {
  if (value === null || value === undefined) return 'Not sent';
  const toggle = toggleValue(value);
  if (toggle !== null) return toggle ? 'On' : 'Off';
  if (name === 'timeout_s' && typeof value === 'number') return `${value} s`;
  return text(value);
}

/** "Set in this config", "Platform default", "Not sent: Hermes's own default applies (on)". */
export function sourceWords(source: SettingSource | undefined, harness: string, cap: CapabilitySetting | undefined): string {
  switch (source) {
    case 'config':
      return 'Set in this config';
    case 'platform_default':
      return 'Platform default';
    case 'harness_default': {
      const d = cap?.default;
      const own = d === undefined || d === null ? '' : ` (${typeof d === 'boolean' ? (d ? 'on' : 'off') : text(d)})`;
      return `Not sent: ${harness}'s own default applies${own}`;
    }
    case 'unsupported':
      return `Ignored: ${harness} cannot take it`;
    default:
      return source ?? 'Not recorded';
  }
}

/**
 * Why a setting is ignored for this harness and model before the config is saved: the harness's
 * own words from its capabilities, or the model's refusal as the API states it on any saved config
 * with the same model (the API's `unsupported` names the model's refusals on every config read).
 */
export function ignoredReasons(harness: string, caps: Record<string, CapabilitySetting> | undefined, model: string, saved: ConfigView[]): Partial<Record<SettingName, string>> {
  const out: Partial<Record<SettingName, string>> = {};
  for (const c of saved) {
    if (c.model !== model) continue;
    for (const [name, reason] of Object.entries(c.unsupported ?? {}) as [SettingName, string][]) {
      // A refusal on a setting that config's harness supports is the model's, so it holds here too.
      if (c.settings_sources[name] !== 'unsupported' && caps?.[name]?.supported) out[name] = reason;
    }
  }
  for (const [name, cap] of Object.entries(caps ?? {}) as [SettingName, CapabilitySetting][]) {
    if (!cap.supported) out[name] = cap.observed ? `${harness} does not support ${name}: ${cap.observed}` : `${harness} does not support ${name}`;
  }
  return out;
}
