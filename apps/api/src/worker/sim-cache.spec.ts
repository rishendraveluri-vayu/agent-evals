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

  it('never caches an empty simulator reply (D26), but keeps the end marker alone', () => {
    // The 4 Nov Haiku reply: the whole token cap went to reasoning, so there is no text.
    const usage = { completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 300, text_tokens: 0 } };
    const text = [
      JSON.stringify({ key: key('1'), reply: '', model: 'sim-model', usage, error: 'reply has no text' }),
      JSON.stringify({ key: key('2'), reply: '[[END_CONVERSATION]]', model: 'sim-model', error: 'reply holds only the end marker, before the client has said anything' }),
      JSON.stringify({ key: key('3'), reply: ' \n', model: 'sim-model', usage }), // unmarked, from an older adapter
      JSON.stringify({ key: key('4'), reply: '[[END_CONVERSATION]]', model: 'sim-model' }), // after the client's own goodbye
    ].join('\n');
    const { rows, problems } = parseSimReplies(text, 'sim-model');
    expect(rows).toEqual([{ key: key('4'), reply: '[[END_CONVERSATION]]', usage: null }]);
    expect(problems).toEqual(['sim_replies.jsonl line 3 has an empty reply; not cached']);
  });

  it('never caches a reply with a NUL in it, and stores its usage without one (E7)', () => {
    const text = [
      JSON.stringify({ key: key('1'), reply: 'half\u0000a reply', model: 'sim-model' }),
      JSON.stringify({ key: key('2'), reply: 'fine', model: 'sim-model', usage: { note: 'n\u0000' } }),
    ].join('\n');
    const { rows, problems } = parseSimReplies(text, 'sim-model');
    expect(rows).toEqual([{ key: key('2'), reply: 'fine', usage: { note: 'n\uFFFD' } }]);
    expect(problems).toEqual(['sim_replies.jsonl line 1 has a NUL character in its reply; not cached']);
  });
});
