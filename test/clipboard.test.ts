import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PasteStream } from '../src/clipboard/input';
import { EnhancedPasteController } from '../src/clipboard/enhanced-paste';
import { clipboardFilePaths, markdownFileLinks } from '../src/clipboard/files';
import { readSystemClipboard } from '../src/clipboard/system';
import { dimensions, imageMime, pastedImagePaths, savePastedImage, loadImage } from '../src/attachments';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOwyrwDAAJgAYBVGbA3AAAAAElFTkSuQmCC', 'base64');
const osc = (meta: string, payload = '') => `\x1b]5522;type=read:${meta};${payload}\x07`;
const b64 = (text: string) => Buffer.from(text).toString('base64');

test('stream filter handles every packet split and preserves adjacent keys and TSP', () => {
  const packet = osc('status=DATA:mime=' + b64('image/png'), PNG.toString('base64'));
  const before = Buffer.from('\u4e2d\u6587\x1b_tsp;e;{"ev":"ack","sf":"s1","s":1}\x1b\\');
  const after = Buffer.from('\x1b[13uhello🙂');
  const payload = Buffer.concat([before, Buffer.from(packet), after]);
  for (let split = 1; split < payload.length; split++) {
    const keys: Buffer[] = []; const packets: string[] = [];
    const stream = new PasteStream(b => keys.push(b), p => packets.push(p));
    stream.feed(payload.subarray(0, split)); stream.feed(payload.subarray(split)); stream.flush();
    assert.deepEqual(packets, [packet]);
    assert.deepEqual(Buffer.concat(keys), Buffer.concat([before, after]));
  }
});
test('literal protocol-looking text inside bracketed paste is never treated as a clipboard packet', () => {
  const text = Buffer.from(`\x1b[200~text ${osc('status=OK')}\nmore\x1b[201~`);
  const out: Buffer[] = []; const packets: string[] = [];
  const stream = new PasteStream(b => out.push(b), p => packets.push(p));
  for (const byte of text) stream.feed(Buffer.from([byte]));
  stream.flush(); assert.deepEqual(Buffer.concat(out), text); assert.equal(packets.length, 0);
});
test('an oversized packet is discarded through its terminator without leaking base64 into the draft', () => {
  const keys: Buffer[] = []; const errors: string[] = [];
  const stream = new PasteStream(b => keys.push(b), () => assert.fail('oversized packet'), e => errors.push(e), 64);
  stream.feed('\x1b]5522;' + 'A'.repeat(100));
  stream.feed('more-base64'); stream.feed('\x1b'); stream.flush(); stream.feed('\\typed text');
  assert.deepEqual(Buffer.concat(keys).toString(), 'typed text'); assert.equal(errors.length, 1);
});
test('enhanced paste negotiates PNG over text and delivers the original image bytes once', async () => {
  const writes: string[] = []; const images: any[] = []; const texts: string[] = [];
  const controller = new EnhancedPasteController({ write: b => writes.push(b), pasteImage: i => { images.push(i); },
    pasteText: t => texts.push(t), pasteFiles: () => assert.fail('unexpected files'), showStatus: m => assert.fail(m) });
  controller.enable();
  controller.handleInput(osc('status=OK:pw=test'));
  controller.handleInput(osc('status=DATA:mime=' + b64('text/plain')));
  controller.handleInput(osc('status=DATA:mime=' + b64('image/png')));
  controller.handleInput(osc('status=DONE'));
  assert.ok(writes.at(-1)!.includes('mime=' + b64('image/png')));
  controller.handleInput(osc('status=OK'));
  controller.handleInput(osc('status=DATA:mime=' + b64('image/png'), PNG.toString('base64')));
  controller.handleInput(osc('status=DONE'));
  await Promise.resolve();
  assert.equal(images.length, 1); assert.equal(images[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(images[0].data, 'base64'), PNG); assert.deepEqual(texts, []);
  controller.disable(); assert.equal(writes.at(-1), '\x1b[?5522l');
});
test('enhanced paste keeps multiline text exact and supports ST terminators', () => {
  const texts: string[] = [];
  const controller = new EnhancedPasteController({ write: () => {}, pasteImage: () => assert.fail('unexpected image'),
    pasteText: t => texts.push(t), pasteFiles: () => assert.fail('unexpected files'), showStatus: m => assert.fail(m) });
  const text = '  \u4e2d🙂\nsecond line\n';
  const send = (meta: string, payload = '') => controller.handleInput(osc(meta, payload).replace(/\x07$/, '\x1b\\'));
  send('status=OK'); send('status=DATA:mime=' + b64('text/plain')); send('status=DONE');
  send('status=DATA:mime=' + b64('text/plain'), b64(text)); send('status=DONE');
  assert.deepEqual(texts, [text]);
});
test('an unsupported clipboard type is reported and never becomes model input', () => {
  const errors: string[] = []; let sent = false;
  const controller = new EnhancedPasteController({ write: () => {}, pasteImage: () => { sent = true; },
    pasteText: () => { sent = true; }, pasteFiles: () => { sent = true; }, showStatus: m => errors.push(m) });
  controller.handleInput(osc('status=OK')); controller.handleInput(osc('status=DATA:mime=' + b64('application/pdf')));
  controller.handleInput(osc('status=DONE'));
  assert.equal(sent, false); assert.equal(errors.length, 1);
});
test('image data is validated and cached outside the installation for native previews', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'codex-tern-clipboard-'));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
    await rm(cache, { recursive: true, force: true });
  });
  assert.equal(imageMime(PNG), 'image/png'); assert.deepEqual(dimensions(PNG, 'image/png'), { width: 1, height: 1 });
  const saved = await savePastedImage(PNG, 'image/png');
  assert.equal(saved.path.startsWith(join(cache, 'codex-tern', 'attachments') + '/'), true);
  const loaded = await loadImage(saved.path); assert.deepEqual(loaded.bytes, PNG);
  assert.equal(loaded.width, 1); assert.equal(loaded.height, 1);
  await assert.rejects(savePastedImage(Buffer.from('not an image'), 'image/png'), /invalid/);
});
test('path paste recognizes quoted paths, file URLs and screenshot names, while preserving prose', () => {
  assert.deepEqual(pastedImagePaths('"/tmp/Screen Shot.png"', '/tmp'), ['/tmp/Screen Shot.png']);
  assert.deepEqual(pastedImagePaths('file:///tmp/Screen%20Shot.png', '/tmp'), ['/tmp/Screen Shot.png']);
  assert.deepEqual(pastedImagePaths('/tmp/one.png\n/tmp/two.jpg', '/tmp'), ['/tmp/one.png', '/tmp/two.jpg']);
  assert.equal(pastedImagePaths('Please review /tmp/one.png', '/tmp'), undefined);
  assert.equal(pastedImagePaths('https://example.com/image.png', '/tmp'), undefined);
});

