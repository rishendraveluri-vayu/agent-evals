import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { builtInToolsets, loadFinanceServer } from '../catalogue/catalogue-files';
import { sha256Ref } from '../common/hashing';
import { PLATFORM_DEFAULTS } from '../configs/settings';
import { MODEL_KEY_ENV, SIM_KEY_ENV, SIM_MAX_OUTPUT_TOKENS, type SpecInputs, buildSpec, simTemperature } from './spec-builder';

const SCHEMA = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contract/v2/spec.schema.json'), 'utf8')) as object;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(SCHEMA);

const toolset = builtInToolsets(loadFinanceServer(path.resolve(__dirname, '../../../../services/finance-mcp')))[0];
const base: SpecInputs = {
  trial: { id: 't_abc123', experimentId: 'e_xyz', repeatIndex: 2, attempt: 1 },
  config: {
    id: 'c_0123456789ab',
    hash: `sha256:${'a'.repeat(64)}`,
    model: 'claude-haiku-5-5',
    apiFormat: 'openai_chat',
    settings: { ...PLATFORM_DEFAULTS, memory: null, skills: null, compression: null },
    settingsSources: {
      temperature: 'harness_default',
      max_output_tokens: 'platform_default',
      max_steps: 'platform_default',
      timeout_s: 'platform_default',
      parallel_tool_calls: 'platform_default',
      memory: 'unsupported',
      skills: 'unsupported',
      compression: 'unsupported',
    },
    harnessOptions: {},
  },
  task: {
    id: 'emi-basic-01',
    sha256: `sha256:${'b'.repeat(64)}`,
    split: 'discovery',
    body: { id: 'emi-basic-01', messages: [{ role: 'user', content: 'EMI on 10 lakh at 9% for 20 years?' }], client_sim: null, extra: 'kept' },
  },
  prompt: { id: 'finance-advisor', version: 'v1', sha256: sha256Ref('Be kind.\n'), text: 'Be kind.\n' },
  toolset,
  sim: null,
  modelBaseUrl: 'http://litellm:4000/v1',
};

function errors(spec: unknown): string {
  return validate(spec) ? '' : JSON.stringify(validate.errors);
}

describe('buildSpec', () => {
  it('builds a spec that validates against contract/v2/spec.schema.json', () => {
    const spec = buildSpec(base);
    expect(errors(spec)).toBe('');
    expect(spec.model).toEqual({ name: 'claude-haiku-5-5', base_url: 'http://litellm:4000/v1', api_key_env: MODEL_KEY_ENV, api_format: 'openai_chat' });
    expect(spec.trial).toMatchObject({ id: 't_abc123', experiment_id: 'e_xyz', task_version: base.task.sha256, task_split: 'discovery', repeat_index: 2 });
  });

  it("copies the task's required_tools into the spec, and leaves the field out without them", () => {
    const withTools = buildSpec({ ...base, task: { ...base.task, body: { ...base.task.body, required_tools: ['calculate_emi'] } } });
    expect(errors(withTools)).toBe('');
    expect((withTools.task as { required_tools?: string[] }).required_tools).toEqual(['calculate_emi']);
    expect(buildSpec(base).task).not.toHaveProperty('required_tools');
  });

  it('writes bare hex where contract v2 wants it and every finance tool in the built-in toolset', () => {
    const spec = buildSpec(base) as { system_prompt: { sha256: string }; tools: { toolset: { sha256: string }; mcp_servers: { allowed_tools: string[] }[] } };
    expect(spec.system_prompt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.tools.toolset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.tools.mcp_servers[0].allowed_tools).toHaveLength(11);
  });

  it('gives a simulated-client task the experiment simulator, at temperature 0 (D22)', () => {
    const simPrompt = { id: 'client-sim', version: 'v1', sha256: sha256Ref('You are {{persona}}.\n'), text: 'You are {{persona}}.\n' };
    const spec = buildSpec({
      ...base,
      task: {
        ...base.task,
        body: {
          messages: [{ role: 'user', content: 'Where do I start?' }],
          client_sim: {
            persona: 'Meera, 41 (invented test persona)',
            hidden_facts: ['Take-home Rs 92,000'],
            concerns: ['Can I keep the house?'],
            goal: 'Know whether she can keep the house',
            opening_message: 'Where do I start?',
            max_client_turns: 3,
            notes: 'not a contract field',
          },
        },
      },
      sim: { model: 'claude-haiku-5-5', temperature: 0, maxOutputTokens: 300, prompt: simPrompt },
    });
    expect(errors(spec)).toBe('');
    const sim = (spec.task as { client_sim: { model: { api_key_env: string; temperature: number }; notes?: string } }).client_sim;
    expect(sim.model.api_key_env).toBe(SIM_KEY_ENV);
    expect(sim.model.temperature).toBe(0);
    expect(sim.notes).toBeUndefined();
  });

  it('adds the client file summary and a null temperature for a simulator on Haiku 5.5 (D27)', () => {
    const simPrompt = { id: 'client-sim', version: 'v2', sha256: sha256Ref('{{client_summary}}\n'), text: '{{client_summary}}\n' };
    const taskSim = {
      persona: 'Meera, 41 (invented test persona)',
      hidden_facts: [],
      concerns: ['Can I keep the house?'],
      goal: 'Know whether she can keep the house',
      opening_message: 'Where do I start?',
      max_client_turns: 3,
    };
    const input = (clientSummary: string | null): SpecInputs => ({
      ...base,
      task: { ...base.task, body: { messages: [{ role: 'user', content: 'Where do I start?' }], client_sim: taskSim }, clientSummary },
      sim: { model: 'claude-haiku-5-5', temperature: simTemperature('claude-haiku-5-5'), maxOutputTokens: 300, prompt: simPrompt },
    });
    const spec = buildSpec(input('Profile:\n- name: Meera (synthetic)\nDebts: none recorded'));
    expect(errors(spec)).toBe('');
    const sim = (spec.task as { client_sim: { client_summary?: string; model: { temperature: number | null } } }).client_sim;
    expect(sim.client_summary).toBe('Profile:\n- name: Meera (synthetic)\nDebts: none recorded');
    expect(sim.model.temperature).toBeNull();
    // Without a client file the field is left out, not empty.
    const plain = buildSpec(input(null));
    expect(errors(plain)).toBe('');
    expect((plain.task as { client_sim: object }).client_sim).not.toHaveProperty('client_summary');
  });

  it("keeps D22's temperature 0 for a simulator model that takes it", () => {
    expect(simTemperature('claude-haiku-5-5')).toBeNull();
    expect(simTemperature('gemini-3.8-flash')).toBe(0);
    expect(simTemperature('fake/sim-client')).toBe(0);
  });

  it("gives the simulator room for Haiku 5.5's reasoning: 2048 tokens, as in the contract example", () => {
    // On 4 Nov a cap of 300 went entirely to reasoning and the simulator's reply was empty.
    expect(SIM_MAX_OUTPUT_TOKENS).toBe(2048);
    const example = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contract/v2/examples/spec-client-sim.json'), 'utf8')) as {
      task: { client_sim: { model: { max_output_tokens: number } } };
    };
    expect(example.task.client_sim.model.max_output_tokens).toBe(SIM_MAX_OUTPUT_TOKENS);
  });

  it('refuses a simulated-client task when the experiment has no simulator', () => {
    const body = { messages: [{ role: 'user', content: 'x' }], client_sim: { persona: 'p' } };
    expect(() => buildSpec({ ...base, task: { ...base.task, body } })).toThrow('no simulator model');
  });
});
