import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { nativeArgs, parseOptions } from '../src/options';

const cli = resolve(import.meta.dirname, '../src/cli.ts');

test('Codex-style arguments preserve prompts and repeated backend configuration across relaunch', () => {
  const options = parseOptions(['resume', 'thread-1', '-C', 'project with spaces', '-c', 'model="test"',
    '-c', 'features.test=true', '--', '--a literal \u4e2d\u6587 prompt\nwith a second line'], '/tmp');
  assert.equal(options.cwd, '/tmp/project with spaces');
  assert.equal(options.resume, 'thread-1');
  const relaunched = parseOptions(nativeArgs(options, '/tmp/my codex'), '/');
  assert.deepEqual(relaunched, { ...options, native: true, codex: '/tmp/my codex' });
  assert.equal(parseOptions([], '/tmp/project').cwd, '/tmp/project');
  const literal = parseOptions(['resume', 'thread-1', 'resume']);
  assert.equal(parseOptions(nativeArgs(literal, '/tmp/codex')).prompt, 'resume');
  assert.throws(() => parseOptions(['resume']), /THREAD_ID/);
  assert.throws(() => parseOptions(['-C', 'one', '--cwd', 'two']), /either/);
  assert.throws(() => parseOptions(['--unknown']), /Unknown option/);
});

async function fixture(t: any) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'codex-tern-entry-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'caller');
  const project = join(cwd, 'project with spaces');
  const programs = join(dir, 'bin');
  const log = join(dir, 'launched.json');
  await mkdir(project, { recursive: true });
  await mkdir(programs);
  const codex = join(programs, 'codex');
  await writeFile(codex, `#!${process.execPath}\nthrow new Error('The launcher must not start Codex outside a native surface');\n`);
  await chmod(codex, 0o755);
  const tern = join(programs, 'tern');
  await writeFile(tern, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'ls') process.exit(Number(process.env.QA_TERN_STATUS ?? '0'));
