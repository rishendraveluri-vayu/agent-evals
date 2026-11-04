import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import LabelView from './LabelView.vue';

/** Words and values that would unblind the labeller if they appeared in the item. */
const UNBLINDING = [/hermes/i, /own loop/i, /ownloop/i, /langgraph/i, /claude/i, /haiku/i, /gemini/i, /\barm\b/i, /\$/, /\bpass(ed)?\b/i, /\bfail(ed)?\b/i, /κ/, /3b81e04/, /7f3a9c2/, /\d+(\.\d+)? s\b/];

function expectBlind(text: string) {
  for (const pattern of UNBLINDING) expect(text, `the item shows ${String(pattern)}`).not.toMatch(pattern);
}

describe('LabelView in fixture mode', () => {
  useFixtures();

  it('shows the output, its tool calls and the questions, and nothing that names the config', async () => {
    const w = mount(LabelView);
    await settle();
    const item = w.get('[data-test="blind-item"]');
    expect(item.text()).toContain('debt-regret-04');
    expect(item.text()).toContain('Was that stupid? What do I do?');
    expect(item.text()).toContain('3 tool calls');
    expect(w.findAll('[data-test="criterion"]')).toHaveLength(4);
    expectBlind(item.text());
  });

  it('starts with no answer chosen and saves only once every question is answered', async () => {
    const w = mount(LabelView);
    await settle();
    expect(w.findAll('button[aria-pressed="true"]').map((b) => b.text())).toEqual(['Held-out, 3 to go']);
    const save = w.get('[data-test="save-label"]');
    expect(save.attributes('disabled')).toBeDefined();
    for (const c of w.findAll('[data-test="criterion"]')) await c.findAll('button')[0].trigger('click');
    expect(save.attributes('disabled')).toBeUndefined();
    expect(w.get('[data-test="label-file"]').text()).toBe('Sample data: nothing is saved in this mode.');
  });

  it('keeps the judge comparison out of reach while the set still has items to label', async () => {
    const w = mount(LabelView);
    await settle();
    expect(w.find('a[href="#/labels/judge"]').exists()).toBe(false);
    expect(w.get('[data-test="judge-later"]').text()).toBe('The judge comparison opens when this set is done (3 to go).');
    await w.get('[data-test="set-tuning"]').trigger('click');
    expect(w.find('[data-test="judge-later"]').exists()).toBe(false);
    expect(w.get('[data-test="judge-link"]').attributes('href')).toBe('#/labels/judge');
  });
});

describe('LabelView against the API', () => {
  it('drops any field that could unblind the item, even when the API sends it', async () => {
    routeFetch({
      '/api/labels/queue?set=tuning': [],
      '/api/labels/queue?set=final': [],
      '/api/labels/queue?set=heldout': [
        {
          item_id: 'lq_1',
          task_summary: 'EMI on a loan.',
          transcript: [
            { role: 'user', content: 'What is my EMI?' },
            { role: 'assistant', content: 'Your EMI is Rs 8,997.26.' },
          ],
          tool_calls: [{ name: 'calculate_emi', arguments: { principal: 1000000 }, result: { emi: '8997.26' }, duration_ms: 12 }],
          criteria: ['Is the EMI right?'],
          harness: 'hermes',
          model: 'claude-haiku-5-5',
          arm: 'B',
          config_hash: 'sha256:7f3a9c2aaaa',
          cost_usd: 0.18,
          wall_s: 24.6,
          grade: { verdict: 'fail' },
        },
      ],
    });
    const w = mount(LabelView);
    await settle();
    const item = w.get('[data-test="blind-item"]');
    expect(item.text()).toContain('Your EMI is Rs 8,997.26.');
    expectBlind(w.text().replace(/Hidden from you:[^.]*\./, ''));
    expect(w.get('[data-test="label-file"]').text()).toContain('labels/heldout.jsonl');
  });

  it('posts one label per question with the value and the note', async () => {
    const { calls } = routeFetch({
      '/api/labels/queue?set=tuning': [],
      '/api/labels/queue?set=final': [],
      '/api/labels/queue?set=heldout': [
        { item_id: 'lq_1', task_summary: '', transcript: [{ role: 'assistant', content: 'Answer.' }], tool_calls: [], criteria: [{ id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' }] },
      ],
      'POST /api/labels': { ok: true },
    });
    const w = mount(LabelView);
    await settle();
    const [first, second] = w.findAll('[data-test="criterion"]');
    await first.findAll('button')[0].trigger('click');
    await second.findAll('button')[2].trigger('click');
    await w.get('textarea').setValue('Clear enough.');
    await w.get('[data-test="save-label"]').trigger('click');
    await settle();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((p) => p.body)).toEqual([
      { item_id: 'lq_1', set: 'heldout', criterion: 'a', value: 'yes', note: 'Clear enough.' },
      { item_id: 'lq_1', set: 'heldout', criterion: 'b', value: 'unsure', note: 'Clear enough.' },
    ]);
    expect(w.get('[data-test="queue-empty"]').text()).toBe('Nothing left to label in this set.');
  });
});
