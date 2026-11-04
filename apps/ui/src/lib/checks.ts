/**
 * The checks the run page makes before anything starts, from the configs, their harnesses'
 * capabilities and the chosen tasks. Each is pass or fail, with the evidence in words.
 *
 * Also what two configs differ in, in words and with both values ("Max steps 10 vs 12"), for every
 * screen that names a config or an arm: a config's auto-name (autoConfigName), a run's default
 * name (runAutoName), the Run screen's arm labels and checks, and the comparison's header
 * (configChanges, changeWords, changesWords, armValue).
 */
import { SETTING_NAMES, type ConfigView, type ConfigDiffEntry, type Estimate, type Harness, type SeedSkill, type SettingName, type TaskView } from '../api/types';
import { capitalise, money, shortHash, shortRef, wholeMoney } from './format';
import { NAME_MAX } from './limits';
import { harnessName, harnessShort, modelName, settingLabel, splitName } from './names';
import { toggleValue } from './settings';
import { text } from '../trials';

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

/**
 * Whether the arms differ in exactly one thing. The detail says it in words, with both values when
 * the two saved configs are given ("Max steps 10 vs 12"); the field paths and raw values are kept
 * in `raw`, for a Details disclosure.
 */
export function armsCheck(fullDiff: ConfigDiffEntry[], sameConfig: boolean, configs?: [ConfigContent, ConfigContent]): Check {
  const diff = contentDiff(fullDiff);
  if (sameConfig) return { ok: true, title: 'Both arms are the same config', detail: 'An A/A run: any difference it finds is the noise of the setup itself.' };
  const raw = diff.map((d) => `${d.path}: ${shortValue(d.a)} to ${shortValue(d.b)}`).join('\n');
  const changes = configs ? configChanges(configs[0], configs[1]) : [];
  const axis = axisFromDiff(diff, false);
  if (axis) {
    const harnessToo = axis === 'harness' && diff.some((d) => d.path !== 'harness') ? ', with the harness version and any setting only one of the two takes, which come with the harness' : '';
    const what = changes.length === 1 ? changeWords(changes[0]) : capitalise(diffWords(diff));
    return {
      ok: true,
      title: `Only ${axisPhrase(axis)} differs between the arms`,
      detail: `Checked from the two saved configs: ${what}${harnessToo}. Nothing else differs.`,
      raw,
    };
  }
  if (!diff.length) return { ok: false, title: 'The two configs do not differ', detail: 'They differ only in name, so the run would compare an agent with itself. Pick two configs that differ in the one thing to compare.' };
  return {
    ok: false,
    title: 'The arms differ in more than one thing',
    detail: `They differ in ${changes.length ? lowerFirst(changesWords(changes)) : diffWords(diff)}, so a difference in results could not be pinned on one change. Pick a baseline for arm A that differs from arm B in one thing, or fork arm B's agent and change one setting, the prompt or the model.`,
    raw,
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
  if (!configs.length) return { ok: false, title: 'No agent picked yet', detail: 'Pick a saved agent for arm A.' };
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

// ---------------------------------------------------------------------------------------- what differs, in words

/** The fields of a config that change behaviour, as GET /configs/:a/diff/:b compares them. A
 *  config being made on a form has them too, before it has a hash or a name. */
export type ConfigContent = Pick<ConfigView, 'harness' | 'harness_ref' | 'adapter_version' | 'capabilities_sha256' | 'model' | 'prompt' | 'toolset' | 'settings' | 'harness_options' | 'seed'>;

/**
 * Two configs as paths and values, in the shape of GET /configs/:a/diff/:b (every field that
 * changes behaviour, the harness's version and capabilities file included), so a screen can say
 * what they differ in without a call per pair.
 */
export function localDiff(a: ConfigContent, b: ConfigContent): ConfigDiffEntry[] {
  const fields = (c: ConfigContent) => ({
    harness: c.harness,
    harness_ref: c.harness_ref,
    adapter_version: c.adapter_version,
    capabilities_sha256: c.capabilities_sha256,
    model: c.model,
    prompt: c.prompt.sha256,
    toolset: c.toolset.sha256,
    settings: c.settings,
    harness_options: c.harness_options,
    seed: c.seed,
  });
  const out: ConfigDiffEntry[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const walk = (path: string, x: unknown, y: unknown) => {
    if (isObj(x) && isObj(y)) {
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) walk(path ? `${path}.${k}` : k, x[k], y[k]);
    } else if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) {
      out.push({ path, a: (x ?? null) as ConfigDiffEntry['a'], b: (y ?? null) as ConfigDiffEntry['b'] });
    }
  };
  walk('', fields(a), fields(b));
  return out;
}

/** One thing two configs differ in, with both values in words. */
export interface ConfigChange {
  /** `harness`, `harness_version`, `model`, `prompt`, `toolset`, `settings.max_steps`, `harness_options.<name>` or `seed`. */
  key: string;
  /** "Max steps", "Prompt", "Model". */
  label: string;
  /** The first config's value (arm A's): "10", "v1", "Claude Haiku 5.5". */
  a: string;
  /** The second config's value (arm B's). */
  b: string;
  /** The values name themselves (a model, a harness), so the label is not said before them. */
  named: boolean;
  /** For a change with no readable values (a file of the same name with other content): the
   *  change in words, said instead of the two values ("The finance all toolset's content"). */
  differs?: string;
}

/** PLATFORM_DEFAULTS in apps/api/src/configs/settings.ts: what the API stores for a setting left unset. */
export const PLATFORM_DEFAULTS: Record<SettingName, unknown> = {
  temperature: null,
  max_output_tokens: 8192,
  max_steps: 15,
  timeout_s: 300,
  parallel_tool_calls: false,
  memory: { enabled: false },
  skills: { enabled: false },
  compression: { enabled: false },
};

/** A setting's value in running text: "12", "8,192", "300 s", "on", "not sent". */
export function settingWords(name: string, value: unknown): string {
  if (value === null || value === undefined) return 'not sent';
  const toggle = toggleValue(value);
  if (toggle !== null) return toggle ? 'on' : 'off';
  if (typeof value === 'number') return name === 'timeout_s' ? `${value} s` : value.toLocaleString('en-US');
  return text(value);
}

/** "a", "a and b", "a, b and c". */
function listWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "none", "2 memory entries", "1 memory entry and 1 skill". */
function seedWords(seed: { memory?: string[]; skills?: SeedSkill[] } | null | undefined): string {
  const m = seed?.memory?.length ?? 0;
  const k = seed?.skills?.length ?? 0;
  if (!m && !k) return 'none';
  return listWords([m ? `${m} memory ${m === 1 ? 'entry' : 'entries'}` : '', k ? `${k} ${k === 1 ? 'skill' : 'skills'}` : ''].filter(Boolean));
}

/** Names keep their capital in the middle of a sentence: a model, a harness, a fake model. */
const PROPER = /^(Claude|Gemini|GPT|Hermes|Own loop|Google|OpenAI|LangGraph|Fake model)\b/;

/** Lower-cases a label's first letter for the middle of a sentence; a name keeps its capital. */
function lowerFirst(words: string): string {
  return words && !PROPER.test(words) ? words[0].toLowerCase() + words.slice(1) : words;
}

/** Where a diff path belongs: one entry per thing that differs. A harness's version, capabilities
 *  file and the settings only one harness takes come with a change of harness. */
function changeKey(path: string, harnessChanged: boolean, a: unknown, b: unknown): string | null {
  const [head, sub] = path.split('.');
  if (head === 'harness') return 'harness';
  if (head === 'harness_ref' || head === 'adapter_version' || head === 'capabilities_sha256') return harnessChanged ? 'harness' : 'harness_version';
  if (head === 'settings' && sub) return harnessChanged && (a === null || a === undefined || b === null || b === undefined) ? 'harness' : `settings.${sub}`;
  if (head === 'harness_options' && sub) return harnessChanged ? 'harness' : `harness_options.${sub}`;
  if (head === 'model' || head === 'prompt' || head === 'toolset' || head === 'seed') return head;
  return null;
}

const ORDER = ['harness', 'harness_version', 'model', 'prompt', 'toolset', ...SETTING_NAMES.map((n) => `settings.${n}`)];
const rank = (key: string) => (ORDER.includes(key) ? ORDER.indexOf(key) : key === 'seed' ? ORDER.length + 1 : ORDER.length);

/**
 * Each thing config `b` differs from config `a` in, once each and in a fixed order (harness, its
 * version, model, prompt, toolset, settings, harness options, seeds), with both values in words.
 * Bookkeeping (name, hash, where a setting's value came from) is never a change.
 */
export function configChanges(a: ConfigContent, b: ConfigContent): ConfigChange[] {
  const harnessChanged = a.harness !== b.harness;
  const keys = [...new Set(contentDiff(localDiff(a, b)).map((d) => changeKey(d.path, harnessChanged, d.a, d.b)).filter((k): k is string => !!k))];
  keys.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  return keys.map((key): ConfigChange => {
    if (key === 'harness') return { key, label: 'Harness', a: harnessName(a.harness), b: harnessName(b.harness), named: true };
    if (key === 'model') return { key, label: 'Model', a: modelName(a.model), b: modelName(b.model), named: true };
    if (key === 'harness_version') {
      const [x, y] =
        a.harness_ref !== b.harness_ref
          ? [shortRef(a.harness_ref), shortRef(b.harness_ref)]
          : a.adapter_version !== b.adapter_version
            ? [`adapter ${a.adapter_version}`, `adapter ${b.adapter_version}`]
            : [`capabilities ${shortHash(a.capabilities_sha256)}`, `capabilities ${shortHash(b.capabilities_sha256)}`];
      const capsOnly = a.harness_ref === b.harness_ref && a.adapter_version === b.adapter_version;
      return { key, label: `${harnessName(a.harness)} version`, a: x, b: y, named: false, ...(capsOnly ? { differs: `The ${harnessName(a.harness)} capabilities file` } : {}) };
    }
    if (key === 'prompt' || key === 'toolset') {
      const [x, y] = [a[key], b[key]];
      const sameName = x.id === y.id && x.version === y.version;
      const words = (r: typeof x) => `${x.id === y.id ? '' : `${r.id} `}${r.version}${sameName ? ` (${shortHash(r.sha256)})` : ''}`;
      const differs = key === 'prompt' ? `The ${x.id} ${x.version} prompt's text` : `The ${x.id} ${x.version} toolset's content`;
      return { key, label: key === 'prompt' ? 'Prompt' : 'Toolset', a: words(x), b: words(y), named: false, ...(sameName ? { differs } : {}) };
    }
    if (key === 'seed') return { key, label: 'Seeds', a: seedWords(a.seed), b: seedWords(b.seed), named: false };
    const [head, name] = key.split('.');
    if (head === 'settings') {
      const s = name as SettingName;
      return { key, label: settingLabel(s), a: settingWords(s, a.settings[s]), b: settingWords(s, b.settings[s]), named: false };
    }
    const opt = (c: ConfigContent) => (c.harness_options[name] === undefined ? 'default' : text(c.harness_options[name]));
    return { key, label: settingLabel(name), a: opt(a), b: opt(b), named: false };
  });
}

/** One change in words: "Max steps 10 vs 12", "Prompt v1 vs v2", "Claude Haiku 5.5 vs Claude Sonnet 5.5";
 *  a file of the same name with other content by what it is ("The finance all toolset's content"). */
export function changeWords(c: ConfigChange): string {
  if (c.differs) return c.differs;
  return c.named ? `${c.a} vs ${c.b}` : `${c.label} ${c.a} vs ${c.b}`;
}

/** Every change, as a phrase that starts a sentence: "Max steps 10 vs 12 and temperature not sent vs 0.3"; '' for none. */
export function changesWords(changes: ConfigChange[]): string {
  return listWords(changes.map((c, i) => (i ? lowerFirst(changeWords(c)) : changeWords(c))));
}

/** One side of a change, to tell two arms apart: "max steps 10", "prompt v1", "Claude Haiku 5.5". */
export function armValue(c: ConfigChange, side: 'a' | 'b'): string {
  return c.named ? c[side] : `${lowerFirst(c.label)} ${c[side]}`;
}

/** What two arms share, for a run's name: "Own loop with Fake model finance-emi"; the harness or
 *  the model alone when the other is what changes. */
function sharedWords(a: ConfigContent, change: ConfigChange | undefined): string {
  if (change?.key === 'harness') return modelName(a.model);
  if (change?.key === 'model') return harnessShort(a.harness);
  return `${harnessShort(a.harness)} with ${modelName(a.model)}`;
}

/** The longest run name the API takes (EXPERIMENT_NAME_MAX in the contract). */
export const RUN_NAME_MAX = 200;

const clip = (words: string, max: number) => (words.length <= max ? words : `${words.slice(0, max - 1).trimEnd()}…`);

/**
 * A run's default name, saying what the arms differ in: "Max steps 10 vs 12 on Own loop with Fake
 * model finance-emi, 15 tasks", "Own loop vs Hermes Agent on Claude Haiku 5.5, held-out". Arms
 * that differ in more than one thing are named by their configs or, when those names are the
 * same, by every change; never "X vs X". One arm: its config's name. At most RUN_NAME_MAX.
 */
export function runAutoName(a: ConfigView, b: ConfigView | undefined, set: string): string {
  if (!b || a.hash === b.hash) return clip(`${a.name}, ${set}`, RUN_NAME_MAX);
  const changes = configChanges(a, b);
  if (changes.length === 1) return clip(`${changeWords(changes[0])} on ${sharedWords(a, changes[0])}, ${set}`, RUN_NAME_MAX);
  if (a.name.trim() !== b.name.trim()) return clip(`${a.name} vs ${b.name}, ${set}`, RUN_NAME_MAX);
  if (changes.length) return clip(`${changesWords(changes)} on ${sharedWords(a, undefined)}, ${set}`, RUN_NAME_MAX);
  return clip(`${a.name}, ${set}`, RUN_NAME_MAX);
}

/** What a config being named holds: its harness, model, prompt and settings as the API would
 *  store them (null for one it cannot take); its harness options, seeds and toolset when known. */
export type NameContent = Pick<ConfigContent, 'harness' | 'model'> & {
  /** A setting left out is unset: the platform's default applies. */
  settings: Partial<ConfigContent['settings']>;
  prompt: Pick<ConfigContent['prompt'], 'id' | 'version'>;
} & Partial<Pick<ConfigContent, 'harness_options' | 'seed' | 'toolset'>>;

const sameValue = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/**
 * A config's name, made from what it holds, so two configs that differ in one thing never share a
 * name and a fork never keeps its parent's words: "Own loop, Claude Haiku 5.5, finance-advisor
 * v1", then every setting it sets away from the platform's default ("max steps 12", "memory on"),
 * each harness option and its seeds; and, against its nearest saved relative (the config it was
 * forked from, or the one it is compared with), a toolset that differs. At most NAME_MAX
 * characters: past that, the settings it shares with the relative are left out first.
 */
export function autoConfigName(c: NameContent, relative?: ConfigContent | null): string {
  const core = [harnessShort(c.harness), modelName(c.model), `${c.prompt.id} ${c.prompt.version}`];
  const settings = SETTING_NAMES.filter((name) => c.settings[name] !== undefined && c.settings[name] !== null && !sameValue(c.settings[name], PLATFORM_DEFAULTS[name])).map((name) => ({
    words: `${settingLabel(name).toLowerCase()} ${settingWords(name, c.settings[name])}`,
    shared: !!relative && sameValue(relative.settings[name], c.settings[name]),
  }));
  const extra = Object.entries(c.harness_options ?? {}).map(([k, v]) => `${settingLabel(k).toLowerCase()} ${text(v)}`);
  const seeds = seedWords(c.seed);
  if (seeds !== 'none') extra.push(`seeded with ${seeds}`);
  if (relative && c.toolset && c.toolset.sha256 !== relative.toolset.sha256) extra.push(`toolset ${c.toolset.id} ${c.toolset.version}`);
  const join = (list: string[]) => [...core, ...list, ...extra].join(', ');
  const full = join(settings.map((s) => s.words));
  if (full.length <= NAME_MAX) return full;
  return clip(join(settings.filter((s) => !s.shared).map((s) => s.words)), NAME_MAX);
}
