import { Logger } from '@nestjs/common';
import { DB_CHECK_TIMEOUT_MS, HealthService } from './health.service';

/** A stand-in for pg.Pool whose `query` is a plain mock property, so tests can assert on it. */
function fakePool(query: (sql: string) => Promise<unknown>): {
  query: jest.Mock<Promise<unknown>, [string]>;
} {
  return { query: jest.fn(query) };
}

describe('HealthService', () => {
  beforeEach(() => {
    // The service logs a warning on every failed check; keep test output clean.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reports not_configured when there is no pool', async () => {
    await expect(new HealthService(null).check()).resolves.toEqual({
      status: 'ok',
      db: 'not_configured',
    });
  });

  it('reports up when SELECT 1 succeeds', async () => {
    const pool = fakePool(() => Promise.resolve({ rows: [{ '?column?': 1 }] }));

    await expect(new HealthService(pool).check()).resolves.toEqual({ status: 'ok', db: 'up' });
    expect(pool.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('reports down when the query fails', async () => {
    const pool = fakePool(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')));

    await expect(new HealthService(pool).check()).resolves.toEqual({ status: 'ok', db: 'down' });
  });

  it('reports down when the query takes longer than the timeout', async () => {
    jest.useFakeTimers();
    const pool = fakePool(() => new Promise(() => undefined)); // never settles

    const result = new HealthService(pool).check();
    await jest.advanceTimersByTimeAsync(DB_CHECK_TIMEOUT_MS);

    await expect(result).resolves.toEqual({ status: 'ok', db: 'down' });
  });

  it('still reports up when the reply lands just inside the timeout', async () => {
    jest.useFakeTimers();
    const pool = fakePool(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ rows: [] }), DB_CHECK_TIMEOUT_MS - 1);
        }),
    );

    const result = new HealthService(pool).check();
    await jest.advanceTimersByTimeAsync(DB_CHECK_TIMEOUT_MS);

    await expect(result).resolves.toEqual({ status: 'ok', db: 'up' });
  });
});
