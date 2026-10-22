import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { readImageFromClipboard, readTextFromClipboard } from '@oh-my-pi/pi-natives/clipboard';
import { pastedImagePaths } from '../attachments';
import { clipboardFilePaths } from './files';

const exec = promisify(execFile);
// AppKit is built into macOS. No Swift compiler, Xcode, or extra runtime is needed.
const MAC_FILE_REFERENCES = `ObjC.import('AppKit');
const board = $.NSPasteboard.generalPasteboard;
const items = board.pasteboardItems;
const files = [];
for (let i = 0; i < Number(items.count); i++) {
  const value = ObjC.unwrap(items.objectAtIndex(i).stringForType('public.file-url'));
  if (value) files.push(value);
}
if (!files.length) {
  const legacy = ObjC.deepUnwrap(board.propertyListForType('NSFilenamesPboardType'));
  if (Array.isArray(legacy)) files.push(...legacy);
}
JSON.stringify(files);`;

export async function readClipboardFiles(): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_FILE_REFERENCES],
    { timeout: 5000, maxBuffer: 1024 * 1024 });
  const references: unknown = JSON.parse(stdout);
  if (!Array.isArray(references) || !references.every(value => typeof value === 'string'))
    throw new Error('Could not read clipboard file references.');
  return [...new Set(references.map(reference => {
    if (reference.startsWith('file:')) return clipboardFilePaths(reference)[0];
    if (isAbsolute(reference)) return reference;
    throw new Error('Clipboard file references must be absolute paths.');
  }))];
}

interface ClipboardImage { data: Uint8Array; mimeType: string }
interface ClipboardReaders {
  files(): Promise<string[]>;
  text(): Promise<string | null | undefined>;
  image(): Promise<ClipboardImage | null | undefined>;
}

export type ClipboardContent = { kind: 'files'; paths: string[]; text?: string }
  | { kind: 'image'; image: ClipboardImage } | { kind: 'text'; text: string } | { kind: 'empty' };

/** File references win over Finder's image representation. Never fall back to its icon. */
export async function readSystemClipboard(cwd: string, imagesAllowed: boolean,
  readers: ClipboardReaders = { files: readClipboardFiles, text: readTextFromClipboard, image: readImageFromClipboard }): Promise<ClipboardContent> {
  const files = await readers.files();
  if (files.length) return imagesAllowed ? { kind: 'files', paths: files } : { kind: 'text', text: files.join('\n') };
  const text = await readers.text() ?? '';
  if (imagesAllowed) {
    const paths = pastedImagePaths(text, cwd);
    if (paths) return { kind: 'files', paths, text };
    const image = await readers.image();
    if (image) return { kind: 'image', image };
  }
  return text ? { kind: 'text', text } : { kind: 'empty' };
}
