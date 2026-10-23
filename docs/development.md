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

Every native QA script prepares an isolated `TERN_CONFIG_DIR` with `scripts/qa-tern-config.mjs` before starting Tern. The helper records the same omp state as choosing **Not Now**, so fresh test windows never show the update-management prompt or install omp. It does not change the user's Tern profile. Use this helper for new native QA scripts and manual test windows too.

`bun run test:ui` requires Tern and checks native interface scenarios without calling a model. This includes sent image sizing, image-only messages, multiple images, zoom, restored history, and resolving an unconfirmed send while preserving a new draft. Screenshots and results go to `.prototype/ui-qa/`.

`bun run test:proposals` checks stacked prose revisions, selection and prompt drafting, streamed and restored replies, word highlights, formula sizing and narrow windows in an isolated Tern test client. Screenshots and results go to `.prototype/proposals-qa/`.

`bun run test:sessions` runs a separate Tern instance with an isolated plugin configuration and a fixed backend. It checks native pane layout, folder filtering, pagination, project instance reuse, external task delivery, concurrent sessions, background completion, independent cancellation, lock indicators, stable ordering, drafts, pending questions, delayed send failures, resizing, and stale actions after the client closes. Output goes to `.prototype/sessions-qa/`.

`bun run smoke` creates a real Codex test session and uses a small amount of quota. It checks a real reply and recovery in the same process and a fresh process.

`bun run test:session-actions` uses an isolated native Tern window and a fixed backend to check reply-footer forks, exact history cutoffs, independent drafts and running tasks, context-menu renames, cancellation, errors, and persisted names after relaunch. It also checks recorded native events for transient protocol errors.

## Architecture

`src/rpc.ts` handles one stdio RPC connection per project instance. Its request return types come from the generated protocol. It validates incoming envelopes, the response containers used by the client, and essential fields in handled events before dispatch. Unknown methods stay inspectable. Timeout, disconnect and malformed responses use `RpcOutcomeUnknown`; an explicit backend rejection remains `RpcError`.

`src/controller.ts` owns the conversation registry and selection pointer. `src/conversation.ts` owns each thread's history, execution, requests and queue. Initial resume, ordinary navigation and archive replacements use the same registration path. A thread id has one conversation instance, registered before resume starts. New-thread replies adopt the instance already registered by early notifications. Failed navigation keeps the previous selection and retains any requests received by the target. Selecting a loaded conversation needs no additional resume or history RPC. Background deltas do not redraw the selected transcript; task and approval status changes update the rail.

History reads coalesce while pending. A delta received without a full item creates a partial entry. If a history response overlaps new deltas for that entry, the client re-reads the same page instead of guessing whether the snapshot includes those deltas. After three overlapping reads it reports the conflict and leaves the cursor unchanged for an explicit retry. Completed item content takes precedence over late starts, deltas and older history. `src/latest-read.ts` coalesces matching history-picker queries and discards stale results and errors when the scope or page changes. The folder sidebar retains its separate paginated cache.

`src/composer.ts` keeps text and attachments together across session switches. A send captures both, then clears the composer. Recovery restores them only if neither the text revision nor the attachment revision changed. Otherwise, rejected input goes into the original session's paused queue, preserving the newer draft.

A send with an unknown outcome goes into a separate unconfirmed list, including when it came from the queue. It cannot run again or be archived until the user resolves it. The native card can reload history, mark the message as received, or move it to the paused retry queue. It never infers acceptance from matching text. Plain mode exposes the same actions through `/unconfirmed`, `/sent ID`, and `/retry ID`; `/next` explicitly runs a queued retry.

`src/recovery.ts` stores native-client message drafts, attachment paths, queued input, unconfirmed input, the selected session and reminder preference. It uses the project-instance identity, private file permissions, a synced temporary file and atomic rename. Draft writes are coalesced for 200 ms; close flushes them. Each send waits for a durable in-flight record before writing to the backend. A recovered in-flight input becomes unconfirmed, and a matching queued entry is removed to prevent replay. Queue additions also wait for persistence. Invalid files are left intact with a visible error. Plain mode has no project singleton and retains its in-memory behavior.

Reconnect starts a fresh app-server, rereads account and model information, and resumes the selected session through the official API. Other sessions load when selected. Drafts and local input survive, restored queues stay paused, and old approval buttons are invalidated. Automatic startup and reconnect replace a saved blank selection only when the backend explicitly reports that its rollout is missing. The selection must have no title, preview, history, draft, attachments, queue or uncertain input, and its old recovery entry is removed only after successful creation. Explicit resume requests and other failures keep the original selection available. No mutation is retried automatically.

