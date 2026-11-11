// Isolated offscreen native window with saved fork histories. Never calls a model.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..'), out = resolve(root, '.prototype/prompt-tree-qa');
const config = resolve(out, `config-${process.pid}`), socket = `/tmp/ct-prompt-tree-${process.pid}.sock`;
const history = resolve(out, `history-${process.pid}.json`), logFile = resolve(out, `rpc-${process.pid}.jsonl`);
const codexHome = resolve(out, `codex-${process.pid}`), backend = resolve(out, `backend-${process.pid}.sh`);
await prepareTernQaConfig(config); await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
const turn = (id, prompt) => ({ id, status: 'completed', items: [
  { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text_elements: [], text: prompt }] },
  { id: `reply-${id}`, type: 'agentMessage', phase: 'final_answer', text: `Saved response to: ${prompt}.` },
] });
const thread = (id, name, turns, forkedFromId = null) => ({ id, name, turns, forkedFromId, sessionId: id, parentThreadId: null,
  cwd: root, preview: '', createdAt: 1792558800, updatedAt: 1792558800, recencyAt: 1792558800, ephemeral: false });
const shared = [turn('root', 'Explore conversation branches'), turn('vertical', 'Arrange the tree vertically')];
await writeFile(history, JSON.stringify({ seq: 100, threads: [
  thread('source', 'Conversation tree', [...shared, turn('collapsed', 'Keep the map collapsed'), turn('drafts', 'Preserve unsent drafts')]),
  thread('fork', 'Prompt navigation', [...shared, turn('labels', 'Use concise prompt labels'), turn('jump', 'Jump straight to the message')], 'source'),
] }));
const env = { ...process.env, TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: `/tmp/ct-prompt-tree-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, `state-${process.pid}`) };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
await writeFile(backend, `#!/bin/sh\nexec env QA_TREE_FIXTURE=1 QA_FORK_METADATA=1 QA_HISTORY_FILE=${quote(history)} QA_RPC_LOG=${quote(logFile)} QA_CODEX_HOME=${quote(codexHome)} ${quote(process.execPath)} ${quote(resolve(root, 'test/fixtures/ui-app-server.mjs'))} "$@"\n`);
await chmod(backend, 0o700);
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
const click = selector => ctl(`click ${selector}`), key = chord => ctl(`key ${chord}`), type = value => ctl(`type ${JSON.stringify(value)}`);
const editor = '[data-role="omp.editor"] .sf-editor', draft = () => text('[data-role="omp.editor"] .sf-ed-text');
const toggle = '[aria-label="Show conversation tree"]', panel = '[data-role="ct.prompt-tree"]';
const node = prompt => `[data-role="ct.prompt-tree.node"][title="${prompt}"]`;
const branch = id => `[data-role="ct.prompt-tree.branch"][data-thread-id="${id}"]`;
const calls = () => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
async function wait(check, label, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await pause(60); }
  throw new Error(`Timed out: ${label}`);
}
function pass(label) { results.push(label); console.log(`PASS ${label}`); }
function lua(source) { ctl(`carly lua ${JSON.stringify(source)}`); const result = ctl('state').carly.last_tool; ctl('carly close'); assert.ok(!result.error, result.text); }
async function shot(name) { await pause(250); ctl(`shot ${name}`); }
async function jump(prompt, selector = node(prompt)) {
  await wait(() => tree(`${selector}[aria-disabled="false"]`).length, 'navigation ready');
  click(selector);
  await wait(() => tree(`${selector}[aria-current="location"]`).length && tree('.sf-main [data-role="omp.user"]').some(n => {
    const top = tree('.tv-grid')[0].rect[1], bottom = tree('.sf-dock')[0].rect[1];
    return n.text.includes(prompt) && n.rect[1] >= top - 16 && n.rect[1] < bottom;
  }), `jump: ${prompt}`);
  assert.equal(tree('[data-role="ct.search.location"]').length, 0, 'tree links use the ordinary conversation');
  assert.equal(tree('[data-id="main.context-after"]').length, 0);
}
try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['serve', '--control', socket, '--out', resolve(out, 'target/shots/tern'), '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] }); closeSync(log);
  await wait(() => existsSync(socket), 'window'); ctl('resize 1440 1000');
  await wait(() => ctl('state').focused?.prompt, 'shell');
  key('Control+u');
  ctl(`run ${JSON.stringify([process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', backend, '--resume', 'source'].map(quote).join(' '))}`);
  await wait(() => tree(toggle).length && tree(editor).length && tree('.sf-main [data-role="omp.user"]').length === 4, 'conversation ready');
  assert.equal(tree(panel).length, 0); assert.equal(tree('[data-role="ct.prompt-tree.node"]').length, 0);
  assert.equal(tree('[data-role="codex-tern.sessions"] [data-role="ct.prompt-tree"]').length, 0);
  click(editor); type('Source draft'); await pause(650); type(' remains here');
  await wait(() => draft() === 'Source draft remains here', 'draft input settled');
  key('Meta+z'); await wait(() => draft() !== 'Source draft remains here', 'baseline undo');
  const undoDraft = draft();
  key('Meta+Shift+z'); await wait(() => draft() === 'Source draft remains here', 'baseline redo');
  await shot('prompt-tree-collapsed');
  const editorRect = tree(editor)[0].rect;
  click(toggle);
  await wait(() => tree('[data-role="ct.prompt-tree.node"]').length === 1 && tree('[data-role="ct.prompt-tree.branch"]').length === 2, 'fork-only tree');
  assert.equal(text('.ct-prompt-label'), 'Arrange the tree vertically');
  for (const ordinary of ['Explore conversation branches', 'Keep the map collapsed', 'Preserve unsent drafts', 'Use concise prompt labels', 'Jump straight to the message']) {
    assert.equal(tree(node(ordinary)).length, 0, `omit ordinary prompt: ${ordinary}`);
  }
  assert.equal(calls().filter(c => c.method === 'thread/resume').length, 1);
  assert.equal(calls().filter(c => c.method === 'turn/start').length, 0);
  assert.equal(draft(), 'Source draft remains here');
  const map = tree(panel)[0].rect;
  assert.ok(map[2] > 250 && map[3] > 200, `usable map bounds ${map}`);
  assert.ok(map[1] + map[3] < editorRect[1], `map ${map} stays above editor ${editorRect}`);
  assert.deepEqual(tree(editor)[0].rect, editorRect, 'expansion does not reflow the composer');
  const rootNode = tree(node('Arrange the tree vertically'))[0].rect, end = tree(branch('fork'))[0].rect;
  assert.ok(end[1] > rootNode[1]); assert.ok(tree('.ct-prompt-edge').length >= 4);
  await shot('prompt-tree-light');
  const appearance = JSON.parse(readFileSync(resolve(out, 'target/shots/tern/serve/prompt-tree-light.layout.json'), 'utf8'));
  const labelStyles = appearance.elements.filter(e => e.path.endsWith('.ct-prompt-label'));
  assert.ok(labelStyles.length && labelStyles.every(e => parseFloat(e.fontSize) >= 14 && Number(e.fontWeight) >= 500));
  assert.ok(labelStyles.every(e => e.rect[3] > 20), 'prompt excerpt wraps instead of being clipped on one line');
  const chatFont = appearance.elements.find(e => e.path.includes('.sf-main') && e.path.endsWith('.md')).fontFamily;
  assert.ok(chatFont.includes('Concourse T3'));
  assert.ok(labelStyles.every(e => e.fontFamily === chatFont), 'use the conversation font, including its CJK fallbacks');
  assert.ok(appearance.elements.filter(e => e.path.endsWith('.ct-prompt-map-title')).every(e => e.fontFamily === chatFont));
  assert.ok(appearance.elements.filter(e => e.path.endsWith('.ct-prompt-map-panel')).every(e => e.backgroundColor !== 'rgba(0, 0, 0, 0)'), 'panel has a native surface');
  pass('default collapsed; only fork junctions have labels; branch endpoints remain selectable; typography matches the conversation');

  await jump('Arrange the tree vertically', branch('fork'));
  assert.ok(tree('[data-role="ct.fork.origin"]').length);
  assert.equal(tree('[data-role="ct.prompt-tree.branch"]').length, 2);
  assert.ok(tree(`${branch('fork')}.on-path.current`).length);
  assert.ok(text('.sf-main [data-role="omp.assistant"]').includes('Saved response to: Jump straight to the message.'));
  await shot('prompt-tree-fork-conversation');
  assert.ok(!draft().includes('Source draft')); assert.equal(tree('[data-role="ct.search.match"]').length, 0);
  click(editor); type('Fork draft');
  await wait(() => draft() === 'Fork draft', 'fork draft input settled');
  const resumes = calls().filter(c => c.method === 'thread/resume').length;
  await jump('Arrange the tree vertically');
  assert.equal(calls().filter(c => c.method === 'thread/resume').length, resumes, 'shared ancestor stays in the selected fork');
  assert.ok(draft().includes('Fork draft'));
  await jump('Arrange the tree vertically', branch('source'));
  assert.equal(tree('[data-role="ct.prompt-tree.branch"]').length, 2);
  assert.ok(tree(`${branch('source')}.on-path.current`).length);
  assert.ok(text('.sf-main [data-role="omp.assistant"]').includes('Saved response to: Preserve unsent drafts.'));
  assert.equal(draft(), 'Source draft remains here');
  click(editor); key('Meta+z'); await wait(() => draft() === undoDraft, 'source draft undo');
  pass('single-click jumps to the exact prompt, shared ancestors keep the branch, and per-session draft and undo history survive');

  lua('cx.settings:set("theme", "Dark")'); await shot('prompt-tree-dark');
  ctl('resize 900 720'); await shot('prompt-tree-compact');
  const compact = tree(panel)[0].rect, compactEditor = tree(editor)[0].rect;
  assert.ok(compact[0] >= 0 && compact[0] + compact[2] <= 900 && compact[1] + compact[3] < compactEditor[1]);
  click('[aria-label="Hide conversation tree"]');
  await wait(() => tree(toggle).length && !tree(panel).length, 'collapsed again');
  assert.equal(draft(), undoDraft);
  ctl('resize 1440 1000'); lua('cx.settings:set("theme", "Light")'); click(toggle);
  await wait(() => tree(node('Arrange the tree vertically')).length, 'reopened map');
  pass('light, dark and compact layouts keep the composer usable; hiding restores the small edge control');

  const saved = JSON.parse(readFileSync(history, 'utf8'));
  saved.threads.push(thread('deep', 'Long branch', [...shared, ...Array.from({ length: 70 }, (_, i) => turn(`deep-${i}`, i === 0 ? 'Explore edge cases' : `Follow-up question ${i}`))], 'source'));
  saved.threads.push(thread('deep-fork', 'Edge case fork', [...shared, turn('deep-0', 'Explore edge cases')], 'deep'));
  await writeFile(history, JSON.stringify(saved));
  click('[aria-label="Refresh conversation tree"]');
  await wait(() => tree(node('Explore edge cases')).length, 'new deep branch');
  assert.equal(tree('[data-role="ct.prompt-tree.node"]').length, 2, 'seventy follow-ups add only their actual fork point');
  assert.equal(tree(branch('deep-fork')).length, 1, 'untouched fork has a selectable endpoint');
  assert.equal(tree('[data-role="ct.prompt-tree.branch"]').length, 4, 'compact endpoints all fit in the map');
  await shot('prompt-tree-forks');
  await jump('Explore edge cases');
  assert.ok(tree(`${branch('deep')}.on-path`).length);
  await shot('prompt-tree-deep-conversation');
  assert.equal(calls().filter(c => c.method === 'turn/start' || c.method === 'thread/start' || c.method === 'thread/fork').length, 0, 'navigation never invokes models or mutations');
  const cutoff = '[data-role="ct.reply.fork"][data-id*="deep-0:reply-deep-0"]';
  await wait(() => tree(cutoff).length, 'existing fork action');
  click(cutoff);
  await wait(() => calls().filter(c => c.method === 'thread/fork').length === 1, 'official fork request');
  await wait(() => text('.sf-main [data-role="omp.user"]').includes('Explore edge cases') && tree('[data-role="ct.prompt-tree.branch"]').length === 5, 'fork adopted');
  const afterFork = JSON.parse(readFileSync(history, 'utf8')).threads;
  const created = afterFork.find(t => t.id.startsWith('qa-thread-'));
  assert.equal(created.forkedFromId, 'deep'); assert.equal(created.turns.length, 3);
  assert.equal(calls().filter(c => c.method === 'turn/start').length, 0);
  pass('untouched forks appear immediately; long histories show only fork points; navigation stays read-only and the existing fork cutoff is preserved');
  await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
} catch (error) {
  try { ctl('shot failed'); } catch {}
  throw error;
} finally {
  try { ctl('quit'); } catch {}
  server?.kill(); daemon.kill();
}
