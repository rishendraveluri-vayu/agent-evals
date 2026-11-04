/** Display text for numbers, money, times and identifiers. Minus signs are U+2212. */
import { displayTimeZone, now } from '../api/mode';

const MINUS = '−';

/** +15, −40, 0 */
export function signed(value: number, digits = 0): string {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return digits ? (0).toFixed(digits) : '0';
  const text = Math.abs(rounded).toFixed(digits);
  return rounded > 0 ? `+${text}` : `${MINUS}${text}`;
}

/** −20 for axis ticks: a sign only below zero. */
export function tick(value: number): string {
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : `${MINUS}${Math.abs(value)}`;
}

export function minus(text: string): string {
  return text.replace(/-/g, MINUS);
}

/** 0.583 → 58% */
export function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** The Wilson score interval for k successes in n trials, at 95% (z = 1.96), as rates from 0 to 1.
 *  It stays inside 0 to 1 and is sensible for small n, where k / n alone says too much. */
export function wilson(k: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** $18.40, $0.18, $0.0021 */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** A limit or budget: $150, $40, or $12.50 when it has cents. */
export function wholeMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  return Number.isInteger(value) ? `$${value}` : money(value);
}

/** +$0.01 */
export function signedMoney(value: number): string {
  const text = money(Math.abs(value));
  if (Number(value.toFixed(4)) === 0) return '$0';
  return value > 0 ? `+${text}` : `${MINUS}${text}`;
}

/** 18,240 */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  return Math.round(value).toLocaleString('en-US');
}

/** 18.2k */
export function thousands(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}

export function seconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  return value >= 10 ? `${value.toFixed(1)} s` : `${value.toFixed(1)} s`;
}

export function minutes(value: number): string {
  if (value < 60) return `${Math.max(1, Math.round(value))} min`;
  const h = Math.floor(value / 60);
  const m = Math.round(value % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "2 h ago", "Yesterday", "Now" against the app's clock (fixed in fixture mode). */
export function relative(iso: string | null | undefined): string {
  if (!iso) return '–';
  const diffMin = (now() - Date.parse(iso)) / 60_000;
  if (diffMin < 2) return 'Now';
  if (diffMin < 60) return `${Math.round(diffMin)} min ago`;
  if (diffMin < 24 * 60) return `${Math.round(diffMin / 60)} h ago`;
  if (diffMin < 48 * 60) return 'Yesterday';
  return `${Math.round(diffMin / (24 * 60))} days ago`;
}

/** 14:06 */
export function clock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone() }).format(new Date(iso));
}

/** The first 7 hex characters of a `sha256:` hash, as git shows a commit. */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '–';
  return hash.replace(/^sha256:/, '').slice(0, 7);
}

/** A git SHA or version: a 40-character SHA is shortened, a version is left alone. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
