import { node, type Node } from '@stencil-hq/tern';
import type { NativeChild, NativeNode, NativeUiEvent, DescribeContext } from '@oh-my-pi/pi-tui/native/node';

/** Render original OMP component descriptions through the official Tern SDK.
 * OMP lists use local item keys; the SDK sends and receives full node IDs. */
export function ompNode(child: NativeChild, context: DescribeContext,
  update: () => void, parentId = 'layer', index = 0,
  owner?: { handleNativeEvent?(event: NativeUiEvent): void }, path = ''): Node {
  let raw: NativeNode;
  if ('k' in child) raw = child;
  else {
    owner = child;
    if (!child.describe) return node('text', { text: child.render(context.cols).join('\n') });
    raw = child.describe(context) ?? { k: 'col', p: { hidden: true } }; path = '';
  }
  const id = `${parentId}.${raw.key ?? index}`;
  const props: Record<string, unknown> = { ...raw.p, key: raw.key };
  if (raw.k === 'overlay') props.anchor = { caret: 'dock.body.line.input' };
  if (raw.k === 'list' && typeof props.selected === 'string') props.selected = `${id}.${props.selected}`;
  if (raw.k === 'list' && owner?.handleNativeEvent) {
    const target = owner;
    const itemKey = (e: { id: string; item: string }) => e.item.startsWith(`${e.id}.`) ? e.item.slice(e.id.length + 1) : e.item;
    props.onSelect = (e: { id: string; item: string }) => { target.handleNativeEvent!({ type: 'select', key: path, item: itemKey(e) }); update(); };
    props.onActivate = (e: { id: string; item: string }) => { target.handleNativeEvent!({ type: 'activate', key: path, item: itemKey(e) }); update(); };
  }
  const children = (raw.c ?? []).map((c, i) => ompNode(c, context, update, id, i, owner,
    path ? `${path}/${'k' in c ? c.key ?? i : i}` : String('k' in c ? c.key ?? i : i)));
  return node(raw.k, props, children);
}
