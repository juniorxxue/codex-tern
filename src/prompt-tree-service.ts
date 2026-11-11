import { Worker } from 'node:worker_threads';
import type { CodexRpc } from './rpc';
import type { PromptAnchor } from './prompt-anchor';
import type { PromptTree } from './prompt-tree';

/** A lazy, read-only worker. It survives UI reloads and owns no chat state. */
export class PromptTreeService {
  private worker?: Worker;
  private seq = 0;
  private pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closed = false;
  private closing = false;
  constructor(private readonly options: CodexRpc['options']) {}

  private spawn() {
    if (this.worker || this.closed || this.closing) return;
    const url = new URL(import.meta.url.endsWith('/prompt-tree-service.ts') ? './prompt-tree-worker.ts' : './prompt-tree-worker.mjs', import.meta.url);
    const worker = this.worker = new Worker(url, { workerData: this.options });
    worker.on('message', message => {
      if (this.worker !== worker || this.closed) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    });
    const failed = (error: Error) => {
      if (this.worker !== worker || this.closing) return;
      this.worker = undefined;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
      void worker.terminate();
    };
    worker.on('error', failed);
    worker.on('exit', code => { if (!this.closed) failed(new Error(`Conversation tree stopped (${code}). Try again.`)); });
  }
  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.worker) return Promise.reject(new Error('Conversation tree is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === 'tree') this.cancelTree();
        reject(new Error('Loading the conversation tree took too long. Try again.'));
      }, method === 'tree' ? 120_000 : 30_000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.worker!.postMessage({ id, method, params });
    });
  }
  tree(threadId: string, fresh = false) { this.spawn(); return this.request<PromptTree>('tree', { threadId, fresh }); }
  verify(anchor: PromptAnchor) { this.spawn(); return this.request<void>('verify', { anchor }); }
  invalidate(threadId: string) { this.worker?.postMessage({ method: 'invalidate', params: { threadId } }); }
  cancelTree() {
    this.worker?.postMessage({ method: 'cancelTree', params: {} });
    for (const [id, request] of this.pending) if (request.method === 'tree') {
      clearTimeout(request.timer); this.pending.delete(id); request.reject(new Error('Conversation tree loading cancelled.'));
    }
  }
  async close() {
    if (this.closed || this.closing) return;
    this.closing = true;
    const worker = this.worker;
    if (worker) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.request('close', {}).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
    }
    this.closed = true; this.worker = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Conversation tree closed.')); }
    this.pending.clear(); await worker?.terminate();
  }
}
