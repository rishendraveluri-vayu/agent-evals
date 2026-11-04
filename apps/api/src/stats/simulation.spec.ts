import { simulate } from './simulate';

/**
 * SP6's done-when (stats proposal section 7): the method on simulated data with a known truth.
 * Each task's pass rate is drawn from 10% to 75%; arm B's is arm A's plus the effect. Every run is
 * seeded, so these numbers are the same on every machine; the bands only guard against a change
 * that breaks the method. Each simulated run uses 1,000 bootstrap resamples to keep the suite in
 * seconds (the API uses 10,000; the percentiles are a little noisier, not shifted).
 *
 * Measured in plain Node, 1,000 runs per row, N = 10, 2,000 resamples (docs/design.md and
 * docs/known-limits.md, "Statistics"):
 *
 *   K   A/A better-or-worse  A/A covers 0  +15 "better" (power)  +15 covers +15  width (points)
 *   8   2.7%                 88.5%         30.4%                 90.7%           25
 *   10  2.9%                 90.5%         49.9%                 91.8%           23
 *   12  3.3%                 92.0%         54.7%                 90.8%           21
 *   20  3.4% (4.7%)          93.0% (91.6%) 85.4% (85.2%)         94.2% (93.7%)   17
 *
 * (In brackets: another set of seeds.) Better and worse stay under 5% because they also need the
 * exact sign-flip p < 0.05. The percentile interval covers a little under 95% with this few tasks.
 * The first design, resampling trials again inside each task, gave 1.5% false calls, 98.5 to 99%
 * coverage and 69% power at K = 20, with an interval 40% wider: it counted trial noise twice.
 */
jest.setTimeout(120_000);

const N = 10;
const RUNS = 1000;
const FAST = { resamples: 1000 };

describe(`the method on simulated data, N = ${N} trials per task and arm`, () => {
  it('calls an A/A comparison better or worse at most about 5% of the time (20 tasks, 1,000 runs)', () => {
    const s = simulate({ tasks: 20, trials: N, effect: 0 }, RUNS, 'sim:aa', FAST);
    expect((s.better + s.worse) / RUNS).toBeLessThanOrEqual(0.065);
    expect(s.covered / RUNS).toBeGreaterThanOrEqual(0.89);
  });

  it('finds a known +15 point effect at 20 tasks: the interval covers +15 about 95% of the time, and the verdict is better about 85%', () => {
    const s = simulate({ tasks: 20, trials: N, effect: 15 }, RUNS, 'sim:plus15', FAST);
    expect(s.covered / RUNS).toBeGreaterThanOrEqual(0.9);
    expect(s.better / RUNS).toBeGreaterThanOrEqual(0.75);
    expect(s.worse).toBe(0);
    expect(s.equivalent / RUNS).toBeLessThanOrEqual(0.025);
  });

  it('at a held-out size of 10 tasks: A/A false calls stay under 5%, and +15 is found about half the time', () => {
    const aa = simulate({ tasks: 10, trials: N, effect: 0 }, RUNS, 'sim:aa10', FAST);
    const e = simulate({ tasks: 10, trials: N, effect: 15 }, RUNS, 'sim:plus15-10', FAST);
    expect((aa.better + aa.worse) / RUNS).toBeLessThanOrEqual(0.05);
    expect(aa.covered / RUNS).toBeGreaterThanOrEqual(0.87);
    expect(e.better / RUNS).toBeGreaterThanOrEqual(0.4);
    expect(e.covered / RUNS).toBeGreaterThanOrEqual(0.87);
    expect(e.equivalent / RUNS).toBeLessThanOrEqual(0.025);
  });

  it('finds a known -15 point effect as worse, never better (20 tasks)', () => {
    const s = simulate({ tasks: 20, trials: N, effect: -15, low: 0.25, high: 0.9 }, 300, 'sim:minus15', FAST);
    expect(s.worse / 300).toBeGreaterThanOrEqual(0.75);
    expect(s.better).toBe(0);
  });

  it('calls no change practically equivalent once there are enough tasks and trials (40 x 20)', () => {
    // 40 tasks is above the exact sign-flip limit: 2,000 seeded flips per run keep it quick.
    const s = simulate({ tasks: 40, trials: 20, effect: 0 }, 200, 'sim:equivalent', { ...FAST, flips: 2000 });
    expect(s.equivalent / 200).toBeGreaterThanOrEqual(0.8);
    expect(s.better + s.worse).toBeLessThanOrEqual(10);
  });

  it('gives no verdict at all with 4 tasks, where the interval under-covers (the 6-task floor)', () => {
    const s = simulate({ tasks: 4, trials: N, effect: 15 }, 300, 'sim:four', FAST);
    expect(s.none).toBe(300);
  });

  it('shows why trials are not resampled again inside tasks: that interval is about 40% wider and over-covers', () => {
    const one = simulate({ tasks: 20, trials: N, effect: 0 }, 200, 'sim:levels', FAST);
    const two = simulate({ tasks: 20, trials: N, effect: 0 }, 200, 'sim:levels', { ...FAST, levels: 2 });
    expect(two.width / one.width).toBeGreaterThan(1.3);
    expect(two.covered / 200).toBeGreaterThanOrEqual(0.97);
    expect(two.better + two.worse).toBeLessThanOrEqual(one.better + one.worse);
  });
});
