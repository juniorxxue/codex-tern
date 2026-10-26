import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuxiliaryAgent, type AuxiliaryModel } from './auxiliary-agent';
import type { CodexRpc } from './rpc';
import type { Turn } from './generated/v2/Turn';
import type { ThreadTurnsListResponse } from './generated/v2/ThreadTurnsListResponse';
import { record } from './protocol';
import { outlineBatches, outlineContext, outlineFromHistory, outlineHash, outlineInstructions, outlineSchema,
  validateOutline, outlineLocations, type OutlineLocation, type OutlineNode, type OutlineRecord, type OutlineTurn } from './session-outline';

interface Pending { model: AuxiliaryModel; turns: OutlineTurn[]; full: boolean; rebuild: boolean }
interface State {
  record?: OutlineRecord; loading?: Promise<void>; error: string; updating: boolean; version: number;
  pending?: Pending; active?: Pending; timer?: ReturnType<typeof setTimeout>; abort?: AbortController; writing: Promise<void>;
}
const empty = (threadId: string): OutlineRecord => ({ version: 1, threadId, revision: '', topics: [], anchors: [], fingerprints: {}, recent: [] });
const visible = (node: OutlineNode) => ({ id: node.id, title: node.title, visits: node.anchors.length });
const shape = (value: OutlineRecord['topics']) => value.map(n => ({ ...visible(n), anchors: n.anchors,
  children: n.children.map(c => ({ ...visible(c), anchors: c.anchors })) }));

/** A disposable, persisted navigation index. Nothing is written into Codex history or prompts. */
export class SessionOutlines {
  private readonly states = new Map<string, State>();
  private readonly removed = new Set<string>();
  private readonly locations = new WeakMap<OutlineRecord, Map<string, OutlineLocation>>();
  constructor(private readonly agent: AuxiliaryAgent, private readonly rpc: CodexRpc,
    private readonly changed: () => void, readonly directory?: string, private readonly debounceMs = 350) {}

  private path(id: string) { return this.directory && join(this.directory, `${outlineHash(id)}.json`); }
  async load(id: string) {
    if (this.removed.has(id)) return;
    const existing = this.states.get(id);
    if (existing) { await existing.loading; return; }
    const state: State = { error: '', updating: false, version: 0, writing: Promise.resolve() };
    this.states.set(id, state);
    state.loading = (async () => {
      const path = this.path(id);
      if (!path) return;
      try {
        const data: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!record(data) || data.version !== 1 || data.threadId !== id || typeof data.revision !== 'string'
          || !Array.isArray(data.anchors) || !data.anchors.every(a => typeof a === 'string') || !record(data.fingerprints)
          || !Object.values(data.fingerprints).every(x => typeof x === 'string') || !Array.isArray(data.recent))
          throw new Error('Invalid TOC cache');
        const topics = validateOutline(data, data.anchors);
        const anchors = data.anchors as string[];
        // Recent context is optional; a cache cannot inject arbitrary shapes into a worker.
        const recent = data.recent.filter(t => record(t) && typeof t.id === 'string' && typeof t.status === 'string'
          && Array.isArray(t.messages) && t.messages.every((m: unknown) => record(m) && typeof m.role === 'string' && ['user', 'assistant'].includes(m.role)
            && typeof m.text === 'string' && typeof m.anchor === 'string' && anchors.includes(m.anchor))) as OutlineTurn[];
        state.record = { version: 1, threadId: id, revision: data.revision, topics,
          anchors, fingerprints: data.fingerprints as Record<string, string>, recent: outlineContext(recent) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') state.error = 'Saved TOC unavailable. Get TOC to rebuild.';
      }
    })();
    await state.loading; state.loading = undefined; this.changed();
  }

  snapshot(id?: string) {
    const state = id && this.states.get(id);
    if (!id || !state) return undefined;
    return { threadId: id, enabled: !!state.record, revision: state.record?.revision ?? '',
      updating: state.updating, error: state.error,
      topics: state.record?.topics.map(n => ({ ...visible(n), children: n.children.map(visible) })) ?? [] };
  }

  async enableNew(id: string) {
    await this.load(id);
    const state = this.states.get(id);
    if (!state || state.record) return;
    state.record = empty(id);
    try { await this.save(state, state.record); }
    catch { state.error = 'TOC could not be saved. Retry when storage is available.'; }
    this.changed();
  }

  async update(id: string, model: AuxiliaryModel, turns: OutlineTurn[]) {
    await this.load(id);
    const state = this.states.get(id);
    if (!state?.record) return; // Old sessions stay opt-in, including when continued.
    this.enqueue(id, state, { model, turns, full: false, rebuild: false });
  }

  async resume(id: string, model: AuxiliaryModel, turns: OutlineTurn[]) {
    await this.load(id);
    const state = this.states.get(id);
    if (state?.record) this.enqueue(id, state, { model, turns, full: true, rebuild: false });
  }

  async generate(id: string, model: AuxiliaryModel, turns: OutlineTurn[], rebuild = false) {
    await this.load(id);
    const state = this.states.get(id);
    if (!state) return;
    state.record ??= empty(id);
    this.enqueue(id, state, { model, turns, full: true, rebuild });
  }

  private enqueue(id: string, state: State, pending: Pending) {
    // Duplicate user item/started + item/completed notifications do not spend another request.
    const scheduled = state.pending ?? state.active;
    if (!pending.full && !pending.rebuild && !state.error && pending.turns.every(t =>
      (scheduled?.turns.find(p => p.id === t.id) && outlineHash(scheduled.turns.find(p => p.id === t.id)) === outlineHash(t))
      || state.record?.fingerprints[t.id] === outlineHash(t))) return;
    state.pending = { ...pending, full: pending.full || !!state.pending?.full, rebuild: pending.rebuild || !!state.pending?.rebuild };
    state.version++; state.error = ''; state.updating = true;
    if (state.timer) clearTimeout(state.timer);
    if (!state.abort) state.timer = setTimeout(() => { state.timer = undefined; void this.run(id, state); }, this.debounceMs);
    this.changed();
  }

