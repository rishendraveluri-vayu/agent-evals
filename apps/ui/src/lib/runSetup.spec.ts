import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import type { ArmView, ConfigView, TaskView } from '../api/types';
import configsJson from '../fixtures/configs.json';
import { armPauseHelp, defaultArms, defaultBudget, partnerFor, plainRunError, providerOf, taskSetWords, validateN } from './runSetup';

const configs = configsJson as unknown as ConfigView[];
// The fixtures, oldest first: v1 on Hermes (2 Nov), v2 on Hermes (3 Nov), the own loop (4 Nov),
// v1 on Hermes with Gemini Flash (5 Nov).
const [v1, v2, ownloop, gemini] = configs.map((c) => c.hash);

describe('defaultArms', () => {
  it('with only arm B given, picks the newest other config on the same harness as arm A, never the oldest or B itself', () => {
    expect(defaultArms(configs, null, v2)).toEqual({ a: gemini, b: v2, note: null });
    expect(defaultArms(configs, null, gemini)).toEqual({ a: v2, b: gemini, note: null });
  });

  it('falls back to the newest config on another harness when none shares B’s', () => {
    expect(defaultArms(configs, null, ownloop)).toEqual({ a: gemini, b: ownloop, note: null });
    expect(partnerFor(configs, ownloop)).toBe(gemini);
  });

  it('with only arm A given, gives arm B the same way', () => {
    expect(defaultArms(configs, v1, null)).toEqual({ a: v1, b: gemini, note: null });
  });

  it('never builds an A/A run: one config runs alone, with a note', () => {
    const one = [configs[0]];
    expect(defaultArms(one, null, v1)).toEqual({ a: v1, b: '', note: 'only_one' });
    expect(defaultArms(one, null, null)).toEqual({ a: v1, b: '', note: 'only_one' });
    expect(defaultArms(one, v1, null)).toEqual({ a: v1, b: '', note: 'only_one' });
    expect(defaultArms([], null, null).note).toBe('none');
  });

  it('keeps both arms when both are given, a one-arm run when B is empty, and the oldest two with neither', () => {
    expect(defaultArms(configs, v2, v1)).toEqual({ a: v2, b: v1, note: null });
    expect(defaultArms(configs, v2, '')).toEqual({ a: v2, b: '', note: null });
    expect(defaultArms(configs, null, null)).toEqual({ a: v1, b: v2, note: null });
  });
});

describe('validateN', () => {
  it('takes a whole number from 1 to 1,000', () => {
    expect(validateN(5)).toEqual({ value: 5, error: null });
    expect(validateN('1000')).toEqual({ value: 1000, error: null });
    expect(validateN(' 3 ')).toEqual({ value: 3, error: null });
  });

  it('says why anything else is refused', () => {
    expect(validateN('').error).toBe('Enter how many trials to run per task and arm: a whole number from 1 to 1,000.');
    expect(validateN(0).error).toBe('Run at least 1 trial per task and arm.');
    expect(validateN(-1).error).toBe('Run at least 1 trial per task and arm.');
    expect(validateN(1001).error).toBe('Run at most 1,000 trials per task and arm.');
    expect(validateN(1_000_000_000).error).toBe('Run at most 1,000 trials per task and arm.');
    expect(validateN(2.5).error).toBe('Trials per task and arm must be a whole number, with no fraction.');
    expect(validateN('abc').error).toBe('Trials per task and arm must be a whole number from 1 to 1,000.');
    expect(validateN(Number.NaN).value).toBeNull();
  });
});

describe('taskSetWords', () => {
  const task = (id: string, split: TaskView['split'], summary = 'x'): TaskView => ({ sha256: `sha256:${id}`, id, version: '1', split, kind: 'single_prompt', summary, graders: [], problems: [] });
  const all = [task('a', 'held_out'), task('b', 'held_out'), task('c', 'discovery'), task('e', 'discovery', 'ENGINE TEST ONLY: smoke')];

  it('says all tasks only when every task is picked, engine tests aside', () => {
    expect(taskSetWords(all.slice(0, 3), all, 'all')).toBe('all tasks');
    expect(taskSetWords(all.slice(0, 2), all, 'all')).toBe('2 tasks');
  });

  it('names a whole split, else counts what is picked', () => {
    expect(taskSetWords(all.slice(0, 2), all, 'held_out')).toBe('held-out');
    expect(taskSetWords([all[0]], all, 'held_out')).toBe('1 held-out task');
  });
});

describe('defaultBudget', () => {
  it('rounds the high end up to $10, so the default covers it', () => {
    // The QA's free run: high $21.56 became a $20 default under rounding to the nearest $10.
    expect(defaultBudget(21.56)).toBe(30);
    expect(defaultBudget(20)).toBe(20);
    expect(defaultBudget(0.15)).toBe(10);
  });
});

