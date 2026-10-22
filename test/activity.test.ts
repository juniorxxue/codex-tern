import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptParts, activitySummary, compactActivity } from '../src/activity';
import type { DisplayItem } from '../src/controller';

const item = (id: string, type: string, extra: any = {}, turnId = 'turn'): DisplayItem => ({
  id, turnId, done: true, item: { id, type, ...extra },
});

test('activity grouping preserves answers, steering messages and turn boundaries', () => {
  const parts = transcriptParts([
    item('u', 'userMessage'), item('c', 'agentMessage', { phase: 'commentary' }),
    item('s', 'commandExecution'), item('steer', 'userMessage'), item('s2', 'commandExecution'),
    item('f', 'agentMessage', { phase: 'final_answer' }),
    item('legacy', 'agentMessage', { phase: null }), item('other', 'commandExecution', {}, 'next'),
  ]);
  assert.deepEqual(parts.map(p => p.kind === 'message' ? p.entry.id : p.entries.map(e => e.id)),
    ['u', ['c', 's'], 'steer', ['s2'], 'f', 'legacy', ['other']]);
});

test('empty finished reasoning disappears and command previews stay bounded', () => {
  assert.deepEqual(transcriptParts([item('r', 'reasoning', { summary: [] })]), []);
  const command = item('s', 'commandExecution', { command: 'echo test', aggregatedOutput: 'x'.repeat(100_000) + '\nlast\nline\n' });
  const preview = compactActivity(command);
  assert.equal(preview.title, 'echo test');
  assert.ok(preview.output.length <= 600);
  assert.ok(preview.output.endsWith('last\nline'));
  assert.equal(activitySummary([command, item('s2', 'commandExecution'), item('f', 'fileChange')]), '2 commands · 1 file change');
});
