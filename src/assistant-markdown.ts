import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownFileLinks } from './clipboard/files';

const marker = /^:{1,3}codex-file-citation\{/;

function citation(source: string, start: number, budget: { left: number }) {
  const prefix = marker.exec(source.slice(start, start + 25));
  if (!prefix || source[start - 1] === ':') return;
  let at = start + prefix[0].length;
  const attributes = new Map<string, string>();
  const space = () => { while (/[ \t]/.test(source[at] ?? '') && budget.left-- > 0) at++; };
  while (at < source.length && budget.left-- > 0) {
    space();
    if (source[at] === '}') {
      const path = attributes.get('path');
      if (path?.trim() && !/[\r\n\0]/.test(path)) return { path, end: at + 1 };
      return;
    }
    const begin = at;
    while (/[\w-]/.test(source[at] ?? '') && budget.left-- > 0) at++;
    const key = source.slice(begin, at);
    if (!key || attributes.has(key)) return;
    space();
    if (source[at++] !== '=') return;
    space();
    const quote = source[at] === '"' || source[at] === "'" ? source[at++] : '';
    const valueStart = at;
    while (at < source.length && budget.left-- > 0 && source[at] !== '\n' && source[at] !== '\r'
      && (quote ? source[at] !== quote : !/[ \t}]/.test(source[at]!))) at++;
    if (budget.left <= 0 || (quote && source[at] !== quote) || /[\r\n]/.test(source[at] ?? '')) return;
    const value = source.slice(valueStart, at);
    if (!quote && !value) return;
    attributes.set(key, value);
    if (quote) at++;
  }
}

function bracketEnd(source: string, start: number, open: string, close: string) {
  let depth = 0;
  for (let at = start; at < source.length; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === open) depth++;
    if (source[at] === close && --depth === 0) return at + 1;
  }
  return start;
}

/** Convert assistant file directives for Tern, keeping examples and unfinished output literal. */
export function assistantMarkdown(source: string, cwd: string): string {
  if (!source.includes('codex-file-citation')) return source;
  let result = '', copied = 0, at = 0;
  let fence: { character: string; length: number } | undefined;
  let htmlBlock = false;
  const budget = { left: source.length * 4 };
  while (at < source.length) {
    if (at === 0 || source[at - 1] === '\n') {
      const end = source.indexOf('\n', at);
      const next = end < 0 ? source.length : end + 1;
      const line = source.slice(at, next);
      const content = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
      const delimiter = /^ {0,3}(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})([^\r\n]*)/.exec(content);
      if (fence) {
        if (delimiter && delimiter[1]![0] === fence.character && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
        at = next; continue;
      }
      if (delimiter) { fence = { character: delimiter[1]![0]!, length: delimiter[1]!.length }; at = next; continue; }
      if (htmlBlock) { htmlBlock = !!content.trim(); at = next; continue; }
      if (/^ {0,3}<(?:!--|\/?(?:div|pre|code|script|style|table|section|details|textarea)\b)/i.test(content)) {
        htmlBlock = true; at = next; continue;
      }
      if (/^(?: {4}|\t)/.test(content) || /^ {0,3}\[[^\]]+\]:/.test(content)) { at = next; continue; }
    }
    const character = source[at];
    if (character === '\\') { at += 2; continue; }
    if (character === '`') {
      let length = 1;
      while (source[at + length] === '`') length++;
      let close = at + length;
      while ((close = source.indexOf('`'.repeat(length), close)) >= 0) {
        if (source[close - 1] !== '`' && source[close + length] !== '`') break;
        while (source[close] === '`') close++;
      }
      at = close < 0 ? source.length : close + length; continue;
    }
    if (character === '[') {
      const labelEnd = bracketEnd(source, at, '[', ']');
      if (labelEnd > at && (source[labelEnd] === '(' || source[labelEnd] === '[')) {
        const open = source[labelEnd]!;
        const end = bracketEnd(source, labelEnd, open, open === '(' ? ')' : ']');
        if (end > labelEnd) { at = end; continue; }
      }
    }
    if (character === '<') {
      const end = source.indexOf('>', at + 1);
      if (end >= 0) { at = end + 1; continue; }
    }
    if (character === ':' && budget.left > 0) {
      const parsed = citation(source, at, budget);
      if (parsed) {
        // Only local file references belong here. Other URL schemes stay literal.
        const scheme = /^[a-z][a-z\d+.-]*:/i.exec(parsed.path)?.[0];
        if (!scheme || scheme === 'file:') {
          try {
            const path = scheme ? fileURLToPath(parsed.path) : resolve(cwd, parsed.path);
            result += source.slice(copied, at) + markdownFileLinks([path]);
            copied = parsed.end;
          } catch { /* Leave invalid file URLs readable. */ }
        }
        at = parsed.end; continue;
      }
    }
    at++;
  }
  return result + source.slice(copied);
}
