import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodexRpc } from './rpc';
import { Conversation } from './conversation';
import type { RpcId, RpcMessage } from './protocol';
import type { Thread } from './generated/v2/Thread';
import type { ReasoningEffort } from './generated/ReasoningEffort';
export type { DisplayItem, PendingRequest, QueuedInput, Notice } from './conversation';

/** One project runtime; changing the selected conversation never stops its work. */
export class Controller extends EventEmitter {
  private selected: Conversation;
  private readonly conversations = new Map<string, Conversation>();
  private readonly archived = new Set<string>();
  private navigation = '';
  private globalDiagnostics: string[] = [];
  sessionsVersion = 0;

  constructor(readonly rpc: CodexRpc, cwd: string) {
    super();
    this.selected = this.create(cwd);
    rpc.on('notification', (message: RpcMessage) => {
      if (message.method === 'turn/completed') this.sessionsVersion++;
      if (message.method === 'serverRequest/resolved' && !message.params?.threadId) {
        for (const conversation of this.all()) conversation.onNotification(message);
        return;
      }
      const id = message.params?.threadId ?? message.params?.thread?.id;
      const target = id ? this.conversation(id) : this.selected;
      if (target && message.method === 'thread/closed') target.hydrated = false;
      target?.onNotification(message);
    });
    rpc.on('request', (message: RpcMessage) => {
      const id = message.params?.threadId;
      const target = id ? this.conversation(id) : this.selected;
      target?.onRequest(message);
    });
    rpc.on('diagnostic', (text: string) => {
      this.globalDiagnostics.push(text); this.globalDiagnostics = this.globalDiagnostics.slice(-30);
    });
    rpc.on('disconnected', (text: string) => {
      for (const conversation of this.all()) {
        conversation.connection = 'disconnected'; conversation.activeTurn = null;
        conversation.requests = []; conversation.queuePaused = true; conversation.notice(text, true);
      }
    });
  }

  private all() { return new Set([this.selected, ...this.conversations.values()]); }
  private find(id: string) { return this.conversations.get(id) ?? (this.thread?.id === id ? this.selected : undefined); }
  /** Register before any await. Requests and replies always reach the same owner. */
  private conversation(id: string) {
    const existing = this.find(id);
    if (existing) return existing;
    const next = this.create(this.cwd);
    next.thread = { id, cwd: this.cwd } as Thread;
    this.conversations.set(id, next);
    return next;
  }
  private async prepareSession(id: string) {
    const next = this.conversation(id);
    if (!next.hydrated) {
      await next.resume(id);
      next.hydrated = true;
    }
    return next;
  }
  private async prepareNew(cwd: string) {
    const path = resolve(this.cwd, cwd);
    if (!(await stat(path)).isDirectory()) throw new Error('The workspace path must be a directory');
    const result = await this.rpc.request('thread/start', { cwd: path });
    // A notification may already have registered this id while the RPC was pending.
    const next = this.conversation(result.thread.id);
    next.adopt(result); next.hydrated = true;
    return next;
  }
  private create(cwd: string) {
    const conversation = new Conversation(this.rpc, cwd);
    if (this.selected) {
      conversation.connection = this.connection;
      conversation.models = this.models; conversation.account = this.account;
    }
    let previous = '';
    conversation.on('activity', () => { this.sessionsVersion++; });
    conversation.on('change', () => {
      const status = JSON.stringify([conversation.thread?.name, conversation.activeTurn, conversation.operation,
        conversation.requests.length, conversation.queue.length, conversation.unconfirmed.length, conversation.endedTurns.size, conversation.thread?.recencyAt]);
      // Background deltas stay in memory; only status changes redraw the rail.
      if (conversation === this.selected || status !== previous) this.changed();
      previous = status;
    });
    return conversation;
  }
  private remember(conversation: Conversation) {
    if (conversation.thread) this.conversations.set(conversation.thread.id, conversation);
  }
  private ensureSelection() {
    if (this.connection !== 'ready') throw new Error('Codex is not connected yet');
    if (this.selecting) throw new Error('Wait for the session to finish opening');
    this.remember(this.selected);
  }

