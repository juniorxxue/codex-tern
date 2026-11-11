import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Node, Session, Surface } from '@stencil-hq/tern';
import { buildPromptTree, layoutPromptTree, promptEntry, promptLabel, relatedThreads, PromptTreeReader, type PromptThread, type PromptEntry, type PromptTree } from '../src/prompt-tree';
import { PromptTreeState } from '../src/prompt-tree-state';
import { Controller } from '../src/controller';
import { NativeUI } from '../src/ui';
import type { CodexRpc } from '../src/rpc';
import { validPromptAnchor } from '../src/prompt-anchor';
import { PromptTreeService } from '../src/prompt-tree-service';

const thread = (id: string, forkedFromId: string | null = null, sessionId = id): PromptThread =>
  ({ id, forkedFromId, sessionId, parentThreadId: null, cwd: '/tmp', createdAt: 1, updatedAt: 1, ephemeral: false });
const prompt = (turnId: string, text = turnId): PromptEntry => ({ turnId, itemId: `user-${turnId}`, text });
const turn = (p: PromptEntry) => ({ id: p.turnId, status: 'completed', items: [
  { id: p.itemId, type: 'userMessage', content: [{ type: 'text', text: p.text }] },
  { id: `reply-${p.turnId}`, type: 'agentMessage', phase: 'final_answer', text: `Reply to ${p.text}` },
] });
const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const fixture = () => buildPromptTree([
  { thread: thread('source'), prompts: [prompt('root', 'Build a conversation tree'), prompt('vertical', 'Use a vertical layout'), prompt('source-end', 'Keep it collapsed')] },
  { thread: thread('fork', 'source'), prompts: [prompt('root', 'Build a conversation tree'), prompt('vertical', 'Use a vertical layout'), prompt('fork-end', 'Use short prompt labels')] },
]);

test('fork families use official IDs, including missing parents, and exclude agent and ephemeral threads', () => {
  const rows = [thread('root'), thread('fork', 'root'), thread('nested', 'fork'), thread('session-peer', null, 'root'),
    thread('unrelated'), { ...thread('agent', null, 'root'), parentThreadId: 'root' }, { ...thread('helper', 'root'), ephemeral: true }];
  assert.deepEqual(new Set(relatedThreads(rows[1], rows).map(t => t.id)), new Set(['root', 'fork', 'nested', 'session-peer']));
  const siblings = [thread('a', 'missing'), thread('b', 'missing'), thread('c')];
  assert.deepEqual(relatedThreads(siblings[0], siblings).map(t => t.id), ['a', 'b']);
});

test('the vertical tree labels only fork junctions and keeps each session reachable', () => {
  const data = fixture();
  assert.equal(data.nodes.length, 3);
  assert.deepEqual(data.nodes.filter(n => n.kind === 'fork').map(n => n.text), ['Use a vertical layout']);
  assert.equal(data.paths.source[0], data.paths.fork[0]);
  assert.notEqual(data.paths.source[1], data.paths.fork[1]);
  assert.equal(data.nodes[0].locations.length, 2);
  for (const id of ['source', 'fork']) {
    const end = data.nodes.find(n => n.id === data.paths[id].at(-1))!;
    assert.equal(end.kind, 'branch'); assert.equal(end.label, '');
    assert.deepEqual(end.locations, [{ threadId: id, turnId: 'vertical', itemId: 'user-vertical' }]);
  }
  const layout = layoutPromptTree(data.nodes);
  for (const n of data.nodes) if (n.parent) assert.ok(layout.positions.get(n.id)!.y > layout.positions.get(n.parent)!.y);
  const a = layout.positions.get(data.paths.source[1])!, b = layout.positions.get(data.paths.fork[1])!;
  assert.equal(a.y, b.y); assert.ok(Math.abs(a.x - b.x) >= 28, 'endpoint hit areas do not overlap');
  assert.deepEqual(layoutPromptTree(data.nodes), layout, 'navigation does not reorder lanes');
});

