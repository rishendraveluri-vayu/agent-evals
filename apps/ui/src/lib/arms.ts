/** The arms of an experiment in words: A is the first config hash, B the second. */
import type { CompareStats, Config, Experiment, Interval, TaskInfo, TrialCounts } from '../api/types';
import { shortHash, signed } from './format';
import { harnessName, harnessShort, modelName, settingLabel, splitName } from './names';

export type ArmKey = 'a' | 'b';

/** How arm B did against arm A, as one tag shows it everywhere: better and worse only when the
 *  difference holds up, none when it does not, pending before there is an interval. */
export type Verdict = 'better' | 'worse' | 'none' | 'pending';

export interface Arm {
  key: ArmKey;
  hash: string;
  config: Config | undefined;
  /** "Prompt v2", "Hermes Agent", "Config 7f3a9c2" */
  label: string;
  /** "v2", "Hermes", "7f3a9c2" */
  short: string;
}

export function armsOf(experiment: Pick<Experiment, 'axis' | 'config_hashes'>, configs: Config[]): Arm[] {
  const sameTwice = experiment.config_hashes.length === 2 && experiment.config_hashes[0] === experiment.config_hashes[1];
  return experiment.config_hashes.slice(0, 2).map((hash, i) => {
    const config = configs.find((c) => c.hash === hash);
    const byHash = { label: `Config ${shortHash(hash)}`, short: shortHash(hash) };
    let names = byHash;
    if (config && !sameTwice) {
      const byPrompt = { label: `Prompt ${config.prompt.version}`, short: config.prompt.version };
      if (experiment.config_hashes.length === 1 || experiment.axis === 'prompt') names = byPrompt;
      else if (experiment.axis === 'harness') names = { label: harnessName(config.harness), short: harnessShort(config.harness) };
      else if (experiment.axis === 'model') names = { label: modelName(config.model), short: modelName(config.model) };
    }
    return { key: i === 0 ? 'a' : 'b', hash, config, ...names };
  });
}

/** What the arms share, in words: "Hermes with Claude Haiku 5.5". */
export function setupOf(experiment: Pick<Experiment, 'axis'>, arms: Arm[]): string {
  const c = arms[0]?.config;
  if (!c) return '';
  if (experiment.axis === 'harness') return `${modelName(c.model)}, prompt ${c.prompt.version}`;
  if (experiment.axis === 'model') return `${harnessShort(c.harness)}, prompt ${c.prompt.version}`;
  return `${harnessShort(c.harness)} with ${modelName(c.model)}`;
}

export function axisWords(experiment: Pick<Experiment, 'axis' | 'config_hashes'>): string {
  const { axis, config_hashes: hashes } = experiment;
  if (axis === 'none' || hashes.length < 2 || hashes[0] === hashes[1]) {
    if (hashes.length === 2 && hashes[0] === hashes[1]) return 'nothing (same config twice)';
    return 'nothing (one config)';
  }
  if (axis === 'prompt') return 'the system prompt';
  if (axis === 'harness') return 'the harness';
  if (axis === 'model') return 'the model';
  if (axis === 'tools' || axis === 'toolset') return 'the tools';
  return `the ${settingLabel(axis).toLowerCase()}`;
}

/** Done trials, whether the API sends a number or a count per label. */
export function doneCount(counts: TrialCounts): number {
  return typeof counts.done === 'number' ? counts.done : Object.values(counts.done).reduce((a, b) => a + b, 0);
}

/** Minutes left on a run, from its estimate and how far it has got: null without an estimate. */
export function timeLeft(estimate: { minutes: number } | null | undefined, done: number, total: number): number | null {
  if (!estimate) return null;
  return (estimate.minutes * Math.max(0, total - done)) / Math.max(1, total);
}

export function totalTrials(e: Pick<Experiment, 'counts' | 'estimate'>): number {
  const c = e.counts;
  const fromCounts = c.queued + c.running + doneCount(c) + c.cancelled;
  return e.estimate?.trials ?? fromCounts;
}

/** The split all the tasks share, in words, or null when they are mixed. */
export function sharedSplit(tasks: TaskInfo[]): string | null {
  const splits = new Set(tasks.map((t) => t.split));
  return splits.size === 1 ? splitName([...splits][0]) : null;
}

