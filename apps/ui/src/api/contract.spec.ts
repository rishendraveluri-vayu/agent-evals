// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const api = new URL('../../../api/src/contract.ts', import.meta.url);
const copy = new URL('./contract.ts', import.meta.url);

/** The UI builds alone (its Docker image copies apps/ui only), so it carries its own copy of the
 *  API's types. This keeps the copy exact: when the API's contract changes, copy it over. */
describe('the UI copy of the API contract', () => {
  it.runIf(existsSync(api))('is identical to apps/api/src/contract.ts (cp apps/api/src/contract.ts apps/ui/src/api/contract.ts)', () => {
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(api, 'utf8'));
  });
});
