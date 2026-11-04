/**
 * Grades and checks as the Trial page shows them.
 *
 * The contract types a grade's `evidence` as loose JSON, and the grading module that writes it is
 * still being built, so this file is the one place that reads it. It accepts the shapes a grader
 * is likely to write and keeps whatever it cannot read as plain text, so a grade is never hidden:
 * - a string: the reason;
 * - a list of strings: quotes from the answer;
 * - an object with any of `name`/`criterion`/`check`, `reason`/`rationale`/`explanation`,
 *   and `quotes`/`quote`/`evidence` (a string or a list of strings).
 *
 * `checks.json` (the number-provenance check, PROVISIONAL: not in the contract yet) is read the
 * same way: any list of amounts `{text, supported, source?}` under `amounts`, `numbers` or
 * `items`, at the top or inside `checks[]`.
 */
import type { Grade, Json } from '../api/types';

export type GradeVerdict = 'pass' | 'fail' | 'other';

export interface GradeView {
  index: number;
  id: number | null;
  graderId: string;
  graderVersion: string;
  kind: string;
  /** The check in words, or the grader's id when the evidence does not name it. */
  name: string;
  verdict: GradeVerdict;
  /** The verdict as the grader wrote it, for a verdict that is neither pass nor fail. */
  rawVerdict: string | null;
  score: number | null;
  reason: string | null;
  /** Passages of the answer the grader quoted. */
  quotes: string[];
  judgeModel: string | null;
  runIndex: number;
}

type Obj = { [key: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const firstString = (o: Obj, keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
};
const strings = (v: Json | undefined): string[] => {
  if (typeof v === 'string') return v.trim() ? [v] : [];
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === 'string' && x.trim() ? [x] : isObj(x) ? strings(x.text ?? x.quote) : []));
  return [];
};

export function verdictOf(raw: string | null, score: number | null): GradeVerdict {
  const v = raw?.toLowerCase().trim();
  if (v === 'pass' || v === 'passed' || v === 'yes' || v === 'true') return 'pass';
  if (v === 'fail' || v === 'failed' || v === 'no' || v === 'false') return 'fail';
  if (v === undefined && score !== null) return score >= 1 ? 'pass' : score <= 0 ? 'fail' : 'other';
  return 'other';
}

export function gradeView(g: Grade, index: number): GradeView {
  const e = g.evidence;
  let name: string | null = null;
  let reason: string | null = null;
  let quotes: string[] = [];
  if (typeof e === 'string') reason = e;
  else if (Array.isArray(e)) quotes = strings(e);
  else if (isObj(e)) {
    name = firstString(e, ['name', 'criterion', 'check', 'title']);
    reason = firstString(e, ['reason', 'rationale', 'explanation', 'why']);
    quotes = [...strings(e.quotes), ...strings(e.quote), ...(typeof e.evidence === 'string' || Array.isArray(e.evidence) ? strings(e.evidence) : [])];
    if (!reason && !quotes.length && Object.keys(e).length) reason = JSON.stringify(e);
  }
  return {
    index,
    id: typeof g.id === 'number' ? g.id : null,
    graderId: g.grader_id,
    graderVersion: g.grader_version,
    kind: g.kind,
    name: name ?? g.grader_id,
    verdict: verdictOf(g.verdict, g.score),
    rawVerdict: g.verdict,
    score: g.score,
    reason,
    quotes,
    judgeModel: g.judge_model,
    runIndex: g.run_index,
  };
}

// ---------------------------------------------------------------------------------- checks.json

export interface AmountCheck {
  /** The amount as it appears in the answer: "₹7,10,870". */
  text: string;
  supported: boolean;
  /** Where it came from when supported: a tool, or the client's own words. */
  source: string | null;
  /** UTF-16 offsets in the final answer, when the check gives them. */
  start: number | null;
  end: number | null;
}

export interface ProvenanceView {
  amounts: AmountCheck[];
  unsupported: AmountCheck[];
}

function amountList(v: Json | undefined): AmountCheck[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (!isObj(x)) return [];
    const text = firstString(x, ['text', 'raw', 'match', 'amount']);
    const ok = x.supported ?? x.grounded ?? x.found ?? x.ok;
    if (!text || typeof ok !== 'boolean') return [];
    const source = firstString(x, ['source', 'tool', 'from']) ?? (Array.isArray(x.sources) ? strings(x.sources).join(', ') || null : null);
    const start = typeof x.start === 'number' ? x.start : null;
    const end = typeof x.end === 'number' ? x.end : null;
    return [{ text, supported: ok, source, start, end }];
  });
}

/** The amounts a checks.json holds, or null when it holds none this page can read. */
export function provenanceOf(raw: unknown): ProvenanceView | null {
  const json = raw as Json;
  const lists: Json[] = [];
  const collect = (o: Json) => {
    if (Array.isArray(o)) {
      lists.push(o);
      return;
    }
    if (!isObj(o)) return;
    for (const k of ['amounts', 'numbers', 'items']) if (o[k] !== undefined) lists.push(o[k]);
  };
  collect(json);
  if (isObj(json) && Array.isArray(json.checks)) for (const c of json.checks) collect(c);
  const amounts = lists.flatMap(amountList);
  if (!amounts.length) return null;
  return { amounts, unsupported: amounts.filter((a) => !a.supported) };
}

export interface AnswerPart {
  text: string;
  /** The unsupported amount this part is, or null for plain text. */
  amount: AmountCheck | null;
}

/** Splits a passage so each unsupported amount is its own part, by offsets when the check gives
 *  them and by its text otherwise (every occurrence, longest amounts first). */
export function markAmounts(body: string, unsupported: AmountCheck[]): AnswerPart[] {
  const hits: { at: number; len: number; amount: AmountCheck }[] = [];
  const taken = (at: number, len: number) => hits.some((h) => at < h.at + h.len && h.at < at + len);
  for (const a of [...unsupported].sort((x, y) => y.text.length - x.text.length)) {
    if (a.start !== null && a.end !== null && body.slice(a.start, a.end) === a.text) {
      if (!taken(a.start, a.end - a.start)) hits.push({ at: a.start, len: a.end - a.start, amount: a });
      continue;
    }
    let from = 0;
    for (;;) {
      const at = body.indexOf(a.text, from);
      if (at < 0) break;
      // Not part of a longer number ("₹1 lakh" inside "₹1 lakh 20 thousand" is fine; "12%" inside "112%" is not).
      const before = body[at - 1] ?? '';
      const after = body[at + a.text.length] ?? '';
      if (!/[0-9.,]/.test(before) && !/[0-9]/.test(after) && !taken(at, a.text.length)) hits.push({ at, len: a.text.length, amount: a });
      from = at + a.text.length;
    }
  }
  hits.sort((x, y) => x.at - y.at);
  const out: AnswerPart[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.at > pos) out.push({ text: body.slice(pos, h.at), amount: null });
    out.push({ text: body.slice(h.at, h.at + h.len), amount: h.amount });
    pos = h.at + h.len;
  }
  if (pos < body.length) out.push({ text: body.slice(pos), amount: null });
  return out;
}
