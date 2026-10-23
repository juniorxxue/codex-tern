# Paper revision proposals

Tern shows each proposal as two full passages: **Original** above, **Suggested** below. Deleted words are red and struck through. Added words are green with a light background. Each edit has a checkbox and a number, starting at 1 in each reply.

Select the edits you want, then click **Apply selected edits**. This fills the message box with a request such as `Apply the edits 1, 2, 3.` Existing draft text is preserved. You send the request, and Codex makes the edits. For an older proposal reply, the request also includes a short passage to identify it.

Paste the following instruction into a paper project's `AGENTS.md`, or send it once in a session:

````markdown
Use one unfenced, top-level block per proposed edit. Keep both passages complete, preserve math, and put explanations outside:

:::proposal
[before]
<exact original>
[after]
<complete replacement>
:::
````

Example reply:

```text
:::proposal
[before]
Both the file descriptors $c_1$ and $c_2$ are closed.
[after]
Both file descriptors $c_1$ and $c_2$ are closed.
:::

The article is unnecessary here.
```

The viewer compares words, including Chinese word boundaries. Each formula is compared as a whole and rendered by Tern. Supported delimiters are `$…$`, `\(…\)`, `$$…$$`, and `\[…\]`; equation, align, alignat, gather, multline and displaymath environments are also recognized. Inline code, simple emphasis and inline links are treated as whole units. Other Markdown block syntax inside a proposal is shown as prose; place lists, tables and code examples outside proposal blocks.

Completed blocks render during streaming and when restoring history. Selection becomes available once the reply finishes. Incomplete or malformed blocks remain readable as ordinary Markdown. Fenced examples are not interpreted as proposals. Very large edits use a coarse comparison of the changed middle to keep the interface responsive. Selections stay separate for each reply and session while the client runs. The feature does not change files, send messages, or automatically add instructions to a session.

After updating this client, rebuild and start a new client process. In an existing client, finish any running tasks and save unsent drafts, then press **Ctrl+Q** and run `codex-tern` again. Reloading the Tern plugin only refreshes styles; it does not add the proposal parser to an already running process.
