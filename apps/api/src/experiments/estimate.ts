import type { Estimate, EstimateCell } from '../contract';

/**
 * The run estimate (SP3, R10.6; Rishi's guide review, item 8): trials, cost and time before
 * anything runs.
 *
 * Each config x task cell takes the mean tokens, cost and wall time of earlier finished trials,
 * from the closest history there is: the same config and task, else the same harness and model
 * (any config or task). Only with no history at all does it fall back to the docs/cost.md planning
 * assumptions, with LiteLLM's prices. The simulator's cost per trial comes from earlier trials of
 * the same task and simulator model, else from the assumptions. Time divides each harness's work
 * by its live workers (seen in the last minute), harnesses in parallel.
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

/** A worker counts as live for the time estimate if it claimed or heartbeat this recently. */
export const LIVE_WORKER_S = 60;

export interface Price {
  inputPerToken: number;
  outputPerToken: number;
}

/** Means over earlier finished trials. `costUsd` is LiteLLM's recorded agent cost (R10.9), when known. */
export interface History {
  trials: number;
  inputTokens: number;
  outputTokens: number;
  wallS: number | null;
  costUsd: number | null;
}

export interface CellInput {
  config: string;
  task: string;
  model: string;
  harness: string;
  /** max_client_turns when the task has a simulated client, else null. */
  simTurns: number | null;
  /** Earlier finished trials of this config on this task. */
  history: History | null;
  /** Earlier finished trials of this harness and model, any config or task. */
  harnessModel?: History | null;
  /** Mean simulator cost per trial of earlier finished trials of this task with this simulator model. */
  simCostUsd?: number | null;
}

export interface EstimateInput {
  cells: CellInput[];
  n: number;
  prices: Map<string, Price>;
  simModel: string | null;
  /** Live workers per harness; a harness with none seen is taken as one worker. */
  workers?: Map<string, number>;
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
  const sources = { config_task: 0, harness_model: 0, assumption: 0 };
  for (const c of input.cells) {
    const own = c.history && c.history.trials > 0 ? c.history : null;
    const near = !own && c.harnessModel && c.harnessModel.trials > 0 ? c.harnessModel : null;
    const h = own ?? near;
    const source: EstimateCell['source'] = own ? 'config_task' : near ? 'harness_model' : 'assumption';
    sources[source] += 1;
    const inTok = h ? h.inputTokens : ASSUMPTIONS.input_tokens_per_trial;
    const outTok = h ? h.outputTokens : ASSUMPTIONS.output_tokens_per_trial;
    const wall = h?.wallS ?? ASSUMPTIONS.wall_s_per_trial;
    const p = price(c.model);
    // LiteLLM's recorded cost when the history has it; tokens at today's price otherwise.
    const agent = h && h.costUsd !== null ? h.costUsd : inTok * p.inputPerToken + outTok * p.outputPerToken;
    let sim = 0;
    if (c.simTurns !== null) {
      if (c.simCostUsd !== undefined && c.simCostUsd !== null) {
        sim = c.simCostUsd;
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
      source,
      trials_seen: h?.trials ?? 0,
      input_tokens: Math.round(inTok),
      output_tokens: Math.round(outTok),
      wall_s: Math.round(wall * 10) / 10,
      agent_usd_per_trial: money(agent),
      sim_usd_per_trial: money(sim),
    });
  }
  const total = cells.length;
  const parts = [
    sources.config_task ? `${sources.config_task} from earlier finished trials of the same config and task` : '',
    sources.harness_model ? `${sources.harness_model} from earlier finished trials of the same harness and model` : '',
    sources.assumption ? `${sources.assumption} from the docs/cost.md assumptions (64k input, 2.4k output per trial)` : '',
  ].filter(Boolean);
  const tokensFrom = total === 0 ? 'no config x task cells' : `of ${total} config x task cells, ${parts.join('; ')}`;
  const workers: Record<string, { live: number; used: number }> = {};
  let slowest = 0;
  for (const [harness, wall] of wallByHarness) {
    const live = input.workers?.get(harness) ?? 0;
    const used = Math.max(1, live);
    workers[harness] = { live, used };
    slowest = Math.max(slowest, wall / used);
  }
  const workerWords = Object.entries(workers)
    .map(([h, w]) => (w.live ? `${h} ${w.live} live` : `${h} none seen in the last ${LIVE_WORKER_S} s, taken as 1`))
    .join(', ');
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
    minutes: Math.round((slowest / 60) * 10) / 10,
    basis:
      `Tokens, cost and time per trial: ${tokensFrom}. Cost: LiteLLM's recorded cost where there is history, else tokens at LiteLLM's prices. ` +
      `Range: ${ASSUMPTIONS.low_factor}x to ${ASSUMPTIONS.high_factor}x the expected cost. ` +
      `Time: each harness's trials over its live workers (${workerWords || 'none'}), harnesses in parallel.`,
    basis_detail: {
      cells,
      prices: Object.fromEntries(
        [...usedPrices].filter((m) => prices.has(m)).map((m) => {
          const p = price(m);
          return [m, { input_per_mtok: money(p.inputPerToken * 1e6), output_per_mtok: money(p.outputPerToken * 1e6) }];
        }),
      ),
      assumptions: { ...ASSUMPTIONS },
      workers,
    },
    budgets: {
      trial_usd: money(Math.max(BUDGET_RULE.min_trial_usd, BUDGET_RULE.multiple * maxAgent)),
      sim_usd: money(Math.max(BUDGET_RULE.min_sim_usd, BUDGET_RULE.multiple * maxSim)),
    },
  };
}
