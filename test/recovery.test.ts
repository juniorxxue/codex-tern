import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session, Surface } from '@stencil-hq/tern';
import { RecoveryStore, type SavedSession } from '../src/recovery';
import { Controller, type Completion } from '../src/controller';
import { NativeUI } from '../src/ui';
import { CodexRpc, RpcError, RpcOutcomeUnknown } from '../src/rpc';
import { completionNotification } from '../src/notifications';
import { Conversation } from '../src/conversation';

const image = fileURLToPath(new URL('./fixtures/clipboard.png', import.meta.url));
const saved = (id: string): SavedSession => ({ id, cwd: process.cwd(), name: id,
  draft: { text: '', images: [] }, queue: [], unconfirmed: [] });
class Transport extends EventEmitter {
  connected = true;
  options = { cwd: process.cwd() };
  starts = 0; restarts = 0;
  calls: { method: string; params: any }[] = [];
  async start() { this.starts++; }
  async restart() { this.restarts++; this.connected = true; }
  handler = async (method: string, params: any): Promise<any> => {
    if (method === 'model/list') return { data: [{ id: 'model', model: 'model' }] };
    if (method === 'account/read') return { account: { type: 'test' } };
    if (method === 'thread/start' || method === 'thread/resume')
      return { thread: { id: params.threadId ?? 'new', cwd: process.cwd() }, cwd: process.cwd(), model: 'model' };
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress', items: [] } };
    return { data: [], nextCursor: null };
  };
  request(method: string, params: any) { this.calls.push({ method, params }); return this.handler(method, params); }
}
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-recovery-'));
  const path = join(dir, 'state', 'recovery.json');
  const store = await RecoveryStore.open(path);
  t.after(async () => { await store.flush().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  return { dir, path, store };
}
function controller(store?: RecoveryStore) {
  const rpc = new Transport(), c = new Controller(rpc as unknown as CodexRpc, process.cwd());
  if (store) c.useRecovery(store);
  return { c, rpc };
}
function uiFor(c: Controller) {
  const surface = { closed: true, stylesheet: () => {}, focus: () => {} } as unknown as Surface;
  return new NativeUI(c, { close: async () => {} } as unknown as Session, surface);
}
const finish = (rpc: Transport, threadId: string, id: string, status = 'completed') =>
  rpc.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id, status, items: [] } } });

test('recovery writes private atomic snapshots and keeps exact Unicode, whitespace and images', async t => {
  const { path, store } = await fixture(t);
  const entry = saved('one'); entry.draft = { text: '  中文🙂\n\n preserved \n', images: [image] };
  store.update(entry); store.select('one'); const first = store.flush();
  entry.draft.text += 'second'; store.update(entry); const last = store.flush();
  await Promise.all([first, last]);
  const restored = await RecoveryStore.open(path);
  assert.equal(restored.selected, 'one'); assert.deepEqual(restored.session('one'), entry);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
  const original = await readFile(path, 'utf8');
  await restored.flush(); assert.equal(await readFile(path, 'utf8'), original);
});

test('a corrupt or newer recovery file is left intact', async t => {
  const { path, store } = await fixture(t); await store.flush();
  for (const contents of ['{bad json', '{"version":999}']) {
    await writeFile(path, contents);
    await assert.rejects(RecoveryStore.open(path), /Could not restore local drafts/);
    assert.equal(await readFile(path, 'utf8'), contents);
  }
});

