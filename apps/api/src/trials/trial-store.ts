import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Read access to finished trials: what the runner uploaded for each one (contract v2,
 * docs/adapter-contract.md section 10).
 *
 * Interim, for SP1: `FileTrialStore` reads trial folders from a runs directory, so the trace
 * view and spend chart work before SP2's data model exists. SP2 replaces it with a database
 * store behind this same interface; the controller and the UI do not change.
 */
export interface TrialStore {
  list(): Promise<TrialSummary[]>;
  get(trialId: string): Promise<TrialDetail | null>;
  spans(trialId: string): Promise<SpanView[] | null>;
  artifact(trialId: string, relPath: string): Promise<Buffer | null>;
}

export const TRIAL_STORE = Symbol('TRIAL_STORE');

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

export interface TrialDetail {
  summary: TrialSummary;
  spec: unknown;
  result: unknown;
  report: unknown;
}

/** A span with its attributes as a plain object, which is what the UI draws from. */
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

type Json = Record<string, unknown>;

const REPORT = path.join('out', 'runner-report.json');
const MAX_DEPTH = 6; // runs/<stamp>/<harness>/<scenario>/trial is four levels down

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** OTLP AnyValue to a plain value. */
export function plainValue(value: unknown): unknown {
  const v = obj(value);
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) {
    const values = obj(v.arrayValue).values;
    return Array.isArray(values) ? values.map(plainValue) : [];
  }
  return null;
}

function plainAttributes(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(list)) {
    for (const item of list) {
      const entry = obj(item);
      if (typeof entry.key === 'string') out[entry.key] = plainValue(entry.value);
    }
  }
  return out;
}

export function toSpanView(raw: unknown): SpanView {
  const s = obj(raw);
  const status = obj(s.status);
  const events = Array.isArray(s.events) ? s.events : [];
  return {
    spanId: str(s.spanId) ?? '',
    parentSpanId: str(s.parentSpanId) || null,
    name: str(s.name) ?? '',
    kind: num(s.kind) ?? 1,
    startNs: str(s.startTimeUnixNano) ?? '0',
    endNs: str(s.endTimeUnixNano) ?? '0',
    statusCode: num(status.code) ?? 0,
    statusMessage: str(status.message),
    attributes: plainAttributes(s.attributes),
    events: events.map((e) => {
      const ev = obj(e);
      return { name: str(ev.name) ?? '', timeNs: str(ev.timeUnixNano) ?? '0', attributes: plainAttributes(ev.attributes) };
    }),
  };
}

export function summarise(spec: unknown, result: unknown, report: unknown): TrialSummary {
  const sp = obj(spec);
  const res = obj(result);
  const rep = obj(report);
  const trial = obj(sp.trial);
  const proxy = rep.proxy_usage === null ? null : obj(rep.proxy_usage);
  const counts = obj(res.counts);
  const conv = obj(res.conversation);
  const timing = obj(rep.timing);
  return {
    trialId: str(rep.trial_id) ?? str(trial.id) ?? 'unknown',
    harness: str(rep.harness) ?? str(obj(res.harness).name) ?? 'unknown',
    model: str(obj(sp.model).name),
    taskId: str(trial.task_id),
    configHash: str(trial.config_hash),
    promptVersion: str(obj(sp.system_prompt).version),
    toolsetVersion: str(obj(obj(sp.tools).toolset).version),
    label: str(rep.label) ?? 'unknown',
    endState: str(rep.end_state),
    startedAt: str(timing.started_at),
    wallS: num(timing.wall_s),
    proxyCalls: proxy ? num(proxy.model_calls) : null,
    proxyCostUsd: proxy ? num(proxy.cost_usd) : null,
    proxyInputTokens: proxy ? num(proxy.input_tokens) : null,
    proxyOutputTokens: proxy ? num(proxy.output_tokens) : null,
    proxyComplete: proxy ? (typeof proxy.complete === 'boolean' ? proxy.complete : null) : null,
    harnessCalls: num(counts.model_calls),
    toolCalls: num(counts.tool_calls),
    toolErrors: num(counts.tool_errors),
    malformedToolCalls: num(counts.malformed_tool_calls),
    agentTurns: num(conv.agent_turns),
    clientTurns: num(conv.client_turns),
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Trial folders under a runs directory: any folder holding out/runner-report.json. */
export class FileTrialStore implements TrialStore {
  private index: Map<string, string> | null = null;

  constructor(private readonly runsDir: string) {}

  private async scan(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isDirectory() && e.name === 'out')) {
        const report = obj(await readJson(path.join(dir, REPORT)));
        if (typeof report.trial_id === 'string') {
          found.set(report.trial_id, dir);
          return;
        }
      }
      if (depth >= MAX_DEPTH) return;
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1);
      }
    };
    await walk(this.runsDir, 0);
    this.index = found;
    return found;
  }

  private async dirFor(trialId: string): Promise<string | null> {
    const known = this.index?.get(trialId);
    if (known) return known;
    return (await this.scan()).get(trialId) ?? null;
  }

  async list(): Promise<TrialSummary[]> {
    const index = await this.scan();
    const rows: TrialSummary[] = [];
    for (const dir of index.values()) {
      const detail = await this.load(dir);
      rows.push(detail.summary);
    }
    return rows.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  }

  private async load(dir: string): Promise<TrialDetail> {
    const [spec, result, report] = await Promise.all([
      readJson(path.join(dir, 'spec.json')),
      readJson(path.join(dir, 'out', 'result.json')),
      readJson(path.join(dir, REPORT)),
    ]);
    return { summary: summarise(spec, result, report), spec, result, report };
  }

  async get(trialId: string): Promise<TrialDetail | null> {
    const dir = await this.dirFor(trialId);
    return dir ? this.load(dir) : null;
  }

  async spans(trialId: string): Promise<SpanView[] | null> {
    const dir = await this.dirFor(trialId);
    if (!dir) return null;
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, 'out', 'trace.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const spans: SpanView[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        spans.push(toSpanView(JSON.parse(line)));
      } catch {
        // A torn last line from a killed adapter: keep every span that parsed.
      }
    }
    return spans.sort((a, b) => (BigInt(a.startNs) < BigInt(b.startNs) ? -1 : BigInt(a.startNs) > BigInt(b.startNs) ? 1 : 0));
  }

  /** A file under the trial's out folder. Paths that escape it are refused. */
  async artifact(trialId: string, relPath: string): Promise<Buffer | null> {
    const dir = await this.dirFor(trialId);
    if (!dir) return null;
    const outDir = path.resolve(dir, 'out');
    const target = path.resolve(outDir, relPath);
    if (!target.startsWith(outDir + path.sep)) return null;
    try {
      const stat = await fs.stat(target);
      return stat.isFile() ? await fs.readFile(target) : null;
    } catch {
      return null;
    }
  }
}
