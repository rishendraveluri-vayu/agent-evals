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
  /** The transcript message an answer quote is from, when the evidence says (`index`). */
  at: number | null;
  /** How the sourcing check verified an amount written without a tool (`derived_in_prose`, D61). */
  verifiedBy: string | null;
  /** The sum it recomputed, in words: "5,000 + 7,488.62 = 12,488.62". */
  derivation: string | null;
}

/** A passage of the agent's replies a check quoted: which message (`at`, or the last reply when
 *  `final`; anywhere when neither is known). */
export interface QuoteView {
  text: string;
  at: number | null;
  final: boolean;
}

/** An amount the sourcing check (a `provenance` grade) lists: one it found no source for, or one
 *  the agent wrote without a tool that the check verified by recomputing it. */
export interface FigureView extends QuoteView {
  verified: boolean;
  derivation: string | null;
}

/** One criterion a judge grade answered: the judge grader's evidence item `{criterion, verdict,
 *  quote, reason}`, with where the grader found the quote. */
export interface JudgeAnswer {
  criterion: string;
  /** yes, no, or what the judge gave instead (missing, an unclear word). */
  verdict: string | null;
  /** Whether the check's verdict rests on it: the grader fails the check on a required criterion
   *  answered no (on any, when none is required). Required unless the evidence says otherwise. */
  required: boolean;
  /** The passage the judge quoted for this answer; null when it quoted nothing. */
  quote: string | null;
  /** False when the grader did not find the quote in the material (`source: "judge"`). */
  quoteFound: boolean | null;
  /** The judge's own line on why it answered so. */
  reason: string | null;
  /** Where the grader found the quote (`agent_message`, `final_answer`, ...), and the transcript
   *  message it is in when the evidence says. */
  source: string | null;
  at: number | null;
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
  /** Passages of the answer the grader quoted, highlighted in the conversation when the check
   *  failed. A judge's quotes are under its answers (`criteria`), each with the criterion it was
   *  quoted for; the sourcing check's amounts are its `figures`. */
  quotes: QuoteView[];
  /** The sourcing check's amounts: the ones with no source, and the ones verified by recomputing. */
  figures: FigureView[];
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
    if (typeof item === 'string') return item.trim() ? [{ source: null, quote: item, tool: null, at: null, verifiedBy: null, derivation: null }] : [];
    if (!isObj(item)) return [];
    const quote = firstString(item, ['quote', 'text']);
    if (!quote) return [];
    return [
      {
        source: str(item.source),
        quote,
        tool: firstString(item, ['tool', 'tool_name']),
        at: typeof item.index === 'number' ? item.index : null,
        verifiedBy: str(item.verified_by),
        derivation: str(item.derivation),
      },
    ];
  });
}

const quoteOf = (x: EvidenceView): QuoteView => ({ text: x.quote, at: x.at, final: x.source === 'final_answer' });

/** The judge grader's evidence: an item per criterion, and one for the call with its rubric. */
function judgeParts(e: Json): { criteria: JudgeAnswer[]; rubric: string | null } {
  const list = Array.isArray(e) ? e.filter(isObj) : [];
  const criteria = list.flatMap((item): JudgeAnswer[] => {
    const criterion = str(item.criterion);
    if (!criterion) return [];
    return [
      {
        criterion,
        verdict: str(item.verdict),
        required: item.required !== false,
        quote: str(item.quote),
        quoteFound: typeof item.quote_found === 'boolean' ? item.quote_found : null,
        reason: str(item.reason),
        source: str(item.source),
        at: typeof item.index === 'number' ? item.index : null,
      },
    ];
  });
  const call = list.find((item) => item.source === 'judge_call');
  return { criteria, rubric: call ? str(call.rubric) : null };
}

/** A judge grade's items that belong to no criterion and are not its call: what it quoted besides
 *  its answers, if anything. Each answer's quote stays with its answer (`criteria`), so it is never
 *  shown under another criterion or the check's own verdict. */
const judgeExtras = (e: Json): Json => (Array.isArray(e) ? e.filter((item) => !isObj(item) || (!str(item.criterion) && item.source !== 'judge_call')) : e);

