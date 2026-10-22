import { EventEmitter } from 'node:events';
import type { TermInput } from '@stencil-hq/tern';

const OSC = Buffer.from('\x1b]5522;');
const PASTE = Buffer.from('\x1b[200~');
const END_PASTE = Buffer.from('\x1b[201~');
const ST = Buffer.from('\x1b\\');

/** Removes only real OSC 5522 packets; ordinary keys, TSP and pasted text pass unchanged. */
export class PasteStream {
  private held = Buffer.alloc(0);
  private paste = false;
  private discarding = false;
  constructor(readonly bytes: (data: Buffer) => void, readonly packet: (data: string) => void,
    readonly error: (message: string) => void = () => {}, readonly maxPacketBytes = 40 * 1024 * 1024) {}
  get undecided() { return this.held.length > 0 && this.held.length < OSC.length && !this.paste && !this.discarding; }
  feed(data: Uint8Array | string) {
    this.held = Buffer.concat([this.held, Buffer.from(data)]);
    while (this.held.length) {
      if (this.discarding) {
        const bel = this.held.indexOf(7); const st = this.held.indexOf(ST);
        const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
        if (end < 0) {
          this.held = this.held.at(-1) === 27 ? this.held.subarray(-1) : Buffer.alloc(0); return;
        }
        this.held = this.held.subarray(end + (end === st ? 2 : 1));
        this.discarding = false; continue;
      }
      if (this.paste) {
        const end = this.held.indexOf(END_PASTE);
        if (end < 0) { this.pass(this.held.length - suffix(this.held, END_PASTE)); return; }
        this.pass(end + END_PASTE.length); this.paste = false; continue;
      }
      if (this.held.subarray(0, OSC.length).equals(OSC)) {
        const bel = this.held.indexOf(7, OSC.length);
        const st = this.held.indexOf(ST, OSC.length);
        const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
        if (end < 0) {
          if (this.held.length > this.maxPacketBytes) {
            this.held = this.held.at(-1) === 27 ? this.held.subarray(-1) : Buffer.alloc(0);
            this.discarding = true; this.error('Clipboard packet is too large');
          }
          return;
        }
        const length = end + (end === st ? 2 : 1);
        const packet = this.held.subarray(0, length).toString('utf8');
        this.held = this.held.subarray(length); this.packet(packet); continue;
      }
      const osc = this.held.indexOf(OSC);
      const paste = this.held.indexOf(PASTE);
      const first = osc < 0 ? paste : paste < 0 ? osc : Math.min(osc, paste);
      if (first >= 0) {
        this.pass(first);
        if (first === paste) { this.pass(PASTE.length); this.paste = true; }
        continue;
      }
      this.pass(this.held.length - Math.max(suffix(this.held, OSC), suffix(this.held, PASTE)));
      return;
    }
  }
  flush() { if (this.undecided) this.pass(this.held.length); }
  private pass(length: number) {
    if (!length) return;
    const data = this.held.subarray(0, length);
    this.held = this.held.subarray(length); this.bytes(data);
  }
}

function suffix(data: Buffer, prefix: Buffer) {
  for (let n = Math.min(data.length, prefix.length - 1); n > 0; n--)
    if (data.subarray(data.length - n).equals(prefix.subarray(0, n))) return n;
  return 0;
}

/** A raw input adapter before the SDK, with no second listener consuming keys. */
export class ClipboardInput extends EventEmitter implements TermInput {
  private timer?: NodeJS.Timeout;
  private parser: PasteStream;
  private listen = (data: Buffer | string) => {
    if (this.timer) clearTimeout(this.timer);
    this.parser.feed(data);
    if (this.parser.undecided) this.timer = setTimeout(() => this.parser.flush(), 30);
  };
  constructor(readonly source: NodeJS.ReadStream, packet: (data: string) => void, error: (message: string) => void) {
    super(); this.parser = new PasteStream(data => this.emit('data', data), packet, error);
    source.on('data', this.listen);
  }
  get isTTY() { return this.source.isTTY; }
  get isRaw() { return this.source.isRaw; }
  setRawMode(raw: boolean) { this.source.setRawMode(raw); }
  resume() { this.source.resume(); }
  pause() { this.source.pause(); }
  dispose() { this.source.off('data', this.listen); if (this.timer) clearTimeout(this.timer); }
}
