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

  it('005 gives experiments made before it their arms, and their trials their old claim order', async () => {
    const all = await readMigrations();
    const upTo4 = path.join(dir, 'upto4');
    await fs.mkdir(upTo4);
    for (const m of all.filter((x) => x.version < '005')) await fs.writeFile(path.join(upTo4, `${m.version}.sql`), m.sql);
    await migrate(pool, upTo4);
    const sha = (c: string): string => `sha256:${c.repeat(64)}`;
    await pool.query(`INSERT INTO prompts (sha256, id, version, text, path) VALUES ($1, 'p', 'v1', 'x', 'x')`, [sha('a')]);
    await pool.query(`INSERT INTO toolsets (sha256, id, version, servers) VALUES ($1, 't', 'all', '[]')`, [sha('b')]);
    await pool.query(
      `INSERT INTO tasks (sha256, id, version, split, kind, summary, body, source_path) VALUES ($1, 'k', '1', 'discovery', 'single_prompt', 's', '{}', 'x')`,
      [sha('c')],
    );
    for (const h of ['d', 'e']) {
      await pool.query(
        `INSERT INTO configs (hash, name, harness, harness_package, harness_ref, adapter_version, capabilities_sha256, capabilities, model,
                              api_format, prompt_sha256, toolset_sha256, settings, settings_sources, harness_options)
         VALUES ($1, $1, 'ownloop', 'p', 'r', '0', 'x', '{}', 'm', 'openai_chat', $2, $3, '{}', '{}', '{}')`,
        [sha(h), sha('a'), sha('b')],
      );
    }
    await pool.query(
      `INSERT INTO experiments (id, name, axis, config_hashes, task_sha256s, n, budget_usd, trial_budget_usd, sim_budget_usd, estimate, status)
       VALUES ('e_old', 'old', 'x', $1, $2, 1, 1, 1, 1, '{}', 'done')`,
      [[sha('d'), sha('e')], [sha('c')]],
    );
    await pool.query(
      `INSERT INTO trials (id, experiment_id, task_sha256, config_hash, repeat_index, attempt, seq, harness, status)
       VALUES ('t_1', 'e_old', $1, $2, 0, 1, 0, 'ownloop', 'done'), ('t_2', 'e_old', $1, $3, 0, 1, 1, 'ownloop', 'done')`,
      [sha('c'), sha('d'), sha('e')],
    );
    expect(await migrate(pool)).toEqual(all.filter((x) => x.version >= '005').map((m) => m.version));
    expect((await pool.query('SELECT config_hash, arm, position, paused_at FROM experiment_arms ORDER BY position')).rows).toEqual([
      { config_hash: sha('d'), arm: 'A', position: 0, paused_at: null },
      { config_hash: sha('e'), arm: 'B', position: 1, paused_at: null },
    ]);
    expect((await pool.query('SELECT id, order_index FROM trials ORDER BY id')).rows).toEqual([
      { id: 't_1', order_index: 0 },
      { id: 't_2', order_index: 1 },
    ]);
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
