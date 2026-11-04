/** The checks the run page makes before anything starts, from the configs, their harnesses'
 *  capabilities and the chosen tasks. Each is pass or fail, with the evidence in words. */
import { SETTING_NAMES, type ConfigView, type ConfigDiffEntry, type Estimate, type Harness, type TaskView } from '../api/types';
import { money, wholeMoney } from './format';
import { harnessName, harnessShort, modelName, settingLabel, splitName } from './names';

export interface Check {
  ok: boolean;
  title: string;
  detail: string;
  /** Not checked, only recorded as given: the page shows it apart from a check that passed. */
  recorded?: boolean;
  /** The evidence in the API's own terms (field paths, hashes), for a Details disclosure. */
  raw?: string;
  /** A link that fixes it, in words. */
  link?: { href: string; text: string };
}

/** What a config diff path is about, in words: "the harness version", "max steps", "the toolset". */
function areaWords(path: string, harnessChanged: boolean): string | null {
  const [head, sub] = path.split('.');
  if (head === 'harness') return 'the harness';
  if (head === 'harness_ref' || head === 'adapter_version' || head === 'capabilities_sha256') return harnessChanged ? 'the harness' : 'the harness version';
  if (head === 'settings' && sub) return settingLabel(sub).toLowerCase();
  if (head === 'model') return 'the model';
  if (head === 'prompt') return 'the system prompt';
  if (head === 'toolset') return 'the toolset';
  if (head === 'harness_options') return 'a harness option';
  if (head === 'seed') return 'the seeds';
  return null;
}

