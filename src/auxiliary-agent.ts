import type { CodexRpc } from './rpc';
import { record, type RpcMessage } from './protocol';
import type { ReasoningEffort } from './generated/ReasoningEffort';
import type { JsonValue } from './generated/serde_json/JsonValue';

export interface AuxiliaryModel {
  cwd: string;
  model?: string;
  modelProvider?: string;
  effort?: ReasoningEffort;
}
interface AuxiliaryInput extends AuxiliaryModel {
  source: string;
  instructions: string;
  prompt: string;
  schema: JsonValue;
  timeoutMs?: number;
}

/** One queue for optional UI work. Its transport and threads never enter the main controller. */
export class AuxiliaryAgent {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly createConnection: () => CodexRpc) {}

  generate(input: AuxiliaryInput, signal: AbortSignal): Promise<unknown | null> {
    const work = this.tail.then(() => signal.aborted ? null : this.run(input, signal));
    this.tail = work.catch(() => null);
    return work;
  }

  private async run(input: AuxiliaryInput, parentSignal: AbortSignal): Promise<unknown | null> {
    let rpc: CodexRpc;
    try { rpc = this.createConnection(); } catch { return null; }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), input.timeoutMs ?? 30_000);
    const signal = AbortSignal.any([parentSignal, timeout.signal]);
    let threadId: string | undefined, turnId: string | undefined, completed = false, answer = '';
    let finish!: (value: unknown | null) => void;
    const result = new Promise<unknown | null>(resolve => { finish = resolve; });
    const cancel = () => finish(null);
    const notification = (message: RpcMessage) => {
      const p = message.params;
      if (message.method === 'thread/started' && p.thread?.ephemeral) threadId = p.thread.id;
      if (!threadId || p?.threadId !== threadId) return;
      if (message.method === 'turn/started') turnId ??= p.turn.id;
      if (p.turnId && turnId && p.turnId !== turnId) return;
      if (message.method === 'item/completed' && p.item.type === 'agentMessage' && p.item.phase !== 'commentary') answer = p.item.text;
      if (message.method !== 'turn/completed' || (turnId && p.turn.id !== turnId)) return;
      completed = true; turnId = p.turn.id;
      const last = p.turn.items?.findLast((item: any) => item.type === 'agentMessage' && item.phase !== 'commentary');
      try { finish(p.turn.status === 'completed' ? JSON.parse(last?.text ?? answer) : null); }
      catch { finish(null); }
    };
    const request = (message: RpcMessage) => {
      try { rpc.rejectRequest(message.id!, 'Interactive tools are unavailable in background UI tasks.'); } catch { /* Closed. */ }
      timeout.abort();
    };
    rpc.on('notification', notification); rpc.on('request', request); rpc.on('disconnected', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    const work = async () => {
      signal.throwIfAborted();
      await rpc.start(); signal.throwIfAborted();
      const { config } = await rpc.request('config/read', { cwd: input.cwd, includeLayers: false });
      signal.throwIfAborted();
      const servers = record(config.mcp_servers) ? Object.keys(config.mcp_servers) : [];
      const started = await rpc.request('thread/start', {
        cwd: input.cwd, model: input.model, modelProvider: input.modelProvider,
        ephemeral: true, threadSource: input.source, sandbox: 'read-only', approvalPolicy: 'never',
        baseInstructions: input.instructions, developerInstructions: '', serviceTier: null,
        config: {
          project_doc_max_bytes: 0, web_search: 'disabled',
          mcp_servers: Object.fromEntries(servers.map(name => [name, { enabled: false }])),
          memories: { use_memories: false, generate_memories: false },
          'features.apps': false, 'features.plugins': false, 'features.hooks': false,
          'features.shell_tool': false, 'features.unified_exec': false, 'features.apply_patch_freeform': false,
          'features.js_repl': false, 'features.code_mode': false, 'features.code_mode_only': false,
          'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.enable_fanout': false,
          'features.image_generation': false, 'features.tool_suggest': false,
          ...(input.effort ? { model_reasoning_effort: input.effort } : {}),
        },
      });
      threadId = started.thread.id; signal.throwIfAborted();
      const turn = await rpc.request('turn/start', { threadId, effort: input.effort, outputSchema: input.schema,
        input: [{ type: 'text', text_elements: [], text: input.prompt }],
      });
      turnId ??= turn.turn.id;
      return result;
    };
    try {
      if (signal.aborted) return null;
      return await Promise.race([work(), result]);
    } catch { return null; }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      rpc.off('notification', notification); rpc.off('request', request); rpc.off('disconnected', cancel);
      if (threadId) {
        if (turnId && !completed) void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        void rpc.request('thread/unsubscribe', { threadId }).catch(() => {});
      }
      await rpc.close().catch(() => {});
    }
  }
}
