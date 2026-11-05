import { Inject, Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CreatePromptRequest, CreatedPrompt, HarnessView, JsonObject, ModelView, PromptView, TaskSplit, TaskView, ToolsetView } from '../contract';
import { type ApiError, badRequest, conflict } from '../common/api-error';
import { APP_CONFIG, type AppConfig, PROVIDER_KEYS, type ProviderKeyName } from '../common/app-config';
import { sha256Ref } from '../common/hashing';
import { Db } from '../database/db.service';
import { LiteLlmClient } from '../litellm/litellm.client';
import {
  type HarnessFile,
  PROMPT_MAX_BYTES,
  PROMPT_NAME_PART,
  SCAFFOLD_PLACEHOLDER,
  type TaskFile,
  builtInToolsets,
  loadFinanceServer,
  nextPromptVersion,
  promptFile,
  promptText,
  readHarnesses,
  readPrompts,
  readTasks,
} from './catalogue-files';

/** A task as stored: the row the engine builds specs from. */
export interface StoredTask {
  sha256: string;
  id: string;
  version: string;
  split: TaskSplit;
  kind: string;
  summary: string;
  body: JsonObject;
  client_state_name: string | null;
  client_state: Buffer | null;
  client_state_sha256: string | null;
  source_path: string;
}

export interface StoredPrompt {
  sha256: string;
  id: string;
  version: string;
  text: string;
  path: string;
}

export interface StoredToolset {
  sha256: string;
  id: string;
  version: string;
  servers: { name: string; allowed_tools: string[] }[];
  /** Null for a toolset stored before 4 Nov, whose hash covered the tool names only. */
  manifest: JsonObject[] | null;
}

export function taskView(t: StoredTask, problems: string[] = []): TaskView {
  const graders = Array.isArray(t.body.graders) ? t.body.graders : [];
  return { sha256: t.sha256, id: t.id, version: t.version, split: t.split, kind: t.kind, summary: t.summary, graders, problems };
}

/**
 * The catalogue: files in git are the source (docs/api-contract.md). Every read also stores
 * what it saw, content-addressed, so a config or experiment made from it keeps pointing at the
 * exact content even after the file changes.
 */
