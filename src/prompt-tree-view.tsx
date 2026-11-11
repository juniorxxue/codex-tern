/** @jsxImportSource @stencil-hq/tern */
import { css, html, type Node } from '@stencil-hq/tern';
import { layoutPromptTree, type PromptNode, type PromptTree } from './prompt-tree';
import type { PromptTreeState } from './prompt-tree-state';

export const promptTreeStyles = css`
  .ct-prompt-map { position: absolute; top: 12px; right: 12px; pointer-events: auto; font-family: var(--ct-prose); }
  .ct-prompt-map button { font-family: inherit; }
  .ct-prompt-map-toggle, .ct-prompt-map-action { display: flex; align-items: center; justify-content: center; color: var(--t3); cursor: pointer; }
  .ct-prompt-map-toggle { width: 32px; height: 32px; border-radius: 6px; background: var(--card); border: 1px solid var(--l2); }
  .ct-prompt-map-toggle:hover, .ct-prompt-map-action:hover { color: var(--t1); background: var(--raise); }
  .ct-prompt-map-panel { position: absolute; display: flex; flex-direction: column; width: 326px; max-width: calc(100% - 24px); max-height: min(580px, calc(100% - 220px)); min-height: 110px; background: var(--card); border: 1px solid var(--l2); border-radius: var(--r-card); box-shadow: 0 1px 2px rgba(0, 0, 0, .03); overflow: hidden; }
  .ct-prompt-map-head { display: flex; align-items: center; gap: 6px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--l2); flex: 0 0 auto; }
  .ct-prompt-map-title { flex: 1; min-width: 0; color: var(--t1); font-size: 14px; font-weight: 600; }
  .ct-prompt-map-action { width: 24px; height: 24px; border-radius: 6px; }
  .ct-prompt-map-action[aria-disabled="true"] { opacity: .4; cursor: default; }
  .ct-prompt-map-scroll { overflow: auto; min-height: 0; overscroll-behavior: contain; padding: 4px; scrollbar-width: thin; }
  .ct-prompt-map-canvas { position: relative; margin: 0 auto; }
  .ct-prompt-node { position: absolute; box-sizing: border-box; display: flex; align-items: center; text-align: left; color: var(--t1); cursor: pointer; }
  .ct-prompt-fork { width: 124px; height: 50px; padding: 6px 8px; background: var(--sf-card-bg); border: 1px solid var(--l2); border-radius: var(--r-card); }
  .ct-prompt-label { min-width: 0; width: 100%; font-family: inherit; font-size: 14px; font-weight: 500; line-height: 19px; max-height: 38px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; white-space: normal; overflow-wrap: anywhere; }
  .ct-prompt-fork.on-path { border-color: var(--t3); }
  .ct-prompt-fork.current { background: var(--l2); border-color: var(--t1); }
  .ct-prompt-fork.current .ct-prompt-label { font-weight: 600; }
  .ct-prompt-fork:hover { color: var(--t1); background: var(--raise); border-color: var(--t3); }
  .ct-prompt-map .ct-prompt-node.ct-prompt-branch { width: 28px; height: 28px; padding: 0; justify-content: center; background: transparent; border: 0; border-radius: 50%; box-shadow: none; }
  .ct-prompt-branch-dot { width: 8px; height: 8px; box-sizing: border-box; background: var(--sf-card-bg); border: 1px solid var(--t3); border-radius: 50%; }
  .ct-prompt-branch.on-path .ct-prompt-branch-dot { background: var(--t1); border-color: var(--t1); }
  .ct-prompt-map .ct-prompt-node.ct-prompt-branch:hover { background: var(--l2); }
  .ct-prompt-branch.current .ct-prompt-branch-dot { box-shadow: 0 0 0 3px var(--l2); }
  .ct-prompt-node:focus-visible, .ct-prompt-map-toggle:focus-visible, .ct-prompt-map-action:focus-visible { outline: 2px solid var(--t2); outline-offset: 2px; }
  .ct-prompt-edge { position: absolute; pointer-events: none; border-color: var(--l2); border-style: solid; border-width: 0; box-sizing: border-box; }
  .ct-prompt-edge.on-path { border-color: var(--t3); }
  .ct-prompt-map-status { padding: 14px; color: var(--t3); font-size: 12px; line-height: 18px; }
  .ct-prompt-map-error { color: var(--bad); }
`;

