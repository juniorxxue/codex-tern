import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Only call this with an isolated QA profile, before starting any Tern process.
export async function prepareTernQaConfig(config) {
  const omp = resolve(config, 'omp');
  await mkdir(omp, { recursive: true });
  // Match Tern's persisted "Not Now" choice. Fresh test profiles must not open
  // the native first-launch prompt or opt into managing the user's omp binary.
  await writeFile(resolve(omp, 'state.json'), JSON.stringify({
    managed: false,
    checked: 0,
    no_build: false,
    offered: true,
  }, null, 2) + '\n');
}
