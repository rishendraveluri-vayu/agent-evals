import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AllowanceView, SpendView, SystemSpendRow } from '../contract';
import { ApiError, conflict } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { Db, type Queryable } from '../database/db.service';
import { JudgeService } from '../judge/judge.service';
import type { CallCost } from '../preflight/conflict-check';

/**
 * The platform's own model calls (D38), kept apart from trial spend: one `system_spend` row per
 * call, written `pending` with a worst-case reservation before the call and settled with LiteLLM's
 * spend-log cost after it. An allowance caps each kind of call.
 */

/** Advisory lock keys: one platform-wide check at a time, and the reservation's own lock. */
const EXCLUSIVE_LOCK: Record<string, number> = { conflict_check: 74_201_106 };
const RESERVE_LOCK = 74_201_107;

const round = (n: number): number => Math.round(n * 1e8) / 1e8;

/** What counts against an allowance: a settled cost, or the reservation while unsettled or unknown. */
const USED_SQL = `coalesce(sum(CASE WHEN status = 'pending' OR cost_usd IS NULL THEN reserved_usd ELSE cost_usd END), 0)::float8`;

interface Row {
  id: string;
  kind: string;
  model: string;
  status: SystemSpendRow['status'];
  reserved_usd: number;
  cost_usd: number | null;
  cost_source: SystemSpendRow['cost_source'];
  input_tokens: number | null;
  output_tokens: number | null;
  ref: string;
  error: string | null;
  created_at: Date;
  settled_at: Date | null;
}

export function spendId(): string {
  return `ss_${Date.now().toString(36).padStart(9, '0')}${randomBytes(6).toString('hex')}`;
}

@Injectable()
export class SpendService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
    private readonly judge: JudgeService,
  ) {}

  /** The kinds of platform call that have an allowance, with their limits. */
  limits(): Record<string, number> {
    return { conflict_check: this.config.conflictCheckAllowanceUsd };
  }

  async allowance(kind: string, q: Queryable | null = null): Promise<AllowanceView> {
    const limit = this.limits()[kind];
    if (limit === undefined) throw new ApiError(500, 'unknown_allowance', `no allowance for ${kind}`);
    const sql = `SELECT count(*)::int AS calls, ${USED_SQL} AS used FROM system_spend WHERE kind = $1`;
    const [r] = q ? ((await q.query(sql, [kind])).rows as { calls: number; used: number }[]) : await this.db.query<{ calls: number; used: number }>(sql, [kind]);
    const used = round(r?.used ?? 0);
    return { kind, limit_usd: limit, used_usd: used, remaining_usd: round(Math.max(0, limit - used)), calls: r?.calls ?? 0, half_reached: used >= limit / 2 };
  }

  /** Runs `fn` as the only call of this kind in progress anywhere; 409 `<kind>_busy` otherwise. */
  async exclusive<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    const got = await this.db.withTryLock(EXCLUSIVE_LOCK[kind] ?? RESERVE_LOCK + 1, fn);
    if (!got.held) throw conflict(`${kind}_busy`, `another ${kind.replace('_', ' ')} is running; try again when it finishes`);
    return got.value;
  }

  /**
   * Records a call about to be made, holding `reservedUsd` (its worst case) against the allowance.
   * 402 `allowance_exhausted` when that would pass the limit; nothing is recorded then.
   */
  async reserve(opts: { kind: string; model: string; ref: string; reservedUsd: number }): Promise<{ id: string; allowance: AllowanceView }> {
    return this.db.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [RESERVE_LOCK]);
      const allowance = await this.allowance(opts.kind, client);
      if (allowance.used_usd + opts.reservedUsd > allowance.limit_usd) {
        throw new ApiError(
          402,
          'allowance_exhausted',
          `the ${opts.kind} allowance is $${allowance.limit_usd}; $${allowance.used_usd} is used and this call could cost up to $${opts.reservedUsd}. ` +
            'A larger allowance (EVALS_CONFLICT_CHECK_ALLOWANCE_USD) needs a new sign-off (D38).',
        );
      }
      const id = spendId();
      await client.query(
        `INSERT INTO system_spend (id, kind, model, status, reserved_usd, ref) VALUES ($1, $2, $3, 'pending', $4, $5)`,
        [id, opts.kind, opts.model, opts.reservedUsd, opts.ref],
      );
      return { id, allowance };
    });
  }

  /** Settles a reserved call with what it cost. A cost LiteLLM never reported stays null, and the reservation keeps counting. */
  async settle(id: string, s: { ok: boolean; cost: CallCost; error: string | null }): Promise<void> {
    await this.db.query(
      `UPDATE system_spend SET status = $2, cost_usd = $3, cost_source = $4, input_tokens = $5, output_tokens = $6,
              litellm_request_id = $7, error = $8, settled_at = now()
       WHERE id = $1`,
      [id, s.ok ? 'done' : 'failed', s.cost.costUsd, s.cost.source, s.cost.inputTokens, s.cost.outputTokens, s.cost.requestId, s.error],
    );
  }

  async cost(id: string): Promise<number | null> {
    const [r] = await this.db.query<{ cost_usd: number | null }>('SELECT cost_usd FROM system_spend WHERE id = $1', [id]);
    return r?.cost_usd ?? null;
  }

  /** GET /spend: experiment trials, platform calls and the LLM judge, separately. */
  async totals(): Promise<SpendView> {
    const [t] = await this.db.query<{ usd: number }>(
      `SELECT coalesce(sum(coalesce(cost_usd, 0) + coalesce(sim_cost_usd, 0)), 0)::float8 AS usd FROM trials WHERE NOT probe`,
    );
    const kinds = await this.db.query<{ kind: string; usd: number; calls: number }>(
      `SELECT kind, coalesce(sum(cost_usd), 0)::float8 AS usd, count(*)::int AS calls FROM system_spend GROUP BY kind ORDER BY kind`,
    );
    const byKind: SpendView['system_by_kind'] = {};
    for (const k of kinds) byKind[k.kind] = { usd: round(k.usd), calls: k.calls };
    const trials = round(t?.usd ?? 0);
    const system = round(kinds.reduce((s, k) => s + k.usd, 0));
    const allowances: AllowanceView[] = [];
    for (const kind of Object.keys(this.limits())) allowances.push(await this.allowance(kind));
    const judge = await this.judge.totals();
    return {
      trials_usd: trials,
      system_usd: system,
      judge_usd: judge.usd,
      judge_approvals: judge.approvals,
      total_usd: round(trials + system + (judge.usd ?? 0)),
      system_by_kind: byKind,
      allowances,
    };
  }

  /** GET /spend/system: every platform call, newest first. */
  async rows(kind?: string): Promise<SystemSpendRow[]> {
    const rows = await this.db.query<Row>(
      `SELECT id, kind, model, status, reserved_usd, cost_usd, cost_source, input_tokens, output_tokens, ref, error, created_at, settled_at
       FROM system_spend ${kind ? 'WHERE kind = $1' : ''} ORDER BY created_at DESC, id DESC`,
      kind ? [kind] : [],
    );
    return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), settled_at: r.settled_at ? r.settled_at.toISOString() : null }));
  }
}
