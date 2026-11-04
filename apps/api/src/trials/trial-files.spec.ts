import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkFiles } from './trial-files';

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
