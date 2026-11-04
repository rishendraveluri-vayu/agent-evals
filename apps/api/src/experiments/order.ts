import { createHash, randomInt } from 'node:crypto';

/**
 * D32: the claim order. Trials are shuffled from a recorded seed with the arms interleaved in time,
 * so any early batch (the futility check's first trials, or a run stopped part-way) is a random
 * sample of the tasks and repeats, and never one arm's.
 *
 * How: every (task, repeat) is a block holding one trial per arm. The blocks are put in a seeded
 * random order, and the arms in a seeded random order inside each block (permuted blocks), so
 * after every block the arms have run equally often.
 *
 * The random stream is plain sha256, so any language can rebuild the order from the seed:
 * the i-th number is the first 4 bytes of sha256("<seed>:<i>") as a big-endian integer over 2^32.
 */

/** A new seed: a random integer from 0 to 2^32 - 1. */
export function newSeed(): number {
  return randomInt(0, 2 ** 32);
}

export function isSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 32;
}

/** Uniform numbers in [0, 1), the same for the same seed. */
export function seededRandom(seed: number): () => number {
  let i = 0;
  return () => createHash('sha256').update(`${seed}:${i++}`).digest().readUInt32BE(0) / 2 ** 32;
}

/** Fisher-Yates: a new array in a random order drawn from `rand`. */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface Slot {
  task: string;
  config: string;
  repeat: number;
}

/** Every (task, config, repeat) slot in claim order: element i has order_index i. */
export function claimOrder(tasks: readonly string[], configs: readonly string[], n: number, seed: number): Slot[] {
  const rand = seededRandom(seed);
  const blocks: { task: string; repeat: number }[] = [];
  for (let repeat = 0; repeat < n; repeat += 1) for (const task of tasks) blocks.push({ task, repeat });
  return shuffle(blocks, rand).flatMap((b) => shuffle(configs, rand).map((config) => ({ task: b.task, config, repeat: b.repeat })));
}
