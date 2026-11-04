import { flushPromises } from '@vue/test-utils';
import { beforeAll, beforeEach, vi } from 'vitest';

/** Lets every pending load finish, including the lazy import of the fixtures. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Runs each test in the file in fixture mode (VITE_FIXTURES=1). The fixtures are loaded once
 *  up front, so the client's lazy import of them resolves at once inside a test. */
export function useFixtures(): void {
  beforeAll(async () => {
    await import('../fixtures');
  });
  beforeEach(() => {
    vi.stubEnv('VITE_FIXTURES', '1');
  });
}

export function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch stub that answers by path, 404 for anything else, and records every call. */
export function routeFetch(routes: Record<string, unknown>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const key = `${method} ${url}`;
    if (key in routes) return Promise.resolve(jsonReply(200, routes[key]));
    if (url in routes) return Promise.resolve(jsonReply(200, routes[url]));
    return Promise.resolve(jsonReply(404, { error: 'not_found', message: `no route for ${key}` }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}
