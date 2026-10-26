import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingPositions, readingAnchorClass, readingPromptMap, readingFocus, sameReadingView } from '../src/reading-position';

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

test('fork and history controls keep the first topic, long replies and pending input keep their preceding topic', () => {
  const nodes = ['origin', 'earlier', 'user-a', 'reply-a', 'user-b', 'reply-b', 'pending'];
  const prompts = new Map([['user-a', 'a'], ['user-b', 'b'], ['pending', 'new']]);
  const mapped = readingPromptMap(nodes, prompts, id => id === 'a' || id === 'b');
  assert.deepEqual([...mapped.values()], ['a', 'a', 'a', 'a', 'b', 'b', 'b']);
  assert.equal(readingPromptMap(nodes, prompts, () => false).size, 0, 'no invented location before indexing');
});

test('scroll focus includes the reply crossing the viewport and switches only as the next prompt reaches it', () => {
  const layout = readingLayout();
  assert.equal(readingFocus(layout)?.node, 'main.reading-reply');
  for (const node of layout) if (node.class.includes('ct-reading-node')) node.rect[1] -= 300;
  assert.equal(readingFocus(layout)?.node, 'main.next-prompt');
  for (const node of layout) if (node.class.includes('ct-reading-node')) node.rect[1] -= 100;
  assert.equal(readingFocus(layout)?.node, 'main.next-reply');
  assert.equal(readingFocus(readingLayout(true))?.node, 'main.next-reply');
});

test('TOC sizing uses its own card and missing or hidden transcript geometry is ignored', () => {
  const layout = [...readingLayout(), element('tv', 300, 200), element('tv-grid', 300, 200), element('sf-list', 342, 100)];
  assert.equal(readingFocus(layout)?.lines, 6);
  assert.equal(readingFocus([...layout, element('sf-col', 450, 38)])?.lines, 4, 'a retry footer keeps its space');
  assert.equal(readingFocus([...layout, element('sf-dock', 466, 24)])?.lines, 5, 'the native canvas dock clips the list before the grid ends');
  assert.equal(readingFocus([...layout, element('sf-text nowrap', 347, 33), element('sf-dock', 466, 24)])?.lines, 3,
    'zoomed labels use their actual line height, not the unscaled 22px style');
  assert.equal(readingFocus([]), undefined);
  assert.equal(readingFocus([element('tv', 0, 0), element('tv-grid', 0, 0), element('sf-main', 0, 0)]), undefined);
});

test('a leftover reply footer cannot hold the old topic after the actual answer has left the viewport', () => {
  const layout = [element('tv scrolled', 45, 844), element('tv-grid', 55, 834), element('sf-main', -1207, 3000),
    element(`sf-el ${readingAnchorClass('main.previous-reply')}`, -1207, 1304), element('sf sf-md', -1207, 1260),
    element(`sf-el ${readingAnchorClass('main.next-prompt')}`, 117, 49),
    element(`sf-el ${readingAnchorClass('main.next-reply')}`, 186, 1304), element('sf sf-md', 186, 1260),
    element('sf-dock', 743, 136)];
  assert.equal(readingFocus(layout)?.node, 'main.next-prompt');
  layout[3]!.rect[1] += 20; layout[4]!.rect[1] += 20;
  assert.equal(readingFocus(layout)?.node, 'main.previous-reply', 'a remaining line of prose still owns the topic');
});

test('adjacent short prompts do not advance the reading topic before the first leaves the viewport', () => {
  const layout = [element('tv scrolled', 45, 844), element('tv-grid', 55, 834), element('sf-main', 55, 4000),
    element(`sf-el ${readingAnchorClass('main.first')}`, 55, 49),
    element(`sf-el ${readingAnchorClass('main.second')}`, 124, 49), element('sf-dock', 743, 136)];
  assert.equal(readingFocus(layout)?.node, 'main.first');
  for (const node of layout) if (node.class.includes('ct-reading-node')) node.rect[1] -= 32;
  assert.equal(readingFocus(layout)?.node, 'main.first', 'partly visible prompt still owns the reading position');
  for (const node of layout) if (node.class.includes('ct-reading-node')) node.rect[1] -= 32;
  assert.equal(readingFocus(layout)?.node, 'main.second');
});

test('reading positions distinguish actual scrolling and new live content from pane movement and background output', () => {
  const layout = readingLayout(), original = readingFocus(layout)!.position!;
  for (const node of layout) node.rect[1] += 120;
  assert.ok(sameReadingView(original, readingFocus(layout)!.position!), 'moving the pane preserves a clicked heading');
  layout.splice(-1, 0, element(`sf-el ${readingAnchorClass('main.new-reply')}`, 1500, 200));
  assert.ok(sameReadingView(original, readingFocus(layout)!.position!), 'new output below the reading area does not undo a jump');
  for (const node of layout) if (node.class.includes('ct-reading-node')) node.rect[1] -= 16;
  assert.equal(sameReadingView(original, readingFocus(layout)!.position!), false, 'one line of scrolling releases the clicked heading');
  const live = readingLayout(true), before = readingFocus(live)!.position!;
  live.splice(-1, 0, element(`sf-el ${readingAnchorClass('main.new-prompt')}`, 900, 60));
  assert.equal(sameReadingView(before, readingFocus(live)!.position!), false, 'new live input resumes automatic following');
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
