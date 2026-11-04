import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

/**
 * The e2e tests that need Postgres run against TEST_DATABASE_URL: a throwaway server, never the
 * compose one. Each test file gets its own fresh database on it, dropped at the end. Start one:
 *
 *   docker run --rm -d --name evals-api-test -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=x postgres:17
 *   TEST_DATABASE_URL=postgresql://postgres:x@127.0.0.1:55432/postgres pnpm test
 *
 * Without it these suites are skipped, and say so.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const describeWithDb: jest.Describe = TEST_DATABASE_URL ? describe : describe.skip;

if (!TEST_DATABASE_URL) {
  console.warn('TEST_DATABASE_URL is not set: the database e2e suites are SKIPPED, not passed.');
}

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

export async function createDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `evals_test_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const a = new Client({ connectionString: TEST_DATABASE_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
