import type { Rand } from './random';

/**
 * The closed-form and exact pieces of the comparison (SP6, D10, D41, D43): per-task intervals
 * and p-values, the multiple-comparison correction, and the paired test on the task differences.
 * Every function is pure; the only randomness is a sign-flip test too large to enumerate, which
 * takes a seeded stream.
 */

/** z for a two-sided 95% interval (D43). */
export const Z95 = 1.959963984540054;

/** Wilson's score interval for one proportion, s successes in n. [0, 1] when n is 0. */
export function wilson(s: number, n: number, z = Z95): [number, number] {
  if (n <= 0) return [0, 1];
  const p = s / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  // At p = 0 or 1 the bound equals the estimate exactly; floating point can miss it by 1e-17.
  return [s === 0 ? 0 : Math.max(0, centre - half), s === n ? 1 : Math.min(1, centre + half)];
}

/**
 * Newcombe's hybrid score interval for p1 - p2 from two independent samples (method 10 of
 * Newcombe 1998, without continuity correction): it combines each arm's Wilson interval, so it
 * stays inside [-1, 1] and behaves at 0 of n and n of n, where the textbook Wald interval fails.
 * Returns [estimate, low, high] as proportions.
 */
export function newcombe(s1: number, n1: number, s2: number, n2: number, z = Z95): [number, number, number] {
  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const [l1, u1] = wilson(s1, n1, z);
  const [l2, u2] = wilson(s2, n2, z);
  const d = p1 - p2;
  return [d, d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2), d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)];
}

const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i += 1) logFactorials.push(logFactorials[i - 1] + Math.log(i));
  return logFactorials[n];
}

/**
 * Fisher's exact test on the 2x2 table [[a, b], [c, d]] (rows: the two arms; columns: pass,
 * fail), two-sided: the total probability, under fixed margins, of every table no more likely
 * than the one observed (the usual definition, as R's fisher.test and SciPy use), with a small
 * relative tolerance so tables of equal probability are not split by rounding.
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const n = r1 + r2;
  if (n === 0) return 1;
  const logP = (x: number): number =>
    logFactorial(r1) + logFactorial(r2) + logFactorial(c1) + logFactorial(n - c1) - logFactorial(n) - logFactorial(x) - logFactorial(r1 - x) - logFactorial(c1 - x) - logFactorial(r2 - c1 + x);
  const observed = logP(a);
  const lo = Math.max(0, c1 - r2);
  const hi = Math.min(r1, c1);
  let p = 0;
  for (let x = lo; x <= hi; x += 1) {
    const lp = logP(x);
    if (lp <= observed + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/**
 * Benjamini-Hochberg at false discovery rate q (D41): which hypotheses are rejected ("beyond
 * noise"), and each one's adjusted p-value (q-value). The k-th smallest p is compared with
 * k x q / m; every p up to the largest that passes is rejected.
 */
export function benjaminiHochberg(pValues: number[], q = 0.05): { rejected: boolean[]; adjusted: number[] } {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p || x.i - y.i);
  let cutoff = -1;
  order.forEach((o, k) => {
    if (o.p <= ((k + 1) * q) / m) cutoff = k;
  });
  const rejected = new Array<boolean>(m).fill(false);
  const adjusted = new Array<number>(m).fill(1);
  let running = 1;
  for (let k = m - 1; k >= 0; k -= 1) {
    running = Math.min(running, (order[k].p * m) / (k + 1));
    adjusted[order[k].i] = Math.min(1, running);
    if (k <= cutoff) rejected[order[k].i] = true;
  }
  return { rejected, adjusted };
}

/** Up to this many tasks the sign-flip test counts every one of the 2^K patterns exactly. */
export const EXACT_FLIP_MAX_TASKS = 30;
/** Above it, this many seeded random patterns. */
export const RANDOM_FLIPS = 20_000;

export interface SignFlipResult {
  p: number;
  exact: boolean;
  /** Sign patterns looked at: 2^K when exact. */
  flips: number;
}

/** Every signed sum of `d` (2^m of them): each value added or subtracted. */
function signedSums(d: readonly number[]): Float64Array {
  const out = new Float64Array(2 ** d.length);
  let len = 1;
  for (const x of d) {
    for (let i = 0; i < len; i += 1) {
      out[len + i] = out[i] - x;
      out[i] += x;
    }
    len *= 2;
  }
  return out;
}

/** The first index whose value is >= x (`strict`: > x) in sorted values. */
function bound(sorted: Float64Array, x: number, strict: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? sorted[mid] <= x : sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The paired test (D10): under "no difference" each task's difference B - A is as likely to be
 * positive as negative, so flipping the signs gives the null distribution of the mean. Two-sided:
 * the share of sign patterns whose sum is at least as far from zero as the observed one.
 *
 * Exact up to EXACT_FLIP_MAX_TASKS tasks: it counts all 2^K patterns without listing them, by
 * splitting the tasks in two halves, listing each half's 2^(K/2) signed sums, sorting one, and
 * counting for each sum of the other half how many partners take the total to +T or beyond, or to
 * -T or beyond (a binary search each). Above that, RANDOM_FLIPS seeded patterns, counting the
 * observed one, so p is never 0.
 */
export function signFlipTest(diffs: number[], rand: Rand, opts: { exactMaxTasks?: number; flips?: number } = {}): SignFlipResult {
  const k = diffs.length;
  if (k === 0) return { p: 1, exact: true, flips: 1 };
  const observed = Math.abs(diffs.reduce((s, d) => s + d, 0));
  const tol = 1e-9 * Math.max(1, observed);
  if (k <= (opts.exactMaxTasks ?? EXACT_FLIP_MAX_TASKS)) {
    const total = 2 ** k;
    // Every pattern is at least as far from zero as a sum of zero.
    if (observed <= tol) return { p: 1, exact: true, flips: total };
    const half = Math.floor(k / 2);
    const left = signedSums(diffs.slice(0, half));
    const right = signedSums(diffs.slice(half)).sort();
    let count = 0;
    for (const s of left) {
      // s + r >= T, or s + r <= -T; with T > 0 the two never overlap.
      count += right.length - bound(right, observed - s - tol, false);
      count += bound(right, -observed - s + tol, true);
    }
    return { p: count / total, exact: true, flips: total };
  }
  const flips = opts.flips ?? RANDOM_FLIPS;
  let count = 0;
  for (let f = 0; f < flips; f += 1) {
    let sum = 0;
    for (const d of diffs) sum += rand() < 0.5 ? -d : d;
    if (Math.abs(sum) >= observed - tol) count += 1;
  }
  return { p: (count + 1) / (flips + 1), exact: false, flips };
}

/** The q-th quantile of sorted values, by linear interpolation (R's type 7, NumPy's default). */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
