import { Inject, Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  GraderClaimResponse,
  GradesReportResponse,
  GradingJobStatus,
  GradingOutcome,
  Json,
  JsonObject,
  RegradeResponse,
  StoredFile,
} from '../contract';
import { badRequest, conflict, notFound } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { canonicalJson } from '../common/hashing';
import { newId } from '../common/ids';
import { type TaskFile, readTasks } from '../catalogue/catalogue-files';
import { Db, type Queryable } from '../database/db.service';
import {
  GRADING_LEASE_S,
  type GraderEntry,
  type GraderFile,
  MAX_GRADER_FILE_BYTES,
  MAX_GRADING_CLAIMS,
  RUBRIC_PATH,
  graderSet,
  outcomeOf,
  parseGradesReport,
  taskCoreSha,
} from './grading-core';

/** Held while queueing jobs, so two claims never queue the same trial twice. Any fixed number. */
const QUEUE_LOCK = 74_201_407;

interface JobRow {
  id: string;
  trial_id: string;
  reason: 'trial_done' | 'regrade';
  status: GradingJobStatus;
  task_id: string;
  task_sha256: string;
  grader_source: 'catalogue' | 'trial_task';
  source_note: string | null;
  graders: GraderEntry[];
  grader_files: Record<string, GraderFile | null>;
  claims: number;
  worker_id: string | null;
  passed: boolean | null;
  outcome: GradingOutcome | null;
  grade_ids: string[];
}

interface TrialTaskRow {
  trial_id: string;
  task_sha256: string;
  task_id: string;
  body: JsonObject;
  client_state_sha256: string | null;
}

interface Choice {
  source: 'catalogue' | 'trial_task';
  taskSha256: string;
  specs: Json[];
  folder: string | null;
  note: string | null;
}

const one = async <T>(q: Queryable, sql: string, params: unknown[]): Promise<T | undefined> => ((await q.query(sql, params)).rows as T[])[0];

const specsOf = (body: JsonObject): Json[] => (Array.isArray(body.graders) ? body.graders : []);

/** A regular file of at most the grader file cap, never through a symlink; else null. */
async function readCapped(file: string): Promise<Buffer | null> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > MAX_GRADER_FILE_BYTES) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/**
 * A judge's rubric by its repo path (`configs/rubrics/<name>.md`), read from the API's configs
 * folder (CONFIGS_DIR, the repo's configs/ by default), or null. Anything that is not one file
 * directly in configs/rubrics/ is never read, whatever the path says.
 */
export async function readRubricFile(configsDir: string, repoPath: string): Promise<Buffer | null> {
  if (!RUBRIC_PATH.test(repoPath)) return null;
  const folder = path.resolve(configsDir, 'rubrics');
  const file = path.resolve(configsDir, repoPath.slice('configs/'.length));
  if (path.dirname(file) !== folder) return null;
  return readCapped(file);
}

/**
 * Grading as its own step after the trial (R14). A grading job freezes which graders grade one
 * trial; the grader worker claims it over HTTP (D2), downloads the trial's stored files, grades
 * and reports. A grader fix is a regrade (POST /experiments/:id/regrade): new jobs, new grade
 * versions next to the old ones, no trial re-run.
 */
