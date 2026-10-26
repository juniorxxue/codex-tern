import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Controller } from '../src/controller';
import { type CodexRpc, RpcOutcomeUnknown } from '../src/rpc';

class Transport extends EventEmitter {
  connected = true;
  options = { cwd: process.cwd() };
  calls: any[] = [];
  responses: any[] = [];
  errors: any[] = [];
  handler: (method: string, params: any) => Promise<any> = async () => ({});
  request(method: string, params: any) { this.calls.push({ method, params }); return this.handler(method, params); }
  respond(id: any, result: any) { this.responses.push({ id, result }); }
  rejectRequest(id: any, message: string) { this.errors.push({ id, message }); }
  async start() {}
  async restart() { this.connected = true; }
}
function setup() {
  const transport = new Transport();
  const c = new Controller(transport as unknown as CodexRpc, process.cwd());
  c.connection = 'ready';
  c.thread = { id: 'thread-1' } as any;
  return { c, t: transport };
}
const tick = () => new Promise(r => setTimeout(r, 15));
function firstText(c: Controller) {
  const item = c.items[0].item;
  assert.equal(item.type, 'agentMessage');
  assert.ok('text' in item); return item.text;
}
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('models gate session creation while a slow account read follows later session selections', async () => {
  const t = new Transport(), c = new Controller(t as unknown as CodexRpc, process.cwd());
  const account = deferred(), models = deferred();
  let seq = 0;
  t.handler = async method => {
    if (method === 'account/read') return account.promise;
    if (method === 'model/list') return models.promise;
    if (method === 'thread/start') return { thread: { id: `new-${++seq}`, cwd: process.cwd() }, cwd: process.cwd() };
    throw new Error(`Unexpected method: ${method}`);
  };
  const connecting = c.connect(); await tick();
  assert.equal(t.calls.some(call => call.method === 'thread/start'), false);
  models.resolve({ data: [{ id: 'available', model: 'available' }] });
  await connecting;
  assert.equal(c.sessionReady, true);
  assert.equal(c.account, 'Reading account…');
  assert.equal(c.models[0].id, 'available');
  await c.newThread();
  account.resolve({ account: { type: 'chatgpt', planType: 'plus' } }); await tick();
  assert.equal(c.account, 'ChatGPT · plus');
  await c.resume('new-1');
  assert.equal(c.account, 'ChatGPT · plus', 'a late account reply updates loaded background sessions too');
  assert.equal(t.calls.some(call => call.method.startsWith('turn/')), false);
});

test('account failures do not delay or disable the ready session', async () => {
  const t = new Transport(), c = new Controller(t as unknown as CodexRpc, process.cwd());
  const account = deferred();
  t.handler = async method => method === 'account/read' ? account.promise : method === 'model/list'
    ? { data: [] } : { thread: { id: 'new', cwd: process.cwd() }, cwd: process.cwd() };
  await c.connect();
  account.reject(new Error('Account unavailable')); await tick();
  assert.equal(c.account, 'Account unavailable');
  assert.equal(c.sessionReady, true);
  assert.equal(c.thread?.id, 'new');
});

test('old account replies and failures cannot overwrite a reconnected account', async () => {
  for (const fail of [false, true]) {
    const t = new Transport(), c = new Controller(t as unknown as CodexRpc, process.cwd());
    const old = deferred(); let reads = 0;
    t.handler = async (method, params) => {
      if (method === 'account/read') return ++reads === 1 ? old.promise : { account: { type: 'chatgpt', planType: 'pro' } };
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: params.threadId ?? 'new', cwd: process.cwd() }, cwd: process.cwd() };
      return { data: [], nextCursor: null };
    };
    await c.connect(); t.emit('disconnected', 'Disconnected');
    await c.reconnect();
    if (fail) old.reject(new Error('Old read failed'));
    else old.resolve({ account: { type: 'chatgpt', planType: 'old' } });
    await tick();
    assert.equal(c.account, 'ChatGPT · pro');
    assert.equal(c.sessionReady, true);
  }
});

