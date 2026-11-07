import { calibrationOrder, shuffled } from './calibration-order';

/** D83's calibrating queue on made-up items: each item is its id, and its judge verdict is in `verdicts`. */
const verdicts: Record<string, string | undefined> = { p1: 'yes', p2: 'yes', p3: 'yes', p4: 'yes', f1: 'no', f2: 'no', n1: undefined, e1: 'error' };
const items = Object.keys(verdicts);
const of = (id: string) => verdicts[id];

describe('the calibrating queue (D83, review 7 Nov)', () => {
  it('is only a balanced block: k passes and k fails (k the smaller count), nothing of the larger kind left over, nothing without a yes or no', () => {
    for (let run = 0; run < 50; run += 1) {
      const order = calibrationOrder(items, of);
      // k = 2: four items, two of each, and no other.
      expect(order).toHaveLength(4);
      expect(order.map(of).sort()).toEqual(['no', 'no', 'yes', 'yes']);
      expect(new Set(order).size).toBe(4);
      expect(order).not.toContain('n1');
      expect(order).not.toContain('e1');
    }
  });

  it('does not give the verdict away by position: the first item is not always a pass, nor the order the old alternation', () => {
    const firsts = new Set<string | undefined>();
    const balanced = new Set<string>();
    for (let run = 0; run < 200; run += 1) {
      const order = calibrationOrder(items, of);
      firsts.add(of(order[0]));
      balanced.add(order.map(of).join(','));
    }
    expect(firsts).toEqual(new Set(['yes', 'no']));
    // Every arrangement of two passes and two fails turns up, alternation among them but not alone.
    expect(balanced.size).toBe(6);
  });

  it('draws which of the larger kind are in the block at random', () => {
    const picked = new Set<string>();
    for (let run = 0; run < 200; run += 1) for (const id of calibrationOrder(items, of)) if (of(id) === 'yes') picked.add(id);
    expect(picked).toEqual(new Set(['p1', 'p2', 'p3', 'p4']));
  });

  it('is drawn at random, so the same input is not always the same order', () => {
    const orders = new Set(Array.from({ length: 50 }, () => calibrationOrder(items, of).join(',')));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('takes a random source', () => {
    // A source that always picks the first slot: Fisher-Yates then rotates the list by one.
    const first = () => 0;
    expect(shuffled(['a', 'b', 'c'], first)).toEqual(['b', 'c', 'a']);
    const order = calibrationOrder(items, of, first);
    expect(order.map(of).sort()).toEqual(['no', 'no', 'yes', 'yes']);
  });

  it('is empty when the judge gave only one kind, and for an empty list', () => {
    expect(calibrationOrder([], of)).toEqual([]);
    expect(calibrationOrder(['p1', 'p2', 'n1'], of)).toEqual([]);
    expect(calibrationOrder(['f1', 'e1'], of)).toEqual([]);
  });
});
