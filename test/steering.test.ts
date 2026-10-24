import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Node, Session, Surface } from '@stencil-hq/tern';
import { Controller } from '../src/controller';
import { NativeUI } from '../src/ui';
import { RpcOutcomeUnknown, type CodexRpc } from '../src/rpc';

function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const calls: { method: string; params: any }[] = [];
  const transport = Object.assign(new EventEmitter(), {
    handler: async (method: string, params: any): Promise<any> => {
      if (method === 'thread/resume') return { thread: { id: params.threadId, cwd: '/tmp' }, cwd: '/tmp' };
      if (method === 'thread/turns/list') return { data: [], nextCursor: null };
      return { turnId: 'turn' };
    },
    request(method: string, params: any) { calls.push({ method, params }); return this.handler(method, params); },
  });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp');
  c.thread = { id: 'thread', cwd: '/tmp', preview: 'Existing conversation' } as any;
  c.connection = 'ready'; c.activeTurn = 'turn'; c.notifications = false;
  const emit = (method: string, params: object) => transport.emit('notification', {
    method, params: { threadId: 'thread', turnId: 'turn', ...params },
  });
  const message = (at = 0) => ({ id: `server-${at}`, type: 'userMessage' as const,
    clientId: calls[at].params.clientUserMessageId, content: calls[at].params.input });
  return { c, transport, calls, emit, message };
}
const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
function uiFor(c: Controller) {
  const frames: { main: Node; dock: Node }[] = [];
  const surface = { closed: false, stylesheet: () => {}, focus: () => {},
    render: (frame: typeof frames[number]) => { frames.push(frame); } } as unknown as Surface;
  const session = { caps: { cols: 100, cell: { w: 8 }, kinds: [], features: [] },
    close: async () => {} } as unknown as Session;
  const ui = new NativeUI(c, session, surface);
  ui.render();
  const main = () => nodes(frames.at(-1)!.main);
  const cards = () => main().filter(n => n.props.role === 'omp.user');
  const delivery = () => main().filter(n => n.props.role === 'ct.user.delivery').map(n => n.props.text);
  return { ui, frames, cards, delivery };
}

test('steer is visible before its reply and until the delayed message arrives, with exact content', async () => {
  const { c, transport, calls, emit, message } = setup();
  const reply = deferred(); transport.handler = () => reply.promise;
  const text = '  \u8865\u5145🙂\n\n keep whitespace \n';
  const sending = c.submit(text, ['/a.png', '/b.png']);
  const local = c.items[0];
  assert.equal(local.delivery, 'sending');
  assert.equal(c.items.length, 1);
  assert.deepEqual(local.item, { id: calls[0].params.clientUserMessageId, type: 'userMessage',
    clientId: calls[0].params.clientUserMessageId, content: [
      { type: 'text', text, text_elements: [] }, { type: 'localImage', path: '/a.png' }, { type: 'localImage', path: '/b.png' },
    ] });
  assert.equal(calls[0].method, 'turn/steer'); assert.equal(calls[0].params.expectedTurnId, 'turn');
  reply.resolve({ turnId: 'turn' }); await sending;
  assert.equal(c.items[0], local); assert.equal(local.delivery, 'accepted');
  assert.equal(c.operation, '');
  emit('item/completed', { item: { id: 'work', type: 'agentMessage', phase: 'commentary', text: 'Still working' } });
  emit('item/started', { item: message() });
  emit('item/completed', { item: message() });
  emit('item/completed', { item: message() });
  assert.equal(c.items.length, 2); assert.equal(c.items[0], local);
  assert.equal(local.delivery, undefined); assert.equal(local.id, 'turn:server-0');
  assert.equal(local.done, true); assert.deepEqual(local.item, message());
  assert.equal(calls.length, 1, 'confirmation never resends input');
});

test('a message or completed turn received before the steer reply confirms the local card once', async () => {
  for (const method of ['item/started', 'item/completed', 'turn/completed']) {
    const { c, transport, emit, message } = setup();
    const reply = deferred(); transport.handler = () => reply.promise;
    const sending = c.submit('Keep working');
    const local = c.items[0];
    emit(method, method === 'turn/completed'
      ? { turn: { id: 'turn', status: 'completed', items: [message()] } } : { item: message() });
    assert.equal(local.delivery, undefined);
    reply.resolve({ turnId: 'turn' }); await sending;
    assert.equal(c.items.length, 1); assert.equal(c.items[0], local);
    assert.equal(local.delivery, undefined, 'a late reply must not restore the waiting label');
    assert.equal(c.activeTurn, method === 'turn/completed' ? null : 'turn');
  }
});

