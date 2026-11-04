/** Trials as the API serves them (apps/api/src/trials), plus the pure helpers the views use. */
import { api } from './api/client';
import { harnessShort } from './lib/names';

export interface TrialSummary {
  trialId: string;
  harness: string;
  model: string | null;
  taskId: string | null;
  configHash: string | null;
  promptVersion: string | null;
  toolsetVersion: string | null;
  label: string;
  endState: string | null;
  startedAt: string | null;
  wallS: number | null;
  proxyCalls: number | null;
  proxyCostUsd: number | null;
  proxyInputTokens: number | null;
  proxyOutputTokens: number | null;
  proxyComplete: boolean | null;
  harnessCalls: number | null;
  toolCalls: number | null;
  toolErrors: number | null;
  malformedToolCalls: number | null;
  agentTurns: number | null;
  clientTurns: number | null;
}

export interface SpanView {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startNs: string;
  endNs: string;
  statusCode: number;
  statusMessage: string | null;
  attributes: Record<string, unknown>;
  events: { name: string; timeNs: string; attributes: Record<string, unknown> }[];
}

export interface TrialDetail {
  summary: TrialSummary;
  spec: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
}

/** Gate and smoke runs from the folder store (`GET /trials`), through the typed client so
 *  fixture mode serves them too. */
export const fetchTrials = (): Promise<TrialSummary[]> => api.recordedTrials();

/** Harness colours follow the harness, never its rank (categorical slots in a fixed order). */
export const HARNESS_ORDER = ['hermes', 'ownloop', 'langgraph', 'adk', 'openai-agents'];

export function harnessSlot(harness: string): number {
  const i = HARNESS_ORDER.indexOf(harness);
  return i === -1 ? HARNESS_ORDER.length + 1 : i + 1;
}

