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

/**
 * $18.40, $0.18, $0.0094, $0.0122: cents from $1 up; below $1, three significant figures (with at
 * least the cents, and no trailing zeros past them), so two small amounts side by side always show
 * the difference between them: $0.0094 beside $0.0122, never $0.0094 beside $0.01.
 */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs >= 1) return `$${value.toFixed(2)}`;
  const digits = Math.max(2, 2 - Math.floor(Math.log10(abs)));
  const fixed = value.toFixed(Math.min(digits, 20));
  // Rounding can carry up to $1.00: then it reads as cents, like any amount from $1.
  if (Math.abs(Number(fixed)) >= 1) return `$${Number(fixed).toFixed(2)}`;
  const [whole, frac = ''] = fixed.split('.');
  const trimmed = frac.length > 2 ? frac.replace(/0+$/, '').padEnd(2, '0') : frac;
  return `$${whole}.${trimmed}`;
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

/** The day a time falls on, against the app's clock: null for today, "5 Nov" for another day this
 *  year, "5 Nov 2025" for an earlier year. A time alone reads as today's, so any other day says so
 *  (7 Nov QA: a run from two days before listed its events as 13:02 and 13:35). */
export function dayOf(iso: string): string | null {
  const zone = displayTimeZone();
  const at = new Date(iso);
  const today = new Date(now());
  const ymd = (d: Date) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone }).format(d);
  if (ymd(at) === ymd(today)) return null;
  const year = (d: Date) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: zone }).format(d);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(year(at) === year(today) ? {} : { year: 'numeric' }), timeZone: zone }).format(at);
}

/** 14:06 today; "5 Nov, 14:06" on any other day; with `seconds`, 14:06:09. */
export function stamp(iso: string, seconds = false): string {
  const day = dayOf(iso);
  const time = seconds ? clockSeconds(Date.parse(iso)) : clock(iso);
  return day ? `${day}, ${time}` : time;
}

/** A time inside a sentence, its day always said: "today at 14:06", "on 5 Nov at 14:06". */
export function when(iso: string, seconds = false): string {
  const day = dayOf(iso);
  const time = seconds ? clockSeconds(Date.parse(iso)) : clock(iso);
  return day ? `on ${day} at ${time}` : `today at ${time}`;
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

/** A version as it reads: a sha256 (a judge's rubric, a grader's files) as its first 7 hex, a
 *  40-character git SHA shortened, anything else as it is. */
export function shortVersion(version: string): string {
  return /^(sha256:)?[0-9a-f]{64}$/.test(version) ? shortHash(version) : shortRef(version);
}

/** A harness version as one short token: a git SHA to 7 characters, and a version with its
 *  libraries in brackets ("0.1.0 (openai 2.1.0, mcp 1.9.0)") to the version alone. */
export function harnessVersion(version: string): string {
  if (/^[0-9a-f]{7,40}$/.test(version)) return version.slice(0, 7);
  return version.split(' (')[0].trim() || version;
}

/** Text from the API without the authors' internal references to their own decision log. The
 *  sentence reads the same without them:
 *  - a bracket of nothing else goes: "(R8)", "(D32)", "(SP4)", "(D25, R11b)", "(R10.8)";
 *  - one that opens or closes a longer bracket goes, the rest stays: "(D18; the SDK default is
 *    kept)" and "(D31, prompt_caching off)" become "(the SDK default is kept)" and "(prompt_caching
 *    off)", "(guidance: false, D33)" becomes "(guidance: false)";
 *  - one that labels the text after it goes: "R10.11: one attempt" becomes "one attempt". */
export function plainText(text: string): string {
  const ref = '(?:R|D|SP|A)\\d+[a-z]?(?:\\.\\d+)*';
  const refs = `${ref}(?:,\\s*${ref})*`;
  return text
    .replace(new RegExp(`\\s*\\(${refs}\\)`, 'g'), '')
    .replace(new RegExp(`\\(${refs}[;,]\\s*`, 'g'), '(')
    .replace(new RegExp(`[;,]\\s*${refs}\\)`, 'g'), ')')
    .replace(new RegExp(`(^|[\\s(])${refs}:\\s+`, 'g'), '$1');
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
