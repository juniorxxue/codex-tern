import { parentPort, workerData } from 'node:worker_threads';
import { CodexRpc } from './rpc';
import { PromptTreeReader } from './prompt-tree';
import { verifyPromptAnchor } from './prompt-anchor';

const port = parentPort!;
const rpc = new CodexRpc({ ...workerData, timeoutMs: 30_000 });
const tree = new PromptTreeReader(rpc);
let closed = false, starting: Promise<unknown> | undefined, treeRequest = 0;
async function connect() {
  if (closed) throw new Error('Conversation tree is closed.');
  if (starting || rpc.connected) return starting;
  starting = rpc.restart().finally(() => { starting = undefined; });
  return starting;
}
rpc.on('request', message => rpc.rejectRequest(message.id, 'The conversation tree only reads saved history.'));
port.on('message', async ({ id, method, params }) => {
  try {
    let result: unknown;
    if (method === 'tree') {
      const request = ++treeRequest;
      await connect();
      if (request !== treeRequest || closed) throw new Error('Conversation tree loading cancelled.');
      result = await tree.read(params.threadId, params.fresh);
    } else if (method === 'verify') { await connect(); await verifyPromptAnchor(rpc, params.anchor); }
    else if (method === 'invalidate') tree.invalidate(params.threadId);
    else if (method === 'cancelTree') { treeRequest++; tree.cancel(); }
    else if (method === 'close') {
      closed = true; tree.cancel(); await rpc.close(); await starting?.catch(() => {});
      port.postMessage({ id, result: true }); port.close(); return;
    }
    if (id) port.postMessage({ id, result });
  } catch (error) { if (id) port.postMessage({ id, error: (error as Error).message }); }
});
