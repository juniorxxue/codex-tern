// Native rendering checks with a fixed backend; no model calls or user sessions.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.prototype/proposals-qa');
const socket = `/tmp/codex-tern-proposals-${process.pid}.sock`;
const codexHome = resolve(out, `codex-${process.pid}`);
await mkdir(resolve(out, 'config'), { recursive: true });
await mkdir(codexHome, { recursive: true });
const env = { ...process.env, TERN_CONFIG_DIR: resolve(out, 'config'), XDG_CACHE_HOME: resolve(out, 'cache'), QA_PROPOSAL_FIXTURES: '1' };
const server = spawn('tern', ['serve', '--control', socket, '--out', out, '--cwd', root], { env, stdio: 'ignore' });
const pause = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function ctl(command) {
  const result = JSON.parse(execFileSync('tern', ['ctl', '--control', socket, command], { encoding: 'utf8', timeout: 15000 }));
  if (!result.ok) throw new Error(`${command}: ${result.error}`);
  return result;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(n => n.text ?? '').join('\n');
const click = selector => ctl(`click ${selector}`);
const draft = () => text('.sf-ed-text').replace(/\s+/g, ' ').trim();
async function wait(check, name) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (check()) return; await pause(75); }
  throw new Error(`Timed out: ${name}`);
}
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
function validate() {
  assert.equal(tree('[data-role="ct.proposal"]').length, 2);
  assert.equal(tree('[data-role="ct.proposal.before"]').length, 2);
  assert.equal(tree('[data-role="ct.proposal.after"]').length, 2);
  assert.ok(text('[data-role="ct.proposal.before"] .ct-proposal-del').includes('type checked'));
  assert.ok(text('[data-role="ct.proposal.after"] .ct-proposal-ins').includes('typed'));
  assert.equal(tree('.ct-proposal .math-err').length, 0);
  assert.equal(tree('.ct-proposal .math svg, .ct-proposal .math-display svg').length, 6);
  for (const n of tree('.ct-proposal .math svg')) assert.ok(n.rect[2] > 8 && n.rect[3] > 8, 'inline formulas retain readable size');
  assert.equal(tree('.ct-proposal .ct-proposal-del .math svg, .ct-proposal .ct-proposal-del .math-display svg').length, 2);
  assert.equal(tree('.ct-proposal .ct-proposal-ins .math svg, .ct-proposal .ct-proposal-ins .math-display svg').length, 2);
  assert.equal(tree('.ct-proposal [role="checkbox"]').length, 2);
  assert.equal(tree('[aria-label="Select edit 1"]').length, 1);
  assert.equal(tree('[aria-label="Select edit 2"]').length, 1);
  assert.equal(tree('.ct-proposal button').length, 0);
  assert.equal(text('.ct-proposal-label'), 'Original\nSuggested\nOriginal\nSuggested');
  assert.equal(tree('[aria-label="Apply selected edits"]').length, 1);
  assert.ok(!text('.ct-proposal').includes(':::proposal'));
  const before = tree('[data-role="ct.proposal.before"]'), after = tree('[data-role="ct.proposal.after"]');
  before.forEach((node, i) => assert.ok(after[i].rect[1] >= node.rect[1] + node.rect[3], 'passages are stacked vertically'));
}
try {
  await wait(() => { try { execFileSync('test', ['-S', socket]); return true; } catch { return false; } }, 'control socket');
  ctl('resize 1100 1100');
  const command = ['env', 'QA_PROPOSAL_FIXTURES=1', `CODEX_HOME=${codexHome}`, process.execPath, `${root}/dist/cli.mjs`, '--codex',
    `${root}/test/fixtures/ui-app-server.mjs`, 'resume', 'proposal-saved'].map(s => `'${s.replaceAll("'", "'\\''")}'`).join(' ');
  ctl(`run ${JSON.stringify(command)}`);
  await wait(() => tree('.ct-proposal').length === 2, 'restored proposals');
  await pause(150);
  validate(); ctl('shot proposals-restored');
  pass('restored history has two stacked passages, exact word marks and six rendered formulas');
  assert.equal(tree('.ct-proposal-apply[aria-disabled="true"]').length, 1);
  click('[aria-label="Select edit 2"]'); click('[aria-label="Select edit 1"]');
  await wait(() => text('.ct-proposal-count') === '2 selected', 'both selections');
  click('[aria-label="Apply selected edits"]');
  await wait(() => draft() === 'Apply the edits 1, 2.', 'drafted apply request');
  const userMessages = tree('[data-role="omp.user"]').length;
  click('[aria-label="Apply selected edits"]');
  assert.equal(draft(), 'Apply the edits 1, 2.');
  click('[aria-label="Select edit 2"]');
  await wait(() => text('.ct-proposal-count') === '1 selected', 'deselection');
  click('[aria-label="Apply selected edits"]');
  await wait(() => draft() === 'Apply the edits 1.', 'updated apply request');
  assert.equal(tree('[data-role="omp.user"]').length, userMessages, 'apply does not send a message');
  ctl('shot proposals-selected');
  pass('checkboxes draft ordered edit numbers without sending or duplicating the request');
  ctl('key Control+Shift+n');
  await wait(() => tree('[data-role="omp.welcome"]').length === 1, 'new session');
  ctl('type "QA_PROPOSAL_FIXTURE"'); ctl('key Enter');
  await wait(() => text('[data-role="omp.assistant"]').includes(':::proposal'), 'incomplete proposal');
  assert.equal(tree('.ct-proposal').length, 0);
  pass('incomplete streamed blocks stay readable and acquire no premature diff');
  await wait(() => tree('.ct-proposal').length === 2, 'completed proposals');
  await pause(150);
  validate(); ctl('shot proposals-completed');
  pass('completed streaming uses the same proposal view and preserves inline formatting');
  assert.equal(text('.ct-proposal-count'), '0 selected', 'new session has its own selections');
  ctl('type "Keep the notation."');
  click('[aria-label="Select edit 1"]');
  await wait(() => text('.ct-proposal-count') === '1 selected', 'new selection');
  click('[aria-label="Apply selected edits"]');
  await wait(() => draft() === 'Keep the notation. Apply the edits 1.', 'preserved existing draft');
  ctl('key Meta+z');
  await wait(() => draft() === 'Keep the notation.', 'undo apply request');
  click('[aria-label="Select edit 1"]');
  await wait(() => text('.ct-proposal-count') === '0 selected', 'all deselected');
  assert.equal(tree('.ct-proposal-apply[aria-disabled="true"]').length, 1);
  pass('selection is separate in a new session; apply preserves existing text and supports undo');
  for (const width of [480, 1100]) {
    ctl(`resize ${width} 1100`); await pause(100);
    for (const n of tree('.ct-proposal-prose')) assert.ok(n.rect[0] >= 0 && n.rect[0] + n.rect[2] <= width, 'prose fits window');
    ctl(`shot proposals-width-${width}`);
  }
  pass('both passages wrap at narrow and wide widths');
} catch (error) {
  try { ctl('shot failed'); await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2)); } catch { /* Preserve failure. */ }
  throw error;
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ passed: results }, null, 2));
  try { ctl('key Control+q'); } catch { /* The test client may have exited already. */ }
  try { ctl('quit'); } catch { server.kill(); }
}
