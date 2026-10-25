import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { findExecutable } from './launch';
import { runPluginCommand } from './tern-plugin';

export type ReadingRequest = { token: string; lines: number; relative?: boolean };
type Anchor = { id: string; offset: number };
type Position = { following: true } | { following: false; anchor: Anchor };
type Element = { class?: string; rect: number[] };
export const readingAnchorClass = (id: string) => `ct-reading-node-${Buffer.from(id).toString('base64url')}`;
const quoted = (value: string) => '"' + value.replace(/[\\"\x00-\x1f\x7f]/g, c => `\\${c.codePointAt(0)!.toString(16)} `) + '"';
const mainSelector = (role: string) => `.sf-main[data-role=${quoted(role)}]`;
const nodeSelector = (role: string, id: string) => `${mainSelector(role)} > [data-id=${quoted(id)}]`;
const hasClass = (node: Element, name: string) => node.class?.split(' ').includes(name);

async function elements(selector: string): Promise<Element[] | undefined> {
  const tern = findExecutable('tern');
  if (!tern) return;
  try {
    // Keep capture and selection in one input turn. Otherwise an edit arriving
    // during inspection could be applied to the conversation being left.
    const stdout = execFileSync(tern, ['ctl', `tree ${selector}`], { timeout: 500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const reply = JSON.parse(stdout);
    if (reply.ok && Array.isArray(reply.nodes) && reply.nodes.every((n: Element) =>
      Array.isArray(n.rect) && n.rect.length === 4 && n.rect.every(Number.isFinite))) return reply.nodes;
  } catch { /* Older hosts or a closed window must not block navigation. */ }
}

async function anchorOffset(role: string, id: string) {
  const nodes = await elements(`.tv-grid, ${nodeSelector(role, id)}`);
  let grid: Element | undefined;
  for (const node of nodes ?? []) {
    if (hasClass(node, 'tv-grid')) grid = node;
    else if (grid) return node.rect[1]! - grid.rect[1]!;
  }
}

async function viewport(role: string, children = false) {
  const main = mainSelector(role);
  const nodes = await elements(`.tv, .tv-grid, ${main}${children ? `, ${main} > .sf` : ''}`);
  let terminal: Element | undefined, grid: Element | undefined;
  for (const [i, node] of (nodes ?? []).entries()) {
    if (hasClass(node, 'tv')) terminal = node;
    else if (hasClass(node, 'tv-grid')) grid = node;
    else if (hasClass(node, 'sf-main') && terminal && grid)
      return { following: !hasClass(terminal, 'scrolled'), grid, children: nodes!.slice(i + 1) };
  }
}

async function capturePosition(role: string, ids: readonly string[]): Promise<Position | undefined> {
  const view = await viewport(role, true);
  if (!view) return;
  if (view.following) return { following: true };
  let target: Element | undefined;
  const grid = view.grid;
  const nodes = view.children;
  for (const node of nodes ?? []) {
    if (hasClass(node, 'tv')) break;
    if (node.rect[3]! > 0 && node.rect[1]! + node.rect[3]! > grid.rect[1]!) {
      target = node; break;
    }
  }
  if (!target) return;
  // Read identity and geometry together, before typing or background output
  // can change the native viewport. Keys also survive history being prepended.
  const encoded = target.class?.match(/(?:^| )ct-reading-node-([\w-]+)(?: |$)/)?.[1];
  const id = encoded && Buffer.from(encoded, 'base64url').toString('utf8');
  if (id && ids.includes(id)) return { following: false, anchor: { id, offset: target.rect[1]! - grid.rect[1]! } };
}

const inspection = { capture: capturePosition, offset: anchorOffset,
  following: async (role: string) => (await viewport(role))?.following };

/** Scroll bookmarks belong to the UI, never to Codex history or input. */
export class ReadingPositions {
  readonly saved = new Map<string, Position>();
  nodes: string[] = [];
  request?: ReadingRequest;
  private finish?: () => void;
  private disposed = false;

  constructor(private readonly render: () => void,
    private readonly role: () => string,
    private readonly reveal: (id: string) => void,
    private readonly lineHeight: () => number,
    private readonly invoke = () => runPluginCommand('reading-position'),
    private readonly enabled = !!process.stdout.isTTY,
    private readonly inspect = inspection) {}

  reply(value?: string) {
    if (!value || !this.request) return;
    try {
      const reply = JSON.parse(value);
      if (reply.token !== this.request.token) return;
      this.finish?.();
    } catch { /* Ignore stale or malformed window events. */ }
  }

  async capture(id?: string) {
    if (!id || !this.enabled || this.disposed) return;
    const position = await this.inspect.capture(this.role(), [...this.nodes]);
    if (position) this.saved.set(id, position);
    else this.saved.delete(id);
  }

  async restore(id?: string) {
    const saved = id ? this.saved.get(id) : undefined;
    if (!saved || this.disposed) return;
    if (saved.following) {
      // Replacing a transcript normally follows the tail already. Avoid issuing
      // a window command (and its native animation) when no movement is needed.
      if (await this.inspect.following(this.role()) === false)
        await this.exchange({ token: randomUUID(), lines: 0 });
      return;
    }
    const anchor = saved.anchor;
    if (!this.nodes.includes(anchor.id)) return;
    this.reveal(anchor.id);
    // Reveal mounts the saved message. Re-measure after native layout, since
    // virtualized blocks and the composer can change height while we are away.
    for (let attempt = 0; attempt < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (this.disposed) return;
      const offset = await this.inspect.offset(this.role(), anchor.id);
      if (offset === undefined) return;
      const lines = Math.round((anchor.offset - offset) / this.lineHeight());
      if (!lines) return;
      await this.exchange({ token: randomUUID(), lines, relative: true });
    }
  }

  private async exchange(request: ReadingRequest): Promise<void> {
    if (!this.enabled || this.request || this.disposed) return;
    return new Promise(resolve => {
      const finish = () => {
        if (this.request !== request) return;
        clearTimeout(timer); this.request = undefined; this.finish = undefined;
        this.render(); resolve();
      };
      const timer = setTimeout(() => finish(), 3000);
      this.finish = finish;
      this.request = request; this.render();
      void this.invoke().catch(() => finish());
    });
  }

  dispose() { this.disposed = true; this.finish?.(); }
}
