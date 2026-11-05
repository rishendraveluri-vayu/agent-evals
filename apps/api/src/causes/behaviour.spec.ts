import type { Regression, TrialCause } from '../contract';
import { type BehaviourTrial, behaviourOf, withRegressionCauses } from './behaviour';
import { CAUSE_RULES_VERSION } from './causes';

/** D64's per-arm behaviour and the regression list's causes, on synthetic trials. */

const cause = (kind: TrialCause['cause'], contributing: TrialCause['cause'][] = []): TrialCause => ({
  cause: kind,
  reason: `${kind} reason`,
  contributing: contributing.map((c) => ({ cause: c, reason: `${c} reason` })),
  rules_version: CAUSE_RULES_VERSION,
});

let k = 0;
function t(arm: 'A' | 'B', task: string, calls: string[], over: Partial<BehaviourTrial> = {}): BehaviourTrial {
  k += 1;
  return {
    trial_id: `t${k}`,
    arm,
    task,
    end_state: 'answered',
    model_calls: calls.length + 1,
    wanted: ['calculate_emi'],
    calls: calls.map((name) => ({ name, is_error: name.endsWith('!') })).map((c) => ({ ...c, name: c.name.replace('!', '') })),
    cause: null,
    ...over,
  };
}

describe('behaviour per arm', () => {
  const trials = [
    t('A', 'emi', ['calculate_emi', 'calculate_emi']),
    t('A', 'emi', ['mcp__finance__calculate_emi', 'add!'], { end_state: 'step_limit', model_calls: 15, cause: cause('ran_out_of_steps', ['tool_error']) }),
    t('A', 'fd', ['fd_maturity'], { wanted: ['fd_maturity', 'inflation_adjusted_value'], cause: cause('gave_up_early') }),
    t('B', 'emi', ['amortization_schedule'], { cause: cause('wrong_tool', ['wrong_answer']) }),
    t('B', 'emi', ['calculate_emi']),
    t('B', 'fd', ['fd_maturity', 'inflation_adjusted_value'], { wanted: ['fd_maturity', 'inflation_adjusted_value'], model_calls: null }),
  ];
  const b = behaviourOf('exp-1', ['A', 'B'], ['emi', 'fd'], trials, { resamples: 2000 });

  it('counts tool calls by tool (harness prefix removed), errors, required-tool coverage, steps, end states and causes', () => {
    expect(b.rules_version).toBe(CAUSE_RULES_VERSION);
    const [a, bb] = b.arms;
    expect(a).toEqual({
      arm: 'A',
      trials: 3,
      tool_calls: { total: 5, per_trial: 1.667 },
      by_tool: [
        { tool: 'calculate_emi', calls: 3, per_trial: 1, errors: 0, trials: 2 },
        { tool: 'add', calls: 1, per_trial: 0.333, errors: 1, trials: 1 },
        { tool: 'fd_maturity', calls: 1, per_trial: 0.333, errors: 0, trials: 1 },
      ],
      required_tools: [
        { tool: 'calculate_emi', trials: 2, called: 2, share: 1 },
        { tool: 'fd_maturity', trials: 1, called: 1, share: 1 },
        { tool: 'inflation_adjusted_value', trials: 1, called: 0, share: 0 },
      ],
      tool_errors: { total: 1, per_trial: 0.333, trials: 1 },
      steps: { trials_measured: 3, per_trial: 6.667, step_limit: 1 },
      end_states: [
        { end_state: 'answered', trials: 2 },
        { end_state: 'step_limit', trials: 1 },
      ],
      causes: {
        trials: 2,
        by_cause: [
          { cause: 'ran_out_of_steps', primary: 1, contributing: 0 },
          { cause: 'gave_up_early', primary: 1, contributing: 0 },
          { cause: 'tool_error', primary: 0, contributing: 1 },
        ],
      },
    });
    expect(bb.required_tools).toEqual([
      { tool: 'calculate_emi', trials: 2, called: 1, share: 0.5 },
      { tool: 'fd_maturity', trials: 1, called: 1, share: 1 },
      { tool: 'inflation_adjusted_value', trials: 1, called: 1, share: 1 },
    ]);
    // A trial with no LiteLLM record is left out of the steps, not counted as zero.
    expect(bb.steps).toEqual({ trials_measured: 2, per_trial: 2, step_limit: 0 });
    expect(bb.causes.by_cause).toEqual([
      { cause: 'wrong_tool', primary: 1, contributing: 0 },
      { cause: 'wrong_answer', primary: 0, contributing: 1 },
    ]);
  });

  it('gives tool calls and steps per trial as B minus A per task, with the task bootstrap and no verdict', () => {
    const calls = b.paired.find((p) => p.metric === 'tool_calls')!;
    // Per task, A: emi 2, fd 1 (mean 1.5); B: emi 1, fd 2 (mean 1.5).
    expect(calls).toMatchObject({ metric: 'tool_calls', tasks: 2, a: 1.5, b: 1.5, diff: { estimate: 0 }, trials: { a: 3, b: 3 } });
    expect(calls.diff.low).toBeLessThanOrEqual(0);
    expect(calls.diff.high).toBeGreaterThanOrEqual(0);
    const steps = b.paired.find((p) => p.metric === 'steps')!;
    // A: emi (3 + 15) / 2 = 9, fd 2 (mean 5.5); B: emi 2, fd has no record, so only emi is paired.
    expect(steps).toMatchObject({ tasks: 1, a: 9, b: 2, diff: { estimate: -7, low: -7, high: -7 }, trials: { a: 2, b: 2 } });
    expect(Object.keys(calls)).not.toContain('verdict');
    // Seeded: the same trials and experiment always give the same interval.
    expect(behaviourOf('exp-1', ['A', 'B'], ['emi', 'fd'], trials, { resamples: 2000 }).paired).toEqual(b.paired);
  });

  it('a pilot of one arm has no paired differences, and an arm with no done trial has no per-trial means', () => {
    const one = behaviourOf('p', ['A'], ['emi'], [t('A', 'emi', ['calculate_emi'])]);
    expect(one.arms.map((a) => a.arm)).toEqual(['A']);
    expect(one.paired).toEqual([]);
    const empty = behaviourOf('e', ['A', 'B'], ['emi'], [t('A', 'emi', ['calculate_emi'])]);
    expect(empty.arms[1]).toMatchObject({ trials: 0, tool_calls: { total: 0, per_trial: null }, steps: { per_trial: null }, causes: { trials: 0, by_cause: [] } });
    expect(empty.paired).toEqual([]);
  });
});

