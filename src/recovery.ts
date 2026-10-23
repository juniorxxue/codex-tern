import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SavedInput { id: string; text: string; images: string[] }
export interface SavedDraft { text: string; images: string[] }
export interface SavedSession {
  id: string; cwd: string; name?: string; preview?: string;
  draft: SavedDraft; queue: SavedInput[]; unconfirmed: SavedInput[]; inflight?: SavedInput;
}
interface RecoveryData { version: 1; selected?: string; notifications: boolean; sessions: SavedSession[] }

export function recoveryPath(projectAddress: string) {
  const root = process.env.XDG_STATE_HOME || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support') : process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : join(homedir(), '.local', 'state'));
  return join(root, 'codex-tern', 'recovery', createHash('sha256').update(projectAddress).digest('hex') + '.json');
}

const object = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const draft = (x: unknown): x is SavedDraft => object(x) && typeof x.text === 'string'
  && Array.isArray(x.images) && x.images.every((p: unknown) => typeof p === 'string');
const input = (x: unknown): x is SavedInput => draft(x) && typeof (x as SavedInput).id === 'string';
function validate(value: unknown): asserts value is RecoveryData {
  if (!object(value) || value.version !== 1 || typeof value.notifications !== 'boolean'
    || (value.selected !== undefined && typeof value.selected !== 'string') || !Array.isArray(value.sessions)
    || !value.sessions.every((s: unknown) => object(s) && typeof s.id === 'string' && typeof s.cwd === 'string'
      && (s.name === undefined || typeof s.name === 'string') && (s.preview === undefined || typeof s.preview === 'string')
      && draft(s.draft) && Array.isArray(s.queue) && s.queue.every(input)
      && Array.isArray(s.unconfirmed) && s.unconfirmed.every(input) && (s.inflight === undefined || input(s.inflight))))
    throw new Error('Unrecognized recovery file. The original file was left intact.');
}

/** Private client state only. Never reads or writes Codex's conversation files. */
export class RecoveryStore {
  private data: RecoveryData = { version: 1, notifications: true, sessions: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private writing = Promise.resolve();
  private saved = '';
  onError: (error: Error) => void = () => {};
  private constructor(readonly path: string) {}

  static async open(path: string) {
    const store = new RecoveryStore(path);
    try {
      const raw = await readFile(path, 'utf8');
      const value: unknown = JSON.parse(raw); validate(value);
      store.data = value; store.saved = JSON.stringify(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`Could not restore local drafts: ${(error as Error).message} (${path})`);
    }
    return store;
  }
  get selected() { return this.data.selected; }
  get notifications() { return this.data.notifications; }
  get sessions(): readonly SavedSession[] { return this.data.sessions; }
  session(id: string) { return this.data.sessions.find(s => s.id === id); }
  update(session: SavedSession) {
    const index = this.data.sessions.findIndex(s => s.id === session.id);
    if (index >= 0 && JSON.stringify(this.data.sessions[index]) === JSON.stringify(session)) return;
    const copy = structuredClone(session);
    if (index < 0) this.data.sessions.push(copy); else this.data.sessions[index] = copy;
    this.schedule();
  }
  select(id: string) {
    if (this.data.selected === id) return;
    this.data.selected = id; this.schedule();
  }
  remove(id: string) {
    this.data.sessions = this.data.sessions.filter(s => s.id !== id);
    if (this.data.selected === id) this.data.selected = undefined;
    this.schedule();
  }
  setNotifications(enabled: boolean) { this.data.notifications = enabled; this.schedule(); }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(error => this.onError(error)); }, 200);
    this.timer.unref();
  }
  /** Sending waits for this journal write before handing input to the backend. */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const value = JSON.stringify(this.data);
    const work = this.writing.then(async () => {
      if (value === this.saved) return;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
        this.saved = value;
      } finally { await rm(temporary, { force: true }); }
    });
    this.writing = work.catch(() => {});
    return work;
  }
}