test('disconnecting or closing during metadata loading cannot create a session or publish late account text', async () => {
  for (const event of ['disconnected', 'closing']) {
    const t = new Transport(), c = new Controller(t as unknown as CodexRpc, process.cwd());
    const models = deferred(), account = deferred();
    t.handler = async method => method === 'account/read' ? account.promise : models.promise;
    const connecting = c.connect(); await tick();
    t.emit(event, 'Disconnected'); c.connection = 'disconnected';
    models.resolve({ data: [] });
    await assert.rejects(connecting, /disconnected while connecting/);
    account.resolve({ account: { type: 'test' } }); await tick();
    assert.equal(c.connection, 'disconnected');
    assert.equal(c.account, 'Reading account…');
    assert.equal(t.calls.some(call => call.method === 'thread/start'), false);
  }
});

test('archive replacement retains approvals received before resume replies, even if archive fails', async () => {
  for (const failArchive of [false, true]) {
    const { c, t } = setup();
    t.handler = async method => {
      if (method === 'thread/resume') {
        t.emit('request', { id: 71, method: 'item/commandExecution/requestApproval',
          params: { threadId: 'saved', turnId: 'live' } });
        return { thread: { id: 'saved' }, cwd: process.cwd() };
      }
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      if (failArchive) throw new Error('Archive failed');
      return {};
    };
    if (failArchive) {
      await assert.rejects(c.archiveThread('thread-1', 'saved'), /Archive failed/);
      assert.equal(c.thread?.id, 'thread-1');
      await c.resume('saved');
    } else await c.archiveThread('thread-1', 'saved');
    assert.equal(c.requests[0]?.id, 71);
    assert.equal(t.calls.filter(call => call.method === 'thread/resume').length, 1);
    c.answer(71, { decision: 'decline' });
    assert.equal(t.responses.length, 1);
  }
});

test('initial resume and new-thread notifications share the eventual selected conversation', async () => {
  for (const resume of [true, false]) {
    const t = new Transport();
    const c = new Controller(t as unknown as CodexRpc, process.cwd());
    t.handler = async method => {
      if (method === 'thread/resume' || method === 'thread/start') {
        t.emit('notification', { method: 'thread/started', params: { thread: { id: 'early', cwd: process.cwd() } } });
        t.emit('request', { id: 72, method: 'item/fileChange/requestApproval', params: { threadId: 'early', turnId: 'live' } });
        return { thread: { id: 'early' }, cwd: process.cwd() };
      }
      return { data: [], nextCursor: null };
    };
    await c.connect(resume ? 'early' : undefined);
    assert.equal(c.thread?.id, 'early');
    assert.equal(c.requests[0]?.id, 72);
  }
});

test('history overlapping a partial stream reconciles without dropping or duplicating text', async () => {
  for (const snapshotText of ['Hello', 'Hello world']) {
    const { c, t } = setup();
    const reading = deferred(), page = deferred();
    let reads = 0;
    const history = (text: string) => ({ data: [{ id: 'live', status: 'inProgress',
      items: [{ id: 'message', type: 'agentMessage', text }] }], nextCursor: 'older' });
    t.handler = async method => {
      if (method === 'thread/resume') return { thread: { id: 'saved' }, cwd: process.cwd() };
      if (++reads === 1) { reading.resolve(null); return page.promise; }
      return history('Hello world');
    };
    const opening = c.resume('saved'); await reading.promise;
    t.emit('notification', { method: 'item/agentMessage/delta', params: {
      threadId: 'saved', turnId: 'live', itemId: 'message', delta: ' world',
    } });
    page.resolve(history(snapshotText)); await opening;
    assert.equal(firstText(c), 'Hello world');
    assert.equal(c.historyCursor, 'older');
    assert.equal(reads, 2, 'ambiguous overlap requires an authoritative read');
  }
});

