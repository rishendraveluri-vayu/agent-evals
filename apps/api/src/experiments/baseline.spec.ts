import { type BaselineInput, decideBaseline } from './baseline';

const sha = (c: string): string => `sha256:${c.repeat(64)}`;

const base = (over: Partial<BaselineInput> = {}): BaselineInput => ({
  parent: { id: 'e_parent', armA: sha('a'), tasks: [sha('1'), sha('2')], platformCommit: 'abc1234', simModel: null, simPromptSha256: null },
  armA: sha('a'),
  tasks: [sha('2'), sha('1')],
  platformCommit: 'abc1234',
  simModel: null,
  simPromptSha256: null,
  n: 2,
  finished: new Map([
    [sha('1'), ['t1', 't2', 't3']],
    [sha('2'), ['t4', 't5']],
  ]),
  ...over,
});

describe('decideBaseline (D34)', () => {
  it('reuses N finished trials per task when config, tasks, commit and simulator match', () => {
    const d = decideBaseline(base());
    expect(d.applied).toBe(true);
    expect(d.trialIds).toEqual(['t4', 't5', 't1', 't2']); // the first N of each task, in the parent's order
    expect(d.reason).toBe('arm A reuses 4 finished trials of e_parent (N=2 for each of 2 tasks): same config, tasks, platform commit abc1234 and simulator');
  });

  it.each<[string, Partial<BaselineInput>, string]>([
    ['another arm A', { armA: sha('b') }, "the parent's arm A is config aaaaaaaaaaaa, this arm A is bbbbbbbbbbbb"],
    ['another task set', { tasks: [sha('1')] }, 'the task sets differ (2 tasks in the parent, 1 here)'],
    ['another platform commit', { platformCommit: 'def5678' }, 'the platform commit differs (parent abc1234, now def5678)'],
    ['an unknown platform commit', { platformCommit: null }, 'the platform commit is not known for both'],
    ['another simulator model', { simModel: 'claude-haiku-5-5' }, 'the simulator model differs (parent none, here claude-haiku-5-5)'],
    ['too few finished trials', { n: 3 }, 'the parent has fewer than N=3 finished arm-A trials for 1 of 2 tasks (as few as 2)'],
  ])('runs arm A again for %s, and says why', (_what, over, why) => {
    const d = decideBaseline(base(over));
    expect(d.applied).toBe(false);
    expect(d.trialIds).toEqual([]);
    expect(d.reason).toMatch(/^arm A runs again: /);
    expect(d.reason).toContain(why);
  });

  it('checks the simulator prompt when the models match', () => {
    const parent = { ...base().parent, simModel: 'claude-haiku-5-5', simPromptSha256: sha('c') };
    expect(decideBaseline(base({ parent, simModel: 'claude-haiku-5-5', simPromptSha256: sha('c') })).applied).toBe(true);
    expect(decideBaseline(base({ parent, simModel: 'claude-haiku-5-5', simPromptSha256: sha('d') })).reason).toContain('the simulator prompt differs');
  });

  it('lists every reason, not only the first', () => {
    const d = decideBaseline(base({ platformCommit: 'def5678', n: 5 }));
    expect(d.reason).toContain('platform commit differs');
    expect(d.reason).toContain('fewer than N=5');
  });
});
