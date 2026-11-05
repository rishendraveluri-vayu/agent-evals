import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { canWrite, folderProblem, unwritable, writableFolders } from './folders';

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const whenNotRoot = asRoot ? it.skip : it;

describe('the folders the API writes', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'evals-folders-'));
  });

  afterEach(() => {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it('are runs/, labels/ and configs/prompts/, where the config puts them', () => {
    const folders = writableFolders({ runsDir: '/runs', labelsDir: '/repo/labels', configsDir: '/repo/configs' });
    expect(folders.map((f) => [f.name, f.path])).toEqual([
      ['runs/', '/runs'],
      ['labels/', '/repo/labels'],
      ['configs/prompts/', '/repo/configs/prompts'],
    ]);
  });

  it('can be written when they exist and are writable', async () => {
    await expect(canWrite(root)).resolves.toBe(true);
  });

  it('can be written when missing but the folder above them can be (the API makes them on first use)', async () => {
    await expect(canWrite(path.join(root, 'runs', 'deeper'))).resolves.toBe(true);
  });

  it('cannot be written when a file stands where the folder should be', async () => {
    writeFileSync(path.join(root, 'runs'), '');
    await expect(canWrite(path.join(root, 'runs'))).resolves.toBe(false);
    await expect(canWrite(path.join(root, 'runs', 'below'))).resolves.toBe(false);
  });

  whenNotRoot('cannot be written when this user has no write access', async () => {
    const dir = path.join(root, 'runs');
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    await expect(canWrite(dir)).resolves.toBe(false);
    chmodSync(dir, 0o755);
  });

  whenNotRoot('cannot be created when missing under a folder this user cannot write', async () => {
    chmodSync(root, 0o555);
    await expect(canWrite(path.join(root, 'labels'))).resolves.toBe(false);
  });

  whenNotRoot('lists only the ones that cannot be written', async () => {
    const folders = writableFolders({ runsDir: path.join(root, 'runs'), labelsDir: path.join(root, 'labels'), configsDir: path.join(root, 'configs') });
    mkdirSync(path.join(root, 'labels'));
    chmodSync(path.join(root, 'labels'), 0o555);
    expect((await unwritable(folders)).map((f) => f.name)).toEqual(['labels/']);
    chmodSync(path.join(root, 'labels'), 0o755);
  });

  it('are named in plain words when they cannot be written, with the fix by hand for the user the API runs as', () => {
    const folders = writableFolders({ runsDir: '/runs', labelsDir: '/repo/labels', configsDir: '/repo/configs' });
    const text = folderProblem([folders[0], folders[2]], 1000);
    expect(text).toBe(
      "The API cannot write to runs/ (trial files; here /runs), configs/prompts/ (prompt versions you save; here /repo/configs/prompts): the API's user, uid 1000, has no write access there, so anything it stores there fails with a permission error. " +
        "In the compose stack the API's start-up step gives these folders to its user, so that step could not: docker compose logs api says why. " +
        'By hand, from the repo folder: sudo chown 1000 runs configs/prompts && sudo chmod u+rwx,g+rwxs runs configs/prompts, then docker compose up -d.',
    );
    expect(folderProblem([folders[1]], null)).not.toContain('sudo');
  });
});
