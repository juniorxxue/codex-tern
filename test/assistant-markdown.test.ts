import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantMarkdown } from '../src/assistant-markdown';

const render = (text: string) => assistantMarkdown(text, '/tmp/project');
const directive = ':codex-file-citation{path="/tmp/main-review.pdf" purpose="output"}';
const link = '[main-review.pdf](/tmp/main-review.pdf)';

test('assistant file citations become local links with one, two or three colons', () => {
  for (const prefix of ['', ':', '::']) assert.equal(render(`See ${prefix}${directive}.`), `See ${link}.`);
  assert.equal(render(':codex-file-citation{artifact_kind=pdf path=docs/report.pdf purpose=output}'),
    '[report.pdf](/tmp/project/docs/report.pdf)');
  assert.equal(render(":codex-file-citation{path='file:///tmp/main-review.pdf'}"), link);
  assert.equal(render(`- **Output:** ${directive}\n\n> Read ${directive}`), `- **Output:** ${link}\n\n> Read ${link}`);
});

test('file links preserve Chinese, spaces, Markdown punctuation and location suffixes', () => {
  const rendered = render(':codex-file-citation{path="/tmp/中文 [draft] (1) #?& 100%.pdf"}');
  assert.equal(rendered, '[中文 &#91;draft&#93; (1) #?&#38; 100%.pdf](/tmp/%E4%B8%AD%E6%96%87%20%5Bdraft%5D%20%281%29%20%23%3F%26%20100%25.pdf)');
  assert.equal(render(':codex-file-citation{path="src/main.ts:12:3"}'), '[main.ts:12:3](/tmp/project/src/main.ts:12:3)');
});

test('code, escaped directives, HTML and existing links stay literal', () => {
  const samples = [
    '`' + directive + '`', '`` example ` ' + directive + ' ``',
    '```markdown\n' + directive + '\n```', '~~~\n' + directive + '\n~~~',
    '> ```\n> ' + directive + '\n> ```', '    ' + directive, '\t' + directive,
    '\\' + directive, `[${directive}](https://example.com)`, `[label](${directive})`,
    `[${directive}][ref]\n\n[ref]: /tmp/example`,
    '<div>\n' + directive + '\n</div>', `[ref]: ${directive}`, '::::' + directive.slice(1),
  ];
  for (const sample of samples) assert.equal(render(sample), sample);
  assert.equal(render('```\n' + directive + '\n```\n\n' + directive), '```\n' + directive + '\n```\n\n' + link);
});

test('partial streaming directives stay readable and become links as soon as complete', () => {
  for (let length = 1; length < directive.length; length++) assert.equal(render(directive.slice(0, length)), directive.slice(0, length));
  assert.equal(render(directive), link);
  assert.equal(render(`${directive}\n\n${directive}`), `${link}\n\n${link}`);
});

test('malformed, duplicate and non-file directives remain literal without blocking later valid links', () => {
  for (const invalid of [
    ':codex-file-citation{}', ':codex-file-citation{path=""}',
    ':codex-file-citation{path="a" path="b"}', ':codex-file-citation{path="a\nb"}',
    ':codex-file-citation{path="https://example.com/a.pdf"}', ':codex-file-citation{path="file://remote/a.pdf"}',
    ':codex-file-citation{path="/tmp/a.pdf" invalid}',
  ]) assert.equal(render(`${invalid}\n\n${directive}`), `${invalid}\n\n${link}`);
  const malformed = ':codex-file-citation{path='.repeat(4000);
  assert.equal(render(malformed), malformed);
});
