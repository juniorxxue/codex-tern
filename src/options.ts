import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

export const VERSION = '0.1.0';
export const HELP = `Codex × Tern ${VERSION} — a native GUI for Codex

Usage: codex-tern [OPTIONS] [PROMPT]
       codex-tern resume THREAD_ID [OPTIONS] [PROMPT]
       codex-tern setup
       codex-tern sessions

Run in any project directory. Opens Tern when a native surface is unavailable.
Uses the official codex app-server and your existing Codex login and settings.
Approve for me is enabled by default; explicit -c settings take precedence.

setup installs the native Tern command Codex: Sessions.
sessions opens that panel in the current Tern window, reusing the open client.

Options:
  -C, --cd PATH           Use PATH as the project directory (default: current directory)
      --cwd PATH          Alias for --cd
      --resume THREAD_ID  Resume a saved session
      --codex PATH        Use a specific Codex executable (or set CODEX_BINARY)
  -c, --config key=value  Forward an explicit setting to codex app-server; repeatable
      --plain             Run the text client in this terminal
  -h, --help              Show this help
  -V, --version           Show the version

Examples:
  codex-tern
  codex-tern -C ~/projects/my-app
  codex-tern "Explain this project"
  codex-tern resume THREAD_ID

Tested with Codex CLI 0.162.1, Tern 0.9.5 and Tern SDK 0.1.0.
`;

export function parseOptions(args: string[], cwd = process.cwd()) {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    cd: { type: 'string', short: 'C' }, cwd: { type: 'string' },
    codex: { type: 'string' }, resume: { type: 'string' },
    config: { type: 'string', short: 'c', multiple: true },
    plain: { type: 'boolean' }, native: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
  } });
  if (values.cd !== undefined && values.cwd !== undefined) throw new Error('Use either --cd or --cwd, not both.');
  let resume = values.resume;
  let command: 'setup' | 'sessions' | undefined;
  const firstPositional = tokens.find(token => token.kind === 'positional');
  const terminator = tokens.find(token => token.kind === 'option-terminator');
  if (['setup', 'sessions'].includes(positionals[0]) && (!terminator || firstPositional!.index < terminator.index)) {
    command = positionals.shift() as 'setup' | 'sessions';
    if (positionals.length || resume || values.config?.length || values.plain || values.native)
      throw new Error(`Usage: codex-tern ${command}`);
  }
  if (positionals[0] === 'resume' && (!terminator || firstPositional!.index < terminator.index)) {
    positionals.shift();
    if (resume !== undefined) throw new Error('Use either resume THREAD_ID or --resume THREAD_ID.');
    resume = positionals.shift();
    if (!resume && !values.help && !values.version) throw new Error('Usage: codex-tern resume THREAD_ID');
  }
  if (positionals.length > 1) throw new Error('Put the prompt in quotes: codex-tern "your task"');
  return {
    cwd: resolve(cwd, values.cd ?? values.cwd ?? '.'), codex: values.codex,
    command, resume, config: values.config ?? [], prompt: positionals.at(0),
    plain: values.plain ?? false, native: values.native ?? false,
    help: values.help ?? false, version: values.version ?? false,
  };
}

export type Options = ReturnType<typeof parseOptions>;

/** Absolute paths survive the change from the caller's shell to a Tern pane. */
export function nativeArgs(options: Options, codex: string) {
  return ['--native', '--cwd', options.cwd, '--codex', codex,
    ...(options.resume ? ['--resume', options.resume] : []),
    ...options.config.flatMap(value => ['-c', value]),
    ...(options.prompt !== undefined ? ['--', options.prompt] : [])];
}
