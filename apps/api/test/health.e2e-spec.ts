import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/** Boots the real AppModule with the given DATABASE_URL (or none). */
async function bootApp(databaseUrl: string | undefined): Promise<INestApplication<App>> {
  if (databaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = databaseUrl;
  }
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

/** The folders the API writes, each its own scratch folder, so the test owns what it checks. */
const FOLDER_VARS = ['RUNS_DIR', 'LABELS_DIR', 'CONFIGS_DIR'] as const;

describe('GET /api/health (e2e)', () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalDirs = Object.fromEntries(FOLDER_VARS.map((v) => [v, process.env[v]]));
  let app: INestApplication<App> | undefined;
  let root: string;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    root = mkdtempSync(path.join(tmpdir(), 'evals-health-e2e-'));
    process.env.RUNS_DIR = path.join(root, 'runs');
    process.env.LABELS_DIR = path.join(root, 'labels');
    process.env.CONFIGS_DIR = path.join(root, 'configs');
    for (const dir of [process.env.RUNS_DIR, process.env.LABELS_DIR, path.join(process.env.CONFIGS_DIR, 'prompts')]) mkdirSync(dir, { recursive: true });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
    chmodSync(path.join(root, 'runs'), 0o755);
    rmSync(root, { recursive: true, force: true });
    for (const v of FOLDER_VARS) {
      if (originalDirs[v] === undefined) delete process.env[v];
      else process.env[v] = originalDirs[v];
    }
  });

  it('returns 200 and not_configured when DATABASE_URL is unset', async () => {
    app = await bootApp(undefined);

    const res = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'not_configured', files: 'writable' });
  });

  it('returns 503 and down when the database refuses connections', async () => {
    // Port 1 on loopback has no listener, so the connect fails at once.
    app = await bootApp('postgresql://evals:evals@127.0.0.1:1/evals');

    const res = await request(app.getHttpServer()).get('/api/health').expect(503);

    expect(res.body).toEqual({ status: 'ok', db: 'down', files: 'writable' });
  });

  // As root every folder is writable, so this only means something as another user (CI's and ours).
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  (asRoot ? it.skip : it)('returns 503 and says which folder, in plain words, when the API cannot write runs/', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    chmodSync(path.join(root, 'runs'), 0o555);
    app = await bootApp(undefined);

    const res = await request(app.getHttpServer()).get('/api/health').expect(503);

    expect(res.body).toMatchObject({ status: 'ok', db: 'not_configured', files: 'not_writable' });
    expect((res.body as { files_problem?: string }).files_problem).toMatch(/^The API cannot write to runs\/ \(trial files; here .*runs\)/);
  });

  it('serves nothing outside the api prefix', async () => {
    app = await bootApp(undefined);

    await request(app.getHttpServer()).get('/health').expect(404);
  });
});
