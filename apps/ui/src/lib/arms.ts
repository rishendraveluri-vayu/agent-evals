/** The arms of an experiment in words: A is the first config hash, B the second. Experiments
 *  made before D35 (two arms) can have a third, C, which is drawn in grey: blue and orange mean
 *  A and B only. */
import { SETTING_NAMES, type CompareRow, type CompareStats, type ConfigView, type ExperimentCounts, type ExperimentSummary, type Interval, type SettingName, type TaskView, type TrialRowSummary } from '../api/types';
import { harnessVersion, plural, shortHash, signed } from './format';
import { isFake } from './models';
import { harnessName, harnessShort, modelName, settingLabel, splitName } from './names';
import { settingValue } from './settings';
import { kappaWords } from './trust';

/** `a`, `b`, then `c` and on for an experiment made before D35. */
export type ArmKey = string;

/** How arm B did against arm A, as one tag shows it everywhere: better and worse only when the
 *  difference holds up, none when it does not, pending before there is an interval. */
export type Verdict = 'better' | 'worse' | 'none' | 'pending';

export interface Arm {
  key: ArmKey;
  hash: string;
  config: ConfigView | undefined;
  /** "Prompt v2", "Hermes Agent", "Config 7f3a9c2" */
  label: string;
  /** "v2", "Hermes", "7f3a9c2" */
  short: string;
}

/** Which arm a trial row ran in, by its position: 0 is A. Trial rows carry the config hash, not
 *  the arm; an A/A calibration run (D44) has one hash twice, and its second arm's repeats come
 *  after the first's. The experiment's `calibration` flag decides, as in the API's armIndex. */
export function armIndexOf(t: Pick<TrialRowSummary, 'config_hash' | 'repeat_index'>, e: Pick<ExperimentSummary, 'config_hashes' | 'n' | 'calibration'>): number {
  if (e.calibration) return t.repeat_index >= e.n ? 1 : 0;
  return Math.max(0, e.config_hashes.indexOf(t.config_hash));
}

/** The arm letter for a position: 0 is A. */
export const armLetter = (i: number) => String.fromCharCode(65 + i);

const isSetting = (name: string): name is SettingName => (SETTING_NAMES as readonly string[]).includes(name);

/** Arms are named by the one thing that changes: "Prompt v2", "Hermes Agent", "Claude Sonnet 5.5",
 *  "Max steps 12", "Tools v2". Two arms that would share a name (two prompts both at v1, one
 *  harness at two versions) are told apart by what does differ, then by their config names, and
 *  last by their hashes. Arms that differ in several things are named by their hashes, and the
 *  comparison lists what differs (armDifferences). */
export function armsOf(experiment: Pick<ExperimentSummary, 'axis' | 'config_hashes'>, configs: ConfigView[]): Arm[] {
  const sameTwice = experiment.config_hashes.length === 2 && experiment.config_hashes[0] === experiment.config_hashes[1];
  const axis = experiment.axis;
  // Toolsets are named by version when they share an id ("Tools v2"), else by both, so D70's
  // finance v3 and finance-no-calculators v3 do not both read "Tools v3".
  const toolsetIds = new Set(experiment.config_hashes.map((h) => configs.find((c) => c.hash === h)?.toolset.id));
  const toolsetWords = (t: ConfigView['toolset']) => (toolsetIds.size > 1 ? `${t.id} ${t.version}` : t.version);
  // Prompts likewise: D78's finance-advisor-skip-tools v1 against finance-advisor v2 must not read
  // "Prompt v1" and "Prompt v2", which is the headline's pair.
  const promptIds = new Set(experiment.config_hashes.map((h) => configs.find((c) => c.hash === h)?.prompt.id));
  const promptWords = (p: ConfigView['prompt']) => (promptIds.size > 1 ? `${p.id} ${p.version}` : p.version);
  const arms = experiment.config_hashes.map((hash, i) => {
    const config = configs.find((c) => c.hash === hash);
    const byHash = { label: `Config ${shortHash(hash)}`, short: shortHash(hash) };
    let names = byHash;
    if (config && !sameTwice) {
      const byPrompt = { label: `Prompt ${promptWords(config.prompt)}`, short: promptWords(config.prompt) };
      if (experiment.config_hashes.length === 1 || axis === 'prompt') names = byPrompt;
      else if (axis === 'harness') names = { label: harnessName(config.harness), short: harnessShort(config.harness) };
      else if (axis === 'model') names = { label: modelName(config.model), short: modelName(config.model) };
      else if (axis === 'tools' || axis === 'toolset') names = { label: `Tools ${toolsetWords(config.toolset)}`, short: `tools ${toolsetWords(config.toolset)}` };
      else if (isSetting(axis)) {
        const words = `${settingLabel(axis)} ${settingWords(config, axis)}`;
        names = { label: words, short: words };
      }
    }
    return { key: armLetter(i).toLowerCase(), hash, config, ...names };
  });
  return sameTwice ? arms : apart(arms);
}

