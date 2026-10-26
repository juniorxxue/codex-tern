import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionTitles } from '../src/session-titles';
import { Controller } from '../src/controller';
import { FolderSessions } from '../src/folder-sessions';
import { RecoveryStore } from '../src/recovery';
import { type CodexRpc, RpcOutcomeUnknown } from '../src/rpc';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class Worker extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  ready = deferred();
  closed = false;
  rejected: any[] = [];
  onTurn?: () => void;
  async start() {}
  async close() { this.closed = true; }
  rejectRequest(id: any) { this.rejected.push(id); }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { example: { command: 'unused' } } } };
    if (method === 'thread/start') {
      const thread = { id: 'temporary', ephemeral: true };
      this.emit('notification', { method: 'thread/started', params: { thread } });
      this.emit('notification', { method: 'warning', params: { message: 'Background warning' } });
      return { thread, cwd: process.cwd() };
    }
    if (method === 'turn/start') {
      this.emit('notification', { method: 'turn/started', params: { threadId: 'temporary', turn: { id: 'naming' } } });
      this.ready.resolve(null); this.onTurn?.();
      return { turn: { id: 'naming' } };
    }
    return {};
  }
  finish(text = '{"title":"自动生成会话标题"}', status = 'completed') {
    this.emit('notification', { method: 'item/completed', params: { threadId: 'temporary', turnId: 'naming',
      item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text } } });
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'temporary', turn: { id: 'naming', status, items: [] } } });
  }
}
class Main extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  workers: Worker[] = [];
  remoteName: string | null = null;
  writeGate?: Promise<unknown>;
  failure?: Error;
  createPeer() { const worker = new Worker(); this.workers.push(worker); return worker; }
  ownsThread() { return true; }
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'turn/start') {
      if (this.failure) throw this.failure;
      return { turn: { id: 'main-turn', status: 'inProgress' } };
    }
    if (method === 'thread/read') return { thread: { id: params.threadId, name: this.remoteName } };
    if (method === 'thread/name/set') {
      if (this.writeGate) { const gate = this.writeGate; this.writeGate = undefined; await gate; }
      this.remoteName = params.name;
      this.emit('notification', { method: 'thread/name/updated', params: { threadId: params.threadId, threadName: params.name } });
      return {};
    }
    if (method === 'thread/resume') return { thread: { id: params.threadId, cwd: process.cwd(), name: 'Other session' }, cwd: process.cwd() };
    return { data: [], nextCursor: null };
  }
}
function setup() {
  const main = new Main();
  const c = new Controller(main as unknown as CodexRpc, process.cwd());
  c.connection = 'ready'; c.thread = { id: 'original', cwd: process.cwd(), preview: '', name: null } as any;
  return { main, c };
}
async function setupFork(name: string | null = 'Source title', store?: RecoveryStore) {
  const { main, c } = setup();
  if (store) c.useRecovery(store);
  c.thread!.name = main.remoteName = name; c.thread!.preview = 'Original prompt';
  const inherited = { id: 'inherited-turn', status: 'completed', items: [
    { id: 'inherited-reply', type: 'agentMessage', phase: 'final_answer', text: 'Original reply' },
  ] };
  c.turns.set(inherited.id, inherited as any); c.endedTurns.add(inherited.id);
  c.items.push({ id: `${inherited.id}:inherited-reply`, turnId: inherited.id, done: true, item: inherited.items[0] as any });
  const fork = { ...c.thread!, id: 'fork', forkedFromId: 'original' }, history = [inherited];
  const request = main.request.bind(main);
  main.request = async (method, params) => {
    if (method === 'thread/fork' || (params.threadId === 'fork' && ['thread/resume', 'thread/turns/list'].includes(method))) {
      main.calls.push({ method, params });
      return method === 'thread/turns/list' ? { data: [...history].reverse(), nextCursor: null }
        : { thread: { ...fork, name: main.remoteName }, cwd: fork.cwd };
    }
    return request(method, params);
  };
  await c.forkThread('original', inherited.id);
  return { main, c, history };
}

