import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, Surface } from '@stencil-hq/tern';
import { Controller } from '../src/controller';
import { Preferences } from '../src/preferences';
import { NativeUI } from '../src/ui';
import type { CodexRpc } from '../src/rpc';

async function directory(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-preferences-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function setup(path?: string, cwd = tmpdir()) {
  let seq = 0;
  const calls: { method: string; params: any }[] = [];
  const rpc = Object.assign(new EventEmitter(), { start: async () => {},
    request: async (method: string, params: any): Promise<any> => {
      calls.push({ method, params });
      if (method === 'model/list') return { data: ['server-model', 'chosen-model'].map(model => ({ model, displayName: model, hidden: false })) };
      if (method === 'account/read') return { account: { type: 'test' } };
      if (method === 'thread/start' || method === 'thread/resume') return {
        thread: { id: params.threadId ?? `thread-${++seq}`, cwd, name: 'Session' }, cwd,
        model: params.model ?? 'server-model', reasoningEffort: 'high',
      };
      return { data: [], nextCursor: null };
    },
  });
  return { c: new Controller(rpc as unknown as CodexRpc, cwd, new Preferences(path)), calls };
}

test('saved defaults survive restart and reach only new sessions, including another workspace', async t => {
  const dir = await directory(t), path = join(dir, 'preferences.json');
  const { c, calls } = setup(path);
  await c.connect();
  assert.equal(c.model, 'server-model');
  const original = c.thread!.id;
  c.activeTurn = 'running'; c.queue.push({ id: 'q', text: 'Keep working', images: [] });
  await c.setNewSessionModel('chosen-model');
  assert.equal(c.model, 'server-model'); assert.equal(c.activeTurn, 'running');
  assert.equal(c.queue.length, 1);
  assert.deepEqual(calls.filter(x => x.method === 'turn/interrupt'), []);
  await c.newThread(); assert.equal(c.model, 'chosen-model');
  assert.equal(calls.filter(x => x.method === 'thread/start').at(-1)!.params.model, 'chosen-model');
  await c.resume(original); assert.equal(c.model, 'server-model'); assert.equal(c.activeTurn, 'running');
  const other = setup(path, dir); await other.c.connect(); assert.equal(other.c.model, 'chosen-model');
  await other.c.setNewSessionModel();
  await c.newThread(); assert.equal(c.model, 'server-model');
  assert.equal('model' in calls.filter(x => x.method === 'thread/start').at(-1)!.params, false);
});

test('explicit resume keeps its model even with a different saved default', async t => {
  const path = join(await directory(t), 'preferences.json');
  await new Preferences(path).setModel('chosen-model');
  const { c, calls } = setup(path); await c.connect('existing');
  assert.equal(c.model, 'server-model'); assert.equal(c.newSessionModel, 'chosen-model');
  assert.equal(calls.some(x => x.method === 'thread/start'), false);
  assert.equal('model' in calls.find(x => x.method === 'thread/resume')!.params, false);
});

test('failed saves and invalid model choices preserve the previous preference', async t => {
  const dir = await directory(t), path = join(dir, 'settings', 'preferences.json');
  const { c } = setup(path); await c.connect(); await c.setNewSessionModel('chosen-model');
  const original = await readFile(path, 'utf8');
  await assert.rejects(c.setNewSessionModel('missing-model'), /available model/);
  assert.equal(await readFile(path, 'utf8'), original);
  await rm(join(dir, 'settings'), { recursive: true }); await writeFile(join(dir, 'settings'), 'block writes');
  await assert.rejects(c.setNewSessionModel()); assert.equal(c.newSessionModel, 'chosen-model');
});

test('unavailable defaults leave the selected session intact and report how to fix them', async t => {
  const path = join(await directory(t), 'preferences.json');
  const { c, calls } = setup(path); await c.connect(); const id = c.thread!.id;
  await new Preferences(path).setModel('removed-model');
  await assert.rejects(c.newThread(), /New session model/);
  assert.equal(c.thread!.id, id); assert.equal(c.selecting, false);
  assert.equal(calls.filter(x => x.method === 'thread/start').length, 1);
});

test('workspace keeps the typed path when choosing a default, and keeps an invalid folder editable', async t => {
  const { c } = setup(); await c.connect();
  const ui = new NativeUI(c, { close: async () => {} } as unknown as Session,
    { closed: true, stylesheet() {}, focus() {} } as unknown as Surface);
  t.after(() => ui.close());
  const controls = ui as any;
  controls.openPanel('workspace');
  const path = join(await directory(t), 'missing-folder');
  ui.dialogDraft.set(path); const draft = ui.dialogDraft;
  controls.openModelPicker('default-model'); await controls.saveDefaultModel('chosen-model');
  assert.equal(ui.panel, 'workspace'); assert.equal(ui.dialogDraft, draft); assert.equal(ui.dialogDraft.text, path);
  await controls.confirmPath();
  assert.equal(ui.panel, 'workspace'); assert.match(controls.workspaceError, /existing folder/);
  assert.equal(ui.dialogDraft.text, path); assert.equal(c.model, 'server-model');
});
