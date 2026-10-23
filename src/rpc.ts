import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { parseRpcMessage, record, validateResult, type Method, type Params, type Result, type RpcId, type RpcMessage } from './protocol';

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); }
}

/** A written request may have taken effect even though no usable reply arrived. */
export class RpcOutcomeUnknown extends Error {
  constructor(readonly method: Method, readonly requestId: RpcId, message: string) { super(message); }
}

/** Only transport: no model calls, approval decisions, prompts, or retry of mutations. */
export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<RpcId, { method: Method; resolve: (value: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closing = false;
  private stderrTail = '';
  private readonly owned = new Set<string>();
  connected = false;
  codexHome?: string;
  get pid() { return this.child?.pid; }
  ownsThread(id: string) { return this.owned.has(id); }

  constructor(readonly options: { binary?: string; cwd: string; args?: string[]; timeoutMs?: number }) { super(); }

  async start() {
    if (this.child) throw new Error('Codex is already started');
    this.closing = false; this.stderrTail = '';
    const child = this.child = spawn(this.options.binary ?? process.env.CODEX_BINARY ?? 'codex',
      ['app-server', ...(this.options.args ?? [])], {
        cwd: this.options.cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
      });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      if (this.child !== child) return;
      let message: RpcMessage;
      try { message = parseRpcMessage(JSON.parse(line)); }
      catch { this.emit('diagnostic', 'Invalid message from app-server was ignored'); return; }
      this.receive(message);
    });
    this.child.stderr.on('data', chunk => {
      if (this.child !== child) return;
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-6000);
      this.emit('diagnostic', chunk.toString());
    });
    this.child.stdin.on('error', e => { if (this.child === child) this.fail(e); });
    this.child.on('error', e => { if (this.child === child) this.fail(e); });
    this.child.on('exit', (code, signal) => {
      lines.close();
      if (this.child !== child) return;
      this.connected = false;
      this.owned.clear();
      this.fail(new Error(`Codex app-server exited (${signal ?? code}). ${this.stderrTail.slice(-1500)}`));
      if (!this.closing) this.emit('disconnected', `Codex disconnected (${signal ?? code}). The task may have been accepted. Resume the session to check; input will not be resent automatically.`);
    });
    const result = await this.request('initialize', {
      clientInfo: { name: 'codex-tern', title: 'Codex × Tern', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: 'initialized', params: {} });
    this.codexHome = result.codexHome;
    this.connected = true;
    return result;
  }

  async restart() {
    await this.close();
    this.child = undefined;
    return this.start();
  }

  private receive(message: RpcMessage) {
    if (message.method) {
      if (message.method === 'thread/started' && message.params?.thread?.id) this.owned.add(message.params.thread.id);
      if (message.method === 'thread/closed' || message.method === 'thread/deleted') this.owned.delete(message.params?.threadId);
      this.emit(message.id !== undefined ? 'request' : 'notification', message);
    } else if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new RpcError(message.error.message, message.error.code, message.error.data));
      else {
        try { validateResult(entry.method, message.result); entry.resolve(message.result); }
        catch { entry.reject(new RpcOutcomeUnknown(entry.method, message.id,
          `${entry.method} returned an invalid response. The result is unknown; check the session before retrying.`)); }
      }
    }
  }

  request<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcOutcomeUnknown(method, id, `${method} timed out. The result is unknown. Check the session before retrying; nothing was resent.`));
      }, this.options.timeoutMs ?? 90_000);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    }).then(result => {
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
        const thread = record(result) && record(result.thread) ? result.thread : undefined;
        if (typeof thread?.id === 'string') this.owned.add(thread.id);
      }
      return result as Result<M>;
    });
  }

  respond(id: RpcId, result: unknown) { this.write({ id, result }); }
  rejectRequest(id: RpcId, message: string) { this.write({ id, error: { code: -32601, message } }); }

  private write(message: RpcMessage) {
    if (!this.child || this.child.stdin.destroyed || this.closing) throw new Error('The Codex connection is unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private fail(error: Error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcOutcomeUnknown(entry.method, id, error.message));
    }
    this.pending.clear();
  }

  async close() {
    this.closing = true;
    this.connected = false;
    this.owned.clear();
    this.fail(new Error('Client closed'));
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const terminate = setTimeout(() => child.kill('SIGTERM'), 1500);
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(terminate); clearTimeout(kill); resolve(); });
      child.stdin.end();
    });
  }
}
