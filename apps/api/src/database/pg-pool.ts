import { Logger } from '@nestjs/common';
import { Pool } from 'pg';

/** Injection token for the shared Postgres pool. The value is `null` when DATABASE_URL is unset. */
export const PG_POOL = Symbol('PG_POOL');

/** Upper bound on waiting for a connection, so a dead database fails fast instead of hanging. */
export const CONNECT_TIMEOUT_MS = 2000;

/**
 * Builds a pool from a connection string, or returns `null` when none is configured.
 * `pg` connects lazily, so this never touches the network.
 */
export function createPool(databaseUrl: string | undefined): Pool | null {
  if (!databaseUrl) {
    return null;
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // An idle client that loses its connection emits 'error' on the pool.
  // Without a listener Node treats it as unhandled and the process exits.
  const logger = new Logger('PgPool');
  pool.on('error', (err) => {
    logger.error(`idle client error: ${err.message}`);
  });
  return pool;
}
