import { bareHex, canonicalJson, hashCanonical, normalizeSha, sha256Ref } from './hashing';

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('gives the same text whatever order the keys arrived in', () => {
    const a = { model: 'm', settings: { temperature: 0.2, max_steps: 15 }, harness_options: {} };
    const b = { harness_options: {}, settings: { max_steps: 15, temperature: 0.2 }, model: 'm' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it('keeps array order, since order can change behaviour', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined members like JSON.stringify and writes undefined array items as null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  it('escapes strings as JSON and keeps unicode', () => {
    expect(canonicalJson({ t: 'a"b\n₹' })).toBe('{"t":"a\\"b\\n₹"}');
  });

  it('refuses values JSON cannot hold rather than changing them', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ f: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe('sha256 refs', () => {
  it('writes sha256:<hex> of UTF-8 bytes', () => {
    // sha256("abc")
    expect(sha256Ref('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('normalizes the ref or bare hex, any case, and refuses anything else', () => {
    const hex = 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';
    expect(normalizeSha(hex)).toBe(`sha256:${hex.toLowerCase()}`);
    expect(normalizeSha(`sha256:${hex.toLowerCase()}`)).toBe(`sha256:${hex.toLowerCase()}`);
    expect(normalizeSha('sha256:abc')).toBeNull();
    expect(normalizeSha(42)).toBeNull();
    expect(bareHex('sha256:ab')).toBe('ab');
  });
});
