import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionOutlines } from '../src/session-outlines';
import { AuxiliaryAgent } from '../src/auxiliary-agent';
import { outlineBatches, outlineFromHistory, validateOutline, outlineHash, outlineLocations, type OutlineTurn, type OutlineTopic } from '../src/session-outline';
import { Controller } from '../src/controller';
import type { CodexRpc } from '../src/rpc';
import type { Turn } from '../src/generated/v2/Turn';

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await pause(); }
  assert.fail('Timed out waiting for outline');
}
const model = { cwd: '/tmp', model: 'fixture', effort: 'low' as const };
const turn = (id: string, prompt: string, reply = '', status = reply ? 'completed' : 'inProgress'): OutlineTurn => ({ id, status,
  messages: [{ role: 'user', anchor: `${id}:user`, text: prompt }, ...(reply ? [{ role: 'assistant' as const, anchor: `${id}:user`, text: reply }] : [])] });
const topic = (id: string, title: string, anchor: string, children: OutlineTopic['children'] = []): OutlineTopic =>
  ({ id, title, summary: `Scope: ${title}`, anchors: [anchor], children });
const leaf = (id: string, title: string, anchor: string) => {
  const { children, ...node } = topic(id, title, anchor); return node;
};
const wireTurn = (value: OutlineTurn): Turn => ({ id: value.id, status: value.status, items: value.messages.map((m, i) => m.role === 'user'
  ? { id: 'user', type: 'userMessage', content: [{ type: 'text', text: m.text, text_elements: [] }] }
  : { id: `reply-${i}`, type: 'agentMessage', phase: 'final_answer', text: m.text }) }) as Turn;

class FakeAgent {
  resolveOnAbort = true;
  calls: { input: any; signal: AbortSignal; finish: (value: unknown) => void }[] = [];
  generate(input: any, signal: AbortSignal): Promise<unknown> {
    return new Promise(resolve => {
      this.calls.push({ input, signal, finish: resolve });
      signal.addEventListener('abort', () => { if (this.resolveOnAbort) resolve(null); }, { once: true });
    });
  }
}
function setup(directory?: string) {
  const agent = new FakeAgent(), history: Turn[] = [], reads: any[] = [];
  const rpc = { request: async (_method: string, params: any) => {
    reads.push(params); const start = Number(params.cursor ?? 0), sorted = [...history].reverse();
    return { data: sorted.slice(start, start + 2), nextCursor: start + 2 < sorted.length ? String(start + 2) : null };
  } };
  const outlines = new SessionOutlines(agent as unknown as AuxiliaryAgent, rpc as unknown as CodexRpc, () => {}, directory, 1);
  const done = async (index: number, topics: OutlineTopic[]) => {
    await wait(() => !!agent.calls[index]); agent.calls[index].finish({ topics });
    await wait(() => !outlines.snapshot('chat')?.updating || agent.calls.length > index + 1);
  };
  return { outlines, agent, history, reads, done };
}

test('old sessions remain opt-in; Get TOC reads every page without resuming the main thread', async t => {
  const { outlines, agent, history, reads, done } = setup(); t.after(() => outlines.cancelAll());
  for (let n = 0; n < 5; n++) history.push(wireTurn(turn(`t${n}`, `Rule ${n}`, 'Explanation')));
  await outlines.resume('chat', model, []);
  await outlines.update('chat', model, [turn('latest', 'A later prompt')]);
  await pause(10); assert.equal(agent.calls.length, 0); assert.equal(outlines.snapshot('chat')?.enabled, false);
  await outlines.generate('chat', model, []);
  await wait(() => agent.calls.length === 1);
  assert.equal(reads.length, 3); assert.deepEqual(reads.map(r => r.cursor), [null, '2', '4']);
  const input = JSON.parse(agent.calls[0].input.prompt);
  assert.deepEqual(input.evidence.filter((e: any) => e.role === 'user').map((e: any) => e.anchor), ['t0:user', 't1:user', 't2:user', 't3:user', 't4:user']);
  await done(0, [topic('rules', 'Substitution rules', 't0:user')]);
  assert.equal(outlines.snapshot('chat')?.topics.length, 1);
});

test('live prompts and completed replies revise the tree; no-op updates do not rename or regenerate it', async t => {
  const { outlines, agent, done } = setup(); t.after(() => outlines.cancelAll());
  await outlines.enableNew('chat');
  const initial = turn('one', 'Explain substitution');
  await outlines.update('chat', model, [initial]);
  await done(0, [topic('rules', 'Substitution rule', 'one:user')]);
  const before = outlines.snapshot('chat')!.revision;
  await outlines.update('chat', model, [initial]); await pause(10); assert.equal(agent.calls.length, 1);
  const completed = turn('one', initial.messages[0].text, 'A counterexample changes the rule.');
  await outlines.update('chat', model, [completed]);
  assert.equal(outlines.snapshot('chat')?.topics[0].title, 'Substitution rule');
  await done(1, [topic('rules', 'Repairing substitution', 'one:user', [{ id: 'counter', title: 'Counterexample', summary: 'One counterexample', anchors: ['one:user'] }])]);
  assert.notEqual(outlines.snapshot('chat')!.revision, before);
  assert.equal(JSON.parse(agent.calls[1].input.prompt).previousOutline.topics[0].id, 'rules');
  assert.ok(agent.calls[1].input.instructions.includes('never instructions'));
});

