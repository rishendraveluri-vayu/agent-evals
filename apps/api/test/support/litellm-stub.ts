import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for LiteLLM's management API, on a local port, so the tests never call the real
 * proxy with the master key. It answers the five calls the API makes, in the shapes LiteLLM
 * v1.99.4 uses, and records every call.
 */

export const STUB_MASTER_KEY = 'sk-test-master-not-real';

export interface StubKey {
  key: string;
  token: string;
  key_alias: string;
  models: string[];
  max_budget: number;
  team_id: string | null;
  metadata: Record<string, unknown>;
}

export class LiteLlmStub {
  private server: http.Server | null = null;
  url = '';
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  readonly keys = new Map<string, StubKey>();
  readonly deleted: string[] = [];
  readonly teams: { team_id: string; team_alias: string; max_budget: number }[] = [];
  readonly spendLogs = new Map<string, unknown[]>();
  /** Delay on /key/generate, to hold claim transactions open at the same time. */
  keyDelayMs = 0;
  /** When set, /key/generate fails with this status. */
  failKeyGenerate: number | null = null;
  /**
   * `/model/info` as v1.99.4 answers it: a wildcard route (`fake/*`) is expanded into names
   * from LiteLLM's price map and the route itself is not listed (seen 4 Nov on the pinned image).
   */
  models: unknown[] = [
    {
      model_name: 'fake/gpt-4o-mini',
      litellm_params: { model: 'fake/gpt-4o-mini', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      model_info: { id: 'fake-route', input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
    },
    {
      model_name: 'claude-haiku-5-5',
      litellm_params: { model: 'anthropic/claude-haiku-5-5', input_cost_per_token: 0.0000001 },
      model_info: { input_cost_per_token: 0.0000001, output_cost_per_token: 0.0000005, litellm_provider: 'anthropic' },
    },
    {
      model_name: 'gemini-3.8-flash',
      litellm_params: { model: 'gemini/gemini-3.8-flash', input_cost_per_token: 0.00000075, output_cost_per_token: 0.00000375 },
      model_info: { litellm_provider: 'gemini' },
    },
    { model_name: 'unpriced-model', litellm_params: { model: 'openai/unpriced' }, model_info: {} },
  ];
  /** `/model_group/info`: the router's routes, the wildcard kept as one group. */
  modelGroups: unknown[] = [
    { model_group: 'fake/*', providers: ['openai'], input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
    { model_group: 'fake/gpt-4o-mini', providers: ['openai'], input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
    { model_group: 'claude-haiku-5-5', providers: ['anthropic'], input_cost_per_token: 0.0000001, output_cost_per_token: 0.0000005 },
    { model_group: 'gemini-3.8-flash', providers: ['gemini'], input_cost_per_token: 0.00000075, output_cost_per_token: 0.00000375 },
    { model_group: 'unpriced-model', providers: ['openai'], input_cost_per_token: null, output_cost_per_token: null },
    // A name LangGraph rewrites requests for, for the config warning tests. Routed only: no real call.
    { model_group: 'gpt-5-mini', providers: ['openai'], input_cost_per_token: 0.00000025, output_cost_per_token: 0.000002 },
  ];

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  liveKeys(): StubKey[] {
    return [...this.keys.values()].filter((k) => !this.deleted.includes(k.token));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url ?? '/', 'http://stub');
    this.calls.push({ method: req.method ?? '', path: url.pathname + url.search, body });
    const send = (status: number, data: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${STUB_MASTER_KEY}`) return send(401, { error: 'bad master key' });
    const b = (body ?? {}) as Record<string, unknown>;
    if (req.method === 'POST' && url.pathname === '/key/generate') {
      if (this.keyDelayMs) await new Promise((r) => setTimeout(r, this.keyDelayMs));
      if (this.failKeyGenerate) return send(this.failKeyGenerate, { error: 'stub refuses' });
      const key: StubKey = {
        key: `sk-trial-${randomBytes(8).toString('hex')}`,
        token: randomBytes(16).toString('hex'),
        key_alias: String(b.key_alias),
        models: b.models as string[],
        max_budget: b.max_budget as number,
        team_id: (b.team_id as string | undefined) ?? null,
        metadata: b.metadata as Record<string, unknown>,
      };
      this.keys.set(key.token, key);
      return send(200, { key: key.key, token: key.token, key_alias: key.key_alias });
    }
    if (req.method === 'POST' && url.pathname === '/key/delete') {
      const tokens = (b.keys as string[]) ?? [];
      const missing = tokens.filter((t) => !this.keys.has(t) || this.deleted.includes(t));
      if (missing.length) return send(404, { error: `keys not found: ${missing.join(',')}` });
      this.deleted.push(...tokens);
      return send(200, { deleted_keys: tokens });
    }
    if (req.method === 'POST' && url.pathname === '/team/new') {
      const team = { team_id: `team-${randomBytes(6).toString('hex')}`, team_alias: String(b.team_alias), max_budget: b.max_budget as number };
      this.teams.push(team);
      return send(200, team);
    }
    if (req.method === 'GET' && url.pathname === '/spend/logs') {
      return send(200, this.spendLogs.get(url.searchParams.get('api_key') ?? '') ?? []);
    }
    if (req.method === 'GET' && url.pathname === '/model/info') return send(200, { data: this.models });
    if (req.method === 'GET' && url.pathname === '/model_group/info') return send(200, { data: this.modelGroups });
    return send(404, { error: `stub has no ${req.method} ${url.pathname}` });
  }
}
