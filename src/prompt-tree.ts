import { createHash } from 'node:crypto';
import type { CodexRpc } from './rpc';
import type { Thread } from './generated/v2/Thread';
import type { ThreadItem } from './generated/v2/ThreadItem';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse';
import type { ThreadTurnsListResponse } from './generated/v2/ThreadTurnsListResponse';
import type { PromptAnchor } from './prompt-anchor';

export interface PromptEntry { turnId: string; itemId: string; text: string }
export type PromptThread = Pick<Thread, 'id' | 'sessionId' | 'forkedFromId' | 'parentThreadId' | 'cwd' | 'updatedAt' | 'createdAt' | 'ephemeral'> & Partial<Pick<Thread, 'name'>>;
export interface PromptNode {
  id: string;
  parent: string | null;
  kind: 'fork' | 'branch';
  text: string;
  label: string;
  locations: PromptAnchor[];
}
export interface PromptTree {
  threads: { id: string; cwd: string }[];
  nodes: PromptNode[];
  paths: Record<string, string[]>;
  errors: string[];
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/** An excerpt of the user's own words, never a generated title or an ordinal. */
export function promptLabel(text: string, limit = 38) {
  const value = text.replace(/\s+/gu, ' ').trim();
  const chars = [...value];
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : value;
}
export function promptEntry(turnId: string, item: ThreadItem): PromptEntry | undefined {
  if (item.type !== 'userMessage') return;
  const text = item.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
  return { turnId, itemId: item.id, text: text || 'Image prompt' };
}

/** The fork relationship and session family are authoritative. Agent parents
 * and similar titles are deliberately not evidence of a conversation fork. */
export function relatedThreads(seed: PromptThread, candidates: PromptThread[]) {
  const rows = new Map(candidates.filter(t => !t.ephemeral && (!t.parentThreadId || t.id === seed.id)).map(t => [t.id, t]));
  rows.set(seed.id, seed);
  const parents = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parents.has(root) && parents.get(root) !== root) root = parents.get(root)!;
    while (parents.has(id) && parents.get(id) !== root) { const next = parents.get(id)!; parents.set(id, root); id = next; }
    return root;
  };
  const union = (a: string, b: string) => { const left = find(a), right = find(b); if (left !== right) parents.set(left, right); };
  for (const t of rows.values()) {
    if (t.sessionId) union(`thread:${t.id}`, `session:${t.sessionId}`);
    if (t.forkedFromId) union(`thread:${t.id}`, `thread:${t.forkedFromId}`);
  }
  const family = find(`thread:${seed.id}`);
  return [...rows.values()].filter(t => find(`thread:${t.id}`) === family)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
}

/** Compare original prompt identities to find fork junctions, then omit every
 * ordinary prompt. A session ending on shared history is also a fork junction:
 * a new fork must appear before anyone sends its first new message. */
