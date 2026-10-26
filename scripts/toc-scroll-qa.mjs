// Native scroll-follow regression: long replies, many topics, and bounded latency.
// Uses an isolated daemon and a fake backend. No real conversations or model calls.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { prepareTernQaConfig } from './qa-tern-config.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/toc-scroll-qa', `run-${process.pid}`);
const config = resolve(out, 'config'), socket = `/tmp/ct-toc-scroll-${process.pid}.sock`;
const history = resolve(out, 'history.json'), wire = resolve(out, 'wire.jsonl');
const gates = resolve(out, 'gates'), codexHome = resolve(out, 'codex');
await prepareTernQaConfig(config);
await mkdir(resolve(codexHome, 'thread-writer-locks'), { recursive: true });
await mkdir(gates, { recursive: true });
for (const gate of ['account', 'session', 'scan']) await writeFile(resolve(gates, gate), 'ready');
const turns = Array.from({ length: 24 }, (_, i) => ({ id: `scroll-${i}`, status: 'completed', items: [
  { id: 'user', type: 'userMessage', content: [{ type: 'text', text_elements: [], text: `SCROLLTOPIC${i + 1} Explain topic ${i + 1}.` }] },
  { id: 'answer', type: 'agentMessage', phase: 'final_answer', text:
    Array.from({ length: 6 }, (_, j) => `## ${j + 1}. Details of topic ${i + 1}\n\n` +
      'A long answer stays with its conversation topic. Its examples, equations and conclusions do not open another discussion. '.repeat(4)).join('\n\n') },
] }));
await writeFile(history, JSON.stringify({ seq: 100, threads: [{ id: 'scroll', name: 'Long conversation', turns, cwd: root, forkedFromId: 'source',
  preview: 'Long conversation', createdAt: 1792558800, updatedAt: 1792558800, recencyAt: 1792558800 }] }));
const env = { ...process.env, TERN_CONFIG_DIR: config, TERN_DAEMON_SOCKET: `/tmp/ct-scroll-daemon-${process.pid}.sock`,
  XDG_CACHE_HOME: resolve(out, 'cache'), XDG_STATE_HOME: resolve(out, 'state') };
delete env.TERN_WINDOW_KEY; delete env.TERN_WINDOW_SOCKET; delete env.TERN_PANE_SOCKET; delete env.TERN_PANE;
execFileSync('tern', ['plugin', 'link', resolve(root, 'tern-plugin')], { env, encoding: 'utf8' });
const daemon = spawn('tern', ['daemon', '--socket', env.TERN_DAEMON_SOCKET], {env, stdio: 'ignore'});
let server;
const results = [], samples = [], pause = ms => new Promise(r => setTimeout(r, ms));
function ctl(command) {
  const result = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], {env, encoding: 'utf8', timeout: 15000}));
  assert.ok(result.ok, result.error); return result;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
