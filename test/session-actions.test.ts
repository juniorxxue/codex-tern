import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Node, type Session, type Surface } from '@stencil-hq/tern';
import { Controller } from '../src/controller';
import { FolderSessions } from '../src/folder-sessions';
import { NativeUI } from '../src/ui';
import { type CodexRpc, RpcOutcomeUnknown } from '../src/rpc';
import { parseRpcMessage, validateResult } from '../src/protocol';

const reply = (id: string, phase = 'final_answer') => ({ type: 'agentMessage', id, text: id, phase });
const turn = (id: string, status = 'completed') => ({ id, status, items: [reply(`${id}-reply`)] });
const thread = (id: string) => ({ id, cwd: '/tmp', name: id, preview: id, updatedAt: 10, recencyAt: 10 });
const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup() {
  const calls: { method: string; params: any }[] = [];
  const transport = Object.assign(new EventEmitter(), {
    handler: async (method: string, _params: any): Promise<any> => {
      if (method === 'thread/fork' || method === 'thread/resume') return { thread: thread('fork'), cwd: '/tmp' };
      if (method === 'thread/turns/list') return { data: [turn('first')], nextCursor: null };
      return {};
    },
    request(method: string, params: any) { calls.push({ method, params }); return this.handler(method, params); },
  });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp');
  c.connection = 'ready'; c.thread = thread('source') as any;
  for (const id of ['first', 'second']) {
    const t = turn(id);
    c.turns.set(id, t as any); c.endedTurns.add(id);
    c.items.push({ id: `${id}:${id}-reply`, turnId: id, done: true, item: t.items[0] as any });
  }
  return { c, transport, calls };
}
function uiFor(c: Controller) {
  return new NativeUI(c, { close: async () => {} } as unknown as Session,
    { closed: true, stylesheet: () => {}, focus: () => {} } as unknown as Surface);
}

test('fork keeps the chosen completed turn and the same directory, leaving source work intact', async () => {
  const { c, calls } = setup();
  const original = c.items;
  c.activeTurn = 'running'; c.queue.push({ id: 'q', text: 'Later', images: [] }); c.queuePaused = true;
  c.requests.push({ id: 11, method: 'approval', params: { turnId: 'running' }, answers: {} });
  c.modelOverride = 'chosen-model'; c.effortOverride = 'high';
  await c.forkThread('source', 'first');
  assert.deepEqual(calls, [
    { method: 'thread/fork', params: { threadId: 'source', lastTurnId: 'first', cwd: '/tmp', excludeTurns: true,
      model: 'chosen-model', config: { model_reasoning_effort: 'high' } } },
    { method: 'thread/turns/list', params: { threadId: 'fork', limit: 15, sortDirection: 'desc', itemsView: 'full' } },
  ]);
  assert.equal(c.thread?.id, 'fork'); assert.equal(c.cwd, '/tmp'); assert.equal(c.sessionReady, true);
  assert.deepEqual(c.items.map(i => i.turnId), ['first']);
  assert.equal(c.activeTurn, null); assert.equal(c.queue.length, 0); assert.equal(c.requests.length, 0);
  assert.equal(c.model, 'chosen-model'); assert.equal(c.effort, 'high');
  await c.resume('source');
  assert.equal(c.items, original); assert.equal(c.activeTurn, 'running');
  assert.equal(c.queue[0].text, 'Later'); assert.equal(c.requests[0].id, 11);
  assert.equal(calls.length, 2, 'returning to the source reuses its live state');
});

