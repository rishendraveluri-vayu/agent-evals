import type { ConflictFinding, ConflictSeverity, Settings } from '../contract';
import { hashCanonical } from '../common/hashing';

/**
 * The pre-run prompt conflict check (D33, D38): one call to Claude Sonnet 5.5 that lists where the
 * harness's own prompt text and our task prompt (or the config's settings) pull the agent in
 * different directions. The pure parts live here: the checker's input, the cache key, the worst
 * case cost held against the allowance, and parsing the reply.
 */

export const CHECK_KIND = 'conflict_check';
/** D38: pinned. Temperature is not sent and thinking stays at the model's default. */
export const CHECKER_MODEL = 'claude-sonnet-5-5';
export const CHECKER_PROMPT_ID = 'conflict-check';
export const CHECKER_MAX_TOKENS = 2000;
/** The minted key's LiteLLM budget for one check. */
export const CHECK_KEY_BUDGET_USD = 0.1;
/** At most this long for one check's model call. */
export const CHECK_TIMEOUT_MS = 180_000;

export const SEVERITIES: readonly ConflictSeverity[] = ['high', 'medium', 'low'];

export interface Findings {
  conflicts: ConflictFinding[];
  notes: string;
}

/** The user message: the three things the checker prompt says it gets, each in its own block. */
export function checkerInput(harnessText: string, taskPrompt: string, settings: Settings): string {
  return [
    '<harness_text>',
    harnessText.trim(),
    '</harness_text>',
    '',
    '<task_prompt>',
    taskPrompt.trim(),
    '</task_prompt>',
    '',
    '<settings>',
    JSON.stringify(settings, null, 2),
    '</settings>',
  ].join('\n');
}

/**
 * The cache key's input part: everything the checker is given. The rendered prompt's sha covers
 * the harness text and our prompt inside it; the settings are part of the input too, so two
 * configs with the same rendered prompt but different settings do not share findings.
 */
export function checkInputSha(i: { renderedSha256: string; promptSha256: string; settings: Settings }): string {
  return hashCanonical({ rendered_sha256: i.renderedSha256, prompt_sha256: i.promptSha256, settings: i.settings });
}

/**
 * The most one check can cost, held against the allowance before the call: every two characters
 * of input counted as a token (real text runs about 3 to 4 characters a token) and the full
 * max_tokens of output, which includes any thinking.
 */
export function worstCaseUsd(inputChars: number, price: { inputPerToken: number; outputPerToken: number }): number {
  const usd = Math.ceil(inputChars / 2) * price.inputPerToken + CHECKER_MAX_TOKENS * price.outputPerToken;
  return Math.ceil(usd * 1e6) / 1e6;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The JSON object in the reply: the whole text, a ```json fence, or the outermost braces. */
function jsonIn(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  const candidates = [trimmed, fenced?.[1] ?? null, trimmed.includes('{') ? trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1) : null];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c) as unknown;
    } catch {
      // try the next form
    }
  }
  return undefined;
}

/** The checker's reply as findings, or why it cannot be used. Nothing is guessed or repaired. */
export function parseFindings(text: string): { ok: true; findings: Findings } | { ok: false; error: string } {
  const data = jsonIn(text);
  if (!isObj(data)) return { ok: false, error: 'the reply is not a JSON object' };
  if (!Array.isArray(data.conflicts)) return { ok: false, error: 'the reply has no conflicts list' };
  const conflicts: ConflictFinding[] = [];
  for (const [i, raw] of data.conflicts.entries()) {
    if (!isObj(raw)) return { ok: false, error: `conflicts[${i}] is not an object` };
    for (const field of ['harness_says', 'we_say', 'why_it_matters'] as const) {
      if (typeof raw[field] !== 'string' || !raw[field].trim()) return { ok: false, error: `conflicts[${i}].${field} is not text` };
    }
    const severity = typeof raw.severity === 'string' ? raw.severity.trim().toLowerCase() : '';
    if (!(SEVERITIES as readonly string[]).includes(severity)) return { ok: false, error: `conflicts[${i}].severity is not high, medium or low` };
    conflicts.push({
      harness_says: (raw.harness_says as string).trim(),
      we_say: (raw.we_say as string).trim(),
      why_it_matters: (raw.why_it_matters as string).trim(),
      severity: severity as ConflictSeverity,
    });
  }
  if (data.notes !== undefined && data.notes !== null && typeof data.notes !== 'string') return { ok: false, error: 'notes is not text' };
  return { ok: true, findings: { conflicts, notes: typeof data.notes === 'string' ? data.notes.trim() : '' } };
}

/** What one spend-log read says a key's calls cost. `no_call`: the key was never minted, so nothing was sent. */
export interface CallCost {
  costUsd: number | null;
  source: 'spend_log' | 'response_header' | 'unknown' | 'no_call';
  inputTokens: number | null;
  outputTokens: number | null;
  requestId: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * A call's cost: LiteLLM's spend-log rows for its key when there are any (the source of truth,
 * R10.9), else the `x-litellm-response-cost` header with the reply's usage, else unknown (the
 * reservation then stays counted against the allowance).
 */
export function callCost(rows: unknown[], response: { body: unknown; responseCostUsd: number | null }): CallCost {
  const logged = rows.filter(isObj);
  if (logged.length) {
    const sum = (field: string): number => logged.reduce((s, r) => s + (num(r[field]) ?? 0), 0);
    return {
      costUsd: Math.round(sum('spend') * 1e8) / 1e8,
      source: 'spend_log',
      inputTokens: sum('prompt_tokens'),
      outputTokens: sum('completion_tokens'),
      requestId: logged.map((r) => r.request_id).find((id): id is string => typeof id === 'string') ?? null,
    };
  }
  const body = isObj(response.body) ? response.body : {};
  const usage = isObj(body.usage) ? body.usage : {};
  return {
    costUsd: response.responseCostUsd,
    source: response.responseCostUsd === null ? 'unknown' : 'response_header',
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
    requestId: typeof body.id === 'string' ? body.id : null,
  };
}

/** The reply's text and finish reason from an OpenAI-format chat completion. */
export function replyOf(body: unknown): { text: string | null; finishReason: string | null } {
  const b = isObj(body) ? body : {};
  const choice = Array.isArray(b.choices) && isObj(b.choices[0]) ? b.choices[0] : {};
  const message = isObj(choice.message) ? choice.message : {};
  return {
    text: typeof message.content === 'string' ? message.content : null,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
  };
}
