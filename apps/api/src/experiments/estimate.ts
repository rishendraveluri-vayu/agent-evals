import type { Estimate, EstimateCell } from '../contract';

/**
 * The run estimate (SP3, R10.6): trials, cost and time before anything runs.
 *
 * Per-trial tokens are the mean of earlier finished trials of the same config and task when
 * there are any, otherwise the docs/cost.md planning assumptions. Prices come from LiteLLM.
 * The numbers below that docs/cost.md does not give are marked; they are not Rishi's yet.
 */
export const ASSUMPTIONS = {
  /** docs/cost.md: 8 calls x 8k input and 300 output per trial. */
  input_tokens_per_trial: 64_000,
  output_tokens_per_trial: 2_400,
  /** Not in docs/cost.md: wall time per trial with no history. */
  wall_s_per_trial: 60,
  /** Not in docs/cost.md: one simulated-client call, used max_client_turns times per trial. */
  sim_input_tokens_per_call: 2_000,
  sim_output_tokens_per_call: 150,
  /** Not in docs/cost.md: the planning band around the expected cost. */
  low_factor: 0.5,
  high_factor: 2,
} as const;

/** Per-trial key budgets: safety nets well above the estimate (R10.6). Not Rishi's numbers yet. */
export const BUDGET_RULE = {
  multiple: 5,
  min_trial_usd: 0.25,
  min_sim_usd: 0.1,
} as const;

export interface Price {
  inputPerToken: number;
  outputPerToken: number;
}

export interface CellInput {
  config: string;
  task: string;
  model: string;
  harness: string;
  /** max_client_turns when the task has a simulated client, else null. */
  simTurns: number | null;
  history: {
    trials: number;
    inputTokens: number;
    outputTokens: number;
    wallS: number | null;
    simCostUsd: number | null;
  } | null;
}

export interface EstimateInput {
  cells: CellInput[];
  n: number;
  prices: Map<string, Price>;
  simModel: string | null;
}

const money = (v: number): number => Math.round(v * 1e6) / 1e6;

export function estimate(input: EstimateInput): Estimate {
  const { n, prices, simModel } = input;
  const price = (model: string): Price => {
    const p = prices.get(model);
    if (!p) throw new Error(`no price for ${model}`);
    return p;
  };
  const cells: EstimateCell[] = [];
  let expected = 0;
  const wallByHarness = new Map<string, number>();
  let fromHistory = 0;
  for (const c of input.cells) {
    const h = c.history && c.history.trials > 0 ? c.history : null;
    if (h) fromHistory += 1;
    const inTok = h ? h.inputTokens : ASSUMPTIONS.input_tokens_per_trial;
    const outTok = h ? h.outputTokens : ASSUMPTIONS.output_tokens_per_trial;
    const wall = h?.wallS ?? ASSUMPTIONS.wall_s_per_trial;
    const p = price(c.model);
    const agent = inTok * p.inputPerToken + outTok * p.outputPerToken;
    let sim = 0;
    if (c.simTurns !== null) {
      if (h && h.simCostUsd !== null) {
        sim = h.simCostUsd;
      } else if (simModel) {
        const sp = price(simModel);
        sim = c.simTurns * (ASSUMPTIONS.sim_input_tokens_per_call * sp.inputPerToken + ASSUMPTIONS.sim_output_tokens_per_call * sp.outputPerToken);
      }
    }
    expected += n * (agent + sim);
    wallByHarness.set(c.harness, (wallByHarness.get(c.harness) ?? 0) + n * wall);
    cells.push({
      config: c.config,
      task: c.task,
      model: c.model,
      source: h ? 'history' : 'assumption',
      trials_seen: h?.trials ?? 0,
      input_tokens: Math.round(inTok),
      output_tokens: Math.round(outTok),
      wall_s: Math.round(wall * 10) / 10,
      agent_usd_per_trial: money(agent),
      sim_usd_per_trial: money(sim),
    });
  }
  const total = cells.length;
  const tokensFrom =
    total === 0
      ? 'no config x task cells'
      : fromHistory === total
        ? `the mean of earlier finished trials for all ${total} config x task cells`
        : fromHistory === 0
          ? `the docs/cost.md assumptions (64k input, 2.4k output per trial) for all ${total} config x task cells`
          : `earlier finished trials for ${fromHistory} of ${total} config x task cells, the docs/cost.md assumptions for the rest`;
  const maxAgent = Math.max(0, ...cells.map((c) => c.agent_usd_per_trial));
  const maxSim = Math.max(0, ...cells.map((c) => c.sim_usd_per_trial));
  const usedPrices = new Set([...input.cells.map((c) => c.model), ...(simModel ? [simModel] : [])]);
  return {
    trials: total * n,
    cost_usd: {
      expected: money(expected),
      low: money(expected * ASSUMPTIONS.low_factor),
      high: money(expected * ASSUMPTIONS.high_factor),
    },
    // One worker per harness, harnesses in parallel: the slowest harness sets the time.
    minutes: Math.round((Math.max(0, ...wallByHarness.values()) / 60) * 10) / 10,
    basis:
      `Tokens per trial: ${tokensFrom}. Prices: LiteLLM /model/info. Range: ${ASSUMPTIONS.low_factor}x to ` +
      `${ASSUMPTIONS.high_factor}x the expected cost. Time: one worker per harness, harnesses in parallel.`,
    basis_detail: {
      cells,
      prices: Object.fromEntries(
        [...usedPrices].filter((m) => prices.has(m)).map((m) => {
          const p = price(m);
          return [m, { input_per_mtok: money(p.inputPerToken * 1e6), output_per_mtok: money(p.outputPerToken * 1e6) }];
        }),
      ),
      assumptions: { ...ASSUMPTIONS },
    },
    budgets: {
      trial_usd: money(Math.max(BUDGET_RULE.min_trial_usd, BUDGET_RULE.multiple * maxAgent)),
      sim_usd: money(Math.max(BUDGET_RULE.min_sim_usd, BUDGET_RULE.multiple * maxSim)),
    },
  };
}