export function buildPromptTree(threads: { thread: PromptThread; prompts: PromptEntry[] }[], errors: string[] = []): PromptTree {
  const nodes = new Map<string, PromptNode>(), paths: PromptTree['paths'] = {};
  for (const { thread, prompts } of threads) {
    let parent: string | null = null;
    const path: string[] = [], seen = new Set<string>();
    for (const prompt of prompts) {
      const identity = JSON.stringify([prompt.turnId, prompt.itemId]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const id: string = hash(JSON.stringify([parent, prompt.turnId, prompt.itemId, prompt.text]));
      const node: PromptNode = nodes.get(id) ?? { id, parent, kind: 'fork', text: prompt.text.slice(0, 1200), label: promptLabel(prompt.text), locations: [] };
      node.locations.push({ threadId: thread.id, turnId: prompt.turnId, itemId: prompt.itemId });
      nodes.set(id, node); path.push(id); parent = id;
    }
    paths[thread.id] = path;
  }
  const children = new Map<string, number>();
  const ends = new Set(Object.values(paths).flatMap(path => path.length ? [path.at(-1)!] : []));
  for (const node of nodes.values()) if (node.parent) children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
  const forks = new Set([...nodes.values()].filter(node => (children.get(node.id) ?? 0) > 1 || (ends.has(node.id) && node.locations.length > 1)).map(node => node.id));
  const compact: PromptNode[] = [], nearest = new Map<string, string | null>();
  // Parents precede their children. Collapse each omitted run without recursion.
  for (const node of nodes.values()) {
    const parent = node.parent ? nearest.get(node.parent) ?? null : null;
    nearest.set(node.id, forks.has(node.id) ? node.id : parent);
    if (forks.has(node.id)) compact.push({ ...node, parent });
  }
  for (const { thread } of threads) {
    const path = paths[thread.id].filter(id => forks.has(id));
    paths[thread.id] = path;
    const parent = path.at(-1);
    if (!parent) continue;
    // Unlabelled endpoints keep each session selectable without adding its
    // latest prompt to the map. They jump to that session's last fork junction.
    const id = hash(JSON.stringify(['branch', thread.id]));
    compact.push({ id, parent, kind: 'branch', label: '',
      text: thread.name?.trim() || (thread.forkedFromId ? 'Forked conversation' : 'Original conversation'),
      locations: [nodes.get(parent)!.locations.find(location => location.threadId === thread.id)!] });
    path.push(id);
  }
  return { threads: threads.map(({ thread }) => ({ id: thread.id, cwd: thread.cwd })), nodes: compact, paths, errors };
}

/** Runs only on the read-only history worker. Closing the map cancels further
 * pages. The cache is disposable and never writes into Codex's session data. */
export class PromptTreeReader {
  private generation = 0;
  private cache = new Map<string, { revision: number; prompts: PromptEntry[] }>();
  private relationships = new Map<string, Pick<PromptThread, 'sessionId' | 'forkedFromId' | 'parentThreadId'>>();
  private versions = new Map<string, number>();
  cancel() { this.generation++; }
  invalidate(id: string) { this.cache.delete(id); this.versions.set(id, (this.versions.get(id) ?? 0) + 1); }
  constructor(private readonly rpc: CodexRpc) {}

  async read(threadId: string, fresh = false): Promise<PromptTree> {
    const generation = ++this.generation;
    if (fresh) { this.cache.clear(); this.relationships.clear(); }
    const check = () => { if (generation !== this.generation) throw new Error('Conversation tree loading cancelled.'); };
    const seed = (await this.rpc.request('thread/read', { threadId })).thread;
    check();
    const remember = (thread: PromptThread) => this.relationships.set(thread.id, {
      sessionId: thread.sessionId, forkedFromId: thread.forkedFromId, parentThreadId: thread.parentThreadId,
    });
    remember(seed);
    const candidates: PromptThread[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: ThreadListResponse = await this.rpc.request('thread/list', { limit: 100, sortKey: 'updated_at', ...(fresh ? {} : { useStateDbOnly: true }), ...(cursor ? { cursor } : {}) });
      check(); candidates.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Conversation list pagination repeated. Try again.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    // Local thread/list can omit forkedFromId even after scan-and-repair.
    // Resolve missing relationships from metadata-only reads, including when
    // opening the parent first. These creation-time relationships are stable.
    const errors: string[] = [];
    const missing = candidates.filter(t => !t.ephemeral && !t.parentThreadId && !t.forkedFromId && !this.relationships.has(t.id));
    for (let i = 0; i < missing.length; i += 4) {
      check();
      await Promise.all(missing.slice(i, i + 4).map(async candidate => {
        try {
          const thread = (await this.rpc.request('thread/read', { threadId: candidate.id })).thread;
          check(); remember(thread);
        } catch { check(); errors.push(candidate.id); }
      }));
    }
    check();
    const present = new Set([threadId, ...candidates.map(t => t.id)]);
    for (const id of this.relationships.keys()) if (!present.has(id)) this.relationships.delete(id);
    const family = relatedThreads(seed, candidates.map(t => ({ ...t, ...this.relationships.get(t.id) })));
    const histories: { thread: PromptThread; prompts: PromptEntry[] }[] = [];
    // Read the selected session first; stale siblings must not hide its prompts.
    const ordered = [...family].sort((a, b) => Number(b.id === threadId) - Number(a.id === threadId));
    for (const thread of ordered) {
      check();
      try {
        let cached = this.cache.get(thread.id);
        if (!cached || cached.revision !== thread.updatedAt) {
          const version = this.versions.get(thread.id) ?? 0, prompts: PromptEntry[] = [], seen = new Set<string>();
          let cursor: string | null = null;
          do {
            const page: ThreadTurnsListResponse = await this.rpc.request('thread/turns/list', { threadId: thread.id, limit: 25, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
            check();
            for (const turn of page.data) for (const item of turn.items) {
              const prompt = promptEntry(turn.id, item); if (prompt) prompts.push(prompt);
            }
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error('Conversation history pagination repeated.');
            if (cursor) seen.add(cursor);
          } while (cursor);
          cached = { revision: thread.updatedAt, prompts };
          if ((this.versions.get(thread.id) ?? 0) === version) this.cache.set(thread.id, cached);
          // Keep memory bounded across many unrelated trees.
          if (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value!);
        }
        histories.push({ thread, prompts: cached.prompts });
      } catch (error) {
        check();
        if (thread.id === threadId) throw error;
        errors.push(thread.id);
      }
    }
    check();
    histories.sort((a, b) => family.indexOf(a.thread) - family.indexOf(b.thread));
    return buildPromptTree(histories, [...new Set(errors)]);
  }
}

export interface PromptTreeLayout { width: number; height: number; positions: Map<string, { x: number; y: number }> }
/** Iterative layout: long conversations do not exhaust the JS call stack. */
export function layoutPromptTree(nodes: PromptNode[]): PromptTreeLayout {
  const children = new Map<string | null, PromptNode[]>(), ids = new Set(nodes.map(n => n.id));
  for (const n of nodes) { const parent = n.parent && ids.has(n.parent) ? n.parent : null; const row = children.get(parent) ?? []; row.push(n); children.set(parent, row); }
  const positions = new Map<string, { x: number; y: number }>();
  const roots = children.get(null) ?? [];
  const visits: { n: PromptNode; depth: number; done: boolean }[] = [...roots].reverse().map(n => ({ n, depth: 0, done: false }));
  let maxDepth = 0;
  const widths = new Map<string, number>();
  while (visits.length) {
    const { n, depth, done } = visits.pop()!, next = children.get(n.id) ?? [];
    if (!done && next.length) { visits.push({ n, depth, done: true }); for (let i = next.length - 1; i >= 0; i--) visits.push({ n: next[i], depth: depth + 1, done: false }); continue; }
    // Endpoints need a small hit area, not an entire prompt-card column.
    widths.set(n.id, Math.max(n.kind === 'branch' ? 44 : 136, next.reduce((sum, child) => sum + widths.get(child.id)!, 0)));
    maxDepth = Math.max(maxDepth, depth);
  }
  const total = roots.reduce((sum, root) => sum + widths.get(root.id)!, 0), width = Math.max(310, total + 4);
  const pending: { n: PromptNode; left: number; depth: number }[] = [];
  let left = (width - total) / 2;
  for (const n of roots) { pending.push({ n, left, depth: 0 }); left += widths.get(n.id)!; }
  while (pending.length) {
    const { n, left, depth } = pending.pop()!, next = children.get(n.id) ?? [];
    const x = left + widths.get(n.id)! / 2;
    positions.set(n.id, { x, y: 36 + depth * 86 });
    let childLeft = x - next.reduce((sum, child) => sum + widths.get(child.id)!, 0) / 2;
    for (const child of next) { pending.push({ n: child, left: childLeft, depth: depth + 1 }); childLeft += widths.get(child.id)!; }
  }
  return { positions, width, height: nodes.length ? 72 + maxDepth * 86 : 0 };
}
