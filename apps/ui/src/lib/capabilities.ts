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
 * GET /harnesses as a screen shows it: each harness's capabilities (its settings' native calls,
 * what was observed, its known differences, its options' descriptions) without the authors'
 * decision-log references. The adapters' capabilities.json files keep them, since every config
 * hash covers those files; only what is shown drops them, in one place for every screen.
 */
export function plainHarnesses(harnesses: Harness[]): Harness[] {
  return harnesses.map((h) => ({ ...h, capabilities: plainDeep(h.capabilities) }));
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
