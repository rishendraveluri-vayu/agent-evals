import { parseSimReplies, simScope } from './sim-cache';

const hex = 'ab'.repeat(32);
const key = (c: string): string => `sha256:${c.repeat(64)}`;

describe('simScope', () => {
  const spec = {
    task: {
      client_sim: {
        model: { name: 'claude-haiku-5-5', temperature: 0, max_output_tokens: 300, prompt: { id: 'client-sim', sha256: hex } },
      },
    },
  };

  it('takes the simulator model, settings and prompt from the spec the worker ran', () => {
    expect(simScope('sha256:task', spec)).toEqual({
      task_sha256: 'sha256:task',
      sim_model: 'claude-haiku-5-5',
      temperature: 0,
      max_output_tokens: 300,
      prompt_sha256: `sha256:${hex}`,
    });
  });

  it('takes a null or absent temperature (not sent, D27) as its own scope', () => {
    const withModel = (model: Record<string, unknown>) => ({ task: { client_sim: { model: { ...spec.task.client_sim.model, ...model } } } });
    expect(simScope('sha256:task', withModel({ temperature: null }))?.temperature).toBeNull();
    const noTemperature: Record<string, unknown> = { ...spec.task.client_sim.model };
    delete noTemperature.temperature;
    expect(simScope('sha256:task', { task: { client_sim: { model: noTemperature } } })?.temperature).toBeNull();
    expect(simScope('sha256:task', withModel({ temperature: '0' }))).toBeNull();
  });

  it('is null for a task without a simulated client, or a spec it cannot read', () => {
    expect(simScope('sha256:task', { task: { client_sim: null } })).toBeNull();
    expect(simScope('sha256:task', null)).toBeNull();
    expect(simScope('sha256:task', { task: { client_sim: { model: { name: 'x', temperature: 0, max_output_tokens: 1.5, prompt: { sha256: hex } } } } })).toBeNull();
  });
});

describe('parseSimReplies', () => {
  it('keeps the first reply per key and says why it leaves any other line out', () => {
    const text = [
      JSON.stringify({ key: key('1'), reply: 'Will I lose the house?', model: 'sim-model', usage: { prompt_tokens: 3 } }),
      '',
      JSON.stringify({ key: key('1'), reply: 'a second reply for the same state' }),
      JSON.stringify({ key: key('2'), reply: 'Thanks. [[END_CONVERSATION]]' }),
      '{not json',
      JSON.stringify({ key: 'sha256:short', reply: 'x' }),
      JSON.stringify({ key: key('3'), reply: 7 }),
      JSON.stringify({ key: key('4'), reply: 'from another simulator', model: 'other-model' }),
    ].join('\n');
    const { rows, problems } = parseSimReplies(text, 'sim-model');
    expect(rows).toEqual([
      { key: key('1'), reply: 'Will I lose the house?', usage: { prompt_tokens: 3 } },
      { key: key('2'), reply: 'Thanks. [[END_CONVERSATION]]', usage: null },
    ]);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('line 5 is not JSON');
    expect(problems[3]).toContain('"other-model", not the simulator sim-model');
  });
});
