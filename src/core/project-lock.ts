import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureStateDir } from './paths';
import { acquireProcessLockFile, processExists, releaseProcessLockFile } from './process-lock';

/** Hold across the read/check/write sequence and the entire publication. */
export async function withProjectLock<T>(projectDir: string, operation: () => Promise<T>): Promise<T> {
  const root = await realpath(projectDir);
  const paths = await ensureStateDir(root);
  const lock = await acquireProcessLockFile({
    path: join(paths.stateDir, 'atlas.lock'),
    inspectExisting: owner => processExists(owner.pid)
      ? { action: 'refuse', reason: 'An Atlas operation is already active for this project' }
      : { action: 'replace', reason: 'Previous Atlas operation exited' },
  });
  try { return await operation(); } finally { await releaseProcessLockFile(lock); }
}
