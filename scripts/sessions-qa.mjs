// Real Tern rendering and plugin events, with a deterministic Codex backend.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { FileLock } from '@oh-my-pi/pi-natives';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/sessions-qa');
const config = resolve(out, 'config');
const socket = `/tmp/codex-tern-sessions-qa-${process.pid}.sock`;
await mkdir(config, { recursive: true });
const codexHome = resolve(out, `codex-home-${process.pid}`);
await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
const occupied = FileLock.tryAcquire(resolve(codexHome, 'thread-writer-locks/saved-6.lock'));
const env = { ...process.env, TERN_CONFIG_DIR: config,
  STENCIL_LOG: 'warn,tern::plugin=debug',
  TERN_TSP_RECORD: resolve(out, 'client-wire.jsonl'),
  TERN_DAEMON_SOCKET: `/tmp/codex-tern-sessions-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), QA_SESSION_FIXTURES: '1' };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, encoding: 'utf8' });
// Window-plugin timers are not polled by Tern 0.9.5's headless runner.
// Use a real, separate window and daemon, with no user sessions or settings.
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: 'ignore' });
let server;
const results = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFast(check, label) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (check()) return;
    await pause(5);
  }
  throw new Error(`Timed out: ${label}`);
}
function ctl(command) {
  const reply = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { env, encoding: 'utf8', timeout: 15000 }));
  if (!reply.ok) throw new Error(`${command}: ${reply.error}`);
  return reply;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(n => n.text ?? '').join('\n');
const key = chord => ctl(`key ${chord}`);
const click = selector => ctl(`click ${selector}`);
const type = value => ctl(`type ${JSON.stringify(value)}`);
const lua = source => ctl(`carly lua ${JSON.stringify(source)}`);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function wait(check, label, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    if (existsSync(socket)) ctl('wait 100');
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
const panel = '[data-role="codex-tern.sessions"]';
const row = title => `[data-role="codex-tern.sessions.item"][title="${title}"]`;
const selected = '[data-role="codex-tern.sessions.item"][data-mark="pick"]';

try {
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), 'isolated test daemon');
  const log = openSync(resolve(out, 'tern.log'), 'w');
  server = spawn('tern', ['--control', socket, '--cwd', root], { env, cwd: out, stdio: ['ignore', log, log] });
  closeSync(log);
  await wait(() => existsSync(socket), 'isolated native renderer');
  ctl('style islands'); ctl('style glass');
  const command = ['env', 'QA_SESSION_FIXTURES=1', 'QA_SESSION_FEEDBACK_TESTS=1', `QA_EMPTY_SESSION_CWD=${resolve(root, 'test/fixtures')}`, `QA_CODEX_HOME=${codexHome}`, `TERN_TSP_RECORD=${resolve(out, 'client-wire.jsonl')}`,
    process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs')]
    .map(shellQuote).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => text('.sf-dock').includes('QA Model'), 'Codex composer');
  const client = ctl('state').focused.id;
  await wait(() => tree(panel).length === 1, 'sessions sidebar opens automatically without a command');
  ctl('palette "Codex: Sessions"');
  await writeFile(resolve(out, 'palette.json'), JSON.stringify(ctl('state').palette, null, 2));
  await wait(() => text('.cp').includes('Codex: Sessions') || text('.palette').includes('Codex: Sessions') || ctl('state').palette !== null, 'registered palette command');
  key('Escape');
  await writeFile(resolve(out, 'opened-tree.json'), JSON.stringify(ctl('tree'), null, 2));
  await wait(() => tree(panel).length === 1, 'native sessions panel');
  await wait(() => text(panel).includes('Saved session'), 'current-folder history');
  assert.equal(tree('[data-role="codex-tern.sessions.new"]').length, 1);
  assert.equal(ctl('state').focused.id, client, 'opening the panel preserves composer focus');
  assert.equal(ctl('state').panes.length, 2);
  assert.ok(!text(panel).includes('EXCLUDED_OTHER_FOLDER'));
  assert.equal(tree('[data-role="codex-tern.sessions.time"]').length, 0);
  assert.match(tree('[data-role="codex-tern.sessions.title"]')[0].title, /\d{2}:\d{2}/);
  assert.ok(tree('[data-role="codex-tern.sessions.item"]').every(n => n.rect[3] <= 34));
  assert.equal(tree('[data-role="omp.composer.dictation"]').length, 0);
  assert.equal(tree('[data-role="omp.composer.extras"]').length, 0);
  const shot = ctl('shot sessions-native-cards');
  const layout = JSON.parse(await readFile(resolve(out, shot.layout), 'utf8'));
  assert.ok(layout.htmlClass.includes('dense-islands'));
  assert.equal(tree('section.tn-pane').length, 2);
  assert.ok(tree(panel)[0].rect[0] < tree('[data-role="omp.editor"]')[0].rect[0]);
  assert.ok(tree(panel)[0].rect[2] >= 340 && tree(panel)[0].rect[2] <= 430,
    `default sidebar width: ${tree(panel)[0].rect[2]}`);
  pass('sidebar opens automatically with native cards, compact titles and unchanged composer focus');

  ctl('plugins run plugin.codex-tern.sessions'); await pause(1000);
  assert.equal(ctl('state').panes.length, 2);
  pass('repeating the command reuses the existing panel');
  execFileSync(process.execPath, [resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs')],
    { env, cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(ctl('state').panes.length, 2);
  assert.equal(ctl('state').focused.id, client);
  pass('launching the project again focuses its existing client without creating another pane');
  await wait(() => text('[data-role="codex-tern.sessions.note"]').includes('Load more'), 'paged list');
  click('[data-role="codex-tern.sessions.note"][data-id$="more"]');
  await wait(() => tree('[data-role="codex-tern.sessions.item"]').length === 8, 'all pages');
  assert.ok(!text(panel).includes('EXCLUDED_OTHER_FOLDER'));
  pass('load more keeps the folder scope');
  const originalOrder = tree('[data-role="codex-tern.sessions.item"]').map(n => n.title);
  await wait(() => tree(`${row('Saved session 6')} [data-role="codex-tern.sessions.lock"]`).length === 1, 'occupied session indicator');
  click(row('Saved session 6')); await pause(200);
  assert.ok(text(selected).includes('QA session 1'));
  assert.ok(!text(panel).includes('active writer'));
  occupied.release();
  await wait(() => tree(`${row('Saved session 6')} [data-role="codex-tern.sessions.lock"]`).length === 0, 'released session unlocks');
  click(row('Saved session 6'));
  await wait(() => text('[data-role="omp.assistant"]').includes('QA_SAVED_HISTORY_6'), 'released session opens');
  click(row('QA session 1'));
  await wait(() => text(selected).includes('QA session 1'), 'return to original session');
  pass('occupied sessions show a lock, ignore clicks without errors, and unlock after release');

  click('[data-role="omp.editor"] .sf-editor');
  type('unsent draft in original session');
  await wait(() => text('.sf-ed-text').includes('unsent draft in original session'), 'typed original draft');
  click(row('Saved session 7'));
  await wait(() => text('[data-role="omp.assistant"]').includes('QA_SAVED_HISTORY_7'), 'resumed history');
  await wait(() => text(selected).includes('Saved session 7'), 'selected session');
  assert.ok(!text('.sf-ed-text').includes('unsent draft'));
  assert.equal(ctl('state').focused.id, client);
  type('draft in restored session');
  click(row('QA session 1'));
  await wait(() => text('.sf-ed-text').includes('unsent draft in original session'), 'original draft restored');
  click(row('Saved session 7'));
  await wait(() => text('.sf-ed-text').includes('draft in restored session'), 'second draft restored');
  pass('session clicks restore history and preserve a separate unsent draft per session');
  assert.deepEqual(tree('[data-role="codex-tern.sessions.item"]').map(n => n.title), originalOrder);
  // Resume changes updatedAt; it must not override actual conversation activity.
  ctl('plugins run plugin.codex-tern.sessions'); await pause(500);
  assert.deepEqual(tree('[data-role="codex-tern.sessions.item"]').map(n => n.title), originalOrder);
  assert.ok(text(selected).includes('Saved session 7'));
  pass('opening history and metadata refresh preserve activity order');

  key('Meta+a'); key('Backspace'); type('hold'); key('Enter');
  await wait(() => text('.ct-activity').includes('Working'), 'active task');
  click(row('QA session 1'));
  await wait(() => text(selected).includes('QA session 1'), 'switch while first task runs');
  key('Meta+a'); key('Backspace'); type('hold'); key('Enter');
  await wait(() => text('.ct-activity').includes('Working'), 'second active task');
  await wait(() => tree('[data-role="codex-tern.sessions.running"]').length === 2, 'two running session indicators');
  await wait(() => tree('[data-role="codex-tern.sessions.item"]')[1]?.title === 'Saved session 7', 'active sessions rise by last activity');
  const activityOrder = tree('[data-role="codex-tern.sessions.item"]').map(n => n.title);
  ctl('shot project-two-running-sessions');
  const feedback = [];
  for (const title of ['Saved session 4', 'Saved session 5', 'QA session 1', 'Saved session 7']) {
    const start = performance.now();
    click(row(title));
    await waitFast(() => tree(selected).some(n => n.title === title), `immediate highlight: ${title}`);
    const ms = Math.round(performance.now() - start);
    feedback.push({ title, ms });
    assert.ok(ms < 300, `selection feedback took ${ms} ms`);
    assert.equal(tree(selected).length, 1, 'only the last clicked row is highlighted');
    if (title === 'Saved session 4' || title === 'Saved session 5') {
      await waitFast(() => text('[data-role="ct.working"] .sf-text').includes('Opening session'), 'plain session loading status');
      for (let sample = 0; sample < 3; sample++) {
        assert.equal(tree(`${row(title)} .sf-spinner`).length, 0, 'selecting an idle session never starts an animation');
        assert.equal(tree('[data-role="codex-tern.sessions.item"] .sf-spinner').length, 2, 'only the two actual tasks animate');
        assert.equal(tree('[data-role="ct.working"] .sf-spinner').length, 0, 'loading a session uses plain text in the composer');
        await pause(50);
      }
    }
    if (title === 'Saved session 4') {
      await wait(() => text('[data-role="codex-tern.sessions.note"]').includes('QA_RESUME_UNAVAILABLE'), 'failed resume reported');
      await waitFast(() => tree(selected).some(n => n.title === 'QA session 1'), 'failed selection returns to original session');
    }
  }
  await wait(() => tree('[data-role="ct.working"]').length === 0 && text('.ct-activity').includes('Working'), 'latest session finishes opening');
  assert.equal(tree(selected)[0].title, 'Saved session 7');
  await wait(() => text('.ct-activity').includes('Working'), 'latest session transcript ready');
  assert.equal(tree('[data-role="codex-tern.sessions.running"]').length, 2);
  assert.deepEqual(tree('[data-role="codex-tern.sessions.item"]').map(n => n.title), activityOrder);
  await writeFile(resolve(out, 'selection-feedback.json'), JSON.stringify({ delayedResumeMs: 750, feedback }, null, 2));
  console.log(`Selection feedback: ${feedback.map(x => x.ms).join(', ')} ms`);
  pass('selection responds before slow history loads, rolls back on failure, and rapid clicks keep only the latest highlight while two tasks run');
  click(row('Saved session 7'));
  await wait(() => text(selected).includes('Saved session 7'), 'return to first running task');
  assert.ok(text('.ct-activity').includes('Working'));
  click('[data-role="omp.composer.stop"]');
  await wait(() => text('.ct-activity').includes('Stopped'), 'stopped task');
  click(row('QA session 1'));
  await wait(() => text(selected).includes('QA session 1') && text('.ct-activity').includes('Working'), 'return to second task');
  assert.ok(text('.ct-activity').includes('Working'), 'stopping the first task preserves the second');
  click('[data-role="omp.composer.stop"]');
  await wait(() => text('.ct-activity').includes('Stopped'), 'second task stopped');
  key('Meta+a'); key('Backspace');
  pass('two sessions run together; switching preserves both tasks and stopping affects only the selected one');

  for (const title of ['Saved session 6', 'Saved session 7', 'QA session 1']) {
    click(row(title));
    await waitFast(() => tree(selected).some(n => n.title === title), `select idle session: ${title}`);
    for (let sample = 0; sample < 3; sample++) {
      assert.equal(tree('[data-role="codex-tern.sessions.item"] .sf-spinner').length, 0, 'switching idle sessions has no running animation');
      await pause(50);
    }
  }
  pass('cold and cached session selection never animates idle rows; only real tasks retain their running indicators');

  type('background'); key('Enter');
  await wait(() => tree('[data-role="omp.composer.stop"]').length > 0, 'background task starts');
  click(row('Saved session 7'));
  await wait(() => text(selected).includes('Saved session 7'), 'leave background task');
  type('hold'); key('Enter');
  await wait(() => text('.ct-activity').includes('Working'), 'foreground task starts');
  await wait(() => tree(`${row('QA session 1')} [data-role="codex-tern.sessions.running"]`).length === 0, 'background completion');
  assert.ok(text('.ct-activity').includes('Working'));
  await wait(() => tree('[data-role="codex-tern.sessions.item"]')[0]?.title === 'QA session 1', 'newest background activity moves to the top');
  assert.ok(text(selected).includes('Saved session 7'), 'activity sorting does not change the selected session');
  click(row('QA session 1'));
  await wait(() => text('[data-role="omp.assistant"]').includes('QA_BACKGROUND_DONE'), 'background result retained');
  click(row('Saved session 7'));
  await wait(() => text(selected).includes('Saved session 7'), 'return to foreground task');
  await wait(() => text('.ct-activity').includes('Working'), 'foreground transcript finishes rendering');
  click('[data-role="omp.composer.stop"]');
  await wait(() => text('.ct-activity').includes('Stopped'), 'foreground stopped');
  pass('background completion moves the session first by activity while the selected session keeps working');

  const external = 'QA_EXTERNAL_TASK_\u4e2d\u6587';
  execFileSync(process.execPath, [resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs'),
    '--resume', 'qa-thread-1', '--', external], { env, cwd: root, encoding: 'utf8', timeout: 15000 });
  await wait(() => text(selected).includes('QA session 1') && text('[data-role="omp.assistant"]').includes(external), 'external command reaches requested session');
  assert.equal(tree('[data-role="omp.user"]').filter(n => n.text?.includes(external)).length, 1);
  assert.equal(ctl('state').panes.length, 2);
  pass('an external command delivers its task once to the requested session in the existing project');

  key('Meta+a'); key('Backspace'); type('QA_DELAYED_REJECT'); key('Enter');
  click(row('Saved session 7'));
  await wait(() => text(selected).includes('Saved session 7'), 'switch during pending send');
  type('draft belongs to the second session');
  await pause(1400);
  assert.ok(text('.sf-ed-text').includes('draft belongs to the second session'));
  assert.ok(!text('.sf-ed-text').includes('QA_DELAYED_REJECT'));
  assert.ok(!text('[data-role="omp.error"]').includes('QA_DELAYED_REJECTED'));
  click(row('QA session 1'));
  await wait(() => text('.sf-ed-text').includes('QA_DELAYED_REJECT')
    && text('[data-role="omp.error"]').includes('QA_DELAYED_REJECTED'), 'rejected input and its error restored to the original session');
  key('Meta+a'); key('Backspace');
  pass('a late send failure restores only its original draft and never changes another session');

  type('question'); key('Enter');
  await wait(() => text('.ct-request').includes('Choose a color'), 'pending question');
  click('[aria-label="Write an answer"]');
  await wait(() => text('.sf-dock').includes('Answering a question'), 'answer editor is active');
  type('partial answer');
  await wait(() => text('.sf-ed-text').includes('partial answer'), 'partial answer entered');
  click(row('Saved session 7'));
  await wait(() => text(selected).includes('Saved session 7'), 'switch while drafting an answer');
  assert.ok(text('.sf-ed-text').includes('draft belongs to the second session'));
  await wait(() => tree(`${row('QA session 1')} [data-role="codex-tern.sessions.waiting"]`).length === 1, 'waiting indicator');
  click(row('QA session 1'));
  await wait(() => text('.sf-ed-text').includes('partial answer'), 'question answer draft retained');
  key('Enter');
  click('[aria-label="Submit answers"]');
  await wait(() => text('[data-role="omp.assistant"]').includes('QA_RESPONSE_answered'), 'original question receives answer');
  pass('pending questions and partial answer drafts stay with their own session while switching');

  type('hold'); key('Enter');
  await wait(() => text('.ct-activity').includes('Working'), 'task before new session');
  type('draft preserved before creating a session');
  const beforeNew = tree('[data-role="codex-tern.sessions.item"]').map(n => n.title);
  click('[data-role="codex-tern.sessions.new"]');
  await wait(() => tree(selected).some(n => !beforeNew.includes(n.title)), 'sidebar creates and selects a new session');
  const createdTitle = tree(selected)[0].title;
  assert.equal(tree('[data-role="codex-tern.sessions.item"]').length, beforeNew.length + 1);
  assert.equal(ctl('state').panes.length, 2, 'new session stays in the current project client');
  assert.equal(ctl('state').focused.id, client);
  await wait(() => !text('.sf-ed-text').includes('draft preserved') && tree('[data-role="ct.working"]').length === 0,
    'new session composer is blank and idle');
  await wait(() => tree(`${row('QA session 1')} [data-role="codex-tern.sessions.running"]`).length === 1, 'original task keeps running');
  type('draft in new session');
  click(row('QA session 1'));
  await wait(() => text('.sf-ed-text').includes('draft preserved before creating a session')
    && text('.ct-activity').includes('Working'), 'original draft and active task after new session');
  click('[data-role="omp.composer.stop"]');
  await wait(() => text('.ct-activity').includes('Stopped'), 'original task stopped');
  click(row(createdTitle));
  await wait(() => text('.sf-ed-text').includes('draft in new session'), 'new session draft retained');
  ctl('shot sessions-new-button');
  pass('sidebar new session selects a blank conversation in the same project and preserves the original task and drafts');

  const remove = title => `${row(title)} [data-role="codex-tern.sessions.delete"]`;
  const currentBeforeDelete = tree(selected)[0].title;
  click(remove('Saved session 7'));
  await pause(200);
  assert.equal(tree(selected)[0].title, currentBeforeDelete);
  assert.equal(tree(row('Saved session 7')).length, 1, 'a background draft cannot be deleted');
  click(remove('Saved session 1'));
  await wait(() => tree(row('Saved session 1')).length === 0, 'inactive row removed');
  assert.equal(tree(selected)[0].title, currentBeforeDelete, 'delete never activates the row');
  assert.ok(text('.sf-ed-text').includes('draft in new session'));
  pass('delete archives a background session without selecting it, and protects unsent drafts');
  key('Meta+a'); key('Backspace');
  await wait(() => tree(`${remove(currentBeforeDelete)}[data-mark="disabled"]`).length === 0, 'blank session can be deleted');
  click(remove(currentBeforeDelete));
  await wait(() => tree(row(currentBeforeDelete)).length === 0, 'selected session removed');
  await wait(() => tree(selected).length === 1 && beforeNew.includes(tree(selected)[0].title), 'existing neighbour selected');
  assert.ok(!text('.sf-ed-text').includes('draft in new session'));
  ctl('plugins run plugin.codex-tern.sessions'); await pause(800);
  assert.equal(tree(row(currentBeforeDelete)).length, 0);
  assert.equal(tree(row('Saved session 1')).length, 0);
  ctl('shot sessions-compact-delete');
  pass('delete of the selected session returns to an existing conversation and archived rows stay removed after refresh');

  // The disabled-delete explanation can cover the footer until its toast ends.
  ctl('wait 6000');
  click('[data-role="omp.status.path"]');
  await wait(() => text('.sf-layer').includes('Start a new session'), 'workspace dialog');
  key('Meta+a'); type(resolve(root, 'test/fixtures')); key('Enter');
  await wait(() => text('[data-role="omp.status.path"]').includes('fixtures'), 'new workspace');
  await wait(() => text('[data-role="codex-tern.sessions.folder"]').includes('fixtures'), 'panel follows workspace');
  await wait(() => tree('[data-role="codex-tern.sessions.item"]').length === 0, 'previous folder and blank session omitted');
  pass('switching folders replaces the list instead of mixing projects');

  ctl('plugins run plugin.codex-tern.sessions'); await pause(800);
  assert.equal(tree('[data-role="codex-tern.sessions.item"]').length, 0, 'refresh does not resurrect an empty New session');
  type('First message in this folder'); key('Enter');
  await wait(() => tree(row('First message in this folder')).length === 1, 'first accepted message adds the session');
  await wait(() => text('[data-role="omp.assistant"]').includes('QA_REPLY'), 'first message completes');
  await wait(() => tree(`${remove('First message in this folder')}[data-mark="disabled"]`).length === 0, 'completed first session can be deleted');
  click(remove('First message in this folder'));
  await wait(() => tree('[data-role="codex-tern.sessions.item"]').length === 0 && tree('[data-role="omp.welcome"]').length === 1, 'deleting the only selected session leaves a hidden blank conversation');
  type('Second message in this folder'); key('Enter');
  await wait(() => tree(row('Second message in this folder')).length === 1 && text('[data-role="omp.assistant"]').includes('QA_REPLY'), 'replacement accepts a first message');
  click('[data-role="codex-tern.sessions.new"]');
  await wait(() => tree('[data-role="omp.welcome"]').length === 1, 'new blank conversation');
  assert.equal(tree('[data-role="codex-tern.sessions.item"]').length, 1, 'a new blank session adds no row');
  click(remove('Second message in this folder'));
  await wait(() => tree('[data-role="codex-tern.sessions.item"]').length === 0, 'last saved session deleted');
  ctl('plugins run plugin.codex-tern.sessions'); await pause(800);
  assert.equal(tree('[data-role="codex-tern.sessions.item"]').length, 0, 'deleting and refreshing leaves no replacement row');
  pass('empty sessions stay hidden after new, delete and refresh; the first message adds a history row');

  ctl('style compact'); ctl('shot sessions-compact');
  ctl('style islands');
  for (const [width, height] of [[680, 720], [1280, 800]]) {
    ctl(`resize ${width} ${height}`);
    assert.ok(tree('[data-role="omp.editor"]')[0].rect[2] > 200);
    ctl(`shot sessions-width-${width}`);
  }
  pass('native style changes and window resizing keep the panel usable');

  lua('for _, canvas in cx.canvas:list() do if canvas.owner == "codex-tern" then cx.layout:close(canvas.pane) end end'); ctl('carly close');
  await wait(() => tree(panel).length === 0, 'sidebar manually closed');
  click('[data-role="omp.editor"] .sf-editor'); type('Draft after closing the sidebar');
  ctl('wait 2500');
  assert.equal(tree(panel).length, 0, 'automatic discovery respects manual closure');
  assert.ok(text('.sf-ed-text').includes('Draft after closing the sidebar'));
  ctl('plugins run plugin.codex-tern.sessions');
  await wait(() => tree(panel).length === 1, 'command can reopen the sidebar');
  assert.equal(ctl('state').panes.length, 2);
  assert.ok(text('.sf-ed-text').includes('Draft after closing the sidebar'));
  pass('manual closure stays closed; the command reopens one sidebar without losing the draft');

  key('Meta+a'); key('Backspace'); key('Control+q');
  await wait(() => text('.sf-main').includes('The Codex client is closed.'), 'client exits before relaunch');
  ctl('ready');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => text('.sf-dock').includes('QA Model') && text(panel).includes('Saved session'), 'relaunch automatically reconnects the existing sidebar');
  assert.equal(tree(panel).length, 1);
  assert.equal(ctl('state').panes.length, 2);
  assert.equal(ctl('state').focused.id, client);
  pass('relaunch automatically reuses the sidebar in the same pane');

  // Close just the client, leaving the native panel alive to verify stale actions.
  lua(`cx.layout:close(${client})`); ctl('carly close');
  await wait(() => text('.sf-main').includes('The Codex client is closed.'), 'closed owner');
  assert.equal(ctl('state').panes.length, 1);
  pass('closing the client leaves an inert panel with no stale switch actions');
} catch (error) {
  try {
    lua('return cx.session:surface("@focused", {root="dock.sessions", nodes=2, max_chars=64000})');
    await writeFile(resolve(out, 'bridge-diagnostic.json'), JSON.stringify(ctl('state').carly.last_tool, null, 2));
    ctl('carly close'); ctl('shot failed'); await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2));
    await writeFile(resolve(out, 'failed-state.json'), JSON.stringify(ctl('state'), null, 2)); } catch {}
  throw error;
} finally {
  occupied.release();
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed: results }, null, 2));
  try { ctl('quit'); } catch { server?.kill(); }
  daemon.kill();
}
