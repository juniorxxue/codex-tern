// Native Tern UI regression tests, using a deterministic app-server fixture.
// Real Codex is covered separately by smoke.ts and manual native conversations.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { rasterizeSvg } from '@oh-my-pi/pi-natives';

const root = resolve(import.meta.dirname, '..');
const socket = `/tmp/codex-tern-ui-qa-${process.pid}.sock`;
const out = resolve(root, '.prototype/ui-qa');
await mkdir(out, { recursive: true });
const pause = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const portrait = resolve(out, 'e4b9a62df315ae72c11619abef4f475c09ad47a2c0188b93669c1fb5a2a937dd.png');
const landscape = resolve(out, 'landscape.png');
for (const [path, width, height] of [[portrait, 1000, 1400], [landscape, 1400, 700]]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f5f7fb"/><rect x="40" y="40" width="${width - 80}" height="${height - 80}" rx="24" fill="white" stroke="#9ab" stroke-width="4"/><text x="80" y="140" font-size="48" fill="#345">Image preview</text><path d="M80 220h${width - 160}M80 300h${width - 240}M80 380h${width - 200}" stroke="#abc" stroke-width="12"/></svg>`;
  await writeFile(path, await rasterizeSvg(Buffer.from(svg), width, height));
}
const server = spawn('tern', ['serve', '--control', socket, '--out', out, '--cwd', root], {
  stdio: 'ignore', env: { ...process.env, XDG_CACHE_HOME: resolve(out, 'cache') },
});
function ctl(command) {
  const output = execFileSync('tern', ['ctl', '--control', socket, command], { encoding: 'utf8', timeout: 15_000 });
  const r = JSON.parse(output.trim());
  if (!r.ok) throw new Error(`${command}: ${r.error}`);
  return r;
}
const tree = selector => ctl(`tree ${selector}`).nodes ?? [];
const text = selector => tree(selector).map(n => n.text ?? '').join('\n');
const normalize = value => value.replace(/\s+/g, ' ').trim();
const click = selector => ctl(`click ${selector}`);
const type = value => ctl(`type ${JSON.stringify(value)}`);
const key = chord => {
  const parts = chord.split('+');
  const names = { ctrl: 'Control', shift: 'Shift', alt: 'Alt', super: 'Meta', enter: 'Enter', escape: 'Escape',
    backspace: 'Backspace', delete: 'Delete', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End' };
  return ctl(`key ${parts.map(p => names[p] ?? p).join('+')}`);
};
async function waitFor(check, description, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await pause(100); }
  throw new Error(`Timed out: ${description}`);
}
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
async function send(value) { type(value); key('enter'); }
async function attachImage(path) {
  click('[aria-label="More actions"]');
  await waitFor(() => text('.sf-layer').includes('Actions'), 'actions for attachment');
  type('Attach image'); key('enter');
  await waitFor(() => text('.sf-layer').includes('Attach image'), 'attachment panel');
  type(path); key('enter');
  await waitFor(() => tree('[data-role="omp.composer.chips"] .sf-image').length > 0, 'attachment thumbnail');
}
async function editCase(name, initial, operations, expected) {
  key('super+a'); key('backspace');
  for (const [n, line] of initial.split('\n').entries()) { if (n) key('shift+enter'); type(line); }
  await waitFor(() => normalize(text('.sf-ed-text')).replace(/\s/g, '') === normalize(initial).replace(/\s/g, ''), `initial draft: ${name}`);
  for (const [kind, value] of operations) {
    if (kind === 'key') key(value); else type(value);
    await pause(60);
  }
  await waitFor(() => normalize(text('.sf-ed-text')).replace(/\s/g, '') === normalize(expected).replace(/\s/g, ''), `edited draft: ${name}`);
  // Larger type can evict an older reply from Tern's virtualized transcript.
  // Check the submitted content rather than the number of mounted replies.
  const encoded = Buffer.from(expected).toString('base64');
  key('enter');
  await waitFor(() => tree('[data-role="omp.assistant"]').at(-1)?.text.includes(`QA_INPUT_BASE64: ${encoded}`), `submitted draft: ${name}`);
  assert.ok(tree('[data-role="omp.assistant"]').at(-1).text.includes(`QA_INPUT_BASE64: ${encoded}`), `exact submitted text: ${name}`);
  pass(name);
}

