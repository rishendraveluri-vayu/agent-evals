import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { settle, useFixtures } from '../test/helpers';
import TasksView from './TasksView.vue';

useFixtures();

describe('TasksView in fixture mode', () => {
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
    const rows = () => w.findAll('[data-test="tasks-table"] tbody tr');
    expect(rows()).toHaveLength(12);
    expect(rows()[0].text()).toContain('distress-12');
    expect(rows()[0].get('[data-test="last-run"]').text()).toBe('A 1/5 · B 5/5');
    expect(rows()[0].get('[data-verdict]').attributes('data-verdict')).toBe('better');
    expect(rows()[0].get('[data-verdict]').text()).toBe('Better');
    expect(rows()[1].text()).toContain('Judge and state check');
    expect(w.get('[data-test="last-run-head"]').text()).toBe('Last run: Prompt v1 vs v2, held-out');
    const plain = rows().filter((r) => r.find('[data-verdict="none"]').exists());
    expect(plain.length).toBeGreaterThan(0);
    expect(plain[0].get('[data-verdict="none"]').text()).toBe('No clear difference');
    await w.findAll('button').find((b) => b.text() === 'Show all 24 tasks')?.trigger('click');
    expect(rows()).toHaveLength(24);
    await w.findAll('.seg button').find((b) => b.text() === 'Discovery')?.trigger('click');
    expect(rows()).toHaveLength(12);
    expect(rows()[0].text()).toContain('Not in this run');
  });
});
