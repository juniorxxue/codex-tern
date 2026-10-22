# Development

## Bun workflow

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
bun link
```

Commit `bun.lock`. Dependencies, builds, and QA output stay out of Git. Bun is the runtime, not a package dependency.

`bin/codex-tern` loads `dist/cli.mjs`, built from `src/cli.ts`. `src/options.ts` parses arguments; `src/launch.ts` finds executables and opens Tern. The client runs in the current pane when a native surface is available. Otherwise, it opens Tern with the absolute project path, Codex path, and user arguments. The internal `--native` flag prevents repeated launches if the handshake fails.

Run `bun run dev -C /path/to/project` to use the source. Rebuild after edits to update the global command. `bun link` points to this directory, so keep it in place and keep Bun's bin directory on PATH.

Type checking rejects unused imports, variables, and parameters. `src/generated/` is a complete snapshot of the official Codex protocol. Regenerate it as a whole:

```sh
codex app-server generate-ts --out ./src/generated
bun run build
bun run test
```

## Validation

`bun run test` uses fixed backends to check transport, session state, CLI arguments, input editing, Unicode, clipboard handling, approvals, cancellation, and recovery. Multilingual cases use Unicode escapes in the source.

`bun run test:ui` requires Tern and checks native interface scenarios without calling a model. This includes sent image sizing, image-only messages, multiple images, zoom, restored history, and resolving an unconfirmed send while preserving a new draft. Screenshots and results go to `.prototype/ui-qa/`.

`bun run test:sessions` runs a separate Tern instance with an isolated plugin configuration and a fixed backend. It checks native pane layout, folder filtering, pagination, project instance reuse, external task delivery, concurrent sessions, background completion, independent cancellation, lock indicators, stable ordering, drafts, pending questions, delayed send failures, resizing, and stale actions after the client closes. Output goes to `.prototype/sessions-qa/`.

`bun run smoke` creates a real Codex test session and uses a small amount of quota. It checks a real reply and recovery in the same process and a fresh process.

## Architecture

`src/rpc.ts` handles one stdio RPC connection per project instance. Its request return types come from the generated protocol. It validates incoming envelopes, the response containers used by the client, and essential fields in handled events before dispatch. Unknown methods stay inspectable. Timeout, disconnect and malformed responses use `RpcOutcomeUnknown`; an explicit backend rejection remains `RpcError`.

`src/controller.ts` owns the conversation registry and selection pointer. `src/conversation.ts` owns each thread's history, execution, requests and queue. Initial resume, ordinary navigation and archive replacements use the same registration path. A thread id has one conversation instance, registered before resume starts. New-thread replies adopt the instance already registered by early notifications. Failed navigation keeps the previous selection and retains any requests received by the target. Selecting a loaded conversation needs no additional resume or history RPC. Background deltas do not redraw the selected transcript; task and approval status changes update the rail.

History reads coalesce while pending. A delta received without a full item creates a partial entry. If a history response overlaps new deltas for that entry, the client re-reads the same page instead of guessing whether the snapshot includes those deltas. After three overlapping reads it reports the conflict and leaves the cursor unchanged for an explicit retry. Completed item content takes precedence over late starts, deltas and older history. `src/latest-read.ts` coalesces matching history-picker queries and discards stale results and errors when the scope or page changes. The folder sidebar retains its separate paginated cache.

`src/composer.ts` keeps text and attachments together across session switches. A send captures both, then clears the composer. Recovery restores them only if neither the text revision nor the attachment revision changed. Otherwise, rejected input goes into the original session's paused queue, preserving the newer draft.

A send with an unknown outcome goes into a separate unconfirmed list, including when it came from the queue. It cannot run again or be archived until the user resolves it. The native card can reload history, mark the message as received, or move it to the paused retry queue. It never infers acceptance from matching text. Plain mode exposes the same actions through `/unconfirmed`, `/sent ID`, and `/retry ID`; `/next` explicitly runs a queued retry. This state, like drafts and queues, remains in client memory.

`src/project-instance.ts` gives each canonical Git root a local IPC endpoint, scoped to the Tern daemon and Codex home. Outside Git it uses the canonical folder. The existing native IPC binding verifies peer ownership, serializes binding and safely replaces stale sockets. Duplicate launches focus the owner's pane; optional resume and prompt arguments are delivered once. Lost replies are reported as uncertain and never resubmitted. Changing to another repository opens or reuses that project's client.

`src/ui.tsx` maps events to native Tern components. Codex owns execution, configuration, approvals, sandboxing, context, and saved sessions. Starting a session only passes the project directory; model and effort overrides require an explicit user choice.

The launcher defaults to `approval_policy="on-request"` and `approvals_reviewer="auto_review"` (Approve for me). It passes these settings to the official app-server before explicit `-c` overrides. This applies to new and resumed sessions. The backend owns review decisions and enforces managed requirements; the client never answers an approval request automatically. Other configuration, including the sandbox, is inherited.

The client adds no agent loop, model API calls, UI prompts, approval decisions, or automatic retries. Unsupported requests return an error. After a disconnect, resume the session and check its result before submitting again.

## Sessions pane

`tern-plugin/` is a window-only Tern plugin. `codex-tern setup` links it into Tern; its **Codex: Sessions** command opens or reuses an owned native canvas pane beside the current client. Tern draws the outer pane and its card style. `sessions.css` styles the compact, single-line list; update times live in title tooltips.

After connecting, the native client publishes a temporary `sidebarRequest` token and invokes the registered sessions command. The plugin reads the explicit surface bridge to find the requesting client, opens beside it without changing focus, and reuses an existing panel. The client clears the request after the command completes. This happens once per client run, so manually closing the sidebar keeps it closed until explicitly reopened or the client restarts. Missing or disabled plugins do not block normal client use. No discovery polling is needed when there are no open panels.

The build generates `tern-plugin/appearance.css` from `src/appearance.ts`, scoped to `data-surface="codex-tern"`. The manifest loads it alongside the sessions stylesheet. This also applies the current typography to older clients kept alive by the daemon. `tern plugin reload` updates existing windows without restarting their clients or discarding drafts. Changing the appearance source requires a rebuild before reloading the plugin.

The client advertises `archiveProtocol: 1` and a per-row `canArchive` flag. The plugin rechecks the current snapshot before forwarding a trash click. The client checks folder membership, writer locks, task state, requests, queues and drafts before calling `thread/archive`. Deleting the selected session first opens an unlocked neighbour, reusing its loaded state when possible; if no neighbour exists, it prepares an empty conversation. A failed open or archive leaves the original selected. Empty unnamed conversations with no preview or local content stay out of the sidebar. The first accepted input supplies a preview immediately. Archived IDs are filtered from late list responses and the history picker. Older running clients show a disabled trash icon with restart instructions.

`src/folder-sessions.ts` holds a folder-scoped, paginated list cache, separate from the legacy history picker. The client publishes a minimal snapshot in the hidden `dock.sessions` node's title. The plugin reads that node through Tern's surface API and returns explicit refresh, pagination, and resume events to that node. It starts no backend, reads no Codex state files, and writes no prompt to a terminal. Closed-client and stale-row actions cannot start a chat or fall through to Carly.

The panel checks for changed snapshots while open and refreshes metadata every 15 seconds. A click paints the selected row immediately, before backend work or polling. The UI echoes a request token with completion status; only the latest click's acknowledgement can clear its pending highlight. Failed navigation restores the actual selected session. Older running clients use the current session and error state as acknowledgement. After a click the panel checks every 50 ms for two seconds, then returns to a 700 ms idle interval. It patches changed keyed rows instead of replacing the whole list. Both sidebar and history picker request `recency_at` descending. Opening history can change `updatedAt`, so it must not override the activity order. Refreshes reorder existing rows by `recencyAt`, falling back to `updatedAt` for older metadata; ties follow the backend order. Pagination merges and deduplicates earlier pages. The selected row is not pinned first. Accepted input and task completion update local activity immediately, including background conversations, without changing selection or refreshing on every streamed delta.

Selecting or loading a session adds no spinner. Sidebar running indicators require an actual active turn; navigation operations do not count as task execution. The input area's secondary status line shows session loading as plain text.

Occupancy is checked separately every two seconds. `src/session-locks.ts` tests existing writer lock files with a nonblocking native OS lock; an indexer merely opening a file does not count. Threads successfully started or resumed by this RPC connection are excluded. It never edits history, credentials or lock contents, and releases a successful probe immediately. A writer conflict racing with selection becomes a locked row without an error message. Failed scans retain the last known state.

Completing a task or changing folders refreshes the active list. A current session appears when it has a title, preview or content. Streaming output alone does not trigger repeated history requests. Folder generations reject late responses. Sidebar switches retain each thread's draft and attachment paths in client memory; closing the client discards those drafts.

New sidebar panes measure one native resize step against their split ratio. The client reports its cell width alongside column count, so the plugin does not confuse TSP cells with the window's font metrics. Reopening an existing sidebar preserves its manual width.

`src/assistant-markdown.ts` converts assistant file citations before Tern parses Markdown, for live replies, restored history and plans. It leaves code, escaped markers, existing links, HTML blocks and incomplete directives literal. Shared file-link labels use character entities because Tern's math pass treats backslash-bracket escapes as display math.

## Editor and components

The original `@oh-my-pi/pi-tui` Editor handles editing, history, word movement, kill/yank, Vim modes, and file completion. `src/draft.ts` adapts Tern input, native selection, and redo. `src/omp-native.ts` renders the original completion components. The `omp.*` roles select styles built into Tern. `src/appearance.ts` adds mixed-language reading fonts, a bounded reading column, and compact spacing over those native components. It uses installed fonts and Tern's palette; it bundles no Tern application CSS or font files. Tern confines program styles to descendants of the surface regions, so these rules must target content nodes rather than `.sf-main`, `.sf-dock`, or their `data-surface` attributes. See [third-party notices](../THIRD_PARTY_NOTICES.md).

The input area keeps model and effort selection, session actions, and send/stop controls in one wrapping toolbar. Folder, account, notices, and temporary operations share a smaller status line below it. Only the latest activity group shows Working; before any response arrives, the transcript shows a temporary indicator in the same reading column. The input area does not repeat this task status. Pending requests show Needs input instead. The layout changes require a newly launched client; reloading the plugin updates styling only.

Question and approval cards use the reading font, with monospaced command details. Selected answers have a checkmark; submission stays disabled until every question has an answer. Activity summaries align their indicators and separate command previews from output. The send arrow stays subdued until text or an image is ready, and controls share hover, pressed, and keyboard focus styles. Empty conversations show a small wordmark and one prompt; version information lives in session details.

Clients advertise `newSessionProtocol: 1` so the sidebar sends new-session actions to the stable `dock.sessions` bridge. The plugin retains the old `dock.nav.new` route for older running clients. Reload the plugin after updating either the bridge or its styling.

Enter sends; Shift+Enter inserts a line break. Tab completes paths, Enter or a click accepts, and Escape dismisses. Ctrl+L opens session history; Ctrl+Shift+N starts a session; Ctrl+Shift+P opens models. Command+, opens Tern settings. Command+V and Ctrl+V support images. The actions menu includes Vim editing.

Editing follows OMP: Ctrl+A/E moves to line boundaries, Ctrl+B/F moves by character, Ctrl+P/N moves vertically, and Option+arrows moves by word. Ctrl+H/D deletes backward/forward. Ctrl+U/K/W deletes a line segment or word; Ctrl+Y restores it and Option+Y cycles earlier deletions. Command+A selects all; Command+Z and Command+Shift+Z undo and redo. Up/down on an empty draft browses submitted input. Ctrl+D exits only when the draft and images are empty and the project has no tasks or pending input. Ctrl+Q explicitly exits the project client.

## Local data

`.prototype/` holds ignored development artifacts, local research notes, and screenshots. Keep personal paths, session data, and credentials out of committed documentation and images. Pasted images go to the user cache under `codex-tern/attachments/` (on macOS, `~/Library/Caches/codex-tern/attachments/`). `XDG_CACHE_HOME` overrides the cache root. Images are sent only when submitted. The cache is not cleared automatically; finish drafts and queued messages before deleting it.

Copied file references take priority over clipboard image representations, so Finder's file icon is not attached in place of the original file. PDFs and other documents insert Markdown links with absolute paths into the draft. Both Command+V and Ctrl+V use this behavior. Copied images retain their native attachment previews. Sent images show bounded previews that open on click; image attachment paths stay out of the displayed message body.

Codex manages credentials, configuration, and saved sessions. The client inherits its environment and `CODEX_HOME`; it does not copy authentication tokens. The next-turn queue stays in client memory and pauses after a stop, failure, or disconnect.

## Current scope

Tested with Codex CLI 0.162.1, Tern 0.9.5, and Tern SDK 0.1.0. Complex MCP forms, secure input, extra permission grants, external authentication refresh, and dynamic client tools are not supported. Neither are Desktop-only integrations, voice, or cloud workflows. Model loading currently uses the first page; history uses manual pagination and has no virtualization.

Run `bun unlink` in the source directory to remove the global command. To update, pull changes, run `bun install --frozen-lockfile`, and rebuild.
