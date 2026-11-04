import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { BundleTable, ExampleCounts, JsonObject } from '../contract';
import { BUNDLE_TABLES } from '../contract';
import { ApiError } from '../common/api-error';

/**
 * A shipped example on disk (SP7), as scripts/export_example.py writes it:
 *
 *   examples/<name>/manifest.json   what it is, its counts, and the sha256 of each part
 *   examples/<name>/rows.json.gz    {"format", "format_version", "schema_version", "tables": {...}}
 *   examples/<name>/files.jsonl.gz  one stored trial file per line
 *
 * Parts are checked against the manifest's sha256 before they are read.
 */

export const EXAMPLE_FORMAT = 'agent-evals-example';
export const EXAMPLE_FORMAT_VERSION = 1;
export const ROWS_PART = 'rows.json.gz';
export const FILES_PART = 'files.jsonl.gz';
/** A folder name: lower-case letters, digits and hyphens, as in a URL. */
export const EXAMPLE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ExampleManifest {
  format: typeof EXAMPLE_FORMAT;
  format_version: number;
  name: string;
  title: string;
  description: string;
  experiment_id: string;
  created_at: string;
  counts: ExampleCounts;
  parts: Record<string, { bytes: number; sha256: string }>;
}

/** One stored trial file: `content` is its bytes as UTF-8 text, or base64 when they are not text. */
export interface ExampleFile {
  trial_id: string;
  path: string;
  bytes: number;
  sha256: string;
  encoding: 'utf8' | 'base64';
  content: string;
}

/** 422: the example folder is there but cannot be loaded as it is. */
export const exampleInvalid = (name: string, why: string): ApiError =>
  new ApiError(422, 'example_invalid', `examples/${name} cannot be loaded: ${why}`, 'Export it again with scripts/export_example.py.');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SHA = /^sha256:[0-9a-f]{64}$/;

/** The manifest's shape, or the first thing wrong with it. */
export function parseManifest(raw: unknown, folder: string): { manifest: ExampleManifest } | { problem: string } {
  if (!isObj(raw)) return { problem: 'manifest.json is not a JSON object' };
  if (raw.format !== EXAMPLE_FORMAT) return { problem: `manifest.json format is not ${EXAMPLE_FORMAT}` };
  if (raw.format_version !== EXAMPLE_FORMAT_VERSION) return { problem: `manifest.json format_version is ${String(raw.format_version)}, and this API reads ${EXAMPLE_FORMAT_VERSION}` };
  if (raw.name !== folder) return { problem: `manifest.json names ${JSON.stringify(raw.name)}, not its folder ${folder}` };
  for (const key of ['title', 'description', 'experiment_id', 'created_at'] as const) {
    const value = raw[key];
    if (typeof value !== 'string' || !value.trim()) return { problem: `manifest.json has no ${key}` };
  }
  const counts = raw.counts;
  const countKeys: (keyof ExampleCounts)[] = ['configs', 'tasks', 'trials', 'spans', 'grades', 'files'];
  if (!isObj(counts) || countKeys.some((k) => typeof counts[k] !== 'number')) return { problem: `manifest.json counts must give ${countKeys.join(', ')}` };
  const parts = raw.parts;
  if (!isObj(parts)) return { problem: 'manifest.json has no parts' };
  for (const part of [ROWS_PART, FILES_PART]) {
    const p = parts[part];
    if (!isObj(p) || typeof p.bytes !== 'number' || typeof p.sha256 !== 'string' || !SHA.test(p.sha256)) {
      return { problem: `manifest.json parts.${part} must be {bytes, sha256: "sha256:<hex>"}` };
    }
  }
  return {
    manifest: {
      format: EXAMPLE_FORMAT,
      format_version: EXAMPLE_FORMAT_VERSION,
      name: folder,
      title: (raw.title as string).trim(),
      description: (raw.description as string).trim(),
      experiment_id: raw.experiment_id as string,
      created_at: raw.created_at as string,
      counts: Object.fromEntries(countKeys.map((k) => [k, counts[k]])) as unknown as ExampleCounts,
      parts: parts as ExampleManifest['parts'],
    },
  };
}

