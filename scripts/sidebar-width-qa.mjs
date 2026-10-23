// Native layout and persisted preferences in two isolated Tern windows.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/sidebar-width-qa');
const config = resolve(out, `config-${process.pid}`);
const projects = await mkdtemp('/tmp/codex-tern-width-');
await prepareTernQaConfig(config);
const store = resolve(config, 'plugin-data/codex-tern/kv.json');
const key = 'sessions.sidebar-ratio';
const saved = () => existsSync(store) ? JSON.parse(readFileSync(store, 'utf8'))[key] : undefined;
const pause = ms => new Promise(r => setTimeout(r, ms));
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const windows = [];
const passed = [];
function pass(name) { passed.push(name); console.log(`PASS ${name}`); }
async function wait(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (check()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 0.008, `${label}: ${actual} vs ${expected}`);
}
async function openWindow(name, width) {
  const cwd = resolve(projects, name);
  await mkdir(cwd, { recursive: true });
  const codexHome = resolve(out, `codex-home-${process.pid}-${name}`);
  await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
  const env = { ...process.env, TERN_CONFIG_DIR: config, STENCIL_LOG: 'warn,tern::plugin=debug',
    TERN_DAEMON_SOCKET: `/tmp/codex-tern-width-${process.pid}-${name}-daemon.sock`,
    XDG_STATE_HOME: resolve(out, `state-${process.pid}-${name}`), XDG_CACHE_HOME: resolve(out, 'cache') };
  delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET;
  const socket = `/tmp/codex-tern-width-${process.pid}-${name}.sock`;
  const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], { env, stdio: 'ignore' });
  const w = { name, env, daemon, socket };
  windows.push(w);
  await wait(() => existsSync(env.TERN_DAEMON_SOCKET), `${name}: daemon`);
  const log = openSync(resolve(out, `${name}.log`), 'w');
  w.server = spawn('tern', ['--control', socket, '--cwd', cwd], { env, cwd: out, stdio: ['ignore', log, log] });
  closeSync(log);
  w.ctl = command => {
    const result = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { env, encoding: 'utf8', timeout: 15000 }));
    assert.ok(result.ok, `${name}: ${command}: ${result.error}`);
    return result;
  };
  w.lua = source => {
    w.ctl(`carly lua ${JSON.stringify(source)}`);
    const result = w.ctl('state').carly.last_tool;
    w.ctl('carly close');
    assert.ok(!result.error, result.text);
    return result.text;
  };
  w.panel = () => {
    const output = w.lua(`
      local function find(node, pane)
        if not node or node.pane then return nil end
        if node.split == "right" and node[1] and node[1].pane == pane then return node.ratio end
        return find(node[1], pane) or find(node[2], pane)
      end
      for _, canvas in cx.canvas:list() do
        if canvas.owner == "codex-tern" then
          local layout = cx.session:layout(cx.session:tab_of(canvas.pane))
          print(tern.json.encode({pane = canvas.pane, ratio = find(layout.root, canvas.pane)}))
        end
      end`);
    const line = output.split('\n').find(s => s.startsWith('{'));
    return line ? JSON.parse(line) : undefined;
  };
  await wait(() => existsSync(socket), `${name}: native window`);
  w.ctl(`resize ${width} 800`);
  w.ctl('style islands');
  const command = ['env', 'QA_SESSION_FIXTURES=1', `QA_CODEX_HOME=${codexHome}`,
    process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs')]
    .map(quote).join(' ');
  w.ctl(`run ${JSON.stringify(command)}`);
  await wait(() => (w.ctl('tree [data-role="codex-tern.sessions"]').nodes ?? []).length === 1, `${name}: sidebar`);
  await pause(300);
  return w;
}
function closeWindow(w) {
  if (w.closed) return;
  w.closed = true;
  try { w.ctl('quit'); } catch { w.server?.kill(); }
  w.daemon.kill();
}

try {
  execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], {
    env: { ...process.env, TERN_CONFIG_DIR: config }, encoding: 'utf8' });
  const a = await openWindow('project-a', 1280);
  assert.equal(saved(), undefined, 'initial default is not a user preference');
  a.lua(`cx.layout:resize(${a.panel().pane}, "right", -10)`);
  const first = a.panel().ratio;
  await wait(() => saved() === first, 'divider adjustment saved');
  pass('adjusting the divider saves its fraction globally');

  const b = await openWindow('project-b', 1600);
  near(b.panel().ratio, first, 'another project and wider window');
  assert.equal(saved(), first, 'applying the preference never overwrites it with rounding');
  pass('another project in a different window uses the same fraction');

  b.lua(`cx.layout:resize(${b.panel().pane}, "right", 11)`);
  const second = b.panel().ratio;
  await wait(() => saved() === second, 'second window saves new preference');
  await wait(() => Math.abs(a.panel().ratio - second) < 0.008, 'first window observes new preference');
  await pause(800);
  assert.equal(saved(), second, 'synchronizing windows must not cause ratio drift');
  pass('changing either window updates the other without rounding drift');

  for (const width of [760, 1480]) {
    a.ctl(`resize ${width} 800`);
    await pause(350);
    near(a.panel().ratio, second, `window width ${width}`);
    assert.equal(saved(), second, 'window resizing does not change the preferred fraction');
  }
  pass('resizing the whole window preserves the saved fraction');

  a.lua(`cx.layout:close(${a.panel().pane})`);
  a.ctl('plugins run plugin.codex-tern.sessions');
  await wait(() => (a.ctl('tree [data-role="codex-tern.sessions"]').nodes ?? []).length === 1, 'reopened sidebar');
  near(a.panel().ratio, second, 'reopened sidebar');
  assert.equal(saved(), second);
  pass('closing and reopening the sidebar restores the global fraction');

  execFileSync('tern', ['plugin', 'reload'], { env: a.env, encoding: 'utf8', timeout: 15000 });
  await pause(400);
  near(a.panel().ratio, second, 'plugin reload');
  a.lua(`cx.layout:resize(${a.panel().pane}, "right", -7)`);
  const final = a.panel().ratio;
  await wait(() => saved() === final, 'resize watcher restored after reload');
  pass('plugin reload keeps the preference and resumes saving adjustments');

  closeWindow(a); closeWindow(b);
  const c = await openWindow('project-c', 1120);
  near(c.panel().ratio, final, 'fresh window after both prior windows exit');
  assert.equal(saved(), final);
  c.ctl('shot remembered-sidebar');
  pass('the fraction survives a restart and opens in a third project');
} catch (error) {
  for (const w of windows.filter(w => !w.closed && w.ctl)) {
    try { w.ctl('shot failed'); await writeFile(resolve(out, `${w.name}-failed-state.json`), JSON.stringify(w.ctl('state'), null, 2)); } catch {}
  }
  throw error;
} finally {
  for (const w of windows) closeWindow(w);
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed }, null, 2));
}
