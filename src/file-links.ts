import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Resolve a Markdown destination without treating a URL or location suffix as a filename. */
export function localFilePath(href: string, cwd: string): string | undefined {
  if (!href || /^[#?]/.test(href) || href.startsWith('//')) return;
  // Remove locations before decoding: an encoded # or colon belongs to the filename.
  const target = href.replace(/(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/, '');
  try {
    let path: string;
    if (/^file:/i.test(target)) {
      const url = new URL(target);
      if ((url.hostname && url.hostname !== 'localhost') || url.search || url.hash) return;
      decodeURIComponent(url.pathname);
      path = fileURLToPath(url);
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) return;
      path = decodeURIComponent(target);
      if (path === '~' || path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
      else path = resolve(cwd, path);
    }
    if (/[\x00-\x1f\x7f]/.test(path)) return;
    return path;
  } catch { return; }
}

export async function showInFinder(path: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Show in Finder is only available on macOS.');
  try { await stat(path); }
  catch { throw new Error(`Could not find this file: ${path}`); }
  // Pass the path as one argument. Filenames never become shell commands.
  await exec('open', ['-R', path], { timeout: 10_000 });
}
