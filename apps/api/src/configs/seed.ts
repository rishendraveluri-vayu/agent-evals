import Ajv2020 from 'ajv/dist/2020';
import type { Seed, SeedSkill, SettingName, Settings } from '../contract';
import { badRequest } from '../common/api-error';
import { supports } from './settings';

/**
 * Contract v2's seed shape, as `contract/v2/spec.schema.json` has it under `properties.seed`.
 * Copied here because the API image carries no `contract/` folder; seed.spec.ts fails if the
 * two drift apart.
 */
export const SEED_SCHEMA = {
  description: 'Config-given starting state, written natively by the adapter. Never learned state (R10.8).',
  type: 'object',
  additionalProperties: false,
  required: ['memory', 'skills'],
  properties: {
    memory: { type: 'array', items: { type: 'string', minLength: 1 } },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'body'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
          description: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
  },
} as const;

export function emptySeed(): Seed {
  return { memory: [], skills: [] };
}

export function seedIsEmpty(seed: Seed): boolean {
  return seed.memory.length === 0 && seed.skills.length === 0;
}

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(SEED_SCHEMA);

const SHAPE_FIX =
  'Send seed as {"memory": ["a fact", ...], "skills": [{"name": "lower-case-name", "description": "...", "body": "..."}]}; either list may be left out.';

/** The seeded features: `seed.memory` needs the memory setting, `seed.skills` the skills one. */
const FEATURES = [
  ['memory', 'memory'],
  ['skills', 'skills'],
] as const satisfies readonly (readonly [keyof Seed, SettingName])[];

type Caps = Parameters<typeof supports>[0];

/**
 * Checks a config's seed and returns it in full (both lists, empty when left out). The shape is
 * contract v2's (400 `invalid_seed`). A non-empty list is refused, with a fix, when the harness
 * cannot take the feature (400 `unsupported_seed`, from the capabilities as the setting checks
 * are) or when the resolved settings turn it off (400 `seed_feature_off`): the adapter would
 * write state the agent never sees, or, for Hermes memory, state it sees with memory "off"
 * (docs/hermes-notes.md: a non-empty MEMORY.md enters the prompt without the toolset).
 */
export function checkSeed(
  given: unknown,
  settings: Settings,
  caps: Caps,
  harness: string,
  elsewhere: Partial<Record<SettingName, string[]>> = {},
): Seed {
  if (given === undefined || given === null) return emptySeed();
  if (typeof given !== 'object' || Array.isArray(given)) throw badRequest('invalid_seed', 'seed must be an object', SHAPE_FIX);
  const filled = { memory: [], skills: [], ...(given as Record<string, unknown>) };
  if (!validate(filled)) {
    const why = (validate.errors ?? []).map((e) => `seed${e.instancePath} ${e.message ?? ''}`.trim()).join('; ');
    throw badRequest('invalid_seed', `seed does not fit contract v2's seed shape: ${why}`, SHAPE_FIX);
  }
  const seed = filled as unknown as Seed;
  const names = seed.skills.map((s: SeedSkill) => s.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) {
    throw badRequest('invalid_seed', `two seeded skills are named ${dup}; each skill is written to its own folder by name`, `Give each seeded skill its own name, or drop one of the ${dup} skills.`);
  }
  for (const [list, setting] of FEATURES) {
    if (seed[list].length === 0) continue;
    if (!supports(caps, setting)) {
      const others = (elsewhere[setting] ?? []).filter((h) => h !== harness);
      throw badRequest(
        'unsupported_seed',
        `${harness} does not support ${setting}, so a config cannot seed it`,
        `${harness} has no ${setting} to seed: remove seed.${list}${others.length ? `, or pick a harness that takes it (${others.join(', ')})` : ''}.`,
      );
    }
    if (settings[setting]?.enabled !== true) {
      throw badRequest(
        'seed_feature_off',
        `seed.${list} is set but ${setting} is off for this config, so the seeds would not be used`,
        `Set settings.${setting} to {"enabled": true}, or remove seed.${list}.`,
      );
    }
  }
  return { memory: [...seed.memory], skills: seed.skills.map((s) => ({ name: s.name, description: s.description, body: s.body })) };
}
