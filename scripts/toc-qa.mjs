// Native outline layout, updates and history navigation. No model calls.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..'), out = resolve(root, '.prototype/toc-qa');
const config = resolve(out, `config-${process.pid}`), socket = `/tmp/ct-toc-${process.pid}.sock`;
const history = resolve(out, `history-${process.pid}.json`), wire = resolve(out, `wire-${process.pid}.jsonl`);
const logFile = resolve(out, `rpc-${process.pid}.jsonl`), release = resolve(out, `release-${process.pid}`);
const codexHome = resolve(out, `codex-${process.pid}`);
await prepareTernQaConfig(config); await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
await writeFile(release, 'ready');
await writeFile(history, JSON.stringify({ seq: 100, threads: [{
  id: 'saved-outline', cwd: root, name: 'Rules and a build detour', preview: 'SUBSTITUTION Opening discussion',
  createdAt: 1792558800, updatedAt: 1792558800, recencyAt: 1792558800,
  turns: Array.from({ length: 61 }, (_, i) => ({ id: `saved-turn-${i}`, status: 'completed', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text_elements: [], text:
      i === 0 ? 'SUBSTITUTION Opening discussion' : i === 15 ? 'COUNTEREXAMPLE to substitution' : i === 30 ? 'BUILD failed during the discussion'
        : i === 60 ? 'RETURN to substitution after the build detour'
        : i >= 32 && i <= 58 && i % 2 === 0 ? `SCROLLTOPIC${(i - 30) / 2} A separate topic for scrolling` : `Follow-up on the current rule ${i}` }] },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: `Saved explanation ${i}.\n\n` +
      Array.from({ length: 3 }, () => 'The discussion continues with the same rule. This saved passage makes scrolling and old-message navigation visible in the native client.').join('\n\n') },
  ] })),
}] }));
const env = { ...process.env, TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: `/tmp/ct-toc-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, `state-${process.pid}`) };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, encoding: 'utf8' });
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: 'ignore' });
let server;
const results = [], pause = ms => new Promise(r => setTimeout(r, ms));
function ctl(command) {
  const result = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { env, encoding: 'utf8', timeout: 15000 }));
  if (!result.ok) throw new Error(`${command}: ${result.error}`); return result;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(n => n.text ?? '').join('\n');
const click = selector => ctl(`click ${selector}`), key = chord => ctl(`key ${chord}`), type = text => ctl(`type ${JSON.stringify(text)}`);
const row = title => `[data-role="codex-tern.sessions.item"][title="${title}"]`;
const link = title => `[data-role="codex-tern.toc.link"][title="${title}"]`;
const selected = () => text('[data-role="codex-tern.toc.body"] [data-mark="pick"]');
function selectedVisible() {
  const active = tree('[data-role="codex-tern.toc.body"] [data-mark="pick"]')[0];
  const body = tree('[data-role="codex-tern.toc.body"]')[0];
  return active && body && active.rect[1] >= body.rect[1] - 1 && active.rect[1] + active.rect[3] <= body.rect[1] + body.rect[3] + 1;
}
const editor = '[data-role="omp.editor"] .sf-editor';
const calls = () => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
const jobs = () => calls().filter(e => e.source === 'thread_outline').length;
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function lua(source) {
  ctl(`carly lua ${JSON.stringify(source)}`);
  const result = ctl('state').carly.last_tool; ctl('carly close');
  assert.ok(!result.error, result.text); return result.text;
}
async function wait(check, label) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { if (check()) return; await pause(60); }
  throw new Error(`Timed out: ${label}`);
}
function pass(label) { results.push(label); console.log(`PASS ${label}`); }
function visiblePrompt(contains) {
  const dock = tree('.sf-dock')[0], grids = tree('.tv-grid');
  return tree('[data-role="omp.user"]').some(n => n.text?.includes(contains) && n.rect[1] >= grids[0].rect[1] - 20 && n.rect[1] < dock.rect[1]);
}
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['--control', socket, '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] }); closeSync(log);
  await wait(() => existsSync(socket), 'native window'); ctl('resize 1280 900');
  ctl('style islands'); ctl('style glass');
  await wait(() => ctl('state').focused?.prompt, 'shell');
  const command = ['env', 'QA_TOC_FIXTURE=1', `QA_HISTORY_FILE=${history}`, `QA_RPC_LOG=${logFile}`, `QA_CODEX_HOME=${codexHome}`,
    `TERN_TSP_RECORD=${wire}`, `QA_TOC_RELEASE_FILE=${release}`, `QA_EMPTY_SESSION_CWD=${root}`, 'QA_GENERATED_TITLE=Outline demo',
    process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs'), '--resume', 'saved-outline'].map(quote).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => text('[data-role="codex-tern.toc.get"]').includes('Get TOC'), 'old session empty card');
  await pause(500); assert.equal(jobs(), 0); ctl('shot toc-old-empty');
  pass('old sessions stay blank and do not start an agent before Get TOC');
  click('[data-role="codex-tern.toc.get"]');
  await wait(() => tree(link('Build failure')).length && tree(link('Counterexample')).length, 'backfill covers old detour');
  await wait(() => !text('[data-role="codex-tern.toc.status"]').includes('Updating'), 'backfill complete');
  await pause(350); ctl('shot toc-history');
  await writeFile(resolve(out, 'layout.json'), JSON.stringify(ctl('tree'), null, 2));
  assert.ok(calls().some(c => c.method === 'thread/turns/list' && c.cursor === '50'));
  click(link('Substitution rule'));
  await wait(() => visiblePrompt('SUBSTITUTION Opening discussion'), 'jump to unloaded opening prompt');
  ctl('shot toc-jump-opening');
  assert.ok(calls().some(c => c.method === 'thread/turns/list' && c.cursor === '15'));
  pass('Get TOC reads all history; a heading loads and reveals a prompt outside the initial history page');
  click('[data-role="codex-tern.toc.visits"]');
  await wait(() => visiblePrompt('RETURN to substitution'), 'jump to later return');
  pass('returning topics expose a second exact prompt without a third heading level');

  await wait(() => selected().includes('Substitution rule'), 'live end highlights the return');
  const noAgent = jobs(), focused = ctl('state').focused.id;
  click(editor); type('Unsent draft during scrolling');
  ctl('scroll 70');
  await wait(() => /Topic \d+/.test(selected()), 'scrolling into an earlier topic updates selection');
  await wait(selectedVisible, 'active topic remains inside the TOC viewport');
  const readingBefore = tree('.sf-main').find(n => n.rect[0] > 390).rect[1];
  await pause(900);
  assert.equal(tree('.sf-main').find(n => n.rect[0] > 390).rect[1], readingBefore, 'passive selection does not move the conversation');
  assert.equal(ctl('state').focused.id, focused, 'following never focuses the TOC');
  assert.ok(text('[data-role="omp.editor"] .sf-ed-text').includes('Unsent draft'));
  assert.equal(jobs(), noAgent, 'scrolling does not call the outline agent');
  ctl('shot toc-scroll-follow');
  pass('scrolling follows the reading topic, reveals it in a long TOC, and preserves focus, draft, reading position and model usage');
  key('Control+Shift+r'); await pause(500);
  await wait(selectedVisible, 'reading highlight survives UI reload');
  assert.equal(tree('.sf-main').find(n => n.rect[0] > 390).rect[1], readingBefore, 'reload retains the reading position');
  assert.ok(text('[data-role="omp.editor"] .sf-ed-text').includes('Unsent draft'));
  ctl('resize 880 650'); await pause(500);
  await wait(() => {
    const body = tree('[data-role="codex-tern.toc.body"]')[0].rect, grid = tree('.tv-grid').at(-1).rect;
    return body[1] + body[3] <= grid[1] + grid[3] && selectedVisible();
  }, 'long outline fits the smaller card and keeps its selected row visible');
  ctl('shot toc-scroll-narrow'); ctl('resize 1280 900'); await pause(500);
  pass('a long outline keeps its active row visible through UI reload and card resizing');
  ctl('scroll -100000');
  await wait(() => selected().includes('Substitution rule'), 'scrolling to the live end returns to the earlier topic');
  click(editor); key('Meta+a'); key('Backspace');
  click(link('Counterexample'));
  await wait(() => selected().includes('Counterexample'), 'child highlighted');
  click('[data-role="codex-tern.toc.fold"]');
  await wait(() => selected().includes('Substitution rule') && !tree(link('Counterexample')).length, 'collapsed parent represents its active child');
  click('[data-role="codex-tern.toc.fold"]');
  await wait(() => selected().includes('Counterexample'), 'expanding restores the active child');
  click(editor); ctl('scroll -100000');
  await wait(() => selected().includes('Substitution rule'), 'reading follows after expanding');
  pass('return visits and manually collapsed subtopics keep the correct reading highlight');

  click('[data-role="codex-tern.sessions.new"]');
  await wait(() => text('[data-role="codex-tern.toc.note"]').includes('Topics appear'), 'new session auto enabled');
  await unlink(release); click(editor); type('hold SUBSTITUTION rule'); key('Enter');
  await wait(() => text('[data-role="codex-tern.toc.status"]').includes('Updating'), 'live prompt update');
  type('Draft stays while the outline updates');
  await writeFile(release, 'ready');
  await wait(() => tree(link('Substitution rule')).length === 1 && tree(row('Outline demo')).length === 1, 'live topic and title');
  assert.ok(text('[data-role="omp.editor"] .sf-ed-text').includes('Draft stays'));
  assert.equal(tree('[data-role="omp.composer.stop"]').length, 1);
  ctl('shot toc-live');
  pass('live analysis leaves the running main task and unsent draft intact');
  click(editor); key('Meta+a'); type('SUGGEST RETURN to the substitution rule'); key('Enter');
  await wait(() => tree(link('Proposed repair')).length === 1 && !tree('[data-role="omp.composer.stop"]').length, 'steered prompt indexed');
  click(link('Proposed repair'));
  await wait(() => visiblePrompt('SUGGEST RETURN'), 'steering anchor uses stable client card');
  pass('steering within one turn gets its own working prompt link');
  click(editor); type('REPAIR the substitution rule'); key('Enter');
  await wait(() => tree(link('Substitution and its repair')).length === 1, 'finished reply revises heading');
  ctl('shot toc-revised');
  pass('finished replies can rename and restructure existing topics');

  const pane = tree('[data-role="codex-tern.sessions"]')[0].rect;
  const toc = tree('[data-role="codex-tern.toc"]')[0].rect;
  assert.equal(tree('.tn-pane').length, 3, 'conversation, sessions, and TOC are separate native cards');
  assert.ok(toc[3] > 60 && toc[1] > pane[1] + pane[3], 'TOC starts below the separate Sessions card');
  pass('TOC is its own native card, independent of Sessions and free to rearrange');
  const panelInfo = lua('for _, c in cx.canvas:list() do if string.sub(c.about, 1, #"codex-tern.toc/v1:") == "codex-tern.toc/v1:" then print(tern.json.encode({pane = c.pane, target = tonumber(string.sub(c.about, #"codex-tern.toc/v1:" + 1))})) end end');
  const { pane: tocPane, target: client } = JSON.parse(panelInfo.split('\n').find(s => s.startsWith('{')));
  lua(`cx.layout:move(${tocPane}, ${client}, "right", {focus = false})`);
  await wait(() => tree('[data-role="codex-tern.toc"]')[0].rect[0] > tree('[data-role="omp.editor"]')[0].rect[0], 'TOC moved to right');
  execFileSync('tern', ['plugin', 'reload'], { env, encoding: 'utf8', timeout: 15000 });
  await pause(800); assert.equal(tree('.tn-pane').length, 3);
  assert.ok(tree('[data-role="codex-tern.toc"]')[0].rect[0] > tree('[data-role="omp.editor"]')[0].rect[0]);
  ctl('shot toc-rearranged');
  lua(`cx.layout:close(${tocPane})`);
  await pause(1000); assert.equal(tree('[data-role="codex-tern.toc"]').length, 0);
  assert.equal(tree('[data-role="codex-tern.sessions"]').length, 1);
  click(editor); ctl('plugins run plugin.codex-tern.toc');
  await wait(() => tree(link('Substitution and its repair')).length === 1, 'TOC reopened independently');
  pass('moving and reloading retain placement; closing and reopening TOC leave Sessions intact');
  ctl('resize 880 650'); await pause(350); ctl('shot toc-narrow');
  for (const n of tree('[data-role="codex-tern.toc.link"]')) assert.ok(n.rect[2] > 20, 'labels have usable width');
  ctl('resize 1280 900');
  lua('cx.settings:set("theme", "Dark")');
  await pause(500); ctl('shot toc-dark');
  assert.equal(JSON.parse(readFileSync(resolve(out, 'target/shots/tern/live/toc-dark.layout.json'), 'utf8')).theme, 'dark');
  pass('independent TOC card remains readable in narrow and dark layouts');
  click(row('Rules and a build detour'));
  await wait(() => tree(link('Build failure')).length === 1, 'old outline restored');
  assert.equal(tree('[data-role="codex-tern.toc.label"][data-mark="reveal"]').length, 0);
  click(row('Outline demo')); await wait(() => tree(link('Substitution and its repair')).length === 1, 'new outline restored');
  const before = jobs(); key('Control+q');
  await wait(() => text('.sf-main').includes('The Codex client is closed.'), 'close');
  ctl('ready'); ctl(`run ${JSON.stringify(command.replace("'--resume' 'saved-outline'", "'--resume' '" + JSON.parse(readFileSync(history, 'utf8')).threads.find(t => t.name === 'Outline demo').id + "'"))}`);
  await wait(() => tree(link('Substitution and its repair')).length === 1, 'outline survives restart');
  await wait(() => !text('[data-role="codex-tern.toc.status"]').includes('Updating'), 'unchanged resume check');
  assert.equal(jobs(), before);
  pass('outlines persist across switches and restarts without replaying animation or spending an unchanged model call');
  const recorded = (await readFile(wire, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
  assert.ok(!JSON.parse(readFileSync(history, 'utf8')).threads.some(t => t.ephemeral));
  pass('helper sessions remain outside saved conversations and native protocol errors stay empty');
} catch (error) {
  try { ctl('shot failed'); await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2)); } catch {}
  throw error;
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed: results }, null, 2));
  try { key('Control+q'); } catch {}
  try { ctl('quit'); } catch { server?.kill(); }
  daemon.kill();
}