test('an unforked conversation has no prompt nodes, even with a long history', () => {
  const deep = buildPromptTree([{ thread: thread('deep'), prompts: Array.from({ length: 12_000 }, (_, i) => prompt(String(i))) }]);
  assert.deepEqual(deep.nodes, []); assert.deepEqual(deep.paths.deep, []);
  assert.equal(layoutPromptTree(deep.nodes).height, 0);
});

test('a new fork is visible before its first message and ordinary continuation adds no labels', () => {
  const shared = [prompt('first'), prompt('cutoff')];
  const source = { thread: thread('source'), prompts: shared };
  const fork = { thread: thread('fork', 'source'), prompts: shared };
  const data = buildPromptTree([source, fork]);
  assert.deepEqual(data.nodes.filter(n => n.kind === 'fork').map(n => n.text), ['cutoff']);
  assert.equal(data.nodes.filter(n => n.kind === 'branch').length, 2);
  const later = buildPromptTree([{ ...source, prompts: [...shared, prompt('source-next')] }, { ...fork, prompts: [...shared, prompt('fork-next')] }]);
  assert.deepEqual(later, data, 'new messages do not change the fork map');
  const stopped = buildPromptTree([{ ...source, prompts: [...shared, prompt('source-next')] }, fork]);
  assert.deepEqual(stopped, data, 'a fork with no new messages still splits from the continuing source');
});

test('nested forks collapse ordinary prompts without merging repeated words or losing branch ancestry', () => {
  const first = prompt('first', 'Same words'), second = prompt('second', 'Same words');
  const data = buildPromptTree([
    { thread: thread('source'), prompts: [prompt('intro'), first, prompt('skip'), second, prompt('end')] },
    { thread: thread('fork', 'source'), prompts: [prompt('intro'), first, prompt('fork-only')] },
    { thread: thread('nested', 'source'), prompts: [prompt('intro'), first, prompt('skip'), second] },
  ]);
  const junctions = data.nodes.filter(n => n.kind === 'fork');
  assert.equal(junctions.length, 2); assert.equal(junctions[0].label, junctions[1].label);
  assert.notEqual(junctions[0].id, junctions[1].id);
  assert.equal(junctions[1].parent, junctions[0].id);
  assert.deepEqual(data.paths.fork.slice(0, -1), [junctions[0].id]);
  assert.deepEqual(data.paths.nested.slice(0, -1), junctions.map(n => n.id));
  const layout = layoutPromptTree(data.nodes);
  assert.equal(layout.width, 310, 'a few fork points fit without horizontal scrolling');
  for (const n of data.nodes) if (n.parent) assert.ok(layout.positions.get(n.id)!.y > layout.positions.get(n.parent)!.y);
});

test('multiple untouched forks share one junction and retain separate session targets', () => {
  const prompts = [prompt('start'), prompt('fork-here')];
  const data = buildPromptTree(['source', 'a', 'b'].map(id => ({ thread: thread(id, id === 'source' ? null : 'source'), prompts })));
  assert.equal(data.nodes.filter(n => n.kind === 'fork').length, 1);
  assert.deepEqual(data.nodes.filter(n => n.kind === 'branch').map(n => n.locations[0].threadId), ['source', 'a', 'b']);
});

test('labels are short literal excerpts, retain Unicode, and ignore assistant/tool content', () => {
  assert.equal(promptLabel('  Keep\n   my words  '), 'Keep my words');
  assert.equal(promptLabel('😀'.repeat(50)), '😀'.repeat(37) + '…');
  assert.equal(promptEntry('a', turn(prompt('a', '中文 prompt')).items[0] as any)?.text, '中文 prompt');
  assert.equal(promptEntry('a', turn(prompt('a')).items[1] as any), undefined);
  assert.equal(promptEntry('image', { type: 'userMessage', id: 'image', content: [{ type: 'image', url: 'x' }] } as any)?.text, 'Image prompt');
});