test('a fork keeps its inherited title until its first new prompt names only the fork, once', async () => {
  for (const name of ['Source title', null]) {
    const { main, c } = await setupFork(name);
    const list = new FolderSessions(c, () => {}, async () => new Set());
    assert.equal(c.thread?.name, name); assert.equal(main.workers.length, 0);
    await c.resume('original'); await c.resume('fork');
    const prompt = 'Explore the new direction';
    await c.submit(prompt);
    const worker = main.workers[0]; await worker.ready.promise;
    assert.equal(c.thread?.name, name);
    const namingInput = worker.calls.find(call => call.method === 'turn/start')!.params.input[0].text;
    assert.ok(namingInput.endsWith(`\n\n${prompt}`));
    assert.ok(!namingInput.includes('Original prompt'));
    await c.submit('A second prompt while the title is pending');
    await c.resume('original');
    worker.finish('{"title":"New direction"}'); await tick();
    assert.equal(c.thread?.id, 'original'); assert.equal(c.thread?.name, name);
    assert.equal(c.sessionThread('fork')?.name, 'New direction');
    assert.equal(list.snapshot.rows.find(row => row.id === 'fork')?.title, 'New direction');
    assert.ok(c.sessionTitleRevision('fork'));
    await c.resume('fork'); c.activeTurn = null;
    await c.submit('Another later prompt'); await tick();
    assert.equal(main.workers.length, 1);
    assert.deepEqual(main.calls.filter(call => call.method === 'thread/name/set').map(call => call.params),
      [{ threadId: 'fork', name: 'New direction' }]);
    list.dispose();
  }
});

test('a rejected first fork prompt can be retried without naming the rejected input', async () => {
  const { main, c } = await setupFork();
  main.failure = new Error('Rejected');
  await assert.rejects(c.submit('Rejected prompt'), /Rejected/);
  assert.equal(main.workers.length, 0); assert.equal(c.thread?.name, 'Source title');
  main.failure = undefined;
  await c.submit('Accepted prompt');
  const worker = main.workers[0]; await worker.ready.promise;
  assert.ok(worker.calls.find(call => call.method === 'turn/start')!.params.input[0].text.endsWith('\n\nAccepted prompt'));
  worker.finish(); await tick();
  assert.notEqual(c.thread?.name, 'Source title');
});

test('manual names set before or during the first fork prompt take precedence', async () => {
  for (const phase of ['before', 'during', 'same-name']) {
    const { main, c } = await setupFork();
    const name = phase === 'same-name' ? 'Source title' : 'My fork title';
    if (phase !== 'during') await c.renameThread('fork', name);
    await c.submit('A new direction');
    if (phase === 'during') {
      const worker = main.workers[0]; await worker.ready.promise;
      await c.renameThread('fork', name); worker.finish();
    }
    await tick();
    assert.equal(c.thread?.name, name);
    assert.equal(main.workers.length, phase === 'during' ? 1 : 0);
    assert.deepEqual(main.calls.filter(call => call.method === 'thread/name/set').map(call => call.params.name), [name]);
  }
});

test('a name saved elsewhere while a fork title is generated is retained', async () => {
  const { main, c } = await setupFork();
  await c.submit('New fork prompt');
  const worker = main.workers[0]; await worker.ready.promise;
  main.remoteName = 'Named elsewhere';
  worker.finish(); await tick();
  assert.equal(c.thread?.name, 'Named elsewhere');
  assert.ok(!main.calls.some(call => call.method === 'thread/name/set'));
});

test('failed naming, image-only input and confirmed uncertain input never name a later fork prompt', async () => {
  for (const mode of ['failed-title', 'image', 'uncertain']) {
    const { main, c } = await setupFork();
    if (mode === 'uncertain') main.failure = new RpcOutcomeUnknown('turn/start', 1, 'Unknown');
    await c.submit(mode === 'image' ? '' : 'First prompt', mode === 'image' ? ['/image.png'] : []).catch(() => {});
    if (mode === 'failed-title') {
      const worker = main.workers[0]; await worker.ready.promise;
      worker.finish('Invalid title'); await tick();
    }
    if (mode === 'uncertain') { c.resolveUnconfirmed(c.unconfirmed[0].id); main.failure = undefined; }
    c.activeTurn = null;
    await c.submit('Second prompt'); await tick();
    assert.equal(main.workers.length, mode === 'failed-title' ? 1 : 0, mode);
    assert.equal(c.thread?.name, 'Source title', mode);
    assert.ok(!main.calls.some(call => call.method === 'thread/name/set'));
  }
});

test('fork naming survives restart, and is consumed after the first accepted prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-fork-title-'));
  const path = join(dir, 'recovery.json'), store = await RecoveryStore.open(path);
  const stores = [store];
  t.after(async () => { for (const saved of stores) await saved.flush(); await rm(dir, { recursive: true, force: true }); });
  const { main, c } = await setupFork('Source title', store);
  await c.flushRecovery(); main.removeAllListeners();
  const saved = await RecoveryStore.open(path); stores.push(saved);
  const restored = new Controller(main as unknown as CodexRpc, process.cwd());
  restored.useRecovery(saved); restored.connection = 'ready';
  await restored.resume('fork');
  assert.equal(restored.thread?.name, 'Source title'); assert.equal(main.workers.length, 0);
  await restored.submit('First prompt after restart');
  const worker = main.workers[0]; await worker.ready.promise;
  worker.finish('{"title":"Restarted fork"}'); await tick();
  assert.equal(restored.thread?.name, 'Restarted fork');
  await restored.flushRecovery(); main.removeAllListeners();
  const savedAgain = await RecoveryStore.open(path); stores.push(savedAgain);
  const reopened = new Controller(main as unknown as CodexRpc, process.cwd());
  reopened.useRecovery(savedAgain); reopened.connection = 'ready';
  await reopened.resume('fork'); await reopened.submit('Later prompt after another restart'); await tick();
  assert.equal(main.workers.length, 1); assert.equal(reopened.thread?.name, 'Restarted fork');
  await reopened.flushRecovery();
});

