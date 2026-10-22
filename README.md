# Codex × Tern

## What is this?

An unofficial Codex GUI built on [Tern](https://stencil.so/tern). The official Codex harness stays in charge of models, tools, approvals, sandboxing, and sessions. This project adds a native interface with rendered math, images, and file diffs.

## How it works

TypeScript and Bun connect to the official `codex app-server` over stdio JSON-RPC. The [Tern Surface Protocol SDK](https://docs.stencil.so/tern/protocol/sdks.html) renders the interface natively. Your existing Codex login and configuration carry over.

**Approve for me** is enabled by default. The official Codex backend reviews eligible approval requests automatically. Requests that still need your decision appear in Tern. Explicit `-c` settings take precedence; use `codex-tern -c 'approvals_reviewer="user"'` for manual approval. Session details show the active reviewer.

## Use it

Get access to [Tern](https://stencil.so/tern) (currently in closed beta), install [Bun](https://bun.com/docs/installation) 1.4.3+, and install the official [Codex CLI](https://github.com/openai/codex). Sign in with `codex login` and make sure `tern` and `codex` are on your PATH.

Clone this repository, then run:

```sh
cd codex-tern
bun install --frozen-lockfile
bun run build
bun link
```

From any project directory:

```sh
codex-tern
# Or choose a project:
codex-tern -C /path/to/project
```

It opens directly in Tern, or launches Tern from another terminal. A repository has one project instance per Tern profile and Codex home. Running the command again returns to that instance, including from another subfolder of the repository. Outside Git, the chosen folder is the project.

Each session keeps its own task, output, approvals, queue, model choices and draft. Start a task in one session, switch to another, and start another task. Both continue running. Stop affects the selected session.

If a send times out or loses its reply, it appears as **Message delivery unconfirmed**. Check the conversation before marking it as received or moving it to the paused retry queue. The client does not resend it automatically. New text and attachments remain intact if an earlier send fails.

A prompt passed to a second invocation creates a new session in the existing project. Use `codex-tern resume THREAD_ID "your task"` to send it to a specific session. Explicit backend settings must match the open instance; exit it before changing those settings.

For a persistent sessions panel, register the bundled Tern plugin once:

```sh
codex-tern setup
```

Once the plugin is registered, the sessions sidebar opens automatically when the client starts. It reuses an existing sidebar and keeps focus in the composer. Closing it manually keeps it closed for that client run. To reopen it, use **Codex: Sessions** from Tern's command palette or run `codex-tern sessions` in the same Tern window. The sidebar shows sessions from the current folder, with activity times on hover. A spinner means a task is running; a bell means it needs input. A lock means another client owns that session. Locked rows cannot be selected and unlock automatically after the owner releases them.

Click **New session** above the sidebar list to start a conversation in the current folder. The composer receives focus, and tasks and drafts in other sessions stay intact. You can also use **Ctrl+Shift+N** or the **+** at the lower right of the client.

When upgrading from the older client, exit its duplicate project tabs once before starting this version. Keep the project client open while its tasks run. Drafts and running state stay in its memory; Codex saves the conversation history.

Replies use SF Pro Text and PingFang SC at 16 px with a 24 px line height and a centered 736 px reading column. Paragraphs, lists, code blocks and the input area use compact spacing inspired by Claude. Code keeps Tern's configured code font. The sidebar has single-line titles in 32 px rows separated by 2 px; update times appear on hover. After rebuilding, run `tern plugin reload` to apply the styles to existing clients with the bundled plugin installed. Without the plugin, exit and relaunch the client; reopening a Tern window restores its existing process.

The trash icon on each sidebar row removes that session from the list by moving it to Codex's archive. Running tasks, pending questions, queued messages and unsent drafts disable deletion. Deleting the selected session returns to an existing neighbour when available. Empty conversations stay out of history until their first message. New panels use a wider default sidebar, with less space in narrow windows. These changes require the updated client: exit it with **Ctrl+Q**, then run `codex-tern` again. Reopening Tern alone keeps the old client process.

Sessions sort by last conversation activity, newest first. Sending a message or completing a task moves that session up, including background tasks. Opening an old session alone does not move it to the top. Refresh and pagination preserve this activity order.

Assistant `codex-file-citation` directives render as clickable local file links, including in restored conversations and streaming replies. File names can contain Chinese, spaces and punctuation. Code examples keep the literal directive.

The panel follows Tern's own layout and material. Choose **Islands** in **Change interface style** for the rounded cards and spacing. It adds no toolbar button. Images can still be pasted; the actions menu retains **Attach image** for entering a path. Copy a PDF or another document in Finder and paste it into the composer to insert a Markdown link, such as `[report.pdf](/path/to/report.pdf)`.
