// Native preferences and dialog layouts with an isolated profile and a fixed backend.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/settings-qa');
const config = resolve(out, `config-${process.pid}`);
const socket = `/tmp/codex-tern-settings-${process.pid}.sock`;
const history = resolve(out, `history-${process.pid}.json`);
const wire = resolve(out, `wire-${process.pid}.jsonl`);
const codexHome = resolve(out, `codex-${process.pid}`);
await prepareTernQaConfig(config);
await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
const env = { ...process.env, TERN_CONFIG_DIR: config,
  TERN_DAEMON_SOCKET: `/tmp/codex-tern-settings-daemon-${process.pid}.sock`,
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
const text = selector => tree(selector === '.sf-layer' ? '.sf-layer *' : selector).map(node => node.text ?? '').join('\n');
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
async function shot(name) { await pause(400); ctl(`shot ${name}`); }
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


  async function menu(value) {
    click('[aria-label="More actions"]');
    await wait(() => text('.sf-layer').includes('Actions'), 'actions menu');
    type(value); key('Enter');
  }
  async function details() {
    await menu('Session details');
    await wait(() => tree('[data-role="ct.dialog.details"]').length === 1, 'details dialog');
    await pause(300);
  }
  async function workspace() {
    click('[data-role="omp.status.path"]');
    await wait(() => tree('[data-role="ct.workspace.path"]').length === 1, 'workspace dialog');
    await pause(300);
  }
  const preferenceFile = resolve(env.XDG_STATE_HOME, 'codex-tern/preferences.json');
  const longFolder = resolve(root, '.prototype/settings-qa/A workspace with a long folder name/中文 research notes');
  await mkdir(longFolder, {recursive:true});
  click(editor); type('hold'); key('Enter');
  await wait(() => tree('[data-role="omp.composer.stop"]').length === 1, 'live task');
  type('Keep my current draft');
  await details();
  assert.ok(text('.sf-layer').includes('Workspace and allowed folders'));
  assert.equal(tree('[aria-label="Change session model"][aria-disabled="true"]').length, 1);
  await shot('details-light');
  click('[aria-label="New session model"]');
  await wait(() => text('.sf-layer').includes('Use Codex default'), 'default picker');
  await shot('default-model');
  type('Other Model'); key('Enter');
  await wait(() => tree('[data-role="ct.dialog.details"]').length === 1 && existsSync(preferenceFile), 'saved default');
  assert.equal(JSON.parse(readFileSync(preferenceFile,'utf8')).defaultModel, 'other-model');
  key('Escape');
  assert.ok(text('[data-role="omp.composer.model"]').includes('QA Model'));
  assert.equal(tree('[data-role="omp.composer.stop"]').length, 1);
  assert.ok(draft().includes('Keep my current draft'));
  pass('default model saves without changing the running session or its draft');

  key('Control+Shift+n');
  await wait(() => text('[data-role="omp.composer.model"]').includes('Other Model'), 'new session uses default');
  assert.equal(threads().at(-1).model, 'other-model');
  assert.equal(tree(`${row('QA session 1')} [data-role="codex-tern.sessions.running"]`).length, 1);
  await workspace();
  key('Meta+a'); type('/missing/codex-tern-folder');
  click('[aria-label="Create session"]');
  await wait(() => text('[data-role="ct.workspace.error"]').includes('existing folder'), 'inline invalid directory error');
  await shot('workspace-error');
  key('Meta+a'); type(longFolder);
  click('[aria-label="New session model"]');
  await wait(() => text('.sf-layer').includes('Use Codex default'), 'workspace model selector');
  key('Escape');
  assert.ok(text('[data-role="ct.workspace.path"]').includes('research notes'));
  await shot('workspace-light');
  click('[aria-label="Browse folders"]');
  await wait(() => text('.sf-layer').includes('Choose a folder') && text('.sf-layer').includes('Parent folder'), 'folder browser');
  await shot('folder-browser');
  const use = tree('button').find(n => n.text === 'Use this folder');
  assert.ok(use); click(`${use.rect[0] + use.rect[2]/2} ${use.rect[1] + use.rect[3]/2}`);
  await wait(() => tree('[data-role="ct.workspace.path"]').length === 1, 'picked folder');
  click('[aria-label="Create session"]');
  await wait(() => tree('[data-role="ct.workspace.path"]').length === 0 && tree('[data-role="omp.status.path"]')[0]?.title === longFolder, 'workspace created');
  assert.equal(threads().at(-1).model, 'other-model');
  pass('workspace handles invalid paths, keeps drafts across pickers, browses folders, and creates with the saved model');

  ctl('prefs appearance'); await pause(400);
  const dark = tree('.pf button').find(n => n.text === 'Dark');
  assert.ok(dark); click(`${dark.rect[0]+dark.rect[2]/2} ${dark.rect[1]+dark.rect[3]/2}`);
  ctl('prefs close'); await pause(300);
  await workspace(); await shot('workspace-dark'); key('Escape');
  await details(); await shot('details-dark');
  ctl('resize 760 900'); await pause(350); await shot('details-narrow'); key('Escape');
  await workspace(); await shot('workspace-narrow'); key('Escape');
  pass('details and workspace render in light, dark and narrow windows');

  // End only the fixture task before relaunching the isolated client.
  key('Control+l');
  await wait(() => text('.sf-layer').includes('This workspace'), 'history scope');
  await pause(400);
  const scope = tree('button').find(n => n.text === 'This workspace');
  assert.ok(scope); click(`${scope.rect[0]+scope.rect[2]/2} ${scope.rect[1]+scope.rect[3]/2}`);
  await wait(() => text('.sf-layer').includes('QA session 1'), 'all workspaces');
  type('QA session 1'); key('Enter');
  await wait(() => tree('[data-role="omp.composer.stop"]').length === 1, 'original task');
  click('[data-role="omp.composer.stop"]');
  await wait(() => tree('[data-role="omp.composer.stop"]').length === 0, 'fixture stopped');
  key('Control+q'); await wait(() => text('.sf-main').includes('The Codex client is closed.'), 'client closed');
  ctl('ready'); ctl(`run ${JSON.stringify(command)}`);
  await wait(() => tree('[aria-label="More actions"]').length === 1 && text('.sf-dock').includes('QA Model'), 'restored original model');
  key('Control+Shift+n'); await wait(() => text('[data-role="omp.composer.model"]').includes('Other Model'), 'persisted new-session default');
  await menu('New session model');
  await wait(() => text('.sf-layer').includes('Use Codex default'), 'reset default');
  type('Use Codex default'); key('Enter');
  await wait(() => !JSON.parse(readFileSync(preferenceFile,'utf8')).defaultModel, 'default reset');
  key('Control+Shift+n'); await wait(() => text('[data-role="omp.composer.model"]').includes('QA Model'), 'Codex default restored');
  const events = (await readFile(wire,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(events.filter(e=>e.dir==='in' && e.body?.ev==='error').map(e=>e.body), []);
  pass('default survives relaunch, restored sessions retain their model, and resetting follows Codex again');
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
