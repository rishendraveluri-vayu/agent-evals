import type { RenderedPrompt } from '../contract';
import { sha256Ref } from '../common/hashing';

/**
 * The rendered prompt (D33): the system text a harness actually sent on its first model call,
 * read from the probe trial's stored first request (artifacts/proxy/0001.request.json, which the
 * runner writes from LiteLLM's spend log). Pure, so it can be tested on real stored requests.
 */

/** Where our task prompt sat, in `harness_text`. */
export const OURS_MARKER = '<<OUR TASK PROMPT>>';

/** The line Hermes writes with the session's date (D20 keeps it); as evals_adapter.invariance.DATE_LINE. */
const DATE_LINE = /^Conversation started: .*$/gm;
export const DATE_PLACEHOLDER = 'Conversation started: <date>';
export const MODEL_PLACEHOLDER = '<model>';

/** LiteLLM's note inside a stored string it cut short (v1.99.4); as evals_adapter.proxy.TRUNCATION_NOTE. */
export const TRUNCATION_NOTE = 'MAX_STRING_LENGTH_PROMPT_IN_DB';

/** RenderedPrompt (contract.ts) without where it was stored. */
export type Rendering = Omit<RenderedPrompt, 'trial_id' | 'created_at'>;

export type RenderOutcome = { ok: true; rendered: Rendering } | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A message's text: a string, or the text parts of an OpenAI content-part list. */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((p): p is Obj => isObj(p) && typeof p.text === 'string').map((p) => p.text as string);
  return parts.length ? parts.join('') : null;
}

function count(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** The first place `ours` appears: as stored, then without its trailing newline, then trimmed. */
function locate(text: string, ours: string): { start: number; end: number; matches: number } | null {
  for (const candidate of [ours, ours.trimEnd(), ours.trim()]) {
    if (!candidate) continue;
    const start = text.indexOf(candidate);
    if (start !== -1) return { start, end: start + candidate.length, matches: count(text, candidate) };
  }
  return null;
}

/**
 * Reads the system prompt, tools and our prompt's place from a stored first request.
 * `probeModel` is the model the probe ran on; wherever the harness wrote that name into its
 * prompt (Hermes's "Model:" line) it becomes `<model>`, and the date line becomes `<date>`,
 * the way the invariance diff normalises them.
 */
export function renderFromRequest(request: unknown, ourPrompt: string, probeModel: string): RenderOutcome {
  if (!isObj(request)) return { ok: false, error: 'the stored first request is not a JSON object' };
  if (JSON.stringify(request).includes(TRUNCATION_NOTE)) {
    return { ok: false, error: `LiteLLM cut the stored request short (${TRUNCATION_NOTE}), so the prompt cannot be trusted; raise that limit and probe again` };
  }
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const system: string[] = [];
  for (const m of messages) {
    if (!isObj(m) || (m.role !== 'system' && m.role !== 'developer')) break;
    const text = textOf(m.content);
    if (text !== null) system.push(text);
  }
  if (!system.length) return { ok: false, error: 'the first request has no system message' };

  const normalised: string[] = [];
  let text = system.join('\n\n');
  const dates = text.match(DATE_LINE)?.length ?? 0;
  if (dates) {
    text = text.replace(DATE_LINE, DATE_PLACEHOLDER);
    normalised.push(`${dates} "Conversation started:" date line(s) to "${DATE_PLACEHOLDER}"`);
  }
  const models = count(text, probeModel);
  if (models) {
    text = text.split(probeModel).join(MODEL_PLACEHOLDER);
    normalised.push(`${models} mention(s) of the probe model ${probeModel} to "${MODEL_PLACEHOLDER}"`);
  }

  const caveats = [
    `The probe ran on ${probeModel}. Text a harness adds only for some model names is missing here: ` +
      'Hermes adds tool-use guidance when the name contains gpt, gemini, qwen, deepseek and a few others (docs/known-limits.md).',
  ];
  if (system.length > 1) caveats.push(`The request had ${system.length} system messages; they are joined here by a blank line.`);
  const found = locate(text, ourPrompt);
  if (!found) caveats.push('Our task prompt was not found verbatim in the system text, so harness_text is the whole system text.');
  else if (found.matches > 1) caveats.push(`Our task prompt appears ${found.matches} times; the first is marked.`);

  const tools = (Array.isArray(request.tools) ? request.tools : [])
    .map((t) => (isObj(t) ? (isObj(t.function) && typeof t.function.name === 'string' ? t.function.name : typeof t.name === 'string' ? t.name : null) : null))
    .filter((n): n is string => n !== null);

  return {
    ok: true,
    rendered: {
      sha256: sha256Ref(text),
      system_text: text,
      tools,
      ours: found ? { start: found.start, end: found.end } : null,
      harness_text: found ? text.slice(0, found.start) + OURS_MARKER + text.slice(found.end) : text,
      normalised,
      caveats,
    },
  };
}

/** The harness's own text with the marker removed; empty when the harness adds nothing. */
export function harnessOwnText(harnessText: string): string {
  return harnessText.split(OURS_MARKER).join('').trim();
}
