# Using Codex × Tern

[Installation](../README.md#use-it) · [Writing proposals](proposals.md)

## Projects and sessions

It opens directly in Tern, or launches Tern from another terminal. A repository has one project instance per Tern profile and Codex home. Running the command again returns to that instance, including from another subfolder of the repository. Outside Git, the chosen folder is the project.

Each session keeps its own task, output, approvals, queue, model choices and draft. Start a task in one session, switch to another, and start another task. Both continue running. Stop affects the selected session.

If a send times out or loses its reply, it appears as **Message delivery unconfirmed**. Check the conversation before marking it as received or moving it to the paused retry queue. The client does not resend it automatically. New text and attachments remain intact if an earlier send fails.

A prompt passed to a second invocation creates a new session in the existing project. Use `codex-tern resume THREAD_ID "your task"` to send it to a specific session. Explicit backend settings must match the open instance; exit it before changing those settings.

## Sessions sidebar

For a persistent sessions panel, register the bundled Tern plugin once:

```sh
codex-tern setup
```

Once the plugin is registered, the sessions sidebar opens automatically when the client starts. It reuses an existing sidebar and keeps focus in the composer. Closing it manually keeps it closed for that client run. To reopen it, use **Codex: Sessions** from Tern's command palette or run `codex-tern sessions` in the same Tern window. The sidebar shows sessions from the current folder, with activity times on hover. A spinner means a task is running; a bell means it needs input. A lock means another client owns that session. Locked rows cannot be selected and unlock automatically after the owner releases them.

Click **New session** above the sidebar list to start a conversation in the current folder. The composer receives focus, and tasks and drafts in other sessions stay intact. You can also use **Ctrl+Shift+N** or the **+** at the lower right of the client.

The trash icon on each sidebar row removes that session from the list by moving it to Codex's archive. Running tasks, pending questions, queued messages and unsent drafts disable deletion. Deleting the selected session returns to an existing neighbour when available. Empty conversations stay out of history until their first message. New panels use a wider default sidebar, with less space in narrow windows. These changes require the updated client: exit it with **Ctrl+Q**, then run `codex-tern` again. Reopening Tern alone keeps the old client process.

Sessions sort by last conversation activity, newest first. Sending a message or completing a task moves that session up, including background tasks. Opening an old session alone does not move it to the top. Refresh and pagination preserve this activity order.

## Updating the client

When upgrading from the older client, exit its duplicate project tabs once before starting this version. Keep the project client open while its tasks run. Drafts and running state stay in its memory; Codex saves the conversation history.

## Appearance

Chat messages use Nunito for Latin text and GenSenRounded2 TC (源泉圆体) for Chinese, at 17 px with a 29 px line height, 16 px between paragraphs, and a centered 736 px reading column. The input area and sidebar use the same font pair at smaller sizes. Install both font families locally for this appearance; other systems fall back to their available Chinese and UI fonts. Code keeps Tern's configured code font. The sidebar has single-line titles in 32 px rows separated by 2 px; update times appear on hover. After rebuilding, run `tern plugin reload` to apply the styles to existing clients with the bundled plugin installed. Without the plugin, exit and relaunch the client; reopening a Tern window restores its existing process.

Choose **Islands** in Tern’s **Change interface style** for rounded cards and spacing.

## Files and writing

Assistant `codex-file-citation` directives render as clickable local file links, including in restored conversations and streaming replies. File names can contain Chinese, spaces and punctuation. Code examples keep the literal directive.

Paper revision proposals show two full passages, with red deletions in the original above and green additions in the suggestion below. Check the edits you want and click **Apply selected edits** to draft a request for Codex. The client computes the differences and Tern renders the text and formulas. See [the proposal format and a short AGENTS.md instruction](proposals.md).

Images can be pasted; the actions menu retains **Attach image** for entering a path. Copy a PDF or another document in Finder and paste it into the composer to insert a Markdown link, such as `[report.pdf](/path/to/report.pdf)`.

## Approvals

**Approve for me** is enabled by default. The official Codex backend reviews eligible approval requests automatically. Requests that still need your decision appear in Tern. Explicit `-c` settings take precedence; use `codex-tern -c 'approvals_reviewer="user"'` for manual approval. Session details show the active reviewer.
