import { createHash } from 'node:crypto';

/**
 * A seeded random stream for the statistics (SP6), so the same experiment always gives the same
 * interval and p-value. The seed is text (the experiment id plus what the stream is for, e.g.
 * `e_123:pass_rate`), hashed with sha256; its first 16 bytes start sfc32, a small fast generator
 * with a 128-bit state that passes PractRand's tests. Each use has its own stream, so adding a
 * metric never moves another metric's numbers.
 */
export type Rand = () => number;

export function seededStream(seed: string): Rand {
  const h = createHash('sha256').update(seed).digest();
  // The state in a typed array: much faster than four captured variables in V8.
  const s = Uint32Array.of(h.readUInt32LE(0), h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12));
  const next: Rand = () => {
    const a = s[0];
    const b = s[1];
    const c = s[2];
    const d = (s[3] + 1) | 0;
    const t = (((a + b) | 0) + d) | 0;
    s[0] = b ^ (b >>> 9);
    s[1] = (c + (c << 3)) | 0;
    s[2] = (((c << 21) | (c >>> 11)) + t) | 0;
    s[3] = d;
    return (t >>> 0) / 4294967296;
  };
  // Warm up, as sfc32's authors advise, so nearby seeds do not start alike.
  for (let i = 0; i < 12; i += 1) next();
  return next;
}
