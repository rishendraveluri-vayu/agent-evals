/**
 * Grades and checks as the Trial page shows them.
 *
 * A grade (contract `Grade`, SP4) has a verdict (pass, fail, not_applicable, error, or
 * not_implemented for the judge), a reason, and `evidence`: a list of `{source, quote, ...}` whose
 * quotes are verbatim from their source (docs/proposals/grader-format.md). Quotes from the answer
 * (`final_answer`, `agent_message`) are highlighted in the conversation; the rest are listed with
 * their source. Older or hand-made shapes (a string, a list of strings, an object with `reason`
 * and `quotes`) are read too, so a grade is never hidden.
 *
 * A trial passes when every required grade passes, fails when a required one fails, and is
 * incomplete otherwise (the API's `TrialGradingJob.passed` rule).
 *
 * `checks.json` (the adapter library's number-provenance check) is read in the shapes the
 * provenance grader accepts (docs/assumptions.md A14): `{number_provenance: {unsupported, total}}`,
 * `unsupported_count` instead of the list, or a `checks: [{id: "number_provenance", ...}]` list.
 */
import type { Grade, Json } from '../api/types';

export type Verdict = 'pass' | 'fail' | 'other';

export interface EvidenceView {
  source: string | null;
  quote: string;
  /** The tool a tool_result or span quote came from. */
  tool: string | null;
}

export interface GradeView {
  index: number;
  id: number | null;
  graderId: string;
  graderVersion: string;
  kind: string;
  /** The grader type: number, tool_called, regex_absent, unit_test, judge, ... */
  type: string | null;
  required: boolean;
  /** The check in words when the evidence names it, else the grader's id. */
  name: string;
  verdict: Verdict;
  /** The verdict in words: Pass, Fail, Not applicable, Grader error, Not built yet. */
  verdictWord: string;
  score: number | null;
  reason: string | null;
  /** Passages of the answer the grader quoted, to highlight in the conversation. */
  quotes: string[];
  /** Everything else it quoted, with where from. */
  evidence: EvidenceView[];
  judgeModel: string | null;
  runIndex: number;
}

