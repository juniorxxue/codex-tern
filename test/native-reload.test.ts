import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import type { Node, Session, Surface } from '@stencil-hq/tern';
import { Controller } from '../src/controller';
import { NativeUI, UI_API_VERSION } from '../src/ui';
import { NativeHost, loadNativeUI, type UIModule, type UILoader } from '../src/native-host';
import { RpcOutcomeUnknown, type CodexRpc } from '../src/rpc';

const module = { NativeUI, UI_API_VERSION };
const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(load: UILoader = async () => module) {
  const calls: string[] = [], frames: { main: Node; dock: Node }[] = [];
  let sessionClosed = 0, seq = 0;
  const transport = Object.assign(new EventEmitter(), {
    request: async (method: string): Promise<any> => {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: `thread-${++seq}`, cwd: '/tmp' }, cwd: '/tmp' };
      throw new Error(`Unexpected RPC: ${method}`);
    },
  });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp');
  c.connection = 'ready'; c.notifications = false; await c.newThread();
  const session = { caps: { cols: 100, cell: { w: 8 }, kinds: [], features: [] }, blob: () => 'test-blob',
    close: async () => { sessionClosed++; } } as unknown as Session;
  const surface = { closed: false, stylesheet: () => {}, focus: () => {},
    render: (frame: typeof frames[number]) => { frames.push(frame); } } as unknown as Surface;
  const host = new NativeHost(c, session, surface, module, load);
  const emit = (method: string, params: object, threadId = c.thread!.id) => transport.emit('notification', {
    method, params: { threadId, ...params },
  });
  const render = () => { host.current.render(); return nodes(frames.at(-1)!.main).concat(nodes(frames.at(-1)!.dock)); };
  return { host, c, transport, calls, emit, render, closed: () => sessionClosed };
}

test('reload retains active and background turns, questions, queues, drafts and editor undo', async t => {
  const { host, c, calls, emit, render, closed } = await setup(); t.after(() => host.close());
  host.current.draft.set('Background draft'); render();
  emit('turn/started', { turn: { id: 'background', status: 'inProgress', items: [] } });
  await host.newSession();
  host.current.draft.set('Original'); host.current.draft.set('Current draft');
  const draft = host.current.draft;
  emit('turn/started', { turn: { id: 'running', status: 'inProgress', items: [] } });
  emit('item/started', { turnId: 'running', item: { id: 'reasoning', type: 'reasoning', summary: [] } });
  c.requests.push({ id: 10, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-2', turnId: 'running', questions: [{ id: 'q', question: 'Choose', options: [{ label: 'Keep' }] }],
  }, answers: { q: ['Keep'] } });
  c.queue.push({ id: 'queued', text: 'Next message', images: [] });
  host.current.sendMode = 'queue';
  const listeners = [c.listenerCount('change'), c.listenerCount('completion')];
  const requests = c.requests, queue = c.queue, items = c.items;
  for (let n = 1; n <= 3; n++) {
    const old = host.current;
    await host.reload();
    assert.notEqual(host.current, old); assert.equal(host.current.generation, n);
    assert.equal(host.current.draft, draft); assert.equal(host.current.sendMode, 'queue');
    assert.equal(c.activeTurn, 'running'); assert.equal(c.sessionStatus('thread-1').running, true);
    assert.equal(c.requests, requests); assert.equal(c.queue, queue); assert.equal(c.items, items);
    assert.deepEqual([c.listenerCount('change'), c.listenerCount('completion')], listeners);
    assert.ok(render().some(node => node.props.role === 'ct.activity.state' && node.props.text === 'Needs input'));
    assert.ok(render().some(node => node.props.role === 'omp.composer.stop'));
    assert.equal(closed(), 0);
  }
  host.current.draft.undo(); assert.equal(host.current.draft.text, 'Original');
  await host.openSession('thread-1'); assert.equal(host.current.draft.text, 'Background draft');
  assert.deepEqual(calls, ['thread/start', 'thread/start'], 'reload never reconnects, resumes or replays input');
});

