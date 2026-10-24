import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Node, type ActionEvent } from '@stencil-hq/tern';
import { localFilePath, showInFinder } from '../src/file-links';
import { FileMarkdown } from '../src/file-markdown';
import { markdownFileLinks } from '../src/clipboard/files';

test('file destinations resolve against the conversation and distinguish locations from encoded filename punctuation', () => {
  const cwd = '/tmp/project';
  for (const suffix of [':12', ':12:3', ':12-20', '#L12', '#L12-L20']) {
    assert.equal(localFilePath(`./main.pdf${suffix}`, cwd), '/tmp/project/main.pdf');
  }
  const path = '/tmp/中文 [draft] (1) #?& 100%:12.txt';
  assert.equal(localFilePath(encodeURI(path).replaceAll('#', '%23').replaceAll('?', '%3F'), cwd), path);
  assert.equal(localFilePath(pathToFileURL(path).href, cwd), path);
  assert.equal(localFilePath('/tmp/name%23L12', cwd), '/tmp/name#L12');
  assert.equal(localFilePath('/tmp/name%3A12', cwd), '/tmp/name:12');
  assert.equal(localFilePath('~/main.pdf', cwd), `${homedir()}/main.pdf`);
  assert.equal(localFilePath('../main.pdf', cwd), '/tmp/main.pdf');
  for (const href of ['https://example.com/a.pdf', 'mailto:test@example.com', '//server/a.pdf',
    'file://remote/a.pdf', 'file:///tmp/a.pdf?download', '#section', '?query', '/tmp/%00', '/tmp/%FF', '']) {
    assert.equal(localFilePath(href, cwd), undefined, href);
  }
});

const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
function render(text: string, onReveal: (path: string) => void = () => {}) {
  const node = FileMarkdown({ text, cwd: '/tmp/project', onReveal });
  assert.ok(node instanceof Node);
  return nodes(node);
}

test('menus target the particular file among multiple links and reference links', { skip: process.platform !== 'darwin' }, () => {
  const revealed: string[] = [];
  const tree = render('Read [one](./one.pdf) and **[two][result]**; [web](https://example.com).\n\n[result]: <two space.pdf>',
    path => revealed.push(path));
  const links = tree.filter(node => node.props.role === 'ct.file-link');
  assert.equal(links.length, 2);
  links[1]!.handlers!.onMenu!['Show in Finder']!({} as ActionEvent);
  links[0]!.handlers!.onMenu!['Show in Finder']!({} as ActionEvent);
  assert.deepEqual(revealed, ['/tmp/project/two space.pdf', '/tmp/project/one.pdf']);
  assert.ok(tree.some(node => node.props.tag === 'strong'));
  assert.ok(tree.some(node => typeof node.props.text === 'string' && node.props.text.startsWith('and\n\n')));
});

test('links in lists and tables work while code, images, URLs and math remain literal', { skip: process.platform !== 'darwin' }, () => {
  const file = markdownFileLinks(['/tmp/中文 #?& 100%.pdf']);
  const tree = render(`- ${file}\n\n| File |\n| --- |\n| [two](two.pdf) |\n\n` +
    '`[code](code.pdf)`\n\n```md\n[fenced](fenced.pdf)\n```\n\n' +
    '$[math](math.pdf)$\n\n![image](image.png)\n\n[web](https://example.com)');
  assert.deepEqual(tree.filter(node => node.props.role === 'ct.file-link').map(node => node.props.title),
    ['/tmp/中文 #?& 100%.pdf', '/tmp/project/two.pdf']);
  assert.equal(render('No files: **hello** and $x^2$.')[0]!.kind, 'md');
  assert.equal(render('[unfinished](./main.pdf')[0]!.kind, 'md');
});

test('a missing file reports an error before launching Finder', { skip: process.platform !== 'darwin' }, async () => {
  await assert.rejects(showInFinder(`/tmp/codex-tern-missing-${process.pid}/main.pdf`), /Could not find this file/);
});

test('adding file menus preserves explicit list numbering and hard line breaks', { skip: process.platform !== 'darwin' }, () => {
  const tree = render('3. [one](one.pdf)\n4. [two](two.pdf)\n\nFirst line  \n[three](three.pdf)');
  const text = tree.map(node => node.props.text);
  assert.ok(text.includes('3.')); assert.ok(text.includes('4.'));
  assert.ok(tree.some(node => node.props.class === 'br'));
});
