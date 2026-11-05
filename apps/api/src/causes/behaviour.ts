import type { BehaviourArm, BehaviourStat, CauseKind, CompareBehaviour, Regression, RegressionCause, StatsInterval, TrialCause } from '../contract';
import { CAUSE_KINDS } from '../contract';
import { type TaskSample, bootstrapTasks, percentileInterval, valuesArm } from '../stats/bootstrap';
import { seededStream } from '../stats/random';
import { CAUSE_RULES_VERSION, bareTool } from './causes';

/**
 * D64: how each arm behaved, beside the pass-rate verdict and never part of it. Per arm, over its
 * done trials: tool calls in all and by tool, how often each tool the task wants was called, tool
 * errors, steps (model calls, D17) and step-limit hits, end states and failure causes. Tool calls
 * and steps per trial also get B minus A per task with the costs' task bootstrap (D10), and no
 * verdict, like cost. Pure: the same trials and seed always give the same numbers.
 */

export interface BehaviourTrial {
  trial_id: string;
  arm: 'A' | 'B';
  task: string;
  end_state: string | null;
  /** LiteLLM's count of the agent's model calls; null when it has no record. */
  model_calls: number | null;
  /** The tools the task wants (causes.ts wantedTools). */
  wanted: string[];
  calls: { name: string; is_error: boolean }[];
  cause: TrialCause | null;
}

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function interval(estimate: number, lowHigh: [number, number], scale: number, places: number): StatsInterval {
  return { estimate: round(estimate * scale, places), low: round(lowHigh[0] * scale, places), high: round(lowHigh[1] * scale, places) };
}

const kindOrder = (k: CauseKind): number => CAUSE_KINDS.indexOf(k);

function armOf(arm: string, trials: BehaviourTrial[]): BehaviourArm {
  const n = trials.length;
  const perTrial = (total: number): number | null => (n ? round(total / n, 3) : null);
  const tools = new Map<string, { calls: number; errors: number; trials: number }>();
  const required = new Map<string, { trials: number; called: number }>();
  const ends = new Map<string, number>();
  const causes = new Map<CauseKind, { primary: number; contributing: number }>();
  let calls = 0;
  let errors = 0;
  let withError = 0;
  let steps = 0;
  let measured = 0;
  let stepLimit = 0;
  let withCause = 0;
  for (const t of trials) {
    const names = t.calls.map((c) => bareTool(c.name));
    calls += names.length;
    const errs = t.calls.filter((c) => c.is_error).length;
    errors += errs;
    if (errs) withError += 1;
    t.calls.forEach((c, i) => {
      const row = tools.get(names[i]) ?? { calls: 0, errors: 0, trials: 0 };
      row.calls += 1;
      if (c.is_error) row.errors += 1;
      tools.set(names[i], row);
    });
    for (const name of new Set(names)) tools.get(name)!.trials += 1;
    for (const w of t.wanted) {
      const row = required.get(w) ?? { trials: 0, called: 0 };
      row.trials += 1;
      if (names.includes(w)) row.called += 1;
      required.set(w, row);
    }
    if (t.model_calls !== null) {
      steps += t.model_calls;
      measured += 1;
    }
    if (t.end_state === 'step_limit') stepLimit += 1;
    const end = t.end_state ?? 'not recorded';
    ends.set(end, (ends.get(end) ?? 0) + 1);
    if (t.cause) {
      withCause += 1;
      const bump = (k: CauseKind, key: 'primary' | 'contributing') => {
        const row = causes.get(k) ?? { primary: 0, contributing: 0 };
        row[key] += 1;
        causes.set(k, row);
      };
      bump(t.cause.cause, 'primary');
      // A cause listed twice on one trial (two contributing `other`s cannot happen, but be safe) counts once.
      for (const k of new Set(t.cause.contributing.map((c) => c.cause))) if (k !== t.cause.cause) bump(k, 'contributing');
    }
  }
  return {
    arm,
    trials: n,
    tool_calls: { total: calls, per_trial: perTrial(calls) },
    by_tool: [...tools.entries()]
      .map(([tool, r]) => ({ tool, calls: r.calls, per_trial: round(r.calls / n, 3), errors: r.errors, trials: r.trials }))
      .sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool)),
    required_tools: [...required.entries()]
      .map(([tool, r]) => ({ tool, trials: r.trials, called: r.called, share: round(r.called / r.trials, 4) }))
      .sort((x, y) => x.tool.localeCompare(y.tool)),
    tool_errors: { total: errors, per_trial: perTrial(errors), trials: withError },
    steps: { trials_measured: measured, per_trial: measured ? round(steps / measured, 3) : null, step_limit: stepLimit },
    end_states: [...ends.entries()].map(([end_state, k]) => ({ end_state, trials: k })).sort((x, y) => y.trials - x.trials || x.end_state.localeCompare(y.end_state)),
    causes: {
      trials: withCause,
      by_cause: [...causes.entries()].map(([cause, r]) => ({ cause, ...r })).sort((x, y) => kindOrder(x.cause) - kindOrder(y.cause)),
    },
  };
}

