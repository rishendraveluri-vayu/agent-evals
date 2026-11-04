import type { ExperimentEventKind, Json } from '../contract';
import type { Queryable } from '../database/db.service';

/**
 * The run state that can change while an experiment runs (D32, D37): stored events, experiment
 * pauses and arm pauses. Each function takes the caller's transaction, so a pause and its event
 * commit together.
 */

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
 * claiming. Returns false if the arm was already paused (the first reason is kept).
 */
export async function pauseArm(
  q: Queryable,
  experimentId: string,
  configHash: string,
  reason: string,
  fix: string,
  trial: { id: string; attempt: number } | null = null,
): Promise<boolean> {
  const { rows } = await q.query<{ arm: string }>(
    `UPDATE experiment_arms SET paused_at = now(), paused_reason = $3, paused_fix = $4
     WHERE experiment_id = $1 AND config_hash = $2 AND paused_at IS NULL RETURNING arm`,
    [experimentId, configHash, reason, fix],
  );
  if (!rows.length) return false;
  await addEvent(q, {
    experimentId,
    kind: 'arm_paused',
    detail: `arm ${rows[0].arm} paused: ${reason}`,
    configHash,
    trialId: trial?.id ?? null,
    attempt: trial?.attempt ?? null,
    data: { arm: rows[0].arm, reason, fix },
  });
  return true;
}
