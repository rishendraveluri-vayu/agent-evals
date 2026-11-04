import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import { currentHash } from './router';
import { jsonReply, settle, useFixtures } from './test/helpers';

function open(hash: string) {
  window.location.hash = hash;
  currentHash.value = hash;
}

/** Answers /api/health as given and every other call with an empty list. */
function api(health: () => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url === '/api/health' ? health() : Promise.resolve(jsonReply(200, []));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => open(''));

describe('App header against the API', () => {
  it('shows a loading state before the API answers', () => {
    api(() => new Promise<Response>(() => undefined));
    const wrapper = mount(App);
    expect(wrapper.get('.brand').text()).toBe('Agent Evals');
    expect(wrapper.find('[data-test="health-loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="sample-data"]').exists()).toBe(false);
  });

  it('renders status and db from /api/health', async () => {
    const fetchMock = api(() => Promise.resolve(jsonReply(200, { status: 'ok', db: 'up' })));
    const wrapper = mount(App);
    await settle();
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything());
    expect(wrapper.get('[data-test="health-status"]').text()).toBe('ok');
    expect(wrapper.get('[data-test="health-db"]').text()).toBe('up');
  });

  it('renders db down from a 503 reply, since the API itself answered', async () => {
    api(() => Promise.resolve(jsonReply(503, { status: 'ok', db: 'down' })));
    const wrapper = mount(App);
    await settle();
    expect(wrapper.get('[data-test="health-db"]').text()).toBe('down');
    expect(wrapper.find('[data-test="health-unreachable"]').exists()).toBe(false);
  });

  it('names the judge in the spoken spend summary only when it has spent something', async () => {
    const answer = (judgeUsd: number | null) => {
      const spend = { trials_usd: 1.5, system_usd: 0.02, judge_usd: judgeUsd, judge_approvals: 1, total_usd: 1.52 + (judgeUsd ?? 0), system_by_kind: {}, allowances: [] };
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url === '/api/health') return Promise.resolve(jsonReply(200, { status: 'ok', db: 'up' }));
          return Promise.resolve(jsonReply(200, url === '/api/spend' ? spend : []));
        }),
      );
    };
    const label = (w: ReturnType<typeof mount>) => w.get('[data-test="spend"] [role="group"]').attributes('aria-label');
    answer(0.42);
    const spent = mount(App);
    await settle();
    expect(label(spent)).toContain(", the platform's own calls $0.02, the judge $0.42");
    for (const none of [0, null]) {
      answer(none);
      const w = mount(App);
      await settle();
      expect(label(w)).not.toContain('judge');
    }
  });

  it('renders the unreachable state when fetch fails or a proxy answers', async () => {
    api(() => Promise.reject(new TypeError('Failed to fetch')));
    const first = mount(App);
    await settle();
    expect(first.get('[data-test="health-unreachable"]').text()).toContain('API unreachable (Failed to fetch)');
    api(() => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })));
    const second = mount(App);
    await settle();
    expect(second.get('[data-test="health-unreachable"]').text()).toContain('HTTP 502');
  });
});

describe('App in fixture mode', () => {
  useFixtures();

  it('marks sample data in the header and shows trial spend and platform spend apart, with the allowance', async () => {
    const wrapper = mount(App);
    await settle();
    expect(wrapper.get('[data-test="sample-data"]').text()).toBe('Sample data');
    expect(wrapper.get('[data-test="spend-trials"]').text()).toBe('$55.88');
    expect(wrapper.get('[data-test="spend-platform"]').text()).toBe('$0.02');
    expect(wrapper.get('[data-test="spend"]').text()).toContain('of $150');
    expect(wrapper.get('[data-test="spend-compact"]').text()).toBe('$55.88 + $0.02');
    const meter = wrapper.get('[data-test="allowance"] [role="img"]');
    expect(meter.attributes('aria-label')).toBe('Conflict checks: $0.02 of $2 used, $1.98 left, 1 call');
  });

  it('routes by hash and marks the current section', async () => {
    open('#/harnesses');
    const wrapper = mount(App);
    await settle();
    expect(wrapper.get('main h1').text()).toBe('Harnesses');
    expect(wrapper.get('nav[aria-label="Main"] [aria-current="page"]').text()).toBe('Harnesses');
    open('#/labels/judge');
    await settle();
    expect(wrapper.get('main h1').text()).toBe('Can we trust the judge?');
    expect(wrapper.get('nav[aria-label="Main"] [aria-current="page"]').text()).toBe('Labels');
    open('#/nowhere');
    await settle();
    expect(wrapper.get('main h1').text()).toBe('Page not found');
  });

  it('opens on the front door, with the guided builder and the full platform each in the nav', async () => {
    open('');
    const wrapper = mount(App);
    await settle();
    expect(wrapper.get('main h1').text()).toBe('Evaluate an agent');
    const current = () => wrapper.get('nav[aria-label="Main"] [aria-current="page"]').text();
    expect(current()).toBe('Start');
    expect(wrapper.get('.brand').attributes('href')).toBe('#/');
    const nav = wrapper.findAll('nav[aria-label="Main"] a').map((a) => [a.text(), a.attributes('href')]);
    expect(nav.slice(0, 3)).toEqual([
      ['Start', '#/'],
      ['Build an agent', '#/build'],
      ['Experiments', '#/experiments'],
    ]);
    open('#/build');
    await settle();
    expect(wrapper.get('main h1').text()).toBe('Build an agent');
    expect(current()).toBe('Build an agent');
    open('#/experiments');
    await settle();
    expect(wrapper.get('main h1').text()).toBe('Experiments');
    expect(current()).toBe('Experiments');
    expect(wrapper.get('[data-test="build-agent"]').attributes('href')).toBe('#/build');
  });

  it('switches to the dark theme when chosen, and back', async () => {
    const wrapper = mount(App);
    await settle();
    const toggle = wrapper.get('[data-test="theme-toggle"]');
    await toggle.trigger('click');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(toggle.attributes('aria-pressed')).toBe('true');
    await toggle.trigger('click');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
