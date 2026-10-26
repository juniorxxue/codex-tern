import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Controller } from '../src/controller';
import { FolderSessions } from '../src/folder-sessions';
import type { CodexRpc } from '../src/rpc';

class Transport extends EventEmitter {
  calls: any[] = [];
  owned = new Set<string>();
  ownsThread(id: string) { return this.owned.has(id); }
  handler: (params: any) => Promise<any> = async () => ({ data: [], nextCursor: null });
  request(method: string, params: any) { this.calls.push({ method, params }); return this.handler(params); }
}
const thread = (id: string, cwd = '/tmp/project', recencyAt = id.endsWith('current') ? 1792558900 : 1792558800) =>
  ({ id, cwd, name: id, preview: '', updatedAt: 1792558800, recencyAt }) as any;
function setup() {
  const rpc = new Transport();
  const c = new Controller(rpc as unknown as CodexRpc, '/tmp/project');
  c.connection = 'ready'; c.thread = thread('current');
  let changes = 0;
  const list = new FolderSessions(c, () => changes++);
  return { rpc, c, list, changes: () => changes };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('empty sessions stay out of history across refreshes; accepted first input adds the current session', async () => {
  const { rpc, c, list } = setup();
  const empty = { ...thread('empty'), name: null, preview: '' };
  c.thread = empty; c.changed();
  rpc.handler = async () => ({ data: [empty, { ...empty, id: 'other-empty' }, thread('saved')], nextCursor: null });
  await list.refresh(); await list.refresh();
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['saved']);
  rpc.handler = async () => ({ turn: { id: 'first-turn' } });
  await c.submit('First question 中文');
  assert.equal(list.snapshot.rows.find(t => t.id === 'empty')?.title, 'First question 中文');
  list.dispose();
});

test('folder list stays scoped, coalesces reads, formats time and includes the unsaved current session', async () => {
  const { rpc, list } = setup();
  rpc.handler = async () => ({ data: [thread('saved'), thread('other', '/tmp/project/subfolder')], nextCursor: null });
  await Promise.all([list.refresh(), list.refresh()]);
  assert.equal(rpc.calls.length, 2);
  assert.equal(rpc.calls[0].params.useStateDbOnly, true);
  assert.equal(rpc.calls[1].params.useStateDbOnly, undefined);
  assert.equal(rpc.calls[0].params.cwd, '/tmp/project');
  assert.equal(rpc.calls[0].params.sortKey, 'recency_at');
  assert.equal(rpc.calls[0].params.sortDirection, 'desc');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'saved']);
  assert.match(list.snapshot.rows[1].time, /\d{2}:\d{2}/);
  assert.equal(list.contains('other'), false);
  list.dispose();
});

test('pagination preserves earlier rows, removes duplicates and passes the backend cursor', async () => {
  const { rpc, list } = setup();
  rpc.handler = async p => p.cursor
    ? { data: [thread('first'), thread('second')], nextCursor: null }
    : { data: [thread('first')], nextCursor: 'next-page' };
  await list.refresh(); await list.refresh(true);
  assert.equal(rpc.calls[2].params.cursor, 'next-page');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'first', 'second']);
  assert.equal(list.snapshot.more, false);
  await list.refresh(true); assert.equal(rpc.calls.length, 3);
  await list.refresh();
  assert.equal(rpc.calls.length, 5);
  assert.equal(rpc.calls[4].params.cursor, 'next-page');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'first', 'second']);
  list.dispose();
});

test('late responses from another folder cannot overwrite the new folder or its loading state', async () => {
  const { rpc, c, list } = setup();
  const replies = new Map<string, (page: any) => void>();
  rpc.handler = p => new Promise(resolve => replies.set(p.cwd, resolve));
  const old = list.refresh(); await tick();
  c.cwd = '/tmp/other'; c.thread = thread('new-current', c.cwd); c.changed(); await tick();
  replies.get('/tmp/other')!({ data: [thread('new-saved', c.cwd)], nextCursor: null }); await tick();
  replies.get('/tmp/project')!({ data: [thread('old-saved')], nextCursor: 'old-cursor' }); await old;
  assert.equal(list.snapshot.cwd, '/tmp/other');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['new-current', 'new-saved']);
  assert.equal(list.snapshot.loading, false); assert.equal(list.snapshot.more, false);
  list.dispose();
});

