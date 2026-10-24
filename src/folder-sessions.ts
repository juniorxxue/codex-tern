import { resolve } from 'node:path';
import type { Controller } from './controller';
import type { Thread } from './generated/v2/Thread';
import { probeWriterLocks, type LockProbe } from './session-locks';

export interface FolderSession {
  id: string;
  title: string;
  titleRevision?: string;
  updatedAt: number;
  time: string;
  locked: boolean;
  running: boolean;
  waiting: boolean;
  completed: boolean;
  failed: boolean;
  canArchive: boolean;
}

function activityAt(thread: Thread) {
  return [thread.recencyAt, thread.updatedAt, thread.createdAt].find(time => typeof time === 'number' && Number.isFinite(time)) ?? 0;
}

/** A separate list cache: the legacy history picker's scope cannot change it. */
export class FolderSessions {
  private cwd: string;
  private threads: Thread[] = [];
  private cursor: string | null = null;
  private pages = 0;
  private generation = 0;
  private request?: { generation: number; promise: Promise<void> };
  private visible = false;
  private disposed = false;
  private observed = '';
  private locked = new Set<string>();
  private conflicts = new Map<string, number>();
  private lockRequest?: { generation: number; ids: string; promise: Promise<void> };
  private readonly timeFormat = new Intl.DateTimeFormat(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  loading = false;
  error = '';

  constructor(private readonly c: Controller, private readonly changed: () => void,
    private readonly probe: LockProbe = ids => probeWriterLocks(c.rpc, ids)) {
    this.cwd = c.cwd;
    this.rememberCurrent();
    this.observed = this.fingerprint();
    c.on('change', this.observe);
  }

  // Opening history changes updatedAt, but does not constitute chat activity.
  private fingerprint() { return JSON.stringify([this.c.cwd, this.c.connection, this.c.sessionsVersion]); }

  private sort() { this.threads.sort((a, b) => activityAt(b) - activityAt(a)); }

  private mergeLocal() {
    this.threads = this.threads.map(thread => {
      const local = this.c.sessionThread(thread.id);
      return local ? { ...thread, ...(local.name !== undefined ? { name: local.name } : {}),
        ...(local.preview ? { preview: local.preview } : {}),
        recencyAt: Math.max(activityAt(thread), activityAt(local)) } : thread;
    });
    this.sort();
  }

  private rememberCurrent() {
    const current = this.c.thread;
    if (!current?.cwd || this.c.isArchived(current.id) || resolve(current.cwd) !== resolve(this.cwd)) return;
    const at = this.threads.findIndex(t => t.id === current.id);
    if (at < 0) this.threads.push(current);
    this.mergeLocal();
  }

  private observe = () => {
    if (this.cwd !== this.c.cwd) {
      this.cwd = this.c.cwd; this.generation++;
      this.threads = []; this.cursor = null; this.pages = 0; this.loading = false; this.error = '';
      this.locked.clear(); this.conflicts.clear();
    }
    this.rememberCurrent();
    const next = this.fingerprint();
    if (next === this.observed) return;
    this.observed = next;
    if (this.visible && this.c.connection === 'ready') void this.refresh();
  };

  get snapshot() {
    const current = this.c.thread;
    const rows: FolderSession[] = this.threads.filter(t => !t.ephemeral && !this.c.isArchived(t.id)
      && (t.name?.trim() || t.preview?.trim() || this.c.sessionHasContent(t.id))).map(t => ({
      id: t.id, title: (t.name || t.preview || 'New session').replace(/\s+/g, ' ').slice(0, 240),
      titleRevision: this.c.sessionTitleRevision(t.id),
      updatedAt: t.updatedAt,
      time: activityAt(t) ? this.timeFormat.format(new Date(activityAt(t) * 1000)) : '',
      locked: this.isLocked(t.id),
      canArchive: this.c.canArchiveSession(t.id) && !this.isLocked(t.id),
      ...this.c.sessionStatus(t.id),
    }));
    return { version: 1, cwd: this.cwd, current: current?.id ?? '', rows,
      loading: this.loading, error: this.error, more: !!this.cursor,
      blockedReason: this.c.selecting ? 'Opening session…' : '',
      canSwitch: this.c.connection === 'ready' && !this.c.selecting,
      connected: this.c.connection === 'ready' };
  }

  contains(id: string) { return this.threads.some(t => t.id === id); }
  get(id: string) { return this.threads.find(t => t.id === id); }
  isLocked(id: string) {
    // Ownership may change after an asynchronous probe or a previous conflict.
    // Loaded background conversations must stay selectable, just like this one.
    return id !== this.c.thread?.id && !this.c.rpc.ownsThread?.(id) && this.locked.has(id);
  }
  markLocked(id: string) {
    this.locked.add(id); this.conflicts.set(id, Date.now() + 15000);
    this.error = ''; this.changed();
  }
  clearError() { if (this.error) { this.error = ''; this.changed(); } }
  fail(message: string) { this.error = message; this.changed(); }
  hide() { this.visible = false; }

  refreshLocks(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const generation = this.generation;
    const ids = this.threads.map(t => t.id);
    const key = JSON.stringify(ids);
    if (this.lockRequest?.generation === generation && this.lockRequest.ids === key) return this.lockRequest.promise;
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await this.probe(ids);
        if (this.disposed || generation !== this.generation || this.lockRequest?.promise !== promise) return;
        const previous = [...this.locked].sort().join(',');
        if (result !== null) { this.locked = result; this.conflicts.clear(); }
        else for (const [id, until] of this.conflicts) if (Date.now() >= until) {
          this.locked.delete(id); this.conflicts.delete(id);
        }
        if (previous !== [...this.locked].sort().join(',')) this.changed();
      } catch { /* Keep the last known state when process inspection is unavailable. */ }
      finally { if (this.lockRequest?.promise === promise) this.lockRequest = undefined; }
    });
    this.lockRequest = { generation, ids: key, promise };
    return promise;
  }

  refresh(more = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.visible = true;
    this.observe();
    if (this.c.connection !== 'ready') return Promise.resolve();
    if (this.request?.generation === this.generation) return this.request.promise;
    if (more && !this.cursor) return Promise.resolve();
    const generation = this.generation;
    const cwd = this.cwd;
    this.loading = true; this.error = ''; this.changed();
    // A deferred start also coalesces changes emitted while an RPC is being set up.
    const promise = Promise.resolve().then(async () => {
      try {
        // Refresh all pages already shown. A session switch must not collapse
        // a paged list back to its first page while the user is clicking it.
        const rows: Thread[] = [];
        let cursor = more ? this.cursor : null;
        let count = 0;
        const pages = more ? 1 : Math.max(1, this.pages);
        do {
          const page = await this.c.rpc.request('thread/list', {
            cwd, limit: 30, sortKey: 'recency_at', sortDirection: 'desc',
            ...(cursor ? { cursor } : {}),
          });
          if (this.disposed || generation !== this.generation) return;
          rows.push(...page.data.filter((t: Thread) => !t.ephemeral && !this.c.isArchived(t.id) && resolve(t.cwd) === resolve(cwd)));
          cursor = page.nextCursor ?? null; count++;
        } while (cursor && count < pages);
        const incoming = new Map(rows.map(t => [t.id, t]));
        const known = new Set(this.threads.map(t => t.id));
        const retained = this.threads
          .filter(t => !this.c.isArchived(t.id) && (more || cursor || incoming.has(t.id) || t.id === this.c.thread?.id))
          .map(t => incoming.get(t.id) ?? t);
        const added = [...incoming.values()].filter(t => !known.has(t.id));
        // Refresh follows backend activity order, including its tie order.
        // Pagination keeps earlier pages and merges duplicates before sorting.
        this.threads = more ? [...retained, ...added]
          : [...incoming.values(), ...retained.filter(t => !incoming.has(t.id))];
        this.mergeLocal();
        this.cursor = cursor; this.pages = more ? this.pages + count : count;
        await this.refreshLocks();
      } catch (error) {
        if (!this.disposed && generation === this.generation)
          this.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (!this.disposed && generation === this.generation) {
          this.request = undefined; this.loading = false; this.changed();
        }
      }
    });
    this.request = { generation, promise };
    return promise;
  }

  dispose() { this.disposed = true; this.generation++; this.c.off('change', this.observe); }

  reloadState() {
    return { cwd: this.cwd, threads: this.threads, cursor: this.cursor, pages: this.pages,
      visible: this.visible, locked: this.locked, conflicts: this.conflicts, error: this.error };
  }
  restoreReloadState(state: ReturnType<FolderSessions['reloadState']>) {
    Object.assign(this, state);
  }
}
