import { ASSUMPTIONS, BUDGET_RULE, type CellInput, type Price, estimate } from './estimate';

const HAIKU: Price = { inputPerToken: 0.1e-6, outputPerToken: 0.5e-6 };
const SONNET: Price = { inputPerToken: 2e-6, outputPerToken: 10e-6 };
const prices = new Map([
  ['claude-haiku-5-5', HAIKU],
  ['claude-sonnet-5-5', SONNET],
]);

const cell = (over: Partial<CellInput> = {}): CellInput => ({
  config: 'sha256:a',
  task: 'sha256:t1',
  model: 'claude-haiku-5-5',
  harness: 'hermes',
  simTurns: null,
  history: null,
  ...over,
});

describe('estimate', () => {
  it('uses the docs/cost.md assumptions when there is no history ($0.0076 a Haiku trial)', () => {
    const e = estimate({ cells: [cell()], n: 10, prices, simModel: null });
    expect(e.trials).toBe(10);
    expect(e.basis_detail.cells[0]).toMatchObject({ source: 'assumption', input_tokens: 64_000, output_tokens: 2_400, agent_usd_per_trial: 0.0076 });
    expect(e.cost_usd.expected).toBeCloseTo(0.076, 6);
    expect(e.cost_usd.low).toBeCloseTo(0.038, 6);
    expect(e.cost_usd.high).toBeCloseTo(0.152, 6);
    expect(e.basis).toContain('docs/cost.md assumptions');
  });

  it('matches docs/cost.md for 20 tasks x 2 configs x N=10 on Sonnet ($61)', () => {
    const cells = [];
    for (let t = 0; t < 20; t += 1) {
      for (const c of ['a', 'b']) cells.push(cell({ config: c, task: `t${t}`, model: 'claude-sonnet-5-5' }));
    }
    const e = estimate({ cells, n: 10, prices, simModel: null });
    expect(e.trials).toBe(400);
    expect(e.cost_usd.expected).toBeCloseTo(60.8, 4);
  });

  it('uses the mean of earlier finished trials when the cell has them', () => {
    const e = estimate({
      cells: [cell({ history: { trials: 4, inputTokens: 10_000, outputTokens: 1_000, wallS: 30, simCostUsd: null } })],
      n: 2,
      prices,
      simModel: null,
    });
    expect(e.basis_detail.cells[0]).toMatchObject({ source: 'history', trials_seen: 4, input_tokens: 10_000, wall_s: 30 });
    expect(e.cost_usd.expected).toBeCloseTo(2 * (10_000 * 0.1e-6 + 1_000 * 0.5e-6), 9);
    expect(e.minutes).toBe(1); // 2 trials x 30 s
    expect(e.basis).toContain('earlier finished trials for all 1');
  });

  it('says when only some cells have history', () => {
    const e = estimate({
      cells: [cell(), cell({ task: 't2', history: { trials: 1, inputTokens: 1, outputTokens: 1, wallS: null, simCostUsd: null } })],
      n: 1,
      prices,
      simModel: null,
    });
    expect(e.basis).toContain('earlier finished trials for 1 of 2');
    expect(e.basis_detail.cells[1].wall_s).toBe(ASSUMPTIONS.wall_s_per_trial);
  });

  it('adds the simulated client for conversation tasks', () => {
    const e = estimate({ cells: [cell({ simTurns: 3 })], n: 1, prices, simModel: 'claude-haiku-5-5' });
    const sim = 3 * (ASSUMPTIONS.sim_input_tokens_per_call * 0.1e-6 + ASSUMPTIONS.sim_output_tokens_per_call * 0.5e-6);
    expect(e.basis_detail.cells[0].sim_usd_per_trial).toBeCloseTo(sim, 9);
    expect(e.cost_usd.expected).toBeCloseTo(0.0076 + sim, 9);
  });

  it('takes the slowest harness as the time, with harnesses in parallel', () => {
    const e = estimate({ cells: [cell({ harness: 'hermes' }), cell({ harness: 'ownloop', config: 'b' })], n: 3, prices, simModel: null });
    expect(e.minutes).toBe(3); // 3 x 60 s per harness, not 6
  });

  it('sets per-trial budgets well above the estimate, with a floor', () => {
    const cheap = estimate({ cells: [cell()], n: 1, prices, simModel: null });
    expect(cheap.budgets.trial_usd).toBe(BUDGET_RULE.min_trial_usd);
    const dear = estimate({ cells: [cell({ model: 'claude-sonnet-5-5' })], n: 1, prices, simModel: null });
    expect(dear.budgets.trial_usd).toBeCloseTo(BUDGET_RULE.multiple * 0.152, 6);
  });

  it('refuses a model with no price rather than guessing', () => {
    expect(() => estimate({ cells: [cell({ model: 'mystery' })], n: 1, prices, simModel: null })).toThrow('no price');
  });
});