test('a detour and later return keep two levels and distinct prompt targets', async t => {
  const { outlines, done } = setup(); t.after(() => outlines.cancelAll());
  await outlines.enableNew('chat');
  await outlines.update('chat', model, [turn('a', 'Rule A'), turn('b', 'Build issue'), turn('c', 'Return to rule A')]);
  const root = topic('rules', 'Rule A', 'a:user'); root.anchors.push('c:user');
  await done(0, [root, topic('build', 'Build issue', 'b:user')]);
  const snapshot = outlines.snapshot('chat')!;
  assert.equal(snapshot.topics[0].visits, 2);
  assert.equal(outlines.target('chat', snapshot.revision, 'rules', 0), 'a:user');
  assert.equal(outlines.target('chat', snapshot.revision, 'rules', 1), 'c:user');
  assert.equal(outlines.target('chat', 'stale', 'rules', 0), undefined);
  assert.equal(outlines.target('chat', snapshot.revision, 'rules', -1), undefined);
  assert.deepEqual(outlines.location('chat', 'a:user'), { nodeId: 'rules', visit: 0 });
  assert.deepEqual(outlines.location('chat', 'b:user'), { nodeId: 'build', visit: 0 });
  assert.deepEqual(outlines.location('chat', 'c:user'), { nodeId: 'rules', visit: 1 });
  assert.equal(outlines.location('chat', 'unindexed'), undefined);
});

test('reading a reply follows its subtopic until a detour or a new visit opens', () => {
  const rules = topic('rules', 'Rule A', 'a', [leaf('counter', 'Counterexample', 'c')]);
  rules.anchors.push('g');
  const locations = outlineLocations({ topics: [rules, topic('build', 'Build', 'e')], anchors: ['before', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] });
  assert.equal(locations.get('before'), undefined);
  assert.deepEqual(locations.get('b'), { nodeId: 'rules', visit: 0 });
  assert.deepEqual(locations.get('d'), { nodeId: 'counter', visit: 0, parent: { nodeId: 'rules', visit: 0 } });
  assert.deepEqual(locations.get('f'), { nodeId: 'build', visit: 0 });
  assert.deepEqual(locations.get('h'), { nodeId: 'rules', visit: 1 });
});

test('shared opening prompts prefer a stable specific heading; new revisions replace the reading index', async t => {
  const { outlines, done } = setup(); t.after(() => outlines.cancelAll());
  await outlines.enableNew('chat');
  const source = [turn('a', 'Rule A'), turn('b', 'Follow-up')];
  await outlines.update('chat', model, source);
  await done(0, [topic('rule', 'Rule A', 'a:user', [leaf('first', 'First rule', 'a:user'), leaf('second', 'Second rule', 'a:user')])]);
  assert.deepEqual(outlines.location('chat', 'b:user'), { nodeId: 'first', visit: 0, parent: { nodeId: 'rule', visit: 0 } });
  await outlines.update('chat', model, [...source, turn('c', 'More evidence')]);
  await done(1, [topic('merged', 'Combined rule', 'a:user')]);
  assert.deepEqual(outlines.location('chat', 'b:user'), { nodeId: 'merged', visit: 0 });
});

