import { type AnalysisOptions, type TaskInput, analyse } from './analysis';
import { type Rand, seededStream } from './random';

/**
 * Simulated experiments with a known truth, for the SP6 done-when tests (stats proposal section 7)
 * and for measuring the method: K tasks, N trials per task and arm. Each task has its own pass
 * rate, drawn uniformly from [low, high] (tasks differ in difficulty, as real ones do); arm B's
 * rate on a task is arm A's plus `effect` (in points), so the true mean difference over tasks is
 * exactly `effect` while the rates stay inside [0, 1]. Nothing here is real data.
 */
export interface SimSpec {
  tasks: number;
  trials: number;
  /** B minus A, in points. */
  effect: number;
  low?: number;
  high?: number;
}

export function simulatedTasks(spec: SimSpec, rand: Rand): TaskInput[] {
  const low = spec.low ?? 0.1;
  const high = spec.high ?? 0.75;
  if (high + spec.effect / 100 > 1 || low + spec.effect / 100 < 0) throw new Error('the effect would push a rate outside [0, 1]');
  return Array.from({ length: spec.tasks }, (_, i) => {
    const pa = low + (high - low) * rand();
    const pb = pa + spec.effect / 100;
    const trial = (arm: 'A' | 'B', r: number, p: number) => ({
      trial_id: `t${i}-${arm}-${r}`,
      arm,
      outcome: rand() < p ? ('pass' as const) : ('fail' as const),
      grades: [],
      cost_usd: null,
      tokens: null,
      wall_s: null,
      retried: false,
    });
    const trials = [];
    for (let r = 0; r < spec.trials; r += 1) trials.push(trial('A', r, pa), trial('B', r, pb));
    return { task: `sha256:sim-${i}`, task_id: `sim-${i}`, trials };
  });
}

export interface SimSummary {
  runs: number;
  better: number;
  worse: number;
  equivalent: number;
  none: number;
  /** Runs whose interval holds the true effect. */
  covered: number;
  /** Mean interval width, in points. */
  width: number;
}

/** `runs` simulated experiments, each analysed as the API would (with `options`). */
export function simulate(spec: SimSpec, runs: number, seed: string, options: AnalysisOptions = {}): SimSummary {
  const rand = seededStream(`${seed}:data`);
  const out: SimSummary = { runs, better: 0, worse: 0, equivalent: 0, none: 0, covered: 0, width: 0 };
  for (let i = 0; i < runs; i += 1) {
    const { stats } = analyse({ seed: `${seed}:${i}`, tasks: simulatedTasks(spec, rand) }, { costs: false, ...options });
    if (!stats) throw new Error('every simulated task has decided trials');
    if (stats.verdict === 'better') out.better += 1;
    else if (stats.verdict === 'worse') out.worse += 1;
    else if (stats.verdict === 'equivalent') out.equivalent += 1;
    else out.none += 1;
    if (stats.diff.low <= spec.effect && spec.effect <= stats.diff.high) out.covered += 1;
    out.width += (stats.diff.high - stats.diff.low) / runs;
  }
  return out;
}