`src/project-instance.ts` gives each canonical Git root a local IPC endpoint, scoped to the Tern daemon and Codex home. Outside Git it uses the canonical folder. The existing native IPC binding verifies peer ownership, serializes binding and safely replaces stale sockets. Duplicate launches focus the owner's pane; optional resume and prompt arguments are delivered once. Lost replies are reported as uncertain and never resubmitted. Changing to another repository opens or reuses that project's client.

`src/ui.tsx` maps events to native Tern components. Codex owns execution, configuration, approvals, sandboxing, context, and saved sessions. Starting a session only passes the project directory; model and effort overrides require an explicit user choice.

The launcher defaults to `approval_policy="on-request"` and `approvals_reviewer="auto_review"` (Approve for me). It passes these settings to the official app-server before explicit `-c` overrides. This applies to new and resumed sessions. The backend owns review decisions and enforces managed requirements; the client never answers an approval request automatically. Other configuration, including the sandbox, is inherited.

The client adds no agent loop, model API calls, UI prompts, approval decisions, or automatic mutation retries. Unsupported requests return an error. After a disconnect, use **Reconnect** (or `/reconnect` in plain mode) and check the session's result before submitting again.

## Sessions pane

`tern-plugin/` is a window-only Tern plugin. `codex-tern setup` links it into Tern; its **Codex: Sessions** command opens or reuses an owned native canvas pane beside the current client. Tern draws the outer pane and its card style. `sessions.css` styles the compact, single-line list; update times live in title tooltips.

After connecting, the native client publishes a temporary `sidebarRequest` token and invokes the registered sessions command. The plugin reads the explicit surface bridge to find the requesting client, opens beside it without changing focus, and reuses an existing panel. The client clears the request after the command completes. This happens once per client run, so manually closing the sidebar keeps it closed until explicitly reopened or the client restarts. Missing or disabled plugins do not block normal client use. No discovery polling is needed when there are no open panels.

The build generates `tern-plugin/appearance.css` from `src/appearance.ts`, scoped to `data-surface="codex-tern"`. The manifest loads it alongside the sessions stylesheet. This also applies the current typography to older clients kept alive by the daemon. `tern plugin reload` updates existing windows without restarting their clients or discarding drafts. Changing the appearance source requires a rebuild before reloading the plugin.

Plugin reloads also recover existing session canvases and restart their polling. Tern calls `window_start` only once per plugin per window, so a one-shot startup timer performs the same recovery after a reload. The shared appearance sheet hides both Tern's injected path and its collapsed title/draft preview. It keeps the input, toolbar and status in normal flow when the pane loses focus, without the host's composer collapse or entrance animation. Session QA checks their bounds during focus changes and new-session creation, then checks input visibility after the host animation would have ended.

The client advertises `archiveProtocol: 1` and a per-row `canArchive` flag. Each sidebar row exposes **Delete session** through Tern's native context menu. The plugin resolves the clicked node to its session and rechecks the current snapshot before forwarding deletion. The client checks folder membership, writer locks, task state, requests, queues and drafts before calling `thread/archive`. Deleting the selected session first opens an unlocked neighbour, reusing its loaded state when possible; if no neighbour exists, it prepares an empty conversation. A failed open or archive leaves the original selected. Empty unnamed conversations with no preview or local content stay out of the sidebar. The first accepted input supplies a preview immediately. Archived IDs are filtered from late list responses and the history picker. Unavailable deletion explains what is blocking it; older running clients get restart instructions.

`src/folder-sessions.ts` holds a folder-scoped, paginated list cache, separate from the legacy history picker. The client publishes a minimal snapshot in the hidden `dock.sessions` node's title. The plugin reads that node through Tern's surface API and returns explicit refresh, pagination, and resume events to that node. It starts no backend, reads no Codex state files, and writes no prompt to a terminal. Closed-client and stale-row actions cannot start a chat or fall through to Carly.

The bridge advertises `renameProtocol: 1`. **Rename session** resolves the context-menu node to a current folder row, then opens a native client dialog without selecting that row. Saving calls `thread/name/set`; response and `thread/name/updated` metadata update loaded conversations, recovery state and cached titles. Empty names are rejected locally. A failed save keeps the entered name and shows the error in the dialog.

