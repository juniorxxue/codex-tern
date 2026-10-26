# Using Codex × Tern

[Installation](../README.md#use-it) · [Writing proposals](proposals.md)

## Projects and sessions

It opens directly in Tern, or launches Tern from another terminal. A repository has one project instance per Tern profile and Codex home. Running the command again returns to that instance, including from another subfolder of the repository. Outside Git, the chosen folder is the project.

Each session keeps its own task, output, approvals, queue, model choices and draft. Start a task in one session, switch to another, and start another task. Both continue running. Stop affects the selected session.

Each session also remembers where you were reading, including when you only scroll through history. Switching back restores that message and reading line. A session left at the bottom keeps following new output. Reading positions survive interface reloads while the client stays open; they reset when the client exits. This uses the bundled Tern plugin.

Choose **More actions → New session model** to save a default for new sessions in every workspace. The setting survives a client restart. **Use Codex default** restores the model from Codex configuration. Changing this setting leaves existing sessions and running tasks alone; changing a session's model in the composer does not change the saved default. Resuming or forking a session keeps that session's model settings.

**Session details** shows the current model, reasoning effort, workspace and permissions. Session IDs, backend paths and diagnostics are under **Technical details**. Click the workspace name below the composer to choose a folder. The dialog shows its full path, supports **Browse**, and offers the saved new-session model. Invalid paths stay editable with an inline error.

Click **Fork from here** below a completed reply to continue that conversation in a new session. The fork includes history through that reply, including when later replies already exist. It inherits the source session's current model and reasoning effort. It keeps its initial title until your first new text prompt is accepted, then generates a new title from that prompt. A name you set manually takes precedence. It uses the same working directory and files; no Git worktree is created and no file changes are rolled back. The source keeps its later messages, task, queue and draft. The fork starts with an empty message box. **Open source** returns to the original session.

While a task runs, open the **Steer / Queue** selector to choose how to send your next message. **Steer** adds input to the current turn; **Queue** waits for that turn to finish. Opening or dismissing the choices keeps the current mode and draft. With no text or images to send, the composer shows only **Stop**; adding content also shows **Send**.

If a send times out or loses its reply, it appears as **Message delivery unconfirmed**. Check the conversation before marking it as received or moving it to the paused retry queue. The client does not resend it automatically. New text and attachments remain intact if an earlier send fails.

The native client saves each session's message draft, image paths, queue and unconfirmed messages locally. Reopening a project returns to its last selected session. Restored queues stay paused until you click **Run next**. An explicit initial prompt starts a new session; `resume THREAD_ID` opens the requested session. If the backend disconnects, click **Reconnect** above the composer to reload the conversation while keeping your draft. A session that cannot be opened leaves its draft intact and lets you select another session.

Task completion shows a small, dismissible reminder above the composer. A background session also gets a checkmark in the sidebar; **View** opens its result. Failed tasks have a warning mark. Stopping a task does not show a completion reminder, and a running queue reminds you after its final turn. Tern receives a quiet desktop notification with an unfocused-window preference; delivery follows Tern and system notification settings. Turn reminders on or off in **More actions**. No usage counters are added.

A prompt passed to a second invocation creates a new session in the existing project. Use `codex-tern resume THREAD_ID "your task"` to send it to a specific session. Explicit backend settings must match the open instance; exit it before changing those settings.

## Sessions sidebar

For a persistent sessions panel, register the bundled Tern plugin once:

```sh
codex-tern setup
```

Once the plugin is registered, the sessions sidebar opens automatically when the client starts. It reuses an existing sidebar and keeps focus in the composer. Closing it manually keeps it closed for that client run. To reopen it, use **Codex: Sessions** from Tern's command palette or run `codex-tern sessions` in the same Tern window. The sidebar shows sessions from the current folder, with activity times on hover. A spinner means a task is running; a bell means it needs input. A lock means another client owns that session. Locked rows cannot be selected and unlock automatically after the owner releases them.

Click **New session** above the sidebar list to start a conversation in the current folder. The composer receives focus, and tasks and drafts in other sessions stay intact. You can also use **Ctrl+Shift+N** or the **+** at the lower right of the client.

Drag the sidebar divider to choose its width. The proportion is saved globally in your Tern profile and shared by all projects and windows. New windows and reopened sidebars use that proportion, including after a restart. Resizing the whole window preserves your choice. Before your first adjustment, new sidebars use a comfortable default width.

Right-click a session in the sidebar and choose **Delete session** to remove it from the list by moving it to Codex's archive. Running tasks, pending questions, queued messages and unsent drafts prevent deletion; choosing the action explains why it is unavailable. Deleting the selected session returns to an existing neighbour when available. Empty conversations stay out of history until their first message.

The same right-click menu has **Rename session**. Enter a name and press **Enter** or **Save name**; **Esc** cancels. You can rename a background or running session without switching to it. Saved names appear in both the sidebar and history picker and persist in Codex. A rejected name keeps the dialog open with the error and leaves the stored title unchanged.

Sessions sort by last conversation activity, newest first. Sending a message or completing a task moves that session up, including background tasks. Opening an old session alone does not move it to the top. Refresh and pagination preserve this activity order.

## Updating the client

After `bun run build`, choose **Developer: Reload Window** in **More actions**, or press **Ctrl+Shift+R**. This loads the latest interface and styles in the same pane. Running tasks, pending questions and selected answers, queues, session drafts, attachments and editor undo stay intact. A failed load keeps the previous interface available. If a paste, send or session action is in progress, finish that action before reloading; running model turns do not block reload.

With the bundled plugin installed, Tern's command palette also has **Codex: Reload Window**. `codex-tern reload` invokes that command in the current Tern window. The command works when either the client or its sidebar has focus. Run `tern plugin reload` after updating the plugin itself.

Clients started before window reload was added need one restart to gain the feature. Finish their tasks, press **Ctrl+Q**, then launch `codex-tern` once. Changes to the backend connection, controller, launcher or dependencies still need a client restart; window reload updates the interface. Keep the client open while tasks run, since local recovery cannot keep an exited backend working. Codex saves the conversation history.

On macOS, local recovery files live in `~/Library/Application Support/codex-tern/recovery/`. `XDG_STATE_HOME` overrides the state root. Files are private to your user and scoped by project, Tern profile and Codex home. They contain draft text and attachment paths; keep the original images or their pasted-image cache available. Plain text mode keeps its existing in-memory behavior.

## Appearance

Chat messages use Concourse T3 for Latin text and LXGW Neo XiHei (霞鹜新晰黑) for Chinese, at 17 px with a 29 px line height, 16 px between paragraphs, and a centered 736 px reading column. The input area and sidebar use the same font pair at smaller sizes. Install both font families locally for this appearance; other systems fall back to their available Chinese and UI fonts. Code keeps Tern's configured code font. The sidebar has single-line titles in 32 px rows separated by 2 px; update times appear on hover. After rebuilding, use **Reload Window** to load the client styles. With the plugin installed, `tern plugin reload` also applies the shared styles to existing clients, including older clients.

Choose **Islands** in Tern’s **Change interface style** for rounded cards and spacing.

## Files and writing

Assistant `codex-file-citation` directives render as clickable local file links, including in restored conversations and streaming replies. File names can contain Chinese, spaces and punctuation. Code examples keep the literal directive.

On macOS, right-click a local file link and choose **Show in Finder** to select that file in Finder. This also works for file links in sent messages. Normal clicks still open the file in Tern.

Paper revision proposals show two full passages, with red deletions in the original above and green additions in the suggestion below. Check the edits you want and click **Apply selected edits** to draft a request for Codex. The client computes the differences and Tern renders the text and formulas. See [the proposal format and a short AGENTS.md instruction](proposals.md).

Images can be pasted; the actions menu retains **Attach image** for entering a path. Copy a PDF or another document in Finder and paste it into the composer to insert a Markdown link, such as `[report.pdf](/path/to/report.pdf)`.

## Approvals

**Approve for me** is enabled by default. The official Codex backend reviews eligible approval requests automatically. Requests that still need your decision appear in Tern. Explicit `-c` settings take precedence; use `codex-tern -c 'approvals_reviewer="user"'` for manual approval. Session details show the active reviewer.
