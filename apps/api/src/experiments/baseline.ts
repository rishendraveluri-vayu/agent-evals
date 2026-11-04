/**
 * D34: whether a new experiment can reuse its parent's arm-A trials instead of running arm A again.
 * Reuse is allowed only when nothing that could change arm A's outcome differs:
 * - the parent's arm-A config hash is this arm A (the hash covers harness, adapter, capabilities,
 *   model, prompt, toolset, settings and options, so the invariance diff is empty);
 * - the task hashes are the same set;
 * - both ran under the same, known platform commit;
 * - the simulator model and prompt are the same (the simulator's settings follow from its model);
 * - the parent has at least N finished (`done`) arm-A trials for every task.
 * Otherwise arm A is queued and run alongside B. Either way the reason is recorded.
 */

export interface BaselineInput {
  parent: {
    id: string;
    armA: string;
    tasks: string[];
    platformCommit: string | null;
    simModel: string | null;
    simPromptSha256: string | null;
  };
  armA: string;
  tasks: string[];
  platformCommit: string | null;
  simModel: string | null;
  simPromptSha256: string | null;
  n: number;
  /** The parent's finished arm-A trials, per task, in the order to take them (repeat, attempt). */
  finished: Map<string, string[]>;
}

export interface BaselineOutcome {
  applied: boolean;
  reason: string;
  /** The parent's trials arm A takes, N per task, when applied; empty otherwise. */
  trialIds: string[];
}

const short = (h: string | null): string => (h ? h.replace(/^sha256:/, '').slice(0, 12) : 'none');

export function decideBaseline(input: BaselineInput): BaselineOutcome {
  const { parent } = input;
  const why: string[] = [];
  if (parent.armA !== input.armA) why.push(`the parent's arm A is config ${short(parent.armA)}, this arm A is ${short(input.armA)}`);
  const same = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  if (!same(parent.tasks, input.tasks)) why.push(`the task sets differ (${parent.tasks.length} tasks in the parent, ${input.tasks.length} here)`);
  if (!input.platformCommit || !parent.platformCommit) {
    why.push('the platform commit is not known for both, so they cannot be shown to match');
  } else if (parent.platformCommit !== input.platformCommit) {
    why.push(`the platform commit differs (parent ${parent.platformCommit}, now ${input.platformCommit})`);
  }
  if (parent.simModel !== input.simModel) why.push(`the simulator model differs (parent ${parent.simModel ?? 'none'}, here ${input.simModel ?? 'none'})`);
  else if (parent.simPromptSha256 !== input.simPromptSha256) why.push(`the simulator prompt differs (parent ${short(parent.simPromptSha256)}, here ${short(input.simPromptSha256)})`);
  const missing = input.tasks.filter((t) => (input.finished.get(t)?.length ?? 0) < input.n);
  if (missing.length) {
    const least = Math.min(...input.tasks.map((t) => input.finished.get(t)?.length ?? 0));
    why.push(`the parent has fewer than N=${input.n} finished arm-A trials for ${missing.length} of ${input.tasks.length} tasks (as few as ${least})`);
  }
  if (why.length) {
    return { applied: false, reason: `arm A runs again: ${why.join('; ')}`, trialIds: [] };
  }
  const trialIds = input.tasks.flatMap((t) => (input.finished.get(t) ?? []).slice(0, input.n));
  return {
    applied: true,
    reason:
      `arm A reuses ${trialIds.length} finished trials of ${parent.id} (N=${input.n} for each of ${input.tasks.length} tasks): ` +
      `same config, tasks, platform commit ${input.platformCommit} and simulator`,
    trialIds,
  };
}
