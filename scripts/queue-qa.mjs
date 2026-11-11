// Native queue layout and Activity summary checks against a deterministic backend.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/queue-style-qa', `run-${process.pid}`);
const config = resolve(out, 'config'), home = resolve(out, 'codex');
const socket = `/tmp/ct-queue-${process.pid}.sock`, wire = resolve(out, 'wire.jsonl');
await prepareTernQaConfig(config);
await mkdir(resolve(home, 'thread-writer-locks'), { recursive: true });
const env = { ...process.env, TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: `/tmp/ct-queue-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, 'state'), STENCIL_LOG_DIR: resolve(out, 'logs') };
for (const k of ['TERN_PANE', 'TERN_WINDOW_KEY', 'TERN_WINDOW_SOCKET']) delete env[k];
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, stdio: 'ignore' });
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: 'ignore' });
let server;
const pause = ms => new Promise(r => setTimeout(r, ms));
function ctl(command) {
  const r = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { env, encoding: 'utf8', timeout: 15000 }));
  if (!r.ok) throw new Error(command + ': ' + r.error); return r;
}
const tree = s => ctl(`tree ${s}`).nodes ?? [];
const text = s => tree(`${s}, ${s} *`).map(n => n.text ?? '').filter(Boolean).join('\n');
const click = s => ctl(`click ${s}`), type = s => ctl('type ' + JSON.stringify(s)), key = s => ctl('key ' + s);
async function wait(check, label) { for (let n = 0; n < 120; n++) { if (check()) return; await pause(100); } throw new Error(label); }
function theme(value) {
  ctl('carly lua ' + JSON.stringify(`cx.settings:set("theme", "${value}")`));
  ctl('carly close');
}
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const editor = '[data-role="omp.editor"] .sf-editor';
async function send(value) { click(editor); type(value); key('Enter'); }
function assertActivity() {
  const button = ctl('dump .ct-activity-toggle').elements[0];
  const label = tree('[data-role="ct.activity.state"]')[0];
  assert.equal(button.backgroundColor, 'rgba(0, 0, 0, 0)', 'Activity has no default button background');
  assert.ok(label.rect[0] - button.rect[0] < 60, 'Activity summary stays left aligned');
}
async function shot(name) {
  ctl('wait 250'); ctl('move 5 5'); assertActivity();
  const layout = ctl('dump [data-role="omp.queue"], [data-role="omp.queue"] *');
  assert.equal(layout.header.theme === 'light', name.endsWith('light'), 'requested theme is active');
  await writeFile(resolve(out, `${name}.json`), JSON.stringify(layout, null, 2));
  ctl('shot ' + name);
}
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['--control', socket, '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] }); closeSync(log);
  await wait(() => existsSync(socket), 'window'); ctl('resize 1160 760'); theme('Light');
  await wait(() => ctl('state').focused?.prompt, 'shell');
  const command = ['env', `CODEX_HOME=${home}`, `QA_CODEX_HOME=${home}`, `QA_HISTORY_FILE=${resolve(out, 'history.json')}`, `TERN_TSP_RECORD=${wire}`,
    process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs')].map(quote).join(' ');
  ctl('run ' + JSON.stringify(command)); await wait(() => text('.sf-dock').includes('QA Model'), 'composer');
  await send('hold'); await wait(() => tree('[data-role="ct.composer.mode"]').length, 'running');
  click('[data-role="ct.composer.mode"]'); await wait(() => text('.sf-layer *').includes('Send while running'), 'mode');
  type('Queue'); key('Enter'); await wait(() => text('[data-role="ct.composer.mode"] .sf-text').includes('Queue'), 'queue mode');
  await send('\u4e3a\u4ec0\u4e48 spec \u4e0d\u9700\u8981\u8fd9\u4e00\u4e2a\u4fee\u6539\uff1f'); await wait(() => tree('[data-role="omp.queue.item"]').length === 1, 'first queued');
  await shot('single-light');
  click(editor); type('\u518d\u68c0\u67e5\u8fd9\u4e00\u4e2a\u5f88\u957f\u7684\u540e\u7eed\u95ee\u9898\uff0c\u786e\u8ba4\u4e2d\u82f1\u6587\u6df7\u6392\u4e0e\u622a\u65ad\u7684\u663e\u793a\u6548\u679c\u3002'.repeat(5)); key('Shift+Enter'); type('\u7b2c\u4e8c\u884c\u7ee7\u7eed\u68c0\u67e5\u3002'); key('Enter');
  await wait(() => tree('[data-role="omp.queue.item"]').length === 2, 'two queued');
  assert.ok(text('[data-role="omp.queue.count"]').includes('2 queued'));
  await shot('multiple-light');
  click('[data-role="omp.composer.stop"]'); await wait(() => text('[data-role="omp.queue.count"]').includes('paused'), 'paused');
  await shot('paused-light');
  theme('Dark'); await shot('paused-dark');
  ctl('resize 760 640'); await shot('paused-narrow-dark');
  theme('Light'); await shot('paused-narrow-light');
  const rows = tree('[data-role="omp.queue.item"]');
  for (const row of rows) assert.ok(row.rect[3] < 45, 'queue row remains one line');
  for (const control of tree('[data-role="omp.queue.edit"]')) {
    assert.ok(control.rect[2] > 10 && control.rect[3] > 10, 'control has usable bounds');
    assert.ok(control.rect[0] + control.rect[2] <= 760, 'control stays in window');
  }
  click('[data-role="omp.queue.item"]:last-child [aria-label="Remove queued message"]');
  await wait(() => tree('[data-role="omp.queue.item"]').length === 1, 'remove');
  assert.ok(text('[data-role="omp.queue"]').includes('\u4e3a\u4ec0\u4e48 spec'));
  click('[aria-label="Run next"]');
  await wait(() => tree('[data-role="omp.queue"]').length === 0, 'queue drains');
  await wait(() => text('[data-role="omp.assistant"]').includes('QA_REPLY: \u4e3a\u4ec0\u4e48 spec'), 'queued message sent');
  const events = (await readFile(wire, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(events.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
  console.log('PASS queue previews, count, pause, remove and run next; Activity alignment; light/dark and narrow layouts');
  console.log(out);
} catch (error) { try { ctl('shot failure'); await writeFile(resolve(out, 'failure-tree.json'), JSON.stringify(ctl('tree'), null, 2)); console.log(out); } catch {} throw error; } finally { try { ctl('quit'); } catch { server?.kill(); } daemon.kill(); }
