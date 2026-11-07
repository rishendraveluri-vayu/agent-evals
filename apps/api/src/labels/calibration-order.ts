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
 * D83's calibrating queue: only a balanced block, so no position gives the judge's verdict away.
 * With k the smaller of the judge's pass and fail counts, k passes and k fails drawn at random and
 * shuffled together, 2k items in all. The passes or fails left over and the items with no yes or
 * no are left out: after the block every item would be the larger kind (review 7 Nov: items 21 to
 * 198 were all passes while the page still said "balanced"); the usual queue offers them. k is 0,
 * and the block empty, when the judge gave only one kind. Drawn afresh on every call.
 */
export function calibrationOrder<T>(items: readonly T[], verdictOf: (item: T) => string | undefined, rand: RandomIndex = cryptoIndex): T[] {
  const pass = shuffled(items.filter((i) => verdictOf(i) === 'yes'), rand);
  const fail = shuffled(items.filter((i) => verdictOf(i) === 'no'), rand);
  const k = Math.min(pass.length, fail.length);
  return shuffled([...pass.slice(0, k), ...fail.slice(0, k)], rand);
}
