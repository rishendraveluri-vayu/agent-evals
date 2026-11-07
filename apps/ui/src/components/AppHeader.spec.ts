import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// A header left mounted would keep asking for health and answering visibility changes.
enableAutoUnmount(afterEach);

const allowance = { kind: 'conflict_check', limit_usd: 2, used_usd: 0, remaining_usd: 2, calls: 0, half_reached: false };

describe('AppHeader spend (5 Nov QA, major 6)', () => {
  it('counts real spend only, and says fake models’ made-up prices are left out', async () => {
    // A free A/B on fake models: LiteLLM counted $1.37 at made-up prices; nothing real was spent.
    answer({ trials_usd: 0, trials_spend_unknown: 0, fake_trials_usd: 1.37, system_usd: 0, judge_usd: 0, judge_approvals: 0, total_usd: 0, system_by_kind: {}, allowances: [allowance] });
    const w = mount(AppHeader, { props: { section: null } });
    await settle();
    expect(w.get('[data-test="spend-trials"]').text()).toBe('$0');
    const words = w.get('[data-test="spend"] [role="group"]').attributes('aria-label');
    expect(words).toContain('trials on real models $0,');
    expect(words).toContain('Fake-model trials are free: their made-up prices ($1.37) are not counted');
    expect(w.get('[data-test="spend"]').text()).not.toContain('1.37');
  });

  it('says when an abandoned attempt’s spend is unknown, rather than counting it as nothing (G3)', async () => {
    answer({ trials_usd: 0.44, trials_spend_unknown: 2, fake_trials_usd: 0, system_usd: 0, judge_usd: 0, judge_approvals: 0, total_usd: 0.44, system_by_kind: {}, allowances: [allowance] });
    const w = mount(AppHeader, { props: { section: null } });
    await settle();
    const words = w.get('[data-test="spend"] [role="group"]').attributes('aria-label');
    expect(words).toContain('The spend of 2 abandoned attempts is unknown (LiteLLM could not be read), so the real total may be higher');
    answer({ trials_usd: 0.44, trials_spend_unknown: 0, fake_trials_usd: 0, system_usd: 0, judge_usd: 0, judge_approvals: 0, total_usd: 0.44, system_by_kind: {}, allowances: [allowance] });
    const known = mount(AppHeader, { props: { section: null } });
    await settle();
    expect(known.get('[data-test="spend"] [role="group"]').attributes('aria-label')).not.toContain('unknown');
  });

  it('names the allowance meter on screen, not only in its tooltip', async () => {
    answer({ trials_usd: 0, trials_spend_unknown: 0, fake_trials_usd: 0, system_usd: 0, judge_usd: 0, judge_approvals: 0, total_usd: 0, system_by_kind: {}, allowances: [allowance] });
    const w = mount(AppHeader, { props: { section: null } });
    await settle();
    const meter = w.get('[data-test="header-allowance"]');
    expect(meter.text()).toBe('Conflict checks$0 of $2 used');
    expect(meter.get('.allowance-label').isVisible()).toBe(true);
    expect(meter.attributes('title')).toBe('Conflict-check allowance: $0 of $2 used, $2.00 left');
  });

  it('keeps a short allowance where the meter does not fit, and names each phone figure on screen (QA round 3, minor 15)', async () => {
    answer({ trials_usd: 0.44, trials_spend_unknown: 0, fake_trials_usd: 0, system_usd: 0.02, judge_usd: 0, judge_approvals: 0, total_usd: 0.46, system_by_kind: {}, allowances: [{ ...allowance, used_usd: 0.5, remaining_usd: 1.5 }] });
    const w = mount(AppHeader, { props: { section: null } });
    await settle();
    const short = w.get('[data-test="header-allowance-short"]');
    expect(short.text()).toBe('Checks $0.50 of $2');
    expect(short.attributes('aria-label')).toBe('Conflict-check allowance: $0.50 of $2 used, $1.50 left');
    const phone = w.get('[data-test="spend-compact"]');
    expect(phone.findAll('span[aria-hidden="true"]').map((s) => s.text())).toEqual(['Trials $0.44', 'Platform $0.02', 'Checks $0.50 of $2']);
    expect(phone.attributes('aria-label')).toContain("trials on real models $0.44, the platform's own calls $0.02");
    expect(phone.text()).not.toContain(' + ');
  });
});

describe('AppHeader nav on a phone (7 Nov QA)', () => {
  // jsdom does no layout, so this guards the rules themselves; checked in a browser at 390 px.
  // A path, not new URL(..., import.meta.url), which Vite turns into an asset address.
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'AppHeader.vue'), 'utf8');
  const phone = source.slice(source.indexOf('@media (max-width: 640px)'));

  it('wraps the sections onto more rows rather than scrolling them out of sight', () => {
    const nav = phone.match(/\n {2}\.nav \{([^}]*)\}/)?.[1] ?? '';
    expect(nav).toContain('flex-wrap: wrap;');
    expect(nav).not.toContain('overflow-x');
    expect(phone).not.toContain('mask-image');
  });
});

describe('AppHeader health badge (destructive review U7)', () => {
  const spend: SpendView = { trials_usd: 0, trials_spend_unknown: 0, fake_trials_usd: 0, system_usd: 0, judge_usd: 0, judge_approvals: 0, total_usd: 0, system_by_kind: {}, allowances: [allowance] };
  let hidden = false;

  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'hidden');
  });

  /** The API is up or down as `up()` says when each call is made. */
  function api(up: () => boolean) {
    const calls = { health: 0, spend: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === '/api/health') calls.health += 1;
        if (url === '/api/spend') calls.spend += 1;
        if (!up()) return Promise.reject(new TypeError('Failed to fetch'));
        if (url === '/api/health') return Promise.resolve(jsonReply(200, { status: 'ok', db: 'up' }));
        return Promise.resolve(jsonReply(200, url === '/api/spend' ? spend : []));
      }),
    );
    return calls;
  }

  const tick = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await flushPromises();
  };

  it('asks again every 10 s, so it says when the API goes down and when it is back, and reads the spend again then', async () => {
    let up = true;
    const calls = api(() => up);
    const w = mount(AppHeader, { props: { section: null } });
    await tick(0);
    expect(w.get('[data-test="health-status"]').text()).toBe('ok');
    up = false;
    await tick(10_000);
    expect(w.get('[data-test="health-unreachable"]').text()).toContain('API unreachable');
    const spendBefore = calls.spend;
    up = true;
    await tick(10_000);
    expect(w.get('[data-test="health-status"]').text()).toBe('ok');
    expect(calls.spend).toBe(spendBefore + 1);
    w.unmount();
    const after = calls.health;
    await tick(60_000);
    expect(calls.health).toBe(after);
  });

  it('asks nothing while the tab is hidden, and asks at once when it is shown again', async () => {
    const calls = api(() => true);
    const w = mount(AppHeader, { props: { section: null } });
    await tick(0);
    expect(calls.health).toBe(1);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(60_000);
    expect(calls.health).toBe(1);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(0);
    expect(calls.health).toBe(2);
    await tick(10_000);
    expect(calls.health).toBe(3);
    w.unmount();
  });
});