  get thread() { return this.selected.thread; }
  set thread(value: Conversation['thread']) {
    const previous = this.selected.thread?.id;
    if (previous && previous !== value?.id && this.conversations.get(previous) === this.selected) this.conversations.delete(previous);
    this.selected.thread = value; this.selected.hydrated = !!value;
    this.remember(this.selected);
  }
  get effective() { return this.selected.effective; }
  set effective(value: Conversation['effective']) { this.selected.effective = value; }
  get items() { return this.selected.items; }
  set items(value: Conversation['items']) { this.selected.items = value; }
  get requests() { return this.selected.requests; }
  set requests(value: Conversation['requests']) { this.selected.requests = value; }
  get queue() { return this.selected.queue; }
  get unconfirmed() { return this.selected.unconfirmed; }
  set queue(value: Conversation['queue']) { this.selected.queue = value; }
  get queuePaused() { return this.selected.queuePaused; }
  set queuePaused(value: Conversation['queuePaused']) { this.selected.queuePaused = value; }
  get historyCursor() { return this.selected.historyCursor; }
  set historyCursor(value: Conversation['historyCursor']) { this.selected.historyCursor = value; }
  get activeTurn() { return this.selected.activeTurn; }
  set activeTurn(value: Conversation['activeTurn']) { this.selected.activeTurn = value; }
  get notices() { return this.selected.notices; }
  set notices(value: Conversation['notices']) { this.selected.notices = value; }
  get diff() { return this.selected.diff; }
  set diff(value: Conversation['diff']) { this.selected.diff = value; }
  get plan() { return this.selected.plan; }
  set plan(value: Conversation['plan']) { this.selected.plan = value; }
  get tokens() { return this.selected.tokens; }
  set tokens(value: Conversation['tokens']) { this.selected.tokens = value; }
  get modelOverride() { return this.selected.modelOverride; }
  set modelOverride(value: Conversation['modelOverride']) { this.selected.modelOverride = value; }
  get effortOverride() { return this.selected.effortOverride; }
  set effortOverride(value: Conversation['effortOverride']) { this.selected.effortOverride = value; }
  get threads() { return this.selected.threads; }
  set threads(value: Conversation['threads']) { this.selected.threads = value; }
  get threadsCursor() { return this.selected.threadsCursor; }
  set threadsCursor(value: Conversation['threadsCursor']) { this.selected.threadsCursor = value; }
  get cwd() { return this.selected.cwd; }
  set cwd(value: Conversation['cwd']) { this.selected.cwd = value; }
  get connection() { return this.selected.connection; }
  set connection(value: Conversation['connection']) { for (const c of this.all()) c.connection = value; }
  get models() { return this.selected.models; }
  get account() { return this.selected.account; }
  get diagnostics() { return [...this.globalDiagnostics, ...this.selected.diagnostics].slice(-30); }
  get endedTurns() { return this.selected.endedTurns; }
  get turns() { return this.selected.turns; }
  get model() { return this.selected.model; }
  get effort() { return this.selected.effort; }
  get operation() { return this.navigation || this.selected.operation; }
  set operation(value: string) { this.selected.operation = value; }
  get selecting() { return this.navigation !== ''; }
  get busy() { return this.selecting || this.selected.busy; }
  get hasWork() { return [...this.all()].some(c => c.busy || c.queue.length || c.requests.length || c.unconfirmed.length); }
  sessionStatus(id: string) {
    const c = this.find(id);
    return { running: !!c?.activeTurn, waiting: !!(c?.requests.length || c?.unconfirmed.length) };
  }
  sessionHasContent(id: string) {
    const c = this.find(id);
    return !!(c?.items.length || c?.activeTurn || c?.requests.length || c?.queue.length || c?.unconfirmed.length);
  }
  sessionThread(id: string) { return this.find(id)?.thread; }
  isArchived(id: string) { return this.archived.has(id); }
  canArchiveSession(id: string) {
    const conversation = this.find(id);
    return this.connection === 'ready' && !this.selecting && !this.isArchived(id)
      && !conversation?.busy && !conversation?.requests.length && !conversation?.queue.length && !conversation?.unconfirmed.length;
  }
  changed() { this.emit('change'); }
  notice(text: string, error = false) { this.selected.notice(text, error); }
  sessionNotice(id: string | undefined, text: string, error = false) {
    (id ? this.find(id) : this.selected)?.notice(text, error);
  }
  preserveInput(id: string | undefined, text: string, images: string[]) {
    const conversation = id ? this.find(id) : this.selected;
    if (!conversation) return;
    conversation.queue.unshift({ id: randomUUID(), text, images });
    conversation.queuePaused = true; conversation.changed();
  }
  async act(action: () => Promise<unknown>) {
    try { await action(); } catch (error) { this.notice(error instanceof Error ? error.message : String(error), true); }
  }

