import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRpc, RpcError, RpcOutcomeUnknown } from '../src/rpc';
import { once } from 'node:events';

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-rpc-'));
  const binary = join(dir, 'fake-codex');
  await copyFile(new URL('./fixtures/fake-app-server.mjs', import.meta.url), binary);
  await chmod(binary, 0o755);
  const rpc = new CodexRpc({ binary, cwd: process.cwd(), timeoutMs: 1000 });
  t.after(async () => { await rpc.close(); await rm(dir, { recursive: true, force: true }); });
  return rpc;
}
test('stdio handles split JSON, concurrent responses and server requests with overlapping IDs', async t => {
  const rpc = await fixture(t);
  const request = once(rpc, 'request');
  await rpc.start();
  const [approval] = await request;
  assert.equal(approval.id, 1);
  assert.equal(approval.method, 'item/fileChange/requestApproval');
  const observed: string[] = [];
  rpc.on('notification', m => { if (m.method === 'fixture/observed') observed.push(m.params.method); });
  const [models, account] = await Promise.all([
    rpc.request('model/list', {}), rpc.request('account/read', { refreshToken: false }),
  ]);
  assert.deepEqual(models.data, ['model']); assert.equal(account.account?.type, 'test');
  const response = new Promise<any>(resolve => rpc.on('notification', m => { if (m.method === 'fixture/responded') resolve(m.params); }));
  rpc.respond(approval.id, { decision: 'decline' });
  assert.deepEqual(await response, { id: 1, result: { decision: 'decline' } });
  assert.deepEqual(observed, ['model/list', 'account/read']);
});
test('RPC errors preserve code and data without retrying a mutation', async t => {
  const rpc = await fixture(t); await rpc.start();
  await assert.rejects(rpc.request('thread/resume', { threadId: 'missing' }), (e: any) =>
    e instanceof RpcError && e.code === -32000 && (e.data as any).reason === 'missing');
});
test('backend exit rejects pending requests and marks disconnected', async t => {
  const rpc = await fixture(t); await rpc.start();
  const disconnected = once(rpc, 'disconnected');
  await assert.rejects(rpc.request('thread/start', {}), (e: unknown) => e instanceof RpcOutcomeUnknown && /exited/.test(e.message));
  await disconnected; assert.equal(rpc.connected, false);
});

test('timeouts distinguish uncertain delivery from a request that was never written', async t => {
  const rpc = await fixture(t);
  await assert.rejects(rpc.request('thread/read', { threadId: 'pending' }),
    (e: unknown) => e instanceof Error && !(e instanceof RpcOutcomeUnknown));
  await rpc.start(); rpc.options.timeoutMs = 20;
  await assert.rejects(rpc.request('thread/read', { threadId: 'pending' }),
    (e: unknown) => e instanceof RpcOutcomeUnknown && e.method === 'thread/read');
});

test('invalid envelopes and deltas are diagnosed without breaking subsequent responses', async t => {
  const rpc = await fixture(t); const diagnostics: string[] = [];
  rpc.on('diagnostic', value => diagnostics.push(value));
  await rpc.start();
  const result = await rpc.request('thread/read', { threadId: 'malformed' });
  assert.equal(result.thread.id, 'valid'); assert.equal(diagnostics.length, 4);
});

test('malformed mutation results are uncertain rather than successful', async t => {
  const rpc = await fixture(t); await rpc.start();
  await assert.rejects(rpc.request('turn/start', { threadId: 't', input: [] }),
    (e: unknown) => e instanceof RpcOutcomeUnknown && /invalid response/.test(e.message));
});
test('closing rejects pending calls and cleans up the child process', async t => {
  const rpc = await fixture(t); await rpc.start();
  const pending = assert.rejects(rpc.request('thread/read', { threadId: 'pending' }), /Client closed/);
  await rpc.close(); await pending; assert.equal(rpc.connected, false);
});

test('restarting after an exit starts one fresh connection and accepts new requests', async t => {
  const rpc = await fixture(t); await rpc.start(); const first = rpc.pid;
  await assert.rejects(rpc.request('thread/start', {}), RpcOutcomeUnknown);
  await rpc.restart();
  assert.notEqual(rpc.pid, first); assert.equal(rpc.connected, true);
  const result = await rpc.request('account/read', { refreshToken: false });
  assert.equal(result.account?.type, 'test');
});