test('history confirms a delayed steer without duplicating it when live events follow', async () => {
  const { c, transport, emit, message } = setup();
  await c.submit('Keep working');
  const local = c.items[0];
  transport.handler = async () => ({ data: [{ id: 'turn', status: 'inProgress', items: [message()] }], nextCursor: null });
  await c.refreshHistory();
  assert.equal(c.items.length, 1); assert.equal(c.items[0], local); assert.equal(local.delivery, undefined);
  emit('item/completed', { item: message() });
  await c.refreshHistory();
  assert.equal(c.items.length, 1); assert.equal(c.items[0], local); assert.equal(local.done, true);
});

test('identical steers use distinct IDs and unrelated messages cannot confirm them', async () => {
  const { c, calls, emit, message } = setup();
  await c.submit('Same text'); await c.submit('Same text');
  const [first, second] = c.items;
  assert.notEqual(calls[0].params.clientUserMessageId, calls[1].params.clientUserMessageId);
  emit('item/completed', { item: { ...message(), id: 'unrelated', clientId: null } });
  emit('item/completed', { turnId: 'other-turn', item: message() });
  assert.equal(first.delivery, 'accepted'); assert.equal(second.delivery, 'accepted');
  emit('item/completed', { item: message(1) });
  assert.equal(first.delivery, 'accepted'); assert.equal(second.delivery, undefined);
  emit('item/completed', { item: message() });
  assert.equal(first.delivery, undefined); assert.equal(c.items.length, 4);
  assert.equal(c.items[0], first); assert.equal(c.items[1], second);
});

test('the send frame contains the steer immediately, and the card survives acknowledgement and session switching', async t => {
  const { c, transport, emit, message } = setup();
  const { ui, frames, cards, delivery } = uiFor(c); t.after(() => ui.close());
  const reply = deferred(), handler = transport.handler;
  transport.handler = (method, params) => method === 'turn/steer' ? reply.promise : handler(method, params);
  ui.draft.set('Keep working'); ui.render();
  const before = frames.length;
  const sending = ui.send();
  assert.equal(ui.draft.text, ''); assert.equal(cards().length, 1); assert.deepEqual(delivery(), ['Sending…']);
  const cardKey = cards()[0].props.key;
  assert.ok(frames.slice(before).every(frame => nodes(frame.main).some(n => n.props.role === 'omp.user')),
    'clearing the composer must not paint an empty transcript first');
  reply.resolve({ turnId: 'turn' }); await sending;
  assert.equal(cards().length, 1); assert.deepEqual(delivery(), ['Waiting for Codex…']);
  await ui.openSession('other'); assert.equal(cards().length, 0);
  await ui.openSession('thread'); assert.equal(cards().length, 1); assert.deepEqual(delivery(), ['Waiting for Codex…']);
  emit('item/completed', { item: message() }); ui.render();
  assert.equal(cards().length, 1); assert.deepEqual(delivery(), []);
  assert.equal(cards()[0].props.key, cardKey, 'confirmation must keep the same native card');
});

test('rejected or uncertain steering removes its local card and preserves input in the existing recovery flow', async t => {
  for (const mode of ['rejected', 'new draft', 'unknown']) await t.test(mode, async t => {
    const { c, transport, calls } = setup();
    const { ui, cards } = uiFor(c); t.after(() => ui.close());
    const reply = deferred(); transport.handler = () => reply.promise;
    ui.draft.set('Keep this message');
    const sending = ui.send(); assert.equal(cards().length, 1);
    if (mode === 'new draft') ui.draft.set('New typing');
    reply.reject(mode === 'unknown' ? new RpcOutcomeUnknown('turn/steer', 1, 'Reply lost') : new Error('Turn already ended'));
    await sending;
    assert.equal(c.items.length, 0); assert.equal(cards().length, 0); assert.equal(calls.length, 1);
    assert.equal(ui.draft.text, mode === 'rejected' ? 'Keep this message' : mode === 'new draft' ? 'New typing' : '');
    assert.equal(c.unconfirmed.length, mode === 'unknown' ? 1 : 0);
    assert.equal(c.queue.length, mode === 'new draft' ? 1 : 0);
    if (mode === 'unknown') assert.equal(c.unconfirmed[0].text, 'Keep this message');
    if (mode === 'new draft') assert.equal(c.queue[0].text, 'Keep this message');
  });
});

test('queue mode stays local and creates no steering card', async () => {
  const { c, calls } = setup();
  await c.submit('Run after this turn', [], 'queue');
  assert.equal(c.items.length, 0); assert.equal(c.queue.length, 1); assert.equal(calls.length, 0);
});
