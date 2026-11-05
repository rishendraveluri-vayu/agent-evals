import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PG_POOL } from '../../src/database/pg-pool';
import { WorkerService } from '../../src/worker/worker.service';
import { type TestDatabase, createDatabase } from './db';
import { LiteLlmStub, STUB_MASTER_KEY } from './litellm-stub';

export const REPO = path.resolve(__dirname, '../../../..');
export const WORKER_TOKEN = 'test-worker-token';

/** Synthetic tasks for the engine tests (not part of the task set; SP4 writes those). */
export const TASKS = {
  'emi-basic': {
    task: {
      id: 'emi-basic',
      version: '1',
      split: 'discovery',
      summary: 'EMI on a home loan (test fixture)',
      messages: [{ role: 'user', content: 'What is my EMI on Rs 10 lakh at 9% for 20 years?' }],
      client_sim: null,
      client_state: 'client.json',
      graders: [
        { id: 'emi-exact', kind: 'exact' },
        { id: 'tone', kind: 'judge', criteria: [{ id: 'empathy', text: 'Acknowledges the client situation' }, 'no_jargon'] },
      ],
    },
    state: '{"name": "Test Client (synthetic)"}',
  },
  'widow-loan': {
    task: {
      id: 'widow-loan',
      version: '1',
      split: 'held_out',
      messages: [{ role: 'user', content: 'I do not know where to start.' }],
      client_sim: {
        persona: 'Synthetic test persona, not a task',
        hidden_facts: ['Take-home Rs 92,000'],
        concerns: ['Can I keep the house?'],
        goal: 'Know whether she can keep the house',
        opening_message: 'I do not know where to start.',
        max_client_turns: 3,
      },
      client_state: 'client.json',
      graders: [],
    },
    // Synthetic: an invented client file, so the simulator gets a client summary (D27).
    state: JSON.stringify({
      schema_version: 1,
      synthetic: true,
      profile: { name: 'Test Widow (synthetic)', city: 'Pune', monthly_net_income: 92000 },
      debts: [{ name: 'Home loan', kind: 'home_loan', balance: 1800000, annual_rate_pct: 8.5, minimum_payment: 16200, remaining_months: 180 }],
    }),
  },
} as const;

export interface TestEnv {
  app: INestApplication<App>;
  http: App;
  stub: LiteLlmStub;
  db: TestDatabase;
  pool: Pool;
  worker: WorkerService;
  tasksDir: string;
  /** A copy of the repo's configs/, so POST /prompts never writes into the repo. */
  configsDir: string;
  labelsDir: string;
  runsDir: string;
  close(): Promise<void>;
}

async function writeTasks(dir: string): Promise<void> {
  for (const [name, { task, state }] of Object.entries(TASKS)) {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'task.json'), JSON.stringify(task, null, 2));
    if (state) await fs.writeFile(path.join(dir, name, 'client.json'), state);
  }
}

/**
 * Boots the real AppModule against a fresh database, the LiteLLM stub and temp folders.
 * `workersDir` replaces the repo's workers/ (a test that needs a harness the repo does not have).
 */
export async function bootEnv(opts: { workersDir?: string } = {}): Promise<TestEnv> {
  const db = await createDatabase();
  const stub = new LiteLlmStub();
  await stub.start();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-api-e2e-'));
  const tasksDir = path.join(tmp, 'tasks');
  const labelsDir = path.join(tmp, 'labels');
  const runsDir = path.join(tmp, 'runs');
  const configsDir = path.join(tmp, 'configs');
  await writeTasks(tasksDir);
  await fs.cp(path.join(REPO, 'configs'), configsDir, { recursive: true });
  await fs.mkdir(runsDir, { recursive: true });
  Object.assign(process.env, {
    DATABASE_URL: db.url,
    LITELLM_URL: stub.url,
    LITELLM_MASTER_KEY: STUB_MASTER_KEY,
    EVALS_WORKER_TOKEN: WORKER_TOKEN,
    EVALS_PLATFORM_COMMIT: 'abc1234',
    WORKERS_DIR: opts.workersDir ?? path.join(REPO, 'workers'),
    CONFIGS_DIR: configsDir,
    TASKS_DIR: tasksDir,
    LABELS_DIR: labelsDir,
    RUNS_DIR: runsDir,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
  configureApp(app);
  // Listen once, so concurrent supertest calls share one server instead of each starting it.
  await app.listen(0, '127.0.0.1');
  return {
    app,
    http: app.getHttpServer(),
    stub,
    db,
    pool: app.get<Pool>(PG_POOL),
    worker: app.get(WorkerService),
    tasksDir,
    configsDir,
    labelsDir,
    runsDir,
    close: async () => {
      await app.close();
      await stub.stop();
      await db.drop();
      await fs.rm(tmp, { recursive: true, force: true });
      for (const k of ['DATABASE_URL', 'LITELLM_URL', 'LITELLM_MASTER_KEY', 'EVALS_WORKER_TOKEN', 'EVALS_PLATFORM_COMMIT', 'WORKERS_DIR', 'CONFIGS_DIR', 'TASKS_DIR', 'LABELS_DIR', 'RUNS_DIR']) {
        delete process.env[k];
      }
    },
  };
}

export const auth = { Authorization: `Bearer ${WORKER_TOKEN}` };

interface Catalogue {
  prompt: string;
  toolset: string;
  tasks: Record<string, string>;
}

export async function catalogue(http: App): Promise<Catalogue> {
  const prompts = (await request(http).get('/api/prompts').expect(200)).body as { id: string; sha256: string }[];
  const toolsets = (await request(http).get('/api/toolsets').expect(200)).body as { sha256: string }[];
  const tasks = (await request(http).get('/api/tasks').expect(200)).body as { id: string; sha256: string }[];
  return {
    prompt: prompts.find((p) => p.id === 'finance-advisor')!.sha256,
    toolset: toolsets[0].sha256,
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t.sha256])),
  };
}

/** POSTs a config and returns its hash. */
export async function makeConfig(http: App, cat: Catalogue, over: Record<string, unknown> = {}): Promise<string> {
  const res = await request(http)
    .post('/api/configs')
    .send({ name: 'test config', harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset, settings: {}, ...over });
  if (res.status !== 201 && res.status !== 200) throw new Error(`config: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { hash: string }).hash;
}

/** A runner report as the Python runner writes it, for this trial and label. */
export function runnerReport(trialId: string, attempt: number, label: string, files: { path: string; bytes: number; sha256: string }[] = []): Record<string, unknown> {
  const log = { path: 'stdout.log', bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', truncated: false };
  return {
    contract_version: '2',
    trial_id: trialId,
    attempt,
    harness: 'ownloop',
    label,
    end_state: label === 'agent' ? 'answered' : 'harness_error',
    adapter: { exit_code: 0, signal: null, result_valid: true, result_errors: [], trace_valid: true, trace_errors: [], leftover_processes: 0 },
    proxy_usage: { complete: true, model_calls: 2, failed_calls: 0, input_tokens: 1200, output_tokens: 80, cost_usd: 0.00136, last_status: label === 'agent' ? '200' : '429' },
    logs: { stdout: log, stderr: { ...log, path: 'stderr.log' } },
    files,
    timing: { started_at: '2026-11-04T10:00:00.000Z', ended_at: '2026-11-04T10:00:12.500Z', wall_s: 12.5, safety_net_s: 480 },
  };
}
