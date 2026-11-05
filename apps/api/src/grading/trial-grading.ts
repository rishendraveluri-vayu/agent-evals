import type { Grade, GradeKind, GradeVerdict, GradingJobStatus, GradingOutcome, Json, TrialGrading, TrialGradingJob } from '../contract';
import type { Db } from '../database/db.service';
import { JUDGE_MODEL_SQL } from './grading-core';

interface JobRow {
  id: string;
  status: GradingJobStatus;
  reason: 'trial_done' | 'regrade';
  grader_source: 'catalogue' | 'trial_task';
  source_note: string | null;
  task_sha256: string;
  framework_version: string | null;
  passed: boolean | null;
  outcome: GradingOutcome | null;
  error: string | null;
  created_at: Date;
  reported_at: Date | null;
  grade_ids: string[];
}

interface GradeRow {
  id: number;
  grader_id: string;
  grader_version: string;
  kind: GradeKind;
  type: string | null;
  required: boolean;
  verdict: GradeVerdict | null;
  score: number | null;
  reason: string | null;
  evidence: Json;
  judge_model: string | null;
  run_index: number;
  created_at: Date;
}

const FINISHED: GradingJobStatus[] = ['done', 'no_graders'];

function view(j: JobRow): TrialGradingJob {
  return {
    job_id: j.id,
    status: j.status,
    reason: j.reason,
    grader_source: j.grader_source,
    source_note: j.source_note,
    task_sha256: j.task_sha256,
    framework_version: j.framework_version,
    passed: j.passed,
    outcome: j.outcome,
    error: j.error,
    queued_at: j.created_at.toISOString(),
    graded_at: j.reported_at ? j.reported_at.toISOString() : null,
  };
}

/**
 * A trial's grades for GET /trials/:id: those of its latest finished grading job (by queue
 * order), plus any newer job still on its way (queued, claimed, or failed).
 */
export async function trialGrading(db: Db, trialId: string): Promise<{ grades: Grade[]; grading: TrialGrading }> {
  const jobs = await db.query<JobRow>(
    `SELECT id, status, reason, grader_source, source_note, task_sha256, framework_version, passed, outcome, error,
            created_at, reported_at, grade_ids::text[] AS grade_ids
     FROM grading_jobs WHERE trial_id = $1 ORDER BY created_at DESC, id DESC`,
    [trialId],
  );
  const currentAt = jobs.findIndex((j) => FINISHED.includes(j.status));
  const current = currentAt === -1 ? null : jobs[currentAt];
  const newer = currentAt === -1 ? jobs : jobs.slice(0, currentAt);
  const pending = newer.find((j) => j.status !== 'superseded') ?? null;
  let grades: Grade[] = [];
  if (current && current.grade_ids.length) {
    const rows = await db.query<GradeRow>(
      `SELECT g.id::int AS id, g.grader_id, g.grader_version, g.kind, g.type, g.required, g.verdict, g.score, g.reason, g.evidence,
              ${JUDGE_MODEL_SQL('g')} AS judge_model, g.run_index, g.created_at
       FROM grades g WHERE g.id = ANY($1::bigint[])`,
      [current.grade_ids],
    );
    const order = new Map(current.grade_ids.map((id, i) => [Number(id), i]));
    grades = rows
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((g) => ({ ...g, created_at: g.created_at.toISOString() }));
  }
  return { grades, grading: { current: current ? view(current) : null, pending: pending ? view(pending) : null } };
}
