import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { HELP, VERSION, nativeArgs, parseOptions } from './options';
import { findExecutable, openTern, focusClient } from './launch';
import { CodexRpc } from './rpc';
import { Controller } from './controller';
import { RecoveryStore, recoveryPath } from './recovery';
import { Preferences, preferencesPath } from './preferences';
import type { ProjectInstance, ProjectCommand } from './project-instance';

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  if (options.version) { console.log(VERSION); return; }
  if (options.command) {
    await (await import('./tern-plugin')).runPluginCommand(options.command);
    return;
  }
  if (!(await stat(options.cwd).catch(() => null))?.isDirectory())
    throw new Error(`Project directory does not exist or is not a directory: ${options.cwd}`);
  const binary = options.codex ?? process.env.CODEX_BINARY ?? 'codex';
  const codex = findExecutable(binary);
  if (!codex) throw new Error(`Codex executable was not found: ${binary}. Install the official Codex CLI and sign in with codex login, or use --codex /path/to/codex.`);
  const projects = options.plain ? null : await import('./project-instance');
  const address = projects ? await projects.projectAddress(options.cwd) : undefined;
  const command: ProjectCommand = { version: 1, signature: JSON.stringify([codex, options.config]),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}) };
  if (projects && address && await projects.contactProject(address, command)) return;
  const rpc = new CodexRpc({ binary: codex, cwd: options.cwd,
    args: ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"',
      ...options.config.flatMap(value => ['-c', value])] });
  const c = new Controller(rpc, rpc.options.cwd, new Preferences(preferencesPath()));
  let instance: ProjectInstance | null = null;
  let shuttingDown = false;
  const close = async () => {
    if (shuttingDown) return;
    shuttingDown = true; c.connection = 'disconnected';
    // Keep the project lease until the final journal is saved. A new client
    // must not read an older snapshot while this backend is still closing.
    try { await rpc.close(); await c.flushRecovery(); await c.flushOutlines(); }
    finally { await instance?.close(); }
  };
  try {
    const ui = options.plain ? null : await (await import('./native-host')).createNativeUI(c);
    if (!ui && !options.plain) {
      if (options.native) throw new Error('Tern native UI is unavailable. Run directly in a Tern pane without tmux, screen or zellij, or use --plain.');
      process.exitCode = await openTern(fileURLToPath(import.meta.url), nativeArgs(options, codex), options.cwd);
      return;
    }
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    if (ui && projects && address) {
      const openProject = async (cwd: string, resume?: string, prompt?: string) => {
        const target = await projects.projectAddress(cwd);
        const request: ProjectCommand = { version: 1, signature: command.signature, resume, prompt };
        if (await projects.contactProject(target, request)) return true;
        return await openTern(fileURLToPath(import.meta.url), nativeArgs({ ...options, cwd, resume, prompt }, codex), cwd) === 0;
      };
      ui.openProject = openProject;
      instance = await projects.serveProject(address, command, async request => {
        await started;
        if (shuttingDown || c.connection !== 'ready' || !c.thread) throw new Error('The project is not connected.');
        await focusClient();
        if (request.resume) {
          if (!rpc.ownsThread(request.resume)) {
            const result = await rpc.request('thread/read', { threadId: request.resume, includeTurns: false });
            if (result.thread?.cwd && await projects.projectAddress(result.thread.cwd) !== address) {
              if (!await openProject(result.thread.cwd, request.resume, request.prompt)) throw new Error('Could not open the project.');
              return;
            }
          }
          if (!await ui.openSession(request.resume)) throw new Error('This session is unavailable or open in another client.');
        } else if (request.prompt !== undefined && !await ui.newSession()) throw new Error('Could not create a session.');
        if (request.prompt !== undefined) await c.submit(request.prompt);
      });
      if (!instance) { await ui.close(); return; }
      try { c.useRecovery(await RecoveryStore.open(recoveryPath(address))); }
      catch (error) { c.notice((error as Error).message, true); }
      const recoveryFile = recoveryPath(address);
      c.useOutlines(join(dirname(dirname(recoveryFile)), 'outlines', basename(recoveryFile, '.json')));
    }
    // Never await backend work in the UI input loop: approvals and cancellation stay live.
    const connection = c.connect(options.resume, options.prompt !== undefined).then(async () => {
      if (options.prompt !== undefined) await c.submit(options.prompt);
    }).catch(e => {
      c.notice(e.message, true); c.connection = rpc.connected ? 'ready' : 'disconnected'; c.changed();
    }).finally(ready);
    const sidebar = ui?.openSidebar().catch(error => c.notice(error.message, true));
    if (ui) {
      await ui.run();
    } else {
      console.log('Codex × Tern · Plain text mode (launch in Tern for the native interface)');
      c.on('change', (() => {
        const seen = new Set<string>();
        const shownNotices = new WeakSet<object>();
        let account = c.account;
        return () => {
          if (c.account !== account) { account = c.account; console.log(`\n${account}`); }
          for (const item of c.items) {
            if (!item.done || seen.has(item.id)) continue;
            seen.add(item.id);
            if (item.item.type === 'agentMessage') console.log(`\nCodex: ${item.item.text}`);
            else if (item.item.type === 'commandExecution') console.log(`\n[Command] ${item.item.command}\n${item.item.aggregatedOutput ?? ''}`);
            else if (item.item.type === 'fileChange') console.log(`\n[Changes] ${JSON.stringify(item.item.changes, null, 2)}`);
          }
          for (const n of c.notices) if (!shownNotices.has(n)) {
            console.log(`\n${n.error ? 'Error' : 'Notice'}: ${n.text}`); shownNotices.add(n);
          }
        };
      })());
      rpc.on('request', m => console.log(`\n[Pending request ${m.id}] ${m.method}\n${JSON.stringify(m.params, null, 2)}\nRespond with /reply ${m.id} followed by the native JSON response.`));
      await connection;
      if (!c.thread) { process.exitCode = 1; return; }
      console.log(`Workspace: ${c.cwd}\nModel: ${c.model} · ${c.effort}\nType /help for commands.`);
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\n› ' });
      rl.on('SIGINT', () => { if (c.activeTurn) void c.act(() => c.stop()); else rl.close(); });
      rl.prompt();
      for await (const line of rl) {
        if (line === '/quit') break;
        // Commands are UI actions. Unknown slash input is sent verbatim to Codex.
        await c.act(async () => {
          if (line === '/help') console.log('/new · /threads · /resume ID · /reconnect · /stop · /queue TEXT · /next · /reply ID JSON · /unconfirmed · /sent ID · /retry ID · /quit');
          else if (line === '/reconnect') await c.reconnect();
          else if (line === '/new') await c.newThread();
          else if (line === '/threads') { await c.listThreads(); console.log(c.threads.map(t => `${t.id}  ${t.name || t.preview}`).join('\n')); }
          else if (line.startsWith('/resume ')) await c.resume(line.slice(8).trim());
          else if (line === '/stop') await c.stop();
          else if (line === '/next') await c.runQueue();
          else if (line === '/unconfirmed') {
            await c.refreshHistory();
            console.log(c.unconfirmed.map(q => `${q.id}  ${q.text || '[Image]'} (${q.images.length} images)`).join('\n'));
            console.log('Check the conversation, then use /sent ID or /retry ID. Retry only queues the message; /next sends it.');
          }
          else if (line.startsWith('/sent ')) c.resolveUnconfirmed(line.slice(6).trim());
          else if (line.startsWith('/retry ')) c.resolveUnconfirmed(line.slice(7).trim(), true);
          else if (line.startsWith('/queue ')) await c.submit(line.slice(7), [], 'queue');
          else if (line.startsWith('/reply ')) {
            const match = line.match(/^\/reply (\S+) ([\s\S]+)$/);
            if (!match) throw new Error('Usage: /reply ID JSON');
            const req = c.requests.find(r => String(r.id) === match[1]);
            if (!req) throw new Error('This request is no longer active'); c.answer(req.id, JSON.parse(match[2]));
          } else await c.submit(line);
        });
        rl.prompt();
      }
      rl.close();
    }
    await close();
    await Promise.all([connection, sidebar]);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e); process.exitCode = 1;
  } finally { await close(); }
}

main().catch(error => {
  console.error(`codex-tern: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