test('reader follows all metadata and history pages, caches revisions, and uses only read RPCs', async () => {
  const rows = [thread('source'), thread('fork', 'source'), thread('unrelated')];
  const calls: { method: string; params: any }[] = [];
  const rpc = { request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: rows[0] };
    if (method === 'thread/list') return { data: params.cursor ? rows.slice(1) : rows.slice(0, 1), nextCursor: params.cursor ? null : 'next' };
    assert.equal(method, 'thread/turns/list');
    return { data: [turn(prompt(params.cursor ? params.threadId : 'shared'))], nextCursor: params.cursor ? null : 'older' };
  } } as unknown as CodexRpc;
  const reader = new PromptTreeReader(rpc), data = await reader.read('source');
  assert.equal(data.nodes.length, 3); assert.equal(data.threads.length, 2);
  assert.equal(calls.filter(c => c.method === 'thread/turns/list').length, 4);
  assert.ok(calls.filter(c => c.method === 'thread/turns/list').every(c => c.params.sortDirection === 'asc'));
  await reader.read('source');
  assert.equal(calls.filter(c => c.method === 'thread/turns/list').length, 4);
  reader.invalidate('source'); await reader.read('source');
  assert.equal(calls.filter(c => c.method === 'thread/turns/list').length, 6);
  rows[1].updatedAt++; await reader.read('source');
  assert.equal(calls.filter(c => c.method === 'thread/turns/list').length, 8);
  await reader.read('source', true);
  assert.equal(calls.filter(c => c.method === 'thread/turns/list').length, 12, 'explicit refresh rechecks history even with unchanged timestamps');
});

test('closing cancels further history pages, and unavailable siblings do not hide the current branch', async () => {
  const gate = deferred<any>(); let pages = 0;
  const rpc = { request: async (method: string, params: any) => {
    if (method === 'thread/read') return { thread: thread('source') };
    if (method === 'thread/list') return { data: [thread('source'), thread('fork', 'source')], nextCursor: null };
    pages++;
    if (params.threadId === 'fork') throw new Error('Missing');
    return gate.promise;
  } } as unknown as CodexRpc;
  const reader = new PromptTreeReader(rpc), read = reader.read('source');
  while (!pages) await tick();
  reader.cancel(); gate.resolve({ data: [turn(prompt('first'))], nextCursor: 'next' });
  await assert.rejects(read, /cancelled/); assert.equal(pages, 1);
  gate.promise = Promise.resolve({ data: [turn(prompt('first'))], nextCursor: null });
  const partial = await reader.read('source');
  assert.deepEqual(partial.errors, ['fork']); assert.equal(partial.nodes.length, 0);
  assert.deepEqual(partial.paths.source, []);
});

test('metadata-only reads recover omitted fork relationships from either branch, across projects', async () => {
  const rows = [thread('source'), { ...thread('fork', 'source'), cwd: '/other' }, thread('nested', 'fork'), thread('unrelated')];
  const reads: string[] = [], histories: string[] = [];
  const rpc = { request: async (method: string, params: any) => {
    if (method === 'thread/read') {
      reads.push(params.threadId); assert.ok(!params.includeTurns);
      return { thread: rows.find(t => t.id === params.threadId)! };
    }
    if (method === 'thread/list') return { data: rows.map(t => ({ ...t, forkedFromId: null })), nextCursor: null };
    assert.equal(method, 'thread/turns/list'); histories.push(params.threadId);
    return { data: [turn(prompt('shared')), turn(prompt(params.threadId))], nextCursor: null };
  } } as unknown as CodexRpc;
  const reader = new PromptTreeReader(rpc), source = await reader.read('source');
  assert.deepEqual(source.threads.map(t => t.id), ['fork', 'nested', 'source']);
  assert.equal(source.nodes.length, 4); assert.ok(!histories.includes('unrelated'));
  assert.deepEqual(new Set(reads), new Set(rows.map(t => t.id)));
  reads.length = 0;
  assert.deepEqual(await reader.read('fork'), source);
  assert.deepEqual(reads, ['fork'], 'branch switches reuse stable relationships');
  reads.length = 0;
  assert.deepEqual(await reader.read('source', true), source);
  assert.equal(reads.length, 4, 'explicit refresh rechecks all metadata');
});

