import { ApiError } from '../common/api-error';
import type { Estimate } from '../contract';
import { FUTILITY_DEFAULT, estimatePerTrial, futile, infraGuardTrips, projectedSpend, resolveFutility } from './rules';

describe('resolveFutility (D32)', () => {
  it('defaults to after 3 finished trials per arm, pausing an arm that passed nothing', () => {
    expect(resolveFutility(undefined)).toEqual({ enabled: true, after: 3, min_passed: 1 });
    expect(resolveFutility(null)).toEqual(FUTILITY_DEFAULT);
    expect(resolveFutility({ after: 5 })).toEqual({ enabled: true, after: 5, min_passed: 1 });
    expect(resolveFutility({ enabled: false })).toEqual({ enabled: false, after: 3, min_passed: 1 });
  });

  it.each([[[]], ['3'], [{ after: 0 }], [{ after: 2.5 }], [{ min_passed: 4 }], [{ enabled: 'no' }], [{ threshold: 1 }]])('refuses %p with a fix', (input) => {
    let err: unknown;
    try {
      resolveFutility(input);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).fix).toEqual(expect.any(String));
  });
});

describe('futile', () => {
  it('pauses only once the arm has the first batch, and only when it passed too few', () => {
    expect(futile(FUTILITY_DEFAULT, 2, 0)).toBe(false);
    expect(futile(FUTILITY_DEFAULT, 3, 0)).toBe(true);
    expect(futile(FUTILITY_DEFAULT, 3, 1)).toBe(false);
    expect(futile({ enabled: true, after: 5, min_passed: 2 }, 5, 1)).toBe(true);
    expect(futile({ ...FUTILITY_DEFAULT, enabled: false }, 3, 0)).toBe(false);
  });
});

describe('infraGuardTrips', () => {
  it('needs at least 5 finished trials and more than 30% of them infra failures', () => {
    expect(infraGuardTrips(4, 4)).toBe(false);
    expect(infraGuardTrips(5, 1)).toBe(false); // 20%
    expect(infraGuardTrips(10, 3)).toBe(false); // exactly 30% does not pass it
    expect(infraGuardTrips(5, 2)).toBe(true); // 40%
  });
});

describe('projectedSpend', () => {
  it('adds the remaining trials at the cost of the finished ones, or the estimate before any finished', () => {
    expect(projectedSpend(0.3, [{ remaining: 3, meanCost: 0.3, estimatePerTrial: 0.07 }])).toBeCloseTo(1.2, 9);
    expect(projectedSpend(0, [{ remaining: 4, meanCost: null, estimatePerTrial: 0.07 }])).toBeCloseTo(0.28, 9);
    expect(projectedSpend(0.1, [{ remaining: 0, meanCost: 0.1, estimatePerTrial: 1 }])).toBeCloseTo(0.1, 9);
  });

  it('takes the estimate per trial as the mean of the arm’s cells, agent and simulator', () => {
    const e = { basis_detail: { cells: [
      { config: 'a', agent_usd_per_trial: 0.1, sim_usd_per_trial: 0.02 },
      { config: 'a', agent_usd_per_trial: 0.3, sim_usd_per_trial: 0 },
      { config: 'b', agent_usd_per_trial: 9, sim_usd_per_trial: 9 },
    ] } } as unknown as Estimate;
    expect(estimatePerTrial(e, 'a')).toBeCloseTo(0.21, 9);
    expect(estimatePerTrial(e, 'zzz')).toBe(0);
    expect(estimatePerTrial(null, 'a')).toBe(0);
  });
});