/** The example's manifest; 404 `unknown_example` when there is no such folder or manifest. */
export async function readManifest(examplesDir: string, name: string): Promise<ExampleManifest> {
  let text: string;
  try {
    text = await fs.readFile(path.join(examplesDir, name, 'manifest.json'), 'utf8');
  } catch {
    throw new ApiError(404, 'unknown_example', `there is no example ${name}`, 'Pick one from GET /api/examples.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw exampleInvalid(name, 'manifest.json is not JSON');
  }
  const parsed = parseManifest(raw, name);
  if ('problem' in parsed) throw exampleInvalid(name, parsed.problem);
  return parsed.manifest;
}

/** A part's bytes, decompressed, after checking its sha256 against the manifest. */
async function readPart(examplesDir: string, m: ExampleManifest, part: string): Promise<Buffer> {
  let gz: Buffer;
  try {
    gz = await fs.readFile(path.join(examplesDir, m.name, part));
  } catch {
    throw exampleInvalid(m.name, `${part} is missing`);
  }
  const seen = `sha256:${createHash('sha256').update(gz).digest('hex')}`;
  if (seen !== m.parts[part].sha256) throw exampleInvalid(m.name, `${part} is ${seen}, not the manifest's ${m.parts[part].sha256}`);
  try {
    return gunzipSync(gz);
  } catch {
    throw exampleInvalid(m.name, `${part} is not gzip`);
  }
}

/** Every table's rows. Tables the bundle does not name are empty; a table this API does not know is refused. */
export async function readTables(examplesDir: string, m: ExampleManifest): Promise<Record<BundleTable, JsonObject[]>> {
  let raw: unknown;
  try {
    raw = JSON.parse((await readPart(examplesDir, m, ROWS_PART)).toString('utf8'));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw exampleInvalid(m.name, `${ROWS_PART} is not JSON`);
  }
  if (!isObj(raw) || !isObj(raw.tables)) throw exampleInvalid(m.name, `${ROWS_PART} has no tables`);
  const tables = raw.tables;
  const unknown = Object.keys(tables).filter((t) => !(BUNDLE_TABLES as readonly string[]).includes(t));
  if (unknown.length) throw exampleInvalid(m.name, `${ROWS_PART} has tables this API does not load: ${unknown.join(', ')}`);
  const out = {} as Record<BundleTable, JsonObject[]>;
  for (const t of BUNDLE_TABLES) {
    const rows = tables[t] ?? [];
    if (!Array.isArray(rows) || !rows.every(isObj)) throw exampleInvalid(m.name, `${ROWS_PART} tables.${t} must be a list of objects`);
    out[t] = rows as JsonObject[];
  }
  return out;
}

/** Every stored file line, each checked: its content must have the size and sha256 it names. */
export async function readFiles(examplesDir: string, m: ExampleManifest): Promise<{ file: ExampleFile; data: Buffer }[]> {
  const text = (await readPart(examplesDir, m, FILES_PART)).toString('utf8');
  const out: { file: ExampleFile; data: Buffer }[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let f: unknown;
    try {
      f = JSON.parse(line);
    } catch {
      throw exampleInvalid(m.name, `${FILES_PART} line ${i + 1} is not JSON`);
    }
    if (
      !isObj(f) ||
      typeof f.trial_id !== 'string' ||
      typeof f.path !== 'string' ||
      typeof f.sha256 !== 'string' ||
      typeof f.bytes !== 'number' ||
      (f.encoding !== 'utf8' && f.encoding !== 'base64') ||
      typeof f.content !== 'string'
    ) {
      throw exampleInvalid(m.name, `${FILES_PART} line ${i + 1} is not {trial_id, path, bytes, sha256, encoding, content}`);
    }
    const file = f as unknown as ExampleFile;
    const data = Buffer.from(file.content, file.encoding === 'utf8' ? 'utf8' : 'base64');
    const sha = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    if (data.length !== file.bytes || sha !== file.sha256) {
      throw exampleInvalid(m.name, `${file.trial_id}/${file.path} is ${data.length} bytes with ${sha}, not ${file.bytes} bytes with ${file.sha256}`);
    }
    out.push({ file, data });
  });
  return out;
}
