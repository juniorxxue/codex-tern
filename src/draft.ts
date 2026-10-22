import type { Key, EditorProps } from '@stencil-hq/tern';
import { Editor } from '@oh-my-pi/pi-tui/components/editor';
import { getEditorTheme } from '@oh-my-pi/pi-tui/theme/tui-adapters';
import { CombinedAutocompleteProvider } from '@oh-my-pi/pi-tui/autocomplete';
import type { DescribeContext, NativeNode } from '@oh-my-pi/pi-tui/native/node';

interface Snapshot { text: string; cursor: number; anchor: number }
const context: DescribeContext = { cols: 100, dark: false, reduceMotion: false, supports: () => true, feature: () => false };
const arrows: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const tilde: Record<string, number> = { insert: 2, delete: 3, page_up: 5, page_down: 6 };

/** Encode the SDK's decoded key for the original OMP input pipeline. */
export function ompInput(k: Key): string {
  if (k.text && !k.ctrl && !k.alt && !k.meta && (k.name === 'space' || [...k.name].length === 1)) return k.text;
  const mods = 1 + Number(k.shift) + 2 * Number(k.alt) + 4 * Number(k.ctrl) + 8 * Number(k.meta);
  if (arrows[k.name]) return `\x1b[1;${mods}${arrows[k.name]}`;
  if (tilde[k.name]) return `\x1b[${tilde[k.name]};${mods}~`;
  const code = k.name === 'enter' ? 13 : k.name === 'tab' ? 9 : k.name === 'backspace' ? 127
    : k.name === 'escape' ? 27 : k.name === 'space' ? 32 : k.name.codePointAt(0);
  if (code === undefined) return '';
  if (mods === 1) return k.name === 'enter' ? '\r' : k.name === 'tab' ? '\t' : k.name === 'backspace' ? '\x7f'
    : k.name === 'escape' ? '\x1b' : k.text ?? String.fromCodePoint(code);
  return `\x1b[${code};${mods}u`;
}

/** Only a host adapter. OMP Editor owns editing, history, words, kills and Vim.
 * Native selection and redo bridge features supplied by the Tern SDK. */
export class Draft {
  readonly editor = new Editor(getEditorTheme());
  onUpdate?: () => void;
  revision = 0;
  private observedText = '';
  private selection: number | undefined;
  private redoStack: Snapshot[] = [];
  private cwd = '';
  context = context;