type Obj = { [key: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const firstString = (o: Obj, keys: string[]): string | null => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return null;
};

const VERDICT_WORDS: Record<string, string> = {
  pass: 'Pass',
  fail: 'Fail',
  not_applicable: 'Not applicable',
  error: 'Grader error',
  not_implemented: 'Not built yet',
};

export function verdictOf(raw: string | null, score: number | null): Verdict {
  const v = raw?.toLowerCase().trim();
  if (v === 'pass' || v === 'passed' || v === 'yes' || v === 'true') return 'pass';
  if (v === 'fail' || v === 'failed' || v === 'no' || v === 'false') return 'fail';
  if (v === undefined && score !== null) return score >= 1 ? 'pass' : score <= 0 ? 'fail' : 'other';
  return 'other';
}

/** The answer's own text: these sources' quotes are passages of what the agent said. */
const ANSWER_SOURCES = new Set(['final_answer', 'agent_message']);

function evidenceItems(e: Json): EvidenceView[] {
  if (typeof e === 'string') return [];
  const list = Array.isArray(e) ? e : isObj(e) ? [...(Array.isArray(e.quotes) ? e.quotes : str(e.quotes) ? [e.quotes] : []), ...(str(e.quote) ? [e.quote] : [])] : [];
  return list.flatMap((item): EvidenceView[] => {
    if (typeof item === 'string') return item.trim() ? [{ source: null, quote: item, tool: null }] : [];
    if (!isObj(item)) return [];
    const quote = firstString(item, ['quote', 'text']);
    return quote ? [{ source: str(item.source), quote, tool: firstString(item, ['tool', 'tool_name']) }] : [];
  });
}

export function gradeView(g: Grade, index: number): GradeView {
  const e = g.evidence;
  const items = evidenceItems(e);
  const legacy = isObj(e) ? e : null;
  const reason = str(g.reason) ?? (typeof e === 'string' ? str(e) : legacy ? firstString(legacy, ['reason', 'rationale', 'explanation', 'why']) : null);
  const raw = g.verdict ?? null;
  const verdict = verdictOf(raw, g.score);
  return {
    index,
    id: typeof g.id === 'number' ? g.id : null,
    graderId: g.grader_id,
    graderVersion: g.grader_version,
    kind: g.kind,
    type: g.type ?? null,
    required: g.required ?? true,
    name: (legacy && firstString(legacy, ['name', 'criterion', 'check', 'title'])) ?? g.grader_id,
    verdict,
    verdictWord: VERDICT_WORDS[raw ?? ''] ?? (verdict === 'pass' ? 'Pass' : verdict === 'fail' ? 'Fail' : (raw ?? 'No verdict')),
    score: g.score,
    reason,
    quotes: items.filter((x) => x.source === null || ANSWER_SOURCES.has(x.source)).map((x) => x.quote),
    evidence: items.filter((x) => x.source !== null && !ANSWER_SOURCES.has(x.source)),
    judgeModel: g.judge_model,
    runIndex: g.run_index,
  };
}

export type Outcome = { kind: 'pass' | 'fail' | 'incomplete'; required: number; failed: number; undetermined: number };

/** The trial's outcome from its grades: pass when every required grade passes, fail when a
 *  required one fails, incomplete otherwise; null with no grades. */
export function outcomeOf(grades: GradeView[]): Outcome | null {
  if (!grades.length) return null;
  const required = grades.filter((g) => g.required);
  const failed = required.filter((g) => g.verdict === 'fail').length;
  const undetermined = required.filter((g) => g.verdict === 'other').length;
  const kind = failed ? 'fail' : required.length && !undetermined ? 'pass' : 'incomplete';
  return { kind, required: required.length, failed, undetermined };
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
  /** Every amount the check lists (some shapes list only the unsupported ones). */
  amounts: AmountCheck[];
  unsupported: AmountCheck[];
  /** How many amounts the check looked at, when it says; else the ones it lists. */
  total: number | null;
  /** How many it found no source for, even when it does not list them. */
  unsupportedCount: number;
}

function amount(x: Json, supported: boolean | null): AmountCheck[] {
  if (typeof x === 'string') return x.trim() ? [{ text: x, supported: supported ?? false, source: null, start: null, end: null }] : [];
  if (!isObj(x)) return [];
  const text = firstString(x, ['text', 'raw', 'match', 'amount']);
  const ok = typeof x.supported === 'boolean' ? x.supported : typeof x.grounded === 'boolean' ? x.grounded : typeof x.found === 'boolean' ? x.found : supported;
  if (!text || ok === null) return [];
  const source = firstString(x, ['source', 'tool', 'from']) ?? (Array.isArray(x.sources) ? x.sources.filter((s): s is string => typeof s === 'string').join(', ') || null : null);
  return [{ text, supported: ok, source, start: typeof x.start === 'number' ? x.start : null, end: typeof x.end === 'number' ? x.end : null }];
}

/** The provenance entry of a checks.json, in any of the shapes the grader reads. */
function provenanceNode(json: Json): Obj | null {
  if (!isObj(json)) return null;
  for (const key of ['number_provenance', 'provenance']) if (isObj(json[key])) return json[key];
  if (Array.isArray(json.checks)) {
    const found = json.checks.find((c) => isObj(c) && (c.id === 'number_provenance' || c.id === 'provenance'));
    if (isObj(found)) return found;
  }
  return null;
}

/** The amounts a checks.json holds, or null when it holds no provenance check this page can read. */
export function provenanceOf(raw: unknown): ProvenanceView | null {
  const node = provenanceNode(raw as Json);
  if (!node) return null;
  const listed = [
    ...(Array.isArray(node.amounts) ? node.amounts.flatMap((x) => amount(x, null)) : []),
    ...(Array.isArray(node.numbers) ? node.numbers.flatMap((x) => amount(x, null)) : []),
    ...(Array.isArray(node.supported) ? node.supported.flatMap((x) => amount(x, true)) : []),
    ...(Array.isArray(node.unsupported) ? node.unsupported.flatMap((x) => amount(x, false)) : []),
  ];
  const unsupported = listed.filter((a) => !a.supported);
  const count = typeof node.unsupported_count === 'number' ? node.unsupported_count : unsupported.length;
  // An empty list is an answer (nothing without a source); no list and no count is not.
  if (!listed.length && typeof node.unsupported_count !== 'number' && !Array.isArray(node.unsupported) && !Array.isArray(node.amounts)) return null;
  return { amounts: listed, unsupported, total: typeof node.total === 'number' ? node.total : listed.length || null, unsupportedCount: count };
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
      // Not part of a longer number ("12%" inside "112%" is not that amount).
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
