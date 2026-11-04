import { normalizeSha } from '../common/hashing';

/**
 * The simulated client's reply cache (D22). Replies are keyed by evals_adapter.sim.cache_key,
 * which hashes the task, the simulator model, temperature, token cap, prompt and the visible
 * transcript. A claim hands out every stored reply for the same task, simulator model, settings
 * and prompt; the worker's runner writes them to /trial/sim_cache.json, and the trial's new
 * replies come back in out/sim_replies.jsonl.
 */

/** The file the adapter appends new client replies to, relative to out/ (contract v2). */
export const SIM_REPLIES_FILE = 'sim_replies.jsonl';

/** What a stored reply is selected by: everything in the cache key but the transcript. */
export interface SimScope {
  task_sha256: string;
  sim_model: string;
  /** Null when the simulator's temperature is not sent (D27). */
  temperature: number | null;
  max_output_tokens: number;
  prompt_sha256: string;
}

export interface SimReplyRow {
  key: string;
  reply: string;
  usage: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEY = /^sha256:[0-9a-f]{64}$/;

/** The simulator a trial's spec ran with, or null when its task has no simulated client. */
export function simScope(taskSha256: string, spec: unknown): SimScope | null {
  const sim = isObj(spec) && isObj(spec.task) ? spec.task.client_sim : null;
  const model = isObj(sim) ? sim.model : null;
  if (!isObj(model) || !isObj(model.prompt)) return null;
  const prompt = normalizeSha(model.prompt.sha256);
  const { name, temperature: raw, max_output_tokens: maxTokens } = model;
  // D27: a null or absent temperature is not sent, and is its own scope.
  const temperature = raw === undefined ? null : raw;
  if (typeof name !== 'string' || (temperature !== null && typeof temperature !== 'number') || !Number.isInteger(maxTokens) || !prompt) return null;
  return { task_sha256: taskSha256, sim_model: name, temperature, max_output_tokens: maxTokens as number, prompt_sha256: prompt };
}

/**
 * The lines of a trial's sim_replies.jsonl that can be cached, first reply per key, and a note for
 * each line that cannot: not JSON, no `sha256:<hex>` key or string reply, or from another model.
 */
export function parseSimReplies(text: string, model: string): { rows: SimReplyRow[]; problems: string[] } {
  const rows: SimReplyRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      problems.push(`${SIM_REPLIES_FILE} line ${i + 1} is not JSON; not cached`);
      return;
    }
    if (!isObj(row) || typeof row.key !== 'string' || !KEY.test(row.key) || typeof row.reply !== 'string') {
      problems.push(`${SIM_REPLIES_FILE} line ${i + 1} is not {key: sha256:<hex>, reply}; not cached`);
      return;
    }
    if (row.model !== undefined && row.model !== model) {
      problems.push(`${SIM_REPLIES_FILE} line ${i + 1} is from ${JSON.stringify(row.model)}, not the simulator ${model}; not cached`);
      return;
    }
    if (seen.has(row.key)) return;
    seen.add(row.key);
    rows.push({ key: row.key, reply: row.reply, usage: row.usage ?? null });
  });
  return { rows, problems };
}