test('reopening a fork with new history or an external rename clears its pending first title', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-fork-title-'));
  const stores: RecoveryStore[] = [];
  t.after(async () => { for (const saved of stores) await saved.flush(); await rm(dir, { recursive: true, force: true }); });
  for (const mode of ['history', 'rename']) {
    const path = join(dir, `${mode}.json`), store = await RecoveryStore.open(path); stores.push(store);
    const { main, c, history } = await setupFork('Source title', store);
    await c.flushRecovery(); main.removeAllListeners();
    if (mode === 'history') history.push({ id: 'continued-elsewhere', status: 'completed', items: [] });
    else main.remoteName = 'External name';
    const saved = await RecoveryStore.open(path); stores.push(saved);
    const restored = new Controller(main as unknown as CodexRpc, process.cwd());
    restored.useRecovery(saved); restored.connection = 'ready';
    await restored.resume('fork'); await restored.submit('A later prompt'); await tick();
    assert.equal(main.workers.length, 0, mode);
    assert.equal(restored.thread?.name, mode === 'rename' ? 'External name' : 'Source title');
    await restored.flushRecovery();
  }
});

test('naming stays off the main connection and updates the original session without changing selection or work', async () => {
  const { main, c } = setup();
  const list = new FolderSessions(c, () => {}, async () => new Set());
  const completions: unknown[] = []; c.on('completion', e => completions.push(e));
  await c.submit('请为新会话自动生成一个简短标题，生成时不要影响我的操作');
  assert.equal(c.thread?.preview, '请为新会话自动生成一个简短标题，生成时不要影响我的操作');
  const worker = main.workers[0]; await worker.ready.promise;
  assert.equal(c.sessionThread('temporary'), undefined);
  assert.equal(c.notices.length, 0); assert.equal(c.requests.length, 0);
  assert.equal(c.activeTurn, 'main-turn'); assert.equal(c.operation, '');
  assert.deepEqual(list.snapshot.rows.map(r => r.id), ['original']);
  await c.submit('Queued follow-up', [], 'queue');
  assert.equal(c.queue.length, 1);
  await c.resume('other');
  worker.finish(); await tick();
  assert.equal(c.thread?.id, 'other');
  assert.equal(c.sessionThread('original')?.name, '自动生成会话标题');
  assert.equal(c.sessionStatus('original').running, true);
  assert.ok(c.sessionTitleRevision('original'));
  assert.equal(list.snapshot.rows.find(r => r.id === 'original')?.title, '自动生成会话标题');
  assert.deepEqual(completions, []);
  assert.equal(worker.closed, true);
  assert.ok(worker.calls.some(c => c.method === 'thread/unsubscribe'));
  assert.ok(!main.calls.some(c => c.params?.ephemeral));
  await c.resume('original'); assert.equal(c.queue[0].text, 'Queued follow-up');
  list.dispose();
});

test('the isolated request disables execution and accepts completion before its start acknowledgement', async () => {
  const worker = new Worker(); worker.onTurn = () => worker.finish();
  const titles = new SessionTitles(() => worker as unknown as CodexRpc);
  const result = await titles.generate({ prompt: 'Name this', cwd: '/tmp', model: 'chosen', effort: 'low' }, new AbortController().signal);
  assert.equal(result, '自动生成会话标题');
  const start = worker.calls.find(c => c.method === 'thread/start')!.params;
  assert.equal(start.ephemeral, true); assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never'); assert.equal(start.model, 'chosen');
  assert.deepEqual(start.config.mcp_servers, { example: { enabled: false } });
  assert.equal(start.config['features.hooks'], false); assert.equal(start.config['features.unified_exec'], false);
  assert.equal(start.config.project_doc_max_bytes, 0);
  assert.ok(worker.calls.find(c => c.method === 'turn/start')!.params.outputSchema);
  assert.equal(worker.listenerCount('notification'), 0);
});

