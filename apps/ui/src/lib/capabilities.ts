/** A capability matrix cell: what the platform knows about one setting on one harness. */
import type { CapabilitySetting, Harness } from '../api/types';
import { modelName } from './names';

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
  if (s.evidence === 'none') return { kind: 'pending', text: 'Probe pending', note: join(...effects) };
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