async function wait(check, label) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { if (check()) return; await pause(30); }
  throw new Error(`Timed out: ${label}`);
}
function sample() {
  const nodes = tree('.tv, .tv-grid, [data-role^="ct.transcript."] [data-role="omp.user"], [data-role^="ct.transcript."] [data-role="omp.assistant"] > .sf-md, .sf-dock, [data-role="codex-tern.toc.body"], [data-role="codex-tern.toc.body"] [data-mark="pick"]');
  const grid = nodes.find(n => n.class?.split(' ').includes('tv-grid'));
  const body = nodes.find(n => n.class?.split(' ').includes('sf-list'));
  const selected = nodes.find(n => n['aria-selected'] === 'true');
  const blocks = nodes.filter(n => n.class?.split(' ').some(c => c === 'sf-md' || c === 'sf-card'));
  const following = !nodes.find(n => n.class?.split(' ').includes('tv'))?.class?.split(' ').includes('scrolled');
  const first = following ? blocks.at(-1) : blocks.find(n => n.rect[3] > 0 && n.rect[1] + n.rect[3] > grid.rect[1] + 1);
  // Derive the expected topic from actual prose, not the reply's container or footer.
  const topic = first?.text?.match(/(?:SCROLLTOPIC|Details of topic )(\d+)/)?.[1];
  const expected = topic ? `Topic ${topic}` : undefined;
  const dock = body && nodes.slice(nodes.indexOf(body) + 1).find(n => n.class?.split(' ').includes('sf-dock'));
  return { at: Date.now(), expected, selected: selected?.text, following,
    fits: body && body.rect[1] + body.rect[3] <= (dock?.rect[1] ?? Infinity) + 1,
    visible: selected && body && selected.rect[1] >= body.rect[1] - 1
      && selected.rect[1] + selected.rect[3] <= Math.min(body.rect[1] + body.rect[3], dock?.rect[1] ?? Infinity) + 1 };
}
async function settle(label) {
  const start = Date.now(); let value;
  await wait(() => { value = sample(); samples.push(value); return value.expected && value.selected === value.expected && value.visible && value.fits; }, label);
  results.push({ label, ms: Date.now() - start, ...value });
  return value;
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
    process.execPath, resolve(root, 'dist/cli.mjs'), '--codex', resolve(root, 'test/fixtures/ui-app-server.mjs'), '--resume', 'scroll'].map(quote).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => tree('[data-role="codex-tern.toc.get"]').length, 'Get TOC');
  ctl('click [data-role="codex-tern.toc.get"]');
  await wait(() => tree('[data-role="codex-tern.toc.link"]').length === 24, 'all topics indexed');
  await settle('live end');
  ctl('click [data-role="omp.editor"] .sf-editor');
  // Let the click fast-path expire: normal reading must be responsive as well.
  await pause(2300);
  ctl('scroll 100000'); await settle('scroll to beginning');
  ctl('shot beginning');
  // No TOC clicks between moves. Native ctl scroll settles the input before
  // replying, so bound the remaining inspect/paint delay from that reply.
  for (const direction of ['down', 'up']) {
    let previous, longest = 0, transitions = 0;
    for (let step = 0; step < 20; step++) {
      ctl(`scroll ${direction === 'down' ? -35 : 35}`);
      const start = Date.now();
      const value = await settle(`scroll ${direction} ${step + 1}`);
      longest = Math.max(longest, Date.now() - start);
      if (value.expected !== previous) { transitions++; previous = value.expected; }
    }
    results.push({ label: `scroll sequence ${direction}`, longest, transitions });
    assert.ok(transitions >= 5, 'scroll passes several topic boundaries');
    ctl(`shot sequence-${direction}`);
  }
  ctl('scroll -100000'); await settle('scroll to live end');
  ctl('shot end');
  const normalHeight = tree('[data-role="codex-tern.toc.label"]')[0].rect[3];
  ctl('ui-font-size 18');
  await wait(() => tree('[data-role="codex-tern.toc.label"]')[0]?.rect[3] > normalHeight, 'enlarged font');
  for (const [step, amount] of [100000, -140, -140, 140, -100000].entries()) {
    ctl(`scroll ${amount}`); await settle(`enlarged font scroll ${step + 1}`);
  }
  ctl('shot enlarged-font');
  if (!process.env.QA_MEASURE_ONLY) {
    for (const result of results.filter(r => r.label.startsWith('scroll to') || r.label.startsWith('enlarged font')))
      assert.ok(result.ms < 200, `${result.label}: ${result.ms}ms`);
    for (const result of results.filter(r => r.label.startsWith('scroll sequence'))) {
      assert.ok(result.longest < 200, `${result.label}: ${result.longest}ms`);
    }
  }
  const recorded = (await readFile(wire, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.filter(e => e.dir === 'in' && e.body?.ev === 'error').map(e => e.body), []);
  console.log(JSON.stringify(results.filter(r => !/^scroll (down|up) \d+$/.test(r.label)), null, 2));
} catch (error) {
  try { ctl('shot failed'); await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2)); } catch {}
  throw error;
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({results, samples}, null, 2));
  console.log(`Scroll QA: ${out}`);
  try { ctl('key Control+q'); } catch {}
  try { ctl('quit'); } catch { server?.kill(); }
  daemon.kill();
}
