import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { platformCommit, readGitHead } from './git-commit';

/** Synthetic `.git` folders, laid out as git writes them; no git binary is run. */
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

describe('reading the platform commit from a checkout (G2)', () => {
  let tmp: string;
  let n = 0;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-git-'));
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** A checkout folder whose `.git` holds `files` (path relative to `.git` -> content). */
  async function checkout(files: Record<string, string>): Promise<string> {
    const dotGit = path.join(tmp, `repo-${n++}`, '.git');
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dotGit, rel)), { recursive: true });
      await fs.writeFile(path.join(dotGit, rel), content);
    }
    return dotGit;
  }

  it('reads a detached HEAD, which is the commit itself', async () => {
    const dotGit = await checkout({ HEAD: `${A}\n` });
    expect(readGitHead(dotGit)).toEqual({ commit: A, ref: null });
  });

  it('follows HEAD to a loose branch ref', async () => {
    const dotGit = await checkout({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${A}\n` });
    expect(readGitHead(dotGit)).toEqual({ commit: A, ref: 'refs/heads/main' });
  });

  it('follows HEAD to packed-refs when the branch has no loose file, skipping the header and peeled lines', async () => {
    const packed = ['# pack-refs with: peeled fully-peeled sorted ', `${C} refs/heads/feature/x`, `${B} refs/heads/main`, `${A} refs/tags/v1`, `^${C}`, ''].join('\n');
    const dotGit = await checkout({ HEAD: 'ref: refs/heads/main\n', 'packed-refs': packed, 'refs/heads/.keep': '' });
    expect(readGitHead(dotGit)).toEqual({ commit: B, ref: 'refs/heads/main' });
  });

  it('prefers a loose ref to its packed line, as git does (the loose one is newer)', async () => {
    const dotGit = await checkout({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${A}\n`, 'packed-refs': `${B} refs/heads/main\n` });
    expect(readGitHead(dotGit)?.commit).toBe(A);
  });

  it('reads a linked worktree: its .git file names the git folder, whose commondir holds the branches', async () => {
    const main = await checkout({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${A}\n`, 'packed-refs': `${B} refs/heads/side\n` });
    await fs.mkdir(path.join(main, 'worktrees', 'side'), { recursive: true });
    await fs.writeFile(path.join(main, 'worktrees', 'side', 'HEAD'), 'ref: refs/heads/side\n');
    await fs.writeFile(path.join(main, 'worktrees', 'side', 'commondir'), '../..\n');
    const wt = path.join(tmp, `worktree-${n++}`);
    await fs.mkdir(wt);
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${path.join(main, 'worktrees', 'side')}\n`);
    expect(readGitHead(path.join(wt, '.git'))).toEqual({ commit: B, ref: 'refs/heads/side' });
  });

  it('accepts SHA-256 object names', async () => {
    const long = 'd'.repeat(64);
    expect(readGitHead(await checkout({ HEAD: `${long}\n` }))?.commit).toBe(long);
  });

  it.each<[string, Record<string, string> | null]>([
    ['no .git at all (a downloaded zip)', null],
    ['an empty .git folder (what Docker makes for a missing mount source)', {}],
    ['a branch with no commit yet', { HEAD: 'ref: refs/heads/main\n' }],
    ['a HEAD that is neither a commit nor a ref', { HEAD: 'not a head\n' }],
    ['a short commit in HEAD', { HEAD: 'abc1234\n' }],
    ['a ref that climbs out of refs/ with ..', { HEAD: 'ref: refs/../config\n', config: `${A}\n` }],
    ['a ref outside refs/', { HEAD: 'ref: config\n', config: `${A}\n` }],
    ['a branch whose file holds no commit', { HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': 'garbage\n' }],
  ])('gives null, never a guess, for %s', async (_what, files) => {
    const dotGit = files === null ? path.join(tmp, `nothing-${n++}`, '.git') : await checkout(files);
    if (files !== null && Object.keys(files).length === 0) await fs.mkdir(dotGit, { recursive: true });
    expect(readGitHead(dotGit)).toBeNull();
  });

  it('gives null for a worktree .git file whose git folder is not there (a host path, inside a container)', async () => {
    const wt = path.join(tmp, `worktree-${n++}`);
    await fs.mkdir(wt);
    await fs.writeFile(path.join(wt, '.git'), 'gitdir: /home/someone/repo/.git/worktrees/x\n');
    expect(readGitHead(path.join(wt, '.git'))).toBeNull();
  });

  it('stops at a loop of symbolic refs', async () => {
    const dotGit = await checkout({ HEAD: 'ref: refs/heads/a\n', 'refs/heads/a': 'ref: refs/heads/b\n', 'refs/heads/b': 'ref: refs/heads/a\n' });
    expect(readGitHead(dotGit)).toBeNull();
  });

  it('records EVALS_PLATFORM_COMMIT as given when set, else the checkout HEAD, else nothing', async () => {
    const dotGit = await checkout({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${A}\n` });
    expect(platformCommit('abc1234', dotGit)).toEqual({ commit: 'abc1234', source: 'env' });
    expect(platformCommit(null, dotGit)).toEqual({ commit: A, source: 'git' });
    expect(platformCommit(null, path.join(tmp, 'missing', '.git'))).toEqual({ commit: null, source: null });
  });
});
