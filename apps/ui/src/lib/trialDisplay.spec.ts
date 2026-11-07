import { describe, expect, it } from 'vitest';
import { jsonForDisplay, modelCalls } from './trialDisplay';

describe('jsonForDisplay', () => {
  it("lays out a Hermes tool result with the tool's own JSON unescaped, every number as written", () => {
    // evals.tool.result of a live calculate_emi call (t_0mw38a1yo6a7e2cbbf94d52f9, 7 Nov), cut to three fields.
    const raw = '{"result": "{\\"emi\\":5287.11,\\"emi_formatted\\":\\"₹5,287.11\\",\\"final_payment\\":5287.10}"}';
    expect(jsonForDisplay(raw)).toBe(['{', '  "result": {', '    "emi": 5287.11,', '    "emi_formatted": "₹5,287.11",', '    "final_payment": 5287.10', '  }', '}'].join('\n'));
    expect(jsonForDisplay(raw)).not.toContain('\\"');
  });

  it('lays out arguments, nested lists and empty containers, and keeps keys and plain strings as they are', () => {
    expect(jsonForDisplay('{}')).toBe('{}');
    expect(jsonForDisplay('{"values": [7488.62, 17], "note": "a {brace} and a \\"quote\\"", "list": []}')).toBe(
      ['{', '  "values": [', '    7488.62,', '    17', '  ],', '  "note": "a {brace} and a \\"quote\\"",', '  "list": []', '}'].join('\n'),
    );
    // A string value that only starts like JSON stays a string.
    expect(jsonForDisplay('{"text": "[not json"}')).toBe('{\n  "text": "[not json"\n}');
  });

  it('shows text that is not JSON as it is, and older data that arrives as values', () => {
    expect(jsonForDisplay('Error: connection reset')).toBe('Error: connection reset');
    expect(jsonForDisplay({ amount: 35385 })).toBe('{\n  "amount": 35385\n}');
    expect(jsonForDisplay(undefined)).toBe('null');
  });
});

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
