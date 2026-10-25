import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingPositions } from '../src/reading-position';

const tick = () => new Promise(resolve => setImmediate(resolve));
const inspection = {
  capture: async () => ({ following: true as const }),
  offset: async () => undefined,
  following: async () => false,
};

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