test('completed items and turns cannot be reopened by late start, delta or history events', async () => {
  const { c, t } = setup();
  const page = deferred(); t.handler = async () => page.promise;
  const reading = c.loadHistory();
  const params = { threadId: 'thread-1', turnId: 'finished' };
  t.emit('notification', { method: 'item/completed', params: { ...params,
    item: { id: 'answer', type: 'agentMessage', text: 'Final answer' } } });
  t.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'finished', status: 'completed' } } });
  t.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'finished', status: 'inProgress' } } });
  t.emit('notification', { method: 'item/started', params: { ...params, item: { id: 'answer', type: 'agentMessage', text: '' } } });
  t.emit('notification', { method: 'item/agentMessage/delta', params: { ...params, itemId: 'answer', delta: 'late' } });
  page.resolve({ data: [{ id: 'finished', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'Old' }] }], nextCursor: null });
  await reading;
  assert.equal(c.activeTurn, null); assert.equal(c.items[0].done, true);
  assert.equal(firstText(c), 'Final answer');
});

test('latest history scope wins over older responses and older failures', async () => {
  for (const failOlder of [false, true]) {
    const { c, t } = setup(); const older = deferred(), newer = deferred();
    t.handler = async (_method, p) => p.cwd ? older.promise : newer.promise;
    const first = c.listThreads(false), second = c.listThreads(true);
    newer.resolve({ data: [{ id: 'all' }], nextCursor: 'all-cursor' }); await second;
    if (failOlder) older.reject(new Error('Old scope failed'));
    else older.resolve({ data: [{ id: 'local' }], nextCursor: 'local-cursor' });
    await first;
    assert.equal(c.threads[0].id, 'all'); assert.equal(c.threadsCursor, 'all-cursor');
  }
});

test('unconfirmed queued input is held separately and cannot be replayed or archived', async () => {
  const { c, t } = setup();
  c.activeTurn = 'old'; await c.submit('Possibly received', ['/a.png'], 'queue'); c.activeTurn = null;
  t.handler = async () => { throw new RpcOutcomeUnknown('turn/start', 1, 'Reply lost'); };
  await assert.rejects(c.runQueue(), /Reply lost/);
  assert.equal(c.queue.length, 0); assert.equal(c.unconfirmed.length, 1);
  assert.equal(c.unconfirmed[0].text, 'Possibly received'); assert.equal(c.queuePaused, true);
  await c.runQueue(); await assert.rejects(c.submit('New input'), /unconfirmed/);
  await assert.rejects(c.archiveThread('thread-1'), /Finish this session/);
  assert.equal(t.calls.length, 1);
  const id = c.unconfirmed[0].id;
  c.resolveUnconfirmed(id, true);
  assert.equal(c.unconfirmed.length, 0); assert.equal(c.queue.length, 1);
  assert.equal(t.calls.length, 1, 'choosing retry does not send it');
  t.handler = async () => ({ turn: { id: 'confirmed' } });
  await c.runQueue(); assert.equal(t.calls.length, 2); assert.equal(c.queue.length, 0);
  assert.throws(() => c.resolveUnconfirmed(id), /already been resolved/);
});

test('identical list and history reads coalesce; pagination does not duplicate rows', async () => {
  const { c, t } = setup(); const page = deferred();
  t.handler = async () => page.promise;
  const first = c.listThreads(), second = c.listThreads();
  await Promise.resolve(); assert.equal(t.calls.length, 1);
  page.resolve({ data: [{ id: 'a' }], nextCursor: 'next' }); await Promise.all([first, second]);
  t.handler = async () => ({ data: [{ id: 'a' }, { id: 'b' }], nextCursor: null });
  await Promise.all([c.listThreads(false, true), c.listThreads(false, true)]);
  assert.deepEqual(c.threads.map(t => t.id), ['a', 'b']); assert.equal(t.calls.length, 2);
  const history = deferred(); t.handler = async () => history.promise;
  const a = c.loadHistory(), b = c.loadHistory(); assert.equal(t.calls.length, 3);
  history.resolve({ data: [], nextCursor: null }); await Promise.all([a, b]);
});