test('concurrent reloads coalesce and retain typing and events received during loading', async t => {
  const loading = deferred<UIModule>(); let loads = 0;
  const { host, emit, c } = await setup(() => { loads++; return loading.promise; }); t.after(() => host.close());
  const first = host.reload(), second = host.reload(); assert.equal(first, second);
  host.current.draft.set('Typed during reload');
  emit('turn/started', { turn: { id: 'new-turn', status: 'inProgress', items: [] } });
  loading.resolve(module); await first;
  assert.equal(loads, 1); assert.equal(host.current.draft.text, 'Typed during reload'); assert.equal(c.activeTurn, 'new-turn');
});

test('broken imports, incompatible updates and render failures leave the old UI usable', async t => {
  class BrokenUI extends NativeUI { override render() { throw new Error('Broken renderer'); } }
  for (const load of [async () => { throw new Error('Missing build'); },
    async () => ({ ...module, UI_API_VERSION: 2 }), async () => ({ ...module, NativeUI: BrokenUI })]) {
    const { host, c, render, closed } = await setup(load); t.after(() => host.close());
    host.current.draft.set('Keep me'); const old = host.current;
    const listeners = c.listenerCount('change');
    await assert.rejects(host.reload());
    assert.equal(host.current, old); assert.equal(host.current.draft.text, 'Keep me');
    assert.equal(closed(), 0); assert.equal(c.listenerCount('change'), listeners);
    assert.ok(render().length > 0);
  }
});

test('reload rechecks pending input and cannot replace a closed window', async t => {
  for (const close of [false, true]) {
    const loading = deferred<UIModule>();
    const { host, c, closed } = await setup(() => loading.promise); t.after(() => host.close());
    const old = host.current, reloading = host.reload();
    if (close) await host.close(); else c.operation = 'Sending…';
    loading.resolve(module);
    await assert.rejects(reloading, close ? /closed/ : /current input/);
    assert.equal(host.current, old); assert.equal(closed(), close ? 1 : 0);
    c.operation = '';
  }
});

test('new built modules actually load, share SDK nodes and recognize uncertain sends from the retained backend', async t => {
  const root = resolve(import.meta.dirname, '..');
  await mkdir(join(root, '.prototype'), { recursive: true });
  const dir = await mkdtemp(join(root, '.prototype/reload-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const built = await build({ absWorkingDir: root, entryPoints: ['src/ui.tsx'], outfile: 'ui.mjs', write: false,
    bundle: true, platform: 'node', format: 'esm', target: 'es2023', jsx: 'automatic', jsxImportSource: '@stencil-hq/tern',
    external: ['@stencil-hq/tern', '@stencil-hq/tern/*', '@oh-my-pi/*', 'bun', 'bun:*'] });
  const manifest = pathToFileURL(join(dir, 'ui.json'));
  const publish = async (version: number) => {
    const text = built.outputFiles[0]!.text + `\nexport const testVersion = ${version};\n`;
    const file = `ui-${createHash('sha256').update(text).digest('hex')}.mjs`;
    await writeFile(join(dir, file), text); await writeFile(manifest, JSON.stringify({ file }));
  };
  await publish(1);
  const first = await loadNativeUI(manifest);
  await publish(2);
  const { host, c, transport, render } = await setup(() => loadNativeUI(manifest)); t.after(() => host.close());
  await host.reload();
  assert.notEqual(host.current.constructor, first.NativeUI);
  const { View } = await import('@stencil-hq/tern');
  // Reconcile with the same SDK used by the stable terminal connection.
  assert.doesNotThrow(() => View.from({ main: render()[0] }));
  host.current.draft.set('Possibly sent');
  transport.request = async () => { throw new RpcOutcomeUnknown('turn/start', 1, 'Reply lost'); };
  await host.current.send();
  assert.equal(c.unconfirmed.length, 1); assert.equal(c.queue.length, 0); assert.equal(host.current.draft.text, '');
  await writeFile(manifest, JSON.stringify({ file: '../outside.mjs' }));
  await assert.rejects(loadNativeUI(manifest), /Invalid interface/);
});
