import type { CodexRpc } from './rpc';
import type { ThreadItemsListResponse } from './generated/v2/ThreadItemsListResponse';

export interface PromptAnchor { threadId: string; turnId: string; itemId: string }

export function validPromptAnchor(value: unknown): value is PromptAnchor {
  if (!value || typeof value !== 'object') return false;
  const a = value as PromptAnchor;
  return [a.threadId, a.turnId, a.itemId].every(v => typeof v === 'string' && v.length > 0 && v.length < 1000);
}

/** Verify the original prompt without resuming or changing its conversation. */
export async function verifyPromptAnchor(rpc: CodexRpc, anchor: PromptAnchor): Promise<void> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: ThreadItemsListResponse = await rpc.request('thread/items/list', {
      threadId: anchor.threadId, turnId: anchor.turnId, sortDirection: 'asc', limit: 50, ...(cursor ? { cursor } : {}),
    });
    if (page.data.some(e => e.turnId === anchor.turnId && e.item.id === anchor.itemId && e.item.type === 'userMessage')) return;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Conversation history pagination repeated. Try again.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  throw new Error('This prompt is no longer in the saved conversation. Refresh and try again.');
}
