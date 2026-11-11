import type { PromptTree } from './prompt-tree';

interface Reader { tree(id: string, fresh?: boolean): Promise<PromptTree>; cancelTree(): void }

/** View state only. It never owns a composer, session, or fork operation. */
export class PromptTreeState {
  open = false;
  data?: PromptTree;
  loading = false;
  error = '';
  selection = new Map<string, string>();
  private threadId = '';
  private revision = -1;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private reader: Reader, private changed: () => void) {}

  show(id: string, revision: number) {
    this.open = true;
    this.threadId = id; this.revision = revision;
    void this.refresh();
  }
  hide(cancel = true) {
    this.open = false; this.loading = false; this.generation++;
    clearTimeout(this.timer); this.timer = undefined;
    if (cancel) this.reader.cancelTree();
    this.changed();
  }
  sync(id: string, revision: number) {
    if (!this.open || (id === this.threadId && revision === this.revision)) return;
    const switched = id !== this.threadId;
    const sameFamily = !!this.data?.paths[id];
    const unchanged = revision === this.revision;
    this.threadId = id; this.revision = revision;
    // The graph belongs to the family. Switching its selected branch only
    // changes the highlighted path, not the graph or its layout.
    if (switched && sameFamily && unchanged && !this.loading && !this.error) return;
    if (switched) {
      if (!sameFamily) this.data = undefined;
      void this.refresh();
    } else {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); },250);
    }
  }
  async refresh(fresh = false) {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.open || !this.threadId) return;
    const generation = ++this.generation;
    const current = () => this.open && generation === this.generation;
    this.reader.cancelTree();
    this.loading = true; this.error = ''; this.changed();
    try {
      const data = await this.reader.tree(this.threadId, fresh);
      if (current()) this.data = data;
    } catch (error) {
      if (current()) this.error = (error as Error).message;
    } finally {
      if (current()) { this.loading = false; this.changed(); }
    }
  }
}
