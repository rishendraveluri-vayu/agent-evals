import type { JsonObject, ReportRequest } from '../contract';
import { badRequest } from '../common/api-error';
import { normalizeSha } from '../common/hashing';
import { spendLogUsd } from '../judge/judge-core';
import { isLabel } from '../trials/status';
import { plainValue } from '../trials/trial-store';

/** Pure checks and extraction for POST /worker/trials/:id/report. */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * A reported file hash, stored as `sha256:<hex>` whether it came as that or as bare hex (any case).
 * Anything else is kept as sent (trimmed, lower case) so the file check can flag it.
 */
export function reportedSha(raw: string): string {
  return normalizeSha(raw) ?? raw.trim().toLowerCase();
}

/**
 * E7 (6 Nov review): Postgres text and jsonb cannot hold U+0000, so a report carrying one failed
 * with a 500 on every retry and the finished trial was lost. Every NUL in a string or an object key
 * becomes U+FFFD (the replacement character) before anything is stored, and `replaced` says how
 * many, for the trial's problems. The uploaded files keep the bytes as the worker sent them.
 */
export function withoutNul(value: unknown): { value: unknown; replaced: number } {
  let replaced = 0;
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!v.includes('\u0000')) return v;
      const parts = v.split('\u0000');
      replaced += parts.length - 1;
      return parts.join('\uFFFD');
    }
    if (Array.isArray(v)) return v.map(clean);
    if (!isObj(v)) return v;
    const out: Obj = {};
    // defineProperty, so a key such as "__proto__" stays a plain key of the copy.
    for (const [k, x] of Object.entries(v)) Object.defineProperty(out, clean(k) as string, { value: clean(x), enumerable: true, writable: true, configurable: true });
    return out;
  };
  return { value: clean(value), replaced };
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

/** LiteLLM's status for the trial's last call, as the runner reported it, or null. */
function lastStatus(runnerReport: JsonObject): string | null {
  const usage = runnerReport.proxy_usage;
  return isObj(usage) && typeof usage.last_status === 'string' ? usage.last_status : null;
}

/**
 * D26, D37: why an `infra:config_error` report paused its arm, in plain words for the UI and the
 * events list: LiteLLM's last status and the provider's own message from the adapter's end_detail
 * (the first JSON `"message"` in it, which is the provider's text inside LiteLLM's wrapping), else
 * the start of the whole error.
 */
export function configErrorReason(result: JsonObject | null, runnerReport: JsonObject): string {
  const status = lastStatus(runnerReport);
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
  return `${head}${message ? `: ${message}` : ''}`;
}

/**
 * D37: how to fix a config error, by LiteLLM's status (D26's kinds: auth, unknown model, a
 * rejected request). A config cannot change once stored, so a fix inside the config means a
 * forked config and a new experiment; a fix outside it (a key, LiteLLM's model list) is made
 * there, then the arm is resumed.
 */
