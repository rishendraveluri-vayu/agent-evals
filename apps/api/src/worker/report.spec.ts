import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ApiError } from '../common/api-error';
import type { JsonObject } from '../contract';
import { configErrorReason, parseReport, reportedSha, spanRows, usageOf } from './report';

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
    expect(reason).toContain('POST /experiments/:id/start to resume');
    expect(configErrorReason(result(temperatureSdk), configReport)).toContain(': `temperature` is deprecated for this model.');
  });

  it('still says something without a result or a provider message', () => {
    expect(configErrorReason(null, { ...configReport, proxy_usage: null })).toMatch(/^infra:config_error \(LiteLLM status unknown\)\. New claims are paused/);
    expect(configErrorReason(result('HTTP 401: no JSON here'), configReport)).toContain(': HTTP 401: no JSON here.');
  });
});
