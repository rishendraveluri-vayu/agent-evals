import { MAX_JUDGE_BUDGET_USD, parseJudgeRequest, spendLogUsd } from './judge-core';

describe('a judge approval request', () => {
  it('takes a model and a budget above 0 and at most the cap', () => {
    expect(parseJudgeRequest({ model: ' claude-haiku-5-5 ', budget_usd: 2.5 })).toEqual({ model: 'claude-haiku-5-5', budgetUsd: 2.5 });
    expect(parseJudgeRequest({ model: 'fake/judge', budget_usd: MAX_JUDGE_BUDGET_USD })).toEqual({ model: 'fake/judge', budgetUsd: 20 });
  });

  it.each([
    ['not an object', null],
    ['a list', [{ model: 'm', budget_usd: 1 }]],
    ['no model', { budget_usd: 1 }],
    ['a blank model', { model: '  ', budget_usd: 1 }],
    ['no budget', { model: 'm' }],
    ['a zero budget', { model: 'm', budget_usd: 0 }],
    ['a negative budget', { model: 'm', budget_usd: -1 }],
    ['a budget over the cap', { model: 'm', budget_usd: 20.000001 }],
    ['a budget as text', { model: 'm', budget_usd: '5' }],
  ])('is refused with %s, saying what to send', (_what, body) => {
    expect(() => parseJudgeRequest(body)).toThrow(expect.objectContaining({ code: 'invalid_judge', fix: expect.stringContaining('budget_usd') as string }) as Error);
  });
});

describe('the judge key spend', () => {
  it('sums spend over the spend-log rows, as LiteLLM gives them', () => {
    expect(spendLogUsd([])).toBe(0);
    expect(spendLogUsd([{ spend: 0.1 }, { spend: 0.2 }, { spend: '0.0000001' }, { spend: null }, 'not a row', { status: 'failure' }])).toBe(0.3000001);
  });
});
