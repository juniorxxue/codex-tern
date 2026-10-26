import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { CodexRpc, RpcOutcomeUnknown } from './rpc';
import { LatestRead } from './latest-read';
import type { PendingForkTitle } from './recovery';
import type { RpcId, RpcMessage } from './protocol';
import type { Thread } from './generated/v2/Thread';
import type { ThreadItem } from './generated/v2/ThreadItem';
import type { Model } from './generated/v2/Model';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse';
import type { ReasoningEffort } from './generated/ReasoningEffort';
import type { UserInput } from './generated/v2/UserInput';
import type { Turn } from './generated/v2/Turn';

export interface DisplayItem {
  id: string; turnId: string; item: ThreadItem; done: boolean;
  delivery?: 'sending' | 'accepted';
}
export interface PendingRequest { id: RpcId; method: string; params: any; answers: Record<string, string[]> }
export interface QueuedInput { id: string; text: string; images: string[] }
export interface Notice { id: number; text: string; error: boolean }

/** Disposable view state. Codex owns history, config, permissions and execution. */
export class Conversation extends EventEmitter {
  hydrated = false;
  connection: 'connecting' | 'ready' | 'disconnected' = 'connecting';
  thread?: Thread;
  pendingForkTitle?: PendingForkTitle;
  effective?: ThreadStartResponse;
  models: Model[] = [];
  account = 'Reading account…';
  items: DisplayItem[] = [];
  requests: PendingRequest[] = [];
  queue: QueuedInput[] = [];
  unconfirmed: QueuedInput[] = [];
  inflight?: QueuedInput;
  checkpoint?: () => Promise<void>;
  queuePaused = false;
  threads: Thread[] = [];
  threadsCursor: string | null = null;
  historyCursor: string | null = null;
  activeTurn: string | null = null;
  operation = '';
  notices: Notice[] = [];
  diagnostics: string[] = [];
  diff = '';
  plan: any[] = [];
  tokens: number | null = null;
  modelOverride?: string;
  effortOverride?: ReasoningEffort;
  readonly endedTurns = new Set<string>();
  readonly turns = new Map<string, Turn>();
  private noticeSeq = 0;
  private draining = false;
  private completion?: Turn;
  private readonly threadReads = new LatestRead();
  private threadScope?: string;
  private historyRead?: Promise<void>;
  private readonly partialItems = new Set<string>();
  private readonly itemVersions = new Map<string, number>();

  constructor(readonly rpc: CodexRpc, public cwd: string) {
    super();
  }

  get busy() { return this.activeTurn !== null || this.operation !== ''; }
  get model() { return this.modelOverride ?? this.effective?.model ?? 'Codex default'; }
  get effort() { return this.effortOverride ?? this.effective?.reasoningEffort ?? 'default'; }
  changed() {
    this.emit('change');
    if (this.completion && !this.busy && !this.draining) {
      const turn = this.completion; this.completion = undefined;
      if (turn.status !== 'completed' || !this.queue.length || this.queuePaused) this.emit('completed', turn);
    }
  }
  resetHistory() {
    this.items = []; this.turns.clear(); this.endedTurns.clear(); this.partialItems.clear(); this.itemVersions.clear();
    this.historyCursor = null; this.activeTurn = null; this.diff = ''; this.plan = []; this.completion = undefined;
  }
  private activity(at = Date.now() / 1000) {
    if (this.thread) this.thread.recencyAt = Math.max(this.thread.recencyAt ?? 0, at);
    this.emit('activity');
  }
  notice(text: string, error = false) {
    this.notices.push({ id: ++this.noticeSeq, text, error });
    this.notices = this.notices.slice(-6); this.changed();
  }
  async act(action: () => Promise<unknown>) {
    try { await action(); } catch (e) { this.notice(e instanceof Error ? e.message : String(e), true); }
  }

  async connect() {
    await this.rpc.start();
    await this.readAccountAndModels();
  }

  async readAccountAndModels() {
    const results = await Promise.allSettled([
      this.rpc.request('account/read', { refreshToken: false }),
      this.rpc.request('model/list', {}),
    ]);
    const [account, models] = results;
    if (account.status === 'fulfilled') {
      const a = account.value;
      this.account = a.account?.type === 'chatgpt' ? `ChatGPT · ${a.account.planType ?? 'Signed in'}`
        : a.account?.type ?? (a.requiresOpenaiAuth ? 'Sign in with codex login' : 'Connected');
    } else this.account = 'Account unavailable';
    if (models.status === 'fulfilled') this.models = models.value.data ?? [];
    else this.notice(`Could not load models: ${models.reason.message}`, true);
    this.connection = 'ready'; this.changed();
  }

