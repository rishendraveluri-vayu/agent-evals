/**
 * Small pieces of the Trial page's display: its files, its tool payloads and its graders' words.
 * Everything here returns text; the page renders it as text nodes, never as HTML.
 */

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