export function gradeView(g: Grade, index: number): GradeView {
  const isJudge = g.kind === 'judge' || !!g.judge_model;
  const e = g.evidence;
  const items = evidenceItems(isJudge ? judgeExtras(e) : e);
  const legacy = isObj(e) ? e : null;
  const reason = str(g.reason) ?? (typeof e === 'string' ? str(e) : legacy ? firstString(legacy, ['reason', 'rationale', 'explanation', 'why']) : null);
  const raw = g.verdict ?? null;
  const verdict = verdictOf(raw, g.score);
  const judge = isJudge ? judgeParts(e) : { criteria: [], rubric: null };
  const fromAnswer = items.filter((x) => x.source === null || ANSWER_SOURCES.has(x.source));
  const provenance = g.type === 'provenance';
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
    quotes: provenance ? [] : fromAnswer.map(quoteOf),
    figures: provenance ? fromAnswer.map((x) => ({ ...quoteOf(x), verified: x.verifiedBy !== null, derivation: x.derivation })) : [],
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

// ------------------------------------------------------------------------------ highlights

/** Who quoted a passage, in words: "the judge", "the sourcing check" (number provenance), "number
 *  check months-with-extra", or "check <name>" for any other code check. */
export function checkName(g: GradeView): string {
  if (g.kind === 'judge' || g.judgeModel) return 'the judge';
  if (g.type === 'provenance') return 'the sourcing check';
  if (g.type === 'number') return `number check ${g.name}`;
  return `check ${g.name}`;
}

/** A passage to highlight as evidence of a failure: the grade it links to, and who quoted it. */
export interface FailureQuote extends QuoteView {
  index: number;
  /** "the judge for overall (answered no)", "number check months-with-extra (failed)". */
  by: string;
}

/**
 * What the replies highlight as evidence of a failure, each named by its real source: a quote the
 * judge gave for a question it answered no (and the grader found), and a failed code check's
 * quotes. A quote for a "yes", or from a check that passed or could not decide, is evidence for no
 * failure and stays in its grade card. The sourcing check's amounts are not quotes: the ones with
 * no source are marked as amounts (`unsourcedFigures`, or the runner's checks.json), and the ones
 * it verified by recomputing are never marked.
 */
export function failureQuotes(grades: GradeView[]): FailureQuote[] {
  return grades.flatMap((g): FailureQuote[] => {
    const judged = g.criteria.flatMap((c): FailureQuote[] =>
      c.verdict === 'no' && c.quote && c.quoteFound !== false
        ? [{ text: c.quote, at: c.at, final: c.source === 'final_answer', index: g.index, by: `the judge for ${c.criterion} (answered no)` }]
        : [],
    );
    const failed = g.verdict === 'fail' && !g.criteria.length ? g.quotes.map((q) => ({ ...q, index: g.index, by: `${checkName(g)} (failed)` })) : [];
    return [...judged, ...failed];
  });
}

/** The amounts a failed sourcing check found no source for, as amounts to mark: for a trial whose
 *  checks.json the page could not read (it normally marks the runner's own list). */
export function unsourcedFigures(grades: GradeView[]): AmountCheck[] {
  const texts = grades.filter((g) => g.type === 'provenance' && g.verdict === 'fail').flatMap((g) => g.figures.filter((f) => !f.verified).map((f) => f.text));
  return [...new Set(texts)].map((text) => ({ text, supported: false, source: null, start: null, end: null, note: null }));
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
  // D61: a sum the agent wrote without a tool, which the check recomputed and found right.
  if (by === 'derived') return 'a sum in the reply, verified by recomputing it';
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

/** Where each unsupported amount is in a passage, [start, end), in order: by offsets when the
 *  check gives them and by its text otherwise (every occurrence, longest amounts first). The page
 *  cuts the passage at these and at its blocks' edges (lib/trialMarkdown.ts piecesOf). */
export function amountHits(body: string, unsupported: AmountCheck[]): { start: number; end: number; value: AmountCheck }[] {
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
  return hits.sort((x, y) => x.at - y.at).map((h) => ({ start: h.at, end: h.at + h.len, value: h.amount }));
}
