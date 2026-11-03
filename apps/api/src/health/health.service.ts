import { Inject, Injectable, Logger } from '@nestjs/common';
import { PG_POOL } from '../database/pg-pool';

/** How long the `SELECT 1` probe may take before the database counts as down. */
export const DB_CHECK_TIMEOUT_MS = 2000;

export type DbState = 'up' | 'down' | 'not_configured';

export interface HealthReport {
  status: 'ok';
  db: DbState;
}

/** The only part of `pg.Pool` the health check needs; keeps the service easy to fake in tests. */
export interface SqlProbe {
  query(sql: string): Promise<unknown>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@Inject(PG_POOL) private readonly pool: SqlProbe | null) {}

  async check(): Promise<HealthReport> {
    return { status: 'ok', db: await this.checkDb() };
  }

  private async checkDb(): Promise<DbState> {
    if (this.pool === null) {
      return 'not_configured';
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`no reply within ${DB_CHECK_TIMEOUT_MS} ms`));
      }, DB_CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.pool.query('SELECT 1'), timeout]);
      return 'up';
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`database check failed: ${reason}`);
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
