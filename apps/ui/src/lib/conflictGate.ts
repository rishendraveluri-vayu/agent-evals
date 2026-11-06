/**
 * D75: a run with a Hermes agent on a real model starts only after the prompt conflict check has
 * read that agent's current prompt and settings (the API refuses the start otherwise, 409
 * `conflict_check_required`). The Run screen runs any missing check when you start: first the
 * rendered prompt (a free probe on the fake model), then the check (one paid call, on Claude Sonnet
 * 5.5 when its key is set, otherwise on the agent's own model, from the standing conflict-check
 * allowance). An agent checked before costs nothing.
 * Findings never stop the run; they are shown on the run page.
 */
import { ApiError } from '../api/errors';
import type { ConflictCheckView, RenderedPromptView } from '../api/types';
import { isFake } from './models';

export function needsConflictCheck(c: { harness: string; model: string }): boolean {
  return c.harness === 'hermes' && !isFake(c.model);
}

export interface GateApi {
  conflictCheck(hash: string): Promise<ConflictCheckView | null>;
  renderPrompt(hash: string): Promise<RenderedPromptView>;
  renderedPrompt(hash: string): Promise<RenderedPromptView>;
  runConflictCheck(hash: string): Promise<ConflictCheckView>;
}

export interface GateOptions {
  onProgress?: (text: string | null) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a probe to render the prompt. */
  timeoutMs?: number;
  pollMs?: number;
}

const NO_KEY = /\b401\b|x-api-key|api[_ -]?key|authenticat/i;

/** A failed check in plain words: why the run did not start and what to do. */
export function gateFailure(name: string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'checker_call_failed' && NO_KEY.test(err.message)) return `The prompt check for ${name} was refused for want of a provider key: add the key to .env and restart the stack.`;
    if (err.code === 'checker_call_failed') return `The prompt check for ${name} could not reach its model. Try again later.`;
    if (err.code === 'checker_output_invalid') return `The prompt check for ${name} gave a reply that could not be read (the call is counted in the platform's spend). Start again to retry it.`;
    if (err.code === 'allowance_exhausted') return `The prompt check for ${name} would pass the conflict-check allowance: raise EVALS_CONFLICT_CHECK_ALLOWANCE_USD in .env and restart the stack.`;
    return `The prompt check for ${name} failed: ${err.message}${err.fix ? ` ${err.fix}` : ''}`;
  }
  return `The prompt check for ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
}

async function storedCheck(api: GateApi, hash: string): Promise<ConflictCheckView | null> {
  try {
    return await api.conflictCheck(hash);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'rendered_prompt_required') return null;
    throw err;
  }
}

/**
 * Makes sure each config has a stored check for its current input, running what is missing.
 * Resolves with the checks; throws an Error whose message says, in plain words, why not.
 */
export async function ensureConflictChecks(
  configs: { hash: string; name: string }[],
  api: GateApi,
  opts: GateOptions = {},
): Promise<ConflictCheckView[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollMs = opts.pollMs ?? 2_000;
  const say = opts.onProgress ?? (() => undefined);
  const done: ConflictCheckView[] = [];
  try {
    for (const c of configs) {
      const stored = await storedCheck(api, c.hash);
      if (stored) {
        done.push(stored);
        continue;
      }
      say(`Rendering what Hermes sends for ${c.name} (a free run on the fake model)…`);
      let r = await api.renderPrompt(c.hash);
      const until = Date.now() + timeoutMs;
      while (r.status === 'queued' || r.status === 'running') {
        if (Date.now() > until) throw new Error(`The prompt of ${c.name} was not rendered within ${Math.round(timeoutMs / 60_000)} minutes: is the Hermes worker running? The run did not start.`);
        await sleep(pollMs);
        r = await api.renderedPrompt(c.hash);
      }
      if (r.status !== 'ready') throw new Error(`The prompt of ${c.name} could not be rendered${r.error ? `: ${r.error}` : ''}. The run did not start.`);
      say(`Checking ${c.name}'s prompt against Hermes's own instructions…`);
      try {
        done.push(await api.runConflictCheck(c.hash));
      } catch (err) {
        throw new Error(`${gateFailure(c.name, err)} The run did not start.`, { cause: err });
      }
    }
  } finally {
    say(null);
  }
  return done;
}
