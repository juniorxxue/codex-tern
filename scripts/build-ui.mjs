import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function buildUI() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await build({
    absWorkingDir: root, entryPoints: ['src/ui.tsx'], outfile: 'dist/ui.mjs', write: false,
    bundle: true, platform: 'node', format: 'esm', target: 'es2023',
    jsx: 'automatic', jsxImportSource: '@stencil-hq/tern',
    // Both generations must use the same SDK Node constructors and terminal.
    external: ['@stencil-hq/tern', '@stencil-hq/tern/*', '@oh-my-pi/*', 'bun', 'bun:*'],
    sourcemap: 'inline',
  });
  const contents = result.outputFiles[0].contents;
  const hash = createHash('sha256').update(contents).digest('hex');
  const directory = new URL('../dist/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const file = `ui-${hash}.mjs`;
  const temporary = new URL(`.ui-${randomUUID()}.tmp`, directory);
  await writeFile(temporary, contents); await rename(temporary, new URL(file, directory));
  const manifest = new URL(`.ui-${randomUUID()}.json`, directory);
  await writeFile(manifest, JSON.stringify({ file }) + '\n');
  await rename(manifest, new URL('ui.json', directory));
}
