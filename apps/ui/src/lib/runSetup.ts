/**
 * The Run screen's setup rules, apart from the page so each can be tested on its own: which
 * configs the arms start on, what a valid N is, the run's default name and spending limit, the
 * API's refusals in plain words, and what to do about an arm that a config error paused (D37).
 */
import { ApiError, errorText, errorWithFix } from '../api/errors';
import type { ArmView, ConfigView, ModelView, TaskView } from '../api/types';
import { axisFromDiff, localDiff } from './checks';
import { isFake } from './models';
import { modelName, splitName } from './names';

// ---------------------------------------------------------------------------------------- arms

export interface ArmDefaults {
  a: string;
  b: string;
  /**
   * Why the run is not an A/B comparison: `only_one`, one config of your own, so a pilot of it;
   * `no_baseline`, no saved config differs from it in exactly one thing, so a pilot of it too;
   * `none`, no config of your own at all.
   */
  note: 'only_one' | 'no_baseline' | 'none' | null;
}

/** Newest first, by `created_at`; GET /configs lists the oldest first, so a later one breaks a tie. */
function newestFirst(configs: ConfigView[]): ConfigView[] {
  return configs
    .map((c, i) => ({ c, i }))
    .sort((x, y) => Date.parse(y.c.created_at) - Date.parse(x.c.created_at) || y.i - x.i)
    .map((x) => x.c);
}

/** Configs of your own: a shipped example's (`example_only`) are never a default. */
export const ownConfigs = (configs: ConfigView[]): ConfigView[] => configs.filter((c) => !c.example_only);

/** Two configs as paths and values (lib/checks.ts, where the words for what differs live). */
export { localDiff };

/** The one thing two configs differ in (`prompt`, `model`, `max_steps`, ...), or null when it is
 *  nothing or more than one thing. */
export function oneThingApart(a: ConfigView, b: ConfigView): string | null {
  if (a.hash === b.hash) return null;
  const axis = axisFromDiff(localDiff(a, b), false);
  return axis && axis !== 'none' ? axis : null;
}

/**
 * The baseline to compare `hash` with: a config of your own that differs from it in exactly one
 * thing, never an example's. The config it was forked from comes first (a fork changes the one
 * thing it tests), then the newest. Null when there is none.
 */
export function baselineFor(configs: ConfigView[], hash: string): { config: ConfigView; axis: string } | null {
  const me = configs.find((c) => c.hash === hash);
  if (!me) return null;
  const others = newestFirst(ownConfigs(configs)).filter((c) => c.hash !== hash);
  const parent = others.find((c) => c.hash === me.parent_hash);
  for (const c of parent ? [parent, ...others.filter((x) => x !== parent)] : others) {
    const axis = oneThingApart(c, me);
    if (axis) return { config: c, axis };
  }
  return null;
}

/**
 * The arms a new run starts on, from the address (`#/run?a=&b=`). Arm A is the baseline and arm
 * B the agent being tested; the comparison reads B minus A, so the two must differ in exactly one
 * thing. When arm B is given (the guided builder's "Evaluate it", the Config screen's "Save and
 * set up a run"), arm A is its baseline (baselineFor). With neither given, arm B is the newest of
 * your configs that has a baseline. A shipped example's configs are never a default. With no
 * baseline, the run is a pilot of the config on its own, with a note saying why (never an A/A run).
 * Both given are kept as given; `b` given as '' asks for a one-arm run.
 */
export function defaultArms(configs: ConfigView[], a: string | null | undefined, b: string | null | undefined): ArmDefaults {
  const own = newestFirst(ownConfigs(configs));
  const alone = (hash: string): ArmDefaults => ({ a: hash, b: '', note: own.some((c) => c.hash !== hash) ? 'no_baseline' : 'only_one' });
  if (a && b) return { a, b, note: null };
  if (b === '') return { a: a || own[0]?.hash || '', b: '', note: a || own.length ? null : 'none' };
  if (b) {
    const base = baselineFor(configs, b);
    return base ? { a: base.config.hash, b, note: null } : alone(b);
  }
  if (a) {
    const me = configs.find((c) => c.hash === a);
    const partner = me ? own.find((c) => c.hash !== a && oneThingApart(me, c)) : undefined;
    return partner ? { a, b: partner.hash, note: null } : alone(a);
  }
  if (!own.length) return { a: '', b: '', note: 'none' };
  for (const c of own) {
    const base = baselineFor(configs, c.hash);
    if (base) return { a: base.config.hash, b: c.hash, note: null };
  }
  return alone(own[0].hash);
}