test('failed history hydration retains requests for a retry of the same session', async () => {
  const { c, t } = setup(); let fail = true;
  t.handler = async method => {
    if (method === 'thread/resume') {
      t.emit('request', { id: 88, method: 'item/fileChange/requestApproval', params: { threadId: 'saved', turnId: 'live' } });
      return { thread: { id: 'saved' }, cwd: process.cwd() };
    }
    if (fail) throw new Error('History unavailable');
    return { data: [], nextCursor: null };
  };
  await assert.rejects(c.resume('saved'), /History unavailable/);
  assert.deepEqual(c.sessionStatus('saved'), { running: false, waiting: true, completed: false, failed: false });
  fail = false; await c.resume('saved');
  assert.equal(c.requests.filter(r => r.id === 88).length, 1);
});

test('new thread inherits config and does not inject prompts or permission overrides', async () => {
  const { c, t } = setup();
  t.handler = async () => ({ thread: { id: 'new' }, cwd: process.cwd(), model: 'configured-model' });
  await c.newThread();
  assert.deepEqual(t.calls, [{ method: 'thread/start', params: { cwd: process.cwd() } }]);
});
test('message preserves exact whitespace, Unicode and attachment order; no model defaults', async () => {
  const { c, t } = setup();
  t.handler = async () => ({ turn: { id: 'turn-1' } });
  const text = '  \u4e2d\u6587🙂\n\n keep whitespace \n';
  await c.submit(text, ['/a.png', '/b.png']);
  assert.deepEqual(t.calls, [{ method: 'turn/start', params: { threadId: 'thread-1', input: [
    { type: 'text', text, text_elements: [] }, { type: 'localImage', path: '/a.png' }, { type: 'localImage', path: '/b.png' },
  ] } }]);
});
test('steering uses active turn precondition and failure never creates a queued turn', async () => {
  const { c, t } = setup(); c.activeTurn = 'active';
  t.handler = async () => { throw new Error('Turn already ended'); };
  await assert.rejects(c.submit('\u8865\u5145'), /Turn already ended/);
  assert.equal(t.calls[0].method, 'turn/steer');
  assert.equal(t.calls[0].params.expectedTurnId, 'active');
  assert.equal(t.calls.length, 1); assert.equal(c.queue.length, 0);
});
test('queue remains local until completion and pauses on interruption', async () => {
  const { c, t } = setup(); c.activeTurn = 'active';
  await c.submit('next', [], 'queue'); assert.equal(t.calls.length, 0);
  t.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'active', status: 'interrupted' } } });
  await tick(); assert.equal(c.queue.length, 1); assert.equal(c.queuePaused, true); assert.equal(t.calls.length, 0);
});
test('completed turn starts one queued turn, without losing entries or resending', async () => {
  const { c, t } = setup(); c.activeTurn = 'active';
  t.handler = async () => ({ turn: { id: 'next' } });
  await c.submit('next', [], 'queue');
  t.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'active', status: 'completed' } } });
  await tick(); assert.equal(t.calls.length, 1); assert.equal(c.queue.length, 0); assert.equal(c.activeTurn, 'next');
});
test('completion arriving before turn/start response cannot resurrect the finished turn', async () => {
  const { c, t } = setup();
  t.handler = async () => {
    t.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'fast', status: 'completed' } } });
    return { turn: { id: 'fast' } };
  };
  await c.submit('hello'); assert.equal(c.activeTurn, null);
});
test('approvals stay pending until an explicit response, and stale buttons fail', () => {
  const { c, t } = setup();
  t.emit('request', { id: 'approval-7', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', command: 'test' } });
  assert.equal(t.responses.length, 0);
  c.answer('approval-7', { decision: 'decline' });
  assert.deepEqual(t.responses, [{ id: 'approval-7', result: { decision: 'decline' } }]);
  assert.throws(() => c.answer('approval-7', { decision: 'accept' }), /no longer active/);
});
test('resolved requests and turn completion invalidate old approvals', () => {
  const { c, t } = setup();
  const request = { id: 3, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } };
  t.emit('request', request);
  t.emit('notification', { method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 3 } });
  assert.equal(c.requests.length, 0);
  t.emit('request', request);
  t.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(c.requests.length, 0);
});
test('unknown requests fail explicitly and never approve execution', () => {
  const { c, t } = setup();
  t.emit('request', { id: 9, method: 'item/permissions/requestApproval', params: {} });
  assert.equal(t.responses.length, 0); assert.equal(t.errors[0].id, 9); assert.equal(c.notices[0].error, true);
});
test('disconnect clears pending approvals, preserves queue, never replays requests', async () => {
  const { c, t } = setup(); c.activeTurn = 'active';
  await c.submit('next', [], 'queue');
  t.emit('request', { id: 7, method: 'item/fileChange/requestApproval', params: {} });
  t.emit('disconnected', 'Disconnected');
  assert.equal(c.requests.length, 0); assert.equal(c.queue.length, 1); assert.equal(c.queuePaused, true);
  assert.equal(t.calls.length, 0); assert.equal(c.connection, 'disconnected');
});
test('failed resume never silently creates a new conversation', async () => {
  const { c, t } = setup(); t.handler = async () => { throw new Error('Missing thread'); };
  await assert.rejects(c.resume('missing'), /Missing thread/);
  assert.equal(t.calls.length, 1); assert.equal(t.calls[0].method, 'thread/resume'); assert.equal(c.thread?.id, 'thread-1');
});