const PAIRED: { metric: BehaviourStat['metric']; value: (t: BehaviourTrial) => number | null }[] = [
  { metric: 'tool_calls', value: (t) => t.calls.length },
  { metric: 'steps', value: (t) => t.model_calls },
];

/** B minus A per task, as costsOf in stats/analysis.ts does it: tasks with a value in both arms. */
function pairedOf(seed: string, trials: BehaviourTrial[], tasks: string[], resamples: number): BehaviourStat[] {
  const out: BehaviourStat[] = [];
  for (const m of PAIRED) {
    const samples: TaskSample[] = [];
    const counted = { a: 0, b: 0 };
    for (const task of tasks) {
      const vals = (arm: 'A' | 'B') => trials.filter((t) => t.task === task && t.arm === arm).map(m.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const a = vals('A');
      const b = vals('B');
      if (!a.length || !b.length) continue;
      counted.a += a.length;
      counted.b += b.length;
      samples.push({ a: valuesArm(a), b: valuesArm(b) });
    }
    if (!samples.length) continue;
    // Its own stream, so adding a metric never moves another's numbers.
    const draws = bootstrapTasks(samples, seededStream(`${seed}:behaviour:${m.metric}`), { resamples });
    const meanA = samples.reduce((s, x) => s + x.a.mean, 0) / samples.length;
    const meanB = samples.reduce((s, x) => s + x.b.mean, 0) / samples.length;
    out.push({
      metric: m.metric,
      tasks: samples.length,
      a: round(meanA, 3),
      b: round(meanB, 3),
      diff: interval(meanB - meanA, percentileInterval(draws.diff), 1, 3),
      relative: meanA !== 0 && draws.relative.length ? interval(meanB / meanA - 1, percentileInterval(draws.relative), 100, 2) : null,
      trials: counted,
    });
  }
  return out;
}

/**
 * The behaviour of each arm (`arms`: ['A'] for a pilot, ['A', 'B'] otherwise) over its done
 * trials; `tasks` in the experiment's order, for the paired differences.
 */
export function behaviourOf(seed: string, arms: readonly ('A' | 'B')[], tasks: readonly string[], trials: readonly BehaviourTrial[], opts: { resamples?: number } = {}): CompareBehaviour {
  const ordered = [...trials];
  return {
    rules_version: CAUSE_RULES_VERSION,
    arms: arms.map((a) => armOf(a, ordered.filter((t) => t.arm === a))),
    paired: arms.length === 2 ? pairedOf(seed, ordered, [...tasks], opts.resamples ?? 10_000) : [],
  };
}

/**
 * D64 on the regression list: each failed trial's cause, and per task the primary causes that
 * were more common in B than in A, with both counts, most grown first. New objects: the
 * statistics' cached regressions are never changed.
 */
export function withRegressionCauses(regressions: readonly Regression[], trials: readonly Pick<BehaviourTrial, 'trial_id' | 'task' | 'arm' | 'cause'>[]): Regression[] {
  const byId = new Map(trials.map((t) => [t.trial_id, t.cause]));
  return regressions.map((r) => {
    const counts = new Map<CauseKind, RegressionCause>();
    for (const t of trials) {
      if (t.task !== r.task || !t.cause) continue;
      const row = counts.get(t.cause.cause) ?? { cause: t.cause.cause, a: 0, b: 0 };
      if (t.arm === 'A') row.a += 1;
      else row.b += 1;
      counts.set(t.cause.cause, row);
    }
    const grew = [...counts.values()].filter((c) => c.b > c.a).sort((x, y) => y.b - y.a - (x.b - x.a) || kindOrder(x.cause) - kindOrder(y.cause));
    return { ...r, failed_trials: r.failed_trials.map((f) => ({ ...f, cause: byId.get(f.trial_id) ?? null })), causes_grew: grew };
  });
}
