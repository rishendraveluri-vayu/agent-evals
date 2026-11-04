import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Settings } from '../contract';
import { ApiError } from '../common/api-error';
import { SEED_SCHEMA, checkSeed } from './seed';
import { PLATFORM_DEFAULTS } from './settings';

const SPEC_SCHEMA = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contract/v2/spec.schema.json'), 'utf8')) as { properties: { seed: unknown } };

const BOTH: Parameters<typeof checkSeed>[2] = { settings: { memory: { supported: true }, skills: { supported: true } } };
const NEITHER: Parameters<typeof checkSeed>[2] = { settings: { memory: { supported: false }, skills: { supported: false } } };
const ON: Settings = { ...PLATFORM_DEFAULTS, memory: { enabled: true }, skills: { enabled: true } };

function refusal(fn: () => unknown): { status: number; error: string; message: string; fix?: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return { status: err.getStatus(), ...(err.getResponse() as { error: string; message: string; fix?: string }) };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('checkSeed', () => {
  it("is contract v2's seed shape, copied from contract/v2/spec.schema.json", () => {
    expect(SEED_SCHEMA).toEqual(SPEC_SCHEMA.properties.seed);
  });

  it('gives empty lists for no seed, and fills a list left out', () => {
    expect(checkSeed(undefined, PLATFORM_DEFAULTS, NEITHER, 'ownloop')).toEqual({ memory: [], skills: [] });
    expect(checkSeed(null, PLATFORM_DEFAULTS, NEITHER, 'ownloop')).toEqual({ memory: [], skills: [] });
    // Empty lists need no feature: there is nothing to write.
    expect(checkSeed({ memory: [], skills: [] }, PLATFORM_DEFAULTS, NEITHER, 'ownloop')).toEqual({ memory: [], skills: [] });
    expect(checkSeed({ memory: ['a fact'] }, ON, BOTH, 'hermes')).toEqual({ memory: ['a fact'], skills: [] });
  });

  it.each<[string, unknown]>([
    ['a non-object', ['a fact']],
    ['an unknown key', { memories: ['a fact'] }],
    ['an empty memory entry', { memory: [''] }],
    ['a skill name with capitals', { skills: [{ name: 'EMI', description: 'd', body: 'b' }] }],
    ['a skill without a body', { skills: [{ name: 'emi', description: 'd' }] }],
    ['two skills with one name', { skills: [{ name: 'emi', description: 'd', body: 'b' }, { name: 'emi', description: 'e', body: 'c' }] }],
  ])('refuses %s with 400 invalid_seed and a fix', (_what, seed) => {
    const r = refusal(() => checkSeed(seed, ON, BOTH, 'hermes'));
    expect(r).toMatchObject({ status: 400, error: 'invalid_seed' });
    expect(r.fix).toBeTruthy();
  });

  it('refuses seeds for a harness without the feature, naming one that has it', () => {
    const r = refusal(() => checkSeed({ memory: ['a fact'] }, PLATFORM_DEFAULTS, NEITHER, 'ownloop', { memory: ['hermes'] }));
    expect(r).toEqual({
      status: 400,
      error: 'unsupported_seed',
      message: 'ownloop does not support memory, so a config cannot seed it',
      fix: 'ownloop has no memory to seed: remove seed.memory, or pick a harness that takes it (hermes).',
    });
  });

  it('refuses seeds the config turns off', () => {
    const skill = { name: 'emi', description: 'd', body: 'b' };
    expect(refusal(() => checkSeed({ skills: [skill] }, PLATFORM_DEFAULTS, BOTH, 'hermes'))).toEqual({
      status: 400,
      error: 'seed_feature_off',
      message: 'seed.skills is set but skills is off for this config, so the seeds would not be used',
      fix: 'Set settings.skills to {"enabled": true}, or remove seed.skills.',
    });
    expect(refusal(() => checkSeed({ memory: ['a fact'] }, { ...ON, memory: { enabled: false } }, BOTH, 'hermes')).error).toBe('seed_feature_off');
    expect(checkSeed({ skills: [skill] }, { ...ON, memory: { enabled: false } }, BOTH, 'hermes')).toEqual({ memory: [], skills: [skill] });
  });
});
