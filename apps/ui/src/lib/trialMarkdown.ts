/**
 * An agent's reply on the Trial page, as blocks of text: paragraphs (with the inline Markdown of
 * lib/markdown.ts: bold, italics, bullets, headings), GitHub-style tables and rules. Every block
 * and table cell is a range of the reply's own text, so a highlight (a check's quote, an amount
 * with no source) is placed once on the whole reply and cut at block and cell edges. Nothing here
 * produces HTML: the page renders each piece as a text node.
 */
import type { AmountCheck } from './grading';
import { inlineParts, inlineStyles, type InlinePart, type InlineStyles } from './markdown';

/** A range of the reply's text, [start, end). */
export interface Span {
  start: number;
  end: number;
}

export type Align = 'left' | 'center' | 'right' | null;

export type MessageBlock =
  | { kind: 'para'; start: number; end: number }
  | { kind: 'rule' }
  | { kind: 'table'; head: Span[]; rows: Span[][]; align: Align[] };

/** A thematic break: three or more of one of - * _ alone on a line. */
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** A table's delimiter row: cells of dashes, each with an optional colon either side. */
const DELIM_CELL = /^:?-+:?$/;

/** The cells of a table line at offset `at` in the reply: split at each pipe not escaped, the
 *  outer pipes' empty cells dropped, each cell trimmed. */
function cellsOf(line: string, at: number): Span[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '|') pipes.push(i);
  }
  const edges = [-1, ...pipes, line.length];
  const out: Span[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    let s = edges[k] + 1;
    let e = edges[k + 1];
    while (s < e && /\s/.test(line[s])) s++;
    while (e > s && /\s/.test(line[e - 1])) e--;
    out.push({ start: at + s, end: at + e });
  }
  if (pipes.length && !line.slice(0, pipes[0]).trim()) out.shift();
  if (pipes.length && !line.slice(pipes[pipes.length - 1] + 1).trim()) out.pop();
  return out;
}

/** The alignment of each column, from a delimiter row; null when the line is not one. */
function delimiter(line: string): Align[] | null {
  if (!line.includes('|') || !line.includes('-')) return null;
  const cells = cellsOf(line, 0).map((c) => line.slice(c.start, c.end));
  if (!cells.length || !cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
}

/**
 * The blocks of a reply. With `markdown` off (a client's message), only paragraphs, split at
 * blank lines. With it on, a line with a pipe followed by a delimiter row of as many cells starts
 * a table, which runs to the first blank line or line with no pipe; a line of three dashes,
 * stars or underscores is a rule. A row with more cells than the header keeps them all, so no
 * text is dropped.
 */
export function messageBlocks(text: string, markdown = true): MessageBlock[] {
  const lines: { text: string; start: number }[] = [];
  let at = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, start: at });
    at += line.length + 1;
  }
  const out: MessageBlock[] = [];
  let para: Span | null = null;
  const flush = () => {
    if (para) out.push({ kind: 'para', ...para });
    para = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.text.trim()) {
      flush();
      continue;
    }
    if (markdown && line.text.includes('|') && i + 1 < lines.length) {
      const align = delimiter(lines[i + 1].text);
      const head = cellsOf(line.text, line.start);
      if (align && head.length === align.length) {
        flush();
        const rows: Span[][] = [];
        let j = i + 2;
        for (; j < lines.length && lines[j].text.trim() && lines[j].text.includes('|'); j++) {
          const cells = cellsOf(lines[j].text, lines[j].start);
          const end = lines[j].start + lines[j].text.length;
          while (cells.length < head.length) cells.push({ start: end, end });
          rows.push(cells);
        }
        out.push({ kind: 'table', head, rows, align });
        i = j - 1;
        continue;
      }
    }
    if (markdown && RULE.test(line.text)) {
      flush();
      out.push({ kind: 'rule' });
      continue;
    }
    if (para) para.end = line.start + line.text.length;
    else para = { start: line.start, end: line.start + line.text.length };
  }
  flush();
  return out;
}

// ------------------------------------------------------------------------------- highlights

/** A highlighted passage: the grade it links to, and who quoted it ("the judge for overall
 *  (answered no)"), which a screen reader hears first. */
export interface QuoteMark {
  index: number;
  by: string;
}

export interface Mark<T> extends Span {
  value: T;
}

/** A run of one block's text as shown, with whatever highlights cover it. Only the first piece of
 *  a highlight carries its words for a screen reader (`quoteFirst`, `amountFirst`). */
export interface Piece {
  text: string;
  parts: InlinePart[];
  quote: QuoteMark | null;
  quoteFirst: boolean;
  amount: AmountCheck | null;
  amountFirst: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a quote is in a reply: its first occurrence, comparing runs of whitespace as one, as the
 *  judge grader finds a quote in the material (graders judge.py `locate`). */
export function findQuote(text: string, quote: string): Span | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const m = new RegExp(words.map(escapeRe).join('\\s+')).exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/**
 * The pieces of one block (`span` of the reply `text`), cut at every highlight's edges. `styles`
 * are the block's inline Markdown styles, worked out on the whole block so a highlight inside
 * bold text stays bold; null shows the text as written. `started` holds the highlights already
 * begun in earlier blocks of the same reply.
 */
export function piecesOf(text: string, span: Span, styles: InlineStyles | null, quotes: Mark<QuoteMark>[], amounts: Mark<AmountCheck>[], started: Set<object>): Piece[] {
  const marks = [...quotes, ...amounts];
  const cuts = new Set([span.start, span.end]);
  for (const m of marks) for (const at of [m.start, m.end]) if (at > span.start && at < span.end) cuts.add(at);
  const edges = [...cuts].sort((a, b) => a - b);
  const block = text.slice(span.start, span.end);
  const out: Piece[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const [a, b] = [edges[k], edges[k + 1]];
    const parts = styles ? inlineParts(block, styles, a - span.start, b - span.start) : [{ text: text.slice(a, b), bold: false, italic: false }];
    if (!parts.some((p) => p.text)) continue;
    const q = quotes.find((m) => m.start <= a && m.end >= b) ?? null;
    const am = amounts.find((m) => m.start <= a && m.end >= b) ?? null;
    const first = (m: object | null) => {
      if (!m || started.has(m)) return false;
      started.add(m);
      return true;
    };
    out.push({ text: text.slice(a, b), parts, quote: q?.value ?? null, quoteFirst: first(q), amount: am?.value ?? null, amountFirst: first(am) });
  }
  return out;
}

/** A table cell's or a paragraph's inline styles. */
export const stylesOf = (text: string, span: Span): InlineStyles => inlineStyles(text.slice(span.start, span.end));

/** A quote as a grade card shows it: the Markdown markers the reply had dropped (bold and italic
 *  markers, heading hashes, bullet markers, a table row's outer pipes), the words as written. */
export function quoteText(quote: string): string {
  const lines = quote.split('\n').map((line) => {
    const row = /^\s*\|(.*)\|\s*$/.exec(line);
    return (row ? row[1].trim() : line).replace(/^\s*#{1,6}\s+/, '').replace(/^(\s*)[-*+]\s+/, '$1');
  });
  const joined = lines.join('\n');
  const { hidden } = inlineStyles(joined);
  let out = '';
  for (let i = 0; i < joined.length; i++) if (!hidden[i]) out += joined[i];
  return out;
}