  target(id: string, revision: string, nodeId: string, visit: number) {
    const value = this.states.get(id)?.record;
    if (!value || value.revision !== revision || !Number.isInteger(visit) || visit < 0) return;
    const node = value.topics.flatMap(n => [n, ...n.children]).find(n => n.id === nodeId);
    return node?.anchors[visit];
  }

  location(id: string, prompt: string) {
    const value = this.states.get(id)?.record;
    if (!value) return;
    let locations = this.locations.get(value);
    if (!locations) { locations = outlineLocations(value); this.locations.set(value, locations); }
    return locations.get(prompt);
  }

  private async history(id: string, signal: AbortSignal) {
    let cursor: string | null = null;
    const pages: Turn[][] = [], cursors = new Set<string>();
    do {
      signal.throwIfAborted();
      const page: ThreadTurnsListResponse = await this.rpc.request('thread/turns/list', { threadId: id, cursor, limit: 50, sortDirection: 'desc', itemsView: 'full' });
      signal.throwIfAborted();
      pages.push([...page.data].reverse()); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('History pagination repeated');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return outlineFromHistory(pages.reverse().flat());
  }

  private async run(id: string, state: State) {
    const job = state.pending;
    if (!job || state.abort || !state.record) return;
    state.pending = undefined;
    state.active = job;
    const version = state.version, abort = new AbortController(); state.abort = abort;
    const current = () => !abort.signal.aborted && state.version === version && this.states.get(id) === state;
    try {
      let source = job.turns;
      if (job.full) {
        source = await this.history(id, abort.signal);
        // Live public messages may be newer than the persisted history snapshot.
        const live = new Map(job.turns.map(t => [t.id, t]));
        source = source.map(t => { const latest = live.get(t.id); live.delete(t.id); return latest ?? t; });
        source.push(...live.values());
      }
      if (!current()) return;
      const old = state.record;
      const removedHistory = job.full && Object.keys(old.fingerprints).some(id => !source.some(t => t.id === id));
      const base = job.rebuild || removedHistory ? empty(id) : old;
      const anchors = [...new Set([...(job.full ? [] : base.anchors), ...source.flatMap(t =>
        t.messages.filter(m => m.role === 'user').map(m => m.anchor))])];
      const changed = source.filter(t => base.fingerprints[t.id] !== outlineHash(t));
      let topics = base.topics;
      const batches = outlineBatches(changed);
      for (const [index, evidence] of batches.entries()) {
        if (!current()) return;
        const value = await this.agent.generate({ ...job.model, source: 'thread_outline', timeoutMs: 60_000,
          instructions: outlineInstructions, schema: outlineSchema,
          prompt: JSON.stringify({ previousOutline: { topics }, recentContext: base.recent,
            batch: index + 1, batches: batches.length, evidence }),
        }, abort.signal);
        if (!current()) return;
        topics = validateOutline(value, anchors);
        if (!topics.length) throw new Error('The helper returned an empty TOC');
      }
      if (!anchors.length && job.full) throw new Error('No prompts to index yet');
      const fingerprints = { ...(job.full ? {} : base.fingerprints) };
      for (const turn of source) fingerprints[turn.id] = outlineHash(turn);
      const result: OutlineRecord = { version: 1, threadId: id, topics, anchors, fingerprints,
        recent: outlineContext(source.length ? source : base.recent),
        revision: outlineHash(shape(topics)) === outlineHash(shape(old.topics)) ? old.revision : randomUUID() };
      if (!current()) return;
      await this.save(state, result, current);
      // Publish only a complete, validated revision. The old card remains usable while working.
      if (current()) state.record = result;
    } catch (error) {
      if (current()) state.error = (error as Error).message === 'No prompts to index yet'
        ? 'No prompts to index yet.' : 'Could not update TOC. Your last outline is kept.';
    } finally {
      if (state.abort === abort) state.abort = undefined;
      if (state.active === job) state.active = undefined;
      const pending = state.pending as Pending | undefined;
      if (pending && this.states.get(id) === state && !this.removed.has(id)) {
        // A newer prompt arriving during a backfill must not turn it into a partial index.
        pending.full ||= job.full; pending.rebuild ||= job.rebuild;
        state.timer = setTimeout(() => { state.timer = undefined; void this.run(id, state); }, this.debounceMs);
      } else state.updating = false;
      this.changed();
    }
  }

  private save(state: State, value: OutlineRecord, current: () => boolean = () => true) {
    const path = this.path(value.threadId);
    if (!path) return Promise.resolve();
    const work = state.writing.then(async () => {
      if (!current()) return;
      await mkdir(this.directory!, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
        if (!current()) return;
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    });
    state.writing = work.catch(() => {});
    return work;
  }

  cancelAll() { for (const state of this.states.values()) this.cancel(state); this.changed(); }
  private cancel(state: State) {
    state.version++; state.abort?.abort(); state.pending = undefined; state.active = undefined;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined; state.updating = false;
  }
  async remove(id: string) {
    this.removed.add(id);
    const state = this.states.get(id);
    if (state) { this.cancel(state); await state.loading; await state.writing; }
    this.states.delete(id);
    const path = this.path(id);
    if (path) await rm(path, { force: true });
  }
  async flush() { await Promise.all([...this.states.values()].map(state => state.writing)); }
}
