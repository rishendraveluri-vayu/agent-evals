import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';

/**
 * LiteLLM's management API, called with the master key. Only the API holds that key
 * (docs/api-contract.md): it mints and revokes each trial's keys, sets the experiment's
 * budget, reads spend logs and prices. Shapes checked against LiteLLM v1.99.4's source
 * (proxy_server.py `/model/info`, team_endpoints.py `/team/new`) and the runner's ProxyClient.
 */

export interface MintedKey {
  /** The secret, handed to the worker once and never stored. */
  key: string;
  /** LiteLLM's hash of it, kept to read the spend log and to revoke. */
  token: string;
}

export interface ModelPrice {
  name: string;
  provider: string | null;
  /** USD per token, or null when LiteLLM has no price. */
  inputPerToken: number | null;
  outputPerToken: number | null;
}

/** LiteLLM answered with an error status (as opposed to not answering at all). */
export class LiteLlmHttpError extends ApiError {
  constructor(
    readonly upstreamStatus: number,
    message: string,
  ) {
    super(502, 'litellm_error', message);
  }
}

const TIMEOUT_MS = 15_000;
const MODEL_INFO_TTL_MS = 30_000;

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** `fake/*` matches `fake/finance-emi`; a name with no `*` matches only itself. */
export function routeMatches(route: string, model: string): boolean {
  if (!route.includes('*')) return route === model;
  const pattern = route.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${pattern.join('.*')}$`).test(model);
}

@Injectable()
export class LiteLlmClient {
  private modelInfoCache: { at: number; rows: ModelPrice[] } | null = null;
  private modelGroupCache: { at: number; rows: ModelPrice[] } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** LiteLLM's OpenAI-compatible base URL for workers (`model.base_url` in the spec). */
  get workerBaseUrl(): string {
    return `${this.base()}/v1`;
  }

  private base(): string {
    if (!this.config.litellmUrl || !this.config.litellmMasterKey) {
      throw new ApiError(503, 'litellm_not_configured', 'LITELLM_URL and LITELLM_MASTER_KEY must both be set');
    }
    return this.config.litellmUrl;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = this.base() + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.config.litellmMasterKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError(502, 'litellm_unavailable', `${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new LiteLlmHttpError(res.status, `${method} ${path}: HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new ApiError(502, 'litellm_error', `${method} ${path}: the reply is not JSON`);
    }
  }

  /** One key for one trial and role, limited to one model and given a budget. A probe trial has no experiment. */
  async generateKey(opts: {
    trialId: string;
    role: 'agent' | 'sim';
    model: string;
    maxBudgetUsd: number;
    teamId: string | null;
    experimentId: string | null;
    probe?: boolean;
  }): Promise<MintedKey> {
    return this.mint({
      key_alias: `${opts.trialId}:${opts.role}`,
      models: [opts.model],
      max_budget: opts.maxBudgetUsd,
      ...(opts.teamId ? { team_id: opts.teamId } : {}),
      metadata: { trial_id: opts.trialId, role: opts.role, experiment_id: opts.experimentId, ...(opts.probe ? { probe: true } : {}) },
    });
  }

  /** A key for one call the platform makes itself (D38), limited to one model and given a budget. */
  async generateSystemKey(opts: { alias: string; model: string; maxBudgetUsd: number; metadata: Record<string, string> }): Promise<MintedKey> {
    return this.mint({ key_alias: opts.alias, models: [opts.model], max_budget: opts.maxBudgetUsd, metadata: { ...opts.metadata, system: 'true' } });
  }

  private async mint(body: Record<string, unknown>): Promise<MintedKey> {
    const data = obj(await this.request('POST', '/key/generate', body));
    if (typeof data.key !== 'string' || typeof data.token !== 'string') {
      throw new ApiError(502, 'litellm_error', 'POST /key/generate: no key or token in the reply');
    }
    return { key: data.key, token: data.token };
  }

  /**
   * One chat completion with a minted key (never the master key), through LiteLLM's
   * OpenAI-compatible endpoint. An error status is returned, not thrown, so the caller can still
   * record what the call cost. `responseCostUsd` is LiteLLM's `x-litellm-response-cost` header.
   */
  async chat(key: string, body: Record<string, unknown>, timeoutMs: number): Promise<{ status: number; body: unknown; text: string; responseCostUsd: number | null }> {
    const url = `${this.base()}/v1/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ApiError(502, 'litellm_unavailable', `POST /v1/chat/completions: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      parsed = null;
    }
    const header = res.headers.get('x-litellm-response-cost');
    const cost = header === null || header.trim() === '' ? null : Number(header);
    return { status: res.status, body: parsed, text, responseCostUsd: cost !== null && Number.isFinite(cost) ? cost : null };
  }

  async deleteKeys(tokens: string[]): Promise<void> {
    if (tokens.length) await this.request('POST', '/key/delete', { keys: tokens });
  }

  /** One row per call made with the key, failures included, as LiteLLM returns them. */
  async spendLogs(token: string): Promise<unknown[]> {
    const rows = await this.request('GET', `/spend/logs?api_key=${encodeURIComponent(token)}`);
    return Array.isArray(rows) ? (rows as unknown[]) : [];
  }

  /** A team whose max_budget caps the whole experiment's spend across its trial keys. */
  async newTeam(opts: { alias: string; maxBudgetUsd: number; experimentId: string }): Promise<string> {
    const data = obj(
      await this.request('POST', '/team/new', {
        team_alias: opts.alias,
        max_budget: opts.maxBudgetUsd,
        metadata: { experiment_id: opts.experimentId },
      }),
    );
    if (typeof data.team_id !== 'string') throw new ApiError(502, 'litellm_error', 'POST /team/new: no team_id in the reply');
    return data.team_id;
  }

  /** Models as `/model/info` lists them, for GET /models (wildcard routes appear expanded). */
  async models(): Promise<ModelPrice[]> {
    if (this.modelInfoCache && Date.now() - this.modelInfoCache.at < MODEL_INFO_TTL_MS) return this.modelInfoCache.rows;
    const data = obj(await this.request('GET', '/model/info'));
    const rows = (Array.isArray(data.data) ? data.data : []).map((raw): ModelPrice => {
      const entry = obj(raw);
      const params = obj(entry.litellm_params);
      const info = obj(entry.model_info);
      const routed = typeof params.model === 'string' ? params.model : '';
      const provider = typeof info.litellm_provider === 'string' ? info.litellm_provider : routed.includes('/') ? routed.split('/')[0] : null;
      return {
        name: typeof entry.model_name === 'string' ? entry.model_name : '',
        provider,
        inputPerToken: num(info.input_cost_per_token) ?? num(params.input_cost_per_token),
        outputPerToken: num(info.output_cost_per_token) ?? num(params.output_cost_per_token),
      };
    });
    this.modelInfoCache = { at: Date.now(), rows };
    return rows;
  }

  /**
   * LiteLLM's routes as its router sees them (`/model_group/info`), wildcards included.
   * `/model/info` cannot be used to look a model up: v1.99.4 expands a wildcard route such as
   * `fake/*` into a few hundred names from its price map and never lists the route itself, so
   * `fake/finance-emi` is not in it (seen 4 Nov against the pinned image).
   */
  async modelGroups(): Promise<ModelPrice[]> {
    if (this.modelGroupCache && Date.now() - this.modelGroupCache.at < MODEL_INFO_TTL_MS) return this.modelGroupCache.rows;
    const data = obj(await this.request('GET', '/model_group/info'));
    const rows = (Array.isArray(data.data) ? data.data : []).map((raw): ModelPrice => {
      const g = obj(raw);
      const providers = Array.isArray(g.providers) ? g.providers.filter((p): p is string => typeof p === 'string') : [];
      return {
        name: typeof g.model_group === 'string' ? g.model_group : '',
        provider: providers[0] ?? null,
        inputPerToken: num(g.input_cost_per_token),
        outputPerToken: num(g.output_cost_per_token),
      };
    });
    this.modelGroupCache = { at: Date.now(), rows };
    return rows;
  }

  /** The route that serves `model` (exact name first, then a wildcard route), or null. */
  async findModel(model: string): Promise<ModelPrice | null> {
    const rows = await this.modelGroups();
    return rows.find((r) => r.name === model) ?? rows.find((r) => routeMatches(r.name, model)) ?? null;
  }
}
