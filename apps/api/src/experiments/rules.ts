import type { Estimate, FutilityRule } from '../contract';
import { badRequest } from '../common/api-error';
import type { Queryable } from '../database/db.service';
import { pauseExperiment } from './run-state';

/**
 * D32's automatic pauses. None of them looks at the difference between the arms: the verdict
 * uses the full planned N, so nothing here stops or decides on an apparent win or loss.
 *
 * - Futility, once per arm: after the arm's first `after` finished trials (a random sample, D32's
 *   order), an arm that passed fewer than `min_passed` pauses the run for review.
 * - Infra guard: more than 30% infra failures among at least 5 trials finished since the run
 *   started or last resumed.
 * - Spend guard, once per experiment: spend so far plus the remaining trials at the cost of those
 *   finished passes the experiment budget.
 *
 * Until graders exist (SP4), "passed" means label `agent` and end state `answered`.
 */

export const FUTILITY_DEFAULT: FutilityRule = { enabled: true, after: 3, min_passed: 1 };

export const INFRA_GUARD = { min_finished: 5, max_rate: 0.3 } as const;

export const PASSED_MEANS = 'passed means label agent and end state answered until graders exist (SP4)';

/** The rule from a request: defaults for anything left out; `{"enabled": false}` turns it off. */
export function resolveFutility(input: unknown): FutilityRule {
  if (input === undefined || input === null) return { ...FUTILITY_DEFAULT };
  const fix = 'Send futility as {"after": <finished trials per arm, at least 1>, "min_passed": <0 to after>}, {"enabled": false} to turn it off, or leave it out for after 3, min_passed 1.';
  if (typeof input !== 'object' || Array.isArray(input)) throw badRequest('invalid_experiment', 'futility must be an object', fix);
  const f = input as Record<string, unknown>;
  const unknown = Object.keys(f).find((k) => !['enabled', 'after', 'min_passed'].includes(k));
  if (unknown) throw badRequest('invalid_experiment', `futility has no field ${unknown}`, fix);
  const enabled = f.enabled ?? true;
  const after = f.after ?? FUTILITY_DEFAULT.after;
  const minPassed = f.min_passed ?? FUTILITY_DEFAULT.min_passed;
  if (typeof enabled !== 'boolean') throw badRequest('invalid_experiment', 'futility.enabled must be true or false', fix);
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 1 || after > 1000) throw badRequest('invalid_experiment', 'futility.after must be an integer from 1 to 1000', fix);
  if (typeof minPassed !== 'number' || !Number.isInteger(minPassed) || minPassed < 0 || minPassed > after) {
    throw badRequest('invalid_experiment', 'futility.min_passed must be an integer from 0 to futility.after', fix);
  }
  return { enabled, after, min_passed: minPassed };
}

/** Whether an arm that has finished `finished` trials, `passed` of them passing, is futile now. */
export function futile(rule: FutilityRule, finished: number, passed: number): boolean {
  return rule.enabled && finished >= rule.after && passed < rule.min_passed;
}

/** Whether `infra` infra failures among `finished` trials trips the guard. */
export function infraGuardTrips(finished: number, infra: number): boolean {
  return finished >= INFRA_GUARD.min_finished && infra / finished > INFRA_GUARD.max_rate;
}

export interface ArmSpend {
  /** Trials of the arm still queued or running. */
  remaining: number;
  /** Mean cost (agent and simulator) of the arm's reported trials, or null if none has a cost yet. */
  meanCost: number | null;
  /** The estimate's per-trial cost for the arm, used until a trial of it has finished. */
  estimatePerTrial: number;
}

/** Spend so far plus every remaining trial at its arm's cost per trial. */
export function projectedSpend(spent: number, arms: ArmSpend[]): number {
  return spent + arms.reduce((sum, a) => sum + a.remaining * (a.meanCost ?? a.estimatePerTrial), 0);
}

