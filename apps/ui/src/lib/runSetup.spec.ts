import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import type { ArmView, ConfigView, TaskView } from '../api/types';
import configsJson from '../fixtures/configs.json';
import { armsCheck, diffWords, keysCheck, planCheck } from './checks';
import { armPauseHelp, baselineFor, defaultArms, defaultBudget, localDiff, missingKey, needsKeyWords, oneThingApart, plainRunError, providerOf, taskSetWords, validateN } from './runSetup';

const configs = configsJson as unknown as ConfigView[];
// The fixtures, oldest first: v1 on Hermes (2 Nov), v2 on Hermes (3 Nov, forked from v1: the
// prompt), the own loop (4 Nov: the harness), v1 on Hermes with Gemini Flash (5 Nov, forked from
// v1: the model).
const [v1, v2, ownloop, gemini] = configs.map((c) => c.hash);
const byHash = (h: string) => configs.find((c) => c.hash === h)!;

/** A shipped example's config: made elsewhere, on the toolset of its day and another adapter. */
const shipped = (over: Partial<ConfigView> = {}): ConfigView => ({
  ...byHash(ownloop),
  hash: 'sha256:90a6761' + '0'.repeat(57),
  name: 'v2 sim check, ownloop, haiku',
  capabilities_sha256: 'sha256:old-capabilities',
  toolset: { id: 'finance', version: 'all', sha256: 'sha256:e8a33031' + '0'.repeat(56) },
  example_only: true,
  created_at: '2026-11-05T13:00:00.000Z',
  ...over,
});

describe('one thing apart', () => {
  it('reads the same areas as the Run screen: a prompt, a model, a harness with its settings', () => {
    expect(oneThingApart(byHash(v1), byHash(v2))).toBe('prompt');
    expect(oneThingApart(byHash(v1), byHash(gemini))).toBe('model');
    expect(oneThingApart(byHash(v1), byHash(ownloop))).toBe('harness');
    expect(oneThingApart(byHash(v2), byHash(gemini))).toBeNull();
    expect(oneThingApart(byHash(v1), byHash(v1))).toBeNull();
  });

  it('counts the harness’s adapter version and capabilities file, as the API’s diff does', () => {
    const example = shipped();
    expect(localDiff(byHash(ownloop), example).map((d) => d.path)).toEqual(['capabilities_sha256', 'toolset']);
    expect(oneThingApart(byHash(ownloop), example)).toBeNull();
  });
});

describe('baselineFor', () => {
  it('takes the config it was forked from first, when that differs in one thing', () => {
    expect(baselineFor(configs, v2)).toEqual({ config: byHash(v1), axis: 'prompt' });
    expect(baselineFor(configs, gemini)).toEqual({ config: byHash(v1), axis: 'model' });
  });

  it('else the newest config one thing apart, never an example’s and never one apart in two', () => {
    expect(baselineFor(configs, ownloop)).toEqual({ config: byHash(v1), axis: 'harness' });
    expect(baselineFor(configs, v1)?.config.hash).toBe(gemini);
    // An example's config differing in one thing is still never the baseline.
    const twin = shipped({ ...byHash(v1), hash: 'sha256:' + 'e'.repeat(64), prompt: byHash(v2).prompt, example_only: true });
    expect(baselineFor([byHash(v1), twin], v1)).toBeNull();
  });
});

describe('defaultArms', () => {
  it('with arm B given, puts its one-thing-apart baseline in arm A', () => {
    expect(defaultArms(configs, null, v2)).toEqual({ a: v1, b: v2, note: null });
    expect(defaultArms(configs, null, gemini)).toEqual({ a: v1, b: gemini, note: null });
    expect(defaultArms(configs, null, ownloop)).toEqual({ a: v1, b: ownloop, note: null });
  });

  it('with no baseline for arm B, runs it alone and says why, never against a config apart in several things', () => {
    const lone = { ...byHash(v2), hash: 'sha256:' + 'f'.repeat(64), model: 'gemini-3.8-flash', harness: 'ownloop', parent_hash: null };
    expect(defaultArms([...configs, lone], null, lone.hash)).toEqual({ a: lone.hash, b: '', note: 'no_baseline' });
  });

  it('never defaults to a shipped example’s config, the QA’s dead end after loading the example', () => {
    const mine = { ...byHash(ownloop), example_only: false };
    // The builder's new agent differs from the example's in its toolset and adapter only.
    expect(defaultArms([shipped(), shipped({ hash: 'sha256:82e5b0e' + '0'.repeat(57), harness: 'hermes' }), mine], null, mine.hash)).toEqual({ a: mine.hash, b: '', note: 'only_one' });
    expect(defaultArms([shipped()], null, null)).toEqual({ a: '', b: '', note: 'none' });
  });

  it('with only arm A given, gives arm B a config one thing apart', () => {
    expect(defaultArms(configs, v2, null)).toEqual({ a: v2, b: v1, note: null });
  });

  it('never builds an A/A run: one config runs alone, with a note', () => {
    const one = [configs[0]];
    expect(defaultArms(one, null, v1)).toEqual({ a: v1, b: '', note: 'only_one' });
    expect(defaultArms(one, null, null)).toEqual({ a: v1, b: '', note: 'only_one' });
    expect(defaultArms(one, v1, null)).toEqual({ a: v1, b: '', note: 'only_one' });
    expect(defaultArms([], null, null).note).toBe('none');
  });

  it('keeps both arms when both are given, a one-arm run when B is empty, and with neither the newest config with its baseline', () => {
    expect(defaultArms(configs, v2, v1)).toEqual({ a: v2, b: v1, note: null });
    expect(defaultArms(configs, v2, '')).toEqual({ a: v2, b: '', note: null });
    expect(defaultArms(configs, null, null)).toEqual({ a: v1, b: gemini, note: null });
  });
});

