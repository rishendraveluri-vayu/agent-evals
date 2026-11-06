import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ApiError } from '../common/api-error';
import type { JsonObject } from '../contract';
import { configErrorFix, configErrorReason, parseReport, reportedSha, spanRows, spendLogUsage, usageOf, withoutNul } from './report';

const EXAMPLES = path.resolve(__dirname, '../../../../contract/v2/examples');
const exampleSpans = readFileSync(path.join(EXAMPLES, 'trace.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const exampleReport = JSON.parse(readFileSync(path.join(EXAMPLES, 'runner-report.json'), 'utf8')) as Record<string, unknown>;

describe('parseReport', () => {
  const ok = { worker_id: 'w1', attempt: 1, runner_report: exampleReport, result: null, spans: [], files: [] };

  it('accepts a runner report with no result (an adapter crash)', () => {
    expect(parseReport(ok).result).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ['no worker', { worker_id: '' }],
    ['attempt 0', { attempt: 0 }],
    ['no runner report', { runner_report: null }],
    ['an unknown label', { runner_report: { ...exampleReport, label: 'passed' } }],
    ['a bad file entry', { files: [{ path: 'a' }] }],
  ])('refuses %s', (_what, change) => {
    expect(() => parseReport({ ...ok, ...change })).toThrow(ApiError);
  });

  it('takes file hashes as sha256:<hex> or bare hex and keeps them as sha256:<hex>', () => {
    const hex = 'ab'.repeat(32);
    const files = [
      { path: 'a.json', bytes: 1, sha256: hex },
      { path: 'b.json', bytes: 1, sha256: `sha256:${hex}` },
      { path: 'c.json', bytes: 1, sha256: ` SHA256:${hex.toUpperCase()} ` },
      { path: 'd.json', bytes: 1, sha256: 'md5:abc' },
    ];
    expect(parseReport({ ...ok, files }).files.map((f) => f.sha256)).toEqual([`sha256:${hex}`, `sha256:${hex}`, `sha256:${hex}`, 'md5:abc']);
    expect(reportedSha(hex.toUpperCase())).toBe(`sha256:${hex}`);
  });
});

describe('spanRows', () => {
  it('keeps the example trace, with attributes as plain values', () => {
    const { rows, problems } = spanRows(exampleSpans);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(exampleSpans.length);
    const tool = rows.find((r) => r.name.startsWith('execute_tool'));
    expect(tool?.attributes['gen_ai.tool.name']).toBe('calculate_emi');
    expect(rows.find((r) => r.parent_span_id === null)?.name).toBe('invoke_agent scripted');
  });

  it('skips spans it cannot store, saying why, and stores a repeated span id once', () => {
    const [first] = exampleSpans;
    const { rows, problems } = spanRows([first, first, { name: 'x' }, { ...first, spanId: 'ffffffffffffffff', startTimeUnixNano: 12 }]);
    expect(rows).toHaveLength(1);
    expect(problems).toHaveLength(3);
  });
});

describe('usageOf', () => {
  it('takes the proxy usage as the truth and adds the simulator spend from its spans', () => {
    const sim = {
      ...exampleSpans[0],
      spanId: 'eeeeeeeeeeeeeeee',
      name: 'chat claude-haiku-5-5',
      attributes: [
        { key: 'evals.role', value: { stringValue: 'sim' } },
        { key: 'evals.cost_usd', value: { doubleValue: 0.0004 } },
      ],
    };
    const { rows } = spanRows([...exampleSpans, sim]);
    const report = { ...exampleReport, proxy_usage: { complete: true, model_calls: 2, failed_calls: 0, input_tokens: 100, output_tokens: 20, cost_usd: 0.001, last_status: '200' } };
    const usage = usageOf(report, null, rows);
    expect(usage).toMatchObject({ cost_usd: 0.001, input_tokens: 100, output_tokens: 20, model_calls: 2, proxy_complete: true, sim_cost_usd: 0.0004 });
  });

  it('leaves usage unknown (null, never zero) when the trial had no proxy record', () => {
    const usage = usageOf({ ...exampleReport, proxy_usage: null }, null, []);
    expect(usage.cost_usd).toBeNull();
    expect(usage.sim_cost_usd).toBeNull();
  });

  it('takes only finite numbers of at least 0, clamps counts to the integer column, and says what it refused (E8)', () => {
    const problems: string[] = [];
    const report = {
      ...exampleReport,
      proxy_usage: { complete: true, model_calls: -1, input_tokens: 3_000_000_000, output_tokens: 1.5, cost_usd: -1000, last_status: '200' },
      timing: { wall_s: -99 },
    };
    const sim = { ...exampleSpans[0], spanId: 'eeeeeeeeeeeeeeee', name: 'chat sim', attributes: [{ key: 'evals.role', value: { stringValue: 'sim' } }, { key: 'evals.cost_usd', value: { doubleValue: -5 } }] };
    const usage = usageOf(report, null, spanRows([sim]).rows, problems);
    expect(usage).toMatchObject({ cost_usd: null, input_tokens: 2_147_483_647, output_tokens: null, model_calls: null, wall_s: null, sim_cost_usd: 0 });
    expect(problems).toEqual([
      'span eeeeeeeeeeeeeeee evals.cost_usd -5 is not a number of at least 0; stored as unknown',
      'proxy_usage.cost_usd -1000 is not a number of at least 0; stored as unknown',
      'proxy_usage.input_tokens 3000000000 is more than the 2147483647 the database holds; stored as 2147483647',
      'proxy_usage.output_tokens 1.5 is not a whole number of at least 0; stored as unknown',
      'proxy_usage.model_calls -1 is not a whole number of at least 0; stored as unknown',
      'timing.wall_s -99 is not a number of at least 0; stored as unknown',
    ]);
    // A runner's ordinary report says nothing.
    const quiet: string[] = [];
    usageOf({ ...exampleReport, proxy_usage: { complete: true, model_calls: 2, input_tokens: 100, output_tokens: 20, cost_usd: 0.001 }, timing: { wall_s: 1.2 } }, null, [], quiet);
    expect(quiet).toEqual([]);
  });

  it('keeps a span whose kind or status code is out of the column range, with the defaults (E8)', () => {
    const { rows } = spanRows([{ ...exampleSpans[0], kind: 99_999, status: { code: -40_000 } }]);
    expect(rows[0]).toMatchObject({ kind: 1, status_code: 0 });
    expect(spanRows([{ ...exampleSpans[0], kind: 3, status: { code: 2 } }]).rows[0]).toMatchObject({ kind: 3, status_code: 2 });
  });
});

describe('configErrorReason (D26)', () => {
  const configReport = JSON.parse(readFileSync(path.join(EXAMPLES, 'runner-report-config-error.json'), 'utf8')) as JsonObject;
  // Exactly as the own loop and the Agents SDK reported the 4 Nov 400s.
  const unscoped =
    'Error code: 400 - litellm.BadRequestError: AnthropicException - {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace."},"request_id":"req_011CghWkuA86P2P7Ev167Xxo"}. Received Model Group=claude-haiku-5-5\nAvailable Model Group Fallbacks=None';
  const temperatureSdk =
    'Error code: 400 - {\'error\': {\'message\': \'litellm.BadRequestError: AnthropicException - {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."},"request_id":"req_011Cghb1y9rKSsk3uuNY1phY"}. Received Model Group=claude-haiku-5-5\\nAvailable Model Group Fallbacks=None\', \'type\': None, \'param\': None, \'code\': \'400\'}}';
  const result = (message: string | null) => ({ end_state: 'harness_error', end_detail: { harness_stop_reason: 'model call failed: BadRequestError', exception_message: message } });

  it("names LiteLLM's status and the provider's own message", () => {
    expect(configReport.label).toBe('infra:config_error');
    const reason = configErrorReason(result(unscoped), configReport);
    expect(reason).toContain('infra:config_error (LiteLLM status 400): This API key is not scoped to a workspace');
    expect(configErrorReason(result(temperatureSdk), configReport)).toContain(': `temperature` is deprecated for this model.');
  });

  it('still says something without a result or a provider message', () => {
    expect(configErrorReason(null, { ...configReport, proxy_usage: null })).toBe('infra:config_error (LiteLLM status unknown)');
    expect(configErrorReason(result('HTTP 401: no JSON here'), configReport)).toContain(': HTTP 401: no JSON here');
  });
});

describe('configErrorFix (D37)', () => {
  const report = (status: string | null) => ({ proxy_usage: status === null ? null : { last_status: status } });

  it.each([
    ['401', "fix the provider key or its permissions in LiteLLM's environment"],
    ['403', "fix the provider key or its permissions in LiteLLM's environment"],
    ['404', "fix the model's route in LiteLLM's config"],
    ['400', 'A setting the model rejects needs a forked config without it and a new experiment'],
    [null, "Find the setup problem in the trial's result and LiteLLM's logs"],
  ])('says how to fix a %s and how to resume the arm', (status, text) => {
    const fix = configErrorFix(report(status));
    expect(fix).toContain(text);
    expect(fix).toContain('/arms/:config_hash/resume');
  });
});

describe("an abandoned attempt's spend from LiteLLM's spend log (G3)", () => {
  it('sums spend and tokens as the runner sums a reported trial, one row per call, failed calls included', () => {
    const agent = [
      { request_id: 'a', status: 'success', spend: 0.0101, prompt_tokens: 1000, completion_tokens: 90 },
      { request_id: 'b', status: 'failure', spend: 0, prompt_tokens: 0, completion_tokens: 0 },
      { request_id: 'c', status: 'success', spend: '0.0002', prompt_tokens: 50, completion_tokens: 10 },
    ];
    expect(spendLogUsage(agent, [{ spend: 0.003 }, { spend: 0.001 }])).toEqual({ cost_usd: 0.0103, sim_cost_usd: 0.004, input_tokens: 1050, output_tokens: 100, model_calls: 3 });
  });

  it('is zero for a key with no calls, and has no simulator cost without a simulator key', () => {
    expect(spendLogUsage([], null)).toEqual({ cost_usd: 0, sim_cost_usd: null, input_tokens: 0, output_tokens: 0, model_calls: 0 });
    expect(spendLogUsage([], []).sim_cost_usd).toBe(0);
  });

  it('skips rows that are not objects and fields that are not numbers', () => {
    expect(spendLogUsage(['x', null, { spend: 'n/a', prompt_tokens: 'many' }, { spend: 0.5, prompt_tokens: 7 }], null)).toMatchObject({ cost_usd: 0.5, input_tokens: 7, model_calls: 2 });
  });
});

describe('withoutNul (E7)', () => {
  it('replaces every NUL in strings and keys with U+FFFD, deep, and counts them', () => {
    const sent = { a: 'x\u0000y\u0000', list: ['ok', { 'k\u0000': 'v' }], n: 3, t: true, z: null };
    const { value, replaced } = withoutNul(sent);
    expect(replaced).toBe(3);
    expect(value).toEqual({ a: 'x\uFFFDy\uFFFD', list: ['ok', { 'k\uFFFD': 'v' }], n: 3, t: true, z: null });
    expect(JSON.stringify(value)).not.toContain('\\u0000');
    expect(sent.a).toBe('x\u0000y\u0000'); // a copy: the input is not changed
  });

  it('leaves a body without NUL equal, and keeps a "__proto__" key a plain key', () => {
    const body = JSON.parse('{"__proto__": {"polluted": true}, "b": [1, "two"]}') as Record<string, unknown>;
    const { value, replaced } = withoutNul(body);
    expect(replaced).toBe(0);
    expect(Object.keys(value as object)).toEqual(['__proto__', 'b']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
