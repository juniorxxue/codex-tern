import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodexRpc, RpcError } from './rpc';
import { Conversation } from './conversation';
import type { RpcId, RpcMessage } from './protocol';
import type { Thread } from './generated/v2/Thread';
import type { ReasoningEffort } from './generated/ReasoningEffort';
import type { Turn } from './generated/v2/Turn';
import { RecoveryStore, type SavedDraft } from './recovery';
export type { DisplayItem, PendingRequest, QueuedInput, Notice } from './conversation';
export interface Completion { threadId: string; turnId: string; title: string; status: 'completed' | 'failed' }

/** One project runtime; changing the selected conversation never stops its work. */
export class Controller extends EventEmitter {
  private selected: Conversation;
  private readonly conversations = new Map<string, Conversation>();
  private readonly archived = new Set<string>();
  private navigation = '';
  private globalDiagnostics: string[] = [];
  sessionsVersion = 0;
  private recovery?: RecoveryStore;
  private recoveryError = '';
  private reconnecting?: Promise<void>;
  private readonly unread = new Map<string, Completion>();
  notifications = true;

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
      if (id && message.method === 'thread/name/updated') this.updateThreadName(id, message.params.threadName);
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
        conversation.hydrated = false;
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
  private emptyRecoverySession(id: string) {
    const saved = this.recovery?.session(id), conversation = this.find(id);
    return !!saved && !saved.name?.trim() && !saved.preview?.trim()
      && !saved.draft.text && !saved.draft.images.length && !saved.queue.length
      && !saved.unconfirmed.length && !saved.inflight
      && !conversation?.items.length && !conversation?.turns.size && !conversation?.activeTurn
      && !conversation?.requests.length && !conversation?.queue.length
      && !conversation?.unconfirmed.length && !conversation?.inflight;
  }
  private async prepareSession(id: string, recoverEmpty = false) {
    const next = this.conversation(id);
    if (!next.hydrated) {
      try { await next.resume(id); }
      catch (error) {
        // A blank local selection can outlive its backend record. Only automatic
        // recovery may replace it, and only after an explicit missing-rollout reply.
        if (!recoverEmpty || !this.emptyRecoverySession(id) || !(error instanceof RpcError)
          || error.message !== `no rollout found for thread id ${id}`) throw error;
        const replacement = await this.prepareNew(next.cwd);
        // Typing can continue while creation is pending. Keep any new input
        // attached to the original selection instead of discarding it.
        if (!this.emptyRecoverySession(id)) throw error;
        this.recovery?.remove(id);
        this.conversations.delete(id);
        return replacement;
      }
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
    if (this.recovery) conversation.checkpoint = () => this.flushRecovery();
    if (this.selected) {
      conversation.connection = this.connection;
      conversation.models = this.models; conversation.account = this.account;
    }
    let previous = '';
    conversation.on('activity', () => { this.sessionsVersion++; });
    conversation.on('completed', (turn: Turn) => {
      if (!conversation.thread || !['completed', 'failed'].includes(turn.status)) return;
      // A queue is one stretch of work. Report success when its last turn ends.
      if (turn.status === 'completed' && conversation.queue.length && !conversation.queuePaused) return;
      const event: Completion = { threadId: conversation.thread.id, turnId: turn.id,
        title: conversation.thread.name || conversation.thread.preview || 'Codex', status: turn.status as Completion['status'] };
      this.unread.set(event.threadId, event);
      this.emit('completion', event);
    });
    conversation.on('change', () => {
      if (conversation.activeTurn && conversation.thread) this.unread.delete(conversation.thread.id);
      this.saveConversation(conversation);
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
  get sessionReady() { return this.selected.hydrated && this.connection === 'ready'; }
  get hasWork() { return [...this.all()].some(c => c.busy || c.queue.length || c.requests.length || c.unconfirmed.length); }
  sessionStatus(id: string) {
    const c = this.find(id);
    return { running: !!c?.activeTurn, waiting: !!(c?.requests.length || c?.unconfirmed.length),
      completed: this.unread.get(id)?.status === 'completed', failed: this.unread.get(id)?.status === 'failed' };
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
  changed() {
    if (this.thread?.id) this.recovery?.select(this.thread.id);
    this.emit('change');
  }
  markRead(id: string) { if (this.unread.delete(id)) this.changed(); }
  setNotifications(enabled: boolean) { this.notifications = enabled; this.recovery?.setNotifications(enabled); this.changed(); }

  useRecovery(store: RecoveryStore) {
    this.recovery = store; this.notifications = store.notifications;
    store.onError = error => {
      if (this.recoveryError === error.message) return;
      this.recoveryError = error.message;
      this.notice(`Drafts could not be saved: ${error.message}`, true);
    };
    for (const saved of store.sessions) {
      const conversation = this.conversation(saved.id);
      conversation.cwd = saved.cwd;
      conversation.thread = { id: saved.id, cwd: saved.cwd, name: saved.name, preview: saved.preview } as Thread;
      conversation.queue = structuredClone(saved.queue.filter(q => q.id !== saved.inflight?.id));
      conversation.unconfirmed = structuredClone([...new Map([...saved.unconfirmed,
        ...(saved.inflight ? [saved.inflight] : [])].map(q => [q.id, q])).values()]);
      conversation.queuePaused = true;
    }
    for (const conversation of this.all()) conversation.checkpoint = () => this.flushRecovery();
  }
  private saveConversation(conversation: Conversation) {
    const thread = conversation.thread;
    if (!this.recovery || !thread || this.isArchived(thread.id)) return;
    this.recovery.update({ id: thread.id, cwd: conversation.cwd, name: thread.name ?? undefined, preview: thread.preview,
      draft: this.recovery.session(thread.id)?.draft ?? { text: '', images: [] },
      queue: conversation.queue, unconfirmed: conversation.unconfirmed, inflight: conversation.inflight });
  }
  savedDraft(id: string): SavedDraft | undefined { return this.recovery?.session(id)?.draft; }
  saveDraft(id: string, draft: SavedDraft) {
    if (!this.recovery || this.isArchived(id)) return;
    const conversation = this.find(id);
    if (conversation) this.saveConversation(conversation);
    const saved = this.recovery.session(id);
    if (saved) this.recovery.update({ ...saved, draft });
  }
  async flushRecovery() {
    for (const conversation of this.all()) this.saveConversation(conversation);
    await this.recovery?.flush(); this.recoveryError = '';
  }
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

  async connect(resumeId?: string, fresh = false) {
    await this.selected.connect();
    this.connection = 'ready';
    for (const conversation of this.all()) {
      conversation.models = this.selected.models; conversation.account = this.selected.account;
    }
    const id = resumeId ?? (fresh ? undefined : this.recovery?.selected);
    if (id) {
      if (this.recovery?.session(id)) { this.selected = this.conversation(id); this.changed(); }
      await this.resume(id, resumeId === undefined);
    } else await this.newThread();
    this.sessionsVersion++; this.changed();
  }
  reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    if (this.connection === 'ready' && this.sessionReady) return Promise.resolve();
    const work = this.reconnectBackend().finally(() => { this.reconnecting = undefined; });
    this.reconnecting = work; return work;
  }
  private async reconnectBackend() {
    if (this.selecting || [...this.all()].some(c => !!c.operation)) throw new Error('Wait for the current operation to finish.');
    const recoverEmpty = !!this.thread && this.emptyRecoverySession(this.thread.id);
    this.navigation = 'Reconnecting…'; this.connection = 'connecting'; this.changed();
    try {
      for (const conversation of this.all()) {
        conversation.hydrated = false; conversation.queuePaused = true; conversation.requests = [];
        conversation.resetHistory();
      }
      await this.rpc.restart();
      await this.selected.readAccountAndModels();
      this.connection = 'ready';
      for (const conversation of this.all()) {
        conversation.models = this.selected.models; conversation.account = this.selected.account;
      }
      if (this.thread) {
        // Keep local drafts and queues; refresh only the selected thread's backend state.
        this.selected = await this.prepareSession(this.thread.id, recoverEmpty);
      } else this.selected = await this.prepareNew(this.cwd);
      this.sessionsVersion++;
    } catch (error) { this.connection = this.rpc.connected ? 'ready' : 'disconnected'; throw error; }
    finally { this.navigation = ''; this.changed(); }
  }
  async newThread(cwd = this.cwd) {
    this.ensureSelection();
    this.navigation = 'Creating session…'; this.changed();
    try {
      this.selected = await this.prepareNew(cwd); this.sessionsVersion++;
    } finally { this.navigation = ''; this.changed(); }
  }
  async resume(id: string, recoverEmpty = false) {
    this.ensureSelection();
    const cached = this.find(id);
    if (cached?.hydrated) { this.selected = cached; this.changed(); return; }
    this.navigation = 'Opening session…'; this.changed();
    try {
      this.selected = await this.prepareSession(id, recoverEmpty);
    } finally { this.navigation = ''; this.changed(); }
  }
  forkReply(turnId: string) {
    if (this.turns.get(turnId)?.status !== 'completed') return undefined;
    return this.items.findLast(entry => entry.turnId === turnId && entry.done
      && entry.item.type === 'agentMessage' && entry.item.phase !== 'commentary');
  }
  async forkThread(threadId: string, turnId: string) {
    this.ensureSelection();
    if (this.thread?.id !== threadId || !this.sessionReady || !this.forkReply(turnId))
      throw new Error('Choose a completed reply in the current session to fork.');
    const source = this.selected;
    this.navigation = 'Forking session…'; this.changed();
    try {
      const result = await this.rpc.request('thread/fork', {
        threadId, lastTurnId: turnId, cwd: source.cwd, excludeTurns: true,
      });
      const next = this.conversation(result.thread.id);
      next.adopt(result);
      next.modelOverride = source.modelOverride; next.effortOverride = source.effortOverride;
      try { await next.loadHistory(); next.hydrated = true; }
      finally {
        // Creation already succeeded. Keep the fork accessible even if reading
        // its history fails; Retry can reopen it without creating another fork.
        this.selected = next; this.sessionsVersion++;
      }
    } finally { this.navigation = ''; this.changed(); }
  }
  private updateThreadName(id: string, name: string | null) {
    const conversation = this.conversation(id);
    conversation.thread!.name = name;
    for (const owner of this.all()) for (const thread of owner.threads) if (thread.id === id) thread.name = name;
    this.saveConversation(conversation);
    this.sessionsVersion++; this.changed();
  }
  async renameThread(id: string, value: string) {
    if (this.connection !== 'ready') throw new Error('Codex is not connected yet.');
    if (this.selecting || this.isArchived(id)) throw new Error('This session is unavailable.');
    const name = value.trim();
    if (!name) throw new Error('Enter a session name.');
    await this.rpc.request('thread/name/set', { threadId: id, name });
    this.updateThreadName(id, name);
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
      this.recovery?.remove(id); this.unread.delete(id);
      this.conversations.delete(id);
      if (next) { next.hydrated = true; this.selected = next; this.remember(next); }
      for (const conversation of this.all()) conversation.threads = conversation.threads.filter(t => t.id !== id);
      this.sessionsVersion++;
    } finally { this.navigation = ''; this.changed(); }
  }
  async listThreads(all = false, more = false) {
    const target = this.selected;
    await target.listThreads(all, more);
    target.threads = target.threads.filter(t => !this.isArchived(t.id)).map(t => {
      const local = this.sessionThread(t.id);
      return local?.name !== undefined ? { ...t, name: local.name } : t;
    });
  }
  loadHistory() { return this.selected.loadHistory(); }
  refreshHistory() { return this.selected.refreshHistory(); }
  resolveUnconfirmed(id: string, retry = false) { this.selected.resolveUnconfirmed(id, retry); }
  submit(text: string, images: string[] = [], mode: 'steer' | 'queue' = 'steer') {
    if (this.selecting) return Promise.reject(new Error('Wait for the session to finish opening'));
    if (!this.sessionReady) return Promise.reject(new Error('Reconnect and open this session before sending.'));
    return this.selected.submit(text, images, mode);
  }
  stop() { return this.selected.stop(); }
  runQueue() {
    if (!this.sessionReady) return Promise.reject(new Error('Reconnect and open this session before sending.'));
    return this.selected.runQueue();
  }
  removeQueued(id: string) { this.selected.removeQueued(id); }
  chooseModel(id: string) { this.selected.chooseModel(id); }
  chooseEffort(effort: ReasoningEffort) { this.selected.chooseEffort(effort); }
  answer(id: RpcId, result: unknown) { this.selected.answer(id, result); }
}
