import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Pool } from 'pg';
import { MIGRATIONS_DIR, migrate, readMigrations } from '../src/database/migrate';
import { type TestDatabase, createDatabase, describeWithDb } from './support/db';

describeWithDb('migrations (real Postgres)', () => {
  let db: TestDatabase;
  let pool: Pool;
  let dir: string;

  beforeEach(async () => {
    db = await createDatabase();
    pool = new Pool({ connectionString: db.url });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-migrations-'));
  });

  afterEach(async () => {
    await pool.end();
    await db.drop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const tables = async (): Promise<string[]> =>
    (await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);

  it('brings a fresh database to the latest version, then does nothing on a second run', async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(await migrate(pool)).toEqual(all);
    expect(await tables()).toEqual(
      expect.arrayContaining(['configs', 'experiments', 'grades', 'labels', 'prompts', 'schema_migrations', 'sim_replies', 'spans', 'tasks', 'toolsets', 'trials']),
    );
    expect(await migrate(pool)).toEqual([]);
  });

  it('brings an existing database at an older version up to the latest', async () => {
    await fs.writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE a (id int);');
    expect(await migrate(pool, dir)).toEqual(['001_first']);
    await fs.writeFile(path.join(dir, '002_second.sql'), 'CREATE TABLE b (id int);');
    expect(await migrate(pool, dir)).toEqual(['002_second']);
    expect(await tables()).toEqual(['a', 'b', 'schema_migrations']);
  });

  it('refuses an applied migration that has since changed', async () => {
    await fs.writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE a (id int);');
    await migrate(pool, dir);
    await fs.writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE a (id bigint);');
    await expect(migrate(pool, dir)).rejects.toThrow('changed after it was applied');
  });

  it('rolls back a failing migration and leaves it unapplied', async () => {
    await fs.writeFile(path.join(dir, '001_bad.sql'), 'CREATE TABLE ok (id int); SELECT nope FROM missing;');
    await expect(migrate(pool, dir)).rejects.toThrow('001_bad failed');
    expect(await tables()).toEqual(['schema_migrations']);
  });

  it('runs safely when two processes migrate at once', async () => {
    const other = new Pool({ connectionString: db.url });
    try {
      const [a, b] = await Promise.all([migrate(pool), migrate(other)]);
      expect([...a, ...b].sort()).toEqual((await readMigrations(MIGRATIONS_DIR)).map((m) => m.version));
    } finally {
      await other.end();
    }
  });
});
