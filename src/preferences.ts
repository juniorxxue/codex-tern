import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { recoveryPath } from './recovery';

export const preferencesPath = () => join(dirname(dirname(recoveryPath(''))), 'preferences.json');

/** Client preferences are shared across projects, independently of Codex config. */
export class Preferences {
  model?: string;
  private writing: Promise<void> = Promise.resolve();
  constructor(readonly path?: string) {}

  async load() {
    await this.writing;
    if (!this.path) return;
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data?.version !== 1 || (data.defaultModel !== undefined
        && (typeof data.defaultModel !== 'string' || !data.defaultModel.trim())))
        throw new Error('Invalid new session preferences.');
      this.model = data.defaultModel;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.model = undefined;
    }
  }

  setModel(model?: string) {
    const work = this.writing.then(async () => {
      if (this.path) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, defaultModel: model }) + '\n', { mode: 0o600 });
          await rename(temporary, this.path);
        } finally { await rm(temporary, { force: true }); }
      }
      this.model = model;
    });
    this.writing = work.catch(() => {});
    return work;
  }
}
