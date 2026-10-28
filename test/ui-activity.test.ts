import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Node, Session, Surface } from '@stencil-hq/tern';
import { Controller } from '../src/controller';
import { NativeUI } from '../src/ui';
import type { CodexRpc } from '../src/rpc';

const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
function setup() {
  const transport = Object.assign(new EventEmitter(), {
    request: async () => ({ turnId: 'turn' }),
  });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp');
  c.thread = { id: 'thread' } as any; c.connection = 'ready'; c.notifications = false;
  const session = { caps: { cols: 100, dark: false, reduceMotion: false, kinds: [], features: [], cell: { w: 8 } },
    close: async () => {} } as unknown as Session;
  let frame: { main: Node; dock: Node };
  const surface = { closed: false, stylesheet: () => {}, focus: () => {},
    render: (view: typeof frame) => { frame = view; } } as unknown as Surface;
  const ui = new NativeUI(c, session, surface);
  const emit = (method: string, params: object) => transport.emit('notification', {
    method, params: { threadId: 'thread', turnId: 'turn', ...params },
  });
  const item = (id: string, type: string, extra: object = {}, done = true) => emit(done ? 'item/completed' : 'item/started', {
    item: { id, type, ...extra },
  });
  const render = () => {
    ui.render();
    const main = nodes(frame.main), dock = nodes(frame.dock);
    return {
      states: main.filter(n => n.props.role === 'ct.activity.state').map(n => n.props.text),
      spinners: [...main, ...dock].filter(n => n.kind === 'spinner').length,
      stop: dock.some(n => n.props.role === 'omp.composer.stop'),
      previews: main.filter(n => n.props.class === 'ct-activity-preview').length,
    };
  };
  emit('turn/started', { turn: { id: 'turn', status: 'inProgress', items: [] } });
  item('command', 'commandExecution', { command: 'echo ready', status: 'completed', exitCode: 0 });
  item('question', 'agentMessage', { phase: 'final_answer', text: 'Should I change the core rules too?' });
  const working = () => { ui.render(); return nodes(frame.dock).find(n => n.props.role === 'omp.working'); };
  return { ui, c, session, transport, emit, item, render, working };
}

test('a delivered answer and later steering keep activity live until the turn completes', async t => {
  const { ui, c, emit, item, render } = setup(); t.after(() => ui.close());
  assert.deepEqual(render(), { states: ['Activity'], spinners: 1, stop: true, previews: 1 });

  await c.submit('Keep the current core calculus');
  item('steer', 'userMessage', { content: [{ type: 'text', text: 'Keep the current core calculus' }] });
  item('reasoning', 'reasoning', { summary: [] }, false);
  assert.deepEqual(render(), { states: ['Worked', 'Activity'], spinners: 1, stop: true, previews: 1 });

  // Finishing individual items still does not finish the turn.
  item('reasoning', 'reasoning', { summary: ['Checking the source rules.'] });
  item('answer', 'agentMessage', { phase: 'final_answer', text: 'The source rules are updated.' });
  assert.deepEqual(render(), { states: ['Worked', 'Activity'], spinners: 1, stop: true, previews: 1 });

  emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } });
  assert.deepEqual(render(), { states: ['Worked', 'Worked'], spinners: 0, stop: false, previews: 0 });
});

test('input requested after an answer stays visible and returns to Working when resolved', t => {
  const { ui, transport, emit, item, render } = setup(); t.after(() => ui.close());
  item('reasoning', 'reasoning', { summary: [] }, false);
  transport.emit('request', { id: 42, method: 'item/tool/requestUserInput',
    params: { threadId: 'thread', turnId: 'turn', questions: [] } });
  assert.deepEqual(render(), { states: ['Worked', 'Needs input'], spinners: 0, stop: true, previews: 1 });
  emit('serverRequest/resolved', { requestId: 42 });
  assert.deepEqual(render(), { states: ['Worked', 'Activity'], spinners: 1, stop: true, previews: 1 });
});

test('continued work shows its actual terminal status after an earlier answer', async t => {
  for (const [status, label] of [['interrupted', 'Stopped'], ['failed', 'Failed'], ['disconnected', 'Disconnected']]) {
    await t.test(status, t => {
      const { ui, transport, emit, item, render } = setup(); t.after(() => ui.close());
      item('reasoning', 'reasoning', { summary: ['Checking the source rules.'] }, false);
      assert.equal(render().states.at(-1), 'Activity');
      if (status === 'disconnected') transport.emit('disconnected', 'Codex disconnected');
      else emit('turn/completed', { turn: { id: 'turn', status, items: [] } });
      const result = render();
      assert.equal(result.states.at(-1), label);
      assert.equal(result.spinners, 0); assert.equal(result.stop, false); assert.equal(result.previews, 0);
    });
  }
});

test('the dock shows work before any activity arrives and while an answer streams', t => {
  const { ui, c, session, item, working, render } = setup(); t.after(() => ui.close());
  c.items = [];
  assert.ok(working());
  assert.deepEqual(render(), { states: [], spinners: 1, stop: true, previews: 0 });
  item('answer', 'agentMessage', { phase: 'final_answer', text: 'A streaming answer' }, false);
  assert.ok(working());
  (session.caps as { reduceMotion: boolean }).reduceMotion = true;
  assert.equal(nodes(working()!).filter(n => n.kind === 'shimmer').length, 0);
  c.activeTurn = null;
  assert.equal(working(), undefined);
});