test('manual naming cancels generation immediately and never gets overwritten by late output', async () => {
  const { main, c } = setup(); await c.submit('Initial prompt');
  const worker = main.workers[0]; await worker.ready.promise;
  await c.renameThread('original', 'My chosen name');
  worker.finish(); await tick();
  assert.equal(c.thread?.name, 'My chosen name'); assert.equal(worker.closed, true);
  assert.equal(c.sessionTitleRevision('original'), undefined);
  assert.deepEqual(main.calls.filter(c => c.method === 'thread/name/set').map(c => c.params.name), ['My chosen name']);
});

test('a manual rename wins even when the automatic save has already been sent', async () => {
  const { main, c } = setup(); await c.submit('Initial prompt');
  const worker = main.workers[0]; await worker.ready.promise;
  const gate = deferred(); main.writeGate = gate.promise;
  worker.finish(); await tick();
  assert.equal(main.calls.filter(c => c.method === 'thread/name/set').length, 1);
  const manual = c.renameThread('original', 'Manual title');
  gate.resolve(null); await manual;
  assert.equal(c.thread?.name, 'Manual title'); assert.equal(main.remoteName, 'Manual title');
  assert.equal(c.sessionTitleRevision('original'), undefined);
});

test('a name saved elsewhere is retained and duplicate notifications do not replay the reveal', async () => {
  for (const external of [false, true]) {
    const { main, c } = setup(); await c.submit('Initial prompt');
    await main.workers[0].ready.promise;
    if (external) main.remoteName = 'External title';
    main.workers[0].finish(); await tick();
    const name = external ? 'External title' : '自动生成会话标题';
    assert.equal(c.thread?.name, name);
    const revision = c.sessionTitleRevision('original');
    main.emit('notification', { method: 'thread/name/updated', params: { threadId: 'original', threadName: name } });
    assert.equal(c.sessionTitleRevision('original'), revision);
    if (external) assert.ok(!main.calls.some(c => c.method === 'thread/name/set'));
  }
});

test('failed or unconfirmed sends, existing sessions and untracked forks, and image-only input do not start naming', async () => {
  for (const state of ['failed', 'uncertain', 'named', 'history', 'fork', 'image']) {
    const { main, c } = setup();
    if (state === 'failed') main.failure = new Error('Rejected');
    if (state === 'uncertain') main.failure = new RpcOutcomeUnknown('turn/start', 1, 'Unknown');
    if (state === 'named') c.thread!.name = 'Named';
    if (state === 'history') c.thread!.preview = 'Earlier prompt';
    if (state === 'fork') c.thread!.forkedFromId = 'source';
    await c.submit(state === 'image' ? '' : 'Prompt', state === 'image' ? ['/image.png'] : []).catch(() => {});
    await tick(); assert.equal(main.workers.length, 0, state);
  }
});

test('failure, malformed output, disconnect, interactive requests and timeouts quietly keep the preview', async () => {
  for (const mode of ['failed', 'malformed', 'disconnected', 'question', 'timeout']) {
    const worker = new Worker();
    const titles = new SessionTitles(() => worker as unknown as CodexRpc, 25);
    const work = titles.generate({ prompt: 'Keep this preview', cwd: '/tmp' }, new AbortController().signal);
    await worker.ready.promise;
    if (mode === 'failed') worker.finish('{"title":"Wrong"}', 'failed');
    if (mode === 'malformed') worker.finish('Not JSON');
    if (mode === 'disconnected') worker.emit('disconnected', 'Disconnected');
    if (mode === 'question') worker.emit('request', { id: 9, method: 'item/tool/requestUserInput', params: { threadId: 'temporary' } });
    assert.equal(await work, null, mode); assert.equal(worker.closed, true);
    if (mode === 'question') assert.deepEqual(worker.rejected, [9]);
    if (mode === 'timeout') assert.ok(worker.calls.some(c => c.method === 'turn/interrupt'));
  }
});

test('closing or archiving cancels pending naming; queued cancellation never opens another connection', async () => {
  for (const action of ['closing', 'disconnected', 'archive']) {
    const { main, c } = setup(); await c.submit('Prompt');
    const worker = main.workers[0]; await worker.ready.promise;
    if (action === 'archive') { c.activeTurn = null; await c.archiveThread('original', 'other'); }
    else main.emit(action, 'Disconnected');
    worker.finish(); await tick();
    assert.equal(worker.closed, true);
    assert.ok(!main.calls.some(c => c.method === 'thread/name/set'));
  }
  const workers: Worker[] = [];
  const titles = new SessionTitles(() => { const w = new Worker(); workers.push(w); return w as unknown as CodexRpc; });
  const first = new AbortController(), second = new AbortController();
  const one = titles.generate({ prompt: 'One', cwd: '/tmp' }, first.signal);
  const two = titles.generate({ prompt: 'Two', cwd: '/tmp' }, second.signal);
  await tick(); second.abort(); first.abort();
  assert.deepEqual(await Promise.all([one, two]), [null, null]);
  assert.equal(workers.length, 1);
});
