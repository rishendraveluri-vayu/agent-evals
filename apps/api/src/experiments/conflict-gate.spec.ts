import { conflictGateError, needsConflictCheck } from './conflict-gate';

describe('D75 conflict-check gate', () => {
  it('gates Hermes on a real model only', () => {
    expect(needsConflictCheck({ harness: 'hermes', model: 'claude-haiku-5-5' })).toBe(true);
    expect(needsConflictCheck({ harness: 'hermes', model: 'gemini-3.8-flash' })).toBe(true);
    expect(needsConflictCheck({ harness: 'hermes', model: 'fake/finance-emi' })).toBe(false);
    expect(needsConflictCheck({ harness: 'ownloop', model: 'claude-haiku-5-5' })).toBe(false);
    expect(needsConflictCheck({ harness: 'langgraph', model: 'claude-haiku-5-5' })).toBe(false);
  });

  it('names each config and gives the two calls that fix it', () => {
    const one = conflictGateError([{ hash: 'sha256:9051fae02f4c31112fc3', harness: 'hermes', model: 'claude-haiku-5-5' }]);
    expect(one.message).toMatch(/^config 9051fae02f4c \(Hermes on claude-haiku-5-5\) has no conflict check for its current prompt/);
    expect(one.fix).toContain('/rendered-prompt');
    expect(one.fix).toContain('/conflict-check');
    const two = conflictGateError([
      { hash: 'sha256:aaaaaaaaaaaa1', harness: 'hermes', model: 'claude-haiku-5-5' },
      { hash: 'sha256:bbbbbbbbbbbb2', harness: 'hermes', model: 'gemini-3.8-flash' },
    ]);
    expect(two.message).toMatch(/^configs aaaaaaaaaaaa \(Hermes on claude-haiku-5-5\), bbbbbbbbbbbb \(Hermes on gemini-3.8-flash\) have no conflict check for their/);
  });
});
