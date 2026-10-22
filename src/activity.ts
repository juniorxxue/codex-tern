import type { DisplayItem } from './controller';

export type TranscriptPart = { kind: 'message'; entry: DisplayItem }
  | { kind: 'activity'; id: string; turnId: string; entries: DisplayItem[] };

/** Keep user messages and answers in place; group the work between them. */
export function transcriptParts(items: DisplayItem[]): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const entry of items) {
    const i = entry.item;
    if (i.type === 'reasoning' && entry.done && !(i.summary ?? []).join('').trim()) continue;
    const message = i.type === 'userMessage' || (i.type === 'agentMessage' && i.phase !== 'commentary');
    const last = parts.at(-1);
    if (message) parts.push({ kind: 'message', entry });
    else if (last?.kind === 'activity' && last.turnId === entry.turnId) last.entries.push(entry);
    else parts.push({ kind: 'activity', id: entry.id, turnId: entry.turnId, entries: [entry] });
  }
  return parts;
}

export function activitySummary(entries: DisplayItem[]) {
  const commands = entries.filter(e => e.item.type === 'commandExecution').length;
  const changes = entries.filter(e => e.item.type === 'fileChange').length;
  const tools = entries.filter(e => /ToolCall|functionCallOutput/.test(e.item.type)).length;
  return [commands && `${commands} command${commands === 1 ? '' : 's'}`,
    changes && `${changes} file change${changes === 1 ? '' : 's'}`,
    tools && `${tools} tool${tools === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}

export function compactActivity(entry: DisplayItem) {
  const i = entry.item;
  const title = i.type === 'commandExecution' ? i.command
    : i.type === 'fileChange' ? `Editing ${(i.changes ?? []).map((f: any) => f.path.split('/').at(-1)).join(', ')}`
    : i.type === 'agentMessage' || i.type === 'plan' ? i.text
    : i.type === 'reasoning' ? (i.summary ?? []).join(' ') || 'Thinking…'
    : 'tool' in i ? i.tool : 'name' in i ? i.name : i.type;
  // Output is deliberately bounded even if a command prints megabytes.
  const output = i.type === 'commandExecution' ? (i.aggregatedOutput ?? '').split('\n').filter(Boolean).slice(-3).join('\n').slice(-600) : '';
  return { title: String(title).replace(/\s+/g, ' ').slice(0, 240), output };
}
