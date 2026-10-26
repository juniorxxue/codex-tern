import { connect, type Session, type Surface } from '@stencil-hq/tern';
import { readFile } from 'node:fs/promises';
import type { Controller } from './controller';
import type { NativeUI } from './ui';
import { EnhancedPasteController } from './clipboard/enhanced-paste';
import { ClipboardInput } from './clipboard/input';

export interface UIModule { UI_API_VERSION: number; NativeUI: typeof NativeUI }
export type UILoader = () => Promise<UIModule>;

/** Each build publishes an immutable bundle, then atomically updates its manifest. */
export async function loadNativeUI(manifest = new URL('../dist/ui.json', import.meta.url)): Promise<UIModule> {
  if (import.meta.url.endsWith('/native-host.ts') && manifest.href === new URL('../dist/ui.json', import.meta.url).href) {
    // Source development also reloads the complete UI dependency graph.
    const builder = new URL('../scripts/build-ui.mjs', import.meta.url).href;
    await (await import(builder)).buildUI();
  }
  const { file } = JSON.parse(await readFile(manifest, 'utf8'));
  if (typeof file !== 'string' || !/^ui-[a-f0-9]{64}\.mjs$/.test(file)) throw new Error('Invalid interface build. Run bun run build again.');
  return import(new URL(file, manifest).href);
}

function validate(module: UIModule) {
  if (module.UI_API_VERSION !== 4 || typeof module.NativeUI !== 'function')
    throw new Error('This update needs a client restart. Finish running tasks, then restart codex-tern.');
}

/** The terminal, controller and Codex process outlive every UI generation. */
export class NativeHost {
  private reloading?: Promise<void>;
  private closed = false;
  current: NativeUI;

  constructor(readonly c: Controller, readonly session: Session, readonly surface: Surface,
    module: UIModule, private readonly load: UILoader = loadNativeUI,
    readonly enhanced?: EnhancedPasteController, readonly clipboardInput?: ClipboardInput) {
    validate(module);
    this.current = new module.NativeUI(c, session, surface, enhanced, clipboardInput);
    this.current.reloadWindow = () => this.reload();
  }

  get openProject() { return this.current.openProject; }
  set openProject(value: NativeUI['openProject']) { this.current.openProject = value; }
  openSession(id: string) { return this.current.openSession(id); }
  newSession() { return this.current.newSession(); }
  openSidebar() { return this.current.openSidebar(); }

  reload(): Promise<void> {
    if (this.reloading) return this.reloading;
    const work = this.replaceUI().finally(() => { if (this.reloading === work) this.reloading = undefined; });
    this.reloading = work;
    return work;
  }

  private async replaceUI() {
    if (this.closed) throw new Error('This window is closed.');
    this.current.assertReloadable();
    const module = await this.load();
    validate(module);
    if (this.closed) throw new Error('This window is closed.');
    const old = this.current;
    // Input and backend events continue during import. Capture the state only
    // after loading, and recheck for sends, pastes or navigation in progress.
    const state = old.reloadState();
    let next: NativeUI | undefined;
    try {
      next = new module.NativeUI(this.c, this.session, this.surface, this.enhanced, this.clipboardInput, state);
      next.reloadWindow = () => this.reload(); next.openProject = old.openProject; next.notify = old.notify;
      next.generation = old.generation + 1;
      next.render();
    } catch (error) {
      next?.disposeForReload();
      old.applyStyles(); old.render(); old.focus();
      throw error;
    }
    old.disposeForReload();
    this.current = next;
    next.focus();
    this.c.notice('Window reloaded.');
  }

  async run() {
    const disablePaste = () => this.enhanced?.disable();
    process.once('exit', disablePaste); this.enhanced?.enable();
    this.current.render(); this.current.focus();
    try {
      for await (const input of this.session) {
        if (input.type === 'event') {
          if (input.event.ev === 'error') this.c.notice(`Tern: ${input.event.msg}`, true);
          if (input.event.ev === 'visible') this.current.setVisible(input.event.visible);
        } else if (!this.current.handleKey(input.key)) break;
      }
    } finally {
      disablePaste(); process.off('exit', disablePaste); await this.close();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.current.close();
  }
}

export async function createNativeUI(c: Controller) {
  let host: NativeHost | undefined;
  const enhanced = new EnhancedPasteController({
    write: data => process.stdout.write(data),
    pasteText: text => host?.current.pasteText(text),
    pasteFiles: paths => host?.current.pasteFiles(paths),
    pasteImage: image => host?.current.pasteBinary(Buffer.from(image.data, 'base64'), image.mimeType),
    showStatus: message => c.notice(message, true),
  });
  const input = process.stdin.isTTY ? new ClipboardInput(process.stdin,
    data => enhanced.handleInput(data), message => c.notice(message, true)) : undefined;
  let session: Session | null = null;
  try {
    session = await connect({ app: 'codex-tern', version: '0.1.0', features: ['edit', 'undo', 'send'], exitHooks: true,
      ...(input ? { input } : {}) });
    if (!session) { input?.dispose(); return null; }
    const module = await loadNativeUI();
    host = new NativeHost(c, session, session.open({ mode: 'inline', title: 'Codex × Tern', role: 'codex-tern' }), module,
      loadNativeUI, enhanced, input);
    return host;
  } catch (error) { await session?.close(); input?.dispose(); throw error; }
}
