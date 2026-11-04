import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { StoredFile } from '../contract';
import { normalizeSha } from '../common/hashing';

/**
 * Trial folders on the shared runs volume: `runs/<experiment_id>/<trial_id>/attempt-<n>/`
 * (docs/api-contract.md, worker protocol step 4). Manifest paths are relative to the
 * trial's `out/` folder (contract v2 section 10), so a path is looked up in the attempt folder
 * first and then in its `out/` subfolder, whichever way the worker copied it.
 */

export function trialFolder(experimentId: string, trialId: string, attempt: number): string {
  return path.posix.join(experimentId, trialId, `attempt-${attempt}`);
}

/** A manifest path is relative, with no `..` and no empty or dot parts. */
export function safeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The file on disk for a manifest path, or null when it is missing or would leave the folder. */
export async function locate(runsDir: string, folder: string, rel: string): Promise<string | null> {
  if (!safeRelPath(rel)) return null;
  const base = path.resolve(runsDir, folder);
  for (const root of [base, path.join(base, 'out')]) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue;
    try {
      // Refuse symlinks out of the folder: compare the real path too.
      const real = await fs.realpath(target);
      const realRoot = await fs.realpath(root);
      if (!real.startsWith(realRoot + path.sep)) continue;
      if ((await fs.stat(real)).isFile()) return real;
    } catch {
      // not here; try the next root
    }
  }
  return null;
}

/** Size and `sha256:<hex>` of a file on disk. */
export async function hashFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    hash.update(buf);
  }
  return { bytes, sha256: `sha256:${hash.digest('hex')}` };
}

/**
 * Checks each reported file against the folder: present, same size, same sha256. Reported hashes
 * may be `sha256:<hex>` or bare hex; both are compared, and stored, as `sha256:<hex>`.
 */
export async function checkFiles(runsDir: string, folder: string, files: { path: string; bytes: number; sha256: string }[]): Promise<StoredFile[]> {
  const out: StoredFile[] = [];
  for (const f of files) {
    const sha256 = normalizeSha(f.sha256);
    const entry: StoredFile = { path: f.path, bytes: f.bytes, sha256: sha256 ?? f.sha256 };
    const file = await locate(runsDir, folder, f.path);
    if (!file) {
      entry.ok = false;
      entry.problem = safeRelPath(f.path) ? 'missing from the runs volume' : 'path leaves the trial folder';
    } else {
      const seen = await hashFile(file);
      entry.ok = sha256 !== null && seen.bytes === f.bytes && seen.sha256 === sha256;
      if (!entry.ok) {
        entry.problem = sha256 === null ? `sha256 ${f.sha256} is neither sha256:<hex> nor 64 hex digits; on disk: ${seen.sha256}` : `on disk: ${seen.bytes} bytes, ${seen.sha256}`;
      }
    }
    out.push(entry);
  }
  return out;
}
