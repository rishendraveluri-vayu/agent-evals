import type { JsonObject, ReportRequest } from '../contract';
import { badRequest } from '../common/api-error';
import { normalizeSha } from '../common/hashing';
import { isLabel } from '../trials/status';
import { plainValue } from '../trials/trial-store';

/** Pure checks and extraction for POST /worker/trials/:id/report. */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * A reported file hash, stored as `sha256:<hex>` whether it came as that or as bare hex (any case).
 * Anything else is kept as sent (trimmed, lower case) so the file check can flag it.
 */
export function reportedSha(raw: string): string {
  return normalizeSha(raw) ?? raw.trim().toLowerCase();
}

/** The body's shape. A bad span or file is not a reason to refuse a whole trial's report. */
export function parseReport(body: unknown): ReportRequest {
  if (!isObj(body)) throw badRequest('invalid_report', 'the body must be a JSON object');
  if (typeof body.worker_id !== 'string' || !body.worker_id) throw badRequest('invalid_report', 'worker_id is required');
  if (int(body.attempt) === null || (body.attempt as number) < 1) throw badRequest('invalid_report', 'attempt must be an integer of at least 1');
  if (!isObj(body.runner_report)) throw badRequest('invalid_report', 'runner_report must be the runner report object');
  if (!isLabel(body.runner_report.label)) {
    throw badRequest('invalid_report', `runner_report.label ${String(body.runner_report.label)} is not agent or infra:*`);
  }
  if (body.result !== null && body.result !== undefined && !isObj(body.result)) throw badRequest('invalid_report', 'result must be an object or null');
  if (body.spans !== undefined && !Array.isArray(body.spans)) throw badRequest('invalid_report', 'spans must be a list');
  if (body.files !== undefined && !Array.isArray(body.files)) throw badRequest('invalid_report', 'files must be a list');
  const files = ((body.files as unknown[] | undefined) ?? []).map((f, i) => {
    if (!isObj(f) || typeof f.path !== 'string' || int(f.bytes) === null || typeof f.sha256 !== 'string') {
      throw badRequest('invalid_report', `files[${i}] must be {path, bytes, sha256}`);
    }
    return { path: f.path, bytes: f.bytes as number, sha256: reportedSha(f.sha256) };
  });
  return {
    worker_id: body.worker_id,
    attempt: body.attempt as number,
    runner_report: body.runner_report as JsonObject,
    result: (body.result as JsonObject | null | undefined) ?? null,
    spans: ((body.spans as unknown[] | undefined) ?? []) as JsonObject[],
    files,
  };
}

/**
 * D26: why an `infra:config_error` report paused its experiment, in plain words for the events
 * list: LiteLLM's last status and the provider's own message from the adapter's end_detail (the
 * first JSON `"message"` in it, which is the provider's text inside LiteLLM's wrapping), else the
 * start of the whole error.
 */
export function configErrorReason(result: JsonObject | null, runnerReport: JsonObject): string {
  const usage = runnerReport.proxy_usage;
  const status = isObj(usage) && typeof usage.last_status === 'string' ? usage.last_status : null;
  const detail = isObj(result) && isObj(result.end_detail) ? result.end_detail : {};
  const raw = typeof detail.exception_message === 'string' ? detail.exception_message : '';
  let message = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
  const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (inner) {
    try {
      message = (JSON.parse(`"${inner[1]}"`) as string).slice(0, 300);
    } catch {
      message = inner[1].slice(0, 300);
    }
  }
  const head = `infra:config_error (LiteLLM status ${status ?? 'unknown'})`;
  return `${head}${message ? `: ${message}` : ''}. New claims are paused; fix the setup and POST /experiments/:id/start to resume, or cancel`;
}

export interface SpanRow {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: number;
  start_ns: string;
  end_ns: string;
  status_code: number;
  attributes: Record<string, unknown>;
  raw: unknown;
}

const NS = /^(0|[1-9][0-9]{0,19})$/;

/** Spans the table can hold, plus a note for each one it cannot (kept in trace.jsonl). */
export function spanRows(spans: unknown[]): { rows: SpanRow[]; problems: string[] } {
  const rows: SpanRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  spans.forEach((s, i) => {
    if (!isObj(s) || typeof s.spanId !== 'string' || !s.spanId || typeof s.name !== 'string' || !s.name) {
      problems.push(`span ${i} has no spanId or name; kept only in trace.jsonl`);
      return;
    }
    const start = typeof s.startTimeUnixNano === 'string' ? s.startTimeUnixNano : '';
    const end = typeof s.endTimeUnixNano === 'string' ? s.endTimeUnixNano : '';
    if (!NS.test(start) || !NS.test(end)) {
      problems.push(`span ${s.spanId} has no valid start or end time; kept only in trace.jsonl`);
      return;
    }
    if (seen.has(s.spanId)) {
      problems.push(`span id ${s.spanId} appears twice; the first is stored`);
      return;
    }
    seen.add(s.spanId);
    const attributes: Record<string, unknown> = {};
    if (Array.isArray(s.attributes)) {
      for (const a of s.attributes) if (isObj(a) && typeof a.key === 'string') attributes[a.key] = plainValue(a.value);
    }
    const status = isObj(s.status) ? s.status : {};
    rows.push({
      span_id: s.spanId,
      parent_span_id: typeof s.parentSpanId === 'string' && s.parentSpanId ? s.parentSpanId : null,
      name: s.name,
      kind: int(s.kind) ?? 1,
      start_ns: start,
      end_ns: end,
      status_code: int(status.code) ?? 0,
      attributes,
      raw: s,
    });
  });
  return { rows, problems };
}

export interface Usage {
  cost_usd: number | null;
  sim_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_calls: number | null;
  proxy_complete: boolean | null;
  wall_s: number | null;
  end_state: string | null;
}

/** The numbers the API indexes: LiteLLM's usage for the agent key (R10.9), and the
 *  simulated client's spend from its own chat spans. */
export function usageOf(report: JsonObject, result: JsonObject | null, rows: SpanRow[]): Usage {
  const proxy = isObj(report.proxy_usage) ? report.proxy_usage : null;
  const timing = isObj(report.timing) ? report.timing : {};
  const simSpans = rows.filter((r) => r.name.startsWith('chat ') && r.attributes['evals.role'] === 'sim');
  const simCost = simSpans.reduce((sum, r) => sum + (num(r.attributes['evals.cost_usd']) ?? 0), 0);
  const endState = typeof report.end_state === 'string' ? report.end_state : result && typeof result.end_state === 'string' ? result.end_state : null;
  return {
    cost_usd: proxy ? num(proxy.cost_usd) : null,
    sim_cost_usd: simSpans.length ? Math.round(simCost * 1e8) / 1e8 : null,
    input_tokens: proxy ? int(proxy.input_tokens) : null,
    output_tokens: proxy ? int(proxy.output_tokens) : null,
    model_calls: proxy ? int(proxy.model_calls) : null,
    proxy_complete: proxy && typeof proxy.complete === 'boolean' ? proxy.complete : null,
    wall_s: num(timing.wall_s),
    end_state: endState,
  };
}
