import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Link copied documents without reading or copying their contents. */
export function markdownFileLinks(paths: string[]): string {
  return paths.map(path => {
    // Tern recognizes backslash-bracket pairs as math before parsing Markdown.
    // Entities keep filename punctuation literal in both rendering stages.
    const name = basename(path).replace(/[\r\n]/g, ' ').replace(/[\\[\]`*_~<>&]/g,
      character => `&#${character.charCodeAt(0)};`);
    const destination = encodeURI(path).replace(/[()#?&]/g,
      character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
    return `[${name}](${destination})`;
  }).join('\n');
}

/** URI lists describe files, never the bitmap of their Finder icons. */
export function clipboardFilePaths(text: string): string[] {
  const references = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!references.length) throw new Error('Clipboard file list is empty.');
  const paths = references.map(reference => {
    try {
      const url = new URL(reference);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || url.search || url.hash)
        throw new Error();
      decodeURIComponent(url.pathname); // Validate escapes even on runtimes with permissive fileURLToPath.
      const path = fileURLToPath(url);
      if (path.includes('\0')) throw new Error();
      return path;
    } catch { throw new Error('Clipboard files must use valid local file URLs.'); }
  });
  return [...new Set(paths)];
}
