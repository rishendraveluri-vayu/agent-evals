import { Injectable } from '@nestjs/common';
import type { ConfigDetail, ConfigDiffEntry, ConfigView, CreateConfigRequest, Json, JsonObject, Seed, SettingName, Settings, SettingsSources } from '../contract';
import { SETTING_NAMES } from '../contract';
import { badRequest, notFound } from '../common/api-error';
import { canonicalJson, hashCanonical, normalizeSha } from '../common/hashing';
import { CatalogueService, harnessNotImplemented } from '../catalogue/catalogue.service';
import { Db } from '../database/db.service';
import { LiteLlmClient } from '../litellm/litellm.client';
import { checkSeed, seedIsEmpty } from './seed';
import { checkHarnessOptions, resolveSettings, supports, unsupportedReasons } from './settings';
import { configWarnings } from './warnings';

/** Everything that can change a trial's behaviour; its canonical JSON is hashed (R14, SP2). */
export interface ConfigHashInput {
  harness_ref: string;
  adapter_version: string;
  capabilities_sha256: string;
  model: string;
  prompt_sha256: string;
  toolset_sha256: string;
  settings: Settings;
  harness_options: JsonObject;
  /** Seeded memory and skills (D39). Left out, or empty, it adds nothing to the hash. */
  seed?: Seed;
}

/**
 * An empty seed is left out of the hashed JSON, so a config without seeds keeps the hash it had
 * before seeds existed, and a seeded one always differs from it.
 */
export function configHash(input: ConfigHashInput): string {
  return hashCanonical({
    harness_ref: input.harness_ref,
    adapter_version: input.adapter_version,
    capabilities_sha256: input.capabilities_sha256,
    model: input.model,
    prompt_sha256: input.prompt_sha256,
    toolset_sha256: input.toolset_sha256,
    settings: input.settings,
    harness_options: input.harness_options,
    seed: input.seed && !seedIsEmpty(input.seed) ? input.seed : undefined,
  });
}

/** `c_` and the first 12 hex of the hash: the spec's `config_id`. */
export function configId(hash: string): string {
  return `c_${hash.replace(/^sha256:/, '').slice(0, 12)}`;
}

/** A config row joined with its prompt and toolset. */
export interface ConfigRow {
  hash: string;
  name: string;
  harness: string;
  harness_package: string;
  harness_ref: string;
  adapter_version: string;
  capabilities_sha256: string;
  capabilities: JsonObject;
  model: string;
  api_format: string;
  prompt_sha256: string;
  prompt_id: string;
  prompt_version: string;
  toolset_sha256: string;
  toolset_id: string;
  toolset_version: string;
  settings: Settings;
  settings_sources: SettingsSources;
  harness_options: JsonObject;
  seed: Seed;
  parent_hash: string | null;
  /** EXAMPLE_ONLY_SQL: came with a shipped example, and none of this database's own experiments uses it. */
  example_only: boolean;
  created_at: Date;
}

/**
 * True for config `c` when it came with a shipped example (SP7): an example experiment uses it, or
 * it is an ancestor (parent_hash) of a config one uses, since the bundle brings those too; and no
 * experiment of this database's own uses it. Every experiment using it is then an example's.
 */
export const EXAMPLE_ONLY_SQL = `(
    NOT EXISTS (SELECT 1 FROM experiments own WHERE own.example_name IS NULL AND c.hash = ANY (own.config_hashes))
    AND EXISTS (
      WITH RECURSIVE shipped (hash) AS (
        SELECT unnest(ex.config_hashes) FROM experiments ex WHERE ex.example_name IS NOT NULL
        UNION SELECT up.parent_hash FROM configs up JOIN shipped s ON s.hash = up.hash WHERE up.parent_hash IS NOT NULL)
      SELECT 1 FROM shipped WHERE shipped.hash = c.hash))`;

export const CONFIG_SELECT = `
  SELECT c.*, p.id AS prompt_id, p.version AS prompt_version, t.id AS toolset_id, t.version AS toolset_version,
         ${EXAMPLE_ONLY_SQL} AS example_only
  FROM configs c JOIN prompts p ON p.sha256 = c.prompt_sha256 JOIN toolsets t ON t.sha256 = c.toolset_sha256`;

