/** The arms of an experiment in words: A is the first config hash, B the second. */
import type { CompareStats, Config, Experiment, Interval, TaskInfo, TrialCounts } from '../api/types';
import { shortHash, signed } from './format';
import { harnessName, harnessShort, modelName, settingLabel, splitName } from './names';

export type ArmKey = 'a' | 'b';

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

/** "+15 pts (+7 to +23)" */
export function pointsWithInterval(i: Interval, unit = 'pts'): string {
  return `${signed(i.estimate)}${unit ? ` ${unit}` : ''} (${signed(i.low)} to ${signed(i.high)})`;
}

export function intervalText(i: Interval): string {
  return `${signed(i.low)} to ${signed(i.high)}`;
}

export function excludesZero(i: Interval): boolean {
  return i.low > 0 || i.high < 0;
}