@Injectable()
export class CatalogueService {
  /** POST /prompts runs one at a time, so two posts of one text cannot make two versions. */
  private promptWrites: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly litellm: LiteLlmClient,
  ) {}

  /** Every harness folder under workers/, a scaffolded one (`make new-harness`, not finished) included. */
  allHarnesses(): Promise<HarnessFile[]> {
    return readHarnesses(this.config.workersDir);
  }

  /**
   * The harnesses a config can use, and GET /harnesses' list: a scaffolded one is left out, since
   * no worker runs it yet (POST /configs says so by name: harnessNotImplemented).
   */
  async harnesses(): Promise<HarnessFile[]> {
    return (await this.allHarnesses()).filter((h) => !h.scaffolded);
  }

  async harness(name: string): Promise<HarnessFile | null> {
    return (await this.harnesses()).find((h) => h.name === name) ?? null;
  }

  async listHarnesses(): Promise<HarnessView[]> {
    return (await this.harnesses()).map((h) => ({
      name: h.name,
      package: h.package,
      ref: h.ref,
      python: h.python,
      adapter_version: h.adapter_version,
      capabilities_sha256: h.capabilities_sha256,
      capabilities: h.capabilities,
    }));
  }

  async prompts(): Promise<PromptView[]> {
    const prompts = await readPrompts(this.config.configsDir);
    if (this.db.configured) {
      for (const p of prompts) {
        await this.db.query(
          `INSERT INTO prompts (sha256, id, version, text, path) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sha256) DO NOTHING`,
          [p.sha256, p.id, p.version, p.text, p.path],
        );
      }
    }
    return prompts;
  }

  /**
   * Writes the next version of an existing prompt (configs/prompts/<id>.v<n>.md), never over a
   * file that exists. The same text as a version of that id returns that version instead.
   */
  createPrompt(body: CreatePromptRequest, now: Date = new Date()): Promise<{ prompt: CreatedPrompt; created: boolean }> {
    const run = this.promptWrites.then(() => this.writePrompt(body, now));
    this.promptWrites = run.catch(() => undefined);
    return run;
  }

  private async writePrompt(body: CreatePromptRequest, now: Date): Promise<{ prompt: CreatedPrompt; created: boolean }> {
    if (typeof body !== 'object' || body === null) throw badRequest('invalid_prompt', 'the body must be a JSON object', 'Send {"id", "base_version", "text"}.');
    const { id, base_version: baseVersion, text } = body;
    const pick = 'Use the id and a version of a prompt in GET /prompts.';
    if (typeof id !== 'string' || !PROMPT_NAME_PART.test(id)) throw badRequest('invalid_prompt', 'id must be a prompt id: letters, digits, _ and -', pick);
    if (typeof baseVersion !== 'string' || !PROMPT_NAME_PART.test(baseVersion)) {
      throw badRequest('invalid_prompt', 'base_version must be a prompt version such as v1', pick);
    }
    if (typeof text !== 'string' || !text.trim()) throw badRequest('invalid_prompt', 'text must be a non-empty string', 'Send the prompt text, without a review header.');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > PROMPT_MAX_BYTES) {
      throw badRequest('prompt_too_large', `text is ${bytes} bytes; a prompt may be at most ${PROMPT_MAX_BYTES} bytes (50 KB)`, 'Shorten the prompt to 50 KB or less.');
    }

    const all = await readPrompts(this.config.configsDir);
    const versions = all.filter((p) => p.id === id);
    if (!versions.length) {
      const ids = [...new Set(all.map((p) => p.id))];
      throw badRequest('unknown_prompt_id', `no prompt named ${id} under configs/prompts`, `A new version needs an existing prompt: pick one of ${ids.join(', ')}.`);
    }
    if (!versions.some((p) => p.version === baseVersion)) {
      throw badRequest('unknown_base_version', `${id} has no version ${baseVersion}`, `Pick a version of ${id}: ${versions.map((p) => p.version).join(', ')}.`);
    }

    const version = nextPromptVersion(versions.map((p) => p.version));
    const content = promptFile(id, version, baseVersion, text, now);
    const sha256 = sha256Ref(promptText(content));
    const same = versions.find((p) => p.sha256 === sha256) ?? all.find((p) => p.sha256 === sha256);
    if (same && same.id === id) return { prompt: { id, version: same.version, sha256, path: same.path }, created: false };
    if (same) {
      // The prompts table is keyed by text hash, so one text cannot belong to two ids.
      throw conflict('prompt_text_exists', `this text is already prompt ${same.id} ${same.version}`, `Use ${same.id} ${same.version}, or change the text.`);
    }

    const dir = path.resolve(this.config.configsDir, 'prompts');
    const name = `${id}.${version}.md`;
    const file = path.resolve(dir, name);
    if (path.dirname(file) !== dir) throw badRequest('invalid_prompt', `${name} is not a file name in configs/prompts`, pick);
    try {
      // `wx`: fail rather than replace a file that exists.
      await fs.writeFile(file, content, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw conflict('prompt_version_exists', `configs/prompts/${name} already exists`, 'Post again: the next version number will be used.');
      }
      throw err;
    }
    await this.prompts(); // store the new version, so a config can point at it straight away
    return { prompt: { id, version, sha256, path: `configs/prompts/${name}` }, created: true };
  }

  async toolsets(): Promise<ToolsetView[]> {
    const toolsets = builtInToolsets(loadFinanceServer(this.config.financeMcpDir));
    if (this.db.configured) {
      for (const t of toolsets) {
        await this.db.query(
          `INSERT INTO toolsets (sha256, id, version, servers, manifest) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sha256) DO NOTHING`,
          [t.sha256, t.id, t.version, JSON.stringify(t.servers), JSON.stringify(t.manifest)],
        );
      }
    }
    return toolsets;
  }

  /** Every task file, stored when valid. A stored task whose state file changed is flagged. */
  async taskFiles(): Promise<TaskFile[]> {
    const tasks = await readTasks(this.config.tasksDir, this.config.graderSchemaFile);
    if (!this.db.configured) return tasks;
    for (const t of tasks) {
      if (t.problems.length) continue;
      await this.db.query(
        `INSERT INTO tasks (sha256, id, version, split, kind, summary, body, client_state_name, client_state,
                            client_state_sha256, source_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (sha256) DO NOTHING`,
        [t.sha256, t.id, t.version, t.split, t.kind, t.summary, JSON.stringify(t.body), t.clientStateName, t.clientState, t.clientStateSha256, t.sourcePath],
      );
      const [stored] = await this.db.query<{ client_state_sha256: string | null }>(
        'SELECT client_state_sha256 FROM tasks WHERE sha256 = $1',
        [t.sha256],
      );
      if (stored && stored.client_state_sha256 !== t.clientStateSha256) {
        t.problems.push(
          `${t.clientStateName ?? 'client_state'} changed after this task.json was first stored; ` +
            'edit task.json (for example its version) so the change is a new task version',
        );
      }
    }
    return tasks;
  }

  async listTasks(): Promise<TaskView[]> {
    return (await this.taskFiles()).map((t) => ({
      sha256: t.sha256,
      id: t.id,
      version: t.version,
      split: t.split,
      kind: t.kind,
      summary: t.summary,
      graders: t.graders,
      problems: t.problems,
    }));
  }

  /** Real models only: no fake/ routes and no wildcards. */
  async listModels(): Promise<ModelView[]> {
    const rows = await this.litellm.models();
    return rows
      .filter((m) => m.name && !m.name.includes('*') && !m.name.startsWith('fake/'))
      .map((m) => ({
        name: m.name,
        provider: m.provider,
        input_per_mtok: m.inputPerToken === null ? null : round(m.inputPerToken * 1e6),
        output_per_mtok: m.outputPerToken === null ? null : round(m.outputPerToken * 1e6),
        key_set: keySet(m.name, m.provider, this.config.providerKeys),
      }));
  }

  // ---- stored rows, after a sync from files ----

  async prompt(sha256: string): Promise<StoredPrompt | null> {
    await this.prompts();
    const rows = await this.db.query<StoredPrompt>('SELECT sha256, id, version, text, path FROM prompts WHERE sha256 = $1', [sha256]);
    return rows[0] ?? null;
  }

  /** The highest version of a prompt id, as stored now. */
  async latestPrompt(id: string): Promise<StoredPrompt | null> {
    const prompts = (await this.prompts()).filter((p) => p.id === id);
    const last = prompts[prompts.length - 1];
    return last ? this.prompt(last.sha256) : null;
  }

  async toolset(sha256: string): Promise<StoredToolset | null> {
    await this.toolsets();
    const rows = await this.db.query<StoredToolset>('SELECT sha256, id, version, servers, manifest FROM toolsets WHERE sha256 = $1', [sha256]);
    return rows[0] ?? null;
  }

  /** Stored tasks by hash, after syncing from files. Missing hashes are left out. */
  async tasksBySha(shas: string[]): Promise<{ tasks: StoredTask[]; problems: Map<string, string[]> }> {
    const files = await this.taskFiles();
    const problems = new Map(files.filter((f) => f.problems.length).map((f) => [f.sha256, f.problems]));
    const tasks = await this.db.query<StoredTask>(
      `SELECT sha256, id, version, split, kind, summary, body, client_state_name, client_state, client_state_sha256, source_path
       FROM tasks WHERE sha256 = ANY($1)`,
      [shas],
    );
    return { tasks, problems };
  }
}

