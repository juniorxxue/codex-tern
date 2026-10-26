// Verify progressive startup in an isolated native window, with no model calls.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/startup-qa');
const config = resolve(out, `config-${process.pid}`);
const gates = resolve(out, `release-${process.pid}`);
const logFile = resolve(out, `rpc-${process.pid}.jsonl`);
const wire = resolve(out, `wire-${process.pid}.jsonl`);
const socket = `/tmp/codex-tern-startup-${process.pid}.sock`;
await prepareTernQaConfig(config);
await mkdir(gates, { recursive: true });
const env = { ...process.env, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: `/tmp/codex-tern-startup-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, `state-${process.pid}`) };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, encoding: 'utf8' });
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: 'ignore' });
let server;
const results = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
function ctl(command) {
  const reply = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { env, encoding: 'utf8', timeout: 15000 }));
  if (!reply.ok) throw new Error(`${command}: ${reply.error}`);
  return reply;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(node => node.text ?? '').join('\n');
const row = title => `[data-role="codex-tern.sessions.item"][title="${title}"]`;
const events = () => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const release = name => writeFile(resolve(gates, name), 'ready\n');
async function wait(check, label) {
  const until = Date.now() + 12000;
  while (Date.now() < until) { if (check()) return; await pause(25); }
  throw new Error(`Timed out: ${label}`);
}
function pass(label) { results.push(label); console.log(`PASS ${label}`); }

try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'isolated daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['--control', socket, '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] });
  closeSync(log);
  await wait(() => existsSync(socket), 'native window');
  await wait(() => ctl('state').focused?.prompt, 'shell ready');
  const command = ['env', 'QA_SESSION_FIXTURES=1', `QA_STARTUP_RELEASE_DIR=${gates}`, `QA_RPC_LOG=${logFile}`,
    `TERN_TSP_RECORD=${wire}`, process.execPath, resolve(root, 'dist/cli.mjs'),
    '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs'), '--resume', 'saved-1'].map(quote).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => tree(row('Cached session 2')).length === 1, 'indexed list while account, history and repair are blocked');
  assert.equal(tree('[data-role="omp.assistant"]').length, 0);
  assert.ok(!text('[data-role="codex-tern.sessions.note"]').includes('disconnected'));
  assert.ok(events().some(e => e.method === 'thread/list' && e.useStateDbOnly));
  assert.ok(events().some(e => e.method === 'thread/list' && !e.useStateDbOnly));
  pass('sidebar displays indexed sessions before account lookup, history loading and metadata repair finish');

  const draft = 'Keep typing during startup';
  ctl('click [data-role="omp.editor"] .sf-editor'); ctl(`type ${JSON.stringify(draft)}`);
  await release('session');
  await wait(() => text('[data-role="omp.assistant"]').includes('QA_SAVED_HISTORY_1')
    && tree('[data-role="omp.composer.send"]').length === 1, 'restored session ready before account lookup');
  assert.ok(text('.sf-ed-text').includes(draft));
  assert.ok(text('.sf-dock').includes('Reading account'));
  assert.equal(tree(row('Cached session 2')).length, 1);
  pass('history and composer become ready while account lookup and list repair remain pending; early typing survives');

  ctl('click [data-role="codex-tern.sessions.note"][data-id$="more"]');
  await release('scan');
  await wait(() => tree(row('Saved session 2')).length === 1 && tree(row('Saved session 5')).length === 1,
    'repaired metadata and queued pagination');
  assert.equal(tree(row('Cached session 2')).length, 0);
  assert.equal(tree('[data-role="codex-tern.sessions.item"][data-mark="pick"]')[0]?.title, 'Saved session 1');
  assert.ok(text('.sf-ed-text').includes(draft));
  pass('background repair updates stale titles and preserves selection, typing and pagination requested during repair');

  await release('account');
  await wait(() => !text('.sf-dock').includes('Reading account'), 'late account text');
  assert.ok(text('.sf-dock').includes('test'));
  assert.ok(text('.sf-ed-text').includes(draft));
  assert.equal(events().some(e => e.method.startsWith('turn/')), false);
  assert.ok(!(await readFile(wire, 'utf8')).includes('"ev":"error"'), 'no native protocol errors');
  pass('late account information updates the ready interface without sending input');
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
} catch (error) {
  try { await writeFile(resolve(out, 'failed-state.json'), JSON.stringify(ctl('state'), null, 2)); } catch {}
  throw error;
} finally {
  try { ctl('quit'); } catch { server?.kill(); }
  daemon.kill();
}