writeFileSync(process.env.QA_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
if (process.argv[2] === 'ctl' && process.env.QA_TERN_CTL_OK === '1') console.log(JSON.stringify({ok: true}));
process.exit(Number(process.env.QA_TERN_EXIT ?? '0'));
`);
  await chmod(tern, 0o755);
  const env = { ...process.env, PATH: [programs, dirname(process.execPath)].join(delimiter),
    CODEX_BINARY: codex, TERN_TSP: '0', QA_LOG: log };
  const run = (args: string[], overrides: Record<string, string> = {}) => new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => done({ code, output }));
  });
  return { run, log, project, codex, programs };
}

test('session commands do not start Codex, register the bundled plugin and preserve literal prompts', async t => {
  const f = await fixture(t);
  const setup = await f.run(['setup'], { CODEX_BINARY: '/missing/codex' });
  assert.equal(setup.code, 0, setup.output);
  const linked = JSON.parse(await readFile(f.log, 'utf8'));
  assert.deepEqual(linked.args, ['plugin', 'link', resolve(import.meta.dirname, '../tern-plugin') + '/']);
  const opened = await f.run(['sessions'], { CODEX_BINARY: '/missing/codex', QA_TERN_CTL_OK: '1' });
  assert.equal(opened.code, 0, opened.output);
  assert.deepEqual(JSON.parse(await readFile(f.log, 'utf8')).args, ['ctl', 'plugins run plugin.codex-tern.sessions']);
  assert.equal(parseOptions(['--', 'sessions']).prompt, 'sessions');
  assert.equal(parseOptions(['--', 'setup']).command, undefined);
  const reloaded = await f.run(['reload'], { CODEX_BINARY: '/missing/codex', QA_TERN_CTL_OK: '1' });
  assert.equal(reloaded.code, 0, reloaded.output);
  assert.deepEqual(JSON.parse(await readFile(f.log, 'utf8')).args, ['ctl', 'plugins run plugin.codex-tern.reload']);
  assert.equal(parseOptions(['--', 'reload']).prompt, 'reload');
  assert.throws(() => parseOptions(['reload', 'extra']), /Usage/);
  assert.throws(() => parseOptions(['sessions', 'extra']), /Usage/);
});

test('outside Tern the entry opens a tab and preserves the caller project, prompt and Codex path', async t => {
  const f = await fixture(t);
  const result = await f.run(['-C', 'project with spaces', '--codex', '../bin/codex', '\u89e3\u91ca\u9879\u76ee']);
  assert.equal(result.code, 0, result.output);
  const launched = JSON.parse(await readFile(f.log, 'utf8'));
  assert.equal(launched.cwd, f.project);
  assert.deepEqual(launched.args.slice(0, 5), ['new', 'tab', '--cwd', f.project, '--']);
  assert.equal(launched.args[5], process.execPath);
  const options = parseOptions(launched.args.slice(7));
  assert.equal(options.native, true);
  assert.equal(options.codex, f.codex);
  assert.equal(options.prompt, '\u89e3\u91ca\u9879\u76ee');
});

test('a stopped Tern starts a window, returns launch failures and never relaunches recursively', async t => {
  const f = await fixture(t);
  const started = await f.run([], { QA_TERN_STATUS: '1', QA_TERN_EXIT: '7' });
  assert.equal(started.code, 7, started.output);
  const launched = JSON.parse(await readFile(f.log, 'utf8'));
  assert.equal(launched.args[0], '-e');
  await rm(f.log);
  const result = await f.run(['--native']);
  assert.equal(result.code, 1);
  assert.match(result.output, /native UI is unavailable/);
  await assert.rejects(readFile(f.log), /ENOENT/);
});

test('help and version need no backend; invalid paths and missing dependencies fail before launch', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['--help'], { CODEX_BINARY: '/missing/codex' })).code, 0);
  assert.equal((await f.run(['-V'], { CODEX_BINARY: '/missing/codex' })).output.trim(), '0.1.0');
  const directory = await f.run(['-C', 'missing']);
  assert.equal(directory.code, 1); assert.match(directory.output, /Project directory/);
  const backend = await f.run([], { CODEX_BINARY: '/missing/codex' });
  assert.equal(backend.code, 1); assert.match(backend.output, /Codex executable was not found/);
  await rm(join(f.programs, 'tern'));
  const terminal = await f.run([]);
  assert.equal(terminal.code, 1); assert.match(terminal.output, /Tern was not found on PATH/);
});

test('the backend enables Approve for me by default and preserves explicit overrides', async t => {
  const f = await fixture(t);
  const backend = resolve(import.meta.dirname, 'fixtures/ui-app-server.mjs');
  await writeFile(f.codex, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.QA_LOG, JSON.stringify(process.argv.slice(2)));
await import(${JSON.stringify(backend)});
`);
  const defaults = ['app-server', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'];
  const normal = await f.run(['--plain']);
  assert.equal(normal.code, 0, normal.output);
  assert.deepEqual(JSON.parse(await readFile(f.log, 'utf8')), defaults);

  const overrides = ['-c', 'approvals_reviewer="user"', '-c', 'approval_policy="untrusted"', '-c', 'sandbox_mode="read-only"'];
  const explicit = await f.run(['--plain', ...overrides]);
  assert.equal(explicit.code, 0, explicit.output);
  assert.deepEqual(JSON.parse(await readFile(f.log, 'utf8')), [...defaults, ...overrides]);

  const relaunched = nativeArgs(parseOptions(overrides, f.project), f.codex);
  const native = await f.run(['--plain', ...relaunched]);
  assert.equal(native.code, 0, native.output);
  assert.deepEqual(JSON.parse(await readFile(f.log, 'utf8')), [...defaults, ...overrides]);
});

test('explicit text mode submits the initial prompt unchanged without opening Tern', async t => {
  const f = await fixture(t);
  const prompt = '  CLI \u4e2d\u6587🙂\nsecond line  ';
  const marker = `QA_INPUT_BASE64: ${Buffer.from(prompt).toString('base64')}`;
  const backend = resolve(import.meta.dirname, 'fixtures/ui-app-server.mjs');
  const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn(process.execPath, [cli, '--plain', '--codex', backend, prompt], {
      cwd: f.project, env: { ...process.env, TERN_TSP: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Initial CLI prompt timed out')); }, 5000);
    let output = ''; let closing = false;
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!closing && output.includes(marker)) { closing = true; child.stdin.end('/quit\n'); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); done({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.output.includes(marker));
  assert.ok(result.output.includes(`Workspace: ${f.project}`));
  await assert.rejects(readFile(f.log), /ENOENT/);
});
