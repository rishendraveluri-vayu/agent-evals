import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { PG_POOL } from '../database/pg-pool';
import { folderProblem, unwritable, writableFolders, type WritableFolder } from './folders';

/** How long the `SELECT 1` probe may take before the database counts as down. */
export const DB_CHECK_TIMEOUT_MS = 2000;

export type DbState = 'up' | 'down' | 'not_configured';

/** Whether the API can write every folder it stores things in (runs/, labels/, configs/prompts/). */
export type FilesState = 'writable' | 'not_writable';

export interface HealthReport {
  status: 'ok';
  db: DbState;
  files: FilesState;
  /** Only when `files` is not_writable: which folders, and how to put it right, in plain words. */
  files_problem?: string;
}

/** The only part of `pg.Pool` the health check needs; keeps the service easy to fake in tests. */
export interface SqlProbe {
  query(sql: string): Promise<unknown>;
}

@Injectable()
export class HealthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HealthService.name);
  private readonly folders: WritableFolder[];
  /** The last folder problem logged, so a lasting one is logged once, not every 10 s. */
  private logged: string | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: SqlProbe | null,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'runsDir' | 'labelsDir' | 'configsDir'>,
  ) {
    this.folders = writableFolders(config);
  }

  /** Says so at start-up, in the log, when a folder cannot be written. */
  async onApplicationBootstrap(): Promise<void> {
    await this.checkFiles();
  }

  async check(): Promise<HealthReport> {
    const [db, problem] = await Promise.all([this.checkDb(), this.checkFiles()]);
    return problem === null ? { status: 'ok', db, files: 'writable' } : { status: 'ok', db, files: 'not_writable', files_problem: problem };
  }

  /** The folder problem in words, or null when every folder can be written. Logs each change. */
  private async checkFiles(): Promise<string | null> {
    const bad = await unwritable(this.folders);
    const problem = bad.length ? folderProblem(bad, typeof process.getuid === 'function' ? process.getuid() : null) : null;
    if (problem !== null && problem !== this.logged) this.logger.error(problem);
    if (problem === null && this.logged !== null) this.logger.log('every folder the API writes is writable again');
    this.logged = problem;
    return problem;
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
