export type AssistantPart = { kind: 'markdown'; text: string; start: number }
  | { kind: 'proposal'; before: string; after: string; start: number };

/** Only complete, top-level blocks opt in. Examples and unfinished replies stay literal. */
export function assistantParts(source: string): AssistantPart[] {
  if (!source.includes(':::proposal')) return [{ kind: 'markdown', text: source, start: 0 }];
  const parts: AssistantPart[] = [];
  let copied = 0, offset = 0;
  let fence: { char: string; size: number } | undefined;
  let html = false;
  let candidate: { start: number; before: number; after?: number; beforeEnd?: number } | undefined;
  const withoutEol = (end: number) => source[end - 1] === '\n' ? end - (source[end - 2] === '\r' ? 2 : 1) : end;
  for (const raw of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const start = offset; offset += raw.length;
    const line = raw.replace(/\r?\n$/, '');
    const delimiter = /^ {0,3}(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})([^\r\n]*)$/.exec(line.replace(/^(?: {0,3}>[ \t]?)+/, ''));
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence.char && delimiter[1]!.length >= fence.size && !delimiter[2]!.trim()) fence = undefined;
      continue;
    }
    if (delimiter) { fence = { char: delimiter[1]![0]!, size: delimiter[1]!.length }; continue; }
    if (!candidate && html) { html = !!line.trim(); continue; }
    if (!candidate && /^ {0,3}<(?:!--|\/?(?:div|pre|code|script|style|table|section|details|textarea)\b)/i.test(line)) {
      html = true; continue;
    }
    if (/^ {0,3}:::proposal[ \t]*$/.test(line)) {
      candidate = { start, before: -1 }; continue;
    }
    if (!candidate) continue;
    if (candidate.before < 0) {
      if (/^\[before\][ \t]*$/.test(line)) candidate.before = offset;
      else candidate = undefined;
    } else if (/^\[after\][ \t]*$/.test(line)) {
      if (candidate.after !== undefined) { candidate = undefined; continue; }
      candidate.beforeEnd = Math.max(candidate.before, withoutEol(start)); candidate.after = offset;
    } else if (/^ {0,3}:::[ \t]*$/.test(line)) {
      if (candidate.after !== undefined) {
        if (candidate.start > copied) parts.push({ kind: 'markdown', text: source.slice(copied, candidate.start), start: copied });
        parts.push({ kind: 'proposal', before: source.slice(candidate.before, candidate.beforeEnd),
          after: source.slice(candidate.after, Math.max(candidate.after, withoutEol(start))), start: candidate.start });
        copied = offset;
      }
      candidate = undefined;
    }
  }
  if (copied < source.length) parts.push({ kind: 'markdown', text: source.slice(copied), start: copied });
  return parts;
}

export interface ProposalToken {
  kind: 'text' | 'math' | 'markdown' | 'break';
  raw: string;
  tex?: string;
  display?: boolean;
}
export type ProposalRun = ProposalToken & { changed: boolean };
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

function unescapedEnd(source: string, marker: string, start: number) {
  let at = start;
  while ((at = source.indexOf(marker, at)) >= 0) {
    let slashes = 0;
    for (let p = at - 1; p >= 0 && source[p] === '\\'; p--) slashes++;
    if (slashes % 2 === 0) return at;
    at += marker.length;
  }
  return -1;
}

/** Formula sources stay intact; diff never inserts markup into TeX. */
export function proposalTokens(source: string): ProposalToken[] {
  const tokens: ProposalToken[] = [];
  let copied = 0, at = 0;
  const prose = (text: string) => {
    for (const piece of text.split(/(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/)) {
      if (!piece) continue;
      if (/^\r?\n[ \t]*\r?\n/.test(piece)) tokens.push({ kind: 'break', raw: piece });
      else for (const { segment } of words.segment(piece)) tokens.push({ kind: 'text', raw: segment });
    }
  };
  while (at < source.length) {
    if (!/[`*_~\[$\\]/.test(source[at]!)) { at++; continue; }
    let token: ProposalToken | undefined;
    const rest = source.slice(at);
    // Inline formatting is atomic too. Its Markdown is rendered by Tern.
    const inline = /^(?:`+[^`\n]+`+|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_|~~[^~\n]+~~|\[[^\]\n]+\]\([^\n]*?\))/.exec(rest)?.[0];
    if (inline) token = { kind: 'markdown', raw: inline };
    else {
      const open = rest.startsWith('\\(') ? '\\(' : rest.startsWith('\\[') ? '\\['
        : rest.startsWith('$$') ? '$$' : /^\$[^\s$]/.test(rest) ? '$' : undefined;
      if (open) {
        const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
        const end = unescapedEnd(source, close, at + open.length);
        const tex = source.slice(at + open.length, end);
        if (end >= 0 && (open !== '$' || (!/\n/.test(tex) && !/\s$/.test(tex) && !/\d/.test(source[end + 1] ?? ''))))
          token = { kind: 'math', raw: source.slice(at, end + close.length), tex, display: open === '$$' || open === '\\[' };
      } else {
        const env = /^\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|displaymath)\}/.exec(rest);
        if (env) {
          const close = `\\end{${env[1]}}`, end = source.indexOf(close, at + env[0].length);
          if (end >= 0) {
            const raw = source.slice(at, end + close.length);
            token = { kind: 'math', raw, tex: raw, display: true };
          }
        }
      }
    }
    if (token) {
      prose(source.slice(copied, at)); tokens.push(token);
      at += token.raw.length; copied = at;
    } else at += source[at] === '\\' ? Math.min(2, source.length - at) : 1;
  }
  prose(source.slice(copied));
  return tokens;
}

export interface ProposalDiff { before: ProposalRun[]; after: ProposalRun[] }
const cache = new Map<string, ProposalDiff>();

/** Bounded LCS with a common prefix/suffix fallback for unusually large proposals. */
export function proposalDiff(before: string, after: string): ProposalDiff {
  const key = JSON.stringify([before, after]);
  const cached = cache.get(key);
  if (cached) return cached;
  const a = proposalTokens(before), b = proposalTokens(after);
  const oldChanged = a.map(() => true), newChanged = b.map(() => true);
  const equal = (i: number, j: number) => a[i]!.kind === b[j]!.kind && a[i]!.raw === b[j]!.raw;
  let head = 0, tail = 0;
  while (head < a.length && head < b.length && equal(head, head)) { oldChanged[head] = newChanged[head] = false; head++; }
  while (tail < a.length - head && tail < b.length - head && equal(a.length - tail - 1, b.length - tail - 1)) {
    oldChanged[a.length - tail - 1] = newChanged[b.length - tail - 1] = false; tail++;
  }
  const n = a.length - head - tail, m = b.length - head - tail;
  if (n && m && n * m <= 1_000_000) {
    const width = m + 1, lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      lengths[i * width + j] = equal(head + i, head + j) ? lengths[(i + 1) * width + j + 1]! + 1
        : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (equal(head + i, head + j)) { oldChanged[head + i++] = newChanged[head + j++] = false; }
      else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) i++;
      else j++;
    }
  }
  const merge = (tokens: ProposalToken[], changed: boolean[]) => {
    const runs: ProposalRun[] = [];
    tokens.forEach((token, i) => {
      const last = runs.at(-1), mark = changed[i]!;
      if (token.kind === 'text' && last?.kind === 'text' && last.changed === mark) last.raw += token.raw;
      else runs.push({ ...token, changed: mark });
    });
    return runs;
  };
  const diff = { before: merge(a, oldChanged), after: merge(b, newChanged) };
  if (key.length < 32_000) {
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, diff);
  }
  return diff;
}