for (const overrides of [
  {}, { model: 'chosen-model' }, { effort: 'none' }, { model: 'chosen-model', effort: 'high' },
]) test(`fork inherits effective settings and local overrides ${JSON.stringify(overrides)} through its first turn`, async () => {
  const { c, transport, calls } = setup();
  c.effective = { thread: c.thread, cwd: '/tmp', model: 'source-model', modelProvider: 'source-provider', reasoningEffort: 'low' } as any;
  c.modelOverride = overrides.model; c.effortOverride = overrides.effort;
  const model = overrides.model ?? 'source-model', effort = overrides.effort ?? 'low';
  const handle = transport.handler;
  transport.handler = async (method, params) => {
    if (method === 'thread/fork') return { thread: thread('fork'), cwd: '/tmp', model: 'server-default', reasoningEffort: 'medium' };
    if (method === 'turn/start') return { turn: turn('fork-turn', 'inProgress') };
    return handle(method, params);
  };
  await c.forkThread('source', 'first');
  assert.equal(calls[0].params.model, model);
  assert.equal(calls[0].params.modelProvider, 'source-provider');
  assert.deepEqual(calls[0].params.config, { model_reasoning_effort: effort });
  assert.equal(c.model, model); assert.equal(c.effort, effort);
  await c.submit('Continue the fork');
  const started = calls.find(call => call.method === 'turn/start')!;
  assert.equal(started.params.threadId, 'fork');
  assert.equal(started.params.model, model); assert.equal(started.params.effort, effort);
  await c.resume('source');
  assert.equal(c.model, model); assert.equal(c.effort, effort);
  assert.equal(c.modelOverride, overrides.model); assert.equal(c.effortOverride, overrides.effort);
});

test('fork omits unknown settings instead of sending display placeholders to Codex', async () => {
  const { c, calls } = setup();
  await c.forkThread('source', 'first');
  assert.deepEqual(calls[0].params, { threadId: 'source', lastTurnId: 'first', cwd: '/tmp', excludeTurns: true });
});

test('fork rejects an unfinished or stale reply and never retries a rejected mutation', async () => {
  const { c, transport, calls } = setup();
  c.turns.get('first')!.status = 'inProgress';
  await assert.rejects(c.forkThread('source', 'first'), /completed reply/);
  await assert.rejects(c.forkThread('old-source', 'second'), /completed reply/);
  assert.equal(calls.length, 0);
  transport.handler = async () => { throw new RpcOutcomeUnknown('thread/fork', 1, 'Fork outcome unknown'); };
  await assert.rejects(c.forkThread('source', 'second'), /outcome unknown/);
  assert.equal(c.thread?.id, 'source'); assert.equal(c.items.length, 2);
  assert.equal(c.selecting, false); assert.equal(calls.length, 1);
});

test('a created fork survives a history read failure and can be reopened without another fork', async () => {
  const { c, transport, calls } = setup();
  const handle = transport.handler;
  transport.handler = async (method, params) => {
    if (method === 'thread/turns/list') throw new Error('History unavailable');
    return handle(method, params);
  };
  await assert.rejects(c.forkThread('source', 'first'), /History unavailable/);
  assert.equal(c.thread?.id, 'fork'); assert.equal(c.sessionReady, false);
  transport.handler = handle;
  await c.resume('fork');
  assert.equal(c.sessionReady, true);
  assert.equal(calls.filter(call => call.method === 'thread/fork').length, 1);
});

test('renaming a background session updates cached titles without switching or stopping tasks', async () => {
  const { c, transport, calls } = setup();
  c.activeTurn = 'running'; c.threads = [thread('background')] as any;
  transport.handler = async method => method === 'thread/list'
    ? { data: [thread('background')], nextCursor: null } : {};
  await c.renameThread('background', '  分支 A · Revised  ');
  assert.equal(c.thread?.id, 'source'); assert.equal(c.activeTurn, 'running');
  assert.equal(c.sessionThread('background')?.name, '分支 A · Revised');
  assert.equal(c.threads[0].name, '分支 A · Revised');
  await c.listThreads();
  assert.equal(c.threads[0].name, '分支 A · Revised', 'a stale list response cannot undo the rename');
  assert.deepEqual(calls[0], { method: 'thread/name/set', params: { threadId: 'background', name: '分支 A · Revised' } });
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 0);
  transport.emit('notification', { method: 'thread/name/updated', params: { threadId: 'background', threadName: 'Updated elsewhere' } });
  assert.equal(c.threads[0].name, 'Updated elsewhere');
});

