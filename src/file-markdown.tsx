/** @jsxImportSource @stencil-hq/tern */
import { html, node, type JSX } from '@stencil-hq/tern';
import { lexDocument } from '@oh-my-pi/pi-tui/components/markdown';
import { localFilePath } from './file-links';

type Token = ReturnType<typeof lexDocument>[number];
type Container = { tokens?: Token[]; items?: Token[]; header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] };

/** Give local links their own native menu, retaining Tern's Markdown renderer for other content. */
export function FileMarkdown({ text, cwd, stream = false, onReveal }: {
  text: string; cwd: string; stream?: boolean; onReveal: (path: string) => void;
}): JSX.Element {
  const plain = () => <md text={text} stream={stream} actions={{ menu: ['copy'] }} />;
  if (process.platform !== 'darwin' || !/[\[<]/.test(text)) return plain();
  const tokens = lexDocument(text);
  const paths = new Map<Token, string>();
  const contains = new Set<Token>();
  function visit(token: Token): boolean {
    if (token.type === 'link') {
      const path = localFilePath(token.href, cwd);
      if (path) { paths.set(token, path); contains.add(token); }
      return !!path;
    }
    // Link-shaped examples in code, math, images and raw HTML stay on the native path.
    if (['code', 'codespan', 'math', 'image', 'html'].includes(token.type)) return false;
    const container = token as Container;
    const children = [...(container.tokens ?? []), ...(container.items ?? []),
      ...(container.header ?? []).flatMap(cell => cell.tokens),
      ...(container.rows ?? []).flatMap(row => row.flatMap(cell => cell.tokens))];
    let found = false;
    for (const child of children) if (visit(child)) found = true;
    if (found) contains.add(token);
    return found;
  }
  for (const token of tokens) visit(token);
  if (!paths.size) return plain();

  // Keep reference definitions available to native fragments, including non-file links.
  const definitions = tokens.filter(token => token.type === 'def').map(token => token.raw).join('\n');
  const source = (raw: string) => definitions ? `${raw}\n\n${definitions}` : raw;
  const fragment = (raw: string, key: number) => {
    const leading = /^\s*/.exec(raw)![0], trailing = /\s*$/.exec(raw)![0];
    return <html.span key={key} class="ct-file-inline">
      <html.span text={leading} />
      {!!raw.trim() && <md text={source(raw.trim())} />}
      {!!raw.trim() && <html.span text={trailing} />}
    </html.span>;
  };

  function inline(items: Token[]): JSX.Element[] {
    const result: JSX.Element[] = [];
    let pending = '';
    const flush = () => { if (pending) { result.push(fragment(pending, result.length)); pending = ''; } };
    for (const token of items) {
      if (token.type === 'br') { flush(); result.push(<html.span key={result.length} class="br" text="\n" />); continue; }
      if (!contains.has(token) && token.type !== 'link') { pending += token.raw; continue; }
      flush();
      const path = paths.get(token);
      if (token.type === 'link') {
        result.push(<html.span key={result.length} class="ct-file-inline ct-markdown-link"
          role={path ? 'ct.file-link' : undefined} href={token.href}
          title={path ?? token.href} actions={path ? { menu: ['open', 'Show in Finder', 'copy'] } : undefined}
          onMenu={path ? { 'Show in Finder': () => onReveal(path) } : undefined}>
          <md text={source(token.raw)} />
        </html.span>);
      } else {
        // Only these inline containers can hold a link. Native Markdown draws all other tokens.
        result.push(node('el', { key: result.length, tag: token.type }, inline((token as Container).tokens ?? [])));
      }
    }
    flush();
    return result;
  }

  function blocks(items: Token[]): JSX.Element[] {
    const result: JSX.Element[] = [];
    let pending = '';
    const flush = (tail = false) => {
      if (pending.trim()) result.push(<md key={result.length} text={source(pending)} stream={stream && tail}
        actions={{ menu: ['copy'] }} />);
      pending = '';
    };
    for (const token of items) {
      if (token.type === 'def') continue;
      if (!contains.has(token)) { pending += token.raw; continue; }
      flush();
      let content: JSX.Element;
      switch (token.type) {
        case 'paragraph': case 'text':
          content = <html.p>{inline(token.tokens ?? [])}</html.p>; break;
        case 'heading':
          content = node('el', { tag: `h${Math.min(token.depth, 4)}` }, inline(token.tokens ?? [])); break;
        case 'blockquote':
          content = <html.blockquote>{blocks(token.tokens ?? [])}</html.blockquote>; break;
        case 'list': {
          const items = token.items.map((item: Container & { task: boolean; checked?: boolean }, index: number) => {
            const body = <html.div class="li-t">
              {item.task && <html.span text={item.checked ? '☑ ' : '☐ '} />}
              {blocks(item.tokens ?? [])}
            </html.div>;
            // Tern's el attributes do not support ol.start; keep the source numbering explicitly.
            return token.ordered ? <html.div key={index} class="ct-file-numbered" attrs={{ role: 'listitem' }}>
              <html.span text={`${Number(token.start) + index}.`} />{body}
            </html.div> : <html.li key={index}>{body}</html.li>;
          });
          content = token.ordered ? <html.div class="ct-file-ordered" attrs={{ role: 'list' }}>{items}</html.div>
            : <html.ul>{items}</html.ul>; break;
        }
        case 'table': {
          const cells = (row: { tokens: Token[] }[], head: boolean) => row.map((cell, index) =>
            node('el', { key: index, tag: head ? 'th' : 'td', class: `ct-file-align-${token.align[index] ?? 'left'}` }, inline(cell.tokens)));
          content = <html.div class="tbl"><html.table>
            <html.thead><html.tr>{cells(token.header, true)}</html.tr></html.thead>
            <html.tbody>{token.rows.map((row: { tokens: Token[] }[], index: number) =>
              <html.tr key={index}>{cells(row, false)}</html.tr>)}</html.tbody>
          </html.table></html.div>; break;
        }
        default: content = <md text={source(token.raw)} stream={stream} />;
      }
      result.push(<html.div key={result.length} class="md ct-file-block">{content}</html.div>);
    }
    flush(true);
    return result;
  }

  return <html.div class="ct-file-markdown">{blocks(tokens)}</html.div>;
}
