import { Pool } from 'pg';
import { DatabaseModule } from './database.module';
import { createPool } from './pg-pool';

describe('createPool', () => {
  it.each([undefined, ''])('returns null when DATABASE_URL is %p', (url) => {
    expect(createPool(url)).toBeNull();
  });

  it('builds a pool without connecting when a URL is given', async () => {
    const pool = createPool('postgresql://evals:evals@127.0.0.1:1/evals');

    expect(pool).toBeInstanceOf(Pool);
    expect(pool?.totalCount).toBe(0);
    await pool?.end();
  });
});

describe('DatabaseModule', () => {
  it('closes the pool on application shutdown', async () => {
    const pool = { end: jest.fn(() => Promise.resolve()) };

    await new DatabaseModule(pool as unknown as Pool).onApplicationShutdown();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('shuts down cleanly when no pool was configured', async () => {
    await expect(new DatabaseModule(null).onApplicationShutdown()).resolves.toBeUndefined();
  });
});