test('failures retain the last list; streaming does not repeatedly reload; idle completion refreshes', async () => {
  const { rpc, c, list } = setup();
  rpc.handler = async () => ({ data: [thread('saved')], nextCursor: null });
  await list.refresh();
  c.activeTurn = 'working'; c.changed(); c.changed(); c.changed(); await tick();
  assert.equal(rpc.calls.length, 2); assert.equal(list.snapshot.canSwitch, true);
  c.activeTurn = null; c.sessionsVersion++; c.changed(); await tick(); assert.equal(rpc.calls.length, 3);
  rpc.handler = async () => { throw new Error('List unavailable'); };
  await list.refresh();
  assert.equal(list.snapshot.error, 'List unavailable');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'saved']);
  c.queue.push({ id: 'q', text: 'next', images: [] }); c.changed();
  assert.equal(list.snapshot.canSwitch, true);
  list.hide(); c.thread = thread('another'); c.changed(); await tick();
  assert.equal(rpc.calls.length, 4);
  list.dispose();
});

test('disconnects disable switching and disposal ignores pending responses', async () => {
  const { rpc, c, list, changes } = setup();
  let reply!: (page: any) => void;
  rpc.handler = () => new Promise(resolve => { reply = resolve; });
  const pending = list.refresh(); await tick();
  c.connection = 'disconnected'; c.changed();
  assert.equal(list.snapshot.connected, false); assert.equal(list.snapshot.canSwitch, false);
  list.dispose(); const count = changes();
  reply({ data: [thread('late')], nextCursor: null }); await pending;
  assert.equal(changes(), count); assert.equal(list.contains('late'), false);
});

test('opening history does not change activity order; real activity reorders existing rows on refresh', async () => {
  const { rpc, c, list } = setup();
  let rows = [thread('current'), thread('first', '/tmp/project', 1792558810), thread('second')];
  rpc.handler = async () => ({ data: rows, nextCursor: null });
  await list.refresh();
  c.operation = 'Resuming session…'; c.changed();
  c.thread = thread('second'); c.changed();
  c.operation = ''; c.changed(); await tick();
  assert.equal(rpc.calls.length, 2, 'selection never re-lists sessions');
  assert.equal(list.snapshot.current, 'second');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'first', 'second']);
  rows = [{ ...thread('second'), updatedAt: 1792559999 }, thread('current'), thread('first', '/tmp/project', 1792558810)];
  await list.refresh();
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'first', 'second']);
  assert.equal(list.snapshot.rows[2].updatedAt, 1792559999, 'metadata still refreshes');
  rows = [thread('new', '/tmp/project', 1792559100), thread('second', '/tmp/project', 1792559000), thread('current'), thread('first')];
  await list.refresh();
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['new', 'second', 'current', 'first']);
  list.dispose();
});

test('an old selected conversation is not pinned; discovering older history does not put it first', async () => {
  const { rpc, c, list } = setup();
  c.thread = thread('old-selected', '/tmp/project', 100); c.changed();
  rpc.handler = async () => ({ data: [thread('recent', '/tmp/project', 300), thread('old-selected', '/tmp/project', 100)], nextCursor: null });
  await list.refresh();
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['recent', 'old-selected']);
  rpc.handler = async () => ({ data: [thread('recent', '/tmp/project', 300), thread('old-selected', '/tmp/project', 100), thread('newly-found-old', '/tmp/project', 50)], nextCursor: null });
  await list.refresh();
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['recent', 'old-selected', 'newly-found-old']);
  list.dispose();
});

test('pagination sorts by activity, deduplicates rows, and follows backend ties on refresh', async () => {
  const { rpc, list } = setup();
  rpc.handler = async p => p.cursor
    ? { data: [thread('new', '/tmp/project', 1792559000), thread('older', '/tmp/project', 1792558700)], nextCursor: null }
    : { data: [thread('new', '/tmp/project', 1792559000), thread('current')], nextCursor: 'page2' };
  await list.refresh(); await list.refresh(true);
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['new', 'current', 'older']);
  rpc.handler = async () => ({ data: [thread('tie-b'), thread('tie-a'), thread('current', '/tmp/project', 1792558800)], nextCursor: null });
  await list.refresh();
  // The selected thread retains its newer known activity timestamp.
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'tie-b', 'tie-a']);
  list.dispose();
});

