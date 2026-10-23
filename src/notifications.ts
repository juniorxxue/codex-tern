import { createHash } from 'node:crypto';
import type { Completion } from './controller';

/** OSC 99 is handled by Tern, including OS focus and notification preferences. */
export function completionNotification(event: Completion) {
  const id = createHash('sha256').update(event.threadId).digest('hex').slice(0, 20);
  // Titles are display data, never terminal control sequences or prompt text.
  const title = event.title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const label = event.status === 'completed' ? 'Task complete' : 'Task failed';
  return `\x1b]99;i=codex-tern-${id}:o=unfocused:s=c2lsZW50:a=focus;${label} · ${title}\x1b\\`;
}
