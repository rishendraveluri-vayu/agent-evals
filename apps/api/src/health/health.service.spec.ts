import { Logger } from '@nestjs/common';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DB_CHECK_TIMEOUT_MS, HealthService } from './health.service';

/** A stand-in for pg.Pool whose `query` is a plain mock property, so tests can assert on it. */
function fakePool(query: (sql: string) => Promise<unknown>): {
  query: jest.Mock<Promise<unknown>, [string]>;
} {
  return { query: jest.fn(query) };
}

/** As root every folder is writable, so the not-writable cases only mean something as another user. */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('HealthService', () => {
  let root: string;
  let folders: { runsDir: string; labelsDir: string; configsDir: string };

  beforeEach(() => {
    // The service logs a warning on every failed check; keep test output clean.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    root = mkdtempSync(path.join(tmpdir(), 'evals-health-'));
    folders = { runsDir: path.join(root, 'runs'), labelsDir: path.join(root, 'labels'), configsDir: path.join(root, 'configs') };
    for (const dir of [folders.runsDir, folders.labelsDir, path.join(folders.configsDir, 'prompts')]) mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    chmodSync(folders.runsDir, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it('reports not_configured when there is no pool', async () => {
    await expect(new HealthService(null, folders).check()).resolves.toEqual({
      status: 'ok',
      db: 'not_configured',
      files: 'writable',
    });
  });

  it('reports up when SELECT 1 succeeds', async () => {
    const pool = fakePool(() => Promise.resolve({ rows: [{ '?column?': 1 }] }));

    await expect(new HealthService(pool, folders).check()).resolves.toEqual({ status: 'ok', db: 'up', files: 'writable' });
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('reports down when the query fails', async () => {
    const pool = fakePool(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')));

    await expect(new HealthService(pool, folders).check()).resolves.toEqual({ status: 'ok', db: 'down', files: 'writable' });
  });

  it('reports down when the query takes longer than the timeout', async () => {
    jest.useFakeTimers();
    const pool = fakePool(() => new Promise(() => undefined)); // never settles

    const result = new HealthService(pool, folders).check();
    await jest.advanceTimersByTimeAsync(DB_CHECK_TIMEOUT_MS);

    await expect(result).resolves.toEqual({ status: 'ok', db: 'down', files: 'writable' });
  });

  it('still reports up when the reply lands just inside the timeout', async () => {
    jest.useFakeTimers();
    const pool = fakePool(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ rows: [] }), DB_CHECK_TIMEOUT_MS - 1);
        }),
    );

    const result = new HealthService(pool, folders).check();
    await jest.advanceTimersByTimeAsync(DB_CHECK_TIMEOUT_MS);

    await expect(result).resolves.toEqual({ status: 'ok', db: 'up', files: 'writable' });
  });

  it('counts a folder that does not exist yet as writable when the API can create it', async () => {
    rmSync(folders.labelsDir, { recursive: true });

    await expect(new HealthService(null, folders).check()).resolves.toMatchObject({ files: 'writable' });
  });

  (asRoot ? it.skip : it)('reports not_writable, naming the folder in plain words, and logs it once until it is fixed', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    chmodSync(folders.runsDir, 0o555);
    const service = new HealthService(null, folders);

    await service.onApplicationBootstrap();
    const report = await service.check();

    expect(report).toMatchObject({ status: 'ok', db: 'not_configured', files: 'not_writable' });
    expect(report.files_problem).toContain(`runs/ (trial files; here ${folders.runsDir})`);
    expect(report.files_problem).not.toContain('labels/');
    expect(report.files_problem).toContain('docker compose logs api');
    // Logged at start-up, and not again on the next check while nothing changed.
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe(report.files_problem);

    chmodSync(folders.runsDir, 0o755);
    await expect(service.check()).resolves.toEqual({ status: 'ok', db: 'not_configured', files: 'writable' });
    expect(log).toHaveBeenCalledWith('every folder the API writes is writable again');
  });
});