// ---------------------------------------------------------------------------------------- keys

/**
 * The .env variable a model needs and lacks, from GET /models' `key_set`: null for a fake model,
 * one whose key is set, or one the API could not tell about (the run then finds out, as before).
 */
export function missingKey(model: string | null | undefined, models: ModelView[]): string | null {
  if (!model || isFake(model)) return null;
  const listed = models.find((m) => m.name === model);
  if (!listed || listed.key_set !== false) return null;
  return PROVIDERS[providerOf(model, models) ?? '']?.key ?? "the provider's API key";
}

/** "needs ANTHROPIC_API_KEY in .env", for a model whose key is not set; '' otherwise. */
export function needsKeyWords(model: string | null | undefined, models: ModelView[]): string {
  const key = missingKey(model, models);
  return key ? `needs ${key} in .env` : '';
}

// ---------------------------------------------------------------------------------------- N

export const MAX_N = 1000;

/** Trials per task and arm a run starts with: 5 for a run that calls a real model, 2 when every
 *  model is fake, where the run only tries the platform out and measures nothing (the 10 held-out
 *  tasks on two arms are 40 trials at 2, against 100 at 5). A number typed by hand is kept. */
export const DEFAULT_N = 5;
export const FAKE_DEFAULT_N = 2;

export function defaultN(everyModelFake: boolean): number {
  return everyModelFake ? FAKE_DEFAULT_N : DEFAULT_N;
}

/** Trials per task and arm: a whole number from 1 to 1,000 (the API's own limit), or why not. */
export function validateN(raw: number | string | null | undefined): { value: number | null; error: string | null } {
  const text = typeof raw === 'number' ? (Number.isNaN(raw) ? '' : String(raw)) : (raw ?? '').trim();
  if (text === '') return { value: null, error: 'Enter how many trials to run per task and arm: a whole number from 1 to 1,000.' };
  const v = Number(text);
  if (!Number.isFinite(v)) return { value: null, error: 'Trials per task and arm must be a whole number from 1 to 1,000.' };
  if (!Number.isInteger(v)) return { value: null, error: 'Trials per task and arm must be a whole number, with no fraction.' };
  if (v < 1) return { value: null, error: 'Run at least 1 trial per task and arm.' };
  if (v > MAX_N) return { value: null, error: 'Run at most 1,000 trials per task and arm.' };
  return { value: v, error: null };
}

// ---------------------------------------------------------------------------------------- seed

/** The largest claim-order seed the API takes: 2^32 - 1. */
export const MAX_SEED = 4_294_967_295;

/**
 * The claim-order seed as typed, checked as the API checks it: empty for a random one (recorded),
 * else a whole number from 0 to 4,294,967,295, or why not. Never silently dropped.
 */
export function validateSeed(raw: string | null | undefined): { value: number | null; error: string | null } {
  const text = (raw ?? '').trim();
  if (text === '') return { value: null, error: null };
  const range = 'a whole number from 0 to 4,294,967,295, or left empty for a random one';
  if (!/^[+-]?\d+$/.test(text)) return { value: null, error: `The claim-order seed must be ${range}; “${text}” is not.` };
  const v = Number(text);
  if (v < 0) return { value: null, error: `The claim-order seed must be ${range}; it cannot be negative.` };
  if (v > MAX_SEED) return { value: null, error: `The claim-order seed must be ${range}; ${text} is too large.` };
  return { value: v, error: null };
}

// ---------------------------------------------------------------------------------------- tasks

export const isEngineTest = (t: TaskView): boolean => t.summary.startsWith('ENGINE TEST ONLY');

/**
 * The tasks in the run's default name, as the task list counts them ("15 of 17 tasks in the
 * run"): "all tasks" only when every task is in it, engine tests included; "held-out" when every
 * task of that split is; else how many: "15 tasks", "3 held-out tasks".
 */
export function taskSetWords(picked: TaskView[], all: TaskView[], split: string): string {
  const has = new Set(picked.map((t) => t.sha256));
  const covers = (list: TaskView[]) => list.length > 0 && list.every((t) => has.has(t.sha256));
  if (covers(all)) return 'all tasks';
  const n = picked.length;
  if (split === 'all') return `${n} ${n === 1 ? 'task' : 'tasks'}`;
  if (covers(all.filter((t) => t.split === split)) && picked.every((t) => t.split === split)) return splitName(split);
  return `${n} ${splitName(split)} ${n === 1 ? 'task' : 'tasks'}`;
}