/** Arms with different configs but the same name, named again so each reads as itself. */
function apart(arms: Arm[]): Arm[] {
  const clash = (list: Arm[]) => new Set(list.map((a) => a.label)).size < list.length;
  const configs = arms.map((a) => a.config).filter((c): c is ConfigView => !!c);
  if (arms.length < 2 || !clash(arms) || configs.length < arms.length) return arms;
  const distinct = (key: (c: ConfigView) => string) => new Set(configs.map(key)).size === configs.length;
  const renamed = (name: (c: ConfigView) => string, short: (c: ConfigView) => string) => arms.map((a, i) => ({ ...a, label: name(configs[i]), short: short(configs[i]) }));
  // One harness at two versions, or two prompts that share a version number: name the version.
  const sameHarness = new Set(configs.map((c) => c.harness)).size === 1;
  if (sameHarness && distinct((c) => c.harness_ref)) {
    const byVersion = renamed((c) => `${harnessName(c.harness)} ${harnessVersion(c.harness_ref)}`, (c) => `${harnessShort(c.harness)} ${harnessVersion(c.harness_ref)}`);
    if (!clash(byVersion)) return byVersion;
  }
  if (distinct((c) => `${c.prompt.id} ${c.prompt.version}`)) {
    const byPrompt = renamed((c) => `Prompt ${c.prompt.id} ${c.prompt.version}`, (c) => `${c.prompt.id} ${c.prompt.version}`);
    if (!clash(byPrompt)) return byPrompt;
  }
  const byName = renamed((c) => c.name, (c) => c.name);
  if (!clash(byName)) return byName;
  return arms.map((a) => ({ ...a, label: `Config ${shortHash(a.hash)}`, short: shortHash(a.hash) }));
}

/** A setting's value as it reads in a sentence: "10", "420 s", "on", "not sent", "not supported". */
export function settingWords(config: Pick<ConfigView, 'settings' | 'settings_sources'>, name: SettingName): string {
  if (config.settings_sources?.[name] === 'unsupported') return 'not supported';
  const words = settingValue(name, config.settings?.[name]);
  return words === 'On' || words === 'Off' || words === 'Not sent' ? words.toLowerCase() : words;
}

/** One thing two configs differ in, with each arm's value in words. */
export interface ArmDifference {
  /** "Max steps", "Model", "System prompt"; settings with the same pair of values share one
   *  line: "Memory, skills and compression". */
  what: string;
  a: string;
  b: string;
}

const sameValue = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/** A prompt or toolset by its version when the id is shared ("v2"), else by both ("advisor v1"). */
function versionWords(x: { id: string; version: string; sha256: string }, y: { id: string; version: string; sha256: string }): [string, string] {
  if (x.id !== y.id) return [`${x.id} ${x.version}`, `${y.id} ${y.version}`];
  if (x.version !== y.version) return [x.version, y.version];
  return [`${x.version} (${shortHash(x.sha256)})`, `${y.version} (${shortHash(y.sha256)})`];
}

/** "Memory", "Memory and skills", "Memory, skills and compression" */
function joinLabels(labels: string[]): string {
  const all = labels.map((l, i) => (i ? l.toLowerCase() : l));
  return all.length < 2 ? all[0] : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}

