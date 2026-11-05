import type { CauseFinding, TrialCause } from '../contract';

/**
 * D64: a failure cause for every trial that failed or stopped short, from what the trial already
 * recorded: its end state and stop reason (result.json), its tool calls (execute_tool spans), its
 * current grades (each grader's verdict, reason and evidence, which quote the runner's checks.json
 * where provenance is concerned) and Rishi's labels. Pure and rule-based: no model is called and
 * nothing is graded again. docs/assumptions.md A45 lists the rules in precedence order; each is
 * one sentence there and one function here.
 */

/** Bump when a rule or its words change. */
export const CAUSE_RULES_VERSION = 'causes-1';

/** One tool call, in start order. */
export interface CauseCall {
  /** As the span names it; the harness prefix (Hermes's mcp__finance__) is removed here. */
  name: string;
  is_error: boolean;
  /** evals.tool.arguments, possibly cut short; only read on trials that need a cause. */
  arguments: string | null;
  /** evals.tool.result, possibly cut short. */
  result: string | null;
}

/** One grade of the trial's current grading. */
export interface CauseGrade {
  grader_id: string;
  type: string | null;
  required: boolean;
  verdict: string | null;
  reason: string | null;
  evidence: unknown[];
  /** The grader's spec from the grading job (or the task file); null when it is not known. */
  spec: Record<string, unknown> | null;
}

export type CauseLabel = 'yes' | 'no' | 'unsure';

export interface CauseTrial {
  status: string;
  label: string | null;
  /** The latest finished grading's outcome; null when there is none. */
  outcome: 'pass' | 'fail' | 'incomplete' | null;
  end_state: string | null;
  harness: string;
  /** result.json end_detail.harness_stop_reason and exception_message. */
  stop_reason: string | null;
  exception: string | null;
  /** result.json has a non-empty final_answer. */
  has_answer: boolean;
  /** LiteLLM's count of the agent's model calls (D17's steps). */
  model_calls: number | null;
  max_steps: number | null;
  timeout_s: number | null;
  max_output_tokens: number | null;
  malformed_tool_calls: number | null;
  /** The task's required_tools, as the trial's spec carried them. */
  required_tools: string[];
  calls: CauseCall[];
  grades: CauseGrade[];
  /** Rishi's label per judge criterion (resolveLabels). */
  labels: Record<string, CauseLabel>;
}

/** Hermes calls tools mcp__<server>__<name>; every other harness uses the bare name. */
export const bareTool = (name: string): string => name.trim().replace(/^mcp__.+?__/, '');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ERRORED = new Set(['agent_error', 'harness_error']);
/** Deterministic checks on what the answer says. */
const ANSWER_CHECKS = new Set(['number', 'regex_present', 'regex_absent', 'unit_test']);

/** A trial gets a cause when it is an agent outcome that failed, or ended other than answered. */
export function needsCause(t: Pick<CauseTrial, 'status' | 'label' | 'outcome' | 'end_state'>): boolean {
  if (t.status !== 'done') return false;
  if (t.label !== null && t.label !== 'agent') return false;
  return t.outcome === 'fail' || (t.end_state !== null && t.end_state !== 'answered');
}

/**
 * The tools a task wants: its required_tools, then the tool of each required tool_called check
 * (one that asks for at least one call), once each, in that order.
 */
export function wantedTools(requiredTools: readonly string[], specs: readonly { type?: unknown; tool?: unknown; required?: unknown; min_calls?: unknown }[]): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    const bare = bareTool(name);
    if (bare && !out.includes(bare)) out.push(bare);
  };
  for (const t of requiredTools) add(t);
  for (const s of specs) {
    if (s.type !== 'tool_called' || typeof s.tool !== 'string' || s.required === false) continue;
    if (typeof s.min_calls === 'number' && s.min_calls < 1) continue;
    add(s.tool);
  }
  return out;
}

/** Rishi's label per criterion: the first, except that a second look answers a first "unsure" (D46). Rows in label order. */
export function resolveLabels(rows: readonly { criterion: string; value: string; second_look: boolean }[]): Record<string, CauseLabel> {
  const out: Record<string, CauseLabel> = {};
  const second = new Set<string>();
  for (const r of rows) {
    if (r.value !== 'yes' && r.value !== 'no' && r.value !== 'unsure') continue;
    const v = r.value;
    if (r.second_look) {
      if (out[r.criterion] === 'unsure' && !second.has(r.criterion)) {
        out[r.criterion] = v;
        second.add(r.criterion);
      }
      continue;
    }
    if (!(r.criterion in out)) out[r.criterion] = v;
  }
  return out;
}

