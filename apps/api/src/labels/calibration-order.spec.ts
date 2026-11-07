import { calibrationOrder, shuffled } from './calibration-order';

/** D83's calibrating order on made-up items: each item is its id, and its judge verdict is in `verdicts`. */
const verdicts: Record<string, string | undefined> = { p1: 'yes', p2: 'yes', p3: 'yes', p4: 'yes', f1: 'no', f2: 'no', n1: undefined, e1: 'error' };
const items = Object.keys(verdicts);
const of = (id: string) => verdicts[id];

describe('the calibrating order (D83, review 7 Nov)', () => {
  it('puts k passes and k fails first (k the smaller count), then the rest of the larger kind, then the items with no yes or no', () => {
    for (let run = 0; run < 50; run += 1) {
      const order = calibrationOrder(items, of);
      expect([...order].sort()).toEqual([...items].sort());
      const kinds = order.map((id) => of(id) ?? 'none');
      // k = 2: the first four hold exactly two of each.
      expect(kinds.slice(0, 4).filter((v) => v === 'yes')).toHaveLength(2);
      expect(kinds.slice(0, 4).filter((v) => v === 'no')).toHaveLength(2);
      expect(kinds.slice(4, 6)).toEqual(['yes', 'yes']);
      // No yes or no: kept last, in the given order.
      expect(order.slice(6)).toEqual(['n1', 'e1']);
    }
  });

  it('does not give the verdict away by position: the first item is not always a pass, nor the order the old alternation', () => {
    const firsts = new Set<string | undefined>();
    const balanced = new Set<string>();
    for (let run = 0; run < 200; run += 1) {
      const order = calibrationOrder(items, of);
      firsts.add(of(order[0]));
      balanced.add(order.slice(0, 4).map(of).join(','));
    }
    expect(firsts).toEqual(new Set(['yes', 'no']));
    // Every arrangement of two passes and two fails turns up, alternation among them but not alone.
    expect(balanced.size).toBe(6);
  });

  it('is drawn at random, so the same input is not always the same order', () => {
    const orders = new Set(Array.from({ length: 50 }, () => calibrationOrder(items, of).join(',')));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('takes a random source, which picks which of the larger kind come early', () => {
    // A source that always picks the first slot: Fisher-Yates then rotates the list by one.
    const first = () => 0;
    expect(shuffled(['a', 'b', 'c'], first)).toEqual(['b', 'c', 'a']);
    const order = calibrationOrder(items, of, first);
    expect(order.slice(0, 4).map(of).sort()).toEqual(['no', 'no', 'yes', 'yes']);
  });

  it('handles one kind only and an empty list', () => {
    expect(calibrationOrder([], of)).toEqual([]);
    const passes = ['p1', 'p2', 'n1'];
    const order = calibrationOrder(passes, of);
    expect(order.slice(0, 2).sort()).toEqual(['p1', 'p2']);
    expect(order[2]).toBe('n1');
  });
});