test('restart restores each draft and attachment, holds queues, and does not send or notify', async t => {
  const { path, store } = await fixture(t);
  const one = saved('one'), two = saved('two');
  one.draft = { text: 'first draft', images: [image] };
  one.queue = [{ id: 'q', text: 'queued', images: [] }];
  two.draft.text = '第二个草稿'; two.unconfirmed = [{ id: 'u', text: 'uncertain', images: [image] }];
  store.update(one); store.update(two); store.select('two'); store.setNotifications(false); await store.flush();
  const { c, rpc } = controller(await RecoveryStore.open(path));
  const events: Completion[] = []; c.on('completion', e => events.push(e));
  await c.connect();
  const ui = uiFor(c); t.after(() => ui.close()); ui.render();
  assert.equal(c.thread?.id, 'two'); assert.equal(c.models[0].id, 'model');
  assert.equal(ui.draft.text, two.draft.text); assert.equal(c.notifications, false);
  assert.equal(c.unconfirmed.length, 1); await c.runQueue();
  await ui.openSession('one');
  assert.equal(ui.draft.text, one.draft.text); assert.deepEqual(ui.images, [image]);
  assert.equal(c.queue.length, 1); assert.equal(c.queuePaused, true);
  assert.equal(rpc.calls.some(r => r.method === 'turn/start' || r.method === 'turn/steer'), false);
  assert.deepEqual(events, []);
  await ui.openSession('two'); assert.equal(ui.draft.text, two.draft.text);
});

test('an explicit initial prompt creates a fresh session while keeping earlier drafts', async t => {
  const { store } = await fixture(t);
  const entry = saved('old'); entry.draft.text = 'keep me'; store.update(entry); store.select('old');
  const { c, rpc } = controller(store); await c.connect(undefined, true);
  assert.equal(c.thread?.id, 'new'); assert.equal(c.savedDraft('old')?.text, 'keep me');
  assert.equal(rpc.calls.some(r => r.method === 'thread/resume'), false);
});

test('input is journaled before delivery; a crash snapshot never replays or duplicates it in the draft', async t => {
  const { path, store } = await fixture(t);
  const { c, rpc } = controller(store); await c.connect();
  const ui = uiFor(c); t.after(() => ui.close()); ui.render();
  ui.draft.set('  send 中文\n'); ui.images = [image]; ui.render();
  const original = rpc.handler;
  rpc.handler = async (method, params) => {
    if (method !== 'turn/start') return original(method, params);
    const snapshot = await RecoveryStore.open(path);
    assert.equal(snapshot.session('new')?.draft.text, '');
    assert.deepEqual(snapshot.session('new')?.inflight?.images, [image]);
    const recovered = controller(snapshot);
    await recovered.c.connect(); await recovered.c.runQueue();
    assert.equal(recovered.c.unconfirmed[0].text, '  send 中文\n');
    assert.equal(recovered.c.queue.length, 0);
    assert.equal(recovered.rpc.calls.some(r => r.method.startsWith('turn/')), false);
    await recovered.c.flushRecovery();
    throw new RpcOutcomeUnknown('turn/start', 1, 'Connection lost');
  };
  await ui.send(); await c.flushRecovery();
  assert.equal(ui.draft.text, ''); assert.deepEqual(ui.images, []);
  assert.equal(c.unconfirmed.length, 1); assert.equal(c.queue.length, 0);
  assert.equal((await RecoveryStore.open(path)).session('new')?.inflight, undefined);
});

test('a queue journal restores an in-flight entry once, and successful acknowledgement removes it', async t => {
  const { path, store } = await fixture(t);
  const { c, rpc } = controller(store); await c.connect(); c.activeTurn = 'running';
  await c.submit('queued with image', [image], 'queue'); c.activeTurn = null;
  const original = rpc.handler;
  rpc.handler = async (method, params) => {
    if (method === 'turn/start') {
      const { c: recovered } = controller(await RecoveryStore.open(path));
      assert.equal(recovered.sessionStatus('new').waiting, true);
      await recovered.connect();
      assert.equal(recovered.queue.length, 0); assert.equal(recovered.unconfirmed.length, 1);
      assert.equal(recovered.unconfirmed[0].text, 'queued with image');
      await recovered.flushRecovery();
    }
    return original(method, params);
  };
  await c.runQueue(); await c.flushRecovery();
  const snapshot = (await RecoveryStore.open(path)).session('new')!;
  assert.deepEqual(snapshot.queue, []); assert.deepEqual(snapshot.unconfirmed, []); assert.equal(snapshot.inflight, undefined);
});

