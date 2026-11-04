import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { SpendView } from '../api/types';
import { jsonReply, settle } from '../test/helpers';
import AppHeader from './AppHeader.vue';

/** Answers /api/spend with `spend` and /api/health with ok. */
function answer(spend: SpendView) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/health') return Promise.resolve(jsonReply(200, { status: 'ok', db: 'up' }));
      return Promise.resolve(jsonReply(200, url === '/api/spend' ? spend : []));
    }),
  );
}

const allowance = { kind: 'conflict_check', limit_usd: 2, used_usd: 0, remaining_usd: 2, calls: 0, half_reached: false };

describe('AppHeader spend (5 Nov QA, major 6)', () => {
  it('counts real spend only, and says fake models’ made-up prices are left out', async () => {
    // A free A/B on fake models: LiteLLM counted $1.37 at made-up prices; nothing real was spent.
    answer({ trials_usd: 0, fake_trials_usd: 1.37, system_usd: 0, judge_usd: 0, judge_approvals: 0, total_usd: 0, system_by_kind: {}, allowances: [allowance] });
    const w = mount(AppHeader, { props: { section: null } });
    await settle();
    expect(w.get('[data-test="spend-trials"]').text()).toBe('$0');
    const words = w.get('[data-test="spend"] [role="group"]').attributes('aria-label');
    expect(words).toContain('trials on real models $0,');
    expect(words).toContain('Fake-model trials are free: their made-up prices ($1.37) are not counted');
    expect(w.get('[data-test="spend"]').text()).not.toContain('1.37');
  });

  it('names the allowance meter on screen, not only in its tooltip', async () => {
    answer({ trials_usd: 0, fake_trials_usd: 0, system_usd: 0, judge_usd: 0, judge_approvals: 0, total_usd: 0, system_by_kind: {}, allowances: [allowance] });
    const w = mount(AppHeader, { props: { section: null } });
    await settle();
    const meter = w.get('[data-test="header-allowance"]');
    expect(meter.text()).toBe('Conflict checks$0 of $2 used');
    expect(meter.get('.allowance-label').isVisible()).toBe(true);
    expect(meter.attributes('title')).toBe('Conflict-check allowance: $0 of $2 used, $2.00 left');
  });
});