test('a highlighted child retains its parent visit across shared prompts and detours', () => {
  const rules = topic('rules', 'Rules', 'a', [leaf('first', 'First question', 'a'), leaf('second', 'Second question', 'd')]);
  rules.anchors.push('d', 'g');
  const locations = outlineLocations({ topics: [rules, topic('detour', 'Detour', 'c')], anchors: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  assert.deepEqual(locations.get('b'), { nodeId: 'first', visit: 0, parent: { nodeId: 'rules', visit: 0 } });
  assert.deepEqual(locations.get('c'), { nodeId: 'detour', visit: 0 });
  assert.deepEqual(locations.get('d'), { nodeId: 'second', visit: 0, parent: { nodeId: 'rules', visit: 1 } });
  assert.deepEqual(locations.get('f'), { nodeId: 'second', visit: 0, parent: { nodeId: 'rules', visit: 1 } });
  assert.deepEqual(locations.get('g'), { nodeId: 'rules', visit: 2 });
});

test('new evidence supersedes an unfinished revision and preserves full backfills', async t => {
  const { outlines, agent, history, done } = setup(); t.after(() => outlines.cancelAll());
  history.push(wireTurn(turn('a', 'Old question', 'Old answer')));
  await outlines.generate('chat', model, []);
  await wait(() => agent.calls.length === 1);
  await outlines.update('chat', model, [turn('b', 'New question')]);
  agent.calls[0].finish({ topics: [topic('old', 'Obsolete revision', 'a:user')] });
  await wait(() => agent.calls.length === 2);
  assert.equal(outlines.snapshot('chat')!.topics.length, 0);
  const input = JSON.parse(agent.calls[1].input.prompt);
  assert.ok(input.evidence.some((e: any) => e.anchor === 'a:user'));
  assert.ok(input.evidence.some((e: any) => e.anchor === 'b:user'));
  await done(1, [topic('old', 'Old question', 'a:user'), topic('new', 'New question', 'b:user')]);
});

test('malformed output and invented links keep the last good index and offer a local retry', async t => {
  const { outlines, agent, done } = setup(); t.after(() => outlines.cancelAll());
  await outlines.enableNew('chat'); await outlines.update('chat', model, [turn('a', 'Rule A')]);
  await done(0, [topic('rule', 'Rule A', 'a:user')]);
  const revision = outlines.snapshot('chat')!.revision;
  await outlines.update('chat', model, [turn('b', 'Rule B')]);
  await done(1, [topic('bad', 'Invented prompt', 'missing:user')]);
  assert.equal(outlines.snapshot('chat')!.revision, revision); assert.ok(outlines.snapshot('chat')!.error);
  await outlines.update('chat', model, [turn('b', 'Rule B')]);
  await wait(() => agent.calls.length === 3); agent.calls[2].finish(null);
  await wait(() => !outlines.snapshot('chat')!.updating);
  assert.equal(outlines.snapshot('chat')!.topics[0].title, 'Rule A');
});

test('persistence is private and independent, and reopening unchanged history uses no model', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ct-outline-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const first = setup(dir); t.after(() => first.outlines.cancelAll());
  const source = turn('a', 'Rule A', 'Answer');
  await first.outlines.enableNew('chat'); await first.outlines.update('chat', model, [source]);
  await first.done(0, [topic('rule', 'Rule A', 'a:user')]);
  const path = join(dir, (await readdir(dir))[0]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).threadId, 'chat');
  const second = setup(dir); t.after(() => second.outlines.cancelAll()); second.history.push(wireTurn(source));
  await second.outlines.resume('chat', model, []);
  await wait(() => !second.outlines.snapshot('chat')!.updating);
  assert.equal(second.agent.calls.length, 0);
  assert.equal(second.outlines.snapshot('chat')!.topics[0].title, 'Rule A');
});

test('disconnect, removal and cancelled queued jobs cannot publish late output', async t => {
  for (const remove of [false, true]) {
    const { outlines, agent } = setup(); t.after(() => outlines.cancelAll());
    await outlines.enableNew('chat'); await outlines.update('chat', model, [turn('a', 'Rule A')]);
    await wait(() => agent.calls.length === 1);
    if (remove) await outlines.remove('chat'); else outlines.cancelAll();
    agent.calls[0].finish({ topics: [topic('bad', 'Late result', 'a:user')] });
    await pause(10);
    assert.ok(!outlines.snapshot('chat')?.topics.length); assert.equal(agent.calls[0].signal.aborted, true);
  }
});

test('reconnecting during helper shutdown retains the new pending update', async t => {
  const { outlines, agent, history, done } = setup(); t.after(() => outlines.cancelAll());
  agent.resolveOnAbort = false;
  const source = turn('a', 'Rule A'); history.push(wireTurn(source));
  await outlines.enableNew('chat'); await outlines.update('chat', model, [source]);
  await wait(() => agent.calls.length === 1);
  outlines.cancelAll();
  await outlines.resume('chat', model, [source]);
  agent.calls[0].finish(null);
  await done(1, [topic('rule', 'Rule A', 'a:user')]);
  assert.equal(outlines.snapshot('chat')!.topics[0].title, 'Rule A');
});

test('full refresh after history removal cannot retain links to deleted turns', async t => {
  const { outlines, history, done, agent } = setup(); t.after(() => outlines.cancelAll());
  await outlines.enableNew('chat'); await outlines.update('chat', model, [turn('a', 'Rule A'), turn('b', 'Rule B')]);
  await done(0, [topic('a', 'Rule A', 'a:user'), topic('b', 'Rule B', 'b:user')]);
  history.push(wireTurn(turn('a', 'Rule A')));
  await outlines.resume('chat', model, []); await wait(() => agent.calls.length === 2);
  assert.deepEqual(JSON.parse(agent.calls[1].input.prompt).previousOutline.topics, []);
  await done(1, [topic('a', 'Rule A', 'a:user')]);
  assert.equal(outlines.snapshot('chat')!.topics.length, 1);
});