  adopt(result: ThreadStartResponse) {
    this.thread = result.thread; this.effective = result; this.cwd = result.cwd;
  }

  listThreads(all = false, more = false) {
    const cwd = this.cwd;
    const scope = JSON.stringify([cwd, all]);
    const append = more && scope === this.threadScope;
    const cursor = append ? this.threadsCursor : null;
    if (append && !cursor) return Promise.resolve();
    this.threadScope = scope;
    if (!append) this.threadsCursor = null;
    return this.threadReads.run(JSON.stringify([scope, cursor]), () => this.rpc.request('thread/list', {
      limit: 30, sortKey: 'recency_at', sortDirection: 'desc',
      ...(all ? {} : { cwd }), ...(cursor ? { cursor } : {}),
    }), page => {
      if (this.cwd !== cwd) return;
      const rows = append ? [...this.threads, ...page.data] : page.data;
      this.threads = [...new Map<string, Thread>(rows.map((t: Thread) => [t.id, t])).values()];
      this.threadsCursor = page.nextCursor; this.changed();
    });
  }

  async resume(threadId: string) {
    if (this.connection !== 'ready') throw new Error('Codex is not connected yet');
    if (this.operation) throw new Error('Wait for the current operation');
    this.operation = 'Resuming session…'; this.changed();
    try {
      const result = await this.rpc.request('thread/resume', { threadId, excludeTurns: true });
      // Never fall back to a fresh thread on failure.
      this.adopt(result);
      this.historyCursor = null;
      await this.loadHistory();
      const live = this.items.findLast(i => !i.done);
      if (live) this.activeTurn = live.turnId;
    } finally { this.operation = ''; this.changed(); }
  }

  loadHistory(): Promise<void> {
    if (this.historyRead) return this.historyRead;
    const pending = this.readHistory().finally(() => {
      if (this.historyRead === pending) this.historyRead = undefined;
    });
    this.historyRead = pending;
    return pending;
  }

  private async readHistory() {
    if (!this.thread) return;
    const id = this.thread.id;
    const params = { threadId: id, limit: 15, sortDirection: 'desc' as const, itemsView: 'full' as const,
      ...(this.historyCursor ? { cursor: this.historyCursor } : {}) };
    let page;
    for (let attempt = 0; ; attempt++) {
      const versions = new Map(this.itemVersions);
      page = await this.rpc.request('thread/turns/list', params);
      if (this.thread?.id !== id) return;
      const overlap = page.data.some((turn: Turn) => turn.items.some(item => {
        const key = `${turn.id}:${item.id}`;
        return this.partialItems.has(key) && versions.get(key) !== this.itemVersions.get(key);
      }));
      if (!overlap) break;
      // The protocol has no snapshot watermark. Never guess whether a delta is
      // included, or concatenate it twice. Re-read the same page without mutations.
      if (attempt === 2) throw new Error('History is still changing. Open the session again to reload it.');
    }
    // A restored fork is eligible only while its history still ends at the fork
    // point and its inherited name has not been replaced by another client.
    if (!params.cursor && this.pendingForkTitle
      && (page.data[0]?.id !== this.pendingForkTitle.turnId
        || (this.thread.name?.trim() || null) !== this.pendingForkTitle.name)) this.pendingForkTitle = undefined;
    const old: DisplayItem[] = [];
    for (const turn of [...page.data].reverse()) {
      if (!this.endedTurns.has(turn.id)) this.turns.set(turn.id, turn);
      if (turn.status !== 'inProgress') {
        this.endedTurns.add(turn.id);
        if (this.activeTurn === turn.id) this.activeTurn = null;
      }
      for (const item of turn.items) old.push({ id: `${turn.id}:${item.id}`, turnId: turn.id,
        item, done: turn.status !== 'inProgress' || this.endedTurns.has(turn.id) });
      if (turn.status === 'inProgress' && !this.endedTurns.has(turn.id)) this.activeTurn = turn.id;
    }
    const current = new Map(this.items.map(i => [i.id, i]));
    const loaded = new Set(old.map(i => i.id));
    this.items = [...old.map(snapshot => {
      const live = current.get(snapshot.id) ?? this.pendingMessage(snapshot.turnId, snapshot.item);
      if (!live) return snapshot;
      if (live.delivery || this.partialItems.delete(snapshot.id) || (!live.done && snapshot.done)) {
        live.id = snapshot.id; live.item = snapshot.item; live.done = snapshot.done;
        delete live.delivery;
      }
      return live;
    }), ...this.items.filter(i => !loaded.has(i.id))];
    this.historyCursor = page.nextCursor; this.changed();
  }

