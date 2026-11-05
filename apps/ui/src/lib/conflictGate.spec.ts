import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import type { ConflictCheckView, RenderedPromptView } from '../api/types';
import { ensureConflictChecks, gateFailure, needsConflictCheck } from './conflictGate';

const check = (hash: string): ConflictCheckView => ({ config_hash: hash, conflicts: [], cached: false }) as unknown as ConflictCheckView;
const rendered = (status: RenderedPromptView['status'], error: string | null = null): RenderedPromptView => ({ status, error }) as unknown as RenderedPromptView;

/** A stand-in for the API's four calls, each a spy that records its order. */
function fakeApi() {
  const calls: string[] = [];
  const conflictCheck = vi.fn((h: string): Promise<ConflictCheckView | null> => (calls.push(`get ${h}`), Promise.resolve(null)));
  const renderPrompt = vi.fn((h: string): Promise<RenderedPromptView> => (calls.push(`render ${h}`), Promise.resolve(rendered('queued'))));
  const renderedPrompt = vi.fn((h: string): Promise<RenderedPromptView> => (calls.push(`poll ${h}`), Promise.resolve(rendered('ready'))));
  const runConflictCheck = vi.fn((h: string): Promise<ConflictCheckView> => (calls.push(`check ${h}`), Promise.resolve(check(h))));
  return { calls, conflictCheck, renderPrompt, renderedPrompt, runConflictCheck, api: { conflictCheck, renderPrompt, renderedPrompt, runConflictCheck } };
}
const noSleep = (): Promise<void> => Promise.resolve();

describe('D75 conflict gate on the Run screen', () => {
  it('gates Hermes on a real model only', () => {
    expect(needsConflictCheck({ harness: 'hermes', model: 'claude-haiku-5-5' })).toBe(true);
    expect(needsConflictCheck({ harness: 'hermes', model: 'fake/finance-emi' })).toBe(false);
    expect(needsConflictCheck({ harness: 'ownloop', model: 'claude-haiku-5-5' })).toBe(false);
  });

  it('reuses a stored check and pays nothing', async () => {
    const f = fakeApi();
    f.conflictCheck.mockResolvedValue(check('h1'));
    const out = await ensureConflictChecks([{ hash: 'h1', name: 'A' }], f.api, { sleep: noSleep });
    expect(out).toHaveLength(1);
    expect(f.runConflictCheck).not.toHaveBeenCalled();
    expect(f.renderPrompt).not.toHaveBeenCalled();
  });

  it('renders the prompt, waits for the probe, then runs the check, saying what it does', async () => {
    const f = fakeApi();
    f.conflictCheck.mockRejectedValue(new ApiError(409, 'rendered_prompt_required', 'none yet'));
    const said: (string | null)[] = [];
    await ensureConflictChecks([{ hash: 'h1', name: 'Hermes v2' }], f.api, { sleep: noSleep, onProgress: (t) => said.push(t) });
    expect(f.calls).toEqual(['render h1', 'poll h1', 'check h1']);
    expect(said[0]).toContain('Rendering');
    expect(said[1]).toContain("against Hermes's own instructions");
    expect(said.at(-1)).toBeNull();
  });

  it('stops with a plain reason when the probe fails or never finishes, and never runs the check', async () => {
    const failed = fakeApi();
    failed.renderedPrompt.mockResolvedValue(rendered('failed', 'the probe never reached the model'));
    await expect(ensureConflictChecks([{ hash: 'h1', name: 'A' }], failed.api, { sleep: noSleep })).rejects.toThrow(
      /could not be rendered: the probe never reached the model\. The run did not start/,
    );
    expect(failed.runConflictCheck).not.toHaveBeenCalled();
    const stuck = fakeApi();
    stuck.renderedPrompt.mockResolvedValue(rendered('running'));
    await expect(ensureConflictChecks([{ hash: 'h1', name: 'A' }], stuck.api, { sleep: noSleep, timeoutMs: -1 })).rejects.toThrow(/not rendered within/);
    const none = fakeApi();
    none.renderPrompt.mockResolvedValue(rendered('none'));
    await expect(ensureConflictChecks([{ hash: 'h1', name: 'A' }], none.api, { sleep: noSleep })).rejects.toThrow(/could not be rendered/);
  });

  it('turns checker failures into what to do', async () => {
    const noKey = fakeApi();
    noKey.runConflictCheck.mockRejectedValue(new ApiError(502, 'checker_call_failed', 'litellm: 401 invalid x-api-key'));
    await expect(ensureConflictChecks([{ hash: 'h1', name: 'A' }], noKey.api, { sleep: noSleep })).rejects.toThrow(/needs an Anthropic key.*The run did not start/);
    expect(gateFailure('A', new ApiError(402, 'allowance_exhausted', 'over'))).toContain('EVALS_CONFLICT_CHECK_ALLOWANCE_USD');
    expect(gateFailure('A', new ApiError(502, 'checker_output_invalid', 'bad'))).toContain('could not be read');
  });
});
