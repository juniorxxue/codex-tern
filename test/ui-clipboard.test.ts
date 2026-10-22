import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Session, Surface } from '@stencil-hq/tern';
import { Controller } from '../src/controller';
import { NativeUI } from '../src/ui';
import { EnhancedPasteController } from '../src/clipboard/enhanced-paste';
import { readSystemClipboard } from '../src/clipboard/system';
import { loadImage } from '../src/attachments';
import { type CodexRpc, RpcOutcomeUnknown } from '../src/rpc';

function setup() {
  const calls: { method: string; params: any }[] = [];
  const transport = Object.assign(new EventEmitter(), {
    request: async (method: string, params: any) => {
      calls.push({ method, params }); return { turn: { id: 'turn-1' } };
    },
  });
  const c = new Controller(transport as unknown as CodexRpc, '/tmp');
  c.connection = 'ready'; c.thread = { id: 'thread-1' } as any;
  const blobs: { bytes: Uint8Array; mime: string }[] = [];
  const session = {
    blob: (bytes: Uint8Array, mime: string) => { blobs.push({ bytes, mime }); return 'image-blob'; },
    close: async () => {},
  } as unknown as Session;
  // Clipboard behavior needs no terminal renderer or live Codex process.
  const surface = { closed: true, stylesheet: () => {}, focus: () => {} } as unknown as Surface;
  return { ui: new NativeUI(c, session, surface), c, transport, calls, blobs };
}

test('failed sends preserve newly pasted images and keep the failed input separate', async t => {
  const { ui, c, transport } = setup(); t.after(() => ui.close());
  let reject!: (error: Error) => void;
  transport.request = () => new Promise((_resolve, no) => { reject = no; });
  ui.draft.set('First message'); ui.images = ['/tmp/old.png'];
  const sending = ui.send();
  const path = fileURLToPath(new URL('./fixtures/clipboard.png', import.meta.url));
  await ui.pasteFiles([path]);
  reject(new Error('Rejected')); await sending;
  assert.deepEqual(ui.images, [path]); assert.equal(ui.draft.text, '');
  assert.equal(c.queuePaused, true); assert.equal(c.queue[0]?.text, 'First message');
  assert.deepEqual(c.queue[0]?.images, ['/tmp/old.png']);
});

test('editing and then clearing a new draft does not restore an earlier failed send over it', async t => {
  const { ui, c, transport } = setup(); t.after(() => ui.close());
  let reject!: (error: Error) => void;
  transport.request = () => new Promise((_resolve, no) => { reject = no; });
  ui.draft.set('First message'); const sending = ui.send();
  ui.draft.set('New message'); ui.draft.set('');
  reject(new Error('Rejected')); await sending;
  assert.equal(ui.draft.text, ''); assert.equal(c.queue[0]?.text, 'First message');
});

test('an unknown send outcome stays outside the draft and normal queue', async t => {
  const { ui, c, transport } = setup(); t.after(() => ui.close());
  transport.request = async () => { throw new RpcOutcomeUnknown('turn/start', 8, 'Timed out'); };
  ui.draft.set('Possibly sent'); ui.images = ['/tmp/image.png'];
  await ui.send();
  assert.equal(ui.draft.text, ''); assert.deepEqual(ui.images, []); assert.equal(c.queue.length, 0);
  assert.equal(c.unconfirmed[0]?.text, 'Possibly sent');
  assert.deepEqual(c.unconfirmed[0]?.images, ['/tmp/image.png']);
  ui.draft.set('New draft'); await ui.send(); assert.equal(ui.draft.text, 'New draft');
});

test('a copied PDF inserts a link at the selection, supports undo, and submits as text', async t => {
  const { ui, calls, blobs } = setup(); t.after(() => ui.close());
  ui.draft.set('Read this: old');
  for (let n = 0; n < 3; n++) ui.draft.key({ name: 'left', ctrl: false, alt: false, shift: true, meta: false });
  await ui.pasteFiles(['/tmp/report.pdf']);
  const expected = 'Read this: [report.pdf](/tmp/report.pdf)';
  assert.equal(ui.draft.text, expected);
  assert.deepEqual(ui.images, []); assert.deepEqual(blobs, []);
  ui.draft.undo(); assert.equal(ui.draft.text, 'Read this: old');
  ui.draft.undo(true); assert.equal(ui.draft.text, expected);
  await ui.send();
  assert.deepEqual(calls, [{ method: 'turn/start', params: { threadId: 'thread-1', input: [
    { type: 'text', text: expected, text_elements: [] },
  ] } }]);
});

test('a mixed file selection inserts document links and attaches the original image', async t => {
  const { ui, calls, blobs } = setup(); t.after(() => ui.close());
  const image = fileURLToPath(new URL('./fixtures/clipboard.png', import.meta.url));
  await ui.pasteFiles(['/tmp/notes.md', image, '/tmp/report.pdf']);
  const expected = '[notes.md](/tmp/notes.md)\n[report.pdf](/tmp/report.pdf)';
  assert.equal(ui.draft.text, expected); assert.deepEqual(ui.images, [image]);
  assert.equal(blobs.length, 1); assert.deepEqual(blobs[0].bytes, (await loadImage(image)).bytes);
  await ui.send();
  assert.deepEqual(calls[0].params.input, [
    { type: 'text', text: expected, text_elements: [] }, { type: 'localImage', path: image },
  ]);
});

test('both clipboard routes insert copied PDFs instead of reading Finder icon pixels', async t => {
  const { ui, blobs } = setup(); t.after(() => ui.close());
  const path = '/tmp/copied report.pdf';
  const content = await readSystemClipboard('/tmp', true, {
    files: async () => [path], text: async () => assert.fail('unexpected text read'),
    image: async () => assert.fail('unexpected Finder icon read'),
  });
  assert.equal(content.kind, 'files');
  if (content.kind === 'files') await ui.pasteFiles(content.paths);
  const expected = '[copied report.pdf](/tmp/copied%20report.pdf)';
  assert.equal(ui.draft.text, expected);
  ui.draft.set('');
  const b64 = (value: string) => Buffer.from(value).toString('base64');
  const packet = (metadata: string, payload = '') => `\x1b]5522;type=read:${metadata};${payload}\x07`;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const delivered = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const paste = new EnhancedPasteController({ write: () => {},
    pasteText: () => assert.fail('unexpected text fallback'),
    pasteImage: () => assert.fail('unexpected Finder icon'),
    pasteFiles: paths => ui.pasteFiles(paths).then(finish, fail), showStatus: message => fail(new Error(message)),
  });
  paste.handleInput(packet('status=OK'));
  for (const mime of ['application/pdf', 'image/png', 'text/uri-list'])
    paste.handleInput(packet('status=DATA:mime=' + b64(mime)));
  paste.handleInput(packet('status=DONE'));
  paste.handleInput(packet('status=DATA:mime=' + b64('text/uri-list'), b64(pathToFileURL(path).href)));
  paste.handleInput(packet('status=DONE'));
  await delivered;
  assert.equal(ui.draft.text, expected); assert.deepEqual(ui.images, []); assert.deepEqual(blobs, []);
});