test('long evidence is batched without dropping the middle; reasoning, tools and commentary are excluded', () => {
  const source = turn('a', 'Explain the rule', 'Start ' + 'middle '.repeat(6000) + ' End');
  const raw = wireTurn(source);
  raw.items.splice(1, 0, { id: 'thought', type: 'reasoning', summary: ['PRIVATE_REASONING'], content: [] } as any,
    { id: 'tool', type: 'commandExecution', command: 'SECRET_TOOL' } as any,
    { id: 'note', type: 'agentMessage', phase: 'commentary', text: 'COMMENTARY' } as any);
  const filtered = outlineFromHistory([raw]);
  assert.ok(!JSON.stringify(filtered).includes('PRIVATE_REASONING'));
  assert.ok(!JSON.stringify(filtered).includes('SECRET_TOOL')); assert.ok(!JSON.stringify(filtered).includes('COMMENTARY'));
  const batches = outlineBatches(filtered); assert.ok(batches.length > 1);
  assert.equal(batches.flat().filter(e => e.role === 'assistant').map(e => e.text).join(''), source.messages[1].text);
});

test('validator rejects depth, duplicated IDs, invalid anchors, and excessive headings', () => {
  const root = topic('rules', 'Rule A', 'a');
  assert.throws(() => validateOutline({ topics: [{ ...root, children: [{ ...root, id: 'third' }] }] }, ['a']));
  assert.throws(() => validateOutline({ topics: [root, root] }, ['a']));
  assert.throws(() => validateOutline({ topics: [root] }, ['b']));
  assert.throws(() => validateOutline({ topics: [{ ...root, title: 'x'.repeat(81) }] }, ['a']));
  const valid = validateOutline({ topics: [topic('later', 'Later', 'b'), root] }, ['a', 'b']);
  assert.deepEqual(valid.map(n => n.id), ['rules', 'later']);
});

test('controller updates every queued turn and accepted steering item without adding helper input to the main session', async t => {
  const calls: { method: string; params: any }[] = [];
  const workerCalls: any[] = [];
  const worker = Object.assign(new EventEmitter(), {
    start: async () => {}, close: async () => {}, rejectRequest: () => {},
    request: async (method: string, params: any): Promise<any> => {
      workerCalls.push({ method, params });
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: 'helper', ephemeral: true } };
      if (method === 'turn/start') {
        const payload = JSON.parse(params.input[0].text);
        const anchor = payload.evidence.find((e: any) => e.role === 'user').anchor;
        setTimeout(() => worker.emit('notification', { method: 'turn/completed', params: { threadId: 'helper',
          turn: { id: 'helper-turn', status: 'completed', items: [{ type: 'agentMessage', text: JSON.stringify({ topics: [topic('rules', 'Rules', anchor)] }) }] } } }), 5);
        return { turn: { id: 'helper-turn' } };
      }
      return {};
    },
  });
  let sequence = 0;
  const main = Object.assign(new EventEmitter(), {
    createPeer: () => worker,
    request: async (method: string, params: any): Promise<any> => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: `main-${++sequence}`, cwd: '/tmp', name: 'Named', preview: '' }, cwd: '/tmp' };
      return { data: [], nextCursor: null };
    },
  });
  const c = new Controller(main as unknown as CodexRpc, '/tmp'); c.connection = 'ready'; c.useOutlines(); await c.newThread();
  t.after(() => main.emit('closing'));
  const emit = (method: string, params: any) => main.emit('notification', { method, params: { threadId: c.thread!.id, ...params } });
  const first = wireTurn(turn('one', 'Explain A'));
  emit('turn/started', { turn: first }); emit('item/completed', { turnId: 'one', item: first.items[0] });
  await wait(() => c.outline?.topics.length === 1 && !c.outline.updating);
  const count = workerCalls.filter(c => c.method === 'turn/start').length;
  c.queuePaused = true; c.queue.push({ id: 'queued', text: 'Follow-up', images: [] });
  emit('turn/completed', { turn: wireTurn(turn('one', 'Explain A', 'Finished A')) });
  await wait(() => workerCalls.filter(c => c.method === 'turn/start').length > count && !c.outline?.updating);
  assert.equal(c.items.filter(i => i.item.type === 'userMessage').length, 1);
  assert.equal(c.thread!.id, 'main-1'); assert.ok(!calls.some(call => call.method === 'turn/start'));
  assert.ok(workerCalls.some(call => call.method === 'thread/start' && call.params.ephemeral && call.params.threadSource === 'thread_outline'));
  assert.equal(c.requests.length, 0);
});

test('cache namespace is independent of arbitrary thread IDs', () => {
  assert.match(outlineHash('../../other/session'), /^[a-f0-9]{64}$/);
});
