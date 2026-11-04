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