describe('plainRunError', () => {
  it('puts the API’s refusals in plain words, never its field names', () => {
    const same = plainRunError(new ApiError(400, 'invalid_experiment', 'config_hashes lists the same hash twice'));
    expect(same).toBe('Arm A and arm B are the same agent. Pick a different agent for one of them.');
    expect(same).not.toContain('config_hashes');
    expect(plainRunError(new ApiError(400, 'invalid_experiment', 'n must be an integer from 1 to 1000'))).toBe('Trials per task and arm must be a whole number from 1 to 1,000.');
    expect(plainRunError(new ApiError(400, 'budget_below_estimate', 'budget_usd 20 is below the estimate’s high end 21.56', 'Set budget_usd to at least 21.56'))).not.toContain('budget_usd');
    expect(plainRunError(new ApiError(400, 'unknown_model', 'LiteLLM serves no model named gpt-9'))).toBe("LiteLLM does not serve one of the models (gpt-9). Add it to LiteLLM's config, or pick an agent on another model.");
    expect(plainRunError(new ApiError(0, 'unreachable', 'The API could not be reached (fetch failed)'))).toBe('The platform could not be reached. Check that it is running, then try again.');
  });

  it('keeps the message of an unknown refusal, and its fix unless the fix is an API path', () => {
    expect(plainRunError(new ApiError(404, 'unknown_arm', 'no arm C', 'Name an arm by its letter.'))).toBe('no arm C. Name an arm by its letter.');
    expect(plainRunError(new ApiError(409, 'other', 'it is busy', 'POST /experiments/x/start to start it.'))).toBe('it is busy');
  });
});

describe('armPauseHelp', () => {
  const arm = (paused_reason: string, queued = 3, fix: string | null = 'then POST /experiments/:id/arms/:config_hash/resume'): Pick<ArmView, 'arm' | 'paused_reason' | 'fix' | 'counts'> => ({
    arm: 'B',
    paused_reason,
    fix,
    counts: { queued, running: 0, done: 2, infra_failed: 1, abandoned: 0, cancelled: 0 },
  });
  const noKey = 'emi-basic-01 on Haiku, attempt 1: infra:config_error (LiteLLM status 401): x-api-key header is required';

  it('explains a missing key by the provider of the arm’s model, and fixes it with the Resume button', () => {
    const help = armPauseHelp(arm(noKey), 'claude-haiku-5-5');
    expect(help.why).toBe('The Anthropic API rejected the request: no key is set.');
    expect(help.fix).toBe(
      'Add ANTHROPIC_API_KEY to .env, then restart the stack (docker compose up -d). Then press Resume arm B: its 3 waiting trials run. The trial that failed is not re-run; it stays an infra failure.',
    );
    expect(help.fix).not.toContain('POST');
    expect(help.raw).toBe(noKey);
    expect(help.rerun).toBe(false);
  });

  it('names Gemini’s key for a Gemini model, and a bad key as not valid', () => {
    const help = armPauseHelp(arm('x: infra:config_error (LiteLLM status 401): API key not valid. Please pass a valid API key.'), 'gemini-3.8-flash');
    expect(help.why).toBe('The Gemini API rejected the request: the key is not valid.');
    expect(help.fix).toMatch(/^Put a valid GEMINI_API_KEY in \.env, then restart the stack/);
  });

  it('says to set the run up again when the arm has nothing left to run', () => {
    const help = armPauseHelp(arm(noKey, 0), 'claude-haiku-5-5');
    expect(help.fix).toContain('This arm has no trials left to run, so pressing Resume arm B runs nothing more: after the fix, set up the run again.');
    expect(help.rerun).toBe(true);
  });

  it('turns a hand pause and its API fix into the Resume button', () => {
    const help = armPauseHelp(arm('paused by hand: this arm claims nothing more; its running trials finish', 3, 'POST /experiments/e/arms/sha256:x/resume to continue it.'), 'claude-haiku-5-5');
    expect(help).toEqual({ why: 'Paused by hand: this arm starts no new trials; its running trials finish.', fix: 'Press Resume arm B to continue it.', raw: null, rerun: false });
  });

  it('knows a provider from GET /models first, then from the model name', () => {
    expect(providerOf('my-proxy-name', [{ name: 'my-proxy-name', provider: 'anthropic', input_per_mtok: 1, output_per_mtok: 1 }])).toBe('anthropic');
    expect(providerOf('claude-sonnet-5-5')).toBe('anthropic');
    expect(providerOf('gemini-3.8-flash')).toBe('gemini');
    expect(providerOf('gpt-5-mini')).toBe('openai');
    expect(providerOf('fake/finance-emi')).toBeNull();
  });
});
