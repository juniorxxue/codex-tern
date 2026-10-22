import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contactProject, projectAddress, serveProject, type ProjectInstance } from '../src/project-instance';

const command = { version: 1 as const, signature: 'test-settings' };
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tern-project-'));
  const address = await projectAddress(dir, dir);
  const owners: ProjectInstance[] = [];
  t.after(async () => { for (const owner of owners) await owner.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, address, owners };
}

test('concurrent project launches have one owner and deliver each command once', async t => {
  const { address, owners } = await fixture(t);
  const received: string[] = [];
  const starts = await Promise.all(Array.from({ length: 5 }, (_, n) => serveProject(address,
    { ...command, prompt: String(n) }, async request => { received.push(request.prompt!); })));
  owners.push(...starts.filter((owner): owner is ProjectInstance => owner !== null));
  assert.equal(owners.length, 1);
  assert.equal(received.length, 4); assert.equal(new Set(received).size, 4);
  await contactProject(address, { ...command, prompt: 'next' });
  assert.equal(received.at(-1), 'next');
});

test('project aliases share an instance; independent folders and profiles do not', async t => {
  const { dir, address } = await fixture(t);
  const alias = dir + '-alias'; await symlink(dir, alias); t.after(() => rm(alias));
  assert.equal(await projectAddress(alias, dir), address);
  assert.notEqual(await projectAddress(dir, dir + '-other-profile'), address);
});

test('subfolders in one repository share a project instance', async t => {
  const { dir } = await fixture(t);
  await mkdir(join(dir, '.git')); await mkdir(join(dir, 'src'));
  assert.equal(await projectAddress(join(dir, 'src'), dir), await projectAddress(dir, dir));
});

test('stale socket recovery and changed settings never create a second active owner', async t => {
  const { address, owners } = await fixture(t);
  const stale = spawn(process.execPath, ['-e', 'import {createServer} from "node:net"; createServer().listen(process.env.QA_SOCKET,()=>console.log("ready"))'],
    { env: { ...process.env, QA_SOCKET: address }, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(stale.stdout, 'data');
  stale.kill('SIGKILL'); await once(stale, 'exit');
  let calls = 0;
  const owner = await serveProject(address, command, async () => { calls++; });
  assert.ok(owner); owners.push(owner);
  await assert.rejects(contactProject(address, { ...command, signature: 'different' }), /different settings/);
  assert.equal(calls, 0);
  assert.equal(await contactProject(address, command), true); assert.equal(calls, 1);
});
