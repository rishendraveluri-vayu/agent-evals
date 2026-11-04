import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { ApiError } from '../common/api-error';
import { migrate } from './migrate';
import { PG_POOL } from './pg-pool';

export type Queryable = Pick<PoolClient, 'query'>;

/**
 * The database for everything SP2 stores. Migrations run at startup; if the database is not
 * reachable then, they run again on the next request that needs it, so the API still starts
 * (and /health reports the database as down) instead of crashing.
 */
@Injectable()
export class Db implements OnApplicationBootstrap {
  private readonly logger = new Logger(Db.name);
  private migrated: Promise<void> | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool | null) {}

  get configured(): boolean {
    return this.pool !== null;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pool) return;
    await this.ready().catch((err: unknown) => {
      this.logger.error(`migrations not applied yet: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Resolves once the schema is at the latest migration. */
  ready(): Promise<void> {
    const pool = this.requirePool();
    if (!this.migrated) {
      this.migrated = migrate(pool).then(
        (applied) => {
          if (applied.length) this.logger.log(`applied migrations: ${applied.join(', ')}`);
        },
        (err: unknown) => {
          this.migrated = null;
          throw err;
        },
      );
    }
    return this.migrated;
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.readyOr503();
    const { rows } = await this.requirePool().query<T>(sql, params);
    return rows;
  }

  /** Runs `fn` in one transaction; rolls back if it throws. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.readyOr503();
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async readyOr503(): Promise<void> {
    try {
      await this.ready();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(503, 'db_unavailable', `the database is not ready: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private requirePool(): Pool {
    if (!this.pool) throw new ApiError(503, 'db_not_configured', 'DATABASE_URL is not set, so nothing can be stored');
    return this.pool;
  }
}
