// Real native scrolling, using two long saved conversations and no model calls.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/reading-position-qa');
const config = resolve(out, `config-${process.pid}`);
const socket = `/tmp/codex-tern-reading-${process.pid}.sock`;
await prepareTernQaConfig(config);
const history = resolve(out, `history-${process.pid}.json`);
const wire = resolve(out, `wire-${process.pid}.jsonl`);
const codexHome = resolve(out, `codex-home-${process.pid}`);
await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
await writeFile(history, JSON.stringify({ seq: 100, threads: [1, 2].map(n => ({
  id: `saved-${n}`, cwd: root, name: `Reading session ${n}`, preview: '',
  createdAt: 1792558800 - n, updatedAt: 1792558800 - n, recencyAt: 1792558800 - n,
  turns: Array.from({ length: 70 }, (_, i) => ({ id: `turn-${n}-${i}`, status: 'completed', items: [
    { id: `answer-${n}-${i}`, type: 'agentMessage', phase: 'final_answer',
      text: `Session ${n}, paragraph ${i}.\n\nThis is saved history. Read this paragraph, switch to another session, ask a question, and return to the same reading position.` },
  ] })),
})) }));
const env = { ...process.env, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: `/tmp/codex-tern-reading-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, `state-${process.pid}`) };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, encoding: 'utf8' });
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: 'ignore' });
let server;
const pause = ms => new Promise(r => setTimeout(r, ms));
function ctl(command) {
  const reply = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { env, encoding: 'utf8', timeout: 15000 }));
  if (!reply.ok) throw new Error(`${command}: ${reply.error}`);
  return reply;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(n => n.text ?? '').join('\n');
const key = chord => ctl(`key ${chord}`);
const click = selector => ctl(`click ${selector}`);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function wait(check, label) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (check()) return;
    if (existsSync(socket)) ctl('wait 75');
    await pause(75);
  }
  throw new Error(`Timed out: ${label}`);
}
function position() {
  const top = tree('.tv-grid')[0].rect[1], bottom = tree('.sf-dock')[0].rect[1];
  const node = tree('[data-role="omp.assistant"]').find(n => n.rect[1] >= top && n.rect[1] < bottom);
  assert.ok(node, 'a saved reply is visible');
  return { text: node.text, y: node.rect[1] };
}
function assertPosition(expected, label) {
  const actual = position();
  assert.equal(actual.text, expected.text, `${label}: same paragraph`);
  assert.ok(Math.abs(actual.y - expected.y) <= 16, `${label}: same reading line (${actual.y} vs ${expected.y})`);
  console.log(`PASS ${label}`);
}
async function select(n) {
  click(`[data-role="codex-tern.sessions.item"][title="Reading session ${n}"]`);
  await wait(() => text('[data-role="omp.assistant"]').includes(`Session ${n},`), `session ${n}`);
  await pause(350);
}

try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'isolated daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['--control', socket, '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] });
  closeSync(log);
  await wait(() => existsSync(socket), 'native window');
  ctl('resize 1280 1000');
  await wait(() => ctl('state').focused?.prompt, 'shell ready');
  const command = ['env', `QA_HISTORY_FILE=${history}`, `QA_CODEX_HOME=${codexHome}`, `TERN_TSP_RECORD=${wire}`,
    process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs'),
    '--resume', 'saved-1'].map(quote).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => text('.sf-dock').includes('QA Model') && text('[data-role="codex-tern.sessions"]').includes('Reading session 2'), 'client and sidebar');
  await select(2);
  ctl('scroll 53'); ctl('wait 200');
  const reading = position();
  ctl('shot reading-before');
  await select(1);
  ctl('scroll -100000');
  for (const question of ['First prompt', 'Second prompt']) {
    click('[data-role="omp.editor"] .sf-editor'); key('Meta+a'); key('Backspace');
    ctl(`type ${JSON.stringify(question)}`); key('Enter');
    await wait(() => text('[data-role="omp.assistant"]').includes(`QA_REPLY: ${question}`), question);
  }
  await select(2);
  assertPosition(reading, 'passive reading survives questions in another session');
  ctl('shot reading-restored');
  ctl('scroll 19'); ctl('wait 200');
  const newer = position();
  await select(1); await select(2);
  assertPosition(newer, 'a later reading position replaces the old one');
  await select(2);
  assertPosition(newer, 'selecting the current session leaves the viewport alone');
  // Input queued immediately after a click belongs to the destination, even
  // while the source's long transcript is being inspected for its bookmark.
  click('[data-role="codex-tern.sessions.item"][title="Reading session 1"]');
  click('[data-role="omp.editor"] .sf-editor'); ctl('type "Immediate prompt"'); key('Enter');
  await wait(() => text('[data-role="omp.assistant"]').includes('Session 1,')
    && text('[data-role="omp.assistant"]').includes('QA_REPLY: Immediate prompt'), 'immediate input in destination session');
  await select(2);
  assertPosition(newer, 'immediate input reaches the destination without losing the reading position');
  // New output in the bookmarked conversation must not move the saved message.
  click('[data-role="omp.editor"] .sf-editor'); ctl('type "background"'); key('Enter');
  await wait(() => tree('[data-role="omp.composer.stop"]').length === 1, 'background turn starts');
  ctl('scroll 12'); ctl('wait 150');
  const backgroundReading = position();
  await select(1); await pause(1600); await select(2);
  assertPosition(backgroundReading, 'background output preserves the bookmarked message');
  const beforeReload = position();
  key('Control+Shift+r'); await pause(500);
  await select(1); await select(2);
  assertPosition(beforeReload, 'reading positions survive UI reload');
  ctl('scroll -100000'); ctl('wait 200');
  const tail = position();
  await select(1); await select(2);
  assertPosition(tail, 'returning from the live end stays at the live end');
  const events = (await readFile(wire, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed: true }, null, 2));
} catch (error) {
  try {
    ctl('shot failed');
    await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2));
  } catch { /* A failed launch may have no window. */ }
  throw error;
} finally {
  try { ctl('quit'); } catch { /* A failed launch may have no window. */ }
  server?.kill(); daemon.kill();
}
