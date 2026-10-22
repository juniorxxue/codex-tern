import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function findExecutable(name: string): string | undefined {
  const paths = isAbsolute(name) || /[/\\]/.test(name) ? [resolve(name)]
    : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, name));
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const path of paths) for (const ext of extensions) {
    try {
      accessSync(path + ext, constants.X_OK);
      if (statSync(path + ext).isFile()) return path + ext;
    } catch { /* Try the next PATH entry. */ }
  }
}

export async function openTern(client: string, args: string[], cwd: string) {
  const tern = findExecutable('tern');
  if (!tern) throw new Error('Tern was not found on PATH. Install Tern and enable its tern command, then try again. Use --plain for a text client.');
  const running = spawnSync(tern, ['ls', '--json'], { stdio: 'ignore', timeout: 3000 }).status === 0;
  const command = [process.execPath, client, ...args];
  const child = spawn(tern, running ? ['new', 'tab', '--cwd', cwd, '--', ...command]
    : ['-e', ...command], { cwd, stdio: 'inherit' });
  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Tern exited with signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

/** Reveal this native client's existing pane, including when invoked elsewhere. */
export async function focusClient() {
  const tern = findExecutable('tern');
  if (!tern) throw new Error('Tern was not found on PATH.');
  const state = JSON.parse((await exec(tern, ['ls', '--json'], { timeout: 3000 })).stdout);
  const panes: any[] = (state.sessions ?? []).flatMap((s: any) => s.tabs.flatMap((t: any) => t.blocks));
  const matches = await Promise.all(panes.map(async pane => {
    try {
      const result = JSON.parse((await exec(tern, ['process', String(pane.id), '--json'], { timeout: 3000 })).stdout);
      return result.foreground?.pid === process.pid ? pane.id as number : undefined;
    } catch { return undefined; }
  }));
  const pane = matches.find(id => id !== undefined);
  if (pane === undefined) throw new Error('The project is open, but its Tern pane could not be located.');
  await exec(tern, ['focus', String(pane)], { timeout: 3000 });
}