test('minimap state starts closed, ignores stale branch loads, and never reopens after hiding', async () => {
  const pending: ReturnType<typeof deferred<PromptTree>>[] = [];
  const state = new PromptTreeState({ tree: async () => { const p = deferred<PromptTree>(); pending.push(p); return p.promise; }, cancelTree: () => {} }, () => {});
  state.sync('source', 0); assert.equal(pending.length, 0);
  state.show('source', 0); state.sync('fork', 0);
  pending[1].resolve(fixture()); await tick(); const selected = state.data;
  pending[0].resolve({ ...fixture(), nodes: [] }); await tick(); assert.equal(state.data, selected);
  const loading = state.refresh(); state.hide(); pending[2].resolve({ ...fixture(), nodes: [] }); await loading;
  assert.equal(state.open, false); assert.equal(state.loading, false); assert.equal(state.data, selected);
});

test('switching within a loaded fork family retains the same graph and only changes the active branch', async () => {
  const reads: string[] = [];
  const state = new PromptTreeState({ tree: async id => { reads.push(id); return fixture(); }, cancelTree: () => {} }, () => {});
  state.show('fork', 1); await tick(); const graph = state.data;
  state.sync('source', 1); await tick();
  assert.equal(state.data, graph); assert.equal(state.loading, false); assert.deepEqual(reads, ['fork']);
  state.sync('fork', 1); assert.equal(state.data, graph);
  state.sync('ordinary', 1); assert.equal(state.data, undefined);
  state.hide();
});

async function uiFixture(long = false) {
  const calls: string[] = [], outlineCalls: string[] = [];
  const transport = Object.assign(new EventEmitter(), { request: async (method: string, params: any): Promise<any> => {
    calls.push(method);
    if (method === 'thread/resume') return { thread: thread(params.threadId, params.threadId === 'fork' ? 'source' : null), cwd: '/tmp' };
    if (method === 'thread/turns/list') {
      const all = [prompt('root'), prompt('vertical'),
        ...(long ? Array.from({ length: 40 }, (_, i) => prompt(`${params.threadId}-${i}`)) : []),
        prompt(params.threadId === 'fork' ? 'fork-end' : 'source-end')].map(turn).reverse();
      const at = Number(params.cursor ?? 0), end = at + params.limit;
      return { data: all.slice(at, end), nextCursor: end < all.length ? String(end) : null };
    }
    if (method === 'thread/list') return { data: [], nextCursor: null };
    throw new Error(`Unexpected: ${method}`);
  } });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp'); c.connection = 'ready';
  await c.resume('source'); calls.length = 0;
  (c as any).outlines = { load: async () => {}, resume: async (id: string) => { outlineCalls.push(id); }, snapshot: () => undefined, location: () => undefined };
  c.promptTree.tree = async () => fixture();
  c.promptTree.verify = async () => {};
  let frame: { main: Node; dock: Node; layer: Node };
  const session = { caps: { cols: 120, kinds: [], features: [], cell: { w: 8, h: 16 } }, close: async () => {} } as unknown as Session;
  const surface = { closed: false, stylesheet: () => {}, focus: () => {}, reveal: () => {}, render: (f: typeof frame) => { frame = f; } } as unknown as Surface;
  const ui = new NativeUI(c, session, surface);
  (ui as any).readingPositions.enabled = false;
  const view = () => { ui.render(); return Object.values(frame).flatMap(nodes); };
  return { c, ui, view, calls, outlineCalls, session, surface };
}

test('reloading an open tree preserves its family without cancelling the replacement view', async t => {
  const { c, ui, session, surface } = await uiFixture();
  (ui as any).togglePromptTree(); await tick();
  const snapshot = ui.reloadState();
  let cancelled = 0; c.promptTree.cancelTree = () => { cancelled++; };
  const replacement = new NativeUI(c, session, surface, undefined, undefined, snapshot);
  t.after(() => replacement.close());
  replacement.render(); ui.disposeForReload(); await tick();
  assert.equal(cancelled, 1, 'only the replacement refresh cancels the preceding read');
  assert.equal((replacement as any).promptTree.open, true);
  assert.equal((replacement as any).promptTree.error, '');
  assert.deepEqual((replacement as any).promptTree.data, fixture());
});

