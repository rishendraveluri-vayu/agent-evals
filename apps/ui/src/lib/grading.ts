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

/** One criterion a judge grade answered (the judge grader's evidence item `{criterion, verdict}`). */
export interface JudgeAnswer {
  criterion: string;
  /** yes, no, or what the judge gave instead (missing, an unclear word). */
  verdict: string | null;
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
  /** The verdict in words: Pass, Fail, Not applicable, Grader error, Not judged. */
  verdictWord: string;
  /** The grader's own verdict: pass, fail, not_applicable, error or not_implemented (a judge check
   *  on an experiment whose judging is not approved). */
  rawVerdict: string | null;
  score: number | null;
  reason: string | null;
  /** Passages of the answer the grader quoted, to highlight in the conversation. */
  quotes: string[];
  /** Everything else it quoted, with where from. */
  evidence: EvidenceView[];
  judgeModel: string | null;
  /** A judge grade's answers, one per criterion, in the rubric's order; empty for other grades and
   *  for a judge check that was never answered (not judged, or the call failed). */
  criteria: JudgeAnswer[];
  /** The rubric the judge was called with (its `judge_call` evidence item), when the grade says. */
  rubric: string | null;
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
  // The judge's verdict when judging is not approved for the experiment: nothing called, nothing spent.
  not_implemented: 'Not judged',
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

/** The judge grader's evidence: an item per criterion, and one for the call with its rubric. */
function judgeParts(e: Json): { criteria: JudgeAnswer[]; rubric: string | null } {
  const list = Array.isArray(e) ? e.filter(isObj) : [];
  const criteria = list.flatMap((item): JudgeAnswer[] => {
    const criterion = str(item.criterion);
    return criterion ? [{ criterion, verdict: str(item.verdict) }] : [];
  });
  const call = list.find((item) => item.source === 'judge_call');
  return { criteria, rubric: call ? str(call.rubric) : null };
}

export function gradeView(g: Grade, index: number): GradeView {
  const e = g.evidence;
  const items = evidenceItems(e);
  const legacy = isObj(e) ? e : null;
  const reason = str(g.reason) ?? (typeof e === 'string' ? str(e) : legacy ? firstString(legacy, ['reason', 'rationale', 'explanation', 'why']) : null);
  const raw = g.verdict ?? null;
  const verdict = verdictOf(raw, g.score);
  const judge = g.kind === 'judge' || g.judge_model ? judgeParts(e) : { criteria: [], rubric: null };
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
    rawVerdict: raw,
    score: g.score,
    reason,
    quotes: items.filter((x) => x.source === null || ANSWER_SOURCES.has(x.source)).map((x) => x.quote),
    evidence: items.filter((x) => x.source !== null && !ANSWER_SOURCES.has(x.source)),
    judgeModel: g.judge_model,
    criteria: judge.criteria,
    rubric: judge.rubric,
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
  /** Why an amount with no source does not count, when the check says: since D56 an arithmetic
   *  tool's result counts only when the numbers it was given are supported (`rejected`). */
  note: string | null;
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

/** Where a contract v2 amount was found, in words: `supported_by` and the match's `where`
 *  (`tool:<name>`, `client:<file>`, `<source>:<transcript index>`). */
function sourceOf(by: string, match: Json): string {
  const where = isObj(match) ? str(match.where) : null;
  if (by === 'tool') return where?.startsWith('tool:') ? `${where.slice(5)}'s result` : 'a tool result';
  if (by === 'client') return 'the client file';
  if (by === 'user') return where?.startsWith('client_sim:') ? "the simulated client's message" : "the client's message";
  // Since checks 0.5.0 (review G3) the simulated client's words are their own kind.
  if (by === 'client_sim') return "the simulated client's message";
  return by;
}

/** A contract v2 amount's `rejected` (D56) in words: "it matches round's result, but round's
 *  input 23,120 is not supported". */
function rejectedNote(rejected: Json): string | null {
  if (!isObj(rejected)) return null;
  const reason = str(rejected.reason);
  if (!reason) return null;
  const where = str(rejected.where);
  const tool = where?.startsWith('tool:') ? `${where.slice(5)}'s result` : 'an arithmetic result';
  return `it matches ${tool}, but ${reason}`;
}

function amount(x: Json, supported: boolean | null): AmountCheck[] {
  if (typeof x === 'string') return x.trim() ? [{ text: x, supported: supported ?? false, source: null, start: null, end: null, note: null }] : [];
  if (!isObj(x)) return [];
  // Contract v2 (contract/v2/checks.schema.json): `supported_by` is tool, client, user or null.
  const v2 = 'supported_by' in x;
  const text = v2 ? str(x.text) : firstString(x, ['text', 'raw', 'match', 'amount']);
  const ok = v2 ? x.supported_by !== null : typeof x.supported === 'boolean' ? x.supported : typeof x.grounded === 'boolean' ? x.grounded : typeof x.found === 'boolean' ? x.found : supported;
  if (!text || ok === null) return [];
  const source = v2
    ? typeof x.supported_by === 'string'
      ? sourceOf(x.supported_by, x.match ?? null)
      : null
    : (firstString(x, ['source', 'tool', 'from']) ?? (Array.isArray(x.sources) ? x.sources.filter((s): s is string => typeof s === 'string').join(', ') || null : null));
  const note = v2 && !ok ? rejectedNote(x.rejected ?? null) : null;
  return [{ text, supported: ok, source, start: typeof x.start === 'number' ? x.start : null, end: typeof x.end === 'number' ? x.end : null, note }];
}

/** The provenance entry of a checks.json: the file itself in contract v2, which the runner
 *  writes after every trial (`amounts` at the top), or an entry in the older shapes. */
function provenanceNode(json: Json): Obj | null {
  if (!isObj(json)) return null;
  if (json.contract_version === '2' && Array.isArray(json.amounts)) return json;
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
  // Contract v2 gives the count as `unsupported`; older shapes as `unsupported_count`.
  const count = typeof node.unsupported_count === 'number' ? node.unsupported_count : typeof node.unsupported === 'number' ? node.unsupported : unsupported.length;
  // An empty list is an answer (nothing without a source); no list and no count is not.
  if (!listed.length && typeof node.unsupported_count !== 'number' && !Array.isArray(node.unsupported) && !Array.isArray(node.amounts)) return null;
  // Contract v2 lists every amount, so its list's length is the total, even when it is 0.
  const total = typeof node.total === 'number' ? node.total : node.contract_version === '2' ? listed.length : listed.length || null;
  return { amounts: listed, unsupported, total, unsupportedCount: count };
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
