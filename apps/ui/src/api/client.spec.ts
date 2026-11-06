import { describe, expect, it, vi } from 'vitest';
import { jsonReply } from '../test/helpers';
import { api } from './client';
import { ApiError, errorWithFix } from './errors';

/** Every call answers with `reply` (or fails to connect when it throws). */
function answer(reply: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(reply));
}

async function failure(call: () => Promise<unknown>): Promise<ApiError> {
  try {
    await call();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('the call did not fail');
}

describe('the API client in an outage (destructive review U8)', () => {
  it('says the API is not answering when a proxy answers for it, never "POST /configs failed with HTTP 502"', async () => {
    answer(() => Promise.resolve(new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    const err = await failure(() => api.configs());
    expect(err.status).toBe(502);
    expect(err.message).toBe('The API is not answering (HTTP 502): check that the stack is running (docker compose ps), then try again');
    expect(err.message).not.toContain('/configs');
    answer(() => Promise.resolve(new Response('Gateway Timeout', { status: 504 })));
    expect((await failure(() => api.models())).message).toContain('The API is not answering (HTTP 504)');
  });

  it('says so in words when a web page comes back where data was expected, never "Unexpected token \'<\'"', async () => {
    answer(() => Promise.resolve(new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    const err = await failure(() => api.experiments());
    expect(err.code).toBe('not_json');
    expect(err.message).toBe('The API is not answering: the reply was a web page, not data. Check that the stack is running (docker compose ps), then try again');
    expect(err.message).not.toMatch(/Unexpected token|JSON/);
  });

  it('says LiteLLM is not answering, with what to do, when the API says so', async () => {
    answer(() => Promise.resolve(jsonReply(502, { error: 'litellm_unavailable', message: 'GET /model/info: fetch failed' })));
    const err = await failure(() => api.models());
    expect(errorWithFix(err)).toBe(
      'LiteLLM, the proxy every model call goes through, is not answering. Check that it is running (docker compose ps), start it with docker compose up -d litellm, then try again.',
    );
    expect(errorWithFix(err)).not.toContain('/model/info');
  });

  it('keeps the API’s own refusal and fix as they are', async () => {
    answer(() => Promise.resolve(jsonReply(400, { error: 'unsupported_setting', message: 'Qwen refuses parallel_tool_calls', fix: 'Leave it unset.' })));
    const err = await failure(() => api.configs());
    expect([err.status, err.code, err.message, err.fix]).toEqual([400, 'unsupported_setting', 'Qwen refuses parallel_tool_calls', 'Leave it unset.']);
  });

  it('says what to check when the API cannot be reached at all', async () => {
    answer(() => Promise.reject(new TypeError('Failed to fetch')));
    const err = await failure(() => api.configs());
    expect([err.status, err.code]).toEqual([0, 'unreachable']);
    expect(err.message).toBe('The API could not be reached: check that the stack is running (docker compose ps), then try again');
  });
});
