import { PLATFORM_DEFAULTS } from './settings';
import { type ConfigHashInput, configHash, configId, diffValues } from './configs.service';

const BASE: ConfigHashInput = {
  harness_ref: '6112c2adb9e11f69734a29be9d2696f345ffa06a',
  adapter_version: '0.1.0',
  capabilities_sha256: `sha256:${'1'.repeat(64)}`,
  model: 'claude-haiku-5-5',
  prompt_sha256: `sha256:${'2'.repeat(64)}`,
  toolset_sha256: `sha256:${'3'.repeat(64)}`,
  settings: { ...PLATFORM_DEFAULTS },
  harness_options: {},
};

describe('configHash', () => {
  it('is a sha256 ref and stable across key order', () => {
    const reversed = Object.fromEntries(Object.entries(BASE).reverse()) as unknown as ConfigHashInput;
    reversed.settings = Object.fromEntries(Object.entries(BASE.settings).reverse()) as unknown as ConfigHashInput['settings'];
    expect(configHash(BASE)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(configHash(reversed)).toBe(configHash(BASE));
    // An unsupported setting is null, which is a different value from "off".
    expect(configHash({ ...BASE, settings: { ...BASE.settings, compression: null } })).not.toBe(configHash(BASE));
  });

  it.each<[string, Partial<ConfigHashInput>]>([
    ['harness ref', { harness_ref: 'other' }],
    ['adapter version', { adapter_version: '0.2.0' }],
    ['capabilities file', { capabilities_sha256: `sha256:${'9'.repeat(64)}` }],
    ['model', { model: 'gemini-3.8-flash' }],
    ['prompt', { prompt_sha256: `sha256:${'8'.repeat(64)}` }],
    ['toolset', { toolset_sha256: `sha256:${'7'.repeat(64)}` }],
    ['a setting', { settings: { ...PLATFORM_DEFAULTS, temperature: 0.3 } }],
    ['harness options', { harness_options: { prompt_cache_markers: false } }],
  ])('changes when the %s changes', (_what, change) => {
    expect(configHash({ ...BASE, ...change })).not.toBe(configHash(BASE));
  });

  it('gives a short config id from the hash', () => {
    expect(configId(`sha256:${'ab'.repeat(32)}`)).toBe('c_abababababab');
  });
});

describe('diffValues', () => {
  it('lists every leaf path that differs, and nothing else', () => {
    const a = { name: 'A', prompt: { id: 'p', version: 'v1' }, settings: { temperature: 0.2, memory: null } };
    const b = { name: 'A', prompt: { id: 'p', version: 'v2' }, settings: { temperature: 0.2, memory: { enabled: true } } };
    expect(diffValues(a, b)).toEqual([
      { path: 'prompt.version', a: 'v1', b: 'v2' },
      { path: 'settings.memory', a: null, b: { enabled: true } },
    ]);
  });

  it('reports a key present on one side only', () => {
    expect(diffValues({ x: 1 }, { x: 1, y: 2 })).toEqual([{ path: 'y', a: undefined, b: 2 }]);
  });

  it('is empty for equal values in any key order', () => {
    expect(diffValues({ a: { b: 1, c: [1, 2] } }, { a: { c: [1, 2], b: 1 } })).toEqual([]);
  });
});
