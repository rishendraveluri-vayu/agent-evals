import { binaryArm, bootstrapTasks, drawArm, percentileInterval, valuesArm } from './bootstrap';
import { benjaminiHochberg, fisherExact, newcombe, quantileSorted, signFlipTest, wilson } from './methods';
import { seededStream } from './random';

/**
 * The closed-form pieces against published values. Each value below was also reproduced with
 * SciPy 1.16.3 (fisher_exact) and statsmodels 0.14.5 (proportion_confint, method="wilson";
 * confint_proportions_2indep, method="newcomb") on 5 Nov 2026.
 */
describe('Wilson score interval', () => {
  // Newcombe (1998a), Statistics in Medicine 17:857-872, Table I, method 3.
  it.each([
    [81, 263, 0.2553, 0.3662],
    [15, 148, 0.0624, 0.1605],
    [0, 20, 0, 0.1611],
    [1, 29, 0.0061, 0.1718],
  ])('%i of %i is %f to %f', (s, n, lo, hi) => {
    const [l, u] = wilson(s, n);
    expect(l).toBeCloseTo(lo, 4);
    expect(u).toBeCloseTo(hi, 4);
  });
});

describe("Newcombe's interval for a difference of two independent proportions", () => {
  // Newcombe (1998b), Statistics in Medicine 17:873-890, Table II, method 10 (hybrid score).
  it.each([
    [56, 70, 48, 80, 0.0524, 0.3339],
    [9, 10, 3, 10, 0.1705, 0.809],
    [6, 7, 2, 7, 0.0582, 0.8062],
    [5, 56, 0, 29, -0.0381, 0.1926],
    [0, 10, 0, 20, -0.1611, 0.2775],
    [0, 10, 0, 10, -0.2775, 0.2775],
    [10, 10, 0, 20, 0.6791, 1],
    [10, 10, 0, 10, 0.6075, 1],
  ])('%i/%i minus %i/%i is %f to %f', (s1, n1, s2, n2, lo, hi) => {
    const [d, l, u] = newcombe(s1, n1, s2, n2);
    expect(d).toBeCloseTo(s1 / n1 - s2 / n2, 10);
    expect(l).toBeCloseTo(lo, 4);
    expect(u).toBeCloseTo(hi, 4);
  });
});

describe("Fisher's exact test, two-sided", () => {
  it("gives the tea-tasting lady's p of 0.486 (Fisher 1935; Agresti, Categorical Data Analysis, 3.5)", () => {
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.485714, 6);
  });

  it("gives D41's worked examples: 5 of 5 against 0 of 5, 10 of 10 against 2 of 10, 8 of 10 against 2 of 10", () => {
    expect(fisherExact(5, 0, 0, 5)).toBeCloseTo(0.0079365, 7);
    expect(fisherExact(10, 0, 2, 8)).toBeCloseTo(0.00071446, 8);
    expect(fisherExact(8, 2, 2, 8)).toBeCloseTo(0.0230141, 7);
  });

  it('is symmetric in the arms and 1 when the arms are identical', () => {
    expect(fisherExact(56, 14, 48, 32)).toBeCloseTo(0.0125211, 7);
    expect(fisherExact(48, 32, 56, 14)).toBeCloseTo(0.0125211, 7);
    expect(fisherExact(3, 2, 3, 2)).toBeCloseTo(1, 10);
    expect(fisherExact(0, 0, 0, 0)).toBe(1);
  });
});

describe('Benjamini-Hochberg', () => {
  // Benjamini and Hochberg (1995), JRSS B 57:289-300, section 4: 15 p-values; at q = 0.05 BH
  // rejects the four smallest (Bonferroni would reject three).
  const ps = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719, 0.6528, 0.759, 1];

  it('rejects the four smallest of the paper\'s 15 p-values', () => {
    const { rejected } = benjaminiHochberg(ps, 0.05);
    expect(rejected).toEqual(ps.map((_, i) => i < 4));
  });

  it('does not depend on the order the p-values come in, and adjusted p-values are monotone', () => {
    const shuffled = [...ps].reverse();
    const { rejected, adjusted } = benjaminiHochberg(shuffled, 0.05);
    expect(rejected.filter(Boolean)).toHaveLength(4);
    expect(rejected[shuffled.indexOf(0.0095)]).toBe(true);
    expect(rejected[shuffled.indexOf(0.0201)]).toBe(false);
    // The adjusted p of the 4th smallest: min over j >= 4 of p_(j) x 15 / j = 0.0095 x 15 / 4.
    expect(adjusted[shuffled.indexOf(0.0095)]).toBeCloseTo(0.035625, 6);
    const sorted = [...adjusted].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1]).toBe(1);
  });

  it('flags nothing when nothing is small, and handles no tests at all', () => {
    expect(benjaminiHochberg([0.2, 0.5, 0.9]).rejected).toEqual([false, false, false]);
    expect(benjaminiHochberg([])).toEqual({ rejected: [], adjusted: [] });
  });
});

