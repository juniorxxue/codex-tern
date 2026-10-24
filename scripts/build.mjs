import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { appearanceStyles } from '../src/appearance.ts';
import { buildUI } from './build-ui.mjs';
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2023',
  banner: { js: '#!/usr/bin/env bun' },
  jsx: 'automatic',
  jsxImportSource: '@stencil-hq/tern',
  external: ['@stencil-hq/tern', '@stencil-hq/tern/*', '@oh-my-pi/*', 'bun', 'bun:*'],
  sourcemap: true,
});
await buildUI();

// The window plugin also styles clients kept alive by Tern's daemon. Keep it
// in sync with the program sheet, without restarting those conversations.
await writeFile(new URL('../tern-plugin/appearance.css', import.meta.url),
  `/* Generated from src/appearance.ts by bun run build. */\n[data-surface="codex-tern"] {\n${appearanceStyles}\n}\n`);
