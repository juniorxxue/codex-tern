import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingPositions, readingAnchorClass, readingFocus } from '../src/reading-position';

const tick = () => new Promise(resolve => setImmediate(resolve));
const inspection = {
  capture: async () => ({ following: true as const }),
  offset: async () => undefined,
  following: async () => false,
};

const element = (name: string, y: number, height: number) => ({ class: name, rect: [0, y, 800, height] });
const readingLayout = (following = false) => [
  element(`tv${following ? '' : ' scrolled'}`, 100, 600), element('tv-grid', 100, 600), element('sf-main', -500, 1300),
  element(`sf-el ${readingAnchorClass('main.old-reply')}`, -500, 400),
  element(`sf-el ${readingAnchorClass('main.reading-reply')}`, -100, 500),
  element(`sf-el ${readingAnchorClass('main.next-prompt')}`, 400, 60),
  element(`sf-el ${readingAnchorClass('main.next-reply')}`, 460, 400), element('sf-dock', 600, 100),
];

test('scroll focus includes the reply crossing the viewport and switches only as the next prompt reaches it', () => {
  const layout = readingLayout();
  assert.equal(readingFocus(layout)?.node, 'main.reading-reply');
  for (const node of layout) if (node.class.includes('ct-reading-node')) node.rect[1] -= 230;
  assert.equal(readingFocus(layout)?.node, 'main.next-prompt');
  for (const node of layout) if (node.class.includes('ct-reading-node')) node.rect[1] -= 100;
  assert.equal(readingFocus(layout)?.node, 'main.next-reply');
  assert.equal(readingFocus(readingLayout(true))?.node, 'main.next-reply');
});

test('TOC sizing uses its own card and missing or hidden transcript geometry is ignored', () => {
  const layout = [...readingLayout(), element('tv', 300, 200), element('tv-grid', 300, 200), element('sf-list', 342, 100)];
  assert.deepEqual(readingFocus(layout), { node: 'main.reading-reply', lines: 6 });
  assert.equal(readingFocus([...layout, element('sf-col', 450, 38)])?.lines, 4, 'a retry footer keeps its space');
  assert.equal(readingFocus([]), undefined);
  assert.equal(readingFocus([element('tv', 0, 0), element('tv-grid', 0, 0), element('sf-main', 0, 0)]), undefined);
});

test('late window replies and command failures cannot finish a newer restore', async t => {
  const rejections: ((error: Error) => void)[] = [];
  const positions = new ReadingPositions(() => {}, () => 'test', () => {}, () => 16,
    () => new Promise<void>((_, reject) => rejections.push(reject)), true, inspection);
  t.after(() => positions.dispose());
  await positions.capture('first');
  await positions.capture('second');
  const first = positions.restore('first'); await tick();
  const oldToken = positions.request!.token;
  positions.reply(JSON.stringify({ token: oldToken }));
  await first;

  const second = positions.restore('second'); await tick();
  const newToken = positions.request!.token;
  rejections[0]!(new Error('The old command finished late'));
  positions.reply(JSON.stringify({ token: oldToken }));
  await tick();
  assert.equal(positions.request?.token, newToken);
  positions.reply(JSON.stringify({ token: newToken }));
  await second;
  assert.equal(positions.saved.get('first')?.following, true);
  assert.equal(positions.saved.get('second')?.following, true);
});

test('missing window support and a closed UI leave navigation unblocked', async () => {
  const unavailable = new ReadingPositions(() => {}, () => 'test', () => {}, () => 16,
    async () => { throw new Error('Plugin unavailable'); }, true, inspection);
  await unavailable.capture('first'); await unavailable.restore('first');
  assert.equal(unavailable.request, undefined);
  unavailable.dispose();

  const positions = new ReadingPositions(() => {}, () => 'test', () => {}, () => 16,
    async () => {}, true, inspection);
  await positions.capture('second');
  const pending = positions.restore('second'); await tick();
  positions.dispose();
  await pending;
  await positions.capture('closed');
  assert.equal(positions.request, undefined);
  assert.equal(positions.saved.has('closed'), false);
});