describe('the sign-flip permutation test', () => {
  const rand = () => seededStream('test:flips');

  it('is exact for few tasks: d = 1, 2, 3 has 2 of 8 patterns as extreme, p = 0.25', () => {
    expect(signFlipTest([1, 2, 3], rand())).toEqual({ p: 0.25, exact: true, flips: 8 });
  });

  it('gives p = 1 when every difference is 0, and 2/2^K when every task moved the same way', () => {
    expect(signFlipTest([0, 0, 0, 0], rand()).p).toBe(1);
    const ten = Array.from({ length: 10 }, () => 0.2);
    expect(signFlipTest(ten, rand()).p).toBeCloseTo(2 / 1024, 12);
  });

  it('cannot reach 0.05 with 5 tasks: its smallest p is 2/32', () => {
    expect(signFlipTest([0.5, 0.4, 0.3, 0.2, 0.1], rand()).p).toBeCloseTo(0.0625, 12);
  });

  it('agrees with the exact answer when it samples patterns instead', () => {
    const d = [0.3, -0.1, 0.2, 0.4, 0, 0.1, -0.2, 0.3, 0.1, 0.2, 0.2, -0.1];
    const exact = signFlipTest(d, rand());
    const sampled = signFlipTest(d, rand(), { exactMaxTasks: 5, flips: 20_000 });
    expect(exact.exact).toBe(true);
    expect(sampled).toMatchObject({ exact: false, flips: 20_000 });
    expect(Math.abs(sampled.p - exact.p)).toBeLessThan(0.01);
  });
});

describe('the seeded stream and the bootstrap pieces', () => {
  it('gives the same numbers for the same seed and different ones for another', () => {
    const a = seededStream('e_1:pass_rate');
    const b = seededStream('e_1:pass_rate');
    const c = seededStream('e_2:pass_rate');
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('draws a binary arm from Binomial(n, s/n): mean s/n and variance p(1-p)/n', () => {
    const arm = binaryArm(3, 10);
    const rand = seededStream('test:binomial');
    const draws = Array.from({ length: 50_000 }, () => drawArm(arm, rand));
    const mean = draws.reduce((s, x) => s + x, 0) / draws.length;
    const variance = draws.reduce((s, x) => s + (x - mean) ** 2, 0) / draws.length;
    expect(mean).toBeCloseTo(0.3, 2);
    expect(variance).toBeCloseTo((0.3 * 0.7) / 10, 3);
    expect(draws.every((x) => Number.isInteger(Math.round(x * 10)) && x >= 0 && x <= 1)).toBe(true);
    expect(drawArm(binaryArm(0, 5), rand)).toBe(0);
    expect(drawArm(binaryArm(5, 5), rand)).toBe(1);
  });

  it('collapses to the point when every task has the same difference and no trial noise', () => {
    const tasks = Array.from({ length: 6 }, () => ({ a: binaryArm(0, 5), b: binaryArm(5, 5) }));
    const draws = bootstrapTasks(tasks, seededStream('test:flat'), { resamples: 500 });
    expect(percentileInterval(draws.diff)).toEqual([1, 1]);
  });

  it('resamples values with replacement and reports the relative difference', () => {
    const tasks = [
      { a: valuesArm([1, 1, 1]), b: valuesArm([2, 2, 2]) },
      { a: valuesArm([3, 3]), b: valuesArm([6, 6]) },
    ];
    const draws = bootstrapTasks(tasks, seededStream('test:values'), { resamples: 200 });
    expect(draws.diff[0]).toBeGreaterThanOrEqual(1);
    expect(draws.diff[draws.diff.length - 1]).toBeLessThanOrEqual(3);
    expect(Array.from(draws.relative).every((r) => Math.abs(r - 1) < 1e-12)).toBe(true);
  });

  it('interpolates quantiles as R type 7', () => {
    const s = Float64Array.from([1, 2, 3, 4, 5]);
    expect(quantileSorted(s, 0)).toBe(1);
    expect(quantileSorted(s, 0.5)).toBe(3);
    expect(quantileSorted(s, 0.1)).toBeCloseTo(1.4, 12);
    expect(quantileSorted(s, 1)).toBe(5);
  });
});
