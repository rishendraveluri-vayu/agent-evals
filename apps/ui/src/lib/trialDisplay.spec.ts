import { describe, expect, it } from 'vitest';
import { modelCalls } from './trialDisplay';

describe('modelCalls', () => {
  it('pairs each request with its response, in both stored layouts, and counts requests once', () => {
    const calls = modelCalls([
      'result.json',
      'artifacts/proxy/0001.request.json',
      'artifacts/proxy/0001.response.json',
      'artifacts/proxy/0002.request.json',
      'requests/001.json',
      'responses/001.json',
      'trace.jsonl',
    ]);
    expect(calls).toEqual([
      { key: 'proxy:0001', request: 'artifacts/proxy/0001.request.json', response: 'artifacts/proxy/0001.response.json' },
      { key: 'proxy:0002', request: 'artifacts/proxy/0002.request.json', response: null },
      { key: 'old:001', request: 'requests/001.json', response: 'responses/001.json' },
    ]);
  });

  it('keeps a response with no request as its own row, so nothing stored is hidden', () => {
    expect(modelCalls(['responses/007.json'])).toEqual([{ key: 'old:007', request: null, response: 'responses/007.json' }]);
  });
});
