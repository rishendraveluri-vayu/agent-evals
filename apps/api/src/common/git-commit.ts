import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { PlatformCommitSource } from '../contract';

/*
 * The platform commit an experiment records (review G2, 5 Nov). EVALS_PLATFORM_COMMIT, when set,
 * is taken as given (`env`); otherwise the API reads the checkout's HEAD from its `.git`, which
 * compose mounts read-only (`git`), so a plain `docker compose up` records the commit with no
 * step by hand. No git binary is needed: HEAD is a commit (detached), or a ref to a loose ref file
 * or a line of packed-refs.
 *
 * What neither source can tell: whether the working tree had uncommitted changes, and whether the
 * running images were built from that commit. The record's source says which reading it is; the
 * working tree is unknown-dirty either way (docs/known-limits.md).
 */

export interface PlatformCommit {
  commit: string | null;
  source: PlatformCommitSource | null;
}

/** A full object name: SHA-1 (40 hex) or SHA-256 (64 hex). */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SYMREF = /^ref:\s*(\S+)$/;
/** Symbolic refs pointing at symbolic refs: git stops at 5 levels; so does this. */
const MAX_DEPTH = 5;

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** A ref name that stays inside the git folder: under refs/, no `..`, no empty part. */
function safeRef(ref: string): boolean {
  return ref.startsWith('refs/') && !ref.includes('\0') && ref.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The git folder of a checkout: `.git` itself, or the `gitdir:` a linked worktree's `.git` file names. */
function gitDirOf(dotGit: string): string | null {
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(read(dotGit) ?? '')?.[1];
  return target ? path.resolve(path.dirname(dotGit), target) : null;
}

/** `<name>` in packed-refs (`<object name> <ref>` lines; `#` header and `^` peeled lines skipped). */
function packedRef(commonDir: string, ref: string): string | null {
  for (const line of (read(path.join(commonDir, 'packed-refs')) ?? '').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const [name, refName] = line.trim().split(/\s+/);
    if (refName === ref && OBJECT_NAME.test(name)) return name;
  }
  return null;
}

/**
 * The commit HEAD points at in the checkout whose `.git` is `dotGit`, or null when there is no
 * readable repository there, HEAD names a branch with no commit yet, or anything is malformed.
 * A loose ref wins over packed-refs, as in git. In a linked worktree, HEAD is read from the
 * worktree's own git folder and branches from the shared one (`commondir`).
 */
export function readGitHead(dotGit: string): { commit: string; ref: string | null } | null {
  const gitDir = gitDirOf(dotGit);
  if (!gitDir) return null;
  const common = read(path.join(gitDir, 'commondir'));
  const commonDir = common ? path.resolve(gitDir, common.trim()) : gitDir;
  const head = read(path.join(gitDir, 'HEAD'))?.trim();
  if (!head) return null;
  if (OBJECT_NAME.test(head)) return { commit: head, ref: null };
  const branch = SYMREF.exec(head)?.[1] ?? null;
  let ref = branch;
  for (let depth = 0; ref !== null && depth < MAX_DEPTH; depth += 1) {
    if (!safeRef(ref)) return null;
    const loose = (read(path.join(gitDir, ref)) ?? (commonDir !== gitDir ? read(path.join(commonDir, ref)) : null))?.trim() ?? null;
    if (loose === null) {
      const packed = packedRef(commonDir, ref);
      return packed ? { commit: packed, ref: branch } : null;
    }
    if (OBJECT_NAME.test(loose)) return { commit: loose, ref: branch };
    ref = SYMREF.exec(loose)?.[1] ?? null;
  }
  return null;
}

/**
 * The commit to record on a new experiment: EVALS_PLATFORM_COMMIT when set (an override, as
 * before), else the checkout's HEAD from `dotGit`, else none.
 */
export function platformCommit(fromEnv: string | null, dotGit: string): PlatformCommit {
  if (fromEnv) return { commit: fromEnv, source: 'env' };
  const head = readGitHead(dotGit);
  return head ? { commit: head.commit, source: 'git' } : { commit: null, source: null };
}
