import { Inject, Injectable } from '@nestjs/common';
import type { HarnessView, JsonObject, ModelView, PromptView, TaskSplit, TaskView, ToolsetView } from '../contract';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { Db } from '../database/db.service';
import { LiteLlmClient } from '../litellm/litellm.client';
import { type HarnessFile, type TaskFile, builtInToolsets, loadFinanceServer, readHarnesses, readPrompts, readTasks } from './catalogue-files';

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
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly litellm: LiteLlmClient,
  ) {}

  harnesses(): Promise<HarnessFile[]> {
    return readHarnesses(this.config.workersDir);
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
    const tasks = await readTasks(this.config.tasksDir);
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

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
