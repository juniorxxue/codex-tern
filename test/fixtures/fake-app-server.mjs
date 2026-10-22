#!/usr/bin/env bun
// Transport fixture only. No model or external service calls.
import { createInterface } from 'node:readline';
const send = object => process.stdout.write(JSON.stringify(object) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method) { send({ method: 'fixture/responded', params: m }); return; }
  if (m.method === 'initialized') return;
  send({ method: 'fixture/observed', params: { method: m.method, params: m.params } });
  if (m.method === 'initialize') {
    const data = JSON.stringify({ id: m.id, result: { userAgent: 'fixture' } }) + '\n';
    process.stdout.write(data.slice(0, 9));
    setTimeout(() => {
      process.stdout.write(data.slice(9));
      send({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'i' } });
    }, 1);
  } else if (m.method === 'model/list') setTimeout(() => send({ id: m.id, result: { data: ['model'] } }), 20);
  else if (m.method === 'account/read') send({ id: m.id, result: { account: { type: 'test' } } });
  else if (m.method === 'thread/resume') send({ id: m.id, error: { code: -32000, message: 'Resume failed', data: { reason: 'missing' } } });
  else if (m.method === 'thread/start') process.exit(8);
  else if (m.method === 'turn/start') send({ id: m.id, result: { turn: null } });
  else if (m.method === 'thread/read' && m.params.threadId === 'malformed') {
    send(null); send([]); send({ method: 'turn/started', params: {} });
    send({ method: 'item/agentMessage/delta', params: { itemId: 'x', turnId: 'y', delta: {} } });
    send({ id: m.id, result: { thread: { id: 'valid' } } });
  }
  // thread/read deliberately stays pending, to test timeout and shutdown.
});
