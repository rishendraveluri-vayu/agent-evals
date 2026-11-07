import { randomInt } from 'node:crypto';

/** A random integer in [0, max): crypto's, so no seed (and no position) can be predicted. */
export type RandomIndex = (max: number) => number;

const cryptoIndex: RandomIndex = (max) => randomInt(0, max);

/** A Fisher-Yates shuffle into a new list. */
export function shuffled<T>(items: readonly T[], rand: RandomIndex = cryptoIndex): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * D83's calibrating order, without giving the judge's verdict away by position (review, 7 Nov:
 * strict alternation put the judge's passes at 1, 3, 5). With k the smaller of the judge's pass and
 * fail counts: k passes and k fails, drawn at random and shuffled together, then the passes or
 * fails left over, shuffled, then the items with no yes or no, in their given order. So both kinds
 * come early and in balance, and no position says which an item is. The order is drawn afresh on
 * every call.
 */
export function calibrationOrder<T>(items: readonly T[], verdictOf: (item: T) => string | undefined, rand: RandomIndex = cryptoIndex): T[] {
  const pass = shuffled(items.filter((i) => verdictOf(i) === 'yes'), rand);
  const fail = shuffled(items.filter((i) => verdictOf(i) === 'no'), rand);
  const k = Math.min(pass.length, fail.length);
  const balanced = shuffled([...pass.slice(0, k), ...fail.slice(0, k)], rand);
  const rest = shuffled([...pass.slice(k), ...fail.slice(k)], rand);
  const none = items.filter((i) => verdictOf(i) !== 'yes' && verdictOf(i) !== 'no');
  return [...balanced, ...rest, ...none];
}