const optionWords = (v: unknown) => (v === undefined || v === null ? 'not set' : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

/**
 * What two configs differ in, in words, each with both arms' values: "Max steps: 10 in A, 12 in
 * B" is { what: 'Max steps', a: '10', b: '12' }. Read from the two saved configs themselves, so it
 * needs no call. A config's name, hash, timestamps and where a setting's value came from are not
 * differences: they change no result. Empty when the configs are the same.
 */
export function armDifferences(a: ConfigView, b: ConfigView): ArmDifference[] {
  const out: ArmDifference[] = [];
  if (a.harness !== b.harness) {
    out.push({ what: 'Harness', a: `${harnessName(a.harness)} ${harnessVersion(a.harness_ref)}`, b: `${harnessName(b.harness)} ${harnessVersion(b.harness_ref)}` });
  } else if (a.harness_ref !== b.harness_ref) {
    out.push({ what: `${harnessName(a.harness)} version`, a: harnessVersion(a.harness_ref), b: harnessVersion(b.harness_ref) });
  } else if (a.adapter_version !== b.adapter_version) {
    out.push({ what: 'Adapter version', a: a.adapter_version, b: b.adapter_version });
  } else if (a.capabilities_sha256 !== b.capabilities_sha256) {
    out.push({ what: 'Harness capabilities file', a: shortHash(a.capabilities_sha256), b: shortHash(b.capabilities_sha256) });
  }
  if (a.model !== b.model) out.push({ what: 'Model', a: modelName(a.model), b: modelName(b.model) });
  if (a.prompt.sha256 !== b.prompt.sha256) {
    const [pa, pb] = versionWords(a.prompt, b.prompt);
    out.push({ what: 'System prompt', a: pa, b: pb });
  }
  if (a.toolset.sha256 !== b.toolset.sha256) {
    const [ta, tb] = versionWords(a.toolset, b.toolset);
    out.push({ what: 'Tools', a: ta, b: tb });
  }
  // Settings that differ, joined when they share a pair of values: a harness change often turns
  // several from "not supported" to "off" at once.
  const settings = new Map<string, { labels: string[]; a: string; b: string }>();
  for (const name of SETTING_NAMES) {
    const wa = settingWords(a, name);
    const wb = settingWords(b, name);
    if (sameValue(a.settings?.[name], b.settings?.[name]) && wa === wb) continue;
    const key = JSON.stringify([wa, wb]);
    const entry = settings.get(key) ?? { labels: [], a: wa, b: wb };
    entry.labels.push(settingLabel(name));
    settings.set(key, entry);
  }
  for (const s of settings.values()) out.push({ what: joinLabels(s.labels), a: s.a, b: s.b });
  const options = [...new Set([...Object.keys(a.harness_options ?? {}), ...Object.keys(b.harness_options ?? {})])].sort();
  for (const key of options) {
    const va = a.harness_options?.[key];
    const vb = b.harness_options?.[key];
    if (!sameValue(va, vb)) out.push({ what: `Harness option ${key.replace(/_/g, ' ')}`, a: optionWords(va), b: optionWords(vb) });
  }
  const seed = (what: string, la: unknown[], lb: unknown[], wa: string, wb: string) => {
    if (!sameValue(la, lb)) out.push({ what, a: wa, b: wa === wb ? `${wb}, worded differently` : wb });
  };
  const memory = (list: string[]) => (list.length ? plural(list.length, 'entry', 'entries') : 'none');
  const skills = (list: { name: string }[]) => (list.length ? list.map((s) => s.name).join(', ') : 'none');
  const [ma, mb] = [a.seed?.memory ?? [], b.seed?.memory ?? []];
  const [sa, sb] = [a.seed?.skills ?? [], b.seed?.skills ?? []];
  seed('Seeded memory', ma, mb, memory(ma), memory(mb));
  seed('Seeded skills', sa, sb, skills(sa), skills(sb));
  return out;
}

/** "Max steps: 10 in A, 12 in B" */
export function differenceText(d: ArmDifference): string {
  return `${d.what}: ${d.a} in A, ${d.b} in B`;
}

/** How one arm's trials of a task stand on grading: some graded and decided; all graded but none
 *  decided (every one undecided); grading not finished for some; or no finished trial at all. */
export type ArmState = 'decided' | 'undecided' | 'grading' | 'none';

export function armState(c: Pick<CompareRow, 'trials' | 'graded' | 'incomplete'> | undefined): ArmState {
  if (!c || !c.trials) return 'none';
  if (c.graded + c.incomplete < c.trials) return 'grading';
  return c.graded ? 'decided' : 'undecided';
}

/** An arm's passes of a task, as the comparison and the Tasks page write them: "2 of 3", "1 of 2,
 *  1 undecided", "1 undecided" (none graded with an outcome), "not graded", "–" (no row). */
export function passedText(c: Pick<CompareRow, 'trials' | 'graded' | 'incomplete' | 'passed'> | undefined): string {
  if (!c) return '–';
  if (!c.graded && c.incomplete) return `${c.incomplete} undecided`;
  if (!c.graded && c.trials) return 'not graded';
  return `${c.passed} of ${c.graded}${c.incomplete ? `, ${c.incomplete} undecided` : ''}`;
}

/** A task with no difference to show, in words, from each arm's state (A first): which arm is
 *  still grading, which is undecided, or which has no trial. "Not graded yet" only while grading
 *  has not finished. */
export function noDiffWords(states: ArmState[]): { tag: string; detail: string } {
  const letters = ['A', 'B'];
  const which = (s: ArmState) => states.map((x, i) => (x === s ? letters[i] : null)).filter((x): x is string => x !== null);
  const both = (list: string[]) => list.length === states.length && states.length > 1;
  const grading = which('grading');
  if (grading.length) return { tag: 'Not graded yet', detail: both(grading) ? 'grading has not finished' : `arm ${grading[0]} is still grading` };
  const none = which('none');
  if (none.length) return { tag: 'No trials', detail: both(none) ? 'no finished trial in either arm' : `arm ${none[0]} has no finished trial` };
  const undecided = which('undecided');
  if (both(undecided) || (states.length === 1 && undecided.length)) return { tag: 'Undecided', detail: states.length > 1 ? 'no trial in either arm has an outcome' : 'no trial has an outcome' };
  if (undecided.length) {
    const other = letters.find((l, i) => i < states.length && l !== undecided[0]) ?? 'A';
    return { tag: `${undecided[0]} undecided`, detail: `arm ${other} has an outcome, arm ${undecided[0]} none` };
  }
  return { tag: 'Not graded yet', detail: '' };
}

/** Whether an arm is named by its config's hash alone ("Config 7f3a9c2"), so a line that also
 *  gives the hash would say it twice. */
export function namedByHash(arm: Pick<Arm, 'label' | 'hash'>): boolean {
  return arm.label === `Config ${shortHash(arm.hash)}`;
}

/** What the arms share, in words: "Hermes with Claude Haiku 5.5". */
export function setupOf(experiment: Pick<ExperimentSummary, 'axis'>, arms: Arm[]): string {
  const c = arms[0]?.config;
  if (!c) return '';
  if (experiment.axis === 'harness') return `${modelName(c.model)}, prompt ${c.prompt.version}`;
  if (experiment.axis === 'model') return `${harnessShort(c.harness)}, prompt ${c.prompt.version}`;
  return `${harnessShort(c.harness)} with ${modelName(c.model)}`;
}

export function axisWords(experiment: Pick<ExperimentSummary, 'axis' | 'config_hashes'> & { calibration?: boolean }): string {
  const { axis, config_hashes: hashes } = experiment;
  if (experiment.calibration) return 'nothing: an A/A calibration (same config twice)';
  if (axis === 'none' || hashes.length < 2 || hashes[0] === hashes[1]) {
    if (hashes.length === 2 && hashes[0] === hashes[1]) return 'nothing (same config twice)';
    return 'nothing (one config)';
  }
  if (axis === 'prompt') return 'the system prompt';
  if (axis === 'harness') return 'the harness';
  if (axis === 'model') return 'the model';
  if (axis === 'tools' || axis === 'toolset') return 'the tools';
  if (axis === 'mixed') return 'more than one thing';
  return `the ${settingLabel(axis).toLowerCase()}`;
}

/** Done trial rows (one row per attempt). */
export function doneCount(counts: ExperimentCounts): number {
  return counts.done;
}

/** Minutes left on a run, from its estimate and how far it has got: null without an estimate. */
export function timeLeft(estimate: { minutes: number } | null | undefined, done: number, total: number): number | null {
  if (!estimate) return null;
  return (estimate.minutes * Math.max(0, total - done)) / Math.max(1, total);
}

export function totalTrials(e: Pick<ExperimentSummary, 'counts' | 'estimate'>): number {
  const c = e.counts;
  const fromCounts = c.queued + c.running + doneCount(c) + c.cancelled;
  return e.estimate?.trials ?? fromCounts;
}

/** The split all the tasks share, in words, or null when they are mixed. */
export function sharedSplit(tasks: TaskView[]): string | null {
  const splits = new Set(tasks.map((t) => t.split));
  return splits.size === 1 ? splitName([...splits][0]) : null;
}

/** What both arms ran on, for a headline read away from its comparison: "LangGraph and Claude
 *  Haiku 5.5" (the harness and model, less whichever one the arms differ in); '' when unknown. */
export function sharedSetupWords(axis: string, arms: Arm[]): string {
  const c = arms[0]?.config;
  if (!c) return '';
  if (axis === 'harness') return modelName(c.model);
  if (axis === 'model') return harnessName(c.harness);
  return `${harnessName(c.harness)} and ${modelName(c.model)}`;
}

/** The shipped example the README and the front door lead with (examples/<name>). */
export const HEADLINE_EXAMPLE = 'headline-prompt-v1-vs-v2';

/** " (shipped example: a replication)": what a shipped example is, by its folder name. */
function exampleWords(name: string | null | undefined): string {
  if (!name) return '';
  if (name.startsWith('replication')) return ' (shipped example: a replication)';
  if (name.startsWith('positive-control')) return ' (shipped example: a positive control)';
  return ' (shipped example)';
}

/**
 * "Prompt v2 beats v1 on the held-out tasks". One sentence per verdict (D42, D10's guardrail).
 * Given where it ran (`context`), the sentence also names the harness and model both arms share
 * and, for a shipped example, which one it is, so it reads true away from its comparison: "Prompt
 * v2 beats v1 on the held-out tasks, with LangGraph and Claude Haiku 5.5 (shipped example: a
 * replication)".
 */
export function headline(stats: Pick<CompareStats, 'verdict'>, arms: Arm[], tasks: TaskView[], context?: { axis: string; example?: string | null }): string {
  const [a, b] = arms;
  const split = sharedSplit(tasks);
  const setup = context ? sharedSetupWords(context.axis, arms) : '';
  const where = `${split ? ` on the ${split} tasks` : ''}${setup ? `, with ${setup}` : ''}`;
  const ex = exampleWords(context?.example);
  if (stats.verdict === 'better') return sentenceStart(`${b.label} beats ${a.short}${where}${ex}`);
  if (stats.verdict === 'worse') return sentenceStart(`${b.label} does worse than ${a.short}${where}${ex}`);
  if (stats.verdict === 'equivalent') return sentenceStart(`${b.label} and ${a.short} are practically equivalent${where}${ex}`);
  if (stats.verdict === 'held_back') return sentenceStart(`${b.label} is not called better than ${a.short}${where}: critical failures rose${ex}`);
  return `No detectable difference between ${a.label} and ${b.short}${where}${ex}`;
}

/** Every arm of the experiment runs a fake model (or its config is unknown and the rest are fake). */
export function fakeOnly(e: Pick<ExperimentSummary, 'config_hashes'>, configs: ConfigView[]): boolean {
  const models = e.config_hashes.map((h) => configs.find((c) => c.hash === h)?.model);
  return models.some((m) => m !== undefined) && models.every((m) => m === undefined || isFake(m));
}

/**
 * The finished A/B the Experiments page leads with: of `finished` (newest made first) that `ready`
 * accepts, the one that finished last, by its `finished_at` (else when it was made); on a tie, the
 * one made last. A shipped example competes like any run: the page says "Latest result", and the
 * shipped headline led though the model-axis run and runs of your own finished after it (QA,
 * 7 Nov). A run on fake models only never leads: its pass rates test the platform, not an agent.
 */
export function pickLatest(finished: ExperimentSummary[], configs: ConfigView[], ready: (e: ExperimentSummary) => boolean): ExperimentSummary | null {
  const at = (e: ExperimentSummary) => Date.parse(e.finished_at ?? e.created_at);
  return finished.filter((e) => ready(e) && !fakeOnly(e, configs)).reduce<ExperimentSummary | null>((best, e) => (!best || at(e) > at(best) ? e : best), null);
}

/**
 * A sentence that opens with an arm's name starts with a capital, unless the name is an identifier
 * that keeps its case ("v2", "finance-advisor v2", a short hash): "tools finance-rag v1 beats ..."
 * reads "Tools finance-rag v1 beats ..." (QA, 7 Nov), and "v2 beats v1" stays as it is.
 */
export function sentenceStart(text: string): string {
  const first = text.split(' ')[0];
  if (!/^[a-z]+$/.test(first) || /^[0-9a-f]{7}$/.test(first)) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Each arm's name in running text, A first: its short name, or "A" and "B" when both arms share
 *  one (an A/A run names both by one config hash: "9051fae 62%, 9051fae 58%" told them apart by
 *  nothing; QA, 7 Nov). */
export function armWords(arms: Arm[]): [string, string] {
  const [a, b] = arms;
  if (!a || !b || a.short === b.short) return ['A', 'B'];
  return [a.short, b.short];
}

/** "v2 beats v1": the same verbs as headline(), with each arm's short name. */
export function verdictTitle(stats: Pick<CompareStats, 'verdict'>, arms: Arm[]): string {
  const [a, b] = arms;
  if (stats.verdict === 'better') return sentenceStart(`${b.short} beats ${a.short}`);
  if (stats.verdict === 'worse') return sentenceStart(`${b.short} does worse than ${a.short}`);
  if (stats.verdict === 'equivalent') return 'Practically equivalent';
  if (stats.verdict === 'held_back') return sentenceStart(`${b.short} is not called better: critical failures rose`);
  return 'No detectable difference';
}

/** A verdict as a short tag ("Better", "Practically equivalent"), for lists. */
export function verdictWords(verdict: CompareStats['verdict']): string {
  return { better: 'Better', worse: 'Worse', equivalent: 'Practically equivalent', no_detectable_difference: 'No detectable difference', held_back: 'Not called better' }[verdict];
}

/** A no-break space (U+00A0): keeps a number with its unit, and "κ" or "p =" with its value. */
export const NBSP = '\u00a0';

/** "+15 points (+7 to +23)", "+1 point (−7 to +9)", the number and its unit never split. */
export function pointsWithInterval(i: Interval, unit = 'points'): string {
  const word = unit === 'points' && Math.abs(i.estimate) === 1 ? 'point' : unit;
  return `${signed(i.estimate)}${word ? `${NBSP}${word}` : ''} (${signed(i.low)} to ${signed(i.high)})`;
}

export function intervalText(i: Interval): string {
  return `${signed(i.low)} to ${signed(i.high)}`;
}

export function excludesZero(i: Interval): boolean {
  return i.low > 0 || i.high < 0;
}

/** An interval with no width: every task gave the same difference, so it shows no spread, which
 *  is not the same as a small one (D55: such an interval never gives "practically equivalent"). */
export function noWidth(i: Interval): boolean {
  return i.high === i.low;
}

/** How wide an interval reads on the page: its bounds as `signed` rounds them, high minus low, so
 *  "−79 to +79" is 158 points wide even when the unrounded bounds are 158.7 apart. */
export function shownWidth(i: Interval): number {
  return Number(i.high.toFixed(0)) - Number(i.low.toFixed(0));
}

/** The statistics step's method ids, in words. An id not listed here is shown as it is. */
export const METHOD_NAMES: Record<string, string> = {
  paired_task_bootstrap: 'Paired task bootstrap',
};

export function methodName(id: string): string {
  return METHOD_NAMES[id] ?? id;
}

/** What a result rests on when every task that differs needs the judge's pass. `lead` is the
 *  point it opens with, which the page sets in bold before a colon; `before`, `link` and `after`
 *  follow it, and `link` is the part that opens the Judge page. `text` is the whole sentence. */
export interface JudgeCaveat {
  text: string;
  lead: string;
  before: string;
  link: string;
  after: string;
  /** The task ids named in `before`, for the page to set in mono and keep whole. */
  idents: string[];
}

type JudgeStats = NonNullable<CompareStats['judge']>;

/** Where the judge stands against the trust bar, by its trust status (D83), after its figures. */
const STANDING: Partial<Record<JudgeStats['status'], string>> = {
  trusted: 'clearing the trust bar',
  not_trusted: 'short of the trust bar',
  too_few: 'on too few labels to test against the trust bar yet',
};

/** The judge's agreement with you, estimate first and then its interval, then where it stands
 *  against the trust bar: what follows "Its agreement with you". Where it stands is the trust
 *  status the API gives, the one the Judge page shows, never worked out here from the figures:
 *  the trust bar (D8) is more than kappa against 0.6, so a judge with too few "no" labels, or
 *  one kinder to one arm, can have a high kappa and still not be trusted (review 7 Nov). Values
 *  that round to zero read 0.00, never −0.00. Ends with the full stop. "Provisional" only where it
 *  is so: a judge the trust bar has not been applied to yet, with held-out outputs still to label.
 *  Trusted and not trusted are the bar's answer on the labels there are, so they are not called
 *  provisional beside a "Not trusted" badge (QA, 7 Nov). */
export function agreementWords(judge: Pick<JudgeStats, 'kappa' | 'low' | 'high' | 'status'>, toGo: number): string {
  const k = `κ${NBSP}${kappaWords(judge.kappa)}`;
  const interval = `${kappaWords(judge.low)} to ${kappaWords(judge.high)}`;
  const standing = STANDING[judge.status] ?? 'not yet tested against the trust bar';
  const provisional = toGo > 0 && judge.status !== 'trusted' && judge.status !== 'not_trusted';
  return ` is ${k} (interval ${interval}), ${standing}${provisional ? ', so it is provisional until more outputs are labelled.' : '.'}`;
}

/** "the one task that differs needs", "both tasks that differ need", "all 3 tasks that differ need" */
function differingWords(n: number): string {
  return n === 1 ? 'the one task that differs needs' : n === 2 ? 'both tasks that differ need' : `all ${n} tasks that differ need`;
}

/** "the one that differs", "both that differ", "all 3 that differ" */
export function differingShort(n: number): string {
  return n === 1 ? 'the one that differs' : n === 2 ? 'both that differ' : `all ${n} that differ`;
}

/** "debt-hardship-03 also has a state check; x also has a unit test and an exact match" */
function alsoGradedWords(tasks: { name: string; graders: string[] }[]): string {
  const list = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
  return tasks.map((t) => `${t.name} also has ${list(t.graders)}`).join('; ');
}

/** Says a verdict rests on the judge, and how far the judge can be trusted, when every task that
 *  differs after correction needs the judge's pass. A task passes only when all its checks pass,
 *  so a task with a judge check needs the judge's pass even when a code grader also checks it:
 *  `alsoGraded` names those code graders ("a state check"), and the sentence lists them in
 *  brackets. Null when there is no judge, no differing task, or a differing task with no judge
 *  check. */
export function judgeCaveat<T>(args: {
  differing: T[];
  isJudged: (task: T) => boolean;
  judge: CompareStats['judge'] | null | undefined;
  toGo: number;
  /** The task's name and its graders other than the judge, with their article; null or no
   *  graders when the judge is its only one. */
  alsoGraded?: (task: T) => { name: string; graders: string[] } | null;
}): JudgeCaveat | null {
  const { differing, isJudged, judge, toGo, alsoGraded } = args;
  if (!judge || !differing.length || !differing.every(isJudged)) return null;
  const mixed = alsoGraded ? differing.map(alsoGraded).filter((t): t is { name: string; graders: string[] } => !!t && t.graders.length > 0) : [];
  const brackets = mixed.length ? ` (${alsoGradedWords(mixed)})` : '';
  const lead = 'Rests on the judge';
  const before = `${differingWords(differing.length)} the judge's pass${brackets}. Its `;
  const link = 'agreement with you';
  const after = agreementWords(judge, toGo);
  return { text: `${lead}: ${before}${link}${after}`, lead, before, link, after, idents: mixed.map((t) => t.name) };
}

/** Checks still to label: one per question on each queued output. */
export function checksToGo(queue: { criteria: unknown[] }[]): number {
  return queue.reduce((sum, item) => sum + item.criteria.length, 0);
}