// ---------------------------------------------------------------------------------------- budget

/** The spending limit offered: the estimate's high end rounded up to $10, at least $10, so the
 *  default always passes the budget check (rounding to the nearest $10 could fall below it). */
export function defaultBudget(high: number): number {
  return Math.max(10, Math.ceil(high / 10) * 10);
}

// ---------------------------------------------------------------------------------------- refusals

/** An API refusal at estimate, create, start or a control, in words for the page, never the
 *  API's field names. Codes it does not know keep the API's message and fix, unless the fix is
 *  an API path. */
export function plainRunError(err: unknown): string {
  if (!(err instanceof ApiError)) return errorText(err);
  const m = err.message;
  switch (err.code) {
    case 'unreachable':
      return 'The platform could not be reached. Check that it is running, then try again.';
    case 'budget_below_estimate':
      return 'The spending limit is below what this run may cost, so it could stop part-way. Raise the limit, or run fewer trials or tasks.';
    case 'too_many_arms':
      return 'A run compares two agents at most: arm A and arm B.';
    case 'unknown_config':
      return 'One of the agents no longer exists. Reload the page and pick again.';
    case 'unknown_task':
    case 'invalid_task':
      return 'A task has changed or is missing. Reload the page to see the tasks as they are now.';
    case 'sim_model_required':
      return 'A conversation task needs a simulated client: pick its model.';
    case 'unknown_model':
      return `LiteLLM does not serve one of the models${m.match(/named (\S+)/) ? ` (${m.match(/named (\S+)/)?.[1]})` : ''}. Add it to LiteLLM's config, or pick an agent on another model.`;
    case 'no_price':
      return "LiteLLM has no price for one of the models, so the run cannot be costed. Add the model's price to LiteLLM's config.";
    case 'experiment_finished':
      return 'This run has finished or was stopped, so it cannot change now. Set up a new run instead.';
    case 'experiment_not_started':
      return 'This run has not started yet: start it first.';
    case 'experiment_started':
      return 'This run has already started, so it cannot be discarded. Stop it instead: its waiting trials are cancelled and finished ones kept.';
    case 'plan_commit_locked':
      return 'The analysis plan commit is fixed once a run has started.';
    case 'invalid_plan_commit':
      return 'The analysis plan commit must be a git commit hash: 7 to 40 characters, each 0-9 or a-f, as git rev-parse --short HEAD prints it. Commit docs/experiment.md first, then give that commit, or leave the field empty.';
    case 'invalid_experiment':
      if (/same hash twice/.test(m)) return 'Arm A and arm B are the same agent. Pick a different agent for one of them.';
      if (/^n must be/.test(m)) return 'Trials per task and arm must be a whole number from 1 to 1,000.';
      if (/budget_usd/.test(m)) return 'Set a spending limit above $0.';
      if (/order_seed/.test(m)) return 'The claim-order seed must be a whole number from 0 to 4,294,967,295, or left empty for a random one.';
      if (/name is required/.test(m)) return 'Give the run a name.';
      if (/^name is \d+ characters/.test(m)) return 'The run name is longer than 200 characters: shorten it.';
      if (/plan_commit/.test(m)) return 'The analysis plan commit must be text, such as a commit hash.';
      if (/must be a non-empty list/.test(m)) return /task/.test(m) ? 'Pick at least one task.' : 'Pick an agent for arm A.';
      return 'The platform refused this run setup. Check each field, then try again.';
    default:
      return err.fix && /\b(POST|GET) \//.test(err.fix) ? errorText(err) : errorWithFix(err);
  }
}

// ---------------------------------------------------------------------------------------- arm pauses

const PROVIDERS: Record<string, { api: string; key: string }> = {
  anthropic: { api: 'The Anthropic API', key: 'ANTHROPIC_API_KEY' },
  gemini: { api: 'The Gemini API', key: 'GEMINI_API_KEY' },
  vertex_ai: { api: 'The Gemini API', key: 'GEMINI_API_KEY' },
  openai: { api: 'The OpenAI API', key: 'OPENAI_API_KEY' },
};

