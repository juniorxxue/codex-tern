// Optional real-backend integration check. Creates one normal saved Codex thread.
import assert from 'node:assert/strict';
import { CodexRpc } from '../src/rpc';
import { Controller } from '../src/controller';
import { mkdir, writeFile } from 'node:fs/promises';

const rpc = new CodexRpc({ cwd: process.cwd() });
const c = new Controller(rpc, process.cwd());
let savedThreadId = '';
try {
  await c.connect();
  assert.ok(c.thread?.id);
  const threadId = c.thread.id;
  savedThreadId = threadId;
  const completed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Real turn did not complete in 120s')), 120_000);
    rpc.on('notification', message => {
      if (message.method === 'turn/completed' && message.params.threadId === threadId) {
        clearTimeout(timeout);
        if (message.params.turn.status === 'completed') resolve(); else reject(new Error(JSON.stringify(message.params.turn.error)));
      }
    });
  });
  await c.submit('This is a codex-tern integration test. Reply only with TERN_OK. Do not call tools.');
  await completed;
  assert.ok(c.items.some(i => i.item.type === 'agentMessage' && i.item.text.includes('TERN_OK')));
  await c.newThread();
  await c.resume(threadId);
  assert.ok(c.items.some(i => i.item.type === 'agentMessage' && i.item.text.includes('TERN_OK')));
  console.log(`PASS: official app-server → real response → saved thread → resume (${threadId})`);
} finally { await rpc.close(); }

// A new process must restore the same saved thread, too. Scope this check to
// the thread created above; never search the user's other conversations.
const restarted = new CodexRpc({ cwd: process.cwd() });
try {
  const restored = new Controller(restarted, process.cwd());
  await restored.connect(savedThreadId);
  assert.ok(restored.items.some(i => i.item.type === 'agentMessage' && i.item.text.includes('TERN_OK')));
  await mkdir('.prototype', { recursive: true });
  await writeFile('.prototype/real-smoke.json', JSON.stringify({ at: new Date().toISOString(), threadId: savedThreadId,
    checks: ['real reply', 'same-process resume', 'new-process resume'] }, null, 2));
  console.log('PASS: a new app-server process restored the same test thread');
} finally { await restarted.close(); }
