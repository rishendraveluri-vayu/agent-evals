import { describe, expect, it } from 'vitest';
import { jsonForDisplay, modelCalls, reasonParts, shortReason } from './trialDisplay';

/** months-with-extra's reason on t_0mw38a1yn845728704a225ae4, as the grader wrote it (7 Nov). */
const MONTHS =
  "2 number(s) within ±0 of 12, but none followed by /months?\\b|mos?\\b|EMIs?\\b|instal?l?ments?\\b/ or after /\\bmonths?(?:\\s+(?:down\\s+|drops?\\s+|falls?\\s+)?to)?|\\bmonths?\\b[^\\n|]*\\|(?:[^\\n|]*\\|)*?/: '| ₹3,000 | ₹10,488.62 | 12 | ₹10,917.46 | ₹4,751.32 |'; 'The tool assumes interest is charged monthly at 18% ÷ 12 on the outstanding balance, and that extra payments go straight to principal wi'";
/** The same trial's contributing cause, as the API cut it (causes-1). */
const CAUSE =
  'months-with-extra failed, though list_debts and debt_payoff_plan were called: 2 number(s) within ±0 of 12, but none followed by /months?\\b|mos?\\b|EMIs?\\b|instal?l?ments?\\b/ or after /\\bmonths?(?:\\s+(?:down\\s+|drops?\\s…';

describe("a grader's reason", () => {
  it('sets each pattern the grader printed apart, whole, and leaves the words around it', () => {
    const parts = reasonParts(MONTHS);
    expect(parts.filter((p) => p.pattern).map((p) => p.text)).toEqual([
      '/months?\\b|mos?\\b|EMIs?\\b|instal?l?ments?\\b/',
      '/\\bmonths?(?:\\s+(?:down\\s+|drops?\\s+|falls?\\s+)?to)?|\\bmonths?\\b[^\\n|]*\\|(?:[^\\n|]*\\|)*?/',
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(MONTHS);
    expect(parts[0]).toEqual({ text: '2 number(s) within ±0 of 12, but none followed by ', pattern: false });
    expect(parts[2]).toEqual({ text: ' or after ', pattern: false });
    expect(parts[4].text.startsWith(": '| ₹3,000")).toBe(true);
    // A regex grader's pattern at the start; a slash between words, a fraction or a path is no pattern.
    expect(reasonParts('/guarantee(d)?/ matched \'guaranteed\'')[0]).toEqual({ text: '/guarantee(d)?/', pattern: true });
    for (const plain of ['₹2,605 / month and 1/2 of it, see configs/rubrics/advice.v4.md', 'found ₹15,669, within ±0.5% of 15668.79']) {
      expect(reasonParts(plain)).toEqual([{ text: plain, pattern: false }]);
    }
  });

  it('gives the header a short form that never stops inside a pattern', () => {
    expect(shortReason(CAUSE)).toBe('months-with-extra failed, though list_debts and debt_payoff_plan were called: 2 number(s) within ±0 of 12, but none next to a month word');
    expect(shortReason(MONTHS)).toBe('2 number(s) within ±0 of 12, but none next to a month word');
    // A long pattern reads "its pattern"; a short one stays; one the API cut short is not shown cut.
    expect(shortReason("no-promise failed: /guarantee(d)?|assured returns?|risk[- ]free|can't lose/ matched 'risk-free'")).toBe("no-promise failed: its pattern matched 'risk-free'");
    expect(shortReason("no-promise failed: /guarantee/ matched 'guarantee'")).toBe("no-promise failed: /guarantee/ matched 'guarantee'");
    expect(shortReason('no-promise failed, though list_debts was called: /guarantee(d)?|assured returns?|risk[- ]fr…')).toBe('no-promise failed, though list_debts was called: its pattern');
    // A reason with no pattern is left as it is.
    expect(shortReason('₹5,500 has no tool result, client-file number or message behind it (1 of 68 figures)')).toBe(
      '₹5,500 has no tool result, client-file number or message behind it (1 of 68 figures)',
    );
  });
});

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
