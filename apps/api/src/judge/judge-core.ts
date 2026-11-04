import { badRequest } from '../common/api-error';

/**
 * Pure parts of the LLM judge's approval (SP4, R8): checking the approval request and reading
 * what the judge's key has spent from LiteLLM's spend log.
 */

/** The most one approval may let the judge spend, in USD. */
export const MAX_JUDGE_BUDGET_USD = 20;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{model, budget_usd}`, or 400 `invalid_judge` saying what to send. Whether LiteLLM serves the model is checked after. */
export function parseJudgeRequest(body: unknown): { model: string; budgetUsd: number } {
  const fix = `Send {"model": "<a model from GET /api/models>", "budget_usd": <more than 0, at most ${MAX_JUDGE_BUDGET_USD}>}.`;
  if (!isObject(body)) throw badRequest('invalid_judge', 'the body must be a JSON object', fix);
  const { model, budget_usd } = body;
  if (typeof model !== 'string' || !model.trim()) throw badRequest('invalid_judge', 'model is required', fix);
  if (typeof budget_usd !== 'number' || !Number.isFinite(budget_usd) || budget_usd <= 0 || budget_usd > MAX_JUDGE_BUDGET_USD) {
    throw badRequest('invalid_judge', `budget_usd must be a number above 0 and at most ${MAX_JUDGE_BUDGET_USD}`, fix);
  }
  return { model: model.trim(), budgetUsd: budget_usd };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** The sum of `spend` over a key's spend-log rows, as the conflict check's cost sums them. No rows is 0. */
export function spendLogUsd(rows: unknown[]): number {
  const usd = rows.filter(isObject).reduce((s, r) => s + (num(r.spend) ?? 0), 0);
  return Math.round(usd * 1e8) / 1e8;
}
