import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Pool } from 'pg';
import { sha256Hex } from '../common/hashing';

/** apps/api/migrations, from both src/database and dist/database. */
export const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

const NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;
/** Any fixed number; held while migrating so two API processes never migrate at once. */
const LOCK_KEY = 74_201_105;

export interface Migration {
  version: string;
  sha256: string;
  sql: string;
}

export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const seen = new Set<string>();
  const out: Migration[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) throw new Error(`migration file ${name} must be named NNN_words.sql`);
    if (seen.has(m[1])) throw new Error(`two migrations are numbered ${m[1]}`);
    seen.add(m[1]);
    const sql = await fs.readFile(path.join(dir, name), 'utf8');
    out.push({ version: name.replace(/\.sql$/, ''), sha256: sha256Hex(sql), sql });
  }
  return out;
}

/**
 * Applies every migration not yet in `schema_migrations`, in file order, each in its own
 * transaction. A fresh database and an existing one both end at the latest version. An applied
 * file that has since changed is refused: migrations are append-only.
 * Returns the versions applied by this call.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await readMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.sha256]));
    const done: string[] = [];
    for (const m of migrations) {
      const prior = applied.get(m.version);
      if (prior !== undefined) {
        if (prior !== m.sha256) {
          throw new Error(`migration ${m.version} changed after it was applied; add a new migration instead`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)', [m.version, m.sha256]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.version} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      done.push(m.version);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
