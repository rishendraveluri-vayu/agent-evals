import type { ExperimentEventKind, Json } from '../contract';
import type { Queryable } from '../database/db.service';

/**
 * The run state that can change while an experiment runs (D32, D37): stored events, experiment
 * pauses and arm pauses. Each function takes the caller's transaction, so a pause and its event
 * commit together.
 */

/**
 * SQL: trial `t` belongs to arm row `a` of experiment `e`. By config, except in an A/A calibration
 * run (D44), where one config is both arms and arm B's repeats are n to 2n - 1.
 */
export const TRIAL_IN_ARM = `t.config_hash = a.config_hash AND (NOT e.calibration OR (t.repeat_index >= e.n) = (a.position = 1))`;

/** An experiment_arms row (migration 005). */
export interface ArmRow {
  experiment_id: string;
  config_hash: string;
  arm: string;
  position: number;
  reused_trial_ids: string[];
  paused_at: Date | null;
  paused_reason: string | null;
  paused_fix: string | null;
  resumed_at: Date | null;
  futility_checked_at: Date | null;
}

export interface StoredEvent {
  experimentId: string;
  kind: ExperimentEventKind;
  detail: string;
  configHash?: string | null;
  trialId?: string | null;
  attempt?: number | null;
  data?: Record<string, Json>;
}

/**
 * Lock order (E3, E4, E5 of the 6 Nov review). A transaction that changes an experiment's status,
 * its trials, its arms or its events takes the experiment row first, with lockExperiment, then the
 * trial rows, then the arm rows, and reads the experiment's status from that locked row, never
 * from a read made before the transaction. The trial report and the lease sweep (worker.service.ts)
 * and every run control (start, pause, resume, stop, discard, an arm's pause and resume) do so, so
 * two of them on one experiment run one after the other:
 * - the last two reports see each other, so finishIfDone marks the run done (E3: both used to see
 *   the other trial still running, and the run stayed `running` for ever);
 * - Stop and an infra report's re-queue never interleave: the report sees the run cancelled and
 *   queues nothing, or Stop sees the new attempt and cancels it (E4);
 * - no transaction holds the weak lock an insert of a trial or an event takes on the experiment
 *   (KEY SHARE) and then asks for FOR UPDATE, which is how two of them deadlocked (E5).
 * A claim locks only the trial it takes (SKIP LOCKED) and never waits for the experiment row. A
 * grades report locks its grading job, then the experiment (applyFutility), and never an
 * unfinished trial. applyRunRules and applyFutility lock the row again: a no-op after this.
 */
export async function lockExperiment<T extends object = { id: string; status: string }>(q: Queryable, experimentId: string): Promise<T | undefined> {
  const { rows } = await q.query(`SELECT * FROM experiments WHERE id = $1 FOR UPDATE`, [experimentId]);
  return rows[0] as T | undefined;
}

export async function addEvent(q: Queryable, e: StoredEvent): Promise<void> {
  await q.query(
    `INSERT INTO experiment_events (experiment_id, kind, detail, config_hash, trial_id, attempt, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.experimentId, e.kind, e.detail, e.configHash ?? null, e.trialId ?? null, e.attempt ?? null, JSON.stringify(e.data ?? {})],
  );
}

/** The kinds that pause the whole experiment: by hand, D32's futility check and its two guards. */
export type ExperimentPauseKind = 'paused' | 'futility_pause' | 'infra_guard_pause' | 'spend_guard_pause';

/**
 * Pauses a running experiment, so nothing more is claimed; trials already running finish. Only
 * from `running`: returns false (and records nothing) otherwise.
 */
export async function pauseExperiment(q: Queryable, experimentId: string, kind: ExperimentPauseKind, reason: string, data: Record<string, Json> = {}): Promise<boolean> {
  const { rowCount } = await q.query(`UPDATE experiments SET status = 'paused', paused_at = now(), paused_reason = $2 WHERE id = $1 AND status = 'running'`, [
    experimentId,
    reason,
  ]);
  if (!rowCount) return false;
  await addEvent(q, { experimentId, kind, detail: reason, data });
  return true;
}

/**
 * D37: pauses one arm. Claims skip its trials; its running trials finish; the other arm keeps
 * claiming. Returns false if the arm was already paused (the first reason is kept). With `arm`
 * (a letter) only that arm; without it every arm running the config, which in an A/A calibration
 * run (D44) is both: a config error in one is a config error in the other.
 */
export async function pauseArm(
  q: Queryable,
  experimentId: string,
  configHash: string,
  reason: string,
  fix: string,
  trial: { id: string; attempt: number } | null = null,
  arm: string | null = null,
): Promise<boolean> {
  const { rows } = await q.query<{ arm: string }>(
    `UPDATE experiment_arms SET paused_at = now(), paused_reason = $3, paused_fix = $4
     WHERE experiment_id = $1 AND config_hash = $2 AND ($5::text IS NULL OR arm = $5) AND paused_at IS NULL RETURNING arm`,
    [experimentId, configHash, reason, fix, arm],
  );
  if (!rows.length) return false;
  const letters = rows.map((r) => r.arm).sort();
  await addEvent(q, {
    experimentId,
    kind: 'arm_paused',
    detail: `${letters.length > 1 ? `arms ${letters.join(' and ')}` : `arm ${letters[0]}`} paused: ${reason}`,
    configHash,
    trialId: trial?.id ?? null,
    attempt: trial?.attempt ?? null,
    data: { arm: letters.join(','), reason, fix },
  });
  return true;
}