  constructor() {
    this.editor.disableSubmit = true;
    this.editor.setMaxHeight(9);
    this.editor.onChange = () => {
      const text = this.text;
      if (text !== this.observedText) { this.observedText = text; this.revision++; }
      this.onUpdate?.();
    };
    this.editor.onAutocompleteUpdate = () => this.onUpdate?.();
    this.editor.onTextAssistApplied = () => this.onUpdate?.();
    // Keep pasted text visible and send it verbatim rather than introducing
    // OMP's textual attachment markers into Codex input.
    this.editor.onLargePaste = text => { this.editor.insertText(text); return true; };
    this.describe();
  }
  get text() { return this.editor.getText(); }
  get submittedText() { return this.editor.getExpandedText(); }
  get cursor() {
    const p = this.editor.getCursor(), lines = this.editor.getLines();
    return lines.slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.col;
  }
  get anchor() { return this.selection ?? this.cursor; }
  get completing() { return this.editor.isShowingAutocomplete(); }
  get vim() { return this.editor.vimEnabled; }
  setVim(enabled: boolean) { this.editor.setVimMode(enabled); this.selection = undefined; this.onUpdate?.(); }
  setWorkspace(cwd: string) {
    if (cwd === this.cwd) return;
    this.cwd = cwd;
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], cwd));
  }
  describe(): NativeNode { return this.editor.describe(this.context); }
  get nativeProps(): EditorProps {
    const root = this.describe();
    const input = root.c?.find((n): n is NativeNode => 'k' in n && n.k === 'editor');
    return { ...input?.p, ...(this.selection === undefined ? {} : { anchor: this.selection }) } as EditorProps;
  }
  private snapshot(): Snapshot { return { text: this.text, cursor: this.cursor, anchor: this.anchor }; }
  private hostEdit(text: string, from: number, to: number, cursor = from + text.length) {
    this.editor.applyHostEdit({ len: this.text.length, from, to, text, cursor }); this.selection = undefined;
  }
  set(text: string) { this.redoStack = []; this.hostEdit(text, 0, this.text.length); }
  addHistory(text: string) { this.editor.addToHistory(text); }
  undo(redo = false) {
    if (redo) {
      const next = this.redoStack.pop(); if (!next) return;
      this.hostEdit(next.text, 0, this.text.length, next.cursor);
      this.selection = next.anchor === next.cursor ? undefined : next.anchor;
    } else {
      const before = this.snapshot();
      this.editor.handleNativeEvent({ type: 'undo', key: 'input' }); this.selection = undefined;
      if (this.text !== before.text) this.redoStack.push(before);
    }
  }
  nativeEdit(e: { len: number; from: number; to: number; text: string; cursor: number }) {
    if (e.len !== this.text.length || e.from < 0 || e.to < e.from || e.to > this.text.length) return false;
    this.redoStack = []; this.selection = undefined;
    this.editor.applyHostEdit(e); return true;
  }
  key(key: Key) {
    let k = key;
    if ((k.meta || k.ctrl) && !k.alt && (k.name === 'z' || (k.ctrl && ['_', '-'].includes(k.name)))) {
      this.undo(k.name === 'z' && k.shift); return;
    }
    const before = this.text, start = this.cursor, anchor = this.anchor;
    if (k.meta && !k.ctrl && !k.alt && k.name === 'a') {
      this.hostEdit('', this.text.length, this.text.length, this.text.length); this.selection = 0; return;
    }
    if (k.name === 'paste') {
      if (anchor !== start) this.hostEdit(k.text ?? '', Math.min(anchor, start), Math.max(anchor, start));
      else if ((k.text ?? '').includes('\x1b[201~')) {
        if (this.editor.isJumpPending) this.editor.handleInput('\x1b');
        this.editor.insertText(k.text ?? '');
      } else this.editor.handleInput(`\x1b[200~${k.text ?? ''}\x1b[201~`);
    } else if (anchor !== start && ((k.text && !k.ctrl && !k.meta && !k.alt) || ['backspace', 'delete'].includes(k.name))) {
      this.hostEdit(['backspace', 'delete'].includes(k.name) ? '' : k.text!, Math.min(anchor, start), Math.max(anchor, start));
    } else {
      const move = ['left', 'right', 'up', 'down', 'home', 'end'].includes(k.name)
        || (k.ctrl && ['a', 'e', 'b', 'f', 'n', 'p'].includes(k.name));
      if (move && !k.shift && anchor !== start && ['left', 'right'].includes(k.name) && !k.alt && !k.meta && !k.ctrl) {
        const target = k.name === 'left' ? Math.min(anchor, start) : Math.max(anchor, start);
        this.hostEdit('', start, start, target); return;
      }
      const selecting = move && k.shift;
      if (selecting) k = { ...k, shift: false };
      if (k.meta && !k.ctrl && !k.alt && ['left', 'right', 'up', 'down'].includes(k.name)) {
        if (k.name === 'left') this.editor.moveToLineStart();
        if (k.name === 'right') this.editor.moveToLineEnd();
        if (k.name === 'up') this.editor.moveToMessageStart();
        if (k.name === 'down') this.editor.moveToMessageEnd();
      } else if (k.ctrl && !k.alt && !k.meta && ['home', 'end'].includes(k.name)) {
        if (k.name === 'home') this.editor.moveToMessageStart(); else this.editor.moveToMessageEnd();
      } else {
        // macOS aliases absent from the terminal editor's default key map.
        if (k.ctrl && !k.alt && !k.meta && ['n', 'p', 'h'].includes(k.name))
          k = { ...k, name: k.name === 'n' ? 'down' : k.name === 'p' ? 'up' : 'backspace', ctrl: false };
        if (k.meta && !k.ctrl && !k.alt && ['backspace', 'delete'].includes(k.name))
          k = { ...k, name: k.name === 'backspace' ? 'u' : 'k', meta: false, ctrl: true };
        this.editor.handleInput(ompInput(k));
      }
      this.selection = selecting ? anchor : undefined;
    }
    if (this.text !== before) this.redoStack = [];
  }
}
