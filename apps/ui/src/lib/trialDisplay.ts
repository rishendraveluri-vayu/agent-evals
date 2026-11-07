/**
 * Small pieces of the Trial page's display: its files, its tool payloads and its graders' words.
 * Everything here returns text; the page renders it as text nodes, never as HTML.
 */

// ----------------------------------------------------------------------------- tool payloads

const PAD = '  ';

/** A JSON string literal's text, unescaped, when it holds an object or an array as JSON text. */
function nestedJson(literal: string): string | null {
  let text: unknown;
  try {
    text = JSON.parse(literal);
  } catch {
    return null;
  }
  if (typeof text !== 'string' || !/^\s*[[{]/.test(text)) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? text.trim() : null;
  } catch {
    return null;
  }
}

/** Valid JSON text laid out two spaces a level. Every token is copied as written, so a number
 *  keeps its digits (18332.50 stays 18332.50, as the model saw it). A string value that is itself
 *  JSON text of an object or array is laid out in place: Hermes returns each tool result as
 *  `{"result": "<the tool's JSON, escaped>"}`. */
function layout(json: string, level: number): string {
  let out = '';
  let depth = level;
  const newline = () => `\n${PAD.repeat(depth)}`;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < json.length && json[end] !== '"') end += json[end] === '\\' ? 2 : 1;
      const literal = json.slice(i, end + 1);
      let next = end + 1;
      while (next < json.length && /\s/.test(json[next])) next++;
      // A key stays as written; a value may be JSON text of its own.
      const inner = json[next] === ':' ? null : nestedJson(literal);
      out += inner === null ? literal : layout(inner, depth);
      i = end;
    } else if (ch === '{' || ch === '[') {
      let next = i + 1;
      while (next < json.length && /\s/.test(json[next])) next++;
      if (json[next] === (ch === '{' ? '}' : ']')) {
        out += ch + json[next];
        i = next;
      } else {
        depth += 1;
        out += ch + newline();
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      out += newline() + ch;
    } else if (ch === ',') {
      out += `,${newline()}`;
    } else if (ch === ':') {
      out += ': ';
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}

/** A tool's arguments or result for reading: the contract sends them as JSON text (older data as
 *  values). Laid out with every number as written, and any JSON text nested in a string value
 *  unescaped and laid out too. Text that is not JSON is shown as it is. */
export function jsonForDisplay(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
    } catch {
      return value;
    }
    return layout(value, 0);
  }
  return layout(JSON.stringify(value ?? null), 0);
}

// ------------------------------------------------------------------------------- model calls

/** One model call's stored files: its request and, when it was saved, its response. */
export interface ModelCallFiles {
  key: string;
  request: string | null;
  response: string | null;
}

/** A trial's stored model calls: `requests/001.json` with `responses/001.json` in older runs,
 *  `artifacts/proxy/0001.request.json` with `0001.response.json` since the API stores them. */
const CALL_FILE = [/^(requests|responses)\/(.+?)\.json$/, /^artifacts\/proxy\/(.+?)\.(request|response)\.json$/] as const;

export const isModelCallFile = (path: string): boolean => /^(requests|responses)\//.test(path) || /^artifacts\/proxy\//.test(path);

/** The model calls among a trial's files, one per call in file order, each with its request and
 *  response. A file under those folders that names neither is listed as a request of its own, so
 *  nothing stored is hidden. */
export function modelCalls(paths: readonly string[]): ModelCallFiles[] {
  const calls = new Map<string, ModelCallFiles>();
  for (const path of paths.filter(isModelCallFile)) {
    const old = CALL_FILE[0].exec(path);
    const proxy = CALL_FILE[1].exec(path);
    const key = old ? `old:${old[2]}` : proxy ? `proxy:${proxy[1]}` : `file:${path}`;
    const side = old ? (old[1] === 'responses' ? 'response' : 'request') : proxy ? proxy[2] : 'request';
    const call = calls.get(key) ?? { key, request: null, response: null };
    call[side as 'request' | 'response'] = path;
    calls.set(key, call);
  }
  return [...calls.values()];
}
