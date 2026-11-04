import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { ApiError } from '../common/api-error';
import { checkFiles, storeUpload } from './trial-files';

const hex = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('checkFiles', () => {
  let runs: string;
  const folder = 'e_1/t_1/attempt-1';

  beforeAll(async () => {
    runs = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-files-'));
    await fs.mkdir(path.join(runs, folder, 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(runs, folder, 'result.json'), '{"ok":true}');
    await fs.writeFile(path.join(runs, folder, 'artifacts', 'x.txt'), 'x');
  });

  afterAll(async () => {
    await fs.rm(runs, { recursive: true, force: true });
  });

  it('accepts sha256:<hex> and bare hex alike, and returns sha256:<hex>', async () => {
    const files = await checkFiles(runs, folder, [
      { path: 'result.json', bytes: 11, sha256: hex('{"ok":true}') },
      { path: 'artifacts/x.txt', bytes: 1, sha256: `sha256:${hex('x')}` },
    ]);
    expect(files).toEqual([
      { path: 'result.json', bytes: 11, sha256: `sha256:${hex('{"ok":true}')}`, ok: true },
      { path: 'artifacts/x.txt', bytes: 1, sha256: `sha256:${hex('x')}`, ok: true },
    ]);
  });

  it('flags a different file, a missing one, a path out of the folder and a hash it cannot read', async () => {
    const files = await checkFiles(runs, folder, [
      { path: 'result.json', bytes: 11, sha256: '0'.repeat(64) },
      { path: 'missing.log', bytes: 1, sha256: '1'.repeat(64) },
      { path: '../t_2/secret', bytes: 1, sha256: '1'.repeat(64) },
      { path: 'artifacts/x.txt', bytes: 1, sha256: 'md5:abc' },
    ]);
    expect(files.map((f) => f.ok)).toEqual([false, false, false, false]);
    expect(files[0]).toMatchObject({ sha256: `sha256:${'0'.repeat(64)}`, problem: expect.stringContaining(`sha256:${hex('{"ok":true}')}`) as string });
    expect(files[2].problem).toBe('path leaves the trial folder');
    expect(files[3]).toMatchObject({ sha256: 'md5:abc', problem: expect.stringContaining('neither sha256:<hex> nor 64 hex digits') as string });
  });
});

describe('storeUpload', () => {
  let runs: string;
  const folder = 'e_1/t_9/attempt-1';
  const body = (text: string): Readable => Readable.from([Buffer.from(text)]);

  beforeEach(async () => {
    runs = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-upload-'));
  });

  afterEach(async () => {
    await fs.rm(runs, { recursive: true, force: true });
  });

  it('refuses a body that grows past the cap while streaming, and keeps nothing of it', async () => {
    const err = await storeUpload(runs, folder, 'big.log', body('x'.repeat(11)), `sha256:${hex('x'.repeat(11))}`, { allowNew: true, maxBytes: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(413);
    expect(await fs.readdir(path.join(runs, 'e_1/t_9'))).toEqual(['attempt-1']);
    expect(await fs.readdir(path.join(runs, folder))).toEqual([]);
  });

  it('stores one copy when the same file arrives twice at once', async () => {
    const sha = `sha256:${hex('same')}`;
    const both = await Promise.all([0, 1].map(() => storeUpload(runs, folder, 'a/b.json', body('same'), sha, { allowNew: true })));
    expect(both.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(await fs.readFile(path.join(runs, folder, 'a/b.json'), 'utf8')).toBe('same');
    expect(await fs.readdir(path.join(runs, 'e_1/t_9'))).toEqual(['attempt-1']);
  });

  it('never follows a symlink out of the attempt folder', async () => {
    const outside = path.join(runs, 'outside');
    await fs.mkdir(outside);
    await fs.mkdir(path.join(runs, folder), { recursive: true });
    await fs.symlink(outside, path.join(runs, folder, 'link'));
    const err = await storeUpload(runs, folder, 'link/x.txt', body('x'), `sha256:${hex('x')}`, { allowNew: true }).catch((e: unknown) => e);
    expect((err as ApiError).getStatus()).toBe(400);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