test('file URI lists preserve encoded names and reject web or remote references', () => {
  const name = '/tmp/Screen Shot #1 \\ literal \u4e2d.png';
  const uri = pathToFileURL(name).href;
  assert.deepEqual(clipboardFilePaths(`\uFEFF# Copied files\r\n${uri}\r\n${uri}\r\nfile:///tmp/two.jpg\r\n`),
    [name, '/tmp/two.jpg']);
  for (const value of ['', '# no files', 'https://example.com/image.png', 'file://remote-host/image.png',
    'file:///tmp/image.png?query=1', 'file:///tmp/image.png#fragment', 'file:///tmp/%XX.png'])
    assert.throws(() => clipboardFilePaths(value), /Clipboard/);
});

test('copied document links keep names and safely encode Markdown and path punctuation', () => {
  assert.equal(markdownFileLinks(['/tmp/report.pdf', '/tmp/notes.docx']),
    '[report.pdf](/tmp/report.pdf)\n[notes.docx](/tmp/notes.docx)');
  const path = '/tmp/\u4e2d\u6587 [draft] (1) #?& 100% \\_*.pdf';
  const link = markdownFileLinks([path]);
  assert.ok(link.startsWith('[中文 &#91;draft&#93; (1) #?&#38; 100% &#92;&#95;&#42;.pdf]('));
  const destination = link.slice(link.lastIndexOf('](') + 2, -1);
  assert.equal(decodeURIComponent(destination), path);
  assert.doesNotMatch(destination, /[\s()#?&\\]/);
  assert.equal(markdownFileLinks(['/tmp/line\nbreak.pdf']), '[line break.pdf](/tmp/line%0Abreak.pdf)');
});

test('Finder references beat icon pixels and load the original bytes through enhanced paste', async () => {
  const original = new URL('./fixtures/clipboard.png', import.meta.url);
  const writes: string[] = [];
  let delivered!: (bytes: Buffer) => void;
  const delivery = new Promise<Buffer>(resolve => { delivered = resolve; });
  const controller = new EnhancedPasteController({
    write: data => writes.push(data),
    pasteText: () => assert.fail('a copied file is not a text paste'),
    pasteImage: () => assert.fail('the Finder icon must not be requested'),
    pasteFiles: async paths => { delivered((await loadImage(paths[0])).bytes); },
    showStatus: message => assert.fail(message),
  });
  controller.handleInput(osc('status=OK:pw=finder'));
  for (const mime of ['image/png', 'text/plain', 'text/uri-list'])
    controller.handleInput(osc('status=DATA:mime=' + b64(mime)));
  controller.handleInput(osc('status=DONE'));
  assert.ok(writes.at(-1)!.includes(b64('text/uri-list')));
  const payload = Buffer.from(`# Finder selection\r\n${original.href}\r\n`);
  for (const chunk of [payload.subarray(0, 23), payload.subarray(23)])
    controller.handleInput(osc('status=DATA:mime=' + b64('text/uri-list'), chunk.toString('base64')));
  controller.handleInput(osc('status=DONE'));
  assert.deepEqual(await delivery, (await loadImage(original.pathname)).bytes);
});

test('the Kitty MIME listing and native file URL MIME also prefer copied files', async () => {
  const writes: string[] = []; const files: string[][] = [];
  const controller = new EnhancedPasteController({ write: data => writes.push(data),
    pasteText: () => assert.fail('unexpected text'), pasteImage: () => assert.fail('unexpected icon'),
    pasteFiles: paths => { files.push(paths); }, showStatus: message => assert.fail(message) });
  controller.handleInput(osc('status=OK'));
  controller.handleInput(osc('status=DATA:mime=' + b64('.'), b64('image/png public.file-url text/plain')));
  controller.handleInput(osc('status=DONE'));
  assert.ok(writes.at(-1)!.includes(';' + b64('public.file-url')));
  controller.handleInput(osc('status=DATA:mime=' + b64('public.file-url'), b64('file:///tmp/first%20image.png')));
  controller.handleInput(osc('status=DONE'));
  await Promise.resolve();
  assert.deepEqual(files, [['/tmp/first image.png']]);
});

test('invalid file references report an error without requesting the icon as a fallback', async () => {
  const writes: string[] = []; const errors: string[] = [];
  const controller = new EnhancedPasteController({ write: data => writes.push(data),
    pasteText: () => assert.fail('unexpected text'), pasteImage: () => assert.fail('unexpected icon'),
    pasteFiles: () => assert.fail('invalid files must not be delivered'), showStatus: message => errors.push(message) });
  controller.handleInput(osc('status=OK'));
  for (const mime of ['text/uri-list', 'image/png']) controller.handleInput(osc('status=DATA:mime=' + b64(mime)));
  controller.handleInput(osc('status=DONE'));
  controller.handleInput(osc('status=DATA:mime=' + b64('text/uri-list'), b64('https://example.com/file.png')));
  controller.handleInput(osc('status=DONE'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /local file URLs/);
  assert.equal(writes.length, 1);
});

test('system paste reads Finder file references before text or icon pixels', async () => {
  const paths = ['/tmp/first image.png', '/tmp/second.jpg'];
  const content = await readSystemClipboard('/tmp', true, {
    files: async () => paths,
    text: async () => assert.fail('Finder file references do not require plain text'),
    image: async () => assert.fail('Finder icon pixels must never be read'),
  });
  assert.deepEqual(content, { kind: 'files', paths });
});

test('system paste preserves Snipaste image pixels when there are no file references', async () => {
  const image = { data: PNG, mimeType: 'image/png' };
  const content = await readSystemClipboard('/tmp', true, {
    files: async () => [], text: async () => 'Screenshot', image: async () => image,
  });
  assert.deepEqual(content, { kind: 'image', image });
  assert.deepEqual(Buffer.from(content.kind === 'image' ? content.image.data : []), PNG);
});

test('plain image paths never fall through to icon pixels, and plain text keeps its exact content', async () => {
  const text = '"/tmp/Screen Shot.png"';
  assert.deepEqual(await readSystemClipboard('/tmp', true, {
    files: async () => [], text: async () => text, image: async () => assert.fail('unexpected bitmap'),
  }), { kind: 'files', paths: ['/tmp/Screen Shot.png'], text });
  const prose = '  ordinary text\nwith whitespace  ';
  assert.deepEqual(await readSystemClipboard('/tmp', true, {
    files: async () => [], text: async () => prose, image: async () => null,
  }), { kind: 'text', text: prose });
});

test('file-reference read failures never silently fall back to the Finder icon', async () => {
  await assert.rejects(readSystemClipboard('/tmp', true, {
    files: async () => { throw new Error('Clipboard file read failed'); },
    text: async () => assert.fail('unexpected text'), image: async () => assert.fail('unexpected icon'),
  }), /Clipboard file read failed/);
});

test('text-only fields receive file paths as text and never read image pixels', async () => {
  assert.deepEqual(await readSystemClipboard('/tmp', false, {
    files: async () => ['/tmp/image.png', '/tmp/other.png'],
    text: async () => assert.fail('unexpected text read'), image: async () => assert.fail('unexpected image read'),
  }), { kind: 'text', text: '/tmp/image.png\n/tmp/other.png' });
});