/** The estimate's mean cost per trial (agent and simulator) over a config's cells. */
export function estimatePerTrial(e: Estimate | null, config: string): number {
  const cells = e?.basis_detail?.cells?.filter((c) => c.config === config) ?? [];
  if (!cells.length) return 0;
  return cells.reduce((s, c) => s + c.agent_usd_per_trial + c.sim_usd_per_trial, 0) / cells.length;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const usd = (x: number): string => `$${x.toFixed(4)}`;

/**
 * Runs the three checks for one experiment, inside the caller's transaction, after a report or a
 * lapse has changed its trials. Locks the experiment row so two reports never both pause it.
 * Does nothing unless the experiment is running. Returns the kind of pause, if one happened.
 */
export async function applyRunRules(q: Queryable, experimentId: string): Promise<string | null> {
  const { rows: exps } = await q.query<{
    status: string;
    futility: FutilityRule | null;
    budget_usd: number;
    estimate: Estimate | null;
    spend_guard_at: Date | null;
    window_start: Date | null;
  }>(
    `SELECT status, futility, budget_usd, estimate, spend_guard_at, coalesce(resumed_at, started_at) AS window_start
     FROM experiments WHERE id = $1 FOR UPDATE`,
    [experimentId],
  );
  const exp = exps[0];
  if (!exp || exp.status !== 'running') return null;

  const { rows: arms } = await q.query<{
    arm: string;
    config_hash: string;
    reused: boolean;
    futility_checked: boolean;
    done: number;
    passed: number;
    remaining: number;
    reported: number;
    cost: number;
  }>(
    `SELECT a.arm, a.config_hash, cardinality(a.reused_trial_ids) > 0 AS reused, a.futility_checked_at IS NOT NULL AS futility_checked,
            count(t.id) FILTER (WHERE t.status = 'done')::int AS done,
            count(t.id) FILTER (WHERE t.status = 'done' AND t.label = 'agent' AND t.end_state = 'answered')::int AS passed,
            count(t.id) FILTER (WHERE t.status IN ('queued', 'claimed', 'running'))::int AS remaining,
            count(t.id) FILTER (WHERE t.cost_usd IS NOT NULL)::int AS reported,
            coalesce(sum(coalesce(t.cost_usd, 0) + coalesce(t.sim_cost_usd, 0)), 0)::float8 AS cost
     FROM experiment_arms a LEFT JOIN trials t ON t.experiment_id = a.experiment_id AND t.config_hash = a.config_hash
     WHERE a.experiment_id = $1
     GROUP BY a.arm, a.config_hash, a.reused_trial_ids, a.futility_checked_at, a.position
     ORDER BY a.position`,
    [experimentId],
  );

  // Futility, once per arm, on the arm's first `after` finished trials.
  const rule = exp.futility;
  if (rule?.enabled) {
    const due = arms.filter((a) => !a.reused && !a.futility_checked && a.done >= rule.after);
    for (const a of due) {
      await q.query('UPDATE experiment_arms SET futility_checked_at = now() WHERE experiment_id = $1 AND config_hash = $2', [experimentId, a.config_hash]);
    }
    const futileArms = due.filter((a) => futile(rule, a.done, a.passed));
    if (futileArms.length) {
      const what = futileArms.map((a) => `arm ${a.arm} passed ${a.passed} of its first ${a.done} finished trials`).join('; ');
      const reason =
        `futility check (D32): ${what}, fewer than the ${rule.min_passed} the rule asks for (${PASSED_MEANS}). ` +
        'Review those trials, then resume or stop; the check runs once per arm and never compares the arms';
      await pauseExperiment(q, experimentId, 'futility_pause', reason, {
        rule: { ...rule },
        arms: futileArms.map((a) => ({ arm: a.arm, config_hash: a.config_hash, finished: a.done, passed: a.passed })),
      });
      return 'futility_pause';
    }
  }

  // Infra guard, over the trials finished since the run started or last resumed.
  // An abandoned attempt has no label, so it counts under its status.
  const { rows: window } = await q.query<{ what: string; infra: boolean; n: number }>(
    `SELECT coalesce(label, status) AS what, status <> 'done' AS infra, count(*)::int AS n
     FROM trials WHERE experiment_id = $1 AND status IN ('done', 'infra_failed', 'abandoned')
       AND finished_at >= coalesce($2::timestamptz, '-infinity'::timestamptz)
     GROUP BY 1, 2 ORDER BY 1`,
    [experimentId, exp.window_start],
  );
  const finished = window.reduce((s, w) => s + w.n, 0);
  const failures = window.filter((w) => w.infra);
  const infra = failures.reduce((s, w) => s + w.n, 0);
  if (infraGuardTrips(finished, infra)) {
    const which = failures.map((w) => `${w.what} x${w.n}`).join(', ');
    const reason =
      `infra guard (D32): ${infra} of the ${finished} trials finished since the run started or last resumed were infra failures ` +
      `(${pct(infra / finished)}, above ${pct(INFRA_GUARD.max_rate)}: ${which}). Fix the cause, then resume (the count starts again), or stop`;
    await pauseExperiment(q, experimentId, 'infra_guard_pause', reason, { finished, infra, failures: Object.fromEntries(failures.map((w) => [w.what, w.n])) });
    return 'infra_guard_pause';
  }

  // Spend guard, once: what is spent plus the rest at the cost of what has finished.
  if (!exp.spend_guard_at) {
    const spent = arms.reduce((s, a) => s + a.cost, 0);
    const projected = projectedSpend(
      spent,
      arms.map((a) => ({ remaining: a.remaining, meanCost: a.reported ? a.cost / a.reported : null, estimatePerTrial: estimatePerTrial(exp.estimate, a.config_hash) })),
    );
    if (projected > exp.budget_usd) {
      const remaining = arms.reduce((s, a) => s + a.remaining, 0);
      const reason =
        `spend guard (D32): ${usd(spent)} spent; the ${remaining} trials left, at the cost of the trials finished so far, project ${usd(projected)}, ` +
        `above the experiment budget of ${usd(exp.budget_usd)}. Stop and re-plan, or resume: this guard does not fire again, and LiteLLM's budget still stops spend at the cap`;
      await q.query('UPDATE experiments SET spend_guard_at = now() WHERE id = $1', [experimentId]);
      await pauseExperiment(q, experimentId, 'spend_guard_pause', reason, { spent, projected, budget_usd: exp.budget_usd, remaining });
      return 'spend_guard_pause';
    }
  }
  return null;
}