  async connect(resumeId?: string) {
    await this.selected.connect();
    this.connection = 'ready';
    if (resumeId) await this.resume(resumeId); else await this.newThread();
    this.sessionsVersion++; this.changed();
  }
  async newThread(cwd = this.cwd) {
    this.ensureSelection();
    this.navigation = 'Creating session…'; this.changed();
    try {
      this.selected = await this.prepareNew(cwd); this.sessionsVersion++;
    } finally { this.navigation = ''; this.changed(); }
  }
  async resume(id: string) {
    this.ensureSelection();
    const cached = this.find(id);
    if (cached?.hydrated) { this.selected = cached; this.changed(); return; }
    this.navigation = 'Opening session…'; this.changed();
    try {
      this.selected = await this.prepareSession(id);
    } finally { this.navigation = ''; this.changed(); }
  }
  async archiveThread(id: string, replacementId?: string) {
    this.ensureSelection();
    if (!this.canArchiveSession(id)) throw new Error('Finish this session\'s task, answers and queue before deleting.');
    const current = this.thread?.id === id;
    this.navigation = 'Deleting session…'; this.changed();
    try {
      // Open an existing neighbour before archiving the selected conversation.
      // If opening fails, leave the original conversation selected and intact.
      const replacement = current ? replacementId ?? [...this.all()].find(c => c.thread?.id !== id
        && c.cwd === this.cwd && (c.thread?.name?.trim() || c.thread?.preview?.trim() || c.items.length))?.thread?.id : undefined;
      if (replacement && (replacement === id || this.isArchived(replacement))) throw new Error('Choose another session before deleting.');
      const next = current ? await (replacement ? this.prepareSession(replacement) : this.prepareNew(this.cwd)) : undefined;
      await this.rpc.request('thread/archive', { threadId: id });
      this.archived.add(id);
      this.conversations.delete(id);
      if (next) { next.hydrated = true; this.selected = next; this.remember(next); }
      for (const conversation of this.all()) conversation.threads = conversation.threads.filter(t => t.id !== id);
      this.sessionsVersion++;
    } finally { this.navigation = ''; this.changed(); }
  }
  async listThreads(all = false, more = false) {
    const target = this.selected;
    await target.listThreads(all, more);
    target.threads = target.threads.filter(t => !this.isArchived(t.id));
  }
  loadHistory() { return this.selected.loadHistory(); }
  refreshHistory() { return this.selected.refreshHistory(); }
  resolveUnconfirmed(id: string, retry = false) { this.selected.resolveUnconfirmed(id, retry); }
  submit(text: string, images: string[] = [], mode: 'steer' | 'queue' = 'steer') {
    if (this.selecting) return Promise.reject(new Error('Wait for the session to finish opening'));
    return this.selected.submit(text, images, mode);
  }
  stop() { return this.selected.stop(); }
  runQueue() { return this.selected.runQueue(); }
  removeQueued(id: string) { this.selected.removeQueued(id); }
  chooseModel(id: string) { this.selected.chooseModel(id); }
  chooseEffort(effort: ReasoningEffort) { this.selected.chooseEffort(effort); }
  answer(id: RpcId, result: unknown) { this.selected.answer(id, result); }
}
