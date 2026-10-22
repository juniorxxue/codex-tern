import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FileLock } from '@oh-my-pi/pi-natives';

export type LockProbe = (ids: string[]) => Promise<Set<string> | null>;

export function sessionInUse(error: unknown) {
  return error instanceof Error && error.message.includes('already has an active writer');
}

/** Test the OS lock itself. An indexer opening the file is not a writer.
 * Only inspect existing lock files, never history or settings. Own threads
 * are excluded because every session in this project shares one backend.
 */
export async function probeWriterLocks(source: { codexHome?: string; ownsThread?(id: string): boolean }, ids: string[]): Promise<Set<string> | null> {
  if (!source.codexHome || !FileLock) return null;
  const locked = new Set<string>();
  try {
    for (const id of ids) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || source.ownsThread?.(id)) continue;
      const path = join(source.codexHome, 'thread-writer-locks', `${id}.lock`);
      try { if (!(await stat(path)).isFile()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      // A resume can finish while stat is pending. Its writer is now ours.
      if (source.ownsThread?.(id)) continue;
      const guard = FileLock.tryAcquire(path);
      try { if (!guard.acquired) locked.add(id); }
      finally { guard.release(); }
    }
    for (const id of locked) if (source.ownsThread?.(id)) locked.delete(id);
    return locked;
  } catch { return null; }
}
