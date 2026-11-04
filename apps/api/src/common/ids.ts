import { randomBytes } from 'node:crypto';

/**
 * `<prefix>_<time><random>`: sortable by creation time, unique without coordination, and
 * inside contract v2's id pattern (letters, digits, `_`).
 */
export function newId(prefix: 'e' | 't' | 'g'): string {
  const time = Date.now().toString(36).padStart(9, '0');
  return `${prefix}_${time}${randomBytes(8).toString('hex')}`;
}