/** The provider behind a model: GET /models when it lists the model, else its name. */
export function providerOf(model: string | null | undefined, models: ModelView[] = []): string | null {
  if (!model) return null;
  const listed = models.find((m) => m.name === model)?.provider;
  if (listed) return listed;
  if (/^(anthropic\/)?claude/.test(model)) return 'anthropic';
  if (/^(gemini|google|vertex_ai)[/-]?/.test(model)) return 'gemini';
  if (/^(openai\/)?(gpt|o\d)/.test(model)) return 'openai';
  return null;
}

export interface ArmPauseHelp {
  /** What happened, in a sentence. */
  why: string;
  /** What to do, ending with the arm's Resume button, never an API path. */
  fix: string;
  /** The API's own words, for a "Details" disclosure; null when there is nothing more to show. */
  raw: string | null;
  /** The arm has no trials left to run, so resuming it runs nothing: the run has to be set up again. */
  rerun: boolean;
}

/**
 * What paused an arm and how to fix it (D37), from its `paused_reason`: a config error is
 * explained by LiteLLM's status and the arm's provider (the key to add to .env for a 401), a
 * hand pause says how to continue. The trial that hit a config error is never re-run (D26).
 */
export function armPauseHelp(arm: Pick<ArmView, 'arm' | 'paused_reason' | 'fix' | 'counts'>, model: string | null, models: ModelView[] = []): ArmPauseHelp {
  const reason = arm.paused_reason ?? '';
  const resume = `Resume arm ${arm.arm}`;
  const waiting = arm.counts.queued;
  const after =
    waiting > 0
      ? `Then press ${resume}: its ${waiting === 1 ? 'waiting trial runs' : `${waiting} waiting trials run`}. The trial that failed is not re-run; it stays an infra failure.`
      : `This arm has no trials left to run, so pressing ${resume} runs nothing more: after the fix, set up the run again.`;
  if (/^paused by hand/.test(reason)) {
    return { why: 'Paused by hand: this arm starts no new trials; its running trials finish.', fix: `Press ${resume} to continue it.`, raw: null, rerun: false };
  }
  const config = reason.match(/infra:config_error \(LiteLLM status (\w+)\)(?::\s*(.*))?$/s);
  if (!config) {
    const fix = arm.fix && !/\b(POST|GET) \//.test(arm.fix) ? arm.fix : `Press ${resume} to continue it.`;
    return { why: reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'Paused.', fix, raw: null, rerun: false };
  }
  const [, status, message = ''] = config;
  const provider = PROVIDERS[providerOf(model, models) ?? ''] ?? null;
  const api = provider?.api ?? 'The model provider';
  const key = provider?.key ?? "the provider's API key";
  const name = model ? modelName(model) : 'the model';
  const restart = 'then restart the stack (docker compose up -d)';
  let why: string;
  let fix: string;
  switch (status) {
    case '401': {
      const missing = /required|missing|no api key|not set|not provided/i.test(message);
      const invalid = /invalid|not valid|incorrect|expired|revoked/i.test(message);
      why = `${api} rejected the request: ${missing ? 'no key is set' : invalid ? 'the key is not valid' : 'its key is missing or not valid'}.`;
      fix = `${missing ? `Add ${key} to .env` : `Put a valid ${key} in .env`}, ${restart}. ${after}`;
      break;
    }
    case '403':
      why = `${api} refused the key: it has no access to ${name}.`;
      fix = `Put a ${key} that can use ${name} in .env, ${restart}. ${after}`;
      break;
    case '404':
      why = `${name.charAt(0).toUpperCase()}${name.slice(1)} was not found: LiteLLM or the provider does not know this model.`;
      fix = `Check the model's entry in LiteLLM's config (services/litellm/config.yaml), ${restart}. ${after} If the agent names the wrong model, save a corrected agent and set up a new run.`;
      break;
    case '400':
      why = `${api} refused how the request is set up.`;
      fix = `Read the details below. A setting the model rejects needs a new agent without it and a new run, since a saved agent cannot change. A key or account problem is fixed in .env, ${restart}. ${after}`;
      break;
    default:
      why = `The model call was refused (LiteLLM status ${status}).`;
      fix = `Find the cause in the details below and in LiteLLM's logs, and fix it. ${after}`;
  }
  return { why, fix, raw: reason, rerun: waiting === 0 };
}