test('deleting an inactive background session archives it once without changing selection', async () => {
  const { c, t } = setup();
  c.threads = [{ id: 'saved' }, { id: 'thread-1' }] as any;
  await c.archiveThread('saved');
  assert.deepEqual(t.calls, [{ method: 'thread/archive', params: { threadId: 'saved' } }]);
  assert.equal(c.thread?.id, 'thread-1');
  assert.equal(c.isArchived('saved'), true);
  assert.deepEqual(c.threads.map(t => t.id), ['thread-1']);
  await assert.rejects(c.archiveThread('saved'), /Finish this session/);
  assert.equal(t.calls.length, 1);
});

test('deleting the selected session returns to an existing conversation and keeps its task running', async () => {
  const { c, t } = setup();
  c.activeTurn = 'background-task';
  t.handler = async method => method === 'thread/start'
    ? { thread: { id: 'idle' }, cwd: process.cwd() } : {};
  await c.newThread();
  await c.archiveThread('idle', 'thread-1');
  assert.equal(c.isArchived('idle'), true);
  assert.equal(c.thread?.id, 'thread-1');
  assert.deepEqual(c.sessionStatus('thread-1'), { running: true, waiting: false, completed: false, failed: false });
  assert.deepEqual(t.calls.map(x => x.method), ['thread/start', 'thread/archive']);
});

test('deleting a selected session resumes a saved neighbour before archiving, without creating another thread', async () => {
  const { c, t } = setup();
  t.handler = async method => method === 'thread/resume'
    ? { thread: { id: 'saved' }, cwd: process.cwd() }
    : method === 'thread/turns/list' ? { data: [], nextCursor: null } : {};
  await c.archiveThread('thread-1', 'saved');
  assert.equal(c.thread?.id, 'saved');
  assert.deepEqual(t.calls.map(x => x.method), ['thread/resume', 'thread/turns/list', 'thread/archive']);
});