/** Every area two configs differ in, in words and once each: "the harness version, max steps and the toolset". */
export function diffWords(diff: ConfigDiffEntry[]): string {
  const content = contentDiff(diff);
  const harnessChanged = content.some((d) => d.path === 'harness');
  const words = [...new Set(content.map((d) => areaWords(d.path, harnessChanged)).filter((w): w is string => !!w))];
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Diff paths that are bookkeeping, not content: a name or a timestamp changes no result. */
export function contentDiff(diff: ConfigDiffEntry[]): ConfigDiffEntry[] {
  return diff.filter((d) => !/^(name|hash|created_at|settings_sources)(\.|$)/.test(d.path));
}

/** The one thing the arms differ in, read from the config diff paths. */
export function axisFromDiff(diff: ConfigDiffEntry[], sameConfig: boolean): string | null {
  if (sameConfig) return 'none';
  const content = contentDiff(diff);
  const harnessChanges = content.some((d) => d.path === 'harness');
  const areas = new Set(
    content.map((d) => {
      const [head, sub] = d.path.split('.');
      // The adapter's version and its capabilities file come with the harness (GET /configs/:a/diff/:b lists them).
      if (head === 'harness' || head === 'harness_ref' || head === 'adapter_version' || head === 'capabilities_sha256') return 'harness';
      // A setting only one of the two harnesses supports is part of changing the harness.
      if (harnessChanges && (head === 'harness_options' || (head === 'settings' && (d.a === null || d.a === undefined || d.b === null || d.b === undefined)))) return 'harness';
      if (head === 'settings' && sub) return sub;
      if (head === 'toolset') return 'tools';
      if (head === 'harness_options') return 'harness options';
      return head;
    }),
  );
  return areas.size === 1 ? [...areas][0] : null;
}

const AXIS_WORDS: Record<string, string> = { prompt: 'the system prompt', harness: 'the harness', model: 'the model', tools: 'the toolset', 'harness options': 'a harness option' };

export function axisPhrase(axis: string): string {
  return AXIS_WORDS[axis] ?? `the ${settingLabel(axis).toLowerCase()} setting`;
}

export function armsCheck(fullDiff: ConfigDiffEntry[], sameConfig: boolean): Check {
  const diff = contentDiff(fullDiff);
  if (sameConfig) return { ok: true, title: 'Both arms are the same config', detail: 'An A/A run: any difference it finds is the noise of the setup itself.' };
  const axis = axisFromDiff(diff, false);
  if (axis) {
    return {
      ok: true,
      title: `Only ${axisPhrase(axis)} differs between the arms`,
      detail: `Checked from the two saved configs: ${diff.map((d) => d.path).join(', ')}. Nothing else differs.`,
    };
  }
  if (!diff.length) return { ok: false, title: 'The two configs do not differ', detail: 'They differ only in name, so the run would compare an agent with itself. Pick two configs that differ in the one thing to compare.' };
  return {
    ok: false,
    title: 'The arms differ in more than one thing',
    detail: `They differ in ${diffWords(diff)}, so a difference in results could not be pinned on one change. Pick a baseline for arm A that differs from arm B in one thing, or fork arm B's agent and change one setting, the prompt or the model.`,
    raw: diff.map((d) => `${d.path}: ${shortValue(d.a)} to ${shortValue(d.b)}`).join('\n'),
  };
}

/** A diff value for the Details disclosure: hashes shortened, objects as JSON. */
function shortValue(v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'string') return /^sha256:[0-9a-f]{12,}$/.test(v) ? v.slice(0, 19) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function capabilityCheck(configs: ConfigView[], harnesses: Harness[]): Check {
  const problems: string[] = [];
  for (const c of configs) {
    const h = harnesses.find((x) => x.name === c.harness);
    if (!h) {
      problems.push(`${c.harness} is not a known harness`);
      continue;
    }
    for (const name of SETTING_NAMES) {
      // Only what the config sets itself: the API leaves out, as null, whatever the harness cannot take.
      if (c.settings_sources[name] === 'config' && c.settings[name] !== null && !h.capabilities.settings[name]?.supported) {
        problems.push(`${harnessShort(h.name)} cannot apply ${settingLabel(name).toLowerCase()}`);
      }
    }
  }
  const names = [...new Set(configs.map((c) => harnessShort(c.harness)))];
  const who = names.length === 1 ? names[0] : names.join(' and ');
  if (problems.length) return { ok: false, title: 'A setting would be silently ignored', detail: `${problems.join('; ')}.` };
  return { ok: true, title: `${who} ${names.length === 1 ? 'supports' : 'support'} every setting in ${configs.length === 1 ? 'the config' : 'both configs'}`, detail: 'Nothing will be silently ignored.' };
}

/** A git commit hash, short or full, as the API takes it (`PLAN_COMMIT` in apps/api/src/experiments/experiments.service.ts). */
export const PLAN_COMMIT = /^[0-9a-f]{7,40}$/i;

/**
 * The analysis plan commit. Only its form is checked: the platform cannot see git history, so a
 * commit in the right form is recorded as given, never reported as a check that passed.
 */
export function planCheck(commit: string | null | undefined): Check {
  const given = commit?.trim() ?? '';
  if (!given) return { ok: false, title: 'No analysis plan commit yet', detail: 'Commit the hypothesis and analysis plan in docs/experiment.md first, then give its commit here.' };
  if (!PLAN_COMMIT.test(given)) {
    return { ok: false, title: 'The analysis plan commit is not a commit hash', detail: `“${given}” is not a git commit: give 7 to 40 characters, each 0-9 or a-f, as git rev-parse --short HEAD prints it.` };
  }
  return {
    ok: true,
    recorded: true,
    title: `Analysis plan commit recorded as given: ${given.toLowerCase()}`,
    detail: 'The platform cannot see git history, so it does not check that this commit exists or that it holds the plan in docs/experiment.md.',
  };
}

/**
 * Every model the run calls whose provider key is not set in .env (GET /models' `key_set`). Each
 * would fail its first call; the run stays off until the key is added and the stack restarted.
 */
export function keysCheck(missing: { role: string; model: string; key: string }[]): Check | null {
  if (!missing.length) return null;
  const keys = [...new Set(missing.map((m) => m.key))];
  const who = missing.map((m) => `${m.role} (${modelName(m.model)})`);
  return {
    ok: false,
    title: `${keys.join(' and ')} ${keys.length === 1 ? 'is' : 'are'} not set`,
    detail: `${who.join(' and ')} ${who.length === 1 ? 'needs' : 'need'} ${keys.join(' and ')} in .env, so every call would fail. Add ${keys.length === 1 ? 'it' : 'them'} to .env, then run docker compose up -d and reload this page.`,
  };
}

export function splitCheck(tasks: TaskView[], all: TaskView[]): Check {
  if (!tasks.length) return { ok: false, title: 'No tasks chosen', detail: 'Choose the tasks to run.' };
  const splits = new Set(tasks.map((t) => splitName(t.split)));
  if (splits.size > 1) return { ok: false, title: 'Discovery and held-out tasks are mixed', detail: 'A change found on the discovery tasks has to be measured on held-out tasks alone.' };
  const split = [...splits][0];
  if (split === 'held-out') {
    const discovery = all.filter((t) => splitName(t.split) === 'discovery').length;
    return {
      ok: true,
      title: `${tasks.length} held-out tasks, none of the discovery tasks`,
      detail: discovery ? 'Changes are made using the discovery tasks, so they stay out of this measurement.' : 'There are no discovery tasks in the catalogue.',
    };
  }
  return { ok: true, title: `${tasks.length} ${split} tasks`, detail: 'Discovery tasks are for finding problems; confirm a change on the held-out tasks.' };
}

export function budgetCheck(budget: number | undefined, estimate: Estimate | null): Check {
  if (!estimate) return { ok: false, title: 'No estimate yet', detail: 'The cost estimate has not come back.' };
  if (!budget || budget <= 0) return { ok: false, title: 'No spending limit set', detail: 'Set the LiteLLM budget for the whole experiment.' };
  if (budget < estimate.cost_usd.high) {
    return { ok: false, title: 'The spending limit is below the likely cost', detail: `It is ${wholeMoney(budget)}, but the run may cost up to ${money(estimate.cost_usd.high)}, so it could stop part-way.` };
  }
  return { ok: true, title: 'The spending limit covers the likely cost', detail: `${wholeMoney(budget)} against at most ${money(estimate.cost_usd.high)}.` };
}

export function harnessList(configs: ConfigView[]): string {
  return [...new Set(configs.map((c) => harnessName(c.harness)))].join(' and ');
}