const layouts = new WeakMap<PromptTree, { style: string; edges: { id: string; className: string }[] }>();
/** Only generated numbers enter CSS; prompt text stays in escaped native nodes. */
export function promptTreeDrawing(tree: PromptTree) {
  const cached = layouts.get(tree);
  if (cached) return cached;
  const { positions, width, height } = layoutPromptTree(tree.nodes);
  const rules = [`.ct-prompt-map-canvas { width: ${width}px; height: ${height}px; }`];
  const edges: { id: string; className: string }[] = [];
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  tree.nodes.forEach((node, i) => {
    const p = positions.get(node.id)!;
    const branch = node.kind === 'branch';
    rules.push(`.ct-prompt-node-${i} { left: ${p.x - (branch ? 14 : 62)}px; top: ${p.y - (branch ? 14 : 25)}px; }`);
    const parent = node.parent && positions.get(node.parent);
    if (!parent) return;
    const top = parent.y + (byId.get(node.parent!)?.kind === 'branch' ? 4 : 25), h = p.y - (branch ? 4 : 25) - top, dx = p.x - parent.x;
    const cls = `ct-prompt-edge-${i}`;
    if (!dx) {
      rules.push(`.${cls}-a { left: ${p.x}px; top: ${top}px; height: ${h}px; border-left-width: 1px; }`);
      edges.push({ id: node.id, className: `${cls}-a` });
    } else {
      const mid = (p.x + parent.x) / 2, leftward = dx < 0;
      rules.push(`.${cls}-a { left: ${Math.min(parent.x, mid)}px; top: ${top}px; width: ${Math.abs(dx) / 2 + 1}px; height: ${h / 2 + 1}px; border-${leftward ? 'right' : 'left'}-width: 1px; border-bottom-width: 1px; border-bottom-${leftward ? 'right' : 'left'}-radius: 10px; }`);
      rules.push(`.${cls}-b { left: ${Math.min(p.x, mid)}px; top: ${top + h / 2}px; width: ${Math.abs(dx) / 2 + 1}px; height: ${h / 2}px; border-${leftward ? 'left' : 'right'}-width: 1px; border-top-width: 1px; border-top-${leftward ? 'left' : 'right'}-radius: 10px; }`);
      edges.push({ id: node.id, className: `${cls}-a` }, { id: node.id, className: `${cls}-b` });
    }
  });
  const result = { style: rules.join('\n'), edges }; layouts.set(tree, result); return result;
}

export function PromptMinimap({ state: s, threadId, busy, toggle, refresh, jump }: {
  state: PromptTreeState; threadId: string; busy: boolean;
  toggle(): void; refresh(): void; jump(node: PromptNode): void;
}) {
  if (!s.open) return <html.button key="prompt-map" role="ct.prompt-tree.toggle" class="ct-prompt-map ct-prompt-map-toggle"
    title="Conversation tree" aria="Show conversation tree" attrs={{ 'aria-expanded': false }} onClick={toggle}><icon name="branch" /></html.button>;
  const tree = s.data, path = new Set(tree?.paths[threadId] ?? []);
  const selected = s.selection.get(threadId) ?? tree?.paths[threadId]?.at(-1);
  return <html.aside key="prompt-map" role="ct.prompt-tree" class="ct-prompt-map ct-prompt-map-panel" aria="Conversation tree">
    <html.div key="head" class="ct-prompt-map-head">
      <html.span class="ct-prompt-map-title">Conversation tree</html.span>
      <html.button class="ct-prompt-map-action" aria="Refresh conversation tree" title="Refresh" attrs={{ 'aria-disabled': s.loading }} onClick={() => { if (!s.loading) refresh(); }}><icon name="redo" /></html.button>
      <html.button class="ct-prompt-map-action" aria="Hide conversation tree" title="Hide" attrs={{ 'aria-expanded': true }} onClick={toggle}><icon name="chev-r" /></html.button>
    </html.div>
    {s.error && <html.div key="error" class="ct-prompt-map-status ct-prompt-map-error">{s.error}</html.div>}
    {!tree && !s.error && <html.div key="loading" class="ct-prompt-map-status">Loading…</html.div>}
    {tree && <html.div key="scroll" class="ct-prompt-map-scroll" attrs={{ 'aria-busy': s.loading }}>
      {!!tree.nodes.length && <html.div key="canvas" class="ct-prompt-map-canvas">
        {promptTreeDrawing(tree).edges.map(e => <html.div key={e.className} class={`ct-prompt-edge ${e.className}${path.has(e.id) ? ' on-path' : ''}`} attrs={{ 'aria-hidden': true }} />)}
        {tree.nodes.map((node, i) => <html.button key={node.id} role={node.kind === 'branch' ? 'ct.prompt-tree.branch' : 'ct.prompt-tree.node'}
          class={`ct-prompt-node ct-prompt-${node.kind} ct-prompt-node-${i}${path.has(node.id) ? ' on-path' : ''}${selected === node.id ? ' current' : ''}`}
          title={node.text} aria={node.kind === 'branch' ? `Switch to ${node.text}` : node.label}
          attrs={{ 'aria-current': selected === node.id ? 'location' : false, 'aria-disabled': busy, ...(node.kind === 'branch' ? { 'data-thread-id': node.locations[0].threadId } : {}) }}
          onClick={() => { if (!busy) jump(node); }}>{node.kind === 'branch'
            ? <html.span class="ct-prompt-branch-dot" attrs={{ 'aria-hidden': true }} />
            : <html.span class="ct-prompt-label">{node.label}</html.span>}</html.button>)}
      </html.div>}
      {!tree.nodes.length && <html.div class="ct-prompt-map-status">No fork points to show.</html.div>}
      {!!tree.errors.length && <html.div class="ct-prompt-map-status">Some branches could not be loaded.</html.div>}
    </html.div>}
  </html.aside> as Node;
}
