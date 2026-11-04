/** A capability matrix cell: what the platform knows about one setting on one harness. */
import type { CapabilitySetting } from '../api/types';
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