test('empty and failed renames leave the stored title intact', async () => {
  const { c, transport, calls } = setup();
  await assert.rejects(c.renameThread('source', ' \n '), /Enter a session name/);
  assert.equal(calls.length, 0);
  transport.handler = async () => { throw new Error('Rename rejected'); };
  await assert.rejects(c.renameThread('source', 'New title'), /Rename rejected/);
  assert.equal(c.thread?.name, 'source'); assert.equal(calls.length, 1);
});

test('the sidebar sees renamed metadata even when an older list page arrives later', async t => {
  const { c, transport } = setup();
  const list = new FolderSessions(c, () => {}, async () => new Set()); t.after(() => list.dispose());
  const oldPage = deferred();
  transport.handler = async method => method === 'thread/list' ? oldPage.promise : {};
  const refreshing = list.refresh();
  await c.renameThread('background', 'Renamed');
  oldPage.resolve({ data: [thread('source'), thread('background')], nextCursor: null });
  await refreshing;
  assert.equal(list.snapshot.rows.find(row => row.id === 'background')?.title, 'Renamed');
});

test('only the last reply of a completed turn gets a fork action, including restored history', async t => {
  const { c } = setup();
  const ui = uiFor(c); t.after(() => ui.close());
  const render = (index: number) => nodes((ui as any).renderItem(c.items[index]));
  const forks = (index: number) => render(index).filter(n => n.props.role === 'ct.reply.fork');
  c.items.unshift({ id: 'first:intermediate', turnId: 'first', done: true, item: reply('intermediate') as any });
  assert.equal(forks(0).length, 0); assert.equal(forks(1).length, 1);
  c.items[2].done = false; c.turns.get('second')!.status = 'inProgress';
  assert.equal(forks(2).length, 0);
  c.items[2].done = true;
  assert.equal(forks(2).length, 0, 'item completion alone is not turn completion');
  c.turns.get('second')!.status = 'completed';
  assert.equal(forks(2).length, 1);
  c.connection = 'disconnected';
  assert.equal((forks(2)[0].props.attrs as any)['aria-disabled'], true);
});

test('fork navigation preserves source drafts and attachments and ignores repeated or stale clicks', async t => {
  const { c, transport, calls } = setup();
  const ui = uiFor(c); t.after(() => ui.close());
  ui.draft.set('Keep this draft'); ui.images = ['/tmp/diagram.png'];
  const pending = deferred(), handle = transport.handler;
  transport.handler = (method, params) => method === 'thread/fork' ? pending.promise : handle(method, params);
  const first = ui.forkSession('source', 'first');
  assert.equal(await ui.forkSession('source', 'first'), false);
  pending.resolve({ thread: thread('fork'), cwd: '/tmp' });
  assert.equal(await first, true); assert.equal(ui.draft.text, ''); assert.deepEqual(ui.images, []);
  assert.equal(await ui.forkSession('source', 'first'), false);
  assert.equal(calls.filter(call => call.method === 'thread/fork').length, 1);
  await ui.openSession('source');
  assert.equal(ui.draft.text, 'Keep this draft'); assert.deepEqual(ui.images, ['/tmp/diagram.png']);
});

test('fork responses and rename notifications reject malformed protocol data', () => {
  assert.throws(() => validateResult('thread/fork', { thread: null, cwd: '/tmp' }));
  assert.throws(() => validateResult('thread/fork', { thread: thread('fork') }));
  assert.throws(() => parseRpcMessage({ method: 'thread/name/updated', params: { threadId: 'source', threadName: {} } }));
  assert.doesNotThrow(() => validateResult('thread/fork', { thread: thread('fork'), cwd: '/tmp' }));
});