export function configView(r: ConfigRow): ConfigView {
  return {
    hash: r.hash,
    name: r.name,
    harness: r.harness,
    harness_ref: r.harness_ref,
    adapter_version: r.adapter_version,
    capabilities_sha256: r.capabilities_sha256,
    model: r.model,
    prompt: { id: r.prompt_id, version: r.prompt_version, sha256: r.prompt_sha256 },
    toolset: { id: r.toolset_id, version: r.toolset_version, sha256: r.toolset_sha256 },
    settings: r.settings,
    settings_sources: r.settings_sources,
    // From the capabilities the config was validated against, which the row keeps.
    unsupported: unsupportedReasons(r.capabilities, r.harness, r.model),
    warnings: configWarnings(r.harness, r.model),
    harness_options: r.harness_options,
    seed: r.seed,
    parent_hash: r.parent_hash,
    example_only: r.example_only === true,
    created_at: r.created_at.toISOString(),
  };
}

/** Fields that are derived or are not behaviour (lineage and where it came from included), left out of a diff. */
const NOT_DIFFED = ['hash', 'created_at', 'unsupported', 'warnings', 'parent_hash', 'example_only'] as const;

/** Every leaf path where two values differ; objects are walked, arrays compared whole. */
export function diffValues(a: unknown, b: unknown, prefix = ''): ConfigDiffEntry[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffValues(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  const same = a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
  return same ? [] : [{ path: prefix, a: a as Json | undefined, b: b as Json | undefined }];
}

@Injectable()
export class ConfigsService {
  constructor(
    private readonly db: Db,
    private readonly catalogue: CatalogueService,
    private readonly litellm: LiteLlmClient,
  ) {}

  /** Stores the config, or returns the stored one with the same hash (`created: false`). */
  async create(body: CreateConfigRequest): Promise<{ config: ConfigView; created: boolean }> {
    if (typeof body !== 'object' || body === null) throw badRequest('invalid_config', 'the body must be a JSON object');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw badRequest('invalid_config', 'name is required');
    if (typeof body.harness !== 'string' || !body.harness) throw badRequest('invalid_config', 'harness is required');
    if (typeof body.model !== 'string' || !body.model) throw badRequest('invalid_config', 'model is required');
    const promptSha = normalizeSha(body.prompt_sha256);
    if (!promptSha) throw badRequest('invalid_config', 'prompt_sha256 must be sha256:<64 hex>');
    const toolsetSha = normalizeSha(body.toolset_sha256);
    if (!toolsetSha) throw badRequest('invalid_config', 'toolset_sha256 must be sha256:<64 hex>');
    let parentHash: string | null = null;
    if (body.parent_hash !== undefined && body.parent_hash !== null) {
      parentHash = normalizeSha(body.parent_hash);
      if (!parentHash) throw badRequest('invalid_config', 'parent_hash must be sha256:<64 hex> or null', 'Give the hash of the config this one was forked from, or leave parent_hash out.');
      const [parent] = await this.db.query('SELECT 1 FROM configs WHERE hash = $1', [parentHash]);
      if (!parent) throw badRequest('unknown_parent', `no config ${parentHash} to be the parent`, 'Fork from a config in GET /configs, or leave parent_hash out.');
    }

    const harnesses = await this.catalogue.harnesses();
    const harness = harnesses.find((h) => h.name === body.harness);
    if (!harness) {
      const scaffold = (await this.catalogue.allHarnesses()).find((h) => h.name === body.harness && h.scaffolded);
      if (scaffold) throw harnessNotImplemented(scaffold, harnesses.map((h) => h.name));
      throw badRequest('unknown_harness', `no harness named ${body.harness} under workers/`, `Pick a harness from GET /harnesses: ${harnesses.map((h) => h.name).join(', ')}.`);
    }
    const caps = harness.capabilities as { settings?: Record<string, { supported?: unknown }>; model_api_formats?: unknown; harness_options_schema?: unknown };
    // Per setting, the harnesses that take it, so a refusal can say where it would work.
    const elsewhere: Partial<Record<SettingName, string[]>> = {};
    for (const name of SETTING_NAMES) {
      elsewhere[name] = harnesses.filter((h) => supports(h.capabilities as Parameters<typeof supports>[0], name)).map((h) => h.name);
    }
    const { settings, settings_sources } = resolveSettings(body.settings, caps, harness.name, body.model, elsewhere);
    const harnessOptions = checkHarnessOptions(body.harness_options, caps.harness_options_schema, harness.name);
    const seed = checkSeed(body.seed, settings, caps, harness.name, elsewhere);

    const prompt = await this.catalogue.prompt(promptSha);
    if (!prompt) throw badRequest('unknown_prompt', `no prompt with ${promptSha}; see GET /prompts`, 'Pick a prompt sha256 from GET /prompts.');
    const toolset = await this.catalogue.toolset(toolsetSha);
    if (!toolset) throw badRequest('unknown_toolset', `no toolset with ${toolsetSha}; see GET /toolsets`, 'Pick a toolset sha256 from GET /toolsets.');
    if (!(await this.litellm.findModel(body.model))) {
      throw badRequest('unknown_model', `LiteLLM serves no model named ${body.model}`, 'Pick a model from GET /models, or add it to the LiteLLM config first.');
    }
    const formats = Array.isArray(caps.model_api_formats) ? (caps.model_api_formats as string[]) : [];
    const apiFormat = formats.includes('openai_chat') ? 'openai_chat' : (formats[0] ?? 'openai_chat');

    const hash = configHash({
      harness_ref: harness.ref,
      adapter_version: harness.adapter_version,
      capabilities_sha256: harness.capabilities_sha256,
      model: body.model,
      prompt_sha256: promptSha,
      toolset_sha256: toolsetSha,
      settings,
      harness_options: harnessOptions,
      seed,
    });
    if (parentHash === hash) {
      throw badRequest(
        'same_as_parent',
        `this config is identical to its parent ${parentHash}: a fork that changes nothing is the parent itself`,
        'Change the one thing this fork is meant to test (a setting, the prompt, the model, ...), or use the parent as it is.',
      );
    }
    // The first post of this content records the parent; a later post of the same content keeps it.
    const inserted = await this.db.query<{ hash: string }>(
      `INSERT INTO configs (hash, name, harness, harness_package, harness_ref, adapter_version, capabilities_sha256,
                            capabilities, model, api_format, prompt_sha256, toolset_sha256, settings, settings_sources,
                            harness_options, seed, parent_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (hash) DO NOTHING RETURNING hash`,
      [
        hash,
        name,
        harness.name,
        harness.package,
        harness.ref,
        harness.adapter_version,
        harness.capabilities_sha256,
        JSON.stringify(harness.capabilities),
        body.model,
        apiFormat,
        promptSha,
        toolsetSha,
        JSON.stringify(settings),
        JSON.stringify(settings_sources),
        JSON.stringify(harnessOptions),
        JSON.stringify(seed),
        parentHash,
      ],
    );
    return { config: configView(await this.row(hash)), created: inserted.length === 1 };
  }

  async list(): Promise<ConfigView[]> {
    const rows = await this.db.query<ConfigRow>(`${CONFIG_SELECT} ORDER BY c.created_at, c.hash`);
    return rows.map(configView);
  }

  async row(hashInput: string): Promise<ConfigRow> {
    const hash = normalizeSha(hashInput);
    if (!hash) throw badRequest('invalid_hash', `${hashInput} is not sha256:<64 hex>`);
    const [row] = await this.db.query<ConfigRow>(`${CONFIG_SELECT} WHERE c.hash = $1`, [hash]);
    if (!row) throw notFound('unknown_config', `no config ${hash}`);
    return row;
  }

  /** The config with the configs forked from it (D34), oldest first. */
  async get(hash: string): Promise<ConfigDetail> {
    const row = await this.row(hash);
    const children = await this.db.query<{ hash: string; name: string; created_at: Date }>(
      'SELECT hash, name, created_at FROM configs WHERE parent_hash = $1 ORDER BY created_at, hash',
      [row.hash],
    );
    return { ...configView(row), children: children.map((c) => ({ hash: c.hash, name: c.name, created_at: c.created_at.toISOString() })) };
  }

  async diff(a: string, b: string): Promise<ConfigDiffEntry[]> {
    const strip = (view: ConfigView): Partial<ConfigView> => {
      const rest: Partial<ConfigView> = { ...view };
      for (const key of NOT_DIFFED) delete rest[key];
      return rest;
    };
    return diffValues(strip(configView(await this.row(a))), strip(configView(await this.row(b))));
  }
}