try {
  await waitFor(() => { try { execFileSync('test', ['-S', socket]); return true; } catch { return false; } }, 'Tern control socket');
  ctl(`run ${JSON.stringify(`${process.execPath} ${root}/dist/cli.mjs --codex ${root}/test/fixtures/ui-app-server.mjs`)}`);
  await waitFor(() => text('.sf-dock').includes('QA Model'), 'composer');
  pass('launch and inherited model');
  const sendButton = '[data-role="omp.composer.send"]';
  assert.equal(tree('[data-role="omp.welcome"]').length, 1);
  assert.ok(!text('[data-role="omp.welcome"]').includes('v0.1.0'));
  await waitFor(() => tree(`${sendButton}[aria-disabled="true"]`).length === 1, 'empty draft send is inactive');
  click(sendButton); await pause(100);
  assert.equal(tree('[data-role="omp.user"]').length, 0, 'empty send does not create a message');
  ctl('shot quiet-welcome');
  type('A draft ready to send');
  await waitFor(() => tree(`${sendButton}[aria-disabled="false"]`).length === 1, 'text enables send');
  ctl('shot composer-ready');
  key('super+a'); type('   ');
  await waitFor(() => tree(`${sendButton}[aria-disabled="true"]`).length === 1, 'whitespace does not enable send');
  key('super+a'); key('backspace');
  pass('quiet welcome and empty, typed, and whitespace-only send states');

  await writeFile(resolve(out, '中文 [draft] (1) #?& 100%.txt'), 'QA_FILE_CITATION_TARGET\n');
  await send('QA_CITATION_FIXTURE');
  const citationLink = '[data-role="omp.assistant"] a';
  await waitFor(() => tree(citationLink).length === 1, 'assistant citation renders as a link');
  assert.ok(text(citationLink).includes('中文 [draft] (1) #?& 100%.txt'));
  assert.ok(text('[data-role="omp.assistant"] code').includes(':codex-file-citation'));
  ctl('shot assistant-file-citation');
  click(citationLink);
  await waitFor(() => tree('section.tn-pane.file').length === 1, 'citation opens its local file');
  assert.equal(tree('.ed-loc')[0].title, resolve(out, '中文 [draft] (1) #?& 100%.txt') + '  ⌘L');
  ctl(`carly lua ${JSON.stringify('for _, pane in cx.session:panes() do if pane.kind == "file" then cx.layout:close(pane.pane) end end')}`); ctl('carly close');
  await waitFor(() => tree('section.tn-pane.file').length === 0, 'close the citation preview');
  pass('streaming and completed citations open the exact local file; code examples stay literal');
  key('ctrl+shift+n');
  await waitFor(() => tree('[data-role="omp.welcome"]').length === 1, 'blank session after citation fixture');

  type('unsent settings draft');
  key('super+,'); await waitFor(() => ctl('state').prefs !== null, 'Command+, terminal settings');
  assert.ok(!text('.sf-layer').includes('Tested Codex version'));
  key('escape'); await waitFor(() => ctl('state').prefs === null, 'close terminal settings');
  assert.ok(text('.sf-ed-text').includes('unsent settings draft'));
  pass('Command+, opens Tern terminal settings without losing the draft');
  key('ctrl+shift+p'); await waitFor(() => text('.sf-layer').includes('Select model'), 'picker before settings');
  key('super+,'); await waitFor(() => ctl('state').prefs !== null, 'Command+, terminal settings from picker');
  key('escape'); await waitFor(() => ctl('state').prefs === null, 'close terminal settings from picker');
  key('escape'); await waitFor(() => !text('.sf-layer').includes('Select model'), 'close retained picker');
  pass('Command+, opens terminal settings while a client panel is open');

  await editCase('Ctrl+A/E move within the line without selecting all', 'alpha beta',
    [['key', 'ctrl+a'], ['type', '<'], ['key', 'ctrl+e'], ['type', '>']], '<alpha beta>');
  await editCase('Ctrl+B/F move by character', 'abcd',
    [['key', 'ctrl+a'], ['key', 'ctrl+f'], ['type', 'X'], ['key', 'ctrl+f'], ['type', 'Y']], 'aXbYcd');
  await editCase('Ctrl+H/D delete backward and forward', 'abcd',
    [['key', 'ctrl+a'], ['key', 'ctrl+f'], ['key', 'ctrl+f'], ['key', 'ctrl+h'], ['key', 'ctrl+d']], 'ad');
  await editCase('Ctrl+P/N move within multiline drafts without opening sessions or models', 'first\nsecond',
    [['key', 'ctrl+p'], ['type', 'X'], ['key', 'ctrl+n'], ['type', 'Y']], 'firstX\nsecondY');
  await editCase('Option+arrows move by word', 'one two',
    [['key', 'alt+left'], ['type', 'X'], ['key', 'alt+right'], ['type', 'Y']], 'one XtwoY');
  await editCase('Ctrl+W/U/Y use the OMP kill ring', 'one two',
    [['key', 'ctrl+w'], ['key', 'ctrl+u'], ['key', 'ctrl+y']], 'one two');
  await editCase('line deletion and yank preserve multiline text', 'first\nsecond',
    [['key', 'ctrl+a'], ['key', 'ctrl+u'], ['key', 'ctrl+y']], 'first\nsecond');
  await editCase('Command+A selects all; undo and redo restore replacement', 'original',
    [['key', 'super+a'], ['type', 'replacement'], ['key', 'super+z'], ['key', 'super+shift+z']], 'replacement');
  await editCase('Ctrl+J inserts a newline', 'first',
    [['key', 'ctrl+j'], ['type', 'second']], 'first\nsecond');
  await editCase('Shift+arrows replace only the selected text', 'abcd',
    [['key', 'ctrl+a'], ['key', 'shift+right'], ['key', 'shift+right'], ['type', 'XY']], 'XYcd');
  key('super+a'); key('backspace'); type('test/fixtures/'); key('tab');
  await waitFor(() => text('.sf-layer').includes('fake-app-server.mjs'), 'original OMP completion popup');
  key('down'); key('enter');
  await waitFor(() => text('.sf-ed-text').includes('test/fixtures/fake-app-server.mjs'), 'accepted completion');
  assert.ok(!text('.sf-layer').includes('fake-app-server.mjs'));
  pass('original OMP file completion accepts with Enter without sending');
  key('super+a'); key('backspace'); type('test/fixtures/'); key('tab');
  await waitFor(() => text('.sf-layer').includes('fake-app-server.mjs'), 'completion popup before Escape');
  key('escape'); await waitFor(() => !text('.sf-layer').includes('fake-app-server.mjs'), 'cancelled completion');
  assert.ok(text('.sf-ed-text').includes('test/fixtures/'));
  pass('Escape dismisses completion and preserves the typed path');
  key('tab'); await waitFor(() => text('.sf-layer').includes('fake-app-server.mjs'), 'completion before pointer pick');
  click('[data-role="omp.autocomplete"] .sf-item:nth-child(2)');
  await waitFor(() => text('.sf-ed-text').includes('test/fixtures/fake-app-server.mjs'), 'pointer completion');
  pass('original OMP completion accepts a mouse selection');
  key('super+a'); key('backspace');
  click('[aria-label="More actions"]'); await waitFor(() => text('.sf-layer').includes('Actions'), 'editing action menu');
  type('Vim'); await waitFor(() => text('.sf-layer').includes('Enable Vim editing'), 'Vim action'); key('enter');
  await waitFor(() => !text('.sf-layer').includes('Enable Vim editing'), 'Vim action closed');
  await editCase('original OMP Vim normal mode edits and returns to insert mode', 'one two',
    [['key', 'escape'], ['key', 'b'], ['key', 'd'], ['key', 'w'], ['key', 'shift+a'], ['type', 'THREE']], 'one THREE');
  click('[aria-label="More actions"]'); await waitFor(() => text('.sf-layer').includes('Actions'), 'standard editing menu');
  type('standard'); await waitFor(() => text('.sf-layer').includes('Use standard editing'), 'standard action'); key('enter');
  await waitFor(() => !text('.sf-layer').includes('Use standard editing'), 'standard editing restored');
  key('ctrl+shift+n'); await waitFor(() => tree('[data-role="omp.welcome"]').length === 1, 'new session shortcut');

  await send('hold');
  await waitFor(() => text('.ct-activity').includes('Working'), 'running activity');
  assert.ok(!text('.ct-activity').includes('Run command'));
  assert.ok(text('.ct-activity-output').endsWith('QA_OUTPUT_999'));
  assert.ok(text('.ct-activity-output').length < 100);
  assert.equal(tree('[data-role="ct.working"]').length, 0, 'the input area does not repeat Working');
  assert.ok(!text('.sf-dock').includes('Working'));
  for (const [w, h] of [[480, 640], [1280, 800]]) {
    ctl(`resize ${w} ${h}`);
    const bar = tree('[data-role="omp.composer.bar"]')[0].rect;
    for (const selector of ['[aria-label="New session"]', '[aria-label="Sessions"]', '[aria-label="More actions"]',
      '[data-role="omp.composer.stop"]', '[data-role="omp.composer.send"]', '[title="Steer now or queue a follow-up"]']) {
      const r = tree(selector)[0].rect;
      assert.ok(r[0] >= bar[0] && r[0] + r[2] <= bar[0] + bar[2] + 1, `${selector} fits the running toolbar at ${w}`);
      assert.ok(r[1] >= bar[1] && r[1] + r[3] <= bar[1] + bar[3] + 1, `${selector} stays in the toolbar at ${w}`);
    }
    ctl(`shot compact-running-${w}`);
  }
  ctl('shot compact-running');
  pass('bounded live command preview, one Working status, and a unified toolbar at narrow and wide widths');
  type('draft during work'); key('super+,');
  await waitFor(() => ctl('state').prefs !== null, 'terminal settings while running');
  key('escape'); await waitFor(() => ctl('state').prefs === null, 'closed terminal settings while running');
  assert.ok(text('.sf-ed-text').includes('draft during work'));
  assert.ok(text('.ct-activity').includes('Working'));
  key('super+a'); key('backspace');
  pass('terminal settings remain available during a task and retain the draft');


  click('.ct-activity-toggle'); await waitFor(() => text('.ct-activity').includes('Run command'), 'opened details');
  await send('steer');
  await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_STEERED'), 'steered answer');
  assert.ok(!text('.ct-activity').includes('Run command'));
  assert.equal(tree('[data-role="ct.working"]').length, 0);
  ctl('shot completed-collapsed');
  pass('steer and auto-collapse even after details were opened while running');
  click('.ct-activity-toggle'); await waitFor(() => text('.ct-activity').includes('Run command'), 'reopened details'); click('.ct-activity-toggle');
  await waitFor(() => !text('.ct-activity').includes('Run command'), 'hidden details');
  pass('reopen and hide completed details');

  key('ctrl+shift+n'); await pause(100);
  await send('hold'); await waitFor(() => text('.ct-activity').includes('Working'), 'queue turn');
  click('[title="Steer now or queue a follow-up"]');
  await waitFor(() => text('.sf-dock').includes('Queue'), 'queue mode');
  await send('queued follow up');
  await waitFor(() => text('[data-role="omp.queue"]').includes('queued follow up'), 'queued message');
  click('[data-role="omp.composer.stop"]');
  await waitFor(() => text('[data-role="omp.queue"]').includes('paused'), 'paused queue');
  assert.ok(text('.ct-activity').includes('Stopped'));
  click('[aria-label="Run next"]');
  await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_REPLY: queued follow up'), 'run next');
  pass('queue follow up, stop, preserve paused queue, run next');

  key('ctrl+shift+n'); await pause(100);
  await send('approval'); await waitFor(() => text('.ct-request').includes('Allow once'), 'approval');
  assert.equal(tree('[data-role="omp.assistant"]').length, 0);
  assert.ok(!text('.sf-dock').includes('Working'), 'pending approval is not presented as more task execution');
  ctl('shot approval-card');
  click('.ct-request .ct-button.ct-danger');
  await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_RESPONSE_decline'), 'decline result');
  assert.equal(tree('.ct-request').length, 0); pass('approval stays pending; decline resolves and removes buttons');
  await send('approval'); await waitFor(() => text('.ct-request').includes('Allow once'), 'allow approval');
  click('.ct-request .ct-primary');
  await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_RESPONSE_accept'), 'allow result');
  pass('explicit allow once');
  await send('question'); await waitFor(() => text('.ct-request').includes('Choose a color'), 'question');
  assert.equal(tree('.ct-request .ct-primary[aria-disabled="true"]').length, 1);
  click('.ct-request .ct-primary'); await pause(100);
  assert.ok(text('.ct-request').includes('Choose a color'), 'incomplete answers stay pending');
  ctl('shot question-unselected');
  click('.ct-choice'); await waitFor(() => tree('.ct-request .ct-primary[aria-disabled="false"]').length === 1, 'selected question');
  assert.equal(tree('.ct-choice[aria-pressed="true"]').length, 1);
  ctl('shot question-selected');
  click('.ct-request .ct-primary');
  await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_RESPONSE_answered'), 'question result');
  pass('question option and submit');

  key('ctrl+shift+n'); await pause(100);
  // The path panel exercises the same validated attachment flow as path paste.
  assert.equal(tree('[data-role="omp.composer.dictation"]').length, 0, 'no attachment plus button');
  assert.equal(tree('[data-role="omp.composer.extras"]').length, 0, 'no composer folder or token counter');
  click('[aria-label="More actions"]');
  await waitFor(() => text('.sf-layer').includes('Actions'), 'attachment menu');
  type('Attach image'); key('enter');
  await waitFor(() => text('.sf-layer').includes('Attach image'), 'attachment panel');
  type(resolve(root, 'test/fixtures/clipboard.png')); key('enter');
  await waitFor(() => text('[data-role="omp.composer.chips"]').includes('Image #1'), 'image thumbnail');
  assert.ok(tree('[data-role="omp.composer.chips"] .sf-image').length);
  assert.equal(tree(`${sendButton}[aria-disabled="false"]`).length, 1, 'an image alone enables send');
  ctl('shot image-thumbnail');
  pass('attach image and native thumbnail');
  click('[data-role="omp.composer.chips"] [title="Remove image"]');
  await waitFor(() => tree('[data-role="omp.composer.chips"]').length === 0, 'removed image'); pass('remove image before sending');
  assert.equal(tree(`${sendButton}[aria-disabled="true"]`).length, 1, 'removing the last image restores the empty state');
  await attachImage(portrait);
  await send('Please explain this diagram.');
  await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_IMAGE_RECEIVED'), 'submitted image');
  await waitFor(() => tree('[data-role="omp.user"] .sf-image').length === 1, 'sent image preview');
  assert.equal(normalize(text('[data-role="omp.user"]')), 'Please explain this diagram.');
  assert.equal(tree('[data-role="omp.composer.chips"]').length, 0);
  const preview = tree('[data-role="omp.user.images"] .sf-image')[0].rect;
  assert.ok(preview[2] > 80 && preview[2] <= 400 && preview[3] <= 260, 'bounded portrait preview');
  assert.ok(Math.abs(preview[2] / preview[3] - 1000 / 1400) < 0.03, 'portrait aspect ratio');
  ctl('shot sent-image-and-text');
  pass('sent image has a bounded preview and only the original text, with no cache path');
  click('[data-role="omp.user.images"] .sf-image');
  await waitFor(() => tree('.tn-lb').length > 0, 'image zoom');
  ctl('shot sent-image-zoom'); key('escape');
  await waitFor(() => tree('.tn-lb').length === 0, 'closed image zoom');
  pass('sent image opens at full size and Escape closes the preview');
  await attachImage(portrait);
  await attachImage(landscape);
  key('enter');
  await waitFor(() => tree('[data-role="omp.user"]').length === 2, 'image-only message');
  await waitFor(() => tree('[data-role="omp.user.images"] .sf-image').length === 3, 'both sent images');
  assert.equal(normalize(tree('[data-role="omp.user"]').at(-1).text ?? ''), '');
  assert.equal(tree('[data-role="omp.user"] .sf-md').length, 1, 'image-only messages have no empty Markdown block');
  for (const [width, height] of [[480, 640], [1280, 800]]) {
    ctl(`resize ${width} ${height}`);
    const bubble = tree('[data-role="omp.user"]').at(-1).rect;
    for (const image of tree('[data-role="omp.user"] .sf-image')) {
      assert.ok(image.rect[0] >= 0 && image.rect[0] + image.rect[2] <= width, `image fits at ${width}`);
    }
    assert.ok(bubble[0] + bubble[2] <= width, `image bubble fits at ${width}`);
    ctl(`shot sent-multiple-images-${width}`);
  }
  pass('image-only messages wrap multiple previews within narrow and wide windows');
  // Clear the earlier typed path without sending it.
  key('super+a'); key('backspace');
  await send('\u591a\u884c\u8f93\u5165 😀');
  await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_REPLY: \u591a\u884c\u8f93\u5165 😀'), 'Unicode answer');
  pass('Unicode composer input and multiple turns');

  key('ctrl+shift+p'); await waitFor(() => text('.sf-layer').includes('Select model'), 'model picker');
  type('Other'); key('enter'); await waitFor(() => text('.sf-dock').includes('Other Model'), 'model selection');
  click('[data-role="omp.composer.effort"]'); key('up'); key('enter');
  await waitFor(() => text('[data-role="omp.composer.effort"]').includes('low'), 'effort selection');
  pass('filter model picker and select reasoning effort');

  key('ctrl+shift+n'); await pause(100); key('ctrl+l');
  await waitFor(() => text('.sf-layer').includes('QA session'), 'session picker');
  key('down'); key('enter');
  await waitFor(() => text('.sf-main').includes('\u591a\u884c\u8f93\u5165 😀'), 'restored history');
  assert.equal(tree('[data-role="omp.user.images"] .sf-image').length, 3, 'restored image previews');
  assert.ok(!text('[data-role="omp.user"]').includes(portrait));
  assert.ok(!text('[data-role="omp.user"]').includes('[Image]'));
  pass('new session and resume with history');

  click('[aria-label="More actions"]'); await waitFor(() => text('.sf-layer').includes('Actions'), 'actions menu');
  type('Session details'); await waitFor(() => text('.sf-layer').includes('Session details'), 'session details menu choice');
  key('enter'); await waitFor(() => text('.sf-layer').includes('Tested Codex version'), 'session details with notices');
  assert.ok(text('.sf-layer').includes('Session details'));
  assert.ok(text('.sf-layer').includes('Approve for me'));
  ctl('shot session-details-with-notices'); key('escape');
  await waitFor(() => !text('.sf-layer').includes('Tested Codex version'), 'closed session details');
  pass('session details show Approve for me with configuration notices');
  click('[aria-label="More actions"]'); await waitFor(() => text('.sf-layer').includes('Actions'), 'help actions menu');
  type('Keyboard'); await waitFor(() => text('.sf-layer').includes('Keyboard shortcuts'), 'help menu choice');
  key('enter'); await waitFor(() => text('.sf-layer').includes('Getting started'), 'help panel');
  key('escape'); await waitFor(() => !text('.sf-layer').includes('Getting started'), 'closed help');
  pass('help panel and Escape return to composer');

  await send('edit fixture'); await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_EDIT_DONE'), 'file change answer');
  assert.ok(text('.ct-activity').includes('file change'));
  assert.ok(!text('.ct-activity').includes('QA_FILE_OK'));
  click('.ct-activity-toggle'); await waitFor(() => text('.ct-activity').includes('QA_FILE_OK'), 'file diff details');
  ctl('shot file-diff'); click('.ct-activity-toggle');
  pass('file changes fold after completion and expand to a native diff');
  click('[aria-label="More actions"]'); await waitFor(() => text('.sf-layer').includes('Actions'), 'diff actions menu');
  type('View changes'); await waitFor(() => text('.sf-layer').includes('View changes'), 'diff menu choice');
  key('enter'); await waitFor(() => text('.sf-layer').includes('QA_FILE_OK'), 'changes panel');
  key('escape'); await waitFor(() => !text('.sf-layer').includes('QA_FILE_OK'), 'closed diff');
  pass('changes panel shows complete turn diff');

  click('[data-role="omp.status.path"]'); await waitFor(() => text('.sf-layer').includes('Start a new session'), 'workspace panel');
  key('super+a'); type(resolve(root, 'test/fixtures')); key('enter');
  await waitFor(() => text('[data-role="omp.status.path"]').includes('fixtures'), 'workspace label');
  assert.ok(text('[data-role="omp.status.path"]').includes('fixtures'));
  assert.equal(tree('[aria-label="Codex composer controls"] > .sf-place').length, 0);
  pass('workspace switch updates the secondary status line; the toolbar stays free of folder, usage and attachment controls');

  for (const [w, h] of [[680, 720], [480, 640], [1280, 800]]) {
    ctl(`resize ${w} ${h}`);
    const nav = tree('[data-role="ct.nav"]')[0].rect;
    for (const label of ['New session', 'Sessions', 'More actions']) {
      const r = tree(`[aria-label="${label}"]`)[0]?.rect;
      assert.ok(r && r[0] >= 0 && r[0] + r[2] <= w, `${label} at ${w}`);
    }
    assert.ok(nav[0] + nav[2] <= w);
    ctl(`shot width-${w}`);
  }
  pass('footer buttons remain accessible at 480, 680 and 1280 px');
  await send('QA_UNCONFIRMED');
  await waitFor(() => text('.sf-dock').includes('Message delivery unconfirmed'), 'unconfirmed delivery card');
  await waitFor(() => text('[data-role="omp.assistant"]').includes('QA_REPLY: QA_UNCONFIRMED'), 'accepted input despite invalid reply');
  assert.equal(tree('[aria-label="Send message"]').length, 0);
  assert.equal(tree('[data-role="omp.queue.item"]').length, 0);
  type('Keep this new draft');
  click('[aria-label="Check conversation"]');
  await pause(100);
  assert.ok(text('.sf-ed-text').includes('Keep this new draft'));
  ctl('shot unconfirmed-delivery');
  click('[aria-label="Already received"]');
  await waitFor(() => !text('.sf-dock').includes('Message delivery unconfirmed'), 'resolved unconfirmed delivery');
  assert.ok(text('.sf-ed-text').includes('Keep this new draft'));
  key('super+a'); key('backspace');
  pass('uncertain delivery blocks resending, reloads history, and preserves a new draft until acknowledged');
  await send('disconnect'); await waitFor(() => text('.sf-dock').includes('Disconnected'), 'disconnected state');
  await waitFor(() => text('[data-role="omp.error"]').includes('Codex disconnected'), 'disconnect error');
  assert.equal(tree('[aria-label="Send message"]').length, 0);
  pass('backend failure is visible and disables sending');
} catch (error) {
  try {
    ctl('shot failed');
    await writeFile(resolve(out, 'failed-tree.json'), JSON.stringify(ctl('tree'), null, 2));
  } catch { /* Keep the original failure if Tern has stopped. */ }
  throw error;
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results }, null, 2));
  try { ctl('quit'); } catch { server.kill(); }
}