describe('the regression list’s causes', () => {
  const regression: Regression = {
    task: 'emi',
    task_id: 'emi-basic',
    a: { passed: 4, graded: 5, incomplete: 0 },
    b: { passed: 1, graded: 5, incomplete: 0 },
    diff: { estimate: -60, low: -90, high: -10 },
    beyond_noise: false,
    critical: false,
    graders: [],
    failed_trials: [
      { trial_id: 'b1', arm: 'B', failed_graders: ['emi'], cause: null },
      { trial_id: 'a1', arm: 'A', failed_graders: ['emi'], cause: null },
    ],
    causes_grew: [],
  };
  const rows = [
    { trial_id: 'b1', task: 'emi', arm: 'B' as const, cause: cause('wrong_tool') },
    { trial_id: 'b2', task: 'emi', arm: 'B' as const, cause: cause('wrong_tool') },
    { trial_id: 'b3', task: 'emi', arm: 'B' as const, cause: cause('gave_up_early') },
    { trial_id: 'b4', task: 'emi', arm: 'B' as const, cause: cause('unsupported_figure') },
    { trial_id: 'a1', task: 'emi', arm: 'A' as const, cause: cause('unsupported_figure') },
    { trial_id: 'x1', task: 'other-task', arm: 'B' as const, cause: cause('other') },
  ];

  it('fills each failed trial’s cause and lists the causes that grew from A to B, most grown first', () => {
    const [r] = withRegressionCauses([regression], rows);
    expect(r.failed_trials.map((f) => f.cause?.cause)).toEqual(['wrong_tool', 'unsupported_figure']);
    expect(r.causes_grew).toEqual([
      { cause: 'wrong_tool', a: 0, b: 2 },
      { cause: 'gave_up_early', a: 0, b: 1 },
    ]);
    // The cached statistics are not changed.
    expect(regression.failed_trials[0].cause).toBeNull();
    expect(regression.causes_grew).toEqual([]);
  });
});
