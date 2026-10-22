import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLock } from '@oh-my-pi/pi-natives';
import { probeWriterLocks } from '../src/session-locks';

test('only actual writer locks disable sessions; plain readers and this backend do not', async t => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-tern-locks-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const directory = join(codexHome, 'thread-writer-locks'); await mkdir(directory);
  const path = join(directory, 'busy.lock');
  const held = FileLock.tryAcquire(path); t.after(() => held.release());
  const source = { codexHome, ownsThread: (id: string) => id === 'own' };
  const own = FileLock.tryAcquire(join(directory, 'own.lock')); t.after(() => own.release());
  const idlePath = join(directory, 'idle.lock'); await writeFile(idlePath, 'marker');
  const reader = await open(idlePath, 'r'); t.after(() => reader.close());
  assert.deepEqual(await probeWriterLocks(source, ['busy', 'own', 'idle', 'missing']), new Set(['busy']));
  held.release();
  assert.deepEqual(await probeWriterLocks(source, ['busy', 'own', 'idle']), new Set());
  assert.equal(await readFile(idlePath, 'utf8'), 'marker');
});

test('a thread acquired by this backend during a probe is never marked locked', async t => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-tern-lock-race-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const directory = join(codexHome, 'thread-writer-locks'); await mkdir(directory);
  const writer = FileLock.tryAcquire(join(directory, 'resuming.lock'));
  t.after(() => writer.release());
  let checks = 0;
  const source = { codexHome, ownsThread: () => ++checks > 1 };
  assert.deepEqual(await probeWriterLocks(source, ['resuming']), new Set());
  assert.ok(checks >= 2, 'ownership is rechecked after the asynchronous file lookup');
});
