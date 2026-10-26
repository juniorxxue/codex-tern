// Native fork and rename flows with an isolated daemon and a fixed backend.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/session-actions-qa');
const config = resolve(out, `config-${process.pid}`);
const socket = `/tmp/codex-tern-actions-${process.pid}.sock`;
const history = resolve(out, `history-${process.pid}.json`);
const wire = resolve(out, `wire-${process.pid}.jsonl`);
const codexHome = resolve(out, `codex-${process.pid}`);
await prepareTernQaConfig(config);
await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
const env = { ...process.env, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: `/tmp/codex-tern-actions-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, `state-${process.pid}`) };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, encoding: 'utf8' });
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: 'ignore' });
let server;
const results = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
function ctl(command) {
  const result = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { env, encoding: 'utf8', timeout: 15000 }));
  if (!result.ok) throw new Error(`${command}: ${result.error}`);
  return result;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(node => node.text ?? '').join('\n');
const click = selector => ctl(`click ${selector}`);
const key = value => ctl(`key ${value}`);
const type = value => ctl(`type ${JSON.stringify(value)}`);
const row = title => `[data-role="codex-tern.sessions.item"][title="${title}"]`;
const selected = '[data-role="codex-tern.sessions.item"][data-mark="pick"]';
const editor = '[data-role="omp.editor"] .sf-editor';
const draft = () => text('[data-role="omp.editor"] .sf-ed-text');
const threads = () => JSON.parse(readFileSync(history, 'utf8')).threads;
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
function pass(label) { results.push(label); console.log(`PASS ${label}`); }
async function rename(title) {
  const current = tree(selected)[0]?.title;
  click(`${row(title)} right`);
  await wait(() => text('[role="menu"] [role="menuitem"]').includes('Rename session'), 'native context menu');
  assert.deepEqual(tree('[role="menu"] [role="menuitem"]').slice(0, 2).map(node => node.text), ['Rename session', 'Delete session']);
  assert.equal(tree(selected)[0]?.title, current, 'right click does not select the row');
  click('[role="menu"] [role="menuitem"]:first-child');
  await wait(() => tree('[data-role="ct.session.name"]').length === 1, 'rename dialog');
  assert.equal(tree(selected)[0]?.title, current, 'opening Rename does not switch sessions');
}
async function saveName(name) {
  key('Meta+a'); type(name); key('Enter');
  await wait(() => tree('[data-role="ct.session.name"]').length === 0 && tree(row(name)).length === 1, 'saved name');
}
async function send(value) {
  click(editor); type(value); key('Enter');
  await wait(() => text('[data-role="omp.assistant"]').includes(`QA_REPLY: ${value}`), `reply: ${value}`);
}

try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'isolated daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['--control', socket, '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] });
  closeSync(log);
  await wait(() => existsSync(socket), 'native window');
  ctl('resize 1280 1100');
  await wait(() => ctl('state').focused?.prompt, 'shell ready');
  const command = ['env', 'QA_SESSION_FIXTURES=1', `QA_HISTORY_FILE=${history}`, `TERN_TSP_RECORD=${wire}`,
    `QA_CODEX_HOME=${codexHome}`, process.execPath, resolve(root, 'dist/cli.mjs'), '--codex',
    resolve(root, 'test/fixtures/ui-app-server.mjs')].map(quote).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => tree(row('Saved session 1')).length === 1 && text('.sf-dock').includes('QA Model'), 'ready client and sidebar');
  assert.equal(tree('[data-role="codex-tern.sessions.delete"]').length, 0);
  assert.equal(tree('[data-role="ct.reply.fork"]').length, 0, 'blank conversations have no fork action');
  const sourceId = threads().find(t => t.name === 'QA session 1').id;

  click(editor); type('Keep source draft 中文');
  await rename('Saved session 1');
  ctl('shot rename-session');
  key('Meta+a'); type('Cancelled title'); key('Escape');
  assert.equal(tree(row('Saved session 1')).length, 1);
  assert.ok(draft().includes('Keep source draft 中文'));
  await rename('Saved session 1');
  key('Meta+a'); type('   ');
  await wait(() => tree('[aria-label="Save name"][aria-disabled="true"]').length === 1, 'blank name cannot save');
  key('Enter');
  assert.equal(tree('[data-role="ct.session.name"]').length, 1);
  await saveName('重命名 · Draft A');
  assert.equal(tree(selected)[0].title, 'QA session 1');
  assert.ok(draft().includes('Keep source draft 中文'));
  assert.equal(threads().find(t => t.id === 'saved-1').name, '重命名 · Draft A');
  pass('right-click rename saves Unicode names; cancel and empty names preserve the session and message draft');

  await rename('重命名 · Draft A'); key('Meta+a'); type('QA_RENAME_REJECT'); key('Enter');
  await wait(() => text('[data-role="ct.rename.error"]').includes('QA_RENAME_UNAVAILABLE'), 'inline rename failure');
  assert.equal(tree(row('重命名 · Draft A')).length, 1);
  ctl('shot rename-rejected'); key('Escape');
  assert.ok(draft().includes('Keep source draft 中文'));
  pass('failed renames keep the old title and expose an editable dialog error');

  click(editor); key('Meta+a'); key('Backspace');
  await send('First branch point');
  await send('Later reply excluded');
  const firstTurn = threads().find(t => t.id === sourceId).turns[0].id;
  const forkButton = `[data-role="ct.reply.fork"][data-id*="${firstTurn}:"]`;
  await wait(() => tree('[data-role="ct.reply.fork"]').length === 2, 'one footer action per completed reply');
  const footer = tree(forkButton)[0].rect;
  const replyBox = tree(`[data-role="omp.assistant"][data-id*="${firstTurn}:"] .sf-md`)[0].rect;
  assert.ok(footer[1] >= replyBox[1] + replyBox[3], 'fork is below the reply');
  ctl('shot fork-reply-footer');
  click('[data-role="omp.composer.model"]');
  await wait(() => text('.sf-layer').includes('Other Model'), 'model picker');
  type('Other Model'); key('Enter');
  await wait(() => text('[data-role="omp.composer.model"]').includes('Other Model'), 'source model selected');
  click('[data-role="omp.composer.effort"]');
  await wait(() => text('.sf-layer').includes('Reasoning effort'), 'effort picker');
  type('low'); key('Enter');
  await wait(() => text('[data-role="omp.composer.effort"]').includes('low'), 'source effort selected');
  type('hold'); key('Enter');
  await wait(() => tree('[data-role="omp.composer.stop"]').length === 1, 'source task running');
  type('Source draft 中文');
  await rename('QA session 1'); await saveName('Source running');
  assert.equal(tree(`${row('Source running')} [data-role="codex-tern.sessions.running"]`).length, 1);
  assert.ok(draft().includes('Source draft 中文'));
  assert.equal(tree('[data-role="ct.reply.fork"]').length, 2, 'the live turn gets no fork action');
  pass('a running session can be renamed without stopping work or clearing its draft');

  click(forkButton);
  await wait(() => tree(selected)[0]?.title === 'Fork of Source running' && tree('[data-role="ct.fork.origin"]').length === 1, 'selected fork');
  assert.ok(text('[data-role="omp.assistant"]').includes('First branch point'));
  assert.ok(!text('[data-role="omp.assistant"]').includes('Later reply excluded'));
  assert.equal(tree('[data-role="omp.composer.stop"]').length, 0);
  assert.ok(['', 'Message Codex…'].includes(draft().trim()), 'new fork has no draft');
  assert.equal(tree('[data-role="omp.composer.send"][aria-disabled="true"]').length, 1);
  const fork = threads().find(t => t.forkedFromId === sourceId);
  assert.equal(fork.cwd, root); assert.deepEqual(fork.turns.map(t => t.id), [firstTurn]);
  assert.equal(fork.model, 'other-model'); assert.equal(fork.reasoningEffort, 'low');
  assert.ok(text('[data-role="omp.composer.model"]').includes('Other Model'));
  assert.ok(text('[data-role="omp.composer.effort"]').includes('low'));
  assert.equal(threads().find(t => t.id === sourceId).turns.length, 3);
  await wait(() => tree(`${row('Source running')} [data-role="codex-tern.sessions.running"]`).length === 1, 'source still working in background');
  ctl('shot fork-selected');
  pass('fork from an earlier reply includes exactly that history in the same folder while the source keeps running');

  type('Fork draft'); click('[aria-label="Open source session"]');
  await wait(() => tree(selected)[0]?.title === 'Source running' && draft().includes('Source draft 中文'), 'source restored');
  assert.ok(text('[data-role="omp.assistant"]').includes('Later reply excluded'));
  click('[data-role="omp.composer.stop"]');
  await wait(() => tree('[data-role="omp.composer.stop"]').length === 0, 'stop source task');
  click(row('Fork of Source running'));
  await wait(() => draft().includes('Fork draft'), 'fork draft restored');
  await rename('Fork of Source running'); await saveName('Branch A');
  key('Control+l');
  await wait(() => text('.sf-layer').includes('Branch A') && text('.sf-layer').includes('重命名 · Draft A'), 'history picker has renamed titles');
  key('Escape');
  pass('source and fork keep independent drafts, and new names reach the history picker');

  key('Control+q');
  await wait(() => text('.sf-main').includes('The Codex client is closed.'), 'client exit');
  ctl('ready'); ctl(`run ${JSON.stringify(command)}`);
  await wait(() => tree(selected)[0]?.title === 'Branch A' && tree('[data-role="ct.fork.origin"]').length === 1, 'fork restored after relaunch');
  assert.ok(draft().includes('Fork draft'));
  assert.ok(!text('[data-role="omp.assistant"]').includes('Later reply excluded'));
  assert.equal(tree(row('重命名 · Draft A')).length, 1);
  assert.ok(text('[data-role="omp.composer.model"]').includes('Other Model'));
  assert.ok(text('[data-role="omp.composer.effort"]').includes('low'));
  click(editor); key('Meta+a'); key('Backspace');
  await send('Continue the fork');
  const continued = threads().find(t => t.id === fork.id).turns.at(-1);
  assert.equal(continued.model, 'other-model'); assert.equal(continued.effort, 'low');
  pass('fork inherits the source model and effort, including its first send after relaunch');
  const events = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
  pass('fork history, source link and renamed titles survive relaunch without native protocol errors');
} catch (error) {
  try {
    ctl('shot failed');
    await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2));
    await writeFile(resolve(out, 'failed-state.json'), JSON.stringify(ctl('state'), null, 2));
  } catch { /* Preserve the original failure. */ }
  throw error;
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed: results }, null, 2));
  try { key('Control+q'); } catch {}
  try { ctl('quit'); } catch { server?.kill(); }
  daemon.kill();
}