test('archive failures and failed replacement creation retain the selected conversation', async () => {
  const { c, t } = setup();
  c.items = [{ id: 'original', item: { text: 'Saved answer' } }] as any;
  t.handler = async () => { throw new Error('Start unavailable'); };
  await assert.rejects(c.archiveThread('thread-1'), /Start unavailable/);
  assert.deepEqual(t.calls.map(x => x.method), ['thread/start']);
  await assert.rejects(c.archiveThread('thread-1', 'saved'), /Start unavailable/);
  assert.equal(c.thread?.id, 'thread-1'); assert.equal(c.items[0].id, 'original');
  assert.equal(t.calls.at(-1).method, 'thread/resume');
  t.handler = async method => {
    if (method === 'thread/archive') throw new Error('Archive unavailable');
    return { thread: { id: 'replacement' }, cwd: process.cwd() };
  };
  await assert.rejects(c.archiveThread('thread-1'), /Archive unavailable/);
  assert.equal(c.thread?.id, 'thread-1'); assert.equal(c.items[0].id, 'original');
  assert.equal(c.isArchived('thread-1'), false); assert.equal(c.selecting, false);
});

test('running tasks, pending answers and queued input cannot be archived', async () => {
  const { c, t } = setup();
  c.activeTurn = 'active';
  await assert.rejects(c.archiveThread('thread-1'), /Finish this session/);
  c.activeTurn = null; c.requests = [{ id: 1 }] as any;
  await assert.rejects(c.archiveThread('thread-1'), /Finish this session/);
  c.requests = []; c.queue = [{ id: 'queued', text: 'Keep', images: [] }];
  await assert.rejects(c.archiveThread('thread-1'), /Finish this session/);
  assert.equal(t.calls.length, 0);
});

test('resuming an idle session never reports task execution; real background turns stay running', async () => {
  const { c, t } = setup();
  c.activeTurn = 'real-background-turn';
  let resumed!: (value: any) => void;
  t.handler = async method => method === 'thread/resume'
    ? new Promise(resolve => { resumed = resolve; })
    : { data: [], nextCursor: null };
  const pending = c.resume('idle');
  assert.equal(c.selecting, true);
  assert.deepEqual(c.sessionStatus('idle'), { running: false, waiting: false, completed: false, failed: false });
  assert.deepEqual(c.sessionStatus('thread-1'), { running: true, waiting: false, completed: false, failed: false });
  resumed({ thread: { id: 'idle' }, cwd: process.cwd() }); await pending;
  assert.equal(c.thread?.id, 'idle');
  assert.deepEqual(c.sessionStatus('idle'), { running: false, waiting: false, completed: false, failed: false });
  assert.deepEqual(c.sessionStatus('thread-1'), { running: true, waiting: false, completed: false, failed: false });
});
test('items keep identity across streaming, completion and other-thread events', () => {
  const { c, t } = setup();
  t.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'a', itemId: 'i', delta: '\u4f60\u597d' } });
  t.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'other', turnId: 'a', itemId: 'i', delta: 'wrong' } });
  t.emit('notification', { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'a', item: { id: 'i', type: 'agentMessage', text: '\u4f60\u597d\uff01' } } });
  assert.equal(c.items.length, 1); assert.equal(firstText(c), '\u4f60\u597d\uff01'); assert.equal(c.items[0].done, true);
});

function sessions(t: Transport) {
  t.handler = async (method, p) => method === 'thread/resume'
    ? { thread: { id: p.threadId }, cwd: process.cwd(), model: 'default-model' }
    : method === 'thread/turns/list' ? { data: [], nextCursor: null }
    : method === 'turn/start' ? { turn: { id: `turn-${p.threadId}` } } : {};
}