**Fork from here** appears beneath the last non-commentary assistant reply of a completed turn. The client calls `thread/fork` with `lastTurnId`, the unchanged `cwd`, and `excludeTurns: true`, then loads the new history with `thread/turns/list`. It does not invoke Git or create a worktree. Source tasks, requests, queues and drafts remain owned by their source conversation. If creation succeeds but history loading fails, the new conversation stays selected and can be reopened without creating another fork. `forkedFromId` supplies the source link after a restart.

The panel checks for changed snapshots while open and refreshes metadata every 15 seconds. A click paints the selected row immediately, before backend work or polling. The UI echoes a request token with completion status; only the latest click's acknowledgement can clear its pending highlight. Failed navigation restores the actual selected session. Older running clients use the current session and error state as acknowledgement. After a click the panel checks every 50 ms for two seconds, then returns to a 700 ms idle interval. It patches changed keyed rows instead of replacing the whole list. Both sidebar and history picker request `recency_at` descending. Opening history can change `updatedAt`, so it must not override the activity order. Refreshes reorder existing rows by `recencyAt`, falling back to `updatedAt` for older metadata; ties follow the backend order. Pagination merges and deduplicates earlier pages. The selected row is not pinned first. Accepted input and task completion update local activity immediately, including background conversations, without changing selection or refreshing on every streamed delta.

Selecting or loading a session adds no spinner. Sidebar running indicators require an actual active turn; navigation operations do not count as task execution. The input area's secondary status line shows session loading as plain text.

Occupancy is checked separately every two seconds. `src/session-locks.ts` tests existing writer lock files with a nonblocking native OS lock; an indexer merely opening a file does not count. Threads successfully started or resumed by this RPC connection are excluded. It never edits history, credentials or lock contents, and releases a successful probe immediately. A writer conflict racing with selection becomes a locked row without an error message. Failed scans retain the last known state.

Completing a task or changing folders refreshes the active list. A current session appears when it has a title, preview or content. Streaming output alone does not trigger repeated history requests. Folder generations reject late responses. Sidebar switches retain each thread's editor state in memory; message text and attachment paths also go to the recovery store. Temporary approval answers are not restored as new message drafts.

Live `turn/completed` events produce a small completion reminder and a background unread marker. Duplicate events, restored history and interrupted turns stay silent. A queue reports success after its last turn, including when completion arrives before the send acknowledgement. Opening a session clears its marker. `src/notifications.ts` emits sanitized OSC 99 messages for Tern, requesting silent delivery only when unfocused. The native UI uses an eight-second dismissible banner with a **View** action for background results. The actions menu persists the reminder preference; no token or quota display is added.

`tern-plugin/sidebar-width.luau` saves the sidebar's split ratio in `tern.kv` under `sessions.sidebar-ratio`. This store is shared by all projects and windows in the Tern profile and survives restarts. A separate 200 ms layout watcher records divider changes, including when the client is closed, and applies preferences from other windows. It tracks the applied preference and the effective ratio separately, so native cell rounding does not become a new preference or cause synchronization drift. Window resizing keeps the split ratio unchanged. New and restored panels apply the global preference; only new panels without one use the default width. Applying a ratio measures one native resize step in the requested direction. The default uses the client's cell width alongside column count, so it does not confuse TSP cells with the window's font metrics. `bun run test:sidebar-width` checks persistence and synchronization in real Tern windows with isolated profiles and a fixture backend.

`src/assistant-markdown.ts` converts assistant file citations before Tern parses Markdown, for live replies, restored history and plans. It leaves code, escaped markers, existing links, HTML blocks and incomplete directives literal. Shared file-link labels use character entities because Tern's math pass treats backslash-bracket escapes as display math.

`src/proposals.ts` splits complete, top-level `:::proposal` blocks from assistant messages and computes a bounded word diff. Both source passages stay intact. Formulas and inline formatting are atomic tokens. `src/proposal-view.tsx` renders two separate passages using native text, math and Markdown fragments; it never injects diff markup into TeX. `src/ui.tsx` numbers proposals within each reply, keeps selections separate by session and reply, and drafts an apply request without submitting it. The same path handles live and restored messages. `docs/proposals.md` provides the short, opt-in session/AGENTS.md format instruction; the client does not inject it into Codex prompts.

## Editor and components