export function configErrorFix(runnerReport: JsonObject): string {
  const resume = 'then POST /experiments/:id/arms/:config_hash/resume to continue this arm';
  switch (lastStatus(runnerReport)) {
    case '401':
    case '403':
      return `The provider refused the key: fix the provider key or its permissions in LiteLLM's environment (never in the config), ${resume}.`;
    case '404':
      return `The provider does not know the model: fix the model's route in LiteLLM's config, ${resume}; if the config names the wrong model, fork it with the right one and run a new experiment.`;
    case '400':
      return (
        `The provider refused how the request is set up: read the message. A setting the model rejects needs a forked config ` +
        `without it and a new experiment (a config cannot change); a key or account problem is fixed in LiteLLM, ${resume}.`
      );
    default:
      return `Find the setup problem in the trial's result and LiteLLM's logs, fix it, ${resume}; or stop the experiment.`;
  }
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
/** Postgres smallint, the span kind and status code columns. */
const SMALLINT = { min: -32_768, max: 32_767 } as const;
const small = (v: unknown, fallback: number): number => {
  const n = int(v);
  return n !== null && n >= SMALLINT.min && n <= SMALLINT.max ? n : fallback;
};

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
      // E8: a value the column cannot hold is not a reason to lose the span.
      kind: small(s.kind, 1),
      start_ns: start,
      end_ns: end,
      status_code: small(status.code, 0),
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

/**
 * G3: what an abandoned attempt spent, from LiteLLM's spend-log rows for its keys, summed as the
 * runner sums a reported trial's (`ProxyClient.usage`: `spend`, `prompt_tokens`,
 * `completion_tokens`, one row per call). `sim` is null when the attempt had no simulator key.
 */
export function spendLogUsage(
  agent: unknown[],
  sim: unknown[] | null,
): { cost_usd: number; sim_cost_usd: number | null; input_tokens: number; output_tokens: number; model_calls: number } {
  const rows = agent.filter(isObj);
  const tokens = (field: string): number => Math.min(INT_MAX, rows.reduce((s, r) => s + Math.max(0, int(r[field]) ?? 0), 0));
  return {
    cost_usd: spendLogUsd(agent),
    sim_cost_usd: sim === null ? null : spendLogUsd(sim),
    input_tokens: tokens('prompt_tokens'),
    output_tokens: tokens('completion_tokens'),
    model_calls: rows.length,
  };
}

/** Postgres integer, the token and call count columns. */
export const INT_MAX = 2_147_483_647;

/**
 * E8 (6 Nov review): a number the worker reported is taken only when it is finite and at least 0;
 * anything else is stored as unknown (null, never zero) and named in `problems`. A count above
 * the integer column's range is stored as INT_MAX, also named. A negative cost used to lower the
 * experiment's spend (-1000 was stored), and 3e9 tokens failed the whole report with a 500.
 */
function amount(v: unknown, what: string, problems: string[]): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  problems.push(`${what} ${JSON.stringify(v)?.slice(0, 40)} is not a number of at least 0; stored as unknown`);
  return null;
}

function count(v: unknown, what: string, problems: string[]): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    problems.push(`${what} ${JSON.stringify(v)?.slice(0, 40)} is not a whole number of at least 0; stored as unknown`);
    return null;
  }
  if (v > INT_MAX) {
    problems.push(`${what} ${v} is more than the ${INT_MAX} the database holds; stored as ${INT_MAX}`);
    return INT_MAX;
  }
  return v;
}

const END_STATE_MAX = 64;

/** The numbers the API indexes: LiteLLM's usage for the agent key (R10.9), and the
 *  simulated client's spend from its own chat spans. What it cannot take goes in `problems` (E8). */
export function usageOf(report: JsonObject, result: JsonObject | null, rows: SpanRow[], problems: string[] = []): Usage {
  const proxy = isObj(report.proxy_usage) ? report.proxy_usage : null;
  const timing = isObj(report.timing) ? report.timing : {};
  const simSpans = rows.filter((r) => r.name.startsWith('chat ') && r.attributes['evals.role'] === 'sim');
  const simCost = simSpans.reduce((sum, r) => sum + (amount(r.attributes['evals.cost_usd'], `span ${r.span_id} evals.cost_usd`, problems) ?? 0), 0);
  const rawEnd = typeof report.end_state === 'string' ? report.end_state : result && typeof result.end_state === 'string' ? result.end_state : null;
  // The contract's end states are short words, extensible (contract v2); a long one is cut and named (re-check of the review, 6 Nov).
  if (rawEnd !== null && rawEnd.length > END_STATE_MAX) problems.push(`end_state was ${rawEnd.length} characters, cut to ${END_STATE_MAX}`);
  const endState = rawEnd === null ? null : rawEnd.slice(0, END_STATE_MAX);
  return {
    cost_usd: proxy ? amount(proxy.cost_usd, 'proxy_usage.cost_usd', problems) : null,
    sim_cost_usd: simSpans.length ? Math.round(simCost * 1e8) / 1e8 : null,
    input_tokens: proxy ? count(proxy.input_tokens, 'proxy_usage.input_tokens', problems) : null,
    output_tokens: proxy ? count(proxy.output_tokens, 'proxy_usage.output_tokens', problems) : null,
    model_calls: proxy ? count(proxy.model_calls, 'proxy_usage.model_calls', problems) : null,
    proxy_complete: proxy && typeof proxy.complete === 'boolean' ? proxy.complete : null,
    wall_s: amount(timing.wall_s, 'timing.wall_s', problems),
    end_state: endState,
  };
}
