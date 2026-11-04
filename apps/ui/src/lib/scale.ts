/** Axis ranges and ticks for interval figures. */
import { tick } from './format';

/** One estimate and its interval in an IntervalStrip. */
export interface StripRow {
  estimate: number;
  low: number;
  high: number;
  tone: 'a' | 'b' | 'ink' | 'neutral';
  size?: 'lg' | 'sm';
  label?: string;
}

/** An arm's colour only when the result holds up: B's orange when B is better, A's blue when B
 *  is worse, grey when there is no clear difference. */
export function verdictTone(verdict: string): StripRow['tone'] {
  if (verdict === 'better') return 'b';
  if (verdict === 'worse') return 'a';
  return 'neutral';
}

/** A range that holds every value, padded by 5 and snapped outward to multiples of ten, and never
 *  narrower than [floor, ceil]. */
export function domainFor(values: number[], floor: number, ceil: number): [number, number] {
  const lo = Math.min(floor, Math.min(...values) - 5);
  const hi = Math.max(ceil, Math.max(...values) + 5);
  return [Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10];
}

/** The two ends, zero, and multiples of `step` in between that are not crowding an end. */
export function ticksFor(min: number, max: number, step: number, zeroLabel = '0', lastSuffix = '') {
  const values = new Set<number>([min, 0, max]);
  for (let v = Math.ceil(min / step) * step; v < max; v += step) {
    if (v - min >= step / 2 && max - v >= step / 2) values.add(v);
  }
  const sorted = [...values].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
  return sorted.map((value, i) => ({
    value,
    label: value === 0 ? zeroLabel : `${tick(value)}${i === sorted.length - 1 ? lastSuffix : ''}`,
    strong: value === 0,
  }));
}
