import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../common/app-config';

/** A folder the API writes into, with the name a person knows it by in the repo. */
export interface WritableFolder {
  /** The repo folder, as the README and the compose file name it: `runs/`. */
  name: string;
  /** What the API keeps there, in a few words. */
  holds: string;
  /** Where the API sees it (in compose, the mount: /runs). */
  path: string;
}

/** The folders the API writes: trial files, human labels and new prompt versions. */
export function writableFolders(config: Pick<AppConfig, 'runsDir' | 'labelsDir' | 'configsDir'>): WritableFolder[] {
  return [
    { name: 'runs/', holds: 'trial files', path: config.runsDir },
    { name: 'labels/', holds: 'your labels', path: config.labelsDir },
    { name: 'configs/prompts/', holds: 'prompt versions you save', path: path.join(config.configsDir, 'prompts') },
  ];
}

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;

/**
 * Whether this process can create files in `dir`: it is a folder this process may write and enter,
 * or it does not exist yet and the nearest folder above it that does exist is one (the API creates
 * its folders on first use). Asks the kernel (access(2)), so nothing is written to find out.
 */
export async function canWrite(dir: string): Promise<boolean> {
  let at = path.resolve(dir);
  for (;;) {
    try {
      if (!(await fs.stat(at)).isDirectory()) return false;
      await fs.access(at, constants.W_OK | constants.X_OK);
      return true;
    } catch (err) {
      if (errno(err) !== 'ENOENT') return false;
      const parent = path.dirname(at);
      if (parent === at) return false;
      at = parent;
    }
  }
}

/** The folders of `folders` this process cannot write, in their order. */
export async function unwritable(folders: WritableFolder[]): Promise<WritableFolder[]> {
  const ok = await Promise.all(folders.map((f) => canWrite(f.path)));
  return folders.filter((_, i) => !ok[i]);
}

/**
 * What is wrong and how to put it right, in plain words, for the health report and the log. The
 * folders are named as in the repo, with where the API sees them; `uid` is this process's user.
 */
export function folderProblem(bad: WritableFolder[], uid: number | null): string {
  const list = bad.map((f) => `${f.name} (${f.holds}; here ${f.path})`).join(', ');
  const who = uid === null ? 'the user the API runs as' : `the API's user, uid ${uid},`;
  const names = bad.map((f) => f.name.replace(/\/$/, '')).join(' ');
  const byHand = uid === null ? '' : ` By hand, from the repo folder: sudo chown ${uid} ${names} && sudo chmod u+rwx,g+rwxs ${names}, then docker compose up -d.`;
  return (
    `The API cannot write to ${list}: ${who} has no write access there, so anything it stores there fails with a permission error. ` +
    `In the compose stack the API's start-up step gives these folders to its user, so that step could not: docker compose logs api says why.${byHand}`
  );
}