The original `@oh-my-pi/pi-tui` Editor handles editing, history, word movement, kill/yank, Vim modes, and file completion. `src/draft.ts` adapts Tern input, native selection, and redo. `src/omp-native.ts` renders the original completion components. The `omp.*` roles select styles built into Tern. `src/appearance.ts` pairs Concourse T3 with LXGW Neo XiHei, with a bounded reading column, 29 px body lines and 16 px paragraph gaps. Native prose uses a shared 17 px size for both scripts, while the editor and controls keep smaller sizes. It uses installed fonts and Tern's palette; it bundles no Tern application CSS or font files. Tern confines program styles to descendants of the surface regions, so these rules must target content nodes rather than `.sf-main`, `.sf-dock`, or their `data-surface` attributes. See [third-party notices](../THIRD_PARTY_NOTICES.md).

The input area keeps model and effort selection, session actions, and send/stop controls in one wrapping toolbar. Folder, account, notices, and temporary operations share a smaller status line below it. While a turn runs, an empty composer shows Stop alone; adding text or images also shows Send. The Steer/Queue control opens a choice picker and changes mode only on selection. Both Stop and Send are native buttons with centered marks. Only the latest activity group shows Working; before any response arrives, the transcript shows a temporary indicator in the same reading column. The input area does not repeat this task status. Pending requests show Needs input instead. Button behavior requires a newly launched client; reloading the plugin applies layout and styling fixes to existing clients.

Question and approval cards use the reading font, with monospaced command details. Selected answers have a checkmark; submission stays disabled until every question has an answer. Activity summaries align their indicators and separate command previews from output. The send arrow stays subdued until text or an image is ready, and controls share hover, pressed, and keyboard focus styles. Empty conversations show a small wordmark and one prompt; version information lives in session details.

Clients advertise `newSessionProtocol: 1` so the sidebar sends new-session actions to the stable `dock.sessions` bridge. The plugin retains the old `dock.nav.new` route for older running clients. Reload the plugin after updating either the bridge or its styling.

Enter sends; Shift+Enter inserts a line break. Tab completes paths, Enter or a click accepts, and Escape dismisses. Ctrl+L opens session history; Ctrl+Shift+N starts a session; Ctrl+Shift+P opens models. Command+, opens Tern settings. Command+V and Ctrl+V support images. The actions menu includes Vim editing.

Editing follows OMP: Ctrl+A/E moves to line boundaries, Ctrl+B/F moves by character, Ctrl+P/N moves vertically, and Option+arrows moves by word. Ctrl+H/D deletes backward/forward. Ctrl+U/K/W deletes a line segment or word; Ctrl+Y restores it and Option+Y cycles earlier deletions. Command+A selects all; Command+Z and Command+Shift+Z undo and redo. Up/down on an empty draft browses submitted input. Ctrl+D exits only when the draft and images are empty and the project has no tasks or pending input. Ctrl+Q explicitly exits the project client.

## Local data

`.prototype/` holds ignored development artifacts, local research notes, and screenshots. Keep personal paths, session data, and credentials out of committed documentation and images. Pasted images go to the user cache under `codex-tern/attachments/` (on macOS, `~/Library/Caches/codex-tern/attachments/`). `XDG_CACHE_HOME` overrides the cache root. Images are sent only when submitted. The cache is not cleared automatically; finish drafts and queued messages before deleting it.

Copied file references take priority over clipboard image representations, so Finder's file icon is not attached in place of the original file. PDFs and other documents insert Markdown links with absolute paths into the draft. Both Command+V and Ctrl+V use this behavior. Copied images retain their native attachment previews. Sent images show bounded previews that open on click; image attachment paths stay out of the displayed message body.

Codex manages credentials, configuration, and saved sessions. The client inherits its environment and `CODEX_HOME`; it does not copy authentication tokens. Native recovery files live under `XDG_STATE_HOME/codex-tern/recovery`, or the platform state directory (`~/Library/Application Support` on macOS). The next-turn queue pauses after a stop, failure, disconnect or process restart. Recovery files hold client input only; conversation history is loaded through app-server.

## Current scope

Tested with Codex CLI 0.162.1, Tern 0.9.5, and Tern SDK 0.1.0. Complex MCP forms, secure input, extra permission grants, external authentication refresh, and dynamic client tools are not supported. Neither are Desktop-only integrations, voice, or cloud workflows. Model loading currently uses the first page; history uses manual pagination and has no virtualization.

Run `bun unlink` in the source directory to remove the global command. To update, pull changes, run `bun install --frozen-lockfile`, and rebuild.
