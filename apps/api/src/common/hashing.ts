import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, numbers and strings as
 * JSON.stringify writes them. The same content always gives the same bytes, whatever order
 * the keys arrived in, so it can be hashed for content addressing (R14).
 *
 * `undefined` object members are dropped (as JSON.stringify does); non-finite numbers and
 * other non-JSON values are refused rather than silently changed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`cannot hash the number ${value}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`cannot hash a ${typeof value}`);
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `sha256:<hex>`, the form the API uses everywhere (docs/api-contract.md). */
export function sha256Ref(data: string | Buffer): string {
  return `sha256:${sha256Hex(data)}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Ref(canonicalJson(value));
}

const REF = /^sha256:([0-9a-f]{64})$/;
const HEX = /^[0-9a-f]{64}$/;

/** Accepts `sha256:<hex>` or bare hex (any case); returns `sha256:<hex>`, or null if neither. */
export function normalizeSha(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (REF.test(s)) return s;
  if (HEX.test(s)) return `sha256:${s}`;
  return null;
}

/** The bare hex of a `sha256:<hex>` ref, for contract v2 fields that take hex only. */
export function bareHex(ref: string): string {
  return ref.startsWith('sha256:') ? ref.slice('sha256:'.length) : ref;
}