describe('the Run screen’s checks in words', () => {
  it('records a plan commit as given, never as a check that passed, and refuses one that is not a commit hash', () => {
    const given = planCheck('ABC1234');
    expect(given).toMatchObject({ ok: true, recorded: true, title: 'Analysis plan commit recorded as given: abc1234' });
    expect(given.detail).toBe('The platform cannot see git history, so it does not check that this commit exists or that it holds the plan in docs/experiment.md.');
    expect(given.title).not.toMatch(/passed|committed before/);
    expect(planCheck('plan-v1')).toMatchObject({ ok: false, title: 'The analysis plan commit is not a commit hash' });
    expect(planCheck('  ')).toMatchObject({ ok: false, title: 'No analysis plan commit yet' });
  });

  it('says what two arms differ in, in words, with the field paths and short hashes kept for Details', () => {
    const check = armsCheck(localDiff(byHash(ownloop), shipped({ settings: { ...byHash(ownloop).settings, max_steps: 15, timeout_s: 300 } })), false);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^They differ in the harness version, max steps, timeout and the toolset, so a difference in results could not be pinned on one change\./);
    expect(check.detail).not.toMatch(/sha256|capabilities_sha256|settings\./);
    expect(check.raw?.split('\n')).toEqual([
      'capabilities_sha256: sha256:17ae974939a5 to sha256:old-capabilities',
      'settings.max_steps: 12 to 15',
      'settings.timeout_s: 180 to 300',
      'toolset: sha256:e4c1f08aa4af to sha256:e8a330310000',
    ]);
    expect(diffWords(localDiff(byHash(v1), byHash(gemini)))).toBe('the model');
  });

  it('names every arm whose key is not set, the variable, and the command to run after adding it', () => {
    expect(keysCheck([])).toBeNull();
    const check = keysCheck([
      { role: 'Arm A', model: 'claude-haiku-5-5', key: 'ANTHROPIC_API_KEY' },
      { role: 'Simulated client', model: 'claude-haiku-5-5', key: 'ANTHROPIC_API_KEY' },
    ]);
    expect(check).toEqual({
      ok: false,
      title: 'ANTHROPIC_API_KEY is not set',
      detail: 'Arm A (Claude Haiku 5.5) and Simulated client (Claude Haiku 5.5) need ANTHROPIC_API_KEY in .env, so every call would fail. Add it to .env, then run docker compose up -d and reload this page.',
    });
  });
});

describe('missing provider keys', () => {
  const models = [
    { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false },
    { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: true },
    { name: 'my-proxy', provider: 'anthropic', input_per_mtok: 1, output_per_mtok: 1, key_set: null },
  ];

  it('names the .env variable a model needs when GET /models says its key is not set', () => {
    expect(missingKey('claude-haiku-5-5', models)).toBe('ANTHROPIC_API_KEY');
    expect(needsKeyWords('claude-haiku-5-5', models)).toBe('needs ANTHROPIC_API_KEY in .env');
  });

  it('says nothing for a key that is set, one the API could not tell, a fake model or an unlisted one', () => {
    expect(missingKey('gemini-3.8-flash', models)).toBeNull();
    expect(missingKey('my-proxy', models)).toBeNull();
    expect(missingKey('fake/finance-emi', models)).toBeNull();
    expect(missingKey('claude-sonnet-5-5', models)).toBeNull();
    expect(needsKeyWords('gemini-3.8-flash', models)).toBe('');
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

  it('says all tasks only when every task is picked, so the name agrees with the list’s “3 of 4 tasks in the run”', () => {
    expect(taskSetWords(all, all, 'all')).toBe('all tasks');
    // The QA's case: every task but the engine tests (left out by default) is "15 tasks", not "all tasks".
    expect(taskSetWords(all.slice(0, 3), all, 'all')).toBe('3 tasks');
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
    const plan = plainRunError(new ApiError(400, 'invalid_plan_commit', '"plan-v1" is not a git commit hash', 'Commit docs/experiment.md first, then give the commit as `git rev-parse --short HEAD` prints it.'));
    expect(plan).toContain('must be a git commit hash: 7 to 40 characters, each 0-9 or a-f');
    expect(plan).not.toContain('`');
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
    expect(providerOf('my-proxy-name', [{ name: 'my-proxy-name', provider: 'anthropic', input_per_mtok: 1, output_per_mtok: 1, key_set: null }])).toBe('anthropic');
    expect(providerOf('claude-sonnet-5-5')).toBe('anthropic');
    expect(providerOf('gemini-3.8-flash')).toBe('gemini');
    expect(providerOf('gpt-5-mini')).toBe('openai');
    expect(providerOf('fake/finance-emi')).toBeNull();
  });
});
