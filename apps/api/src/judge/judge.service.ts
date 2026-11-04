import { Inject, Injectable, Logger } from '@nestjs/common';
import type { JudgeApprovalResponse, JudgeRevokeResponse, JudgeView } from '../contract';
import { missingKeyVar } from '../catalogue/catalogue.service';
import { badRequest, conflict, notFound } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { newId } from '../common/ids';
import { Db } from '../database/db.service';
import { type ExampleMark, assertNotExample } from '../examples/example-guard';
import { LiteLlmClient, LiteLlmHttpError } from '../litellm/litellm.client';
import { parseJudgeRequest, spendLogUsd } from './judge-core';

interface ApprovalRow {
  id: string;
  experiment_id: string;
  model: string;
  budget_usd: number;
  key_token: string;
  approved_at: Date;
  revoked_at: Date | null;
  revoked_spend_usd: number | null;
}

/** Every column but the key itself, which only the grading claim reads. */
const SELECT = `SELECT id, experiment_id, model, budget_usd::float8 AS budget_usd, key_token, approved_at, revoked_at, revoked_spend_usd FROM judge_approvals`;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The LLM judge's approval, one experiment at a time (SP4, R8). Judging costs real money, so it
 * runs only when Rishi approves it for an experiment with a model and a budget: the API, which
 * alone holds LiteLLM's master key, mints one key for that experiment's judging, limited to the
 * model and capped at the budget, and the grading claim hands it to the grader worker. Revoking
 * deletes the key in LiteLLM. No UI-facing route returns the key.
 */
@Injectable()
export class JudgeService {
  private readonly logger = new Logger(JudgeService.name);

  constructor(
    private readonly db: Db,
    private readonly litellm: LiteLlmClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async experiment(id: string): Promise<ExampleMark> {
    const [e] = await this.db.query<ExampleMark>('SELECT id, example_name FROM experiments WHERE id = $1', [id]);
    if (!e) throw notFound('unknown_experiment', `no experiment ${id}`);
    return e;
  }

  private async active(experimentId: string): Promise<ApprovalRow | undefined> {
    return (await this.db.query<ApprovalRow>(`${SELECT} WHERE experiment_id = $1 AND revoked_at IS NULL`, [experimentId]))[0];
  }

  /** What the key has spent by LiteLLM's spend log, or null when LiteLLM cannot be read. */
  private async spendOf(token: string): Promise<number | null> {
    try {
      return spendLogUsd(await this.litellm.spendLogs(token));
    } catch {
      return null;
    }
  }

  /** POST /experiments/:id/judge */
  async approve(experimentId: string, body: unknown): Promise<JudgeApprovalResponse> {
    // SP7: a shipped example is never judged again, so no key is ever minted for one.
    assertNotExample(await this.experiment(experimentId), 'be judged');
    const { model, budgetUsd } = parseJudgeRequest(body);
    const route = await this.litellm.findModel(model);
    if (!route || route.inputPerToken === null || route.outputPerToken === null) {
      throw badRequest(
        'unknown_model',
        route ? `LiteLLM serves ${model} without a price, so its spend could not be capped or counted` : `LiteLLM serves no model ${model}`,
        'Pick a model from GET /api/models (or a fake/* model), or add it with its prices to services/litellm/config.yaml.',
      );
    }
    // A key LiteLLM does not have would fail every judge call: refuse before a key is minted.
    const keyVar = missingKeyVar(model, route.provider, this.config.providerKeys);
    if (keyVar) {
      throw badRequest(
        'provider_key_missing',
        `${model} needs ${keyVar}, which is not set in .env, so every judge call would fail`,
        `Add ${keyVar} to .env, run docker compose up -d, then approve the judge again; or pick a fake model, which needs no key.`,
      );
    }
    const already = conflict(
      'judge_already_approved',
      `experiment ${experimentId} already has an active judge approval`,
      `Revoke it first (DELETE /api/experiments/${experimentId}/judge), then approve again with the new model or budget.`,
    );
    if (await this.active(experimentId)) throw already;
    const key = await this.litellm.generateJudgeKey({ experimentId, model, maxBudgetUsd: budgetUsd });
    try {
      const [row] = await this.db.query<{ approved_at: Date }>(
        `INSERT INTO judge_approvals (id, experiment_id, model, budget_usd, key, key_token) VALUES ($1, $2, $3, $4, $5, $6) RETURNING approved_at`,
        [newId('j'), experimentId, model, budgetUsd, key.key, key.token],
      );
      return { experiment_id: experimentId, model, budget_usd: budgetUsd, approved_at: row.approved_at.toISOString() };
    } catch (err) {
      // No minted key is left that no row knows of; a second approval made meanwhile wins.
      await this.litellm.deleteKeys([key.token]).catch((e: unknown) => this.logger.warn(`could not delete the unused judge key for ${experimentId}: ${message(e)}`));
      if ((err as { code?: string }).code === '23505') throw already;
      throw err;
    }
  }

  /**
   * DELETE /experiments/:id/judge: deletes the key in LiteLLM, so it stops working at once, then
   * marks the approval revoked. A key LiteLLM no longer has counts as deleted; an unreachable
   * LiteLLM is a 502 and the approval stays active, so a live key is never shown as revoked.
   */
  async revoke(experimentId: string): Promise<JudgeRevokeResponse> {
    await this.experiment(experimentId);
    const a = await this.active(experimentId);
    const none = notFound('no_judge_approval', `experiment ${experimentId} has no active judge approval`);
    if (!a) throw none;
    const spent = await this.spendOf(a.key_token);
    try {
      await this.litellm.deleteKeys([a.key_token]);
    } catch (err) {
      if (!(err instanceof LiteLlmHttpError) || err.upstreamStatus >= 500) throw err;
    }
    const [row] = await this.db.query<{ revoked_at: Date }>(
      `UPDATE judge_approvals SET revoked_at = now(), revoked_spend_usd = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING revoked_at`,
      [a.id, spent],
    );
    if (!row) throw none; // revoked by another call meanwhile
    return { experiment_id: experimentId, revoked_at: row.revoked_at.toISOString() };
  }

  /** The active approval for GET /experiments/:id, or null. Never the key. */
  async view(experimentId: string): Promise<JudgeView | null> {
    const a = await this.active(experimentId);
    if (!a) return null;
    return { model: a.model, budget_usd: a.budget_usd, spend_usd: await this.spendOf(a.key_token), approved_at: a.approved_at.toISOString() };
  }

  /**
   * GET /spend's judge line: every approval's spend, revoked ones included. Each key's spend log
   * is the source; for a revoked key, what the log said at revoke is the floor and the fallback.
   * Null when an active key's log cannot be read and nothing was recorded for it.
   */
  async totals(): Promise<{ usd: number | null; approvals: number }> {
    const rows = await this.db.query<ApprovalRow>(`${SELECT} ORDER BY approved_at, id`);
    const each = await Promise.all(
      rows.map(async (a) => {
        const live = await this.spendOf(a.key_token);
        return live === null && a.revoked_spend_usd === null ? null : Math.max(live ?? 0, a.revoked_spend_usd ?? 0);
      }),
    );
    const usd = each.some((v) => v === null) ? null : Math.round(each.reduce((s: number, v) => s + (v ?? 0), 0) * 1e8) / 1e8;
    return { usd, approvals: rows.length };
  }
}