/** "Prompt v2 beats v1 on the held-out tasks" */
export function headline(stats: CompareStats, arms: Arm[], tasks: TaskInfo[]): string {
  const [a, b] = arms;
  const split = sharedSplit(tasks);
  const where = split ? ` on the ${split} tasks` : '';
  if (stats.verdict === 'better') return `${b.label} beats ${a.short}${where}`;
  if (stats.verdict === 'worse') return `${b.label} does worse than ${a.short}${where}`;
  return `No clear difference between ${a.label} and ${b.short}${where}`;
}

/** "v2 is better" */
export function verdictTitle(stats: CompareStats, arms: Arm[]): string {
  const b = arms[1];
  if (stats.verdict === 'better') return `${b.short} is better`;
  if (stats.verdict === 'worse') return `${b.short} is worse`;
  return 'No clear difference';
}

/** "+15 points (+7 to +23)", "+1 point (−7 to +9)" */
export function pointsWithInterval(i: Interval, unit = 'points'): string {
  const word = unit === 'points' && Math.abs(i.estimate) === 1 ? 'point' : unit;
  return `${signed(i.estimate)}${word ? ` ${word}` : ''} (${signed(i.low)} to ${signed(i.high)})`;
}

export function intervalText(i: Interval): string {
  return `${signed(i.low)} to ${signed(i.high)}`;
}

export function excludesZero(i: Interval): boolean {
  return i.low > 0 || i.high < 0;
}

/** The statistics step's method ids, in words. An id not listed here is shown as it is. */
export const METHOD_NAMES: Record<string, string> = {
  paired_task_bootstrap: 'Paired task bootstrap',
};

export function methodName(id: string): string {
  return METHOD_NAMES[id] ?? id;
}

/** What a result rests on when every task that differs is judge-graded. `link` is the part that
 *  opens the Judge page; `text` is the whole sentence. */
export interface JudgeCaveat {
  text: string;
  before: string;
  link: string;
  after: string;
}

type JudgeStats = NonNullable<CompareStats['judge']>;

/** The judge's agreement with you, estimate first and then its interval, against the bar: what
 *  follows "Its agreement with you". Three cases: the whole interval clears the bar, the estimate
 *  clears it but the interval reaches below, or the estimate is below. Ends with the full stop. */
export function agreementWords(judge: Pick<JudgeStats, 'kappa' | 'low' | 'high' | 'bar'>, toGo: number): string {
  const k = judge.kappa.toFixed(2);
  const interval = `${judge.low.toFixed(2)} to ${judge.high.toFixed(2)}`;
  let words: string;
  if (judge.low >= judge.bar) words = ` is κ ${k} (interval ${interval}), clearing the ${judge.bar} bar`;
  else if (judge.kappa >= judge.bar) words = ` is κ ${k}, above the ${judge.bar} bar, but the interval (${interval}) reaches below it`;
  else words = ` is κ ${k} (interval ${interval}), below the ${judge.bar} bar`;
  return `${words}${toGo > 0 ? ', and it is provisional.' : '.'}`;
}

/** "the one task that differs", "both tasks that differ", "all 3 tasks that differ" */
function differingWords(n: number): string {
  return n === 1 ? 'the one task that differs is' : n === 2 ? 'both tasks that differ are' : `all ${n} tasks that differ are`;
}

/** "the one that differs", "both that differ", "all 3 that differ" */
export function differingShort(n: number): string {
  return n === 1 ? 'the one that differs' : n === 2 ? 'both that differ' : `all ${n} that differ`;
}

/** Says a verdict rests on the judge, and how far the judge can be trusted, when every task that
 *  differs after correction is judge-graded. Null when there is no judge, no differing task, or a
 *  differing task that a code grader also sees. */
export function judgeCaveat<T>(args: {
  differing: T[];
  isJudged: (task: T) => boolean;
  judge: CompareStats['judge'] | null | undefined;
  toGo: number;
}): JudgeCaveat | null {
  const { differing, isJudged, judge, toGo } = args;
  if (!judge || !differing.length || !differing.every(isJudged)) return null;
  const before = `Rests on the judge: ${differingWords(differing.length)} judge-graded. Its `;
  const link = 'agreement with you';
  const after = agreementWords(judge, toGo);
  return { text: `${before}${link}${after}`, before, link, after };
}

/** Checks still to label: one per question on each queued output. */
export function checksToGo(queue: { criteria: unknown[] }[]): number {
  return queue.reduce((sum, item) => sum + item.criteria.length, 0);
}
