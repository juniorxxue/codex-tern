import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantParts, proposalDiff, proposalTokens } from '../src/proposals';

const block = (before: string, after: string) => `:::proposal\n[before]\n${before}\n[after]\n${after}\n:::`;
const changed = (runs: ReturnType<typeof proposalDiff>['before']) => runs.filter(r => r.changed).map(r => r.raw).join('');

test('proposals preserve both exact sources and surrounding Markdown', () => {
  const source = `Explanation.\n\n${block('Old $x$.', 'New $x$.')}\n\nReason.\n${block('', 'Added.')}`;
  assert.deepEqual(assistantParts(source).map(p => p.kind === 'markdown' ? p.text : [p.before, p.after]),
    ['Explanation.\n\n', ['Old $x$.', 'New $x$.'], '\nReason.\n', ['', 'Added.']]);
  assert.deepEqual(assistantParts(block(' x\n\ny ', ' z ')).map(p => p.kind === 'proposal' && [p.before, p.after]), [[' x\n\ny ', ' z ']]);
  const crlf = block('Old', 'New').replaceAll('\n', '\r\n');
  assert.deepEqual(assistantParts(crlf)[0], { kind: 'proposal', before: 'Old', after: 'New', start: 0 });
});

test('streaming, malformed and example blocks remain readable without losing content', () => {
  const valid = block('Old', 'New');
  for (let n = 1; n < valid.length; n++) assert.deepEqual(assistantParts(valid.slice(0, n)), [{ kind: 'markdown', text: valid.slice(0, n), start: 0 }]);
  for (const text of [
    `\`\`\`text\n${valid}\n\`\`\``, `~~~~\n${valid}\n~~~~`,
    valid.split('\n').map(line => `> ${line}`).join('\n'), valid.split('\n').map(line => `    ${line}`).join('\n'),
    `<div>\n${valid}\n</div>`, `\\${valid}`, ':::proposal\n[before]\nOld\n:::',
    ':::proposal\n[before]\nOld\n[after]\nNew\n[after]\nAgain\n:::',
  ]) assert.deepEqual(assistantParts(text), [{ kind: 'markdown', text, start: 0 }]);
  const broken = ':::proposal\nmissing header\n';
  assert.equal(assistantParts(broken + valid).filter(p => p.kind === 'proposal').length, 1);
});

test('diff marks only changed occurrences, including replacements, insertion and deletion', () => {
  const diff = proposalDiff('The body is type checked as follows.', 'The body is typed as follows.');
  assert.equal(changed(diff.before), 'type checked'); assert.equal(changed(diff.after), 'typed');
  const repeated = proposalDiff('the first and the second', 'the first and second');
  assert.equal(changed(repeated.before), 'the '); assert.equal(changed(repeated.after), '');
  assert.equal(changed(proposalDiff('same', 'same').before), '');
  assert.equal(changed(proposalDiff('', 'added').after), 'added');
  assert.equal(changed(proposalDiff('removed', '').before), 'removed');
});

test('formulas and inline formatting are atomic; Unicode and all whitespace round trip', () => {
  const formulas = ['$x_1$', '$$x + y$$', '\\(x_1\\)', '\\[x+y\\]', '\\begin{align}x &= y\\end{align}'];
  for (const raw of formulas) {
    const diff = proposalDiff(`Before ${raw}.`, `After ${raw}.`);
    assert.equal(diff.before.find(r => r.kind === 'math')?.raw, raw);
    assert.equal(diff.after.find(r => r.kind === 'math')?.changed, false);
  }
  const math = proposalDiff('Let $x_1$ be fixed.', 'Let $x_2$ be fixed.');
  assert.equal(changed(math.before), '$x_1$'); assert.equal(changed(math.after), '$x_2$');
  assert.equal(math.before.find(r => r.kind === 'math')?.tex, 'x_1');
  for (const text of ['\u4e24\u4e2a\u6587\u4ef6\u63cf\u8ff0\u7b26 $c_1$ \u548c $c_2$', 'a\r\n\r\n b\t\ud83d\udc69\u200d\ud83d\udd2c e\u0301',
    '**bold** _italic_ `a_b` [link](https://example.com)', 'Cost \\$5; unmatched $ and \\(; <tag> & text']) {
    assert.equal(proposalTokens(text).map(t => t.raw).join(''), text);
    const diff = proposalDiff(text, `${text}!`);
    assert.equal(diff.before.map(r => r.raw).join(''), text);
    assert.equal(diff.after.map(r => r.raw).join(''), `${text}!`);
  }
  assert.equal(proposalTokens('Cost \\$5 and \\$10').filter(t => t.kind === 'math').length, 0);
  assert.equal(proposalTokens('Use `a_b` and **bold**').filter(t => t.kind === 'markdown').length, 2);
});

test('large unrelated edits have bounded comparison cost and retain every character', () => {
  const a = 'prefix ' + 'old '.repeat(1500) + 'suffix', b = 'prefix ' + 'new '.repeat(1500) + 'suffix';
  const diff = proposalDiff(a, b);
  assert.equal(diff.before.map(r => r.raw).join(''), a);
  assert.equal(diff.after.map(r => r.raw).join(''), b);
  assert.equal(diff.before[0]?.changed, false); assert.equal(diff.after.at(-1)?.changed, false);
});