test('unwritable recovery storage and missing attachments block delivery without losing the draft', async t => {
  const { path, store } = await fixture(t);
  const { c, rpc } = controller(store); await c.connect();
  const ui = uiFor(c); t.after(() => ui.close()); ui.render();
  ui.draft.set('keep on failure'); ui.images = [join(path, 'missing.png')];
  await ui.send(); assert.equal(ui.draft.text, 'keep on failure'); assert.match(c.notices.at(-1)!.text, /Image unavailable/);
  ui.images = [];
  await store.flush(); await rm(path); await mkdir(path);
  await ui.send(); assert.equal(ui.draft.text, 'keep on failure');
  assert.equal(rpc.calls.some(r => r.method.startsWith('turn/')), false);
  await rm(path, { recursive: true }); await c.flushRecovery();
});

test('a turn finishing while a queue write fails cannot send the rejected queued input', async () => {
  const rpc = new Transport(), c = new Conversation(rpc as unknown as CodexRpc, process.cwd());
  c.thread = { id: 'one' } as any; c.connection = 'ready'; c.activeTurn = 'running';
  let reject!: (error: Error) => void;
  c.checkpoint = () => new Promise((_yes, no) => { reject = no; });
  const adding = c.submit('not saved', [], 'queue');
  c.onNotification({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'running', status: 'completed', items: [] } } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(rpc.calls, [], 'the queue must wait for its durable write');
  reject(new Error('Disk full')); await assert.rejects(adding, /Disk full/);
  assert.equal(c.queue.length, 0); assert.equal(c.queuePaused, true); assert.deepEqual(rpc.calls, []);
});

test('a send rejected during shutdown still saves its restored draft', async t => {
  const { path, store } = await fixture(t);
  const { c, rpc } = controller(store); await c.connect();
  const ui = uiFor(c); ui.render(); ui.draft.set('Keep this even after closing');
  let reject!: (error: Error) => void, started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  rpc.handler = () => new Promise((_yes, no) => { reject = no; started(); });
  const sending = ui.send(); await writing; await ui.close();
  reject(new Error('Not accepted')); await sending; await c.flushRecovery();
  assert.equal((await RecoveryStore.open(path)).session('new')?.draft.text, 'Keep this even after closing');
});

test('reconnect coalesces clicks, refreshes history and auth, preserves drafts, and never restarts the queue', async t => {
  const { store } = await fixture(t);
  const { c, rpc } = controller(store); await c.connect();
  const ui = uiFor(c); t.after(() => ui.close()); ui.render(); ui.draft.set('draft after outage'); ui.render();
  c.activeTurn = 'old'; await c.submit('queue after outage', [], 'queue');
  c.requests = [{ id: 99, method: 'old', params: {}, answers: {} }];
  rpc.emit('disconnected', 'Disconnected');
  const original = rpc.handler;
  rpc.handler = async (method, params) => {
    if (method === 'thread/resume') rpc.emit('request', { id: 101, method: 'item/fileChange/requestApproval', params: { threadId: 'new', turnId: 'live' } });
    if (method === 'thread/turns/list') return { data: [{ id: 'done', status: 'completed', items: [
      { id: 'answer', type: 'agentMessage', text: 'Recovered from Codex' },
    ] }], nextCursor: null };
    return original(method, params);
  };
  const events: Completion[] = []; c.on('completion', e => events.push(e));
  await Promise.all([c.reconnect(), c.reconnect()]); ui.render();
  assert.equal(rpc.restarts, 1); assert.equal(c.sessionReady, true); assert.equal(c.account, 'test');
  assert.equal(c.items.length, 1); assert.deepEqual(c.requests.map(r => r.id), [101]);
  assert.equal(ui.draft.text, 'draft after outage'); assert.equal(c.queue.length, 1); assert.equal(c.queuePaused, true);
  assert.equal(rpc.calls.some(r => r.method.startsWith('turn/')), false); assert.deepEqual(events, []);
});