test('two sessions keep independent running turns, history, model choices and approvals', async () => {
  const { c, t } = setup(); sessions(t);
  c.chooseModel('first-model'); await c.submit('first task');
  await c.resume('thread-2'); await c.submit('second task');
  t.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-thread-1', itemId: 'a', delta: 'background result' } });
  t.emit('request', { id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-thread-1' } });
  assert.equal(c.activeTurn, 'turn-thread-2'); assert.equal(c.requests.length, 0); assert.equal(c.items.length, 0);
  assert.deepEqual(c.sessionStatus('thread-1'), { running: true, waiting: true, completed: false, failed: false });
  const calls = t.calls.length;
  await c.resume('thread-1');
  assert.equal(t.calls.length, calls, 'a loaded session is selected without another resume or history request');
  assert.equal(c.activeTurn, 'turn-thread-1'); assert.equal(c.model, 'first-model');
  assert.equal(firstText(c), 'background result'); assert.equal(c.requests[0].id, 77);
  c.answer(77, { decision: 'decline' });
  await c.stop();
  assert.deepEqual(t.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-thread-1' } });
  await c.resume('thread-2'); assert.equal(c.activeTurn, 'turn-thread-2');
});

test('a delayed send response belongs to its original session after switching', async () => {
  const { c, t } = setup(); sessions(t);
  const handler = t.handler;
  let complete!: (result: any) => void;
  t.handler = (method, p) => method === 'turn/start' && p.threadId === 'thread-1'
    ? new Promise(resolve => { complete = resolve; }) : handler(method, p);
  const sending = c.submit('first task');
  await c.resume('thread-2'); await c.submit('second task');
  complete({ turn: { id: 'late-first' } }); await sending;
  assert.equal(c.thread?.id, 'thread-2'); assert.equal(c.activeTurn, 'turn-thread-2');
  await c.resume('thread-1'); assert.equal(c.activeTurn, 'late-first');
});

test('background completion runs that session queue and never sends it to the selected session', async () => {
  const { c, t } = setup(); sessions(t);
  await c.submit('first task'); await c.submit('first follow-up', [], 'queue');
  await c.resume('thread-2'); await c.submit('second task');
  t.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-thread-1', status: 'completed' } } });
  await tick();
  assert.equal(c.thread?.id, 'thread-2'); assert.equal(c.activeTurn, 'turn-thread-2');
  const next = t.calls.filter(call => call.method === 'turn/start').at(-1);
  assert.equal(next.params.threadId, 'thread-1');
  assert.equal(next.params.input[0].text, 'first follow-up');
  await c.resume('thread-1'); assert.equal(c.queue.length, 0);
});

test('creating a session while another runs keeps the original task and queued input', async () => {
  const { c, t } = setup(); sessions(t);
  await c.submit('running'); await c.submit('later', [], 'queue');
  const handler = t.handler;
  t.handler = (method, p) => method === 'thread/start'
    ? Promise.resolve({ thread: { id: 'new' }, cwd: p.cwd, model: 'default-model' }) : handler(method, p);
  await c.newThread(); assert.equal(c.thread?.id, 'new');
  assert.equal(c.activeTurn, null); assert.equal(c.queue.length, 0); assert.equal(c.hasWork, true);
  await c.resume('thread-1');
  assert.equal(c.activeTurn, 'turn-thread-1'); assert.equal(c.queue[0].text, 'later');
});

test('rejected background input and its error stay in their original session', async () => {
  const { c, t } = setup(); sessions(t);
  await c.resume('thread-2');
  c.preserveInput('thread-1', 'not accepted', ['/tmp/image.png']);
  c.sessionNotice('thread-1', 'Rejected in first session', true);
  assert.equal(c.queue.length, 0); assert.equal(c.notices.length, 0);
  await c.resume('thread-1');
  assert.equal(c.queuePaused, true); assert.equal(c.queue[0].text, 'not accepted');
  assert.deepEqual(c.queue[0].images, ['/tmp/image.png']);
  assert.equal(c.notices[0].text, 'Rejected in first session');
});