test('accepted input moves a loaded session first while merely queueing input does not', async () => {
  const { rpc, c, list } = setup();
  rpc.handler = async () => ({ data: [thread('recent', '/tmp/project', 1792559000), thread('current')], nextCursor: null });
  await list.refresh(); list.hide();
  rpc.handler = async () => ({ turn: { id: 'accepted' } });
  await c.submit('A new message');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'recent']);
  const at = c.thread!.recencyAt;
  await c.submit('Queued locally', [], 'queue');
  assert.equal(c.thread!.recencyAt, at);
  list.dispose();
});

test('background completion updates order even while the selected session is running', async () => {
  const { rpc, c, list } = setup();
  rpc.handler = async () => ({ data: [thread('current'), thread('background')], nextCursor: null });
  await list.refresh();
  c.activeTurn = 'foreground-turn';
  // Register a background conversation through the normal request routing.
  rpc.emit('request', { id: 'pending', method: 'item/tool/requestUserInput', params: { threadId: 'background', turnId: 'background-turn', questions: [] } });
  rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'background', turn: { id: 'background-turn', status: 'completed', completedAt: 1792559200 } } });
  await tick();
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['background', 'current']);
  assert.equal(rpc.calls.filter(x => x.method === 'thread/list').length, 3);
  assert.equal(c.activeTurn, 'foreground-turn');
  list.dispose();
});

test('missing recency metadata falls back to update time', async () => {
  const { rpc, list } = setup();
  rpc.handler = async () => ({ data: [{ ...thread('new'), recencyAt: null, updatedAt: 1792559100 }, thread('current')], nextCursor: null });
  await list.refresh();
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['new', 'current']);
  list.dispose();
});

test('owned background sessions stay selectable after stale lock and conflict results', async () => {
  const { rpc, c } = setup();
  const locks = deferred<Set<string>>();
  const list = new FolderSessions(c, () => {}, () => locks.promise);
  rpc.handler = async () => ({ data: [thread('background'), thread('external')], nextCursor: null });
  const pending = list.refresh(); await tick();
  rpc.owned.add('background');
  locks.resolve(new Set(['background', 'external'])); await pending;
  assert.equal(list.snapshot.rows.find(t => t.id === 'background')?.locked, false);
  assert.equal(list.snapshot.rows.find(t => t.id === 'external')?.locked, true);
  list.markLocked('background');
  assert.equal(list.isLocked('background'), false, 'an old conflict cannot disable a thread now owned by this app');
  assert.equal(list.isLocked('external'), true, 'external writers still stay protected');
  list.dispose();
});

test('indexed rows and writer locks appear before background repair finishes', async () => {
  const { rpc, c, list: unused } = setup(); unused.dispose();
  const repair = deferred();
  const list = new FolderSessions(c, () => {}, async () => new Set(['saved']));
  rpc.handler = async p => p.useStateDbOnly
    ? { data: [{ ...thread('saved'), name: 'Cached title' }], nextCursor: null } : repair.promise;
  const pending = list.refresh(); await tick();
  assert.equal(list.refresh(), pending, 'refreshes coalesce through both phases');
  assert.equal(list.snapshot.rows.find(t => t.id === 'saved')?.title, 'Cached title');
  assert.equal(list.snapshot.rows.find(t => t.id === 'saved')?.locked, true);
  assert.equal(list.snapshot.loading, false);
  assert.equal(list.snapshot.canSwitch, true);
  repair.resolve({ data: [{ ...thread('saved'), name: 'Repaired title' }, thread('discovered')], nextCursor: null });
  await pending;
  assert.equal(list.snapshot.rows.find(t => t.id === 'saved')?.title, 'Repaired title');
  assert.equal(list.contains('discovered'), true);
  assert.equal(rpc.calls.length, 2);
  list.dispose();
});

