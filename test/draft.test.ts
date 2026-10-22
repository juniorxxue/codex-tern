import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Draft, ompInput } from '../src/draft';
import type { Key } from '@stencil-hq/tern';
function key(name: string, extra: Partial<Key> = {}): Key { return { name, ctrl: false, alt: false, shift: false, meta: false, ...extra }; }
test('emoji navigation and deletion keep surrogate pairs intact', () => {
  const d = new Draft(); d.set('\u4e2d🙂\u6587');
  d.key(key('left')); d.key(key('backspace')); assert.equal(d.text, '\u4e2d\u6587');
  d.undo(); assert.equal(d.text, '\u4e2d🙂\u6587'); d.key(key('left')); assert.equal(d.cursor, 1);
});
test('stale native edit is ignored and valid UTF-16 selection replacement is one undo step', () => {
  const d = new Draft(); d.set('\u4e2d🙂\u6587');
  assert.equal(d.nativeEdit({ len: 3, from: 1, to: 3, text: '\u66ff\u6362', cursor: 3 }), false);
  assert.equal(d.text, '\u4e2d🙂\u6587');
  assert.equal(d.nativeEdit({ len: 4, from: 1, to: 3, text: '\u66ff\u6362', cursor: 3 }), true);
  assert.equal(d.text, '\u4e2d\u66ff\u6362\u6587'); d.undo(); assert.equal(d.text, '\u4e2d🙂\u6587');
});
test('multiline bracketed paste is atomic and undo can restore a sent draft', () => {
  const d = new Draft(); d.key(key('paste', { text: '\u7b2c\u4e00\u884c\nsecond line\n🙂' }));
  const text = d.text; d.set(''); d.undo(); assert.equal(d.text, text);
  d.undo(); assert.equal(d.text, '');
});
test('selection, deletion and redo preserve draft state', () => {
  const d = new Draft(); d.set('hello'); d.key(key('a', { meta: true }));
  d.key(key('paste', { text: '\u4f60\u597d' })); assert.equal(d.text, '\u4f60\u597d');
  d.undo(); assert.equal(d.text, 'hello'); d.undo(true); assert.equal(d.text, '\u4f60\u597d');
});

test('readline line movement never selects or replaces the whole draft', () => {
  const d = new Draft(); d.set('first\nsecond\nthird');
  d.key(key('p', { ctrl: true }));
  d.key(key('a', { ctrl: true }));
  assert.equal(d.cursor, 6); assert.equal(d.anchor, 6);
  d.key(key('paste', { text: '>' }));
  d.key(key('e', { ctrl: true })); d.key(key('paste', { text: '<' }));
  assert.equal(d.text, 'first\n>second<\nthird');
  d.set('\nabc'); d.key(key('home', { ctrl: true })); d.key(key('a', { ctrl: true }));
  assert.equal(d.cursor, 0);
});

test('Ctrl+B/F and deletion move by whole Unicode graphemes', () => {
  const d = new Draft(); d.set('a👨‍👩‍👧‍👦e\u0301z');
  d.key(key('b', { ctrl: true })); d.key(key('h', { ctrl: true }));
  assert.equal(d.text, 'a👨‍👩‍👧‍👦z');
  d.key(key('b', { ctrl: true })); assert.equal(d.cursor, 1);
  d.key(key('f', { ctrl: true })); assert.equal(d.cursor, 'a👨‍👩‍👧‍👦'.length);
  d.key(key('b', { ctrl: true })); d.key(key('d', { ctrl: true })); assert.equal(d.text, 'az');
});

test('vertical movement keeps its preferred column across short lines', () => {
  const d = new Draft(); d.set('abcdef\nx\nabcdef');
  d.key(key('p', { ctrl: true })); assert.equal(d.cursor, 8);
  d.key(key('p', { ctrl: true })); assert.equal(d.cursor, 6);
  d.key(key('n', { ctrl: true })); assert.equal(d.cursor, 8);
  d.key(key('n', { ctrl: true })); assert.equal(d.cursor, d.text.length);
});

test('ported OMP word navigation handles paths, joiners, CJK and line boundaries', () => {
  const d = new Draft(); d.set("one/foo-bar \u4e2d\u6587");
  d.key(key('b', { alt: true })); assert.equal(d.cursor, 12);
  d.key(key('b', { alt: true })); assert.equal(d.cursor, 4);
  d.key(key('f', { alt: true })); assert.equal(d.cursor, 11);
  d.key(key('delete', { alt: true })); assert.equal(d.text, 'one/foo-bar');
  d.set('one\ntwo'); d.key(key('a', { ctrl: true }));
  d.key(key('left', { alt: true })); assert.equal(d.cursor, 3);
  d.key(key('right', { alt: true })); assert.equal(d.cursor, 4);
});

