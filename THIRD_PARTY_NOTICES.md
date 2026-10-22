# Third-party notices

## oh-my-pi native Tern layouts

The native node layouts in `src/omp-views.tsx` and `src/ui.tsx` are adapted from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), retrieved on 2026-10-21:

- `packages/tui/src/prompt/custom-editor.ts` — composer frame, input line, model/effort chips, send/stop controls.
- `packages/tui/src/prompt/welcome.ts` — welcome lockup.
- `packages/tui/src/chat/user-message.ts` and `assistant-message.ts` — transcript nodes.
- `packages/tui/src/prompt/attachment-chips.ts` — image thumbnail cards.
- `packages/coding-agent/src/utils/enhanced-paste.ts` — OSC 5522 paste negotiation.
- `packages/tui/src/native/picker.ts` — native picker structure and actions.
- `packages/tui/src/status-line/footer.ts` — compact status segments.
The client directly imports `Editor`, `CombinedAutocompleteProvider`, native node types, and editor theme adapters from **`@oh-my-pi/pi-tui` 18.12.5**. Their editing logic, keybindings, word navigation, kill ring, Vim modes, and completion components execute unchanged under Bun. `src/draft.ts` and `src/omp-native.ts` bridge the official Tern SDK to those original components.

The `omp.*` roles select styles already built into the installed Tern application. No Tern application CSS is bundled or redistributed. The client still identifies itself to Codex as `codex-tern`; no OMP agent runtime, prompts, or model behavior is used. The independent `@oh-my-pi/pi-natives` package supplies system clipboard reads through its platform N-API library. `src/clipboard/system.ts` uses its clipboard module under Bun and reads macOS file references through the built-in AppKit bridge.

MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
