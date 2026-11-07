/** A capability matrix cell: what the platform knows about one setting on one harness. */
import type { CapabilitySetting, Harness } from '../api/types';
import { plainText } from './format';
import { modelName } from './names';

/** Every string in a value, through plainText; keys and other values as they are. */
function plainDeep<T>(value: T): T {
  if (typeof value === 'string') return plainText(value) as T;
  if (Array.isArray(value)) return value.map(plainDeep) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainDeep(v)])) as T;
  return value;
}

/**
 * The key a probed setting really reached the model under. The probe (probe.py `_sent` in
 * workers/adapterlib) reads a request's `max_completion_tokens` as its `max_tokens` and writes
 * "sent as max_tokens" either way, so ADK's and LangGraph's capability files say "sent as
 * max_tokens" while their own `native`, their known differences and their adapters send
 * `max_completion_tokens` (QA, 7 Nov: the Harnesses page said both). Where `native` names the key
 * a setting is sent as, the observed words take it. The files stay as they are: every config hash
 * covers them (R14), so a re-probe is Rishi's call (docs/known-limits.md, "Harness capabilities").
 */
function sentAsNative(s: CapabilitySetting): CapabilitySetting {
  const key = /\bsent as (max_completion_tokens)\b/.exec(s.native ?? '')?.[1];
  if (!key || !s.observed) return s;
  return { ...s, observed: s.observed.replace(/\bsent as max_tokens\b/g, `sent as ${key}`) };
}

/**
 * GET /harnesses as a screen shows it: each harness's capabilities (its settings' native calls,
 * what was observed, its known differences, its options' descriptions) without the authors'
 * decision-log references, and with each probed setting under the key it is really sent as
 * (sentAsNative). The adapters' capabilities.json files keep both as they are, since every config
 * hash covers those files; only what is shown changes, in one place for every screen.
 */
export function plainHarnesses(harnesses: Harness[]): Harness[] {
  return harnesses.map((h) => {
    const caps = plainDeep(h.capabilities);
    const settings = Object.fromEntries(Object.entries(caps.settings ?? {}).map(([name, s]) => [name, sentAsNative(s)])) as typeof caps.settings;
    return { ...h, capabilities: { ...caps, settings } };
  });
}

export type CellKind = 'probed' | 'declared' | 'none' | 'pending';

export interface MatrixCell {
  kind: CellKind;
  text: string;
  note: string;
}

export function matrixCell(s: CapabilitySetting | undefined): MatrixCell {
  if (!s) return { kind: 'pending', text: 'Not declared', note: '' };
  const effects = Object.entries(s.effect ?? {})
    .filter(([, e]) => e.status === 'inert')
    .map(([model]) => `Inert on ${modelName(model)}`);
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join('. ');
  if (s.evidence === 'none') return { kind: 'pending', text: 'Not probed yet', note: join(...effects) };
  if (!s.supported) return { kind: 'none', text: 'Not supported', note: join(s.observed, ...effects) };
  if (s.evidence.startsWith('probe:')) return { kind: 'probed', text: 'Probed', note: join(s.observed, ...effects) };
  const reason = s.evidence.replace(/^declared:/, '');
  return { kind: 'declared', text: 'Declared', note: join(s.observed || reason.charAt(0).toUpperCase() + reason.slice(1), ...effects) };
}

/** How a harness's settings are known: seen in a probe request, declared by the adapter, or not
 *  probed yet. */
export function coverage(h: Pick<Harness, 'capabilities'>): { probed: number; declared: number; pending: number; total: number } {
  const all = Object.values(h.capabilities.settings);
  const probed = all.filter((s) => s.evidence.startsWith('probe:')).length;
  const pending = all.filter((s) => s.evidence === 'none').length;
  return { probed, declared: all.length - probed - pending, pending, total: all.length };
}

/** "4 probed, 4 declared", "1 declared, 7 not probed yet": the nonzero parts, in that order. */
export function coverageText(h: Pick<Harness, 'capabilities'>): string {
  const c = coverage(h);
  const parts = [c.probed ? `${c.probed} probed` : '', c.declared ? `${c.declared} declared` : '', c.pending ? `${c.pending} not probed yet` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No settings declared';
}