/**
 * POST /configs' refusal for a harness `make new-harness` made and nobody finished: its
 * capabilities still say version TODO, its adapter is a stub and no worker would claim its trials.
 */
export function harnessNotImplemented(h: Pick<HarnessFile, 'name' | 'dir' | 'capabilitiesPath'>, available: string[]): ApiError {
  return badRequest(
    'harness_not_implemented',
    `harness ${h.name} is scaffolded but not implemented: ${h.capabilitiesPath} still has the scaffold's version "${SCAFFOLD_PLACEHOLDER}", so no worker would run its trials`,
    `Finish it first (${h.dir}/README.md): write setup and run_turn, run probe.sh, set version.package and version.ref in its capabilities.json, ` +
      `and add its worker to docker-compose.yml. Until then pick a harness from GET /harnesses: ${available.join(', ')}.`,
  );
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** LiteLLM's provider names for the providers the API is told about (PROVIDER_KEYS). */
const PROVIDER_OF: Record<string, ProviderKeyName> = { anthropic: 'anthropic', gemini: 'gemini', vertex_ai: 'gemini' };

/**
 * Whether the key a model needs is set for LiteLLM: the flag compose passes for its provider. null
 * for a fake model (no key), a provider the API is told nothing about, or when it was not told.
 */
export function keySet(model: string, provider: string | null, keys: AppConfig['providerKeys']): boolean | null {
  if (model.startsWith('fake/')) return null;
  const name = provider ? PROVIDER_OF[provider] : undefined;
  return name ? keys[name] : null;
}

/**
 * The .env variable a model's provider key comes from, when the API knows that key is not set
 * (`keySet` is false): "ANTHROPIC_API_KEY". Null when it is set, when the model needs none (a fake
 * one), or when the API was not told.
 */
export function missingKeyVar(model: string, provider: string | null, keys: AppConfig['providerKeys']): string | null {
  if (keySet(model, provider, keys) !== false) return null;
  const name = provider ? PROVIDER_OF[provider] : undefined;
  return name ? PROVIDER_KEYS[name].key : null;
}