// ---- words -----------------------------------------------------------------------------

const HARNESS_NAME: Record<string, string> = {
  hermes: 'Hermes',
  ownloop: 'the own loop',
  langgraph: 'LangGraph',
  adk: 'Google ADK',
  'openai-agents': 'the OpenAI Agents SDK',
};
const harnessName = (h: string): string => HARNESS_NAME[h] ?? h;
const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One line, at most `max` characters. */
export function quote(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 more". */
export function listWords(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? '';
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const wasWere = (items: readonly unknown[]): string => (items.length === 1 ? 'was' : 'were');

/** What the harness said about how it stopped, when it said anything. */
function said(t: CauseTrial): string {
  const why = t.stop_reason ?? t.exception;
  return why ? ` (${harnessName(t.harness)} reported "${quote(why, 80)}")` : '';
}

// ---- the trial as the rules read it ----------------------------------------------------

interface View {
  t: CauseTrial;
  calls: CauseCall[];
  called: Set<string>;
  wanted: string[];
  missing: string[];
  /** Tools called that the task does not want, once each, in first-call order. */
  others: string[];
  failedRequired: CauseGrade[];
}

function view(t: CauseTrial): View {
  const calls = t.calls.map((c) => ({ ...c, name: bareTool(c.name) }));
  const called = new Set(calls.map((c) => c.name));
  const specs = t.grades.map((g) => ({ type: g.type, tool: g.spec?.tool, required: g.required, min_calls: g.spec?.min_calls }));
  const wanted = wantedTools(t.required_tools, specs);
  const others: string[] = [];
  for (const c of calls) if (!wanted.includes(c.name) && !others.includes(c.name)) others.push(c.name);
  return {
    t,
    calls,
    called,
    wanted,
    missing: wanted.filter((w) => !called.has(w)),
    others,
    failedRequired: t.grades.filter((g) => g.required && g.verdict === 'fail'),
  };
}

const evidenceOf = (g: CauseGrade): Record<string, unknown>[] => g.evidence.filter(isObj);
/** The first of these that is a non-empty string. */
const firstText = (...values: unknown[]): string => (values.find((x): x is string => typeof x === 'string' && x !== '') ?? '');

// ---- the rules, in precedence order ----------------------------------------------------

/** 1. The end state is step_limit, token_limit or timeout. */
function ranOutOfSteps(v: View): CauseFinding | null {
  const t = v.t;
  const h = harnessName(t.harness);
  if (t.end_state === 'step_limit') {
    const used = t.model_calls !== null ? ` after ${plural(t.model_calls, 'model call')}` : '';
    const limit = t.max_steps !== null ? ` (its limit is ${t.max_steps})` : '';
    // Hermes answers at the limit (one more call, for a summary); the others stop without one.
    const note =
      t.harness === 'hermes'
        ? t.has_answer
          ? 'Hermes asks for a summary at the limit, and that summary is the answer that was graded'
          : 'Hermes asks for a summary at the limit, but it gave no usable answer'
        : t.has_answer
          ? `${h} stops at the limit without a reply, so the answer graded is an earlier turn's`
          : `${h} stops at the limit without an answer`;
    return { cause: 'ran_out_of_steps', reason: `Stopped at the step limit${used}${limit}; ${note}${said(t)}` };
  }
  if (t.end_state === 'token_limit') {
    const cap = t.max_output_tokens !== null ? ` of ${t.max_output_tokens.toLocaleString('en-US')} tokens` : '';
    const note =
      t.harness === 'ownloop'
        ? 'the own loop had already sent it again once with the cap doubled'
        : t.harness === 'hermes'
          ? 'Hermes raises the cap itself, so this ending is unusual for it'
          : `${h} stops on the first reply that is cut off`;
    return { cause: 'ran_out_of_steps', reason: `A reply was cut off at the output cap${cap}; ${note}${said(t)}` };
  }
  if (t.end_state === 'timeout') {
    const limit = t.timeout_s !== null ? ` of ${t.timeout_s} s` : '';
    const note = t.harness === 'hermes' ? "; Hermes's start-up counts inside that time" : '';
    return { cause: 'ran_out_of_steps', reason: `The trial ran past its time limit${limit} and was stopped${note}` };
  }
  return null;
}

/** 2. The agent or the harness ended in an error (agent_error, harness_error): `other`, in the harness's own words. */
function endedInError(v: View): CauseFinding | null {
  const t = v.t;
  if (!t.end_state || !ERRORED.has(t.end_state)) return null;
  const detail = t.stop_reason ?? t.exception;
  const malformed = t.malformed_tool_calls ? ` after ${plural(t.malformed_tool_calls, 'malformed tool call')}` : '';
  const head = t.end_state === 'agent_error' ? `The agent's run ended in an error${malformed}` : `The harness or the model provider failed${malformed}`;
  const AGENT_ERROR: Record<string, string> = {
    langgraph: 'LangGraph ends this way when a reply holds only malformed tool calls, and the model is never told',
    adk: 'Google ADK ends this way on the 4th malformed tool call in a row, or on another error code',
    'openai-agents': 'the OpenAI Agents SDK ends this way on a model error other than a cut-off reply',
  };
  const note =
    t.end_state === 'agent_error'
      ? (AGENT_ERROR[t.harness] ?? `${harnessName(t.harness)} does not usually end this way`)
      : t.harness === 'hermes'
        ? "Hermes's own failed result ends this way, and its apology is not kept as an answer"
        : "the runner judged it the agent's outcome, as it does a request too long for the model";
  return { cause: 'other', reason: `${head}${detail ? `: "${quote(detail, 100)}"` : ''}; ${note}` };
}

/** The judge's yes or no per criterion, from the judge grades' evidence. */
function judgeVerdicts(g: CauseGrade): { criterion: string; verdict: 'yes' | 'no'; required: boolean }[] {
  return evidenceOf(g).flatMap((e) =>
    typeof e.criterion === 'string' && (e.verdict === 'yes' || e.verdict === 'no')
      ? [{ criterion: e.criterion, verdict: e.verdict, required: e.required !== false }]
      : [],
  );
}

/**
 * 3. On a criterion Rishi labelled, the judge's verdict differs from his label. It is the primary
 * cause only when it explains the failure: every required check that failed is a judge check, and
 * each criterion it said no to is one his label passes.
 */
function judgeVsLabel(v: View): { finding: CauseFinding; explains: boolean } | null {
  const t = v.t;
  const judged = t.grades.filter((g) => g.type === 'judge');
  const differ = judged.flatMap(judgeVerdicts).filter((j) => {
    const label = t.labels[j.criterion];
    return (label === 'yes' || label === 'no') && label !== j.verdict;
  });
  if (!differ.length) return null;
  const words = differ.slice(0, 3).map((d) => `on ${d.criterion} the judge said ${d.verdict} and the human label says ${t.labels[d.criterion]}`);
  const explains =
    v.failedRequired.length > 0 &&
    v.failedRequired.every((g) => {
      if (g.type !== 'judge') return false;
      const no = judgeVerdicts(g).filter((j) => j.verdict === 'no' && j.required);
      return no.length > 0 && no.every((j) => t.labels[j.criterion] === 'yes');
    });
  return { finding: { cause: 'judge_vs_label', reason: upper(words.join('; ')) }, explains };
}

/** The required tool_not_called checks that failed: a tool the task forbids was called. */
function forbiddenCalled(v: View): string[] {
  return v.failedRequired.filter((g) => g.type === 'tool_not_called').map((g) => bareTool(firstText(g.spec?.tool, evidenceOf(g)[0]?.tool, g.grader_id)));
}

/** 4. A wanted tool was never called and another tool was, or a tool a check forbids was called. */
function wrongTool(v: View): CauseFinding | null {
  if (v.missing.length && v.others.length) {
    return { cause: 'wrong_tool', reason: `${listWords(v.missing)} ${wasWere(v.missing)} never called; ${listWords(v.others)} ${wasWere(v.others)}` };
  }
  const forbidden = forbiddenCalled(v);
  if (forbidden.length) return { cause: 'wrong_tool', reason: `${listWords(forbidden)} ${wasWere(forbidden)} called, though a check says the task must not call ${forbidden.length === 1 ? 'it' : 'them'}` };
  return null;
}

/** 5. It answered, a wanted tool was never called, and no other tool was called in its place. */
function gaveUpEarly(v: View): CauseFinding | null {
  if (v.t.end_state !== 'answered' || !v.missing.length || v.others.length) return null;
  if (!v.calls.length) return { cause: 'gave_up_early', reason: `Answered without calling any tool; the task needs ${listWords(v.missing)}` };
  const called = [...v.called];
  return { cause: 'gave_up_early', reason: `Answered without calling ${listWords(v.missing)}; it called only ${listWords(called)}, which the task also needs` };
}

/** The text in parentheses right after `start` in `text`, nesting allowed; null when there is none. */
function parenthesisAfter(text: string, start: string): string | null {
  const at = text.indexOf(`${start} (`);
  if (at < 0) return null;
  let depth = 0;
  const open = at + start.length + 1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** The money figures a failed provenance grade quotes as unsupported, in its order. */
function unsupportedFigures(g: CauseGrade): string[] {
  const out: string[] = [];
  for (const e of evidenceOf(g)) {
    if (e.source === 'span' || 'verified_by' in e || typeof e.quote !== 'string' || !e.quote) continue;
    if (!out.includes(e.quote)) out.push(e.quote);
  }
  return out;
}

/**
 * 6. The wanted tool was called, but with arguments that matched no source: a failed tool_called
 * check whose tool was called without the arguments it wants, or a failed provenance check
 * quoting an arithmetic call the runner's checks rejected because an input had no source.
 */
function madeUpArguments(v: View): CauseFinding | null {
  const parts: string[] = [];
  for (const g of v.failedRequired) {
    if (g.type !== 'tool_called') continue;
    const calls = evidenceOf(g).filter((e) => e.source === 'span');
    const matched = /\bbut (\d+) matched\b/.exec(g.reason ?? '');
    const args = g.spec?.args;
    // The grader quotes each call of its tool; "but N matched" is its own word that the arguments differed.
    if (!calls.length || (!matched && (args === undefined || g.spec?.max_calls !== undefined))) continue;
    const tool = bareTool(firstText(g.spec?.tool, calls[0].tool, g.grader_id));
    const want = args !== undefined ? ` (${quote(JSON.stringify(args), 80)})` : '';
    const how = matched && Number(matched[1]) > 0 ? `only ${times(Number(matched[1]))} with the arguments the check wants${want}` : `never with the arguments the check wants${want}`;
    const sent = typeof calls[0].quote === 'string' && calls[0].quote ? `; it sent ${quote(calls[0].quote, 100)}` : '';
    parts.push(`${tool} was called ${times(calls.length)}, but ${how}${sent}`);
  }
  for (const g of v.failedRequired) {
    if (g.type !== 'provenance') continue;
    const spans = evidenceOf(g).filter((e) => e.source === 'span');
    if (!spans.length) continue;
    // The grade's reason names each figure with the runner's reason when it rests on a rejected call.
    const why = unsupportedFigures(g).flatMap((f) => {
      const p = parenthesisAfter(g.reason ?? '', f);
      return p && /not supported/.test(p) ? [`${f} came from a tool call given a number with no source (${p})`] : [];
    });
    if (why.length) parts.push(why.slice(0, 2).join('; '));
    else parts.push(`${bareTool(firstText(spans[0].tool, 'a tool'))} was called with ${quote(firstText(spans[0].quote, 'its arguments'), 100)}, a number with no source, and a figure in the reply came from it`);
  }
  // A tool's name starts the sentence as it is written: it is an identifier.
  return parts.length ? { cause: 'made_up_arguments', reason: parts.join('; ') } : null;
}

/** Hermes, the own loop and the rest each show the model a tool's error differently (harness guide 2.1). */
const TOOL_ERROR_NOTE: Record<string, string> = {
  hermes: 'Hermes passes the error back as {"error": ...} and pauses the tools for a minute after three errors in a row',
  ownloop: "the own loop passes the server's error text back as it is",
  langgraph: "LangGraph passes the server's text back as an error message",
  adk: 'Google ADK passes the whole tool result back with its error flag set',
  'openai-agents': "the OpenAI Agents SDK passes the server's text back unmasked",
};

/** 7. A tool returned an error and the agent never called that tool successfully afterwards. */
function toolError(v: View): CauseFinding | null {
  // An error followed later by a successful call of the same tool was recovered from.
  const unrecovered: { name: string; first: CauseCall; n: number }[] = [];
  v.calls.forEach((c, i) => {
    if (!c.is_error || v.calls.slice(i + 1).some((d) => d.name === c.name && !d.is_error)) return;
    const seen = unrecovered.find((u) => u.name === c.name);
    if (seen) seen.n += 1;
    else unrecovered.push({ name: c.name, first: c, n: 1 });
  });
  if (!unrecovered.length) return null;
  const [u, ...rest] = unrecovered;
  const text = u.first.result ? `: "${quote(u.first.result, 90)}"` : '';
  const repair = v.t.harness === 'hermes' && u.first.arguments?.trim() === '{}' ? '; Hermes runs a call it cannot repair with no arguments, so the error may come from that repair' : '';
  const note = TOOL_ERROR_NOTE[v.t.harness] ?? `${harnessName(v.t.harness)} passes tool errors back in its own way`;
  const also = rest.length ? `; ${listWords(rest.map((r) => r.name))} also ended on an error` : '';
  return {
    cause: 'tool_error',
    reason: `${u.name} returned an error${u.n > 1 ? ` ${times(u.n)}` : ''} and was not called successfully after it${text}${also}; ${note}${repair}`,
  };
}

/** 8. A required provenance check failed: money figures in the reply with no source. */
function unsupportedFigure(v: View): CauseFinding | null {
  const g = v.failedRequired.find((x) => x.type === 'provenance');
  if (!g) return null;
  const figures = unsupportedFigures(g);
  const counts = /^(\d+) of (\d+) amount/.exec(g.reason ?? '');
  const n = counts ? Number(counts[1]) : figures.length;
  if (!figures.length) return { cause: 'unsupported_figure', reason: upper(quote(g.reason ?? 'A money figure in the reply has no source', 160)) };
  const shown = figures.slice(0, 3);
  const names = n > shown.length ? `${shown.join(', ')} and ${n - shown.length} more` : listWords(shown);
  const one = n === 1;
  const of = counts ? ` (${n} of ${counts[2]} figures)` : '';
  return { cause: 'unsupported_figure', reason: `${names} ${one ? 'has' : 'have'} no tool result, client-file number or message behind ${one ? 'it' : 'them'}${of}` };
}

/** 9. A required check on the answer (number, regex, unit test) failed, and every wanted tool was called. */
function wrongAnswer(v: View): CauseFinding | null {
  if (v.missing.length) return null;
  const bad = v.failedRequired.filter((g) => ANSWER_CHECKS.has(g.type ?? ''));
  if (!bad.length) return null;
  const [first, ...rest] = bad;
  const more = rest.length ? `; ${listWords(rest.map((g) => g.grader_id))} also failed` : '';
  const tools = v.wanted.length ? `, though ${listWords(v.wanted)} ${wasWere(v.wanted)} called` : '';
  return { cause: 'wrong_answer', reason: `${first.grader_id} failed${tools}: ${quote(first.reason ?? 'no reason given', 140)}${more}` };
}

/** 10. None of the above. */
function otherCause(v: View): CauseFinding {
  const failed = v.failedRequired;
  if (!failed.length) return { cause: 'other', reason: 'No rule fits what this trial recorded' };
  const first = failed[0];
  return { cause: 'other', reason: `${listWords(failed.map((g) => g.grader_id))} failed, which no rule explains: ${quote(first.reason ?? 'no reason given', 140)}` };
}

/**
 * The cause of one trial, or null when it needs none (it passed, or it is not an agent outcome).
 * The first rule that matches is primary; every other that matches is contributing. The judge
 * against the label is primary only when it explains the failure on its own.
 */
export function causeOf(t: CauseTrial): TrialCause | null {
  if (!needsCause(t)) return null;
  const v = view(t);
  const found: { finding: CauseFinding; primary: boolean }[] = [];
  const add = (f: CauseFinding | null, primary = true) => {
    if (f) found.push({ finding: f, primary });
  };
  add(ranOutOfSteps(v));
  add(endedInError(v));
  const jl = judgeVsLabel(v);
  if (jl) add(jl.finding, jl.explains);
  add(wrongTool(v));
  add(gaveUpEarly(v));
  add(madeUpArguments(v));
  add(toolError(v));
  add(unsupportedFigure(v));
  add(wrongAnswer(v));
  let primary = found.find((f) => f.primary);
  if (!primary) {
    primary = { finding: otherCause(v), primary: true };
    found.push(primary);
  }
  return {
    ...primary.finding,
    contributing: found.filter((f) => f !== primary).map((f) => f.finding),
    rules_version: CAUSE_RULES_VERSION,
  };
}
