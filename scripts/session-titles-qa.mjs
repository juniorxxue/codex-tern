// Background naming and its reveal in an isolated native window, without a model.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/session-titles-qa');
const config = resolve(out, `config-${process.pid}`);
const socket = `/tmp/codex-tern-titles-${process.pid}.sock`;
const history = resolve(out, `history-${process.pid}.json`);
const wire = resolve(out, `wire-${process.pid}.jsonl`);
const logFile = resolve(out, `rpc-${process.pid}.jsonl`);
const release = resolve(out, `release-${process.pid}`);
const codexHome = resolve(out, `codex-${process.pid}`);
await prepareTernQaConfig(config);
await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
const env = { ...process.env, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: `/tmp/codex-tern-titles-daemon-${process.pid}.sock`,
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
const events = () => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function wait(check, label, interval = 50) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (check()) return;
    await pause(interval);
  }
  throw new Error(`Timed out: ${label}`);
}
function pass(label) { results.push(label); console.log(`PASS ${label}`); }
function sameBounds(actual, expected) {
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 0.5),
    `Layout moved: ${JSON.stringify({ actual, expected })}`);
}

try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'isolated daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['--control', socket, '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] });
  closeSync(log);
  await wait(() => existsSync(socket), 'native window');
  ctl('resize 1280 900');
  await wait(() => ctl('state').focused?.prompt, 'shell ready');
  const generated = '后台自动命名会话';
  const command = ['env', 'QA_SESSION_FIXTURES=1', `QA_EMPTY_SESSION_CWD=${root}`, `QA_HISTORY_FILE=${history}`,
    `TERN_TSP_RECORD=${wire}`, `QA_RPC_LOG=${logFile}`, `QA_TITLE_RELEASE_FILE=${release}`,
    `QA_GENERATED_TITLE=${generated}`, `QA_CODEX_HOME=${codexHome}`, process.execPath,
    resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs')].map(quote).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => tree(row('Saved session 1')).length === 1 && text('.sf-dock').includes('QA Model'), 'ready client and sidebar');
  const prompt = 'hold 请在后台为这个会话生成简短标题，同时保留我正在输入的草稿，切换会话也不要影响任务';
  click(editor); type(prompt); key('Enter');
  await wait(() => tree(row(prompt)).length === 1 && events().some(e => e.ephemeral), 'prompt preview and background generation');
  const original = threads().find(t => t.preview === prompt).id;
  assert.equal(tree('[data-role="omp.composer.stop"]').length, 1);
  const sourceDraft = '这段草稿需要保留，光标和输入不能被打断';
  type(sourceDraft);
  click(row('Saved session 1'));
  await wait(() => tree(selected)[0]?.title === 'Saved session 1', 'switch while naming');
  click(editor); type('另一个会话的草稿');
  click(row(prompt));
  await wait(() => draft().includes(sourceDraft), 'original draft restored');
  click(editor); type('，继续输入');
  const before = { editor: tree(editor)[0].rect, rows: tree('[data-role="codex-tern.sessions.item"]').length,
    row: tree(selected)[0].rect, draft: draft() };
  ctl('shot title-preview');
  pass('the first prompt is shown immediately; typing, switching and both drafts work while naming runs');

  await writeFile(release, 'ready');
  await wait(() => tree(`${selected} [data-role="codex-tern.sessions.reveal"][data-mark="reveal"]`).length === 1, 'generated title reveal', 15);
  ctl('shot title-reveal');
  assert.equal(tree(selected)[0]?.title, generated);
  assert.equal(draft(), before.draft);
  sameBounds(tree(editor)[0].rect, before.editor);
  sameBounds(tree(selected)[0].rect, before.row);
  assert.equal(tree('[data-role="codex-tern.sessions.item"]').length, before.rows);
  assert.equal(tree('[data-role="omp.composer.stop"]').length, 1, 'the main task still runs');
  assert.ok(!text('.sf-main').includes('Give this message a concise title'));
  assert.ok(!threads().some(t => t.ephemeral || t.id.startsWith('qa-title-')));
  const mainPid = events().find(e => e.method === 'thread/name/set')?.pid;
  const backgroundPid = events().find(e => e.ephemeral)?.pid;
  assert.ok(mainPid && backgroundPid && mainPid !== backgroundPid);
  assert.equal(threads().find(t => t.id === original).name, generated);
  await pause(800); ctl('shot title-finished');
  pass('the left-to-right title reveal leaves the list, editor, draft and main task unchanged; only the real session is saved');

  await unlink(release);
  click('[data-role="codex-tern.sessions.new"]');
  await wait(() => tree('[data-role="omp.composer.stop"]').length === 0, 'new session');
  const second = 'hold 手动命名优先';
  click(editor); type(second); key('Enter');
  await wait(() => tree(row(second)).length === 1 && events().filter(e => e.ephemeral).length === 2, 'second title job');
  click(`${row(second)} right`);
  await wait(() => text('[role="menu"]').includes('Rename session'), 'rename menu');
  click('[role="menu"] [role="menuitem"]:first-child');
  await wait(() => tree('[data-role="ct.session.name"]').length === 1, 'rename dialog');
  key('Meta+a'); type('我的手动标题'); key('Enter');
  await wait(() => tree(row('我的手动标题')).length === 1, 'manual title saved');
  await writeFile(release, 'late result'); await pause(850);
  assert.equal(tree(selected)[0]?.title, '我的手动标题');
  assert.equal(tree(`${selected} [data-mark="reveal"]`).length, 0);
  pass('a manual rename cancels the background job and stays in place');

  key('Control+q');
  await wait(() => text('.sf-main').includes('The Codex client is closed.'), 'client exit');
  ctl('ready'); ctl(`run ${JSON.stringify(command)}`);
  await wait(() => tree(row(generated)).length === 1 && tree(row('我的手动标题')).length === 1, 'saved titles restored');
  assert.equal(tree('[data-role="codex-tern.sessions.reveal"][data-mark="reveal"]').length, 0);
  const recorded = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(recorded.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
  ctl('shot title-restored');
  pass('saved titles survive relaunch without replaying the animation or leaking native protocol errors');
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
