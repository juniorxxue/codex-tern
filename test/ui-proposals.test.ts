import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Node, type Session, type Surface } from '@stencil-hq/tern';
import { Controller, type DisplayItem } from '../src/controller';
import { NativeUI } from '../src/ui';
import type { CodexRpc } from '../src/rpc';

const block = (n: number) => `:::proposal\n[before]\nOriginal ${n}.\n[after]\nSuggested ${n}.\n:::`;
const entry = (text = [1, 2, 3].map(block).join('\n\n')): DisplayItem => ({
  id: 'reply', turnId: 'turn', done: true, item: { type: 'agentMessage', id: 'reply', text, phase: 'final_answer',
    memoryCitation: null, delivery: null, questions: null },
});
const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
const disabled = (node: Node) => (node.props.attrs as Record<string, unknown>)?.['aria-disabled'];
const action = { ev: 'action', sf: 'test', id: 'apply', act: 'click', raw: {} } as const;
function setup() {
  const calls: string[] = [], focused: string[] = [];
  const transport = Object.assign(new EventEmitter(), { request: async (method: string) => { calls.push(method); } });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp');
  c.thread = { id: 'thread-1' } as any; c.connection = 'ready'; c.items = [entry()];
  const session = { close: async () => {} } as unknown as Session;
  const surface = { closed: true, stylesheet: () => {}, focus: (id: string) => focused.push(id) } as unknown as Surface;
  const ui = new NativeUI(c, session, surface);
  const render = (item = c.items[0]!) => nodes((ui as any).renderItem(item));
  const checkbox = (number: number) => render().find(node => node.props.aria === `Select edit ${number}`)!;
  const button = () => render().find(node => node.props.aria === 'Apply selected edits')!;
  const select = async (number: number, checked = true) => {
    await checkbox(number).handlers!.onChange!({ ev: 'change', sf: 'test', id: 'check', checked, raw: {} });
  };
  const apply = async () => { await button().handlers!.onClick!(action); };
  return { ui, c, calls, focused, render, checkbox, button, select, apply };
}

test('checked edits draft an ordered request without sending it; deselection disables an empty request', async t => {
  const s = setup(); t.after(() => s.ui.close());
  assert.equal(disabled(s.button()), true);
  await s.apply(); assert.equal(s.ui.draft.text, '');
  await s.select(3); await s.select(1); await s.select(2); await s.select(2, false);
  assert.equal(s.checkbox(1).props.checked, true); assert.equal(s.checkbox(2).props.checked, false);
  assert.equal(disabled(s.button()), false);
  await s.apply(); assert.equal(s.ui.draft.text, 'Apply the edits 1, 3.');
  assert.equal(s.focused.at(-1), 'dock.body.line.input'); assert.deepEqual(s.calls, []);
  await s.select(2); await s.apply(); assert.equal(s.ui.draft.text, 'Apply the edits 1, 2, 3.');
  await s.apply(); assert.equal(s.ui.draft.text, 'Apply the edits 1, 2, 3.');
  for (const n of [1, 2, 3]) await s.select(n, false);
  assert.equal(disabled(s.button()), true);
  const labels = s.render().map(n => n.props.text);
  assert.ok(labels.includes('Original')); assert.ok(labels.includes('Suggested'));
  assert.equal(s.render().filter(n => n.props.tag === 'button').length, 1);
});

test('apply preserves existing text and attachments, supports undo, and respects later user edits', async t => {
  const s = setup(); t.after(() => s.ui.close());
  s.ui.draft.set('Keep the notation.'); s.ui.images = ['/tmp/diagram.png'];
  await s.select(1); await s.apply();
  assert.equal(s.ui.draft.text, 'Keep the notation.\n\nApply the edits 1.');
  s.ui.draft.undo(); assert.equal(s.ui.draft.text, 'Keep the notation.');
  await s.select(2); await s.apply();
  assert.equal(s.ui.draft.text, 'Keep the notation.\n\nApply the edits 1, 2.');
  s.ui.draft.set(s.ui.draft.text + ' Only in the introduction.');
  const written = s.ui.draft.text;
  await s.select(3); await s.apply();
  assert.equal(s.ui.draft.text, written + '\n\nApply the edits 1, 2, 3.');
  assert.deepEqual(s.ui.images, ['/tmp/diagram.png']); assert.deepEqual(s.calls, []);
});

test('selection stays with its session, reply, and exact proposal source', async t => {
  const s = setup(); t.after(() => s.ui.close());
  await s.select(1);
  const staleButton = s.button();
  s.c.thread = { id: 'thread-2' } as any;
  assert.equal(s.checkbox(1).props.checked, false);
  await staleButton.handlers!.onClick!(action); assert.equal(s.ui.draft.text, '');
  s.c.thread = { id: 'thread-1' } as any;
  assert.equal(s.checkbox(1).props.checked, true);
  const second = { ...entry(block(4)), id: 'other', turnId: 'other-turn' };
  s.c.items.push(second);
  assert.equal(s.render(second).find(n => n.props.aria === 'Select edit 1')!.props.checked, false);
  await s.apply();
  assert.match(s.ui.draft.text, /^Apply the edits 1\./);
  assert.ok(s.ui.draft.text.includes('Original 1.'), 'earlier replies include a source reference');
  s.ui.draft.set(''); s.c.items[0] = entry(block(7));
  await staleButton.handlers!.onClick!(action); assert.equal(s.ui.draft.text, '');
  assert.equal(s.checkbox(1).props.checked, false); assert.equal(disabled(s.button()), true);
});

test('apply cannot write into a question, dialog, navigation, or unfinished reply', async t => {
  const s = setup(); t.after(() => s.ui.close());
  await s.select(1);
  const staleButton = s.button();
  const blocked = async () => {
    assert.equal(disabled(s.button()), true);
    await staleButton.handlers!.onClick!(action); assert.equal(s.ui.draft.text, '');
  };
  s.ui.answerTarget = { requestId: 1, questionId: 'q' }; await blocked(); s.ui.answerTarget = null;
  s.ui.panel = 'help'; await blocked(); s.ui.panel = null;
  s.c.operation = 'Opening session'; await blocked(); s.c.operation = '';
  s.c.items[0]!.done = false; await blocked();
  assert.equal(s.checkbox(1).props.disabled, true); assert.deepEqual(s.calls, []);
  s.c.items = [entry('Plain text.')];
  assert.ok(!s.render().some(n => n.props.aria === 'Apply selected edits'));
});
