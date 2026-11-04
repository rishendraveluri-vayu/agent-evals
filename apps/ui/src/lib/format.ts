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

/** 14:06:09, for "the update from" a moment ago. */
export function clockSeconds(at: Date | number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: displayTimeZone() }).format(new Date(at));
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

/** A token that reads as code: an underscore (mcp__finance__<name>, max_tokens), a dot or slash
 *  between words (compression.enabled, finance/all, Runner.run), or a keyword argument
 *  (ChatOpenAI(temperature=)). "e.g." and plain words are not. */
const CODE_TOKEN = /_|[A-Za-z]{2,}[./][A-Za-z<]|[A-Za-z]=/;

const countOf = (text: string, ch: string) => text.split(ch).length - 1;

/** Splits running text around literal identifiers, so they can be set in mono and the words
 *  around them in Plex Sans. Punctuation that ends the sentence around one stays with the words,
 *  and a bracket the identifier opened stays with it. With `lone`, text that is one token with no
 *  spaces ("temperature", "ModelCallLimitMiddleware") is an identifier whole: for cells that hold
 *  either a name or a few words, such as how a setting reaches the model. */
export function splitIdents(text: string, opts: { lone?: boolean } = {}): { text: string; ident: boolean }[] {
  const out: { text: string; ident: boolean }[] = [];
  const push = (part: string, ident: boolean) => {
    if (!part) return;
    const last = out[out.length - 1];
    if (last && last.ident === ident && !ident) last.text += part;
    else out.push({ text: part, ident });
  };
  if (opts.lone && text.trim() && !/\s/.test(text.trim())) return [{ text, ident: true }];
  for (const token of text.split(/(\s+)/)) {
    const m = /\S/.test(token) ? token.match(/^([("'[]*)(.*?)([,.;:!?)"'\]]*)$/) : null;
    if (!m) {
      push(token, false);
      continue;
    }
    const lead = m[1];
    let core = m[2];
    let tail = m[3];
    // A closing bracket the identifier opened belongs to it: ChatOpenAI(temperature=).
    for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
      while (tail.startsWith(close) && countOf(core, open) > countOf(core, close)) {
        core += close;
        tail = tail.slice(1);
      }
    }
    if (core && CODE_TOKEN.test(core)) {
      push(lead, false);
      push(core, true);
      push(tail, false);
    } else push(token, false);
  }
  return out;
}

/** Splits text around the given literal identifiers (task ids, say), so a page can set each in
 *  mono and keep it whole: "debt-hardship-03" never breaks at its hyphens. */
export function identParts(text: string, idents: string[]): { text: string; ident: boolean }[] {
  const names = [...new Set(idents)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return text ? [{ text, ident: false }] : [];
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text
    .split(new RegExp(`(${escaped.join('|')})`))
    .map((part, i) => ({ text: part, ident: i % 2 === 1 }))
    .filter((p) => p.text);
}