test('kill/yank accumulates adjacent deletions including line breaks', () => {
  const d = new Draft(); d.set('one\ntwo'); d.key(key('a', { ctrl: true }));
  d.key(key('k', { ctrl: true })); d.key(key('u', { ctrl: true }));
  assert.equal(d.text, 'one');
  d.key(key('y', { ctrl: true })); assert.equal(d.text, 'one\ntwo');
  d.undo(); assert.equal(d.text, 'one'); d.undo(true); assert.equal(d.text, 'one\ntwo');
});

test('yank-pop uses the original OMP kill ring and is cancelled by cursor movement', () => {
  const d = new Draft(); d.set('one two');
  d.key(key('w', { ctrl: true }));
  d.key(key('left')); d.key(key('right'));
  d.key(key('w', { ctrl: true })); d.key(key('y', { ctrl: true }));
  assert.equal(d.text, 'one ');
  d.key(key('y', { alt: true })); assert.equal(d.text, 'two');
  d.key(key('left')); d.key(key('y', { alt: true })); assert.equal(d.text, 'two');
});

test('native selection, shift selection and redo remain separate from Ctrl+A', () => {
  const d = new Draft(); d.set('hello world');
  d.key(key('a', { ctrl: true })); d.key(key('right', { shift: true }));
  d.key(key('right', { shift: true })); d.key(key('paste', { text: 'HE' }));
  assert.equal(d.text, 'HEllo world');
  d.key(key('z', { meta: true })); assert.equal(d.text, 'hello world');
  d.key(key('z', { meta: true, shift: true })); assert.equal(d.text, 'HEllo world');
  d.key(key('a', { meta: true })); d.key(key('left')); assert.equal(d.cursor, 0); assert.equal(d.anchor, 0);
});

test('Ctrl+J inserts a newline and native edits reset the kill sequence', () => {
  const d = new Draft(); d.set('first'); d.key(key('j', { ctrl: true }));
  d.key(key('paste', { text: 'second' })); assert.equal(d.text, 'first\nsecond');
  d.key(key('w', { ctrl: true }));
  d.nativeEdit({ len: 6, from: 6, to: 6, text: 'third', cursor: 11 });
  d.key(key('w', { ctrl: true })); d.key(key('y', { ctrl: true }));
  assert.equal(d.text, 'first\nthird');
});

test('history browsing recalls sent drafts without stealing in-draft movement', () => {
  const d = new Draft(); d.addHistory('older'); d.addHistory('newer');
  d.key(key('up')); assert.equal(d.text, 'newer');
  d.key(key('up')); assert.equal(d.text, 'older');
  d.key(key('down')); assert.equal(d.text, 'newer');
  d.key(key('down')); assert.equal(d.text, '');
  d.set('first\nsecond'); d.key(key('p', { ctrl: true })); assert.equal(d.text, 'first\nsecond'); assert.equal(d.cursor, 5);
});

test('paging never recalls history or jumps within a single line', () => {
  const d = new Draft(); d.addHistory('old prompt');
  d.key(key('page_up')); assert.equal(d.text, '');
  d.set('short'); d.key(key('page_up')); assert.equal(d.cursor, 5);
  d.set('first\nsecond'); d.key(key('page_up')); assert.equal(d.cursor, 5);
});

test('paste cancels character-jump mode without losing the pasted text', () => {
  const d = new Draft(); d.set('abc'); d.key(key(']', { ctrl: true }));
  d.key(key('paste', { text: 'exact\ntext' })); assert.equal(d.text, 'abcexact\ntext');
});


test('decoded printable keys preserve case, symbols and Unicode', () => {
  const d = new Draft();
  for (const text of ['A', 'Z', '_', '\u4e2d', '🙂']) d.key(key(text.toLowerCase(), { text, shift: true }));
  assert.equal(d.text, 'AZ_\u4e2d🙂');
  assert.equal(ompInput(key('a', { text: 'A', shift: true })), 'A');
  assert.equal(ompInput(key(',', { text: ',', meta: true })), '\x1b[44;9u');
});

test('large OMP pastes retain literal text and submit without paste markers', () => {
  const d = new Draft();
  const text = ('line with spaces \u4e2d\u6587 🙂\n').repeat(200);
  d.key(key('paste', { text }));
  assert.equal(d.text, text);
  assert.equal(d.submittedText, text);
  d.undo(); assert.equal(d.text, '');
});

test('OMP Vim normal mode motions and operators return cleanly to insert', () => {
  const d = new Draft(); d.setVim(true); d.set('one two');
  d.key(key('escape')); assert.equal(d.nativeProps.mode, 'NORMAL');
  d.key(key('b', { text: 'b' })); d.key(key('d', { text: 'd' })); d.key(key('w', { text: 'w' }));
  d.key(key('a', { text: 'A', shift: true })); d.key(key('paste', { text: 'THREE' }));
  assert.equal(d.submittedText, 'one THREE');
  d.setVim(false); assert.equal(d.nativeProps.mode, undefined);
});