test('native minimap navigation preserves draft objects, undo, attachments, background turns, and skips outline generation', async t => {
  const { c, ui, view, calls, outlineCalls } = await uiFixture(); t.after(() => ui.close());
  assert.ok(view().some(n => n.props.aria === 'Show conversation tree'));
  assert.ok(!view().some(n => n.props.role === 'ct.prompt-tree.node'));
  const original = ui.draft; original.set('Before'); original.set('Unsent source draft');
  ui.images = ['/tmp/kept.png']; (ui as any).failedPreviews.add('/tmp/kept.png');
  c.activeTurn = 'background'; const items = c.items;
  (ui as any).togglePromptTree(); await tick();
  assert.equal(ui.draft, original); assert.equal(view().filter(n => n.props.role === 'ct.prompt-tree.node').length, 1);
  assert.equal(view().filter(n => n.props.role === 'ct.prompt-tree.branch').length, 2);
  assert.deepEqual(calls, []);
  const anchor = { threadId: 'fork', turnId: 'fork-end', itemId: 'user-fork-end' };
  assert.equal(await ui.openPrompt(anchor), true);
  assert.equal(c.thread?.id, 'fork'); assert.equal(c.sessionStatus('source').running, true);
  assert.deepEqual(outlineCalls, [], 'minimap resume cannot schedule the auxiliary model');
  assert.ok(!view().some(n => n.props.role === 'ct.search.match'));
  assert.ok(!view().some(n => n.props.role === 'ct.search.location'));
  assert.equal(view().filter(n => n.props.role === 'ct.prompt-tree.branch').length, 2);
  assert.ok(view().some(n => n.props.role === 'ct.prompt-tree.branch'
    && (n.props.attrs as any)['data-thread-id'] === 'fork' && String(n.props.class).includes('on-path')));
  ui.draft.set('Fork draft'); const forkDraft = ui.draft;
  assert.equal(await ui.openPrompt({ ...anchor, threadId: 'source', turnId: 'source-end', itemId: 'user-source-end' }), true);
  assert.equal(ui.draft, original); assert.deepEqual(ui.images, ['/tmp/kept.png']);
  original.undo(); assert.equal(original.text, 'Before'); assert.equal(c.items, items);
  await ui.openSession('fork'); assert.equal(ui.draft, forkDraft);
  await ui.openSession('ordinary'); assert.deepEqual(outlineCalls, ['ordinary'], 'ordinary switching keeps its previous behavior');
  assert.ok(calls.every(method => ['thread/resume', 'thread/turns/list', 'thread/list'].includes(method)));
});

test('tree jumps hydrate the ordinary conversation through an old prompt and keep later replies available', async t => {
  const { c, ui, view, calls, outlineCalls } = await uiFixture(true); t.after(() => ui.close()); ui.render();
  const anchor = { threadId: 'fork', turnId: 'vertical', itemId: 'user-vertical' };
  assert.equal(await ui.openPrompt(anchor), true);
  assert.ok(c.items.some(e => e.id === 'vertical:user-vertical'));
  assert.ok(c.items.some(e => e.id === 'fork-end:reply-fork-end'));
  assert.equal(c.items.length, 86, 'all intervening turns remain in the same transcript');
  assert.equal(calls.filter(m => m === 'thread/turns/list').length, 3);
  assert.deepEqual(outlineCalls, []);
  assert.ok(!view().some(n => n.props.role === 'ct.search.location' || n.props.text === 'Load later context'));
  assert.ok(view().some(n => n.props.role === 'ct.reply.fork' && String(n.props.key) === 'fork'));
  assert.deepEqual((ui as any).readingPositions.saved.get('fork'),
    { following: false, anchor: { id: 'main.vertical:user-vertical', offset: 0 } });
});

