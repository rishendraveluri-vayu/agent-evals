import type { Settings } from '../contract';
import { CHECKER_MAX_TOKENS, callCost, checkInputSha, checkerInput, parseFindings, replyOf, worstCaseUsd } from './conflict-check';

const SETTINGS: Settings = {
  temperature: null,
  max_output_tokens: 8192,
  max_steps: 15,
  timeout_s: 300,
  parallel_tool_calls: false,
  memory: { enabled: false },
  skills: { enabled: false },
  compression: { enabled: false },
};

const FINDING = { harness_says: 'batch them', we_say: 'settings.parallel_tool_calls = false', why_it_matters: 'It will try to batch and cannot.', severity: 'high' };

describe('parseFindings', () => {
  it('reads a plain JSON reply', () => {
    const out = parseFindings(JSON.stringify({ conflicts: [FINDING], notes: ' One clear clash. ' }));
    expect(out).toEqual({ ok: true, findings: { conflicts: [FINDING], notes: 'One clear clash.' } });
  });

  it('reads a reply in a code fence or with prose around it, and normalises severity case', () => {
    const body = JSON.stringify({ conflicts: [{ ...FINDING, severity: 'High' }], notes: '' });
    for (const text of ['```json\n' + body + '\n```', `Here is the result:\n${body}\nDone.`]) {
      const out = parseFindings(text);
      expect(out.ok && out.findings.conflicts[0].severity).toBe('high');
    }
  });

  it('accepts no conflicts and a missing notes field', () => {
    expect(parseFindings('{"conflicts": []}')).toEqual({ ok: true, findings: { conflicts: [], notes: '' } });
  });

  it('refuses anything it would have to guess at', () => {
    expect(parseFindings('I found two conflicts.')).toMatchObject({ ok: false });
    expect(parseFindings('{"findings": []}')).toMatchObject({ ok: false, error: expect.stringContaining('no conflicts list') as string });
    expect(parseFindings(JSON.stringify({ conflicts: [{ ...FINDING, severity: 'critical' }] }))).toMatchObject({ ok: false, error: expect.stringContaining('severity') as string });
    expect(parseFindings(JSON.stringify({ conflicts: [{ ...FINDING, we_say: '' }] }))).toMatchObject({ ok: false, error: expect.stringContaining('we_say') as string });
    expect(parseFindings(JSON.stringify({ conflicts: [], notes: 3 }))).toMatchObject({ ok: false });
    // A reply cut off at max_tokens is not JSON.
    expect(parseFindings('{"conflicts": [{"harness_says": "batch')).toMatchObject({ ok: false });
  });
});

describe('the checker input and its cache key', () => {
  it('puts the three inputs in their own blocks', () => {
    const text = checkerInput('Hermes says <<OUR TASK PROMPT>>', 'Our prompt\n', SETTINGS);
    expect(text).toContain('<harness_text>\nHermes says <<OUR TASK PROMPT>>\n</harness_text>');
    expect(text).toContain('<task_prompt>\nOur prompt\n</task_prompt>');
    expect(text).toContain('"parallel_tool_calls": false');
  });

  it('changes with the settings, so configs with the same rendered prompt do not share findings', () => {
    const base = { renderedSha256: 'sha256:aa', promptSha256: 'sha256:bb', settings: SETTINGS };
    expect(checkInputSha(base)).toBe(checkInputSha({ ...base, settings: { ...SETTINGS } }));
    expect(checkInputSha(base)).not.toBe(checkInputSha({ ...base, settings: { ...SETTINGS, max_steps: 5 } }));
    expect(checkInputSha(base)).not.toBe(checkInputSha({ ...base, renderedSha256: 'sha256:cc' }));
  });
});

describe('worstCaseUsd', () => {
  it('counts every two characters as an input token and the whole max_tokens as output', () => {
    // Sonnet 5.5: $2 in, $10 out per million tokens.
    const usd = worstCaseUsd(10_000, { inputPerToken: 0.000002, outputPerToken: 0.00001 });
    expect(usd).toBeCloseTo(5_000 * 0.000002 + CHECKER_MAX_TOKENS * 0.00001, 9);
    expect(usd).toBeCloseTo(0.03, 9);
  });
});

describe('callCost', () => {
  it('takes cost and tokens from LiteLLM spend-log rows', () => {
    const rows = [{ request_id: 'r1', spend: 0.0123, prompt_tokens: 3000, completion_tokens: 400 }];
    expect(callCost(rows, { body: null, responseCostUsd: 99 })).toEqual({ costUsd: 0.0123, source: 'spend_log', inputTokens: 3000, outputTokens: 400, requestId: 'r1' });
  });

  it('falls back to the response-cost header, then to unknown', () => {
    const body = { id: 'chatcmpl-1', usage: { prompt_tokens: 10, completion_tokens: 2 } };
    expect(callCost([], { body, responseCostUsd: 0.001 })).toEqual({ costUsd: 0.001, source: 'response_header', inputTokens: 10, outputTokens: 2, requestId: 'chatcmpl-1' });
    expect(callCost([], { body: null, responseCostUsd: null })).toMatchObject({ costUsd: null, source: 'unknown' });
  });
});

describe('replyOf', () => {
  it('reads the text and finish reason of an OpenAI-format reply', () => {
    expect(replyOf({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] })).toEqual({ text: '{}', finishReason: 'length' });
    expect(replyOf({})).toEqual({ text: null, finishReason: null });
  });
});
