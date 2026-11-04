import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import compares from '../fixtures/compares.json';
import details from '../fixtures/experiment-details.json';
import experiments from '../fixtures/experiments.json';
import tasks from '../fixtures/tasks.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import TasksView from './TasksView.vue';

describe('TasksView in fixture mode', () => {
  useFixtures();

  it('sums up the task set and how many tasks separated the last two arms', async () => {
    const w = mount(TasksView);
    await settle();
    const glance = w.get('[data-test="task-glance"]').text();
    expect(glance).toContain('12 held-out, 12 discovery');
    expect(glance).toContain('16 code, 8 judge');
    expect(glance).toContain('18 single prompts, 6 conversations');
    expect(glance).toContain('Separated v1 and v2');
    expect(glance).toContain('2 of 12 held-out');
  });

  it('shows each task with its graders and last result, and filters by split', async () => {
    const w = mount(TasksView);
    await settle();
    const rows = () => w.findAll('[data-test="task-row"]');
    // "All" shows all 24, grouped by split under a heading row each, with no "Show all" button.
    expect(rows()).toHaveLength(24);
    expect(w.findAll('[data-test="group-row"]').map((g) => g.text())).toEqual(['Held-out (12)', 'Discovery (12)']);
    expect(w.get('[data-test="group-row"] th').attributes('colspan')).toBe('6');
    expect(w.findAll('button').some((b) => b.text().startsWith('Show'))).toBe(false);
    await w.findAll('.seg button').find((b) => b.text() === 'Held-out')?.trigger('click');
    expect(rows()).toHaveLength(12);
    expect(w.find('[data-test="group-row"]').exists()).toBe(false);
    expect(rows()[0].text()).toContain('distress-12');
    expect(rows()[0].get('[data-test="last-run"]').text()).toBe('A 1/5 · B 5/5');
    expect(rows()[0].get('[data-verdict]').attributes('data-verdict')).toBe('better');
    expect(rows()[0].get('[data-verdict]').text()).toBe('Better');
    expect(rows()[1].text()).toContain('Judge and state check');
    expect(w.get('[data-test="last-run-head"]').text()).toBe('Last run');
    expect(w.get('[data-test="last-run-head"]').classes()).toContain('last-run-head');
    const caption = w.get('[data-test="run-caption"]');
    expect(caption.text()).toBe('Last run: Prompt v1 vs v2, held-out, 5 trials per arm. No clear difference is not the same as unchanged.');
    expect(caption.classes()).toContain('result-detail');
    // The caption sits between the filters and the table.
    expect(caption.element.previousElementSibling?.classList.contains('filters')).toBe(true);
    expect(caption.element.nextElementSibling?.classList.contains('table-wrap')).toBe(true);
    const plain = rows().filter((r) => r.find('[data-verdict="none"]').exists());
    expect(plain.length).toBeGreaterThan(0);
    expect(plain[0].get('[data-verdict="none"]').text()).toBe('No clear difference');
    expect(rows()[0].get('.result-detail').text()).toBe('A 1/5 · B 5/5');
    await w.findAll('.seg button').find((b) => b.text() === 'Discovery')?.trigger('click');
    expect(rows()).toHaveLength(12);
    expect(rows()[0].text()).toContain('Not in this run');
  });
});

describe('TasksView against the API: a shipped example, no statistics', () => {
  it('names the last run by its example title and promises no per-task verdict', async () => {
    const example = { name: 'harness-ownloop-vs-hermes-haiku', title: 'Draft stand-in: own loop vs Hermes on Claude Haiku 5.5 (15 draft tasks, one trial each)', loaded_at: '2026-11-05T08:00:00.000Z' };
    const working = 'Label batch 1: open coding (R8, approved: 30 trials, cap $2)';
    const summary = (experiments as { id: string }[]).find((e) => e.id === 'exp_heldout');
    routeFetch({
      '/api/tasks': tasks,
      '/api/experiments': [{ ...summary, name: working, example }],
      '/api/experiments/exp_heldout': { ...(details as Record<string, object>).exp_heldout, name: working, example },
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null },
    });
    const w = mount(TasksView);
    await settle();
    const caption = w.get('[data-test="run-caption"]').text();
    expect(caption).toBe(`Last run: ${example.title}, 5 trials per arm. Pass counts only: this version does not compute a verdict per task.`);
    expect(w.text()).not.toContain('Label batch 1');
    expect(w.get('[data-test="task-glance"]').text()).toContain('needs the statistics step, not built in this version');
  });
});