@Injectable()
export class GradingService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
  ) {}

  // ---- which graders ----

  /**
   * The current tasks/<id>/task.json when it differs from the trial's task only in its graders
   * (so a grader fix applies to old trials), else the trial's own task: graders written for a
   * changed task are not applied to answers given to the old one.
   */
  choose(task: TrialTaskRow, catalogue: TaskFile[]): Choice {
    const core = taskCoreSha(task.body, task.client_state_sha256);
    const candidates = catalogue.filter((f) => f.id === task.task_id && !f.problems.length);
    const match = [...candidates].reverse().find((f) => taskCoreSha(f.body, f.clientStateSha256) === core);
    if (match) {
      const dir = match.sourcePath.split('/')[1];
      return {
        source: 'catalogue',
        taskSha256: match.sha256,
        specs: specsOf(match.body),
        folder: path.join(this.config.tasksDir, dir),
        note: match.sha256 === task.task_sha256 ? null : `graders from ${match.sourcePath} (version ${match.version}), which differs from the trial's task only in its graders`,
      };
    }
    const why = candidates.length
      ? `tasks/${task.task_id} changed beyond its graders since this trial ran, so the trial is graded with the graders it ran with`
      : `tasks/${task.task_id} is not in the catalogue now, so the trial is graded with the graders it ran with`;
    return { source: 'trial_task', taskSha256: task.task_sha256, specs: specsOf(task.body), folder: null, note: why };
  }

  private readGraderFile(folder: string, name: string): Promise<Buffer | null> {
    return readCapped(path.join(folder, name));
  }

  /** Inserts one job for the trial; returns its status and where its graders came from. */
  private async queueJob(q: Queryable, task: TrialTaskRow, catalogue: TaskFile[], reason: 'trial_done' | 'regrade'): Promise<{ status: GradingJobStatus; source: Choice['source'] }> {
    const choice = this.choose(task, catalogue);
    const folder = choice.folder;
    // A rubric is not part of the task, so it is read as it is now whichever task the graders come from.
    const set = await graderSet(
      choice.specs,
      folder ? (name) => this.readGraderFile(folder, name) : null,
      (repoPath) => readRubricFile(this.config.configsDir, repoPath),
    );
    const status: GradingJobStatus = set.graders.length ? 'queued' : 'no_graders';
    await q.query(
      `INSERT INTO grading_jobs (id, trial_id, reason, status, task_id, task_sha256, grader_source, source_note, graders, grader_files)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newId('g'), task.trial_id, reason, status, task.task_id, choice.taskSha256, choice.source, choice.note, JSON.stringify(set.graders), JSON.stringify(set.files)],
    );
    return { status, source: choice.source };
  }

  /** Queues a first grading job for every done trial that has none. Returns how many. */
  async queueFinishedTrials(): Promise<number> {
    const waiting = await this.db.query<{ id: string }>(
      `SELECT t.id FROM trials t
       WHERE t.status = 'done' AND NOT t.probe AND NOT EXISTS (SELECT 1 FROM grading_jobs j WHERE j.trial_id = t.id)
       LIMIT 1`,
    );
    if (!waiting.length) return 0;
    const catalogue = await readTasks(this.config.tasksDir);
    return this.db.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [QUEUE_LOCK]);
      const { rows } = await client.query<TrialTaskRow>(
        `SELECT t.id AS trial_id, t.task_sha256, k.id AS task_id, k.body, k.client_state_sha256
         FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256
         WHERE t.status = 'done' AND NOT t.probe AND NOT EXISTS (SELECT 1 FROM grading_jobs j WHERE j.trial_id = t.id)
         ORDER BY t.finished_at NULLS LAST, t.id
         LIMIT 200`,
      );
      for (const row of rows) await this.queueJob(client, row, catalogue, 'trial_done');
      return rows.length;
    });
  }

  // ---- the grader worker's protocol ----

  /** 200 with a job, or null (204) when nothing needs grading. A lapsed lease is claimable again. */
  async claim(body: unknown): Promise<GraderClaimResponse | null> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.worker_id !== 'string' || !b.worker_id) throw badRequest('invalid_claim', 'worker_id is required');
    const workerId = b.worker_id;
    await this.queueFinishedTrials();
    return this.db.tx(async (client) => {
      await client.query(
        `UPDATE grading_jobs SET status = 'failed', error = $2
         WHERE status = 'claimed' AND lease_until < now() AND claims >= $1`,
        [MAX_GRADING_CLAIMS, `the grading lease lapsed ${MAX_GRADING_CLAIMS} times without a report`],
      );
      const job = await one<JobRow>(
        client,
        `UPDATE grading_jobs SET status = 'claimed', worker_id = $1, claimed_at = now(),
                lease_until = now() + make_interval(secs => $2::double precision), claims = claims + 1
         WHERE id = (
           SELECT id FROM grading_jobs
           WHERE status = 'queued' OR (status = 'claimed' AND lease_until < now())
           ORDER BY created_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [workerId, GRADING_LEASE_S],
      );
      if (!job) return null;
      const trial = (await one<{ files: StoredFile[] | null; end_state: string | null; label: string | null }>(
        client,
        'SELECT files, end_state, label FROM trials WHERE id = $1',
        [job.trial_id],
      ))!;
      return {
        job_id: job.id,
        attempt: job.claims,
        trial_id: job.trial_id,
        lease_s: GRADING_LEASE_S,
        task: { id: job.task_id, sha256: job.task_sha256, grader_source: job.grader_source, note: job.source_note },
        graders: job.graders,
        grader_files: job.grader_files,
        trial: { files: trial.files ?? [], end_state: trial.end_state, label: trial.label },
      };
    });
  }

  /**
   * Stores a job's grades. Reporting the same job and claim twice is a no-op 200; a report from a
   * claim that lapsed and was taken by another worker is 409 claim_lost. Grades are never
   * overwritten: the same answer from the same grader version reuses its row, a different one is
   * the next run_index.
   */
  async report(trialId: string, raw: unknown): Promise<GradesReportResponse> {
    const jobId = (raw as { job_id?: unknown } | null)?.job_id;
    if (typeof jobId !== 'string' || !jobId) throw badRequest('invalid_report', 'job_id is required');
    const [job] = await this.db.query<JobRow>('SELECT * FROM grading_jobs WHERE id = $1 AND trial_id = $2', [jobId, trialId]);
    if (!job) throw notFound('unknown_job', `no grading job ${jobId} for trial ${trialId}`);
    const report = parseGradesReport(raw, job.graders);
    const same = (j: JobRow): boolean => j.worker_id === report.worker_id && j.claims === report.attempt;
    if (job.status === 'done' && same(job)) return this.duplicate(job);
    if (job.status !== 'claimed' || !same(job)) {
      throw conflict('claim_lost', `grading job ${jobId} is ${job.status} and not held by ${report.worker_id} on claim ${report.attempt}`);
    }
    const { passed, outcome } = outcomeOf(report.grades);
    const stored = await this.db.tx(async (client) => {
      const locked = (await one<JobRow>(client, 'SELECT * FROM grading_jobs WHERE id = $1 FOR UPDATE', [jobId]))!;
      if (locked.status === 'done' && same(locked)) return null;
      if (locked.status !== 'claimed' || !same(locked)) {
        throw conflict('claim_lost', `grading job ${jobId} is ${locked.status} and not held by ${report.worker_id} on claim ${report.attempt}`);
      }
      // One writer of a trial's grades at a time, so run indexes never collide.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`grades:${trialId}`]);
      const ids: string[] = [];
      let fresh = 0;
      for (const g of report.grades) {
        const { rows } = await client.query<{ id: string; verdict: string; score: number | null; reason: string | null; evidence: Json; required: boolean; run_index: number }>(
          `SELECT id::text AS id, verdict, score, reason, evidence, required, run_index FROM grades
           WHERE trial_id = $1 AND grader_id = $2 AND grader_version = $3 ORDER BY run_index`,
          [trialId, g.grader_id, g.grader_version],
        );
        const evidence = canonicalJson(g.evidence);
        const twin = rows.find(
          (r) => r.verdict === g.verdict && r.score === g.score && r.reason === g.reason && r.required === g.required && canonicalJson(r.evidence) === evidence,
        );
        if (twin) {
          ids.push(twin.id);
          continue;
        }
        const next = rows.length ? Math.max(...rows.map((r) => r.run_index)) + 1 : 0;
        const inserted = (await one<{ id: string }>(
          client,
          `INSERT INTO grades (trial_id, grader_id, grader_version, kind, type, required, verdict, score, reason, evidence,
                               spec_sha256, framework_version, job_id, run_index)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id::text AS id`,
          [trialId, g.grader_id, g.grader_version, g.kind, g.type, g.required, g.verdict, g.score, g.reason, JSON.stringify(g.evidence), g.spec_sha256, report.framework_version, jobId, next],
        ))!;
        ids.push(inserted.id);
        fresh++;
      }
      await client.query(
        `UPDATE grading_jobs SET status = 'done', reported_at = now(), framework_version = $2, passed = $3, outcome = $4,
                grade_ids = $5::bigint[], problems = $6, error = NULL
         WHERE id = $1`,
        [jobId, report.framework_version, passed, outcome, ids, JSON.stringify(report.problems)],
      );
      return { fresh, reused: ids.length - fresh };
    });
    if (!stored) return this.duplicate((await this.db.query<JobRow>('SELECT * FROM grading_jobs WHERE id = $1', [jobId]))[0]);
    return { job_id: jobId, trial_id: trialId, status: 'done', duplicate: false, passed, outcome, grades_stored: stored.fresh, grades_reused: stored.reused };
  }

  private duplicate(job: JobRow): GradesReportResponse {
    return {
      job_id: job.id,
      trial_id: job.trial_id,
      status: 'done',
      duplicate: true,
      passed: job.passed,
      outcome: job.outcome ?? 'incomplete',
      grades_stored: 0,
      grades_reused: job.grade_ids.length,
    };
  }

  // ---- re-grading ----

  /**
   * Queues a new grading job for every done trial of the experiment (or the named ones), with the
   * graders as they are now (see choose). A queued job not yet claimed is superseded; nothing is
   * re-run and no grade is deleted.
   */
  async regrade(experimentId: string, body: unknown): Promise<RegradeResponse> {
    const b = (body ?? {}) as Record<string, unknown>;
    const only = b.trial_ids;
    if (only !== undefined && (!Array.isArray(only) || !only.every((x) => typeof x === 'string'))) {
      throw badRequest('invalid_regrade', 'trial_ids must be a list of trial ids');
    }
    const [exp] = await this.db.query('SELECT 1 FROM experiments WHERE id = $1', [experimentId]);
    if (!exp) throw notFound('unknown_experiment', `no experiment ${experimentId}`);
    const catalogue = await readTasks(this.config.tasksDir);
    return this.db.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [QUEUE_LOCK]);
      const { rows } = await client.query<TrialTaskRow>(
        `SELECT t.id AS trial_id, t.task_sha256, k.id AS task_id, k.body, k.client_state_sha256
         FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256
         WHERE t.experiment_id = $1 AND t.status = 'done' AND ($2::text[] IS NULL OR t.id = ANY($2::text[]))
         ORDER BY t.seq, t.attempt`,
        [experimentId, only ?? null],
      );
      const out: RegradeResponse = { experiment_id: experimentId, trials: rows.length, queued: 0, no_graders: 0, superseded: 0, from_trial_task: 0 };
      for (const row of rows) {
        const sup = await client.query(`UPDATE grading_jobs SET status = 'superseded' WHERE trial_id = $1 AND status = 'queued'`, [row.trial_id]);
        out.superseded += sup.rowCount ?? 0;
        const { status, source } = await this.queueJob(client, row, catalogue, 'regrade');
        if (status === 'queued') out.queued++;
        else out.no_graders++;
        if (source === 'trial_task') out.from_trial_task++;
      }
      return out;
    });
  }
}
