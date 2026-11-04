import { quantileSorted } from './methods';
import type { Rand } from './random';

/**
 * The task bootstrap (D10, revised 5 Nov): the interval of the mean over tasks of B - A. Each
 * resample draws K tasks with replacement and takes the mean of their observed differences; the
 * 2.5th and 97.5th percentiles of the resampled means are the 95% interval (percentile method).
 *
 * Why tasks only: each task's observed pass rate already carries its trial-to-trial noise, so
 * the spread between tasks' observed differences includes it. Drawing the trials again inside
 * each drawn task (the first design, "two-level") counts that noise a second time and makes the
 * interval too wide (Davison and Hinkley 1997, section 3.8). `levels: 2` keeps that design so the
 * simulation tests can show the difference; the API never uses it.
 */

/**
 * One arm of one task: its observed mean, and what a redraw of its trials needs. Plain data with
 * one shape, read by drawArm, so the hot loop stays fast.
 */
export interface ArmSample {
  mean: number;
  /** Trials. */
  n: number;
  /** Pass/fail arms: the cumulative Binomial(n, mean) distribution of the number of passes. */
  cdf: Float64Array | null;
  /** Arms with one number per trial (cost, tokens, seconds). */
  values: readonly number[] | null;
}

/**
 * An arm whose trials are pass (1) or fail (0): s of n. Drawing n trials with replacement from s
 * passes and n - s fails gives Binomial(n, s/n) passes, drawn here from its exact distribution
 * with one random number (the same distribution as drawing the n trials one by one, much faster).
 */
export function binaryArm(s: number, n: number): ArmSample {
  if (n <= 0) throw new Error('an arm needs at least one decided trial');
  const p = s / n;
  if (s === 0 || s === n) return { mean: p, n, cdf: null, values: null };
  const logs = [0];
  for (let i = 1; i <= n; i += 1) logs.push(logs[i - 1] + Math.log(i));
  const cdf = new Float64Array(n + 1);
  let total = 0;
  for (let k = 0; k <= n; k += 1) {
    total += Math.exp(logs[n] - logs[k] - logs[n - k] + k * Math.log(p) + (n - k) * Math.log(1 - p));
    cdf[k] = total;
  }
  for (let k = 0; k <= n; k += 1) cdf[k] /= total;
  return { mean: p, n, cdf, values: null };
}

/** An arm with one number per trial (cost, tokens, seconds): resampled as they are. */
export function valuesArm(values: readonly number[]): ArmSample {
  const n = values.length;
  if (n <= 0) throw new Error('an arm needs at least one value');
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return { mean, n, cdf: null, values: n > 1 ? values : null };
}

/** The mean of the arm's trials drawn again with replacement (as many as it has). */
export function drawArm(arm: ArmSample, rand: Rand): number {
  const cdf = arm.cdf;
  if (cdf !== null) {
    const u = rand();
    let lo = 0;
    let hi = arm.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] > u) hi = mid;
      else lo = mid + 1;
    }
    return lo / arm.n;
  }
  const values = arm.values;
  if (values === null) return arm.mean;
  let sum = 0;
  for (let i = 0; i < arm.n; i += 1) sum += values[Math.floor(rand() * arm.n)];
  return sum / arm.n;
}

export interface TaskSample {
  a: ArmSample;
  b: ArmSample;
}

export interface BootstrapDraws {
  /** Resampled mean over tasks of B - A, sorted ascending. */
  diff: Float64Array;
  /** Resampled (mean over tasks of B) / (mean over tasks of A) - 1, sorted; resamples with a zero A mean are left out. */
  relative: Float64Array;
}

/**
 * `levels`: 1 (the method, D10 revised) resamples tasks only, keeping each task's observed means.
 * 2 is the first design (tasks, then trials within each task and arm), kept only so the
 * simulation tests can measure how much it widens the interval (docs/known-limits.md).
 */
export function bootstrapTasks(tasks: readonly TaskSample[], rand: Rand, opts: { resamples: number; levels?: 1 | 2 }): BootstrapDraws {
  const k = tasks.length;
  if (k === 0) throw new Error('the bootstrap needs at least one task');
  const two = (opts.levels ?? 1) === 2;
  const diff = new Float64Array(opts.resamples);
  const relative = new Float64Array(opts.resamples);
  let rel = 0;
  for (let r = 0; r < opts.resamples; r += 1) {
    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < k; i += 1) {
      const t = tasks[Math.floor(rand() * k)];
      sumA += two ? drawArm(t.a, rand) : t.a.mean;
      sumB += two ? drawArm(t.b, rand) : t.b.mean;
    }
    diff[r] = (sumB - sumA) / k;
    if (sumA !== 0) relative[rel++] = sumB / sumA - 1;
  }
  diff.sort();
  const relSorted = relative.slice(0, rel);
  relSorted.sort();
  return { diff, relative: relSorted };
}

/** The percentile interval at `level` from sorted draws. */
export function percentileInterval(sorted: Float64Array, level = 0.95): [number, number] {
  const tail = (1 - level) / 2;
  return [quantileSorted(sorted, tail), quantileSorted(sorted, 1 - tail)];
}
