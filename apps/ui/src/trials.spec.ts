import { describe, expect, it } from 'vitest';
import { spanRole, spendByConfig, timelineRows, usd, type SpanView, type TrialSummary } from './trials';

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
    trialId: 't', harness: 'hermes', model: 'fake/x', taskId: 'task', configHash: 'h', promptVersion: 'v1',
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
