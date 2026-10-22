import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const LIMIT = 30 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export interface PreviewImage { path: string; name: string; mime: string; bytes: Buffer; width?: number; height?: number }

export function isImagePath(path: string): boolean {
  return !!MIME[extname(path).toLowerCase()];
}

export function dimensions(bytes: Buffer, mime: string): { width: number; height: number } | undefined {
  if (mime === 'image/png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mime === 'image/gif' && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (mime === 'image/jpeg') {
    let p = 2;
    while (p + 9 <= bytes.length) {
      if (bytes[p] !== 255) { p++; continue; }
      const marker = bytes[p + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
        return { width: bytes.readUInt16BE(p + 7), height: bytes.readUInt16BE(p + 5) };
      const size = bytes.readUInt16BE(p + 2); if (size < 2) break; p += size + 2;
    }
  }
  if (mime === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 12, 16) === 'VP8X')
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  return undefined;
}

export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

export async function loadImage(path: string): Promise<PreviewImage> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('The image path must point to a file');
  if (info.size > LIMIT) throw new Error('Images must be smaller than 30 MB');
  const bytes = await readFile(path);
  const mime = imageMime(bytes);
  if (!mime) throw new Error('Choose a PNG, JPEG, WebP or GIF image');
  return { path, name: basename(path), mime, bytes, ...dimensions(bytes, mime) };
}

/** Keep a stable, private copy: drafts and queued inputs must survive clipboard changes. */
export async function savePastedImage(bytes: Uint8Array, mime: string): Promise<PreviewImage> {
  if (!bytes.length || bytes.length > LIMIT) throw new Error('Clipboard images must be between 1 byte and 30 MB');
  const data = Buffer.from(bytes);
  const actualMime = imageMime(data);
  if (!actualMime || actualMime !== mime) throw new Error('Unsupported or invalid clipboard image');
  const extension = Object.keys(MIME).find(ext => MIME[ext] === actualMime)!;
  const cache = process.env.XDG_CACHE_HOME || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches') : process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : join(homedir(), '.cache'));
  const dir = join(cache, 'codex-tern', 'attachments');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, createHash('sha256').update(data).digest('hex') + extension);
  await writeFile(path, data, { mode: 0o600 });
  return { path, name: 'Clipboard image', mime: actualMime, bytes: data, ...dimensions(data, actualMime) };
}

/** OMP-style path paste: only a whole, anchored image path qualifies; prose stays text. */
export function pastedImagePaths(text: string, cwd: string): string[] | undefined {
  const normalize = (s: string) => {
    let path = s.trim();
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
    if (path.startsWith('file://')) { try { path = fileURLToPath(path); } catch { return undefined; } }
    path = path.replace(/\\([ \\"'()])/g, '$1').replace(/^~\//, (process.env.HOME ?? '~') + '/');
    if (!/^(\/|\.\.?\/)/.test(path) || !isImagePath(path)) return undefined;
    return resolve(cwd, path);
  };
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const paths = lines.map(normalize);
  return paths.length && paths.every((p): p is string => !!p) ? paths as string[] : undefined;
}
