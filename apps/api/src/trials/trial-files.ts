import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StoredFile, UploadResponse } from '../contract';
import { ApiError, badRequest, conflict } from '../common/api-error';
import { normalizeSha } from '../common/hashing';

/**
 * Trial folders under runs/: `runs/<experiment_id>/<trial_id>/attempt-<n>/`, written only by the
 * API from the files a worker uploads (docs/api-contract.md, worker protocol steps 4 and 5).
 * Workers never mount runs/, so a trial cannot see another trial's files (D2, D3). Manifest paths
 * are relative to the trial's `out/` folder (contract v2 section 10), so a path is looked up in
 * the attempt folder first and then in its `out/` subfolder, as older folders were laid out.
 */

/** The largest file a worker may upload. The runner caps each log at 50 MB (contract v2). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

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
      entry.problem = safeRelPath(f.path) ? 'not uploaded' : 'path leaves the trial folder';
    } else {
      const seen = await hashFile(file);
      entry.ok = sha256 !== null && seen.bytes === f.bytes && seen.sha256 === sha256;
      if (!entry.ok) {
        entry.problem = sha256 === null ? `sha256 ${f.sha256} is neither sha256:<hex> nor 64 hex digits; stored: ${seen.sha256}` : `stored: ${seen.bytes} bytes, ${seen.sha256}`;
      }
    }
    out.push(entry);
  }
  return out;
}

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/** Size and sha256 of the regular file at `file`, or null when there is none (not followed). */
async function existing(file: string): Promise<{ bytes: number; sha256: string } | 'not_a_file' | null> {
  try {
    const st = await fs.lstat(file);
    return st.isFile() ? await hashFile(file) : 'not_a_file';
  } catch (err) {
    if (errno(err) === 'ENOENT' || errno(err) === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Stores one uploaded file at `<runsDir>/<folder>/<rel>` (worker protocol step 4).
 *
 * The body is streamed to a temporary file next to the attempt folder, counted and hashed on the
 * way, and checked against `sha256` before it is linked into place, so a stored file is always
 * whole and matches its hash. A file is never overwritten: the same bytes again answer
 * `duplicate: true`; different bytes are a 409. With `allowNew` false (the attempt was already
 * reported) only such repeats are accepted.
 */
export async function storeUpload(
  runsDir: string,
  folder: string,
  rel: string,
  body: NodeJS.ReadableStream,
  sha256: string,
  opts: { allowNew: boolean; maxBytes?: number },
): Promise<UploadResponse> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  if (!safeRelPath(rel)) throw badRequest('invalid_path', `${JSON.stringify(rel)} is not a plain relative path inside the trial folder`);
  const base = path.resolve(runsDir, folder);
  const dest = path.resolve(base, rel);
  if (!dest.startsWith(base + path.sep)) throw badRequest('invalid_path', `${JSON.stringify(rel)} leaves the trial folder`);
  await fs.mkdir(base, { recursive: true });
  const tmp = path.join(path.dirname(base), `.upload-${path.basename(base)}-${randomBytes(8).toString('hex')}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(new ApiError(413, 'file_too_large', `${rel} is over ${maxBytes} bytes`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o644 }));
    const seen = `sha256:${hash.digest('hex')}`;
    if (seen !== sha256) throw badRequest('hash_mismatch', `received ${bytes} bytes of ${rel} with ${seen}, not ${sha256}`);
    const same = async (): Promise<UploadResponse> => {
      const found = await existing(dest);
      if (found === null) throw conflict('file_conflict', `${rel} could not be stored`);
      if (found === 'not_a_file' || found.sha256 !== seen) {
        throw conflict('file_conflict', `${rel} is already stored with different content; stored files are never overwritten`);
      }
      return { path: rel, bytes, sha256: seen, duplicate: true };
    };
    if ((await existing(dest)) !== null) return await same();
    if (!opts.allowNew) throw conflict('already_reported', `the attempt was reported without ${rel}; nothing new is stored after a report`);
    const dir = path.dirname(dest);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      if (errno(err) === 'EEXIST' || errno(err) === 'ENOTDIR') throw conflict('file_conflict', `a stored file is in the way of ${rel}`);
      throw err;
    }
    // Only the API writes here and it makes no symlinks; check anyway that the folder stays inside.
    const realBase = await fs.realpath(base);
    const realDir = await fs.realpath(dir);
    if (realDir !== realBase && !realDir.startsWith(realBase + path.sep)) throw badRequest('invalid_path', `${JSON.stringify(rel)} leaves the trial folder`);
    try {
      await fs.link(tmp, dest); // atomic, and refuses to replace an existing file
    } catch (err) {
      if (errno(err) === 'EEXIST') return await same(); // a concurrent upload of the same path won
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(errno(err) ?? '')) throw err;
      // A filesystem without hard links (some Docker Desktop mounts): rename, which is atomic too.
      if ((await existing(dest)) !== null) return await same();
      await fs.rename(tmp, dest);
    }
    return { path: rel, bytes, sha256: seen, duplicate: false };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
