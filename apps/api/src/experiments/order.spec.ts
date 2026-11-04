import { createHash } from 'node:crypto';
import { claimOrder, isSeed, newSeed, seededRandom, shuffle } from './order';

const TASKS = ['t1', 't2', 't3', 't4', 't5'];

describe('claimOrder (D32)', () => {
  it('is the same for the same seed and different for another', () => {
    const a = claimOrder(TASKS, ['A', 'B'], 4, 12345);
    expect(claimOrder(TASKS, ['A', 'B'], 4, 12345)).toEqual(a);
    expect(claimOrder(TASKS, ['A', 'B'], 4, 12346)).not.toEqual(a);
  });

  it('holds every slot exactly once', () => {
    const order = claimOrder(TASKS, ['A', 'B'], 3, 7);
    expect(order).toHaveLength(TASKS.length * 2 * 3);
    expect(new Set(order.map((s) => `${s.task}:${s.config}:${s.repeat}`)).size).toBe(order.length);
  });

  it('interleaves the arms: after every pair, each arm has run equally often', () => {
    for (const seed of [1, 2, 3, 99, 2 ** 32 - 1]) {
      const order = claimOrder(TASKS, ['A', 'B'], 6, seed);
      for (let i = 0; i < order.length; i += 2) {
        expect(new Set([order[i].config, order[i + 1].config])).toEqual(new Set(['A', 'B']));
        expect(order[i]).toMatchObject({ task: order[i + 1].task, repeat: order[i + 1].repeat });
      }
    }
  });

  it('is not the plan order: tasks and repeats come shuffled, and so does the arm inside a pair', () => {
    const order = claimOrder(TASKS, ['A', 'B'], 6, 42);
    const planOrder = order.map((s) => `${s.repeat}:${s.task}`).sort();
    expect(order.map((s) => `${s.repeat}:${s.task}`)).not.toEqual(planOrder);
    expect(order.filter((_, i) => i % 2 === 0).map((s) => s.config)).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('shuffles a pilot (one arm) too', () => {
    const order = claimOrder(TASKS, ['A'], 2, 5);
    expect(order).toHaveLength(10);
    expect(order.every((s) => s.config === 'A')).toBe(true);
  });

  it('draws from sha256("<seed>:<i>"), so the order can be rebuilt outside the API', () => {
    const rand = seededRandom(77);
    const first = createHash('sha256').update('77:0').digest().readUInt32BE(0) / 2 ** 32;
    expect(rand()).toBe(first);
    expect(shuffle([1, 2, 3], seededRandom(1))).toEqual(shuffle([1, 2, 3], seededRandom(1)));
  });

  it('makes seeds in range and checks given ones', () => {
    for (let i = 0; i < 20; i += 1) expect(isSeed(newSeed())).toBe(true);
    expect([0, 2 ** 32 - 1].every(isSeed)).toBe(true);
    expect([-1, 2 ** 32, 1.5, '3', null].some(isSeed)).toBe(false);
  });
});