test('an unavailable saved session keeps drafts and allows selecting another session', async t => {
  const { store } = await fixture(t); const entry = saved('missing'); entry.draft.text = 'recover me';
  store.update(entry); store.select('missing');
  const { c, rpc } = controller(store); const original = rpc.handler;
  rpc.handler = async (method, params) => {
    if (method === 'thread/resume' && params.threadId === 'missing') throw new Error('Session unavailable');
    return original(method, params);
  };
  await assert.rejects(c.connect(), /unavailable/);
  assert.equal(c.connection, 'ready'); assert.equal(c.sessionReady, false);
  await c.newThread(); assert.equal(c.thread?.id, 'new'); assert.equal(c.savedDraft('missing')?.text, 'recover me');
});

test('automatic restore replaces only a missing blank selection and persists the new selection', async t => {
  const { store, path } = await fixture(t);
  store.update({ ...saved('missing'), name: undefined, preview: '' }); store.select('missing');
  const { c, rpc } = controller(store), original = rpc.handler;
  rpc.handler = async (method, params) => {
    if (method === 'thread/resume') throw new RpcError(`no rollout found for thread id ${params.threadId}`, -32600);
    return original(method, params);
  };
  await c.connect(); await c.flushRecovery();
  assert.equal(c.thread?.id, 'new'); assert.equal(c.sessionReady, true);
  const restored = await RecoveryStore.open(path);
  assert.equal(restored.selected, 'new'); assert.equal(restored.session('missing'), undefined);
  assert.equal(rpc.calls.filter(r => r.method === 'thread/start').length, 1);
  assert.equal(rpc.calls.some(r => r.method.startsWith('turn/') || r.method === 'thread/archive'), false);
});

test('missing-rollout recovery preserves every kind of local content and explicit resume requests', async t => {
  const cases: [string, Partial<SavedSession>][] = [
    ['name', { name: 'Saved conversation' }], ['preview', { preview: 'An earlier message' }],
    ['text', { draft: { text: ' ', images: [] } }], ['attachment', { draft: { text: '', images: [image] } }],
    ['queue', { queue: [{ id: 'q', text: 'pending', images: [] }] }],
    ['unconfirmed', { unconfirmed: [{ id: 'u', text: 'maybe sent', images: [] }] }],
    ['inflight', { inflight: { id: 'i', text: 'sending', images: [] } }], ['explicit', {}],
  ];
  for (const [name, content] of cases) await t.test(name, async t => {
    const { store } = await fixture(t);
    store.update({ ...saved('missing'), name: undefined, ...content }); store.select('missing');
    const { c, rpc } = controller(store), original = rpc.handler;
    rpc.handler = async (method, params) => {
      if (method === 'thread/resume') throw new RpcError('no rollout found for thread id missing', -32600);
      return original(method, params);
    };
    await assert.rejects(c.connect(name === 'explicit' ? 'missing' : undefined), /no rollout found/);
    assert.equal(c.thread?.id, 'missing'); assert.ok(store.session('missing'));
    assert.equal(rpc.calls.some(r => r.method === 'thread/start'), false);
  });
});

test('automatic recovery does not hide other errors or uncertain resume outcomes', async t => {
  for (const error of [new RpcError('Session is in use'), new RpcError('no rollout found for thread id another'),
    new RpcOutcomeUnknown('thread/resume', 1, 'no rollout found for thread id missing')]) {
    const { store } = await fixture(t);
    store.update({ ...saved('missing'), name: undefined }); store.select('missing');
    const { c, rpc } = controller(store), original = rpc.handler;
    rpc.handler = async (method, params) => {
      if (method === 'thread/resume') throw error;
      return original(method, params);
    };
    await assert.rejects(c.connect(), e => e === error);
    assert.equal(c.thread?.id, 'missing'); assert.equal(rpc.calls.some(r => r.method === 'thread/start'), false);
  }
});