  async submit(text: string, images: string[] = [], mode: 'steer' | 'queue' = 'steer', queuedId?: string) {
    if (!text.trim() && !images.length) return;
    if (!this.thread || this.connection !== 'ready') throw new Error('The session is not ready yet');
    if (this.unconfirmed.length) throw new Error('Check the unconfirmed message before sending again.');
    if (this.operation) throw new Error('Wait for the current operation to finish');
    if (mode === 'queue' && this.activeTurn) {
      const queued = { id: randomUUID(), text, images: [...images] };
      this.operation = 'Queuing…'; this.queue.push(queued); this.changed();
      try { if (this.checkpoint) await this.checkpoint(); }
      catch (error) { this.queue = this.queue.filter(q => q.id !== queued.id); this.queuePaused = true; this.changed(); throw error; }
      finally {
        this.operation = ''; this.changed();
        if (!this.activeTurn && this.queue.length && !this.queuePaused)
          setTimeout(() => void this.act(() => this.runQueue()), 0);
      }
      return;
    }
    const input: UserInput[] = [
      ...(text ? [{ type: 'text' as const, text, text_elements: [] }] : []),
      ...images.map(path => ({ type: 'localImage' as const, path })),
    ];
    const threadId = this.thread.id;
    const previousName = this.thread.name?.trim() || null;
    const forkTitle = this.pendingForkTitle;
    const firstInput = (forkTitle && forkTitle.name === previousName)
      || (!previousName && !this.thread.preview?.trim()
        && !this.thread.forkedFromId && this.turns.size === 0 && this.items.length === 0);
    const turnId = this.activeTurn;
    const outgoing = { id: queuedId ?? randomUUID(), text, images: [...images] };
    const pending: DisplayItem | undefined = turnId ? {
      id: `${turnId}:local:${outgoing.id}`, turnId, done: false, delivery: 'sending',
      item: { id: outgoing.id, type: 'userMessage', clientId: outgoing.id, content: input },
    } : undefined;
    if (pending) this.items.push(pending);
    this.operation = turnId ? 'Steering…' : 'Sending…';
    try {
      this.inflight = outgoing; this.changed();
      if (this.checkpoint) for (const path of images) {
        if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`Image unavailable: ${path}. Remove or reattach it before sending.`);
      }
      if (this.checkpoint) await this.checkpoint();
      if (this.connection !== 'ready') throw new Error('Codex disconnected before this message was sent.');
      if (turnId) {
        await this.rpc.request('turn/steer', { threadId, expectedTurnId: turnId,
          clientUserMessageId: outgoing.id, input });
        // A successful RPC can precede the user-message event by a long time.
        // An event received first must not become pending again after the reply.
        if (pending?.delivery) pending.delivery = 'accepted';
      } else {
        const result = await this.rpc.request('turn/start', { threadId, input,
          ...(this.modelOverride ? { model: this.modelOverride } : {}),
          ...(this.effortOverride ? { effort: this.effortOverride } : {}),
        });
        if (!this.endedTurns.has(result.turn.id)) this.turns.set(result.turn.id, result.turn);
        if (!this.endedTurns.has(result.turn.id)) this.activeTurn = result.turn.id;
      }
      if (queuedId) this.queue = this.queue.filter(q => q.id !== queuedId);
      const nameFirstInput = firstInput && (!forkTitle || this.pendingForkTitle === forkTitle);
      this.pendingForkTitle = undefined;
      // A new conversation belongs in history only after its first accepted input.
      if (this.thread && !this.thread.preview?.trim()) this.thread.preview = text.trim() || (images.length ? 'Image' : '');
      this.activity();
      if (nameFirstInput && text.trim()) this.emit('firstInput', text, previousName);
    } catch (e) {
      if (pending?.delivery) this.items = this.items.filter(i => i !== pending);
      this.queuePaused = true;
      if (e instanceof RpcOutcomeUnknown) this.unconfirmed.push(outgoing);
      throw e;
    } finally {
      this.inflight = undefined;
      this.operation = ''; this.changed();
      if (!this.draining && !this.activeTurn && this.queue.length && !this.queuePaused)
        setTimeout(() => void this.act(() => this.runQueue()), 0);
    }
  }

  async stop() {
    if (!this.thread || !this.activeTurn) return;
    this.queuePaused = true; this.changed();
    await this.rpc.request('turn/interrupt', { threadId: this.thread.id, turnId: this.activeTurn });
  }

  removeQueued(id: string) { this.queue = this.queue.filter(q => q.id !== id); this.changed(); }
  async runQueue() {
    if (this.busy || this.draining || !this.queue.length || this.unconfirmed.length || this.connection !== 'ready') return;
    this.queuePaused = false;
    const next = this.queue[0];
    this.draining = true;
    try {
      await this.submit(next.text, next.images, 'steer', next.id);
      this.queue = this.queue.filter(q => q.id !== next.id); this.changed();
    } catch (error) {
      // submit retained this input separately. It must no longer be runnable.
      if (error instanceof RpcOutcomeUnknown) this.queue = this.queue.filter(q => q.id !== next.id);
      throw error;
    } finally {
      this.draining = false;
      this.changed();
      if (!this.activeTurn && this.queue.length && !this.queuePaused)
        setTimeout(() => void this.act(() => this.runQueue()), 0);
    }
  }

  async refreshHistory() {
    if (this.historyRead) await this.historyRead;
    this.historyCursor = null;
    await this.loadHistory();
  }
  resolveUnconfirmed(id: string, retry = false) {
    const input = this.unconfirmed.find(q => q.id === id);
    if (!input) throw new Error('This message has already been resolved.');
    this.unconfirmed = this.unconfirmed.filter(q => q.id !== id);
    if (retry) this.queue.unshift(input);
    else this.pendingForkTitle = undefined;
    this.queuePaused = true; this.changed();
  }

  chooseModel(id: string) {
    if (this.busy) throw new Error('Model and effort can be changed after the current turn');
    this.modelOverride = id; this.effortOverride = undefined; this.changed();
  }
  chooseEffort(effort: ReasoningEffort) {
    if (this.busy) throw new Error('Change reasoning effort after the current turn');
    this.effortOverride = effort; this.changed();
  }

  answer(id: RpcId, result: unknown) {
    const request = this.requests.find(r => r.id === id);
    if (!request || this.connection !== 'ready') throw new Error('This request is no longer active');
    this.rpc.respond(id, result);
    this.requests = this.requests.filter(r => r.id !== id); this.changed();
  }

  onRequest(message: RpcMessage) {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!supported.includes(message.method!) ||
      (message.method === 'mcpServer/elicitation/request' && message.params?.mode !== 'url')) {
      this.rpc.rejectRequest(message.id!, `codex-tern prototype does not support ${message.method}`);
      this.notice(`${message.method} is not supported yet. An error was returned; no permission was granted.`, true); return;
    }
    if (!this.requests.some(request => request.id === message.id))
      this.requests.push({ id: message.id!, method: message.method!, params: message.params, answers: {} });
    this.changed();
  }

  private pendingMessage(turnId: string, item: ThreadItem) {
    if (item.type !== 'userMessage' || !item.clientId) return;
    // Match the backend's client ID, never text: identical steers are distinct.
    return this.items.find(i => i.delivery && i.turnId === turnId
      && i.item.type === 'userMessage' && i.item.clientId === item.clientId);
  }

  private upsert(turnId: string, item: ThreadItem, done: boolean) {
    const id = `${turnId}:${item.id}`;
    const existing = this.items.find(i => i.id === id) ?? this.pendingMessage(turnId, item);
    if (!done && (existing?.done || this.endedTurns.has(turnId))) return;
    this.partialItems.delete(id);
    this.itemVersions.set(id, (this.itemVersions.get(id) ?? 0) + 1);
    if (existing) { existing.id = id; existing.item = item; existing.done = done; delete existing.delivery; }
    else this.items.push({ id, turnId, item, done });
  }

  onNotification({ method, params: p }: RpcMessage) {
    if (method === 'serverRequest/resolved') {
      this.requests = this.requests.filter(r => r.id !== p.requestId); this.changed(); return;
    }
    if (p?.threadId && p.threadId !== this.thread?.id) return;
    let outlineChanged = false;
    switch (method) {
      case 'turn/started':
        if (!this.endedTurns.has(p.turn.id)) { this.activeTurn = p.turn.id; this.turns.set(p.turn.id, p.turn); }
        break;
      case 'turn/completed': {
        const firstCompletion = !this.endedTurns.has(p.turn.id);
        this.activity(p.turn.completedAt ?? Date.now() / 1000);
        this.turns.set(p.turn.id, p.turn);
        this.endedTurns.add(p.turn.id);
        if (this.activeTurn === p.turn.id) this.activeTurn = null;
        for (const item of p.turn.items ?? []) this.upsert(p.turn.id, item, true);
        for (const i of this.items) if (i.turnId === p.turn.id) i.done = true;
        this.requests = this.requests.filter(r => r.params.turnId !== p.turn.id);
        if (p.turn.error) this.notice(p.turn.error.message, true);
        if (p.turn.status !== 'completed') this.queuePaused = true;
        if (firstCompletion) this.completion = p.turn;
        outlineChanged = firstCompletion;
        if (this.queue.length && !this.queuePaused)
          setTimeout(() => void this.act(() => this.runQueue()), 0);
        break;
      }
      case 'item/started':
      case 'item/completed':
        this.upsert(p.turnId, p.item, method === 'item/completed');
        outlineChanged = p.item.type === 'userMessage';
        break;
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        let entry = this.items.find(i => i.id === `${p.turnId}:${p.itemId}`);
        if (entry?.done || this.endedTurns.has(p.turnId)) break;
        if (!entry) {
          this.upsert(p.turnId, method === 'item/plan/delta' ? { id: p.itemId, type: 'plan', text: '' }
            : { id: p.itemId, type: 'agentMessage', text: '', phase: null, memoryCitation: null, delivery: null, questions: null }, false);
          entry = this.items.at(-1)!;
          this.partialItems.add(entry.id);
        }
        this.itemVersions.set(entry.id, (this.itemVersions.get(entry.id) ?? 0) + 1);
        if (entry.item.type === 'agentMessage' || entry.item.type === 'plan') entry.item.text += p.delta;
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const entry = this.items.find(i => i.id === `${p.turnId}:${p.itemId}`);
        if (entry && !entry.done && entry.item.type === 'commandExecution') entry.item.aggregatedOutput = (entry.item.aggregatedOutput ?? '') + p.delta;
        break;
      }
      case 'item/fileChange/patchUpdated': {
        const entry = this.items.find(i => i.id === `${p.turnId}:${p.itemId}`);
        if (entry && !entry.done && entry.item.type === 'fileChange' && p.changes) entry.item.changes = p.changes; break;
      }
      case 'item/reasoning/summaryTextDelta': {
        const entry = this.items.find(i => i.id === `${p.turnId}:${p.itemId}`);
        if (entry && !entry.done && entry.item.type === 'reasoning') {
          entry.item.summary ??= [];
          entry.item.summary[p.summaryIndex] = (entry.item.summary[p.summaryIndex] ?? '') + p.delta;
        }
        break;
      }
      case 'turn/diff/updated': this.diff = p.diff; break;
      case 'turn/plan/updated': this.plan = p.plan; break;
      case 'thread/tokenUsage/updated': this.tokens = p.tokenUsage?.last?.totalTokens ?? null; break;
      case 'thread/name/updated': if (this.thread) this.thread.name = p.threadName ?? p.name; break;
      case 'thread/settings/updated':
        if (this.effective && p.threadSettings) {
          Object.assign(this.effective, p.threadSettings);
          this.effective.reasoningEffort = p.threadSettings.effort;
          this.effective.sandbox = p.threadSettings.sandboxPolicy;
        }
        break;
      case 'error': this.notice(p.error?.message ?? JSON.stringify(p), true); break;
      case 'warning': case 'configWarning': case 'deprecationNotice':
        this.notice(p.message ?? p.summary ?? JSON.stringify(p)); break;
      default:
        // Keep unknown notifications inspectable without inventing agent actions.
        this.diagnostics.push(`${method}: ${JSON.stringify(p).slice(0, 2000)}`);
        this.diagnostics = this.diagnostics.slice(-30);
    }
    this.changed();
    if (outlineChanged) this.emit('outlineChanged');
  }
}
