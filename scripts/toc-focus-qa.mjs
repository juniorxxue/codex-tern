// Regressions for clicked headings, passive reading and committed session selection. No model calls.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/toc-focus-qa', `run-${process.pid}`);
const config = resolve(out, 'config'), socket = `/tmp/ct-toc-focus-${process.pid}.sock`;
const history = resolve(out, 'history.json'), wire = resolve(out, 'wire.jsonl');
const gates = resolve(out, 'gates'), codexHome = resolve(out, 'codex');
await prepareTernQaConfig(config);
await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
await mkdir(gates, { recursive: true });
for (const gate of ['account', 'session', 'scan']) await writeFile(resolve(gates, gate), 'ready');
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text_elements: [], text }] });
const answer = text => ({ id: 'answer', type: 'agentMessage', phase: 'final_answer', text });
const long = Array.from({length: 4}, () => 'Saved explanation. This passage gives the prompt enough content below it to reach the top of the reading area.').join('\n\n');
const turn = (id, text, reply = long) => ({ id, status: 'completed', items: [user('user', text), answer(reply)] });
const thread = (id, name, turns) => ({ id, name, turns, cwd: root, preview: name,
  createdAt: 1792558800, updatedAt: 1792558800, recencyAt: 1792558800 });
await writeFile(history, JSON.stringify({ seq: 100, threads: [
  thread('short', 'Short chat', ['SCROLLTOPIC1 first', 'BUILD second', 'SCROLLTOPIC2 latest'].map((text, i) => turn(`short-${i}`, text, 'Done.'))),
  thread('shared', 'Shared anchors', Array.from({length: 15}, (_, i) => turn(`shared-${i}`,
    i === 0 ? 'SUBSTITUTION COUNTEREXAMPLE first' : i === 4 ? 'RETURN SUGGEST second' : i === 8 ? 'RETURN third' : `More discussion ${i}`))),
  thread('steering', 'Adjacent prompts', [
    { id: 'steering-0', status: 'completed', items: [user('first', 'SCROLLTOPIC1 first'), user('second', 'BUILD second'), answer(long)] },
    ...Array.from({length: 14}, (_, i) => turn(`steering-${i+1}`, i === 9 ? 'SCROLLTOPIC2 latest' : 'BUILD follow-up')),
  ]),
] }));
const env = { ...process.env, TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: `/tmp/ct-focus-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, 'state') };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, encoding: 'utf8' });
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], {env, stdio: 'ignore'});
let server;
const results = [], pause = ms => new Promise(r => setTimeout(r, ms));
function ctl(command) {
  const result = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], {env, encoding: 'utf8', timeout: 15000}));
  assert.ok(result.ok, result.error); return result;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(n => n.text ?? '').join('\n');
const click = selector => ctl(`click ${selector}`), key = chord => ctl(`key ${chord}`);
const row = title => `[data-role="codex-tern.sessions.item"][title="${title}"]`;
const link = title => `[data-role="codex-tern.toc.link"][title="${title}"]`;
const selected = () => text('[data-role="codex-tern.toc.body"] [data-mark="pick"] [data-role="codex-tern.toc.label"]');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
async function wait(check, label) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { if (check()) return; await pause(60); }
  throw new Error(`Timed out: ${label}`);
}
async function index() {
  await wait(() => tree('[data-role="codex-tern.toc.get"]').length, 'Get TOC');
  click('[data-role="codex-tern.toc.get"]');
  await wait(() => tree('[data-role="codex-tern.toc.link"]').length && !text('[data-role="codex-tern.toc.status"]').includes('Updating'), 'outline');
  await pause(700);
}
async function record(name) {
  const result = { name, selected: selected(),
    prompts: tree('[data-role="omp.user"]').map(n => ({text: n.text, rect: n.rect})),
    terminals: tree('.tv').map(n => ({class: n.class, rect: n.rect})),
    grids: tree('.tv-grid').map(n => n.rect),
    docks: tree('.sf-dock').map(n => n.rect),
  };
  results.push(result); console.log(`PASS ${name}`);
  await writeFile(resolve(out, `${name}-tree.json`), JSON.stringify(ctl('tree'), null, 2));
  ctl(`shot ${name}`);
}
function visiblePrompt(contains) {
  const grid = tree('.tv-grid')[0].rect, dock = tree('.sf-dock')[0].rect;
  return tree('[data-role="omp.user"]').some(n => n.text?.includes(contains) && n.rect[1] >= grid[1] - 20 && n.rect[1] < dock[1]);
}
async function stableSelection(title) {
  await wait(() => selected() === title, `selected ${title}`);
  // Several idle polls must not replace the heading chosen by the reader.
  for (let i = 0; i < 5; i++) { await pause(300); assert.equal(selected(), title); }
}
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['--control', socket, '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] }); closeSync(log);
  await wait(() => existsSync(socket), 'native window'); ctl('resize 1280 900');
  ctl('style islands'); ctl('style glass');
  await wait(() => ctl('state').focused?.prompt, 'shell');
  const command = ['env', 'QA_TOC_FIXTURE=1', `QA_HISTORY_FILE=${history}`, `QA_CODEX_HOME=${codexHome}`,
    `QA_STARTUP_RELEASE_DIR=${gates}`, `TERN_TSP_RECORD=${wire}`, `QA_EMPTY_SESSION_CWD=${root}`,
    process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs'), '--resume', 'short'].map(quote).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await index(); await stableSelection('Topic 2');
  click(link('Topic 1')); await stableSelection('Topic 1');
  await record('short-chat-keeps-clicked-heading');
  key('Control+Shift+r'); await pause(700); await stableSelection('Topic 1');
  await record('clicked-heading-survives-ui-reload');

  await unlink(resolve(gates, 'session'));
  click(row('Shared anchors')); await pause(300);
  assert.equal(text('[data-role="codex-tern.sessions.item"][data-mark="pick"]'), 'Short chat');
  assert.equal(text('[data-role="codex-tern.sessions.item"][data-mark="pending"]'), 'Shared anchors');
  assert.equal(selected(), 'Topic 1');
  assert.ok(visiblePrompt('SCROLLTOPIC1 first'));
  await record('pending-session-keeps-current-transcript-and-toc');
  await writeFile(resolve(gates, 'session'), 'ready');
  await index();
  assert.equal(text('[data-role="codex-tern.sessions.item"][data-mark="pick"]'), 'Shared anchors');
  click(link('Substitution rule')); await stableSelection('Substitution rule');
  await record('shared-anchor-keeps-clicked-parent');
  click('[data-role="codex-tern.toc.visits"]');
  await wait(() => visiblePrompt('RETURN SUGGEST second'), 'second visit');
  await stableSelection('Substitution rule');
  // Scrolling releases explicit selection and highlights the child. The parent
  // visit must still be available to the next-visit action after that change.
  ctl('scroll -2'); await stableSelection('Proposed repair');
  click('[data-role="codex-tern.toc.visits"]');
  await wait(() => visiblePrompt('RETURN third'), 'third visit after child highlighting');
  await stableSelection('Substitution rule');
  await record('parent-visit-advances-after-child-highlighting');
  click('[data-role="codex-tern.toc.visits"]');
  await wait(() => visiblePrompt('SUBSTITUTION COUNTEREXAMPLE first'), 'visits wrap to opening');
  await stableSelection('Substitution rule');

  click(row('Short chat')); await stableSelection('Topic 1');
  await record('clicked-heading-survives-session-switch');

  click(row('Adjacent prompts')); await index();
  click(link('Topic 1')); await stableSelection('Topic 1');
  assert.ok(visiblePrompt('SCROLLTOPIC1 first'));
  await record('adjacent-prompts-keep-first-topic');
  ctl('scroll -2'); await stableSelection('Topic 1');
  ctl('scroll -3'); await stableSelection('Build failure');
  await record('manual-scroll-advances-when-first-prompt-leaves');
  ctl('scroll -100000'); await stableSelection('Topic 2');
  await record('live-end-follows-latest-topic');
  ctl('resize 880 650'); await pause(700); await record('narrow-layout');
  ctl(`carly lua ${JSON.stringify('cx.settings:set("theme", "Dark")')}`); ctl('carly close');
  await pause(2500); await record('dark-layout');
  const recorded = (await readFile(wire, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
} catch (error) {
  try { ctl('shot failed'); await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2)); } catch {}
  throw error;
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Focus QA: ${out}`);
  try { key('Control+q'); } catch {}
  try { ctl('quit'); } catch { server?.kill(); }
  daemon.kill();
}
