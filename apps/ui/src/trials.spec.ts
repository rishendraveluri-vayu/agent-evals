import { describe, expect, it } from 'vitest';
import { spanBars, spanRole, spendByConfig, timelineRows, usd, type SpanView, type TrialSummary } from './trials';

function span(id: string, parent: string | null, name: string, start: number, end: number, attrs = {}): SpanView {
  return {
    spanId: id,
    parentSpanId: parent,
    name,
    kind: 1,
    startNs: String(BigInt(start) * 1_000_000n),
    endNs: String(BigInt(end) * 1_000_000n),
    statusCode: 1,
    statusMessage: null,
    attributes: attrs,
    events: [],
  };
}

function trial(over: Partial<TrialSummary>): TrialSummary {
  return {
    experiment_id: null, trialId: 't', harness: 'hermes', model: 'fake/x', taskId: 'task', configHash: 'h', promptVersion: 'v1',
    toolsetVersion: 'v1', label: 'agent', endState: 'answered', startedAt: null, wallS: 1, proxyCalls: 2,
    proxyCostUsd: 0.01, proxyInputTokens: 1, proxyOutputTokens: 1, proxyComplete: true, harnessCalls: 2,
    toolCalls: 1, toolErrors: 0, malformedToolCalls: 0, agentTurns: 1, clientTurns: 0, ...over,
  };
}

describe('timelineRows', () => {
  it('orders spans as a tree with times relative to the first start', () => {
    const spans = [
      span('c', 'b', 'chat fake/x', 1010, 1020, { 'evals.role': 'agent' }),
      span('a', null, 'invoke_agent hermes', 1000, 1100),
      span('d', 'b', 'execute_tool calculate_emi', 1030, 1040),
      span('b', 'a', 'agent.turn', 1005, 1090),
      span('e', 'a', 'client_sim.turn', 1091, 1095),
    ];
    const { rows, totalMs } = timelineRows(spans);
    expect(rows.map((r) => [r.span.spanId, r.depth])).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 2], ['e', 1]]);
    expect(rows[2].startMs).toBe(10);
    expect(rows[2].durationMs).toBe(10);
    expect(totalMs).toBe(100);
    expect(rows.map((r) => r.role)).toEqual(['trial', 'turn', 'chat', 'tool', 'client']);
  });

  it('treats a span whose parent is missing as a root rather than dropping it', () => {
    const { rows } = timelineRows([span('x', 'gone', 'execute_tool t', 0, 1)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].depth).toBe(0);
  });

  it('tells simulator model calls from agent model calls', () => {
    expect(spanRole(span('s', 'p', 'chat fake/sim', 0, 1, { 'evals.role': 'sim' }))).toBe('chat-sim');
  });
});

describe('spanBars', () => {
  const spans = [
    span('a', null, 'invoke_agent hermes', 0, 1000),
    span('b', 'a', 'agent.turn', 100, 900),
    span('c', 'b', 'chat claude-haiku-5-5', 100, 200, { 'evals.role': 'agent', 'gen_ai.request.model': 'claude-haiku-5-5' }),
    span('d', 'b', 'execute_tool fd_maturity', 200, 210, { 'gen_ai.tool.name': 'fd_maturity' }),
    span('e', 'b', 'chat claude-haiku-5-5', 210, 300, { 'evals.role': 'agent', 'gen_ai.request.model': 'claude-haiku-5-5' }),
    span('f', 'b', 'chat claude-haiku-5-5', 300, 800, { 'evals.role': 'agent', 'gen_ai.request.model': 'claude-haiku-5-5' }),
  ];

  it('numbers the agent model calls and marks the final reply, keeping the model for the tooltip', () => {
    const { bars } = spanBars(spans, 'hermes');
    expect(bars.map((b) => b.label)).toEqual(['Hermes start-up', 'Agent call 1', 'tool fd_maturity', 'Agent call 2', 'Agent call 3, final reply', 'Shut down and collect files']);
    const agent = bars.filter((b) => b.role === 'agent');
    expect(agent.map((b) => b.title)).toEqual([
      'Agent call 1: chat claude-haiku-5-5',
      'Agent call 2: chat claude-haiku-5-5',
      'Agent call 3, final reply: chat claude-haiku-5-5',
    ]);
    expect(bars.find((b) => b.role === 'tool')?.title).toBe('tool fd_maturity');
    // The tool's name on its own, for the row to set in mono; no other bar has one.
    expect(bars.find((b) => b.role === 'tool')?.ident).toBe('fd_maturity');
    expect(bars.filter((b) => b.ident !== undefined)).toHaveLength(1);
    // No label carries the model id, so none is long enough to be cut short.
    expect(bars.every((b) => !b.label.includes('claude'))).toBe(true);
  });

  it('calls a single agent call just that, with no final-reply mark', () => {
    const { bars } = spanBars(spans.slice(0, 3));
    expect(bars.filter((b) => b.role === 'agent').map((b) => b.label)).toEqual(['Agent call 1']);
  });
});

describe('spendByConfig', () => {
  it('totals and averages spend per config and keeps unpriced trials out of the mean', () => {
    const rows = spendByConfig([
      trial({ trialId: '1', proxyCostUsd: 0.02 }),
      trial({ trialId: '2', proxyCostUsd: 0.04, label: 'infra:provider_error' }),
      trial({ trialId: '3', proxyCostUsd: null, proxyCalls: null }),
      trial({ trialId: '4', harness: 'ownloop', proxyCostUsd: 0.01 }),
    ]);
    expect(rows.map((r) => r.harness)).toEqual(['hermes', 'ownloop']);
    expect(rows[0].trials).toBe(3);
    expect(rows[0].totalUsd).toBeCloseTo(0.06);
    expect(rows[0].meanUsd).toBeCloseTo(0.03);
    expect(rows[0].unpriced).toBe(1);
    expect(rows[0].infra).toBe(1);
  });
});

describe('usd', () => {
  it('shows small costs with enough digits', () => {
    expect(usd(0.000034)).toBe('$0.000034');
    expect(usd(1.5)).toBe('$1.5000');
    expect(usd(null)).toBe('–');
  });
});
