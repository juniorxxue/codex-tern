import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { IpcConnection, IpcServer, ipcEndpoint } from '@oh-my-pi/pi-natives';

export interface ProjectCommand { version: 1; signature: string; resume?: string; prompt?: string }
export interface ProjectInstance { close(): Promise<void> }

export async function projectRoot(cwd: string) {
  const original = await realpath(cwd);
  let directory = original;
  while (true) {
    try { await stat(join(directory, '.git')); return directory; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) return original;
    directory = parent;
  }
}

export async function projectAddress(cwd: string, namespace?: string) {
  const config = process.env.TERN_CONFIG_DIR ?? (process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/Tern')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'tern'));
  const profile = namespace ?? process.env.TERN_DAEMON_SOCKET ?? join(config, 'daemon.sock');
  const key = createHash('sha256').update(JSON.stringify([await projectRoot(cwd), resolve(profile),
    resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))])).digest('hex').slice(0, 28);
  return ipcEndpoint(`/tmp/codex-tern-${process.getuid?.() ?? 'user'}`, key);
}

function code(error: unknown) { return (error as NodeJS.ErrnoException).code ?? String(error).match(/\b(E[A-Z]+):/)?.[1]; }

/** A lost reply must never cause a second submission of the same task. */
export async function contactProject(address: string, command: ProjectCommand): Promise<boolean> {
  let connection: IpcConnection;
  try { connection = await IpcConnection.connect(address, { framing: 'lines', timeoutMs: 1000, maxFrameBytes: 1024 * 1024 }); }
  catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(code(error) ?? '')) return false; throw error; }
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); connection.destroy();
      if (error) reject(error); else resolve(true);
    };
    const timer = setTimeout(() => finish(new Error('The project did not reply. The request may have been accepted; nothing was resent.')), 45000);
    connection.start(line => {
      try {
        const reply = JSON.parse(line);
        finish(reply.ok ? undefined : new Error(reply.error ?? 'Could not open the project'));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }, () => { if (!finished) finish(new Error('The project closed before replying. Check it before submitting again.')); });
    connection.send(JSON.stringify(command));
  });
}

/** Native binding atomically replaces stale sockets and checks peer ownership. */
export async function serveProject(address: string, command: ProjectCommand,
  handle: (command: ProjectCommand) => Promise<void>): Promise<ProjectInstance | null> {
  const connections = new Set<IpcConnection>();
  let queue = Promise.resolve();
  let server: IpcServer;
  try {
    server = await IpcServer.listen(address, { framing: 'lines', maxFrameBytes: 1024 * 1024 }, connection => {
      connections.add(connection);
      let accepted = false;
      const timer = setTimeout(() => connection.destroy(), 60000);
      const reply = (error?: unknown) => {
        connection.send(JSON.stringify(error ? { ok: false, error: error instanceof Error ? error.message : String(error) } : { ok: true }));
        connection.end();
      };
      connection.start(line => {
        if (accepted) return;
        accepted = true;
        let request: ProjectCommand;
        try {
          request = JSON.parse(line);
          if (request.version !== 1 || request.signature !== command.signature
            || (request.resume !== undefined && typeof request.resume !== 'string')
            || (request.prompt !== undefined && typeof request.prompt !== 'string'))
            throw new Error('This project is already open with different settings. Exit its client before changing the backend settings.');
        } catch (error) { reply(error); return; }
        const work = queue.then(() => handle(request));
        queue = work.catch(() => {});
        void work.then(() => reply(), reply);
      }, () => { clearTimeout(timer); connections.delete(connection); });
    });
  } catch (error) {
    if (code(error) === 'EADDRINUSE' && await contactProject(address, command)) return null;
    throw error;
  }
  return { close: async () => {
    await server.close();
    for (const connection of connections) connection.destroy();
  } };
}