test('missing or unsupported indexes fall back to repair without reporting an empty folder early', async () => {
  for (const unsupported of [false, true]) {
    const { rpc, c, list } = setup();
    c.thread = { ...thread('blank'), name: '', preview: '' }; c.changed();
    const repair = deferred();
    rpc.handler = async p => {
      if (!p.useStateDbOnly) return repair.promise;
      if (unsupported) throw new Error('Unknown field useStateDbOnly');
      return { data: [], nextCursor: null };
    };
    const pending = list.refresh(); await tick();
    assert.equal(list.snapshot.loading, true);
    assert.equal(list.snapshot.error, '');
    repair.resolve({ data: [thread('discovered')], nextCursor: null }); await pending;
    assert.deepEqual(list.snapshot.rows.map(t => t.id), ['discovered']);
    assert.equal(list.snapshot.loading, false);
    assert.equal(list.snapshot.error, '');
    list.dispose();
  }
});

test('pagination during repair is coalesced and uses the repaired cursor without dropping earlier rows', async () => {
  const { rpc, list } = setup();
  const repair = deferred();
  rpc.handler = async p => p.cursor ? { data: [thread('first'), thread('older')], nextCursor: null }
    : p.useStateDbOnly ? { data: [thread('first')], nextCursor: 'cached-cursor' } : repair.promise;
  const pending = list.refresh(); await tick();
  const more = list.refresh(true);
  assert.equal(list.refresh(true), more);
  assert.equal(rpc.calls.length, 2, 'pagination waits for the repaired cursor');
  repair.resolve({ data: [thread('first'), thread('added')], nextCursor: 'repaired-cursor' });
  await Promise.all([pending, more]);
  assert.equal(rpc.calls.length, 3);
  assert.equal(rpc.calls[2].params.cursor, 'repaired-cursor');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'first', 'added', 'older']);
  list.dispose();
});

test('queued pagination survives a refresh starting as repair finishes', async () => {
  const { rpc, list } = setup();
  const repair = deferred();
  rpc.handler = async p => p.cursor ? { data: [thread('older')], nextCursor: null }
    : p.useStateDbOnly ? { data: [thread('first')], nextCursor: 'next' } : repair.promise;
  const pending = list.refresh(); await tick();
  const refreshed = pending.then(() => list.refresh());
  const more = list.refresh(true);
  repair.resolve({ data: [thread('first')], nextCursor: 'next' });
  await Promise.all([refreshed, more]);
  assert.equal(list.contains('older'), true);
  assert.equal(rpc.calls.filter(call => call.params.cursor).length, 1);
  list.dispose();
});

test('late repairs and queued pagination cannot change a new folder, disconnected or disposed list', async () => {
  for (const action of ['folder', 'disconnect', 'dispose']) {
    const { rpc, c, list, changes } = setup();
    const repair = deferred();
    rpc.handler = async p => p.cwd !== '/tmp/project'
      ? { data: [thread('new-saved', p.cwd)], nextCursor: null }
      : p.useStateDbOnly ? { data: [thread('old-saved')], nextCursor: 'old-cursor' } : repair.promise;
    const pending = list.refresh(); await tick();
    const more = list.refresh(true);
    if (action === 'dispose') list.dispose();
    else if (action === 'disconnect') { c.connection = 'disconnected'; c.changed(); }
    else { c.cwd = '/tmp/other'; c.thread = thread('new-current', c.cwd); c.changed(); await tick(); }
    const before = list.snapshot, count = changes();
    repair.resolve({ data: [thread('stale')], nextCursor: 'stale-cursor' });
    await Promise.all([pending, more]);
    assert.deepEqual(list.snapshot, before);
    assert.equal(changes(), count);
    assert.equal(rpc.calls.some(call => call.params.cursor), false);
    list.dispose();
  }
});

test('repair failure retains the usable indexed list and lets a later refresh recover', async () => {
  const { rpc, list } = setup();
  rpc.handler = async p => {
    if (p.useStateDbOnly) return { data: [thread('saved')], nextCursor: null };
    throw new Error('Repair unavailable');
  };
  await list.refresh();
  assert.equal(list.contains('saved'), true);
  assert.equal(list.snapshot.canSwitch, true);
  assert.equal(list.snapshot.loading, false);
  assert.equal(list.snapshot.error, 'Repair unavailable');
  rpc.handler = async () => ({ data: [thread('recovered')], nextCursor: null });
  await list.refresh();
  assert.equal(list.snapshot.error, '');
  assert.deepEqual(list.snapshot.rows.map(t => t.id), ['current', 'recovered']);
  list.dispose();
});