/** A config, for spend: harness, model, prompt version and the config hash. */
export interface ConfigSpend {
  key: string;
  /** harness | model | prompt | short config hash, for display */
  label: string;
  harness: string;
  model: string;
  promptVersion: string;
  trials: number;
  totalUsd: number;
  meanUsd: number;
  meanProxyCalls: number | null;
  meanHarnessCalls: number | null;
  infra: number;
  unpriced: number;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function spendByConfig(trials: TrialSummary[]): ConfigSpend[] {
  const groups = new Map<string, TrialSummary[]>();
  for (const t of trials) {
    const key = [t.harness, t.model ?? '?', t.promptVersion ?? '?', t.configHash ?? '?'].join(' | ');
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const rows: ConfigSpend[] = [];
  for (const [key, ts] of groups) {
    const priced = ts.filter((t) => t.proxyCostUsd !== null);
    const total = priced.reduce((a, t) => a + (t.proxyCostUsd ?? 0), 0);
    rows.push({
      key,
      label: [ts[0].harness, ts[0].model ?? '?', ts[0].promptVersion ?? '?', (ts[0].configHash ?? '?').replace('sha256:', '').slice(0, 12)].join(' | '),
      harness: ts[0].harness,
      model: ts[0].model ?? '?',
      promptVersion: ts[0].promptVersion ?? '?',
      trials: ts.length,
      totalUsd: total,
      meanUsd: priced.length ? total / priced.length : 0,
      meanProxyCalls: mean(ts.flatMap((t) => (t.proxyCalls === null ? [] : [t.proxyCalls]))),
      meanHarnessCalls: mean(ts.flatMap((t) => (t.harnessCalls === null ? [] : [t.harnessCalls]))),
      infra: ts.filter((t) => t.label.startsWith('infra:')).length,
      unpriced: ts.length - priced.length,
    });
  }
  return rows.sort((a, b) => harnessSlot(a.harness) - harnessSlot(b.harness) || a.key.localeCompare(b.key));
}

/** What a span is, for colour and legend: the trial, a turn, a model call, a tool or the client. */
export type SpanRole = 'trial' | 'turn' | 'chat' | 'chat-sim' | 'tool' | 'client';

export function spanRole(span: SpanView): SpanRole {
  if (span.parentSpanId === null) return 'trial';
  if (span.name === 'agent.turn') return 'turn';
  if (span.name === 'client_sim.turn') return 'client';
  if (span.name.startsWith('execute_tool')) return 'tool';
  if (span.name.startsWith('chat ')) return span.attributes['evals.role'] === 'sim' ? 'chat-sim' : 'chat';
  return 'turn';
}

export interface TimelineRow {
  span: SpanView;
  depth: number;
  startMs: number;
  durationMs: number;
  role: SpanRole;
}

/** Spans in tree order (parent, then its children by start time), with times relative to the
 *  trace's first start in milliseconds. */
export function timelineRows(spans: SpanView[]): { rows: TimelineRow[]; totalMs: number } {
  if (!spans.length) return { rows: [], totalMs: 0 };
  const t0 = spans.reduce((m, s) => (BigInt(s.startNs) < m ? BigInt(s.startNs) : m), BigInt(spans[0].startNs));
  const tEnd = spans.reduce((m, s) => (BigInt(s.endNs) > m ? BigInt(s.endNs) : m), BigInt(spans[0].endNs));
  const ms = (ns: string) => Number(BigInt(ns) - t0) / 1e6;
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string | null, SpanView[]>();
  for (const s of spans) {
    const parent = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  for (const list of children.values()) list.sort((a, b) => ms(a.startNs) - ms(b.startNs));
  const rows: TimelineRow[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      rows.push({ span: s, depth, startMs: ms(s.startNs), durationMs: Math.max(0, ms(s.endNs) - ms(s.startNs)), role: spanRole(s) });
      visit(s.spanId, depth + 1);
    }
  };
  visit(null, 0);
  return { rows, totalMs: Number(tEnd - t0) / 1e6 };
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

export function duration(ms: number): string {
  return ms >= 100 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** One bar of the trial timeline: a span, or the harness's own start-up and shut-down, which
 *  are the gaps between the trial span's edges and its first and last child. */
export interface SpanBar {
  id: string;
  /** The row's name: "Agent call 2", "tool fd_maturity". */
  label: string;
  /** The same with what the name leaves out, for the row's tooltip and screen readers: the model
   *  of an agent call. */
  title: string;
  /** A tool bar's tool name, a literal identifier the row sets in mono: "get_client_profile". */
  ident?: string;
  role: 'agent' | 'tool' | 'client' | 'harness';
  startMs: number;
  durationMs: number;
  derived: boolean;
  error: boolean;
  span: SpanView | null;
}

export function spanBars(spans: SpanView[], harness?: string): { bars: SpanBar[]; totalMs: number } {
  const { rows, totalMs } = timelineRows(spans);
  if (!rows.length) return { bars: [], totalMs: 0 };
  const clientTurns = new Set(rows.filter((r) => r.role === 'client').map((r) => r.span.spanId));
  const shown = rows.filter((r) => r.role !== 'trial' && r.role !== 'turn' && !(r.role === 'chat-sim' && clientTurns.has(r.span.parentSpanId ?? '')));
  const agentChats = shown.filter((r) => r.role === 'chat');
  const lastChat = agentChats[agentChats.length - 1]?.span.spanId;
  const bars: SpanBar[] = shown.map((r) => {
    const a = r.span.attributes;
    const model = typeof a['gen_ai.request.model'] === 'string' ? a['gen_ai.request.model'] : r.span.name.replace(/^chat /, '');
    let label = r.span.name;
    let title = '';
    let ident: string | undefined;
    let role: SpanBar['role'] = 'harness';
    if (r.role === 'chat') {
      // Numbered, so each call fits its row; the model id is in the tooltip and the details.
      const n = agentChats.findIndex((c) => c.span.spanId === r.span.spanId) + 1;
      label = `Agent call ${n}${r.span.spanId === lastChat && agentChats.length > 1 ? ', final reply' : ''}`;
      title = `${label}: chat ${model}`;
      role = 'agent';
    } else if (r.role === 'chat-sim') {
      label = 'chat simulated client';
      role = 'client';
    } else if (r.role === 'client') {
      label = 'Simulated client';
      role = 'client';
    } else if (r.role === 'tool') {
      ident = text(a['gen_ai.tool.name'] ?? r.span.name.replace(/^execute_tool /, ''));
      label = `tool ${ident}`;
      role = 'tool';
    }
    return {
      id: r.span.spanId,
      label,
      title: title || label,
      ...(ident !== undefined ? { ident } : {}),
      role,
      startMs: r.startMs,
      durationMs: r.durationMs,
      derived: false,
      error: r.span.statusCode === 2 || a['evals.tool.is_error'] === true,
      span: r.span,
    };
  });
  const children = rows.filter((r) => r.depth > 0);
  if (children.length) {
    const first = Math.min(...children.map((r) => r.startMs));
    const last = Math.max(...children.map((r) => r.startMs + r.durationMs));
    const who = harness ? harnessShort(harness) : 'Harness';
    const startup = `${who} start-up`;
    const shutdown = 'Shut down and collect files';
    if (first >= 1) bars.unshift({ id: 'derived:startup', label: startup, title: startup, role: 'harness', startMs: 0, durationMs: first, derived: true, error: false, span: null });
    if (totalMs - last >= 1) bars.push({ id: 'derived:shutdown', label: shutdown, title: shutdown, role: 'harness', startMs: last, durationMs: totalMs - last, derived: true, error: false, span: null });
  }
  return { bars, totalMs };
}

/** Any attribute value as display text: primitives as they are, everything else as JSON. */
export function text(value: unknown): string {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value);
}