test('failed replacement and input typed during replacement retain the original selection', async t => {
  for (const typing of [false, true]) await t.test(typing ? 'new draft' : 'creation failed', async t => {
    const { store } = await fixture(t);
    store.update({ ...saved('missing'), name: undefined }); store.select('missing');
    const { c, rpc } = controller(store), original = rpc.handler;
    rpc.handler = async (method, params) => {
      if (method === 'thread/resume') throw new RpcError('no rollout found for thread id missing', -32600);
      if (method === 'thread/start') {
        if (!typing) throw new RpcOutcomeUnknown('thread/start', 2, 'Creation outcome unknown');
        c.saveDraft('missing', { text: 'Typed while opening', images: [image] });
      }
      return original(method, params);
    };
    await assert.rejects(c.connect()); await c.flushRecovery();
    assert.equal(c.thread?.id, 'missing'); assert.equal(store.selected, 'missing');
    assert.ok(store.session('missing'));
    if (typing) assert.deepEqual(c.savedDraft('missing'), { text: 'Typed while opening', images: [image] });
    assert.equal(rpc.calls.filter(r => r.method === 'thread/start').length, 1);
  });
});

test('reconnect replaces a missing blank session but preserves a session with known history', async t => {
  for (const history of [false, true]) await t.test(history ? 'known history' : 'blank', async t => {
    const { store } = await fixture(t);
    const { c, rpc } = controller(store); await c.connect(); await c.flushRecovery();
    if (history) c.items = [{ id: 'answer', turnId: 'done', done: true,
      item: { id: 'answer', type: 'agentMessage', text: 'Existing answer' } as any }];
    rpc.emit('disconnected', 'Disconnected');
    const original = rpc.handler;
    rpc.handler = async (method, params) => {
      if (method === 'thread/resume') throw new RpcError('no rollout found for thread id new', -32600);
      const result = await original(method, params);
      if (method === 'thread/start') result.thread.id = 'replacement';
      return result;
    };
    if (history) await assert.rejects(c.reconnect(), /no rollout found/); else await c.reconnect();
    assert.equal(c.thread?.id, history ? 'new' : 'replacement');
    assert.equal(c.sessionReady, !history);
    assert.equal(rpc.calls.filter(r => r.method === 'thread/start').length, history ? 1 : 2);
  });
});

test('completion is delivered once after the final queued turn; stopped turns and history stay silent', async () => {
  const { c, rpc } = controller(); await c.connect();
  const events: Completion[] = []; c.on('completion', e => events.push(e));
  c.activeTurn = 'first'; await c.submit('next', [], 'queue');
  finish(rpc, 'new', 'first'); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.length, 0); assert.equal(c.activeTurn, 'turn');
  finish(rpc, 'new', 'turn'); finish(rpc, 'new', 'turn');
  assert.equal(events.length, 1); assert.equal(events[0].status, 'completed');
  assert.equal(c.sessionStatus('new').completed, true); c.markRead('new'); assert.equal(c.sessionStatus('new').completed, false);
  c.activeTurn = 'stopped'; finish(rpc, 'new', 'stopped', 'interrupted'); assert.equal(events.length, 1);
  c.activeTurn = 'failed'; finish(rpc, 'new', 'failed', 'failed'); assert.equal(events[1].status, 'failed');
});

test('fast completion before acknowledgement still notifies once and reminders can be disabled', async t => {
  const { c, rpc } = controller(); await c.connect();
  const ui = uiFor(c); t.after(() => ui.close()); const notifications: Completion[] = []; ui.notify = e => notifications.push(e);
  let seq = 0;
  rpc.handler = async () => {
    const id = `fast-${++seq}`; finish(rpc, 'new', id); return { turn: { id, status: 'completed', items: [] } };
  };
  await c.submit('fast'); assert.equal(notifications.length, 1); assert.equal(c.activeTurn, null);
  c.setNotifications(false); await c.submit('quiet'); assert.equal(notifications.length, 1);
});

test('native notifications are quiet when focused and cannot inject terminal controls through titles', () => {
  const event: Completion = { threadId: 'thread\x1b]bad', turnId: 'turn', title: '中文\n\x1b]52;secret\x07', status: 'completed' };
  const packet = completionNotification(event);
  assert.match(packet, /o=unfocused:s=c2lsZW50:a=focus/);
  assert.equal((packet.match(/\x1b/g) ?? []).length, 2); assert.equal(packet.includes('\x07'), false);
  assert.match(packet, /Task complete/); assert.equal(packet.includes('中文'), true);
});
