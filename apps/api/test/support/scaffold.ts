import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SETTING_NAMES } from '../../src/contract';

/**
 * A harness folder as `make new-harness NAME=<name>` leaves it, for the tests that need one: the
 * capabilities file and pyproject.toml of workers/adapterlib/src/evals_adapter/scaffold.py
 * (`capabilities()` and `PYPROJECT`), with its placeholder version. Nothing else of the scaffold
 * is read by the API.
 */
export function scaffoldCapabilities(name: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const s of SETTING_NAMES) {
    settings[s] = s === 'timeout_s' ? { supported: true, native: 'wrapper', evidence: "declared:the adapter library's watchdog" } : { supported: false, evidence: 'none' };
  }
  return {
    contract_version: '2',
    harness: name,
    version: { package: 'TODO', ref: 'TODO' },
    model_api_formats: ['openai_chat'],
    settings,
    harness_options_schema: { type: 'object', additionalProperties: false, properties: {} },
    known_differences: [],
  };
}

export async function writeScaffold(workersDir: string, name: string): Promise<void> {
  const pkg = `${name.replace(/-/g, '_')}_adapter`;
  const src = path.join(workersDir, name, 'src', pkg);
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'capabilities.json'), `${JSON.stringify(scaffoldCapabilities(name), null, 2)}\n`);
  await fs.writeFile(path.join(workersDir, name, 'pyproject.toml'), `[project]\nname = "${name}-worker"\nversion = "0.1.0"\nrequires-python = ">=3.14"\n`);
}
