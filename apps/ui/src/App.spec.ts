import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import App from './App.vue';

function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('App', () => {
  it('shows the project name and a loading state before the API answers', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    const wrapper = mount(App);

    expect(wrapper.get('h1').text()).toBe('Agent Evals Platform');
    expect(wrapper.find('[data-test="health-loading"]').exists()).toBe(true);
  });

  it('renders status and db from /api/health', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonReply(200, { status: 'ok', db: 'up' })));
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(App);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything());
    expect(wrapper.get('[data-test="health-status"]').text()).toBe('ok');
    expect(wrapper.get('[data-test="health-db"]').text()).toBe('up');
    expect(wrapper.find('[data-test="health-loading"]').exists()).toBe(false);
  });

  it('renders db down from a 503 reply, since the API itself answered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonReply(503, { status: 'ok', db: 'down' }))),
    );

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get('[data-test="health-db"]').text()).toBe('down');
    expect(wrapper.find('[data-test="health-unreachable"]').exists()).toBe(false);
  });

  it('renders the unreachable state when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    const wrapper = mount(App);
    await flushPromises();

    const message = wrapper.get('[data-test="health-unreachable"]');
    expect(message.text()).toContain('API unreachable');
    expect(message.text()).toContain('Failed to fetch');
    expect(wrapper.find('[data-test="health-ok"]').exists()).toBe(false);
  });

  it('renders the unreachable state for a proxy error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 }))),
    );

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.get('[data-test="health-unreachable"]').text()).toContain('HTTP 502');
  });
});
