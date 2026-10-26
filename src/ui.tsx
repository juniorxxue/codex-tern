/** @jsxImportSource @stencil-hq/tern */
import { css, html, Node, type Session, type Surface, type PickerItem, type Key } from '@stencil-hq/tern';
import { basename, dirname, join, resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { projectRoot } from './project-instance';
import { isImagePath, loadImage, savePastedImage, pastedImagePaths, type PreviewImage } from './attachments';
import { readSystemClipboard } from './clipboard/system';
import { markdownFileLinks } from './clipboard/files';
import { EnhancedPasteController } from './clipboard/enhanced-paste';
import { ClipboardInput } from './clipboard/input';
import { Controller, type DisplayItem, type PendingRequest, type Completion } from './controller';
import { completionNotification } from './notifications';
import { FolderSessions } from './folder-sessions';
import { sessionInUse } from './session-locks';
import { Draft } from './draft';
import { Composer } from './composer';
import { isRpcOutcomeUnknown } from './rpc';
import type { ReasoningEffort } from './generated/ReasoningEffort';
import type { UserInput } from './generated/v2/UserInput';
import { Welcome, ComposerFrame } from './omp-views';
import { ompNode } from './omp-native';
import { transcriptParts, activitySummary, compactActivity, type TranscriptPart } from './activity';
import { appearanceStyles } from './appearance';
import { assistantMarkdown } from './assistant-markdown';
import { assistantParts } from './proposals';
import { ProposalView } from './proposal-view';
import { runPluginCommand } from './tern-plugin';
import { SessionDetails, WorkspaceForm, modelName } from './session-panels';
import { ReadingPositions, readingAnchorClass, inspectReadingFocus } from './reading-position';

const styles = css`
  .ct-buttons { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .ct-button { padding: 5px 10px; border-radius: 6px; background: var(--raise); color: var(--t2); }
  .ct-button:hover { background: var(--l2); color: var(--t1); }
  .ct-primary { color: var(--accent-ink); }
  .ct-danger { color: var(--bad); }
  .ct-request { padding: 12px; border-radius: 10px; background: var(--card); box-shadow: inset 0 0 0 1px var(--l2); }
  .ct-choice { padding: 8px 10px; border-radius: 6px; background: var(--raise); }
  .ct-selected { box-shadow: inset 0 0 0 1px var(--accent); }
  [data-role="ct.nav"] > [data-role="omp.status"] { min-width: 0; flex: 1 1 0; overflow: hidden; }
  .ct-activity { min-width: 0; padding: 4px 2px; color: var(--t3); }
  .ct-activity-toggle { display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 0; text-align: left; color: var(--t3); cursor: pointer; }
  .ct-activity-toggle:hover { color: var(--t1); }
  .ct-activity-preview { margin: 2px 0 5px 20px; padding-left: 10px; border-left: 1px solid var(--l2); }
  .ct-activity-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ct-activity-output { font: 12px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; max-height: 4.5em; overflow: hidden; }
  [data-role="omp.user.images"] { min-width: 0; align-items: flex-start; }
  [data-role="omp.user.images"] .sf-image { max-width: 100%; border-radius: 8px; overflow: hidden; }
  [data-role="omp.user.images"] .sf-image img { display: block; max-width: 100%; height: auto; object-fit: contain; }
`;

// Increment when the retained runtime or reload state needs an incompatible change.
export const UI_API_VERSION = 3;
export type NativeUIState = ReturnType<NativeUI['reloadState']>;

export class NativeUI {
  private readonly clientInstance = randomUUID();
  private sidebarRequested = false;
  private composer = new Composer();
  get draft() { return this.composer.draft; }
  set draft(value: Draft) { this.composer.draft = value; }
  dialogDraft = new Draft();
  get images() { return this.composer.images; }
  set images(value: readonly string[]) { this.composer.images = value; }
  private previews = new Map<string, PreviewImage & { blob: string }>();
  private loadingPreviews = new Set<string>();
  private pasting = 0;
  private failedPreviews = new Set<string>();
  private deferredKeys: Key[] = [];
  panel: 'history' | 'models' | 'default-model' | 'folders' | 'effort' | 'send-mode' | 'workspace' | 'attach' | 'rename' | 'details' | 'help' | 'diff' | 'menu' | null = null;
  private pickerReturn?: { panel: 'workspace' | 'details'; draft: Draft };
  private preferenceSaving = false;
  private preferenceError = '';
  private workspaceError = '';
  private workspaceOpening = false;
  private folderBrowser = { directory: '', items: [] as PickerItem[], loading: false, error: '' };
  private folderRead = 0;
  private renaming?: { id: string; saving: boolean; error: string };
  allThreads = false;
  historyLoading = false;
  answerTarget: { requestId: string | number; questionId: string } | null = null;
  sendMode: 'steer' | 'queue' = 'steer';
  private renderTimer?: NodeJS.Timeout;
  private ended = false;
  private pendingActions = 0;
  private focused = 'dock.body.line.input';
  private savedDraft: Draft | null = null;
  private pickerSelected = '';
  private activityModes = new Map<string, 'expanded' | 'collapsed'>();
  private proposalSelections = new Map<string, Set<string>>();
  private proposalDrafts = new WeakMap<Draft, { text: string; prefix: string }>();
  private readonly folderSessions: FolderSessions;
  private sessionDrafts = new Map<string, { composer: Composer;
    answerTarget: NativeUI['answerTarget']; savedDraft: Draft | null }>();
  private pendingSession?: string;
  private navigating = false;
  private readingPositions = new ReadingPositions(() => this.render(),
    () => `ct.transcript.${this.clientInstance}`, id => this.surface.reveal(id, 'start'), () => this.session.caps.cell.h);
  private sidebarNavigation?: { request: string; target: string; pending: boolean };
  private tocJump = 0;
  private tocJumping = false;
  private tocInspecting = false;
  private tocLines?: number;
  private readingPrompts = new Map<string, string>();
  private tocLocation?: { threadId: string; nodeId: string; visit: number };
  private tocError?: { threadId: string; message: string };
  openProject?: (cwd: string, resume?: string) => Promise<boolean>;
  private readonly projectDirectory: string;
  private composerThread?: string;
  private completion?: Completion;
  private completionTimer?: ReturnType<typeof setTimeout>;
  private visible = true;
  generation = 0;
  reloadWindow?: () => Promise<void>;
  notify: (event: Completion) => void = event => {
    if (process.stdout.isTTY) process.stdout.write(completionNotification(event));
  };

  constructor(readonly c: Controller, readonly session: Session, readonly surface: Surface,
    readonly enhanced?: EnhancedPasteController, readonly clipboardInput?: ClipboardInput, state?: NativeUIState) {
    this.applyStyles();
    this.projectDirectory = c.cwd;
    this.folderSessions = new FolderSessions(c, () => this.schedule());
    if (state) {
      const { folder, reading, ...saved } = state;
      Object.assign(this, saved);
      for (const [id, position] of reading ?? []) this.readingPositions.saved.set(id, position);
      this.folderSessions.restoreReloadState(folder);
    }
    c.on('change', this.onChange);
    c.on('completion', this.onCompletion);
  }

  applyStyles() {
    this.surface.stylesheet('codex-tern', styles);
    this.surface.stylesheet('codex-tern-appearance', appearanceStyles);
  }

  private async jumpOutline(value?: string) {
    if (!value || this.c.selecting || this.navigating) return;
    let request: { threadId: string; revision: string; nodeId: string; visit: number };
    try {
      request = JSON.parse(value);
      if (!request || typeof request.threadId !== 'string' || typeof request.revision !== 'string'
        || typeof request.nodeId !== 'string' || !Number.isInteger(request.visit)) return;
    } catch { return; }
    const { threadId, revision, nodeId, visit } = request;
    const target = this.c.outlineTarget(threadId, revision, nodeId, visit);
    if (!target || this.c.thread?.id !== threadId) return;
    const token = ++this.tocJump;
    const current = () => !this.ended && this.tocJump === token && this.c.thread?.id === threadId;
    this.tocError = undefined; this.tocJumping = true;
    try {
      while (current() && !this.c.items.some(i => i.id === target) && this.c.historyCursor) {
        const before = this.c.historyCursor;
        await this.c.loadHistory();
        if (this.c.historyCursor === before) throw new Error('History did not advance');
      }
      if (!current()) return;
      const entry = this.c.items.find(i => i.id === target && i.item.type === 'userMessage');
      if (!entry) throw new Error('Prompt unavailable');
      // Steering cards use client IDs to retain their identity after server acknowledgement.
      const key = entry.item.type === 'userMessage' && entry.item.clientId
        ? `${entry.turnId}:client:${entry.item.clientId}` : entry.id;
      this.tocLocation = { threadId, nodeId, visit }; this.render();
      await this.readingPositions.jump(threadId, `main.${key}`, current);
    } catch {
      if (current()) { this.tocError = { threadId, message: 'Could not locate this prompt. Rebuild TOC or try again.' }; this.render(); }
    } finally { if (this.tocJump === token) this.tocJumping = false; }
  }

  private async followOutline() {
    const outline = this.c.outline;
    if (this.ended || !this.visible || this.panel || this.navigating || this.c.selecting || this.tocJumping
      || this.tocInspecting || !outline?.topics.length) return;
    const { threadId, revision } = outline, jump = this.tocJump, prompts = this.readingPrompts;
    this.tocInspecting = true;
    try {
      const focus = await inspectReadingFocus(`ct.transcript.${this.clientInstance}`, this.clientInstance);
      if (!focus || this.ended || !this.visible || this.panel || this.navigating || this.c.selecting
        || this.tocJumping || this.tocJump !== jump || this.c.thread?.id !== threadId || this.c.outline?.revision !== revision) return;
      const prompt = focus.node && prompts.get(focus.node);
      const location = prompt ? this.c.outlineLocation(threadId, prompt) : undefined;
      const next = location && { threadId, ...location };
      if (JSON.stringify(this.tocLocation) !== JSON.stringify(next) || this.tocLines !== focus.lines) {
        this.tocLocation = next; this.tocLines = focus.lines; this.render();
      }
    } finally { this.tocInspecting = false; }
  }

  assertReloadable() {
    if (this.ended) throw new Error('This window is closed.');
    if (this.pasting || this.pendingActions || this.c.operation || this.c.selecting || this.navigating
      || this.renaming?.saving || this.historyLoading || this.sidebarRequested)
      throw new Error('Wait for the current input or session action to finish, then reload the window.');
  }

  reloadState() {
    this.assertReloadable(); this.syncComposer();
    return { clientInstance: this.clientInstance, projectDirectory: this.projectDirectory,
      composer: this.composer, composerThread: this.composerThread, sessionDrafts: this.sessionDrafts,
      savedDraft: this.savedDraft, answerTarget: this.answerTarget, dialogDraft: this.dialogDraft,
      panel: this.panel, renaming: this.renaming, allThreads: this.allThreads, pickerSelected: this.pickerSelected,
      pickerReturn: this.pickerReturn, folderBrowser: this.folderBrowser, workspaceError: this.workspaceError,
      focused: this.focused, visible: this.visible, sendMode: this.sendMode,
      activityModes: this.activityModes, proposalSelections: this.proposalSelections, proposalDrafts: this.proposalDrafts,
      previews: this.previews, failedPreviews: this.failedPreviews, folder: this.folderSessions.reloadState(),
      reading: this.readingPositions.saved, tocLocation: this.tocLocation, tocError: this.tocError, tocLines: this.tocLines };
  }

  private requestReload() {
    if (!this.reloadWindow) return;
    if (this.panel === 'menu') this.closePanel();
    void this.reloadWindow().catch(error => this.c.notice(`Could not reload window: ${error.message}`, true));
  }

  focus() { this.surface.focus(this.focused || null); }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible && this.c.thread) this.c.markRead(this.c.thread.id);
  }

  private onChange = () => {
    if (this.completion && (this.c.sessionStatus(this.completion.threadId).running
      || (this.completion.threadId === this.c.thread?.id && ['Sending…', 'Steering…'].includes(this.c.operation)))) {
      this.completion = undefined;
      if (this.completionTimer) clearTimeout(this.completionTimer);
    }
    this.schedule();
  };
  private onCompletion = (event: Completion) => {
    if (this.ended) return;
    if (this.c.notifications) {
      this.completion = event;
      if (this.completionTimer) clearTimeout(this.completionTimer);
      this.completionTimer = setTimeout(() => { this.completion = undefined; this.schedule(); }, 8000);
      this.notify(event);
    }
    if (event.threadId === this.c.thread?.id && this.visible) this.c.markRead(event.threadId);
    this.schedule();
  };
  private saveComposer(id: string, composer: Composer, savedDraft: Draft | null = null) {
    this.c.saveDraft(id, { text: (savedDraft ?? composer.draft).submittedText, images: [...composer.images] });
  }
  private syncComposer() {
    const id = this.c.thread?.id;
    if (!id) return;
    if (this.composerThread !== id) {
      if (this.composerThread) {
        this.saveComposer(this.composerThread, this.composer, this.savedDraft);
        this.sessionDrafts.set(this.composerThread, { composer: this.composer, answerTarget: this.answerTarget, savedDraft: this.savedDraft });
      }
      const saved = this.sessionDrafts.get(id), recovered = this.c.savedDraft(id);
      if (saved) {
        this.composer = saved.composer; this.answerTarget = saved.answerTarget; this.savedDraft = saved.savedDraft;
      } else if (this.composerThread || recovered) {
        const earlyText = !this.composerThread ? this.composer.draft.submittedText : '';
        const earlyImages = !this.composerThread ? this.composer.images : [];
        this.composer = new Composer(); this.answerTarget = null; this.savedDraft = null;
        this.draft.set([recovered?.text, earlyText].filter(Boolean).join('\n\n'));
        this.images = [...(recovered?.images ?? []), ...earlyImages];
      }
      this.composerThread = id;
      if (this.visible) this.c.markRead(id);
    }
    this.saveComposer(id, this.composer, this.savedDraft);
    for (const [other, saved] of this.sessionDrafts) if (other !== id)
      this.saveComposer(other, saved.composer, saved.savedDraft);
  }

  private schedule() {
    if (this.ended || this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.render(); }, 25);
  }
  private action(fn: () => Promise<unknown>) {
    this.pendingActions++;
    void this.c.act(fn).finally(() => { this.pendingActions--; });
  }
  private button(label: string, action: () => void, extra = '', disabled = false) {
    return <html.button key={label} class={`ct-button ${extra}`} aria={label} attrs={{ 'aria-disabled': disabled }}
      onClick={disabled ? undefined : () => { action(); this.render(); }}>{label}</html.button>;
  }
  private focusComposer() { this.focused = 'dock.body.line.input'; this.surface.focus(this.focused); }
  async openSidebar() {
    if (this.ended) return;
    void this.folderSessions.refresh();
    this.sidebarRequested = true; this.render();
    try { await runPluginCommand('sessions'); }
    catch { /* The native client remains usable without the optional window plugin. */ }
    finally { this.sidebarRequested = false; this.schedule(); }
  }
  private hasSessionDraft(id: string) {
    const saved = this.sessionDrafts.get(id);
    const recovered = this.c.savedDraft(id);
    return id === this.c.thread?.id ? !!(this.draft.text || this.images.length || this.answerTarget)
      : saved ? !!(saved.composer.draft.text || saved.composer.images.length || saved.answerTarget)
        : !!(recovered?.text || recovered?.images.length);
  }
  private async archiveSession(id?: string) {
    if (!id || !this.folderSessions.contains(id)) throw new Error('This session is no longer in the current folder.');
    if (this.panel || this.pasting) throw new Error('Finish the paste or close the open dialog before deleting.');
    if (this.folderSessions.isLocked(id)) throw new Error('This session is open in another client.');
    if (this.hasSessionDraft(id)) throw new Error('Send or clear this session\'s draft before deleting it.');
    const rows = this.folderSessions.snapshot.rows;
    const at = rows.findIndex(row => row.id === id);
    const replacement = [...rows.slice(at + 1), ...rows.slice(0, at).reverse()].find(row => !row.locked)?.id;
    if (await this.navigate(() => this.c.archiveThread(id, replacement))) {
      this.sessionDrafts.delete(id); this.readingPositions.saved.delete(id);
    }
  }
  private openRenameSession(id?: string) {
    const thread = id ? this.folderSessions.get(id) : undefined;
    if (!thread || this.c.isArchived(thread.id)) throw new Error('This session is no longer in the current folder.');
    if (this.panel || this.pasting) throw new Error('Finish the paste or close the open dialog before renaming.');
    if (this.c.connection !== 'ready' || this.c.selecting) throw new Error('Wait for the session to finish connecting.');
    this.renaming = { id: thread.id, saving: false, error: '' };
    this.openPanel('rename', (thread.name || thread.preview || '').replace(/\s+/g, ' ').trim());
  }
  private async confirmRename() {
    const target = this.renaming, name = this.dialogDraft.text.replace(/\s+/g, ' ').trim();
    if (this.panel !== 'rename' || !target || target.saving || !name) return;
    target.saving = true; target.error = ''; this.render();
    try {
      if (!this.folderSessions.contains(target.id)) throw new Error('This session is no longer in the current folder.');
      await this.c.renameThread(target.id, name);
      if (this.renaming === target) this.closePanel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.renaming === target) target.error = message;
      else this.c.notice(`Could not rename session: ${message}`, true);
    } finally { target.saving = false; this.render(); }
  }
  private async resumeFromSidebar(value?: string) {
    let id = value;
    let request: string | undefined;
    if (value?.startsWith('{')) {
      try {
        const action = JSON.parse(value);
        if (typeof action.id !== 'string' || typeof action.request !== 'string') return;
        id = action.id; request = action.request;
      } catch { return; }
    }
    if (request) this.sidebarNavigation = { request, target: id!, pending: true };
    if (id && this.folderSessions.contains(id) && (this.c.selecting || this.navigating)) {
      this.pendingSession = value; this.schedule(); return;
    }
    try {
      if (!id || !this.folderSessions.contains(id)) {
        this.folderSessions.fail('This session is no longer in the current folder.'); return;
      }
      await this.openSession(id);
    } finally {
      if (request && this.sidebarNavigation?.request === request) this.sidebarNavigation.pending = false;
      this.schedule();
    }
  }

  async openSession(id: string): Promise<boolean> {
    if (this.folderSessions.isLocked(id)) return false;
    const thread = this.c.threads.find(t => t.id === id);
    if (thread && this.openProject && await projectRoot(thread.cwd) !== await projectRoot(this.projectDirectory))
      return this.openProject(thread.cwd, id);
    if (this.pasting || this.panel) {
      this.folderSessions.fail('Finish the paste or close the open dialog before switching.'); return false;
    }
    return this.navigate(() => this.c.resume(id), id);
  }

  async newSession(cwd = this.c.cwd): Promise<boolean> {
    if (this.pasting) { this.c.notice('Wait for the paste to finish.'); return false; }
    if (this.openProject && await projectRoot(cwd) !== await projectRoot(this.projectDirectory))
      return this.openProject(cwd);
    return this.navigate(() => this.c.newThread(cwd));
  }
  async forkSession(threadId: string, turnId: string): Promise<boolean> {
    if (this.panel || this.pasting || this.c.operation || this.c.thread?.id !== threadId) return false;
    return this.navigate(() => this.c.forkThread(threadId, turnId), undefined, true);
  }

  private async navigate(change: () => Promise<void>, id?: string, reportError = false): Promise<boolean> {
    if (this.navigating) return false;
    this.navigating = true;
    this.tocJump++; this.tocJumping = false;
    this.syncComposer();
    this.folderSessions.clearError();
    const previous = this.c.thread?.id;
    try {
      await this.readingPositions.capture(previous);
      if (this.ended) return false;
      await change(); return true;
    }
    catch (error) {
      if (id && sessionInUse(error)) this.folderSessions.markLocked(id);
      else {
        const message = error instanceof Error ? error.message : String(error);
        this.folderSessions.fail(message);
        if (reportError) this.c.notice(message, true);
      }
      return false;
    }
    finally {
      this.syncComposer();
      this.render(); this.focusComposer();
      if (this.c.thread?.id !== previous) await this.readingPositions.restore(this.c.thread?.id);
      this.navigating = false;
      if (this.pendingSession) {
        const next = this.pendingSession; this.pendingSession = undefined;
        void this.resumeFromSidebar(next);
      }
    }
  }
  private closePanel() {
    this.folderRead++;
    if (this.pickerReturn && ['default-model', 'folders', 'models', 'effort'].includes(this.panel ?? '')) {
      const back = this.pickerReturn; this.pickerReturn = undefined;
      this.panel = back.panel; this.dialogDraft = back.draft; this.render();
      this.focused = back.panel === 'workspace' ? 'layer.panel.body.field' : '';
      this.surface.focus(this.focused || null); return;
    }
    this.panel = null; this.renaming = undefined; this.pickerReturn = undefined;
    this.render(); this.focusComposer();
  }
  private openModelPicker(panel: 'default-model' | 'models' | 'effort') {
    if (this.panel === 'workspace' || this.panel === 'details')
      this.pickerReturn = { panel: this.panel, draft: this.dialogDraft };
    this.openPanel(panel);
  }
  private openPanel(panel: NonNullable<NativeUI['panel']>, text = '') {
    if (this.pasting) { this.c.notice('Wait for the paste to finish.'); return; }
    this.panel = panel; this.dialogDraft = new Draft();
    this.pickerSelected = panel === 'models' ? this.c.model : panel === 'default-model' ? this.c.newSessionModel ?? 'codex-default' : panel === 'effort' ? this.c.effort
      : panel === 'send-mode' ? this.sendMode : panel === 'history' ? this.c.thread?.id ?? '' : '';
    if (panel === 'history') {
      this.historyLoading = true;
      this.action(async () => { try { await this.c.listThreads(this.allThreads); } finally { this.historyLoading = false; this.render(); } });
    }
    if (panel === 'workspace') { this.dialogDraft.set(this.c.cwd); this.workspaceError = ''; }
    else if (panel === 'rename') this.dialogDraft.set(text);
    if (panel === 'default-model') this.preferenceError = '';
    if (['default-model', 'workspace', 'details'].includes(panel) && this.c.refreshPreferences)
      this.action(() => this.c.refreshPreferences());
    this.render();
    if (panel === 'workspace' || panel === 'attach' || panel === 'rename') {
      this.focused = 'layer.panel.body.field'; this.surface.focus(this.focused);
    } else { this.focused = ''; this.surface.focus(null); }
  }

  private async saveDefaultModel(id: string) {
    if (this.preferenceSaving) return;
    this.preferenceSaving = true; this.preferenceError = ''; this.render();
    try {
      if (!this.c.setNewSessionModel) throw new Error('Finish running tasks, then restart codex-tern once to enable saved defaults.');
      await this.c.setNewSessionModel(id === 'codex-default' ? undefined : id);
      if (this.panel === 'default-model') this.closePanel();
    } catch (error) { this.preferenceError = (error as Error).message; }
    finally { this.preferenceSaving = false; this.render(); }
  }

  private async browseFolders() {
    this.pickerReturn = { panel: 'workspace', draft: this.dialogDraft };
    const path = this.workspacePath();
    this.openPanel('folders');
    await this.readFolders(path);
  }
  private async readFolders(directory: string) {
    const read = ++this.folderRead;
    this.folderBrowser = { directory, items: [], loading: true, error: '' };
    this.dialogDraft.set(''); this.render();
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const directories = (await Promise.all(entries.map(async entry => entry.isDirectory()
        || (entry.isSymbolicLink() && (await stat(join(directory, entry.name)).catch(() => null))?.isDirectory()) ? entry.name : null)))
        .filter((name): name is string => name !== null).sort((a, b) => a.localeCompare(b));
      if (read !== this.folderRead || this.panel !== 'folders') return;
      this.folderBrowser.items = [
        ...(dirname(directory) !== directory ? [{ id: dirname(directory), label: 'Parent folder', detail: dirname(directory), icon: 'arrow-up' }] : []),
        ...directories.map(name => ({ id: join(directory, name), label: name, icon: 'folder' })),
      ];
    } catch (error) {
      if (read === this.folderRead) this.folderBrowser.error = `Could not open this folder: ${(error as Error).message}`;
    } finally {
      if (read === this.folderRead) { this.folderBrowser.loading = false; this.render(); }
    }
  }
  private useFolder() {
    if (this.folderBrowser.loading || this.folderBrowser.error) return;
    this.pickerReturn?.draft.set(this.folderBrowser.directory);
    this.workspaceError = ''; this.closePanel();
  }
  private workspacePath() {
    return resolve(this.c.cwd, this.dialogDraft.text.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  }

  private renderAssistant(entry: DisplayItem, text: string) {
    const parts = assistantParts(text);
    const proposals = parts.filter(part => part.kind === 'proposal');
    const threadId = this.c.thread?.id;
    const key = JSON.stringify([threadId, entry.turnId, entry.id]);
    // Match the source as well as its position so revised suggestions lose stale checks.
    const ids = proposals.map(part => JSON.stringify([part.start, part.before, part.after]));
    const selection = this.proposalSelections.get(key) ?? new Set<string>();
    for (const id of selection) if (!ids.includes(id)) selection.delete(id);
    const selected = () => ids.flatMap((id, index) => selection.has(id) ? [index + 1] : []);
    const available = () => !!threadId && this.c.thread?.id === threadId && !this.c.operation &&
      !this.panel && !this.answerTarget && !this.pasting && this.c.items.some(item =>
        item.id === entry.id && item.turnId === entry.turnId && item.done &&
        item.item.type === 'agentMessage' && item.item.text === text);
    const disabled = !available();
    const forkable = this.c.forkReply(entry.turnId)?.id === entry.id;
    const forkEnabled = () => !!threadId && this.c.thread?.id === threadId && this.c.sessionReady
      && !this.c.operation && !this.panel && !this.pasting && this.c.forkReply(entry.turnId)?.id === entry.id;
    let number = 0;
    return <col key={entry.id} role="omp.assistant" gap="xs">
      {parts.map(part => {
        if (part.kind === 'markdown') return <md key={`text-${part.start}`}
          text={assistantMarkdown(part.text, this.c.cwd)} stream={!entry.done}
          actions={{ menu: ['copy'] }} />;
        const id = ids[number++]!;
        return <ProposalView key={`proposal-${part.start}`} before={part.before} after={part.after}
          number={number} checked={selection.has(id)} disabled={disabled} onSelect={checked => {
            if (!available()) return;
            if (checked) selection.add(id); else selection.delete(id);
            this.proposalSelections.set(key, selection); this.render();
          }} />;
      })}
      {!!proposals.length && <html.div key="proposal-actions" class="ct-proposal-actions">
        <html.button class="ct-button ct-proposal-apply" aria="Apply selected edits" attrs={{ 'aria-disabled': disabled || !selected().length }}
          title="Add a request to the message box" onClick={() => {
            const numbers = selected();
            if (!available() || !numbers.length) return;
            let prompt = `Apply the edits ${numbers.join(', ')}.`;
            const index = this.c.items.findIndex(item => item.id === entry.id && item.turnId === entry.turnId);
            if (this.c.items.slice(index + 1).some(item => item.item.type === 'agentMessage' &&
              assistantParts(item.item.text).some(part => part.kind === 'proposal'))) {
              const beginning = proposals[0]!.before.trim().slice(0, 160);
              prompt += `\n\nUse the earlier proposal reply whose first original passage begins:\n${beginning}`;
            }
            // Repeated clicks update our untouched request; user-written text stays intact.
            const previous = this.proposalDrafts.get(this.draft);
            const prefix = previous?.text === this.draft.text ? previous.prefix : this.draft.text;
            const next = prefix ? `${prefix}\n\n${prompt}` : prompt;
            if (next !== this.draft.text) this.draft.set(next);
            this.proposalDrafts.set(this.draft, { text: next, prefix });
            this.render(); this.focusComposer();
          }}>Apply selected edits</html.button>
        <html.span class="ct-proposal-count" text={`${selected().length} selected`} />
      </html.div>}
      {forkable && <row key="actions" role="ct.reply.actions" gap="sm" align="center">
        <html.button key="fork" class="ct-reply-action" role="ct.reply.fork" aria="Fork from here"
          title="Start a new session with the conversation up to this reply"
          attrs={{ 'aria-disabled': !forkEnabled() }} onClick={() => {
            if (forkEnabled()) void this.forkSession(threadId!, entry.turnId);
          }}><icon name="branch" /><text text="Fork from here" /></html.button>
      </row>}
    </col>;
  }

  private renderItem(entry: DisplayItem) {
    const i = entry.item;
    const itemStatus = 'status' in i ? i.status : undefined;
    const status = itemStatus === 'failed' || itemStatus === 'declined' ? 'error'
      : itemStatus === 'inProgress' || !entry.done ? 'running' : 'done';
    if (i.type === 'userMessage') {
      const content: UserInput[] = i.content ?? [];
      const images = content.filter(p => p.type === 'localImage' || p.type === 'image');
      const text = content.filter(p => p.type !== 'localImage' && p.type !== 'image')
        .map(p => p.type === 'text' ? p.text : `[${p.type}] ${'path' in p ? p.path : ''}`).join('\n');
      return <card key={i.clientId ? `${entry.turnId}:client:${i.clientId}` : entry.id} role="omp.user" tone="user">
        <col key="content" gap="sm">
          {!!images.length && <row key="images" role="omp.user.images" gap="sm" wrap>
            {images.map((p, n) => p.type === 'localImage' ? this.imageNode(p.path)
              : 'url' in p && p.url.startsWith('data:') ? this.imageNode(p.url)
              : <text key={`unavailable-${n}`} tone="muted" text="Image unavailable" />)}
          </row>}
          {!!text && <md key="text" text={text} actions={{ menu: ['copy'] }} />}
          {entry.delivery && <text key="delivery" role="ct.user.delivery" tone="muted"
            text={entry.delivery === 'sending' ? 'Sending…' : 'Waiting for Codex…'} />}
        </col>
      </card>;
    }
    if (i.type === 'agentMessage') return this.renderAssistant(entry, i.text);
    if (i.type === 'reasoning' && entry.done && !(i.summary ?? []).join('').trim()) return null;
    if (i.type === 'reasoning') return <section key={entry.id} role={entry.done ? 'omp.thinking' : 'omp.thinking.live'} head={entry.done ? 'Thought summary' : 'Thinking…'} collapsible collapsed>
      <md key="text" text={(i.summary ?? []).join('\n\n') || 'Thinking…'} stream={!entry.done} />
    </section>;
    if (i.type === 'commandExecution') return <tool key={entry.id} name="shell" title="Run command"
      target={i.command} targetKind="command" status={status} collapsible collapsed={entry.done}
      exit={i.exitCode ?? undefined} took={i.durationMs != null ? i.durationMs / 1000 : undefined}
      meta={[i.cwd ?? '']} preview={{ tail: 8 }}>
      <code key="out" text={i.aggregatedOutput ?? ''} lang="text" wrap />
    </tool>;
    if (i.type === 'fileChange') return <tool key={entry.id} name="edit" title="File changes" status={status} collapsible>
      {(i.changes ?? []).map((f: any, n: number) => <diff key={`f${n}`} text={f.diff} path={f.path} mode="unified" />)}
    </tool>;
    if (i.type === 'functionCallOutput') return <tool key={entry.id} name="code" title={i.name ?? 'Tool output'} status="done" collapsible collapsed>
      <code key="output" text={typeof i.output === 'string' ? i.output : JSON.stringify(i.output, null, 2)} lang="text" wrap />
    </tool>;
    if (i.type === 'mcpToolCall' || i.type === 'dynamicToolCall') return <tool key={entry.id} name="mcp"
      title={`${i.type === 'mcpToolCall' ? i.server : i.namespace ?? 'tool'} · ${i.tool}`} status={status} collapsible collapsed={entry.done}>
      <code key="args" text={JSON.stringify(i.arguments, null, 2)} lang="json" wrap />
      <code key="result" text={JSON.stringify(i.type === 'mcpToolCall' ? i.error ?? i.result ?? '' : i.contentItems ?? '', null, 2)} lang="json" wrap />
    </tool>;
    if (i.type === 'collabAgentToolCall') return <agent key={entry.id} name={i.tool}
      task={i.prompt ?? (i.receiverThreadIds ?? []).join(', ')} status={status === 'error' ? 'failed' : status}
      model={i.model ?? undefined} collapsible collapsed={entry.done} />;
    if (i.type === 'plan') return <card key={entry.id} head="Plan" collapsible><md text={assistantMarkdown(i.text, this.c.cwd)} /></card>;
    if (i.type === 'contextCompaction') return <text key={entry.id} tone="muted" text="Context compacted" />;
    return <section key={entry.id} head={i.type} collapsible collapsed><code text={JSON.stringify(i, null, 2)} lang="json" wrap /></section>;
  }

  private renderActivity(part: Extract<TranscriptPart, { kind: 'activity' }>, latest: boolean) {
    const turn = this.c.turns.get(part.turnId);
    // An answer can be delivered before work continues in the same turn.
    // Use the turn lifecycle, as the Stop button and session status do.
    const live = latest && this.c.activeTurn === part.turnId;
    // A completed turn gets a new default. Opening details during a run never
    // leaves command output expanded after the turn ends.
    const key = `${part.id}:${live ? 'live' : 'ended'}`;
    const mode = this.activityModes.get(key) ?? (live ? 'compact' : 'collapsed');
    const errors = part.entries.some(({ item }) => ('status' in item && (item.status === 'failed' || item.status === 'declined'))
      || (item.type === 'commandExecution' && item.exitCode != null && item.exitCode !== 0));
    const state = live ? this.c.requests.length ? 'Needs input' : 'Working' : turn?.status === 'interrupted' ? 'Stopped'
      : turn?.status === 'failed' ? 'Failed' : this.c.connection === 'disconnected' && part.entries.some(e => !e.done) ? 'Disconnected' : 'Worked';
    const duration = !live && turn?.durationMs != null ? ` for ${Math.max(1, Math.round(turn.durationMs / 1000))}s` : '';
    const summary = activitySummary(part.entries);
    const label = `${state}${duration}${summary ? ` · ${summary}` : ''}${errors ? ' · has errors' : ''}`;
    const preview = compactActivity(part.entries.at(-1)!);
    return <html.div key={`activity-${part.id}`} class="ct-activity">
      <html.button key="toggle" class="ct-activity-toggle" aria={`${mode === 'expanded' ? 'Hide' : 'Show'} activity details · ${label}`}
        attrs={{ 'aria-expanded': mode === 'expanded' }}
        onClick={() => {
          this.activityModes.set(key, mode === 'expanded' ? 'collapsed' : 'expanded'); this.render();
        }}>
        <icon key="chevron" role="ct.activity.chevron" name={mode === 'expanded' ? 'chev' : 'chev-r'} />
        <html.span key="indicator" class="ct-activity-indicator">
          {live && !this.c.requests.length ? <spinner key="progress" style="starburst" />
            : <icon name={state === 'Needs input' ? 'message' : state === 'Stopped' ? 'stop'
              : state === 'Failed' || state === 'Disconnected' || errors ? 'warn' : 'check'} />}
        </html.span>
        <html.span key="label" class="ct-activity-label">
          <text key="state" role="ct.activity.state" text={state} />
          <text key="meta" role="ct.activity.meta" text={`${duration}${summary ? ` · ${summary}` : ''}${errors ? ' · has errors' : ''}`.trim()} />
        </html.span>
      </html.button>
      {mode === 'compact' && <html.div key="preview" class="ct-activity-preview">
        <html.div class={`ct-activity-title ${part.entries.at(-1)!.item.type === 'commandExecution' ? 'ct-activity-command' : ''}`} title={preview.title}>{preview.title}</html.div>
        {preview.output && <html.pre class="ct-activity-output">{preview.output}</html.pre>}
      </html.div>}
      {mode === 'expanded' && <col key="details" role="ct.activity.details" gap="sm">{part.entries.map(e => this.renderItem(e))}</col>}
    </html.div>;
  }

  private renderRequest(r: PendingRequest) {
    const p = r.params;
    const relevant = !p.threadId || p.threadId === this.c.thread?.id;
    const respond = (result: unknown) => { if (relevant) this.c.answer(r.id, result); };
    if (r.method === 'item/tool/requestUserInput') return <html.div key={`req${r.id}`} class="ct-request">
      <col gap="md">
        <row role="ct.request.heading" gap="sm" align="center"><icon name="message" /><text>Codex needs your input</text></row>
        {(p.questions ?? []).map((q: any) => <col key={`question-${q.id}`} role="ct.request.question" gap="sm">
          {q.header && <text role="ct.request.eyebrow" text={q.header} />}
          <text role="ct.request.prompt" text={q.question} />
          {q.isSecret ? <text tone="error" text="Secure input is not supported yet. Stop this turn and use the official client." /> : <>
            {(q.options ?? []).map((o: any) => <html.button key={`option-${o.label}`}
              class={`ct-choice ${r.answers[q.id]?.[0] === o.label ? 'ct-selected' : ''}`}
              aria={o.label} attrs={{ 'aria-pressed': r.answers[q.id]?.[0] === o.label }}
              onClick={() => { r.answers[q.id] = [o.label]; this.render(); }}>
              <html.span class="ct-choice-mark">{r.answers[q.id]?.[0] === o.label && <icon name="check" />}</html.span>
              <col role="ct.choice.copy" gap="xs"><text role="ct.choice.label" text={o.label} />
                {o.description && <text role="ct.choice.description" tone="muted" text={o.description} />}</col>
            </html.button>)}
            {(!q.options?.length || q.isOther) && this.button('Write an answer', () => {
              if (!this.savedDraft) this.savedDraft = this.draft;
              this.draft = new Draft();
              this.answerTarget = { requestId: r.id, questionId: q.id }; this.closePanel();
            }, 'ct-quiet')}
            {r.answers[q.id] && !(q.options ?? []).some((o: any) => r.answers[q.id]?.[0] === o.label) &&
              <text role="ct.request.answer" text={`Your answer: ${r.answers[q.id].join(', ')}`} />}
          </>}
        </col>)}
        <html.div class="ct-buttons ct-request-actions">
          {this.button('Submit answers', () => respond({ answers: r.answers }), 'ct-primary',
            !(p.questions ?? []).every((q: any) => r.answers[q.id]?.length))}
        </html.div>
      </col>
    </html.div>;
    if (r.method === 'mcpServer/elicitation/request') return <html.div key={`req${r.id}`} class="ct-request"><col gap="sm">
      <row role="ct.request.heading" gap="sm" align="center"><icon name="globe" /><text text={`${p.serverName} needs an action`} /></row>
      <text text={p.message} /><text text={p.url} href={p.url} actions={{ click: 'open' }} />
      <html.div class="ct-buttons ct-request-actions">
        {this.button('Cancel', () => respond({ action: 'cancel', content: null, _meta: null }))}
        {this.button('Decline', () => respond({ action: 'decline', content: null, _meta: null }))}
        {this.button('Done', () => respond({ action: 'accept', content: null, _meta: null }), 'ct-primary')}
      </html.div>
    </col></html.div>;
    return <html.div key={`req${r.id}`} class="ct-request"><col gap="sm">
      <row role="ct.request.heading" gap="sm" align="center"><icon name="shield-alert" /><text>{r.method.includes('fileChange') ? 'Approve file changes' : 'Approve command'}</text></row>
      {p.reason && <text text={p.reason} />}
      {p.command && <code text={p.command} lang="sh" wrap />}
      {p.cwd && <text role="ct.request.context" tone="muted" text={`Directory: ${p.cwd}`} />}
      {p.grantRoot && <text tone="warning" text={`Requested write access: ${p.grantRoot}`} />}
      <section head="Request details and scope" collapsible collapsed><code text={JSON.stringify(p, null, 2)} lang="json" wrap /></section>
      <html.div class="ct-buttons ct-request-actions">
        {this.button('Cancel turn', () => respond({ decision: 'cancel' }))}
        {this.button('Decline', () => respond({ decision: 'decline' }), 'ct-danger')}
        {this.button('Allow for session', () => respond({ decision: 'acceptForSession' }))}
        {this.button('Allow once', () => respond({ decision: 'accept' }), 'ct-primary')}
      </html.div>
    </col></html.div>;
  }

  render() {
    if (this.ended) return;
    this.syncComposer();
    if (this.surface.closed) return;
    const c = this.c;
    this.draft.onUpdate = () => this.schedule(); this.dialogDraft.onUpdate = () => this.schedule();
    this.draft.context = { cols: this.session.caps.cols, dark: this.session.caps.dark,
      reduceMotion: this.session.caps.reduceMotion, supports: kind => this.session.caps.kinds.includes(kind),
      feature: name => this.session.caps.features.includes(name as any) };
    this.draft.setWorkspace(c.cwd);
    const ready = c.sessionReady && !!c.thread && !c.operation && !this.pasting && !c.unconfirmed.length;
    const pendingQuestion = this.answerTarget && c.requests.find(r => r.id === this.answerTarget!.requestId);
    if (this.answerTarget && !pendingQuestion) this.finishAnswer();
    const hasInput = !!this.draft.submittedText.trim() || (!this.answerTarget && this.images.length > 0);
    const sendEnabled = !this.panel && !this.draft.completing && hasInput;
    const displayModel = c.models.find(m => m.model === c.model)?.displayName ?? c.model;
    const parts = transcriptParts(c.items);
    const latestActivity = parts.findLast(p => p.kind === 'activity' && p.turnId === c.activeTurn);
    const awaitingActivity = c.activeTurn && !c.requests.length && !parts.some(p => p.kind === 'activity'
      ? p.turnId === c.activeTurn : p.entry.turnId === c.activeTurn && p.entry.item.type === 'agentMessage');
    // Each message stays in its own direct block for native virtualization.
    let main = <col role={`ct.transcript.${this.clientInstance}`}>
        {c.thread?.forkedFromId && <row key="origin" role="ct.fork.origin" gap="sm" align="center" wrap>
          <icon name="branch" /><text tone="muted" text="Forked conversation" />
          <html.button class="ct-reply-action" aria="Open source session" attrs={{ 'aria-disabled': c.selecting || !!this.panel }}
            onClick={() => { const id = c.thread?.forkedFromId; if (id && !c.selecting && !this.panel) this.action(() => this.openSession(id)); }}>
            Open source</html.button>
        </row>}
        {!c.items.length && <Welcome />}
        {c.historyCursor && <text key="earlier" tone="muted" text="Load earlier messages"
          onClick={() => this.action(() => c.loadHistory())} />}
        {parts.map(p => p.kind === 'message' ? this.renderItem(p.entry) : this.renderActivity(p, p === latestActivity))}
        {awaitingActivity && <row key="pending" role="ct.pending" gap="sm" align="center">
          <spinner style="starburst" /><text tone="muted" text="Working…" />
        </row>}
        {!!c.activeTurn && !!c.plan.length && <checklist key="plan" phases={[{ title: 'Plan', items: c.plan.map((s, i) => ({
          id: `step${i}`, text: s.step, status: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'active' : 'pending',
        })) }]} />}
        {c.notices.filter(n => n.error).map(n => <card key={`notice${n.id}`} role="omp.error" tone="error" head="Error">
          <text text={n.text} />{this.button('Dismiss', () => { c.notices = c.notices.filter(x => x.id !== n.id); c.changed(); })}
        </card>)}
      </col> as Node;
    this.readingPositions.nodes = main.children.map((node, i) => `main.${node.props.key ?? i}`);
    const prompts = new Map(c.items.filter(entry => entry.item.type === 'userMessage').map(entry => [
      `main.${entry.item.type === 'userMessage' && entry.item.clientId ? `${entry.turnId}:client:${entry.item.clientId}` : entry.id}`, entry.id]));
    this.readingPrompts = new Map();
    let prompt: string | undefined;
    for (const id of this.readingPositions.nodes) {
      const next = prompts.get(id);
      // Unindexed pending input keeps the last known topic until the agent catches up.
      if (next && c.thread && c.outlineLocation(c.thread.id, next)) prompt = next;
      if (prompt) this.readingPrompts.set(id, prompt);
    }
    main = new Node(main.kind, main.props, main.children.map((node, i) =>
      html.div({ key: String(node.props.key ?? i), class: readingAnchorClass(this.readingPositions.nodes[i]!) }, node)));
    this.surface.render({ main,
      dock: <col>
        <text key="sessions" hidden title={JSON.stringify({ ...this.folderSessions.snapshot, cols: this.session.caps.cols,
          sidebarRequest: this.sidebarRequested ? this.clientInstance : undefined,
          readingRequest: this.readingPositions.request,
          tocProtocol: 1, tocFollowProtocol: 1, tocClient: this.clientInstance, tocLines: this.tocLines,
          toc: c.outline && { ...c.outline,
            error: this.tocError && this.tocError.threadId === c.thread?.id ? this.tocError.message : c.outline.error,
            location: this.tocLocation?.threadId === c.thread?.id ? this.tocLocation : undefined },
          cellWidth: this.session.caps.cell.w,
          rows: this.folderSessions.snapshot.rows.map(row => ({ ...row, canArchive: row.canArchive && !this.hasSessionDraft(row.id) })),
          archiveProtocol: 1, renameProtocol: 1, navigationProtocol: 1, newSessionProtocol: 1,
          reloadProtocol: this.reloadWindow ? 1 : undefined, uiGeneration: this.generation, navigation: this.sidebarNavigation })}
          onAction={{ refresh: () => { void this.folderSessions.refresh(); },
            'reading-position': e => this.readingPositions.reply(e.value),
            'toc-get': e => { if (e.value) { this.tocError = undefined; void c.generateOutline(e.value); } },
            'toc-rebuild': e => { if (e.value) { this.tocError = undefined; void c.generateOutline(e.value, true); } },
            'toc-jump': e => { void this.jumpOutline(e.value); },
            'toc-follow': () => { void this.followOutline(); },
            reload: () => this.requestReload(),
            locks: () => { void this.folderSessions.refreshLocks(); },
            more: () => { void this.folderSessions.refresh(true); },
            hide: () => this.folderSessions.hide(),
            new: () => this.action(() => this.newSession()),
            archive: e => this.action(() => this.archiveSession(e.value)),
            rename: e => this.action(async () => this.openRenameSession(e.value)),
            resume: e => { void this.resumeFromSidebar(e.value); } }} />
        {this.completion && <row key="completion" role="ct.completion" gap="sm" align="center">
          <icon key="icon" name={this.completion.status === 'completed' ? 'check' : 'warn'} role="ct.completion.icon" />
          <text key="label" grow={1} lines={1} text={`${this.completion.status === 'completed' ? 'Task complete' : 'Task failed'}${this.completion.threadId === c.thread?.id ? '' : ` · ${this.completion.title}`}`} />
          {this.completion.threadId !== c.thread?.id && <html.button key="view" class="ct-completion-action" onClick={() => {
            const target = this.completion?.threadId;
            if (target) this.action(async () => { if (await this.openSession(target)) this.completion = undefined; });
          }}>View</html.button>}
          <icon key="dismiss" name="x" aria="Dismiss completion" title="Dismiss" onClick={() => { this.completion = undefined; this.render(); }} />
        </row>}
        {(c.connection === 'disconnected' || (c.connection === 'ready' && !c.sessionReady && !c.selecting)) && <row key="reconnect" role="ct.reconnect" gap="sm" align="center">
          <icon name="warn" /><text grow={1} text={c.connection === 'disconnected'
            ? 'Disconnected · Your draft is kept' : 'Session unavailable · Your draft is kept'} />
          <html.button class="ct-completion-action" onClick={() => this.action(() => c.connection === 'ready' && c.thread
            ? c.resume(c.thread.id) : c.reconnect())}>{c.connection === 'disconnected' ? 'Reconnect' : 'Retry'}</html.button>
        </row>}
        {c.requests.map(r => this.renderRequest(r))}
        {!!c.unconfirmed.length && <section key="unconfirmed" head="Message delivery unconfirmed">
          <text text="Codex may have received this message. Check the conversation before deciding to retry." />
          {this.button('Check conversation', () => this.action(() => c.refreshHistory()))}
          {c.unconfirmed.map(q => <col key={q.id} gap="xs">
            <text text={q.text || '[Image]'} lines={3} />
            {!!q.images.length && <text tone="muted" text={`${q.images.length} attached image(s)`} />}
            <row gap="sm">
              {this.button('Already received', () => c.resolveUnconfirmed(q.id))}
              {this.button('Queue for retry', () => c.resolveUnconfirmed(q.id, true))}
            </row>
          </col>)}
        </section>}
        {!!c.queue.length && <section key="queue" role="omp.queue" head={`Queued · ${c.queue.length}${c.queuePaused ? ' · paused' : ''}`} collapsible>
          {c.queue.map(q => <row key={q.id} role="omp.queue.item" justify="between"><text text={q.text || '[Image]'} lines={2} />
            {this.button('Remove', () => c.removeQueued(q.id))}</row>)}
          {!c.busy && !c.unconfirmed.length && this.button('Run next', () => this.action(() => c.runQueue()))}
          <text tone="muted" text="Queued locally. Stops and errors pause the queue." />
        </section>}
        <ComposerFrame running={!!c.activeTurn}>
          {this.answerTarget && <row key="answering" gap="sm"><text tone="accent" text="Answering a question" />
            {this.button('Back to message', () => this.finishAnswer())}</row>}
          {!!this.images.length && <row key="images" role="omp.composer.chips" gap="sm" wrap>
            {this.images.map((path, n) => <card key={path} role="omp.composer.chip" tone="accent" head={`Image #${n + 1}`}>
              {this.imageNode(path, true)}
              <row key="caption" gap="xs" justify="between">
                <text tone="muted" text={this.previews.get(path)?.width ? `${this.previews.get(path)!.width} × ${this.previews.get(path)!.height}` : basename(path)} />
                <icon name="x" aria={`Remove image ${n + 1}`} title="Remove image" onClick={() => {
                  this.images = this.images.filter(p => p !== path); this.render();
                }} />
              </row>
            </card>)}
          </row>}
          <row key="line" role="omp.composer.line" align="start" gap="sm">
            <editor key="input" {...this.draft.nativeProps}
              maxLines={9} grow={1} placeholder={this.answerTarget ? 'Type your answer…' : c.activeTurn ? 'Steer this turn, or queue a follow-up…' : 'Message Codex…'}
              sendable={ready && !this.panel && !this.answerTarget && !this.draft.completing} onEdit={e => { this.draft.nativeEdit(e); this.render(); }}
              onUndo={() => { this.draft.undo(); this.render(); }} onFocus={() => this.focusComposer()}
              onSend={e => { if (this.draft.text !== e.text) this.draft.set(e.text); void this.send(); }} />
          </row>
          <row key="bar" role="omp.composer.bar" aria="Codex composer controls" gap="sm" align="center" wrap>
            <row key="settings" role="ct.composer.settings" gap="xs" align="center" grow={1}>
              <row key="model" role="omp.composer.model" gap="xs" align="center" title="Switch model · Ctrl+Shift+P"
                onClick={() => this.openPanel('models')}>
                <icon name="model" /><text wrap="none" text={displayModel} title={displayModel} /><icon name="chev" />
              </row>
              <row key="effort" role="omp.composer.effort" gap="xs" align="center" title="Reasoning effort"
                onClick={() => this.openPanel('effort')}>
                <effort level={c.effort} /><text wrap="none" text={c.effort} />
              </row>
            </row>
            <row key="actions" role="ct.composer.actions" gap="xs" align="center">
              <icon key="new" name="plus" title="New session · Ctrl+Shift+N" aria="New session" onClick={() => this.action(async () => {
                if (this.pasting) throw new Error('Wait for the paste to finish.');
                await this.newSession();
              })} />
              <icon key="history" name="history" title="Sessions · Ctrl+L" aria="Sessions" onClick={() => this.openPanel('history')} />
              <icon key="more" name="more" title="More actions" aria="More actions" onClick={() => this.openPanel('menu')} />
              {c.activeTurn && !this.answerTarget && <html.button key="mode" role="ct.composer.mode"
                aria={`Send mode: ${this.sendMode === 'steer' ? 'Steer' : 'Queue'}`} title="Choose how to send while running"
                attrs={{ 'aria-haspopup': 'dialog', 'aria-expanded': this.panel === 'send-mode' }}
                onClick={() => this.openPanel('send-mode')}>
                <text text={this.sendMode === 'steer' ? 'Steer' : 'Queue'} /><icon name="chev" />
              </html.button>}
              {c.activeTurn && <html.button key="stop" role="omp.composer.stop" class="ct-stop" aria="Stop current turn" title="Stop · Ctrl+C"
                onClick={() => this.action(() => c.stop())}><html.span class="ct-stop-mark" attrs={{ 'aria-hidden': true }} /></html.button>}
              {ready && (!c.activeTurn || hasInput) && <html.button key="send" role="omp.composer.send" class="ct-send" attrs={{ 'aria-disabled': !sendEnabled }}
                aria={this.answerTarget ? 'Save answer' : 'Send message'}
                title={this.answerTarget ? 'Save answer' : c.activeTurn ? this.sendMode === 'steer' ? 'Steer current turn' : 'Queue follow-up' : 'Send · Enter'}
                onClick={sendEnabled ? () => { void this.send(); } : undefined}><icon name="arrow-up" /></html.button>}
            </row>
          </row>
          <row key="nav" role="ct.nav" align="center" gap="sm">
            <status key="status" role="omp.status" transparent grow={1}>
              <seg key="path" role="omp.status.path" icon="folder" priority={6} title={c.cwd}
                onClick={() => this.openPanel('workspace')}>{basename(c.cwd) || c.cwd}</seg>
              <seg key="connection" role="omp.status.account" priority={1}
                icon={c.connection === 'ready' ? undefined : c.connection === 'disconnected' ? 'error' : 'clock'}>
                {c.connection === 'ready' ? c.account : c.connection === 'disconnected' ? 'Disconnected' : 'Connecting…'}
              </seg>
              {c.notices.some(n => !n.error) && <seg key="notice" icon="info" title="Codex notices" onClick={() => this.openPanel('details')}>Notice</seg>}
            </status>
            {(c.operation || !!this.pasting) && <row key="working" role="ct.working" gap="xs" align="center">
              {!c.selecting && <spinner style="starburst" />}<text tone="muted" text={this.pasting ? 'Pasting…' : c.operation} />
            </row>}
          </row>
        </ComposerFrame>
      </col>,
      layer: <col>{!this.panel && (this.draft.describe().c ?? []).filter((n): n is import('@oh-my-pi/pi-tui/native/node').NativeNode => 'k' in n && n.k === 'overlay')
        .map(n => ompNode(n, this.draft.context, () => this.render()))}
        {this.isPicker() ? this.renderPicker() : this.panel && <overlay key="panel" role={`ct.dialog.${this.panel}`} anchor="center" size={this.panel === 'diff' ? 'lg' : 'md'} modal head={this.panelTitle()}>
        <col key="body" gap="sm">{this.renderPanel()}{!['workspace', 'details', 'rename'].includes(this.panel) && <><rule />{this.button('Close · Esc', () => this.closePanel())}</>}</col>
      </overlay>}</col>,
    });
  }

  private shortPath(path: string) {
    const home = process.env.HOME;
    const short = home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
    return short.length > 52 ? '…/' + short.split('/').slice(-3).join('/') : short;
  }

  private isPicker() { return ['history', 'models', 'default-model', 'folders', 'effort', 'send-mode', 'menu'].includes(this.panel ?? ''); }

  private pickerItems(): PickerItem[] {
    const c = this.c;
    let items: PickerItem[];
    switch (this.panel) {
      case 'history': items = c.threads.map(t => ({ id: t.id, label: t.name || t.preview || 'New session',
        detail: this.shortPath(t.cwd), icon: 'message', facts: { updated: new Date(t.updatedAt * 1000).toLocaleDateString('en-US') } })); break;
      case 'models': items = c.models.map(m => ({ id: m.model, label: m.displayName, detail: m.description,
        icon: 'model', badges: c.model === m.model ? [{ text: 'Current', tone: 'accent' }] : undefined })); break;
      case 'default-model': items = [
        { id: 'codex-default', label: 'Use Codex default', detail: 'Follow the model configured in Codex.', icon: 'settings',
          badges: !c.newSessionModel ? [{ text: 'Default', tone: 'accent' }] : undefined },
        ...c.models.filter(m => !m.hidden).map(m => ({ id: m.model, label: m.displayName, detail: m.description,
          icon: 'model', badges: c.newSessionModel === m.model ? [{ text: 'Default', tone: 'accent' as const }] : undefined })),
      ]; break;
      case 'folders': items = this.folderBrowser.items; break;
      case 'effort': items = (c.models.find(m => m.model === c.model)?.supportedReasoningEfforts ?? []).map(o => ({
        id: o.reasoningEffort, label: o.reasoningEffort, detail: o.description, icon: 'brain',
        badges: c.effort === o.reasoningEffort ? [{ text: 'Current', tone: 'accent' }] : undefined })); break;
      case 'send-mode': items = [
        { id: 'steer', label: 'Steer', detail: 'Add input to the current turn.' },
        { id: 'queue', label: 'Queue', detail: 'Send after the current turn finishes.' },
      ]; break;
      default: items = [
        { id: 'new', label: 'New session', icon: 'plus', detail: 'Ctrl+Shift+N' },
        { id: 'history', label: 'Resume session', icon: 'history', detail: 'Ctrl+L' },
        { id: 'workspace', label: 'Switch workspace', icon: 'folder' },
        { id: 'attach', label: 'Attach image', icon: 'image' },
        { id: 'models', label: 'Choose model', icon: 'model', detail: 'Ctrl+Shift+P' },
        { id: 'default-model', label: 'New session model', icon: 'settings', detail: modelName(c, c.newSessionModel) },
        { id: 'effort', label: 'Reasoning effort', icon: 'brain' },
        ...(c.diff ? [{ id: 'diff', label: 'View changes', icon: 'diff' }] : []),
        { id: 'details', label: 'Session details', icon: 'info' },
        { id: 'notifications', label: c.notifications ? 'Turn off completion reminders' : 'Turn on completion reminders', icon: 'bell' },
        { id: 'editing', label: this.draft.vim ? 'Use standard editing' : 'Enable Vim editing', icon: 'keyboard' },
        ...(this.reloadWindow ? [{ id: 'reload', label: 'Developer: Reload Window',
          detail: 'Load the latest interface and keep tasks running.' }] : []),
        { id: 'help', label: 'Keyboard shortcuts', icon: 'keyboard' },
      ];
    }
    const query = this.dialogDraft.text.toLowerCase().trim();
    return query ? items.filter(i => `${i.label} ${i.detail ?? ''}`.toLowerCase().includes(query)) : items;
  }

  private renderPicker() {
    const items = this.pickerItems();
    const folders = this.panel === 'folders', defaults = this.panel === 'default-model';
    const error = defaults ? this.preferenceError : folders ? this.folderBrowser.error : '';
    if (!items.some(i => i.id === this.pickerSelected)) this.pickerSelected = items[0]?.id ?? '';
    return <picker key="panel" size="md" layout="rows" preview="none" title={this.panelTitle()}
      subtitle={defaults ? 'Saved for new sessions in every workspace. Existing sessions keep their model.' : folders ? this.folderBrowser.directory : undefined}
      icon={folders ? 'folder-open' : defaults || this.panel === 'models' ? 'model' : this.panel === 'history' ? 'history' : 'search'}
      query={this.dialogDraft.text} cursor={this.dialogDraft.cursor} placeholder="Type to filter…" focus="list"
      items={items} selected={this.pickerSelected} empty={folders ? 'No folders here' : 'No matches'}
      state={(this.historyLoading && this.panel === 'history') || (folders && this.folderBrowser.loading) || (defaults && this.preferenceSaving) ? 'loading' : error ? 'error' : 'ready'}
      message={error || undefined}
      current={this.panel === 'models' ? [this.c.model] : this.panel === 'effort' ? [this.c.effort]
        : defaults ? [this.c.newSessionModel ?? 'codex-default'] : this.panel === 'send-mode' ? [this.sendMode] : this.panel === 'history' ? [this.c.thread?.id ?? ''] : []}
      actions={[
        { id: 'confirm', label: folders ? 'Open folder' : defaults ? 'Set default' : this.panel === 'history' ? 'Resume' : 'Select', keys: ['enter'], primary: !folders,
          disabled: !items.length || (defaults && this.preferenceSaving) || (folders && this.folderBrowser.loading) || undefined },
        ...(folders ? [{ id: 'use-folder', label: 'Use this folder', primary: true as const,
          disabled: this.folderBrowser.loading || !!this.folderBrowser.error || undefined }] : []),
        ...(this.panel === 'history' ? [{ id: 'scope', label: this.allThreads ? 'All workspaces' : 'This workspace', on: this.allThreads },
          ...(this.c.threadsCursor ? [{ id: 'more', label: 'Load more' }] : [])] : []),
        { id: 'close', label: 'Close', keys: ['esc'], end: true },
      ]}
      onSelect={e => { this.pickerSelected = e.item; this.render(); }}
      onActivate={e => { this.pickerSelected = e.item; this.activatePicker(); }}
      onAction={{ confirm: () => this.activatePicker(), close: () => this.closePanel(),
        'use-folder': () => this.useFolder(),
        scope: () => { this.allThreads = !this.allThreads; this.action(() => this.c.listThreads(this.allThreads)); },
        more: () => this.action(() => this.c.listThreads(this.allThreads, true)) }}
      onEdit={e => { this.dialogDraft.nativeEdit(e); this.render(); }}
      onUndo={() => { this.dialogDraft.undo(); this.render(); }} />;
  }

  private activatePicker() {
    const id = this.pickerSelected;
    if (!id) return;
    if (this.panel === 'history') this.action(async () => { this.closePanel(); await this.openSession(id); });
    else if (this.panel === 'default-model') this.action(() => this.saveDefaultModel(id));
    else if (this.panel === 'folders') { if (!this.folderBrowser.loading) this.action(() => this.readFolders(id)); }
    else if (this.panel === 'models') this.action(async () => { this.c.chooseModel(id); this.closePanel(); });
    else if (this.panel === 'effort') this.action(async () => { this.c.chooseEffort(id as ReasoningEffort); this.closePanel(); });
    else if (this.panel === 'send-mode' && (id === 'steer' || id === 'queue')) { this.sendMode = id; this.closePanel(); }
    else if (id === 'new') this.action(async () => { this.closePanel(); await this.newSession(); });
    else if (id === 'editing') { this.draft.setVim(!this.draft.vim); this.closePanel(); }
    else if (id === 'reload') this.requestReload();
    else if (id === 'notifications') {
      this.c.setNotifications(!this.c.notifications); this.completion = undefined; this.closePanel();
    }
    else this.openPanel(id as NonNullable<NativeUI['panel']>);
  }

  private panelTitle() {
    return ({ history: 'Sessions', models: 'Select model', 'default-model': 'New session model', folders: 'Choose a folder', effort: 'Reasoning effort', 'send-mode': 'Send while running', workspace: 'New session in a workspace', attach: 'Attach image', rename: 'Rename session', details: 'Session details', help: 'Getting started', diff: 'Changes', menu: 'Actions' })[this.panel!];
  }
  private renderPanel() {
    const c = this.c;
    switch (this.panel) {
      case 'rename': return <>
        <html.div class="ct-field-heading">Session name</html.div>
        <input key="field" role="ct.session.name" aria="Session name" text={this.dialogDraft.text}
          cursor={this.dialogDraft.cursor} anchor={this.dialogDraft.anchor} placeholder="Session name" readonly={this.renaming?.saving}
          onEdit={e => { if (!this.renaming?.saving) this.dialogDraft.nativeEdit(e); this.render(); }}
          onUndo={() => { if (!this.renaming?.saving) this.dialogDraft.undo(); this.render(); }}
          onFocus={() => { this.focused = 'layer.panel.body.field'; this.surface.focus(this.focused); }} />
        {!!this.renaming?.error && <html.div class="ct-field-error" role="ct.rename.error"><icon name="warn" />{this.renaming.error}</html.div>}
        <html.div class="ct-dialog-footer">
          <html.span class="ct-footer-hint">Enter to save · Esc to cancel</html.span>
          {this.button('Cancel', () => this.closePanel())}
          {this.button(this.renaming?.saving ? 'Saving…' : 'Save name', () => { void this.confirmRename(); }, 'ct-primary',
            !!this.renaming?.saving || !this.dialogDraft.text.trim())}
        </html.div>
      </>;
      case 'workspace': return <WorkspaceForm c={c} draft={this.dialogDraft} path={this.workspacePath()}
        error={this.workspaceError} opening={this.workspaceOpening}
        edit={() => { this.workspaceError = ''; this.render(); }}
        focus={() => { this.focused = 'layer.panel.body.field'; this.surface.focus(this.focused); }}
        browse={() => this.action(() => this.browseFolders())} chooseDefault={() => this.openModelPicker('default-model')}
        submit={() => this.action(() => this.confirmPath())} close={() => this.closePanel()} />;
      case 'attach': return <>
        <text tone="muted" text="Enter the full path to an image to attach it to your next message." />
        <input key="field" text={this.dialogDraft.text} cursor={this.dialogDraft.cursor} anchor={this.dialogDraft.anchor}
          placeholder="/full/path" onEdit={e => { this.dialogDraft.nativeEdit(e); this.render(); }}
          onUndo={() => { this.dialogDraft.undo(); this.render(); }} onFocus={() => { this.focused = 'layer.panel.body.field'; this.surface.focus(this.focused); }} />
        {this.button('Attach image', () => this.action(() => this.confirmPath()), 'ct-primary')}
      </>;
      case 'details': return <SessionDetails c={c} chooseModel={() => this.openModelPicker('models')}
        chooseEffort={() => this.openModelPicker('effort')} chooseDefault={() => this.openModelPicker('default-model')} close={() => this.closePanel()} />;
      case 'diff': return <diff text={c.diff} mode="unified" />;
      case 'help': return <md text={`**Keyboard shortcuts**\n\n- Ctrl+A / Ctrl+E — Start / end of line\n- Ctrl+B / Ctrl+F — Move left / right\n- Ctrl+P / Ctrl+N — Move up / down\n- Option+Left / Right — Move by word\n- Ctrl+H / Ctrl+D — Delete backward / forward\n- Ctrl+U / Ctrl+K / Ctrl+W — Delete to line start / end / previous word\n- Ctrl+Y / Option+Y — Restore deleted text / cycle earlier deletions\n- Command+A — Select all\n- Command+Z / Command+Shift+Z — Undo / redo\n- Enter — Send message\n- Shift+Enter — New line\n- Command+, — Tern terminal settings\n- Tab — Complete file paths\n- Command+V — Paste text, files or images through Tern\n- Ctrl+V — Paste from the system clipboard\n- Ctrl+Shift+N — New session\n- Ctrl+L — Resume session\n- Ctrl+Shift+P — Select model\n- Ctrl+Shift+R — Reload window without stopping tasks\n- Ctrl+C — Stop the current turn; quit when idle\n- Ctrl+Q — Quit\n- Esc — Close a panel\n\nUse **New session** above the sidebar list to start a conversation in the current folder. Other sessions keep their tasks and drafts.\n\nWhile Codex is working, choose **Steer** to add input to the current turn, or **Queue** to save it for the next turn. A stop or error pauses the local queue.\n\nPaste an image to see a thumbnail before sending. Click it to preview; use × to remove it. Image file paths and **Attach image** in the actions menu also work. Copy a PDF or another document in Finder and paste it to insert a Markdown file link.\n\nThis prototype does not support complex MCP forms, secure input, voice, or desktop host tools.`} />;
      default: return null;
    }
  }

  private imageNode(path: string, small = false) {
    const cached = this.previews.get(path);
    if (cached) return <image key={path} blob={cached.blob} alt={cached.name} path={cached.path}
      w={cached.width} h={cached.height} max={{ w: small ? '12ch' : '28ch', h: small ? '4lines' : '10lines' }}
      actions={{ click: 'zoom', menu: ['open'] }} title={cached.name} />;
    if (!this.loadingPreviews.has(path) && !this.failedPreviews.has(path)) {
      this.loadingPreviews.add(path);
      const data = path.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s);
      const load = data ? savePastedImage(Buffer.from(data[2], 'base64'), data[1]) : loadImage(path);
      void load.then(image => this.cacheImage(image, path)).catch(() => this.failedPreviews.add(path))
        .finally(() => { this.loadingPreviews.delete(path); this.schedule(); });
    }
    return <text key={path} tone="muted" text={this.failedPreviews.has(path) ? 'Image unavailable' : 'Loading image…'} />;
  }

  private cacheImage(image: PreviewImage, key = image.path) {
    const cached = this.previews.get(key);
    if (!cached && !this.ended) this.previews.set(key, { ...image, blob: this.session.blob(image.bytes, image.mime) });
  }

  private async attach(image: PreviewImage) {
    if (this.ended) return;
    this.cacheImage(image);
    if (!this.images.includes(image.path)) this.images = [...this.images, image.path];
    this.render();
  }

  private async attachFiles(paths: string[], target: Draft) {
    const images = await Promise.all(paths.filter(isImagePath).map(loadImage));
    const text = markdownFileLinks(paths.filter(path => !isImagePath(path)));
    if (target !== this.draft || this.ended) return;
    if (text) target.key({ name: 'paste', text, ctrl: false, alt: false, shift: false, meta: false });
    for (const image of images) await this.attach(image);
  }

  async pasteFiles(paths: string[]) {
    if (this.panel || this.answerTarget) throw new Error('Paste files into the message composer.');
    const target = this.draft;
    this.pasting++; this.render();
    try { await this.attachFiles(paths, target); }
    finally { this.finishPaste(); }
  }

  /** Text is never rewritten unless the entire paste is a readable image path. */
  pasteText(text: string) {
    if (this.ended) return;
    const target = this.panel ? this.dialogDraft : this.draft;
    const paths = !this.panel && !this.answerTarget ? pastedImagePaths(text, this.c.cwd) : undefined;
    if (!paths) { target.key({ name: 'paste', text, ctrl: false, alt: false, shift: false, meta: false }); this.render(); return; }
    this.pasting++; this.render();
    this.action(async () => {
      try {
        await this.attachFiles(paths, target);
      } catch {
        target.key({ name: 'paste', text, ctrl: false, alt: false, shift: false, meta: false });
      } finally { this.finishPaste(); }
    });
  }

  async pasteBinary(bytes: Uint8Array, mime: string) {
    if (this.panel || this.answerTarget) throw new Error('Paste images into the message composer.');
    const target = this.draft;
    this.pasting++; this.render();
    try {
      const image = await savePastedImage(bytes, mime);
      if (target === this.draft && !this.ended) await this.attach(image);
    } finally { this.finishPaste(); }
  }

  private async pasteClipboard() {
    const target = this.panel ? this.dialogDraft : this.draft;
    const imageAllowed = !this.panel && !this.answerTarget;
    this.pasting++; this.render();
    try {
      const content = await readSystemClipboard(this.c.cwd, imageAllowed);
      if (content.kind === 'files') {
        try { await this.attachFiles(content.paths, target); }
        catch (error) {
          if (content.text === undefined) throw error;
          target.key({ name: 'paste', text: content.text, ctrl: false, alt: false, shift: false, meta: false });
        }
      } else if (content.kind === 'image') {
        const saved = await savePastedImage(content.image.data, content.image.mimeType);
        if (target === this.draft && !this.ended) await this.attach(saved);
      } else if (content.kind === 'text') {
        target.key({ name: 'paste', text: content.text, ctrl: false, alt: false, shift: false, meta: false });
      } else this.c.notice('Clipboard is empty or has no supported content.');
    } finally { this.finishPaste(); }
  }

  private finishPaste() {
    this.pasting = Math.max(0, this.pasting - 1);
    this.render();
    while (!this.pasting && !this.ended && this.deferredKeys.length) {
      if (!this.handleKey(this.deferredKeys.shift()!)) { void this.session.close(); break; }
    }
  }

  private async confirmPath() {
    const path = this.workspacePath();
    if (this.panel !== 'workspace') { await this.attach(await loadImage(path)); this.closePanel(); return; }
    if (this.workspaceOpening || !this.dialogDraft.text.trim()) return;
    this.workspaceOpening = true; this.workspaceError = ''; this.render();
    try {
      if (!(await stat(path).catch(() => null))?.isDirectory()) throw new Error('Choose an existing folder.');
      if (!await this.newSession(path)) throw new Error(this.folderSessions.error || 'Could not open this workspace. Try again.');
      if (this.panel === 'workspace') this.closePanel();
    } catch (error) { this.workspaceError = (error as Error).message; }
    finally { this.workspaceOpening = false; this.render(); }
  }

  async send() {
    if (this.pasting) return;
    const text = this.draft.submittedText;
    if (this.answerTarget) {
      const r = this.c.requests.find(r => r.id === this.answerTarget!.requestId);
      if (r && text.trim()) r.answers[this.answerTarget.questionId] = [text];
      this.finishAnswer(); this.render(); return;
    }
    if (!text.trim() && !this.images.length) return;
    if (!this.c.sessionReady) { this.c.notice('Reconnect and open this session before sending.'); return; }
    if (this.c.operation) return;
    if (this.c.unconfirmed.length) { this.c.notice('Check the unconfirmed message before sending again.'); return; }
    const composer = this.composer, threadId = this.c.thread?.id;
    const input = composer.take();
    // Clear optimistically for responsive typing, but restore rejected input intact.
    this.syncComposer();
    try {
      const sending = this.c.submit(input.text, input.images, this.sendMode);
      this.render();
      await sending; input.draft.addHistory(text);
    }
    catch (e) {
      if (!isRpcOutcomeUnknown(e) && !composer.restore(input)) this.c.preserveInput(threadId, input.text, input.images);
      if (threadId) this.saveComposer(threadId, composer);
      this.c.sessionNotice(threadId, e instanceof Error ? e.message : String(e), true);
    }
    this.render(); this.focusComposer();
  }

  private finishAnswer() {
    this.answerTarget = null;
    this.draft = this.savedDraft ?? new Draft(); this.savedDraft = null;
  }

  handleKey(key: Key): boolean {
    if (key.ctrl && key.name === 'q') return false;
    if (key.ctrl && key.shift && !key.meta && !key.alt && key.name === 'r') { this.requestReload(); return true; }
    if (this.pasting && !(key.ctrl && key.name === 'c')) { this.deferredKeys.push(key); return true; }
    if (key.ctrl && key.name === 'v') { this.action(() => this.pasteClipboard()); return true; }
    if (key.ctrl && key.name === 'c') {
      if (this.c.activeTurn) this.action(() => this.c.stop());
      else if (!this.c.operation) {
        if (this.c.hasWork) this.c.notice('Other sessions are still working. Select a session to stop it.');
        else return false;
      }
      return true;
    }
    if (key.ctrl && key.name === 'd' && !this.draft.text && !this.images.length && !this.panel && !this.c.busy) {
      if (this.c.hasWork) { this.c.notice('Other sessions are still working.'); return true; }
      return false;
    }
    if (key.name === 'escape' && this.panel) { this.closePanel(); return true; }
    if (this.panel) {
      if (this.isPicker()) {
        const items = this.pickerItems();
        if (key.name === 'enter') this.activatePicker();
        else if (key.name === 'up' || key.name === 'down' || (key.ctrl && !key.shift && (key.name === 'p' || key.name === 'n'))) {
          const at = Math.max(0, items.findIndex(i => i.id === this.pickerSelected));
          this.pickerSelected = items[(at + (key.name === 'up' || key.name === 'p' ? -1 : 1) + items.length) % items.length]?.id ?? '';
        } else { this.dialogDraft.key(key); }
        this.render();
        return true;
      }
      if (this.panel === 'workspace' || this.panel === 'attach' || this.panel === 'rename') {
        if (key.name === 'enter') this.action(() => this.panel === 'rename' ? this.confirmRename() : this.confirmPath());
        else if (!this.renaming?.saving) this.dialogDraft.key(key);
        this.render();
      }
      return true;
    }
    if (key.ctrl && key.shift && !key.alt && !key.meta && key.name === 'n') { this.action(() => this.newSession()); return true; }
    if (key.ctrl && key.name === 'l') { this.openPanel('history'); return true; }
    if (key.ctrl && key.shift && !key.alt && !key.meta && key.name === 'p') { this.openPanel('models'); return true; }
    if (key.name === 'enter' && !key.shift && !key.alt && !this.draft.completing) void this.send();
    else if (key.name === 'paste') this.pasteText(key.text ?? '');
    else { this.draft.key(key); this.render(); }
    return true;
  }

  disposeForReload() {
    this.ended = true; this.folderSessions.dispose();
    this.readingPositions.dispose();
    this.c.off('change', this.onChange);
    this.c.off('completion', this.onCompletion);
    if (this.completionTimer) clearTimeout(this.completionTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
  }

  async close() {
    this.syncComposer(); this.disposeForReload(); this.enhanced?.disable();
    await this.c.flushRecovery().catch(error => { process.stderr.write(`Draft recovery: ${error.message}\n`); });
    await this.session.close(); this.clipboardInput?.dispose();
  }
}