test('switching away while a tree jump loads older history cancels its reveal', async t => {
  const { c, ui } = await uiFixture(true); t.after(() => ui.close()); ui.render();
  const pending = deferred<void>(); let loading = false;
  c.loadHistory = async () => { loading = true; await pending.promise; };
  const jump = ui.openPrompt({ threadId: 'fork', turnId: 'vertical', itemId: 'user-vertical' });
  while (!loading) await tick();
  await ui.openSession('ordinary'); pending.resolve();
  assert.equal(await jump, false); assert.equal(c.thread?.id, 'ordinary');
  assert.equal((ui as any).readingPositions.saved.has('fork'), false);
  assert.equal(c.notices.filter(n => n.error).length, 0);
});

test('failed or delayed prompt lookups leave selection and new navigation intact', async t => {
  const { c, ui } = await uiFixture(); t.after(() => ui.close()); ui.render();
  const draft = ui.draft; draft.set('Keep');
  const anchor = { threadId: 'fork', turnId: 'fork-end', itemId: 'user-fork-end' };
  c.promptTree.verify = async () => { throw new Error('Unavailable'); };
  assert.equal(await ui.openPrompt(anchor), false); assert.equal(c.thread?.id, 'source'); assert.equal(ui.draft, draft);
  const wait = deferred<void>(); c.promptTree.verify = () => wait.promise;
  const navigation = ui.openPrompt(anchor);
  await ui.openSession('ordinary');
  wait.resolve();
  assert.equal(await navigation, false); assert.equal(c.thread?.id, 'ordinary');
});

test('cross-project navigation preserves and validates the exact prompt anchor', async t => {
  const { ui } = await uiFixture(); t.after(() => ui.close()); ui.render();
  const anchor = { threadId: 'fork', turnId: 'fork-end', itemId: 'user-fork-end' };
  let forwarded: unknown;
  ui.openProject = async (_cwd, _id, value) => { forwarded = value; return true; };
  assert.equal(await ui.openPrompt(anchor, '/'), true); assert.deepEqual(forwarded, anchor);
  assert.equal(validPromptAnchor(anchor), true); assert.equal(validPromptAnchor({ ...anchor, itemId: '' }), false);
});

test('the independent worker loads fork families and verifies deep prompts without model calls or session mutations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tern-prompt-worker-'));
  const history = join(dir, 'history.json'), log = join(dir, 'calls.jsonl');
  const shared = turn(prompt('shared'));
  shared.items.unshift(...Array.from({ length: 80 }, (_, i) => ({ id: `activity-${i}`, type: 'agentMessage', phase: 'commentary', text: 'Activity' })));
  await writeFile(history, JSON.stringify({ seq: 100, threads: [
    { ...thread('source'), turns: [shared, turn(prompt('later'))] },
    { ...thread('fork', 'source'), turns: [shared] },
  ] }));
  const env = { QA_HISTORY_FILE: history, QA_RPC_LOG: log, QA_TREE_FIXTURE: '1', QA_FORK_METADATA: '1' };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const service = new PromptTreeService({ binary: resolve('test/fixtures/ui-app-server.mjs'), cwd: dir });
  t.after(async () => {
    await service.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  });
  const source = await service.tree('source');
  assert.equal(source.nodes.length, 3);
  assert.deepEqual(await service.tree('fork'), source);
  await service.verify({ threadId: 'fork', turnId: 'shared', itemId: 'user-shared' });
  await assert.rejects(service.verify({ threadId: 'fork', turnId: 'shared', itemId: 'missing' }), /no longer/);
  service.invalidate('source'); assert.deepEqual(await service.tree('source'), source);
  await service.close();
  await assert.rejects(service.tree('source'), /closed/);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
  assert.ok(calls.filter(m => m === 'thread/items/list').length >= 4, 'prompt verification pages through its turn');
  assert.ok(calls.every(m => ['initialize', 'initialized', 'thread/read', 'thread/list', 'thread/turns/list', 'thread/items/list'].includes(m)));
});
