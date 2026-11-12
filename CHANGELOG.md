# Changelog

Notable changes, newest first. This log starts with the update below.

## 2026-11-12

### Changed

- The light theme uses an opaque white conversation background, frosted-glass sidebars that let the window material's color show through (as in Claude Code), and pale gray user messages.
- Conversations follow Claude Code's layout: 15 px text with 23 px lines, tighter paragraph and list spacing, dark headings and bullets, gray inline code chips, and lines that stop short of the column edge. English uses Anthropic Sans Text (or the variable Anthropic Sans) when installed, otherwise the system font. Chinese keeps LXGW Neo XiHei, falling back to PingFang SC. Regular text uses weight 400. Bold text is thickened rather than set in a heavier face, so English and Chinese emphasis match Claude Code's.
- Your messages appear as right-aligned gray bubbles. The Activity summary reads like a muted status line with the chevron at the end, and **Fork from here** appears when you hover over a reply.
- Sidebars use 14 px rows with regular-weight titles, including the selected one. The composer uses 15 px text and 13 px model controls.
- The sessions sidebar opens wider by default (about 330 px, as in Claude Code). It previously opened at about half its intended width on Retina displays. A width you set yourself is kept.
- Queued messages use OMP's compact rows above the composer, with a queue icon, single-line preview, inline controls and a shared count or paused badge. The old collapsible heading and explanatory footer are removed.

### Fixed

- The sessions and topic sidebars keep their glass look while you type in the conversation, instead of graying over whenever another pane has focus. Clicking a session hands focus straight back to the conversation without a gray flash, and the tab keeps the conversation's title instead of briefly showing "Sessions".
- Question panels use the theme's fonts for prompts, choices, custom answers and buttons, including in chats already running.
- Restored the Activity summary's transparent background and left-aligned text so it no longer appears as a full-width gray button.

## 2026-11-11

### Added

- A collapsed conversation tree shows fork points and branches. Clicking a branch opens its full chat at the fork prompt. The same tree stays visible with the current branch highlighted, including when session lists omit fork metadata. Drafts, attachments and running work stay with their sessions.

### Fixed

- Folder, account and notices are centered below the composer again after Tern's Reader styles stopped applying to the Codex surface.

## 2026-10-28

### Changed

- Running turns show OMP's animated working indicator, elapsed time, and shimmering label above the message box.

## 2026-10-27

### Added

- The session TOC follows the current reading position and keeps the active heading visible. Collapsed topics stay collapsed and highlight their parent.

### Changed

- Projects open the sessions sidebar while the selected conversation loads.
- The first session list loads from the index, then refreshes in the background to update stale details and find missing sessions.
- Account details load in the background, so conversations can become usable before those details arrive.
- The TOC matches the session explorer's compact rows, muted headings and neutral selection background. Long outlines fit the card as it resizes.

### Fixed

- The TOC follows scrolling promptly, keeps the first topic highlighted at fork banners and history controls, and advances when the previous reply's prose leaves the screen. Selected rows stay fully visible above the card's bottom area, including with enlarged fonts.
- The TOC indexes discussion topics across prompts. One prompt with a long reply stays one entry, related follow-ups stay grouped, and reply sections no longer fill the card. Older saved outlines rebuild with the new rules when opened.
- Clicking a TOC heading keeps it selected until the reading position changes, including short conversations and headings that share a prompt.
- Short prompts keep their reading highlight until they leave the top of the viewport.
- Topic return buttons advance correctly when the active prompt belongs to a child heading.
- Opening a session marks its row as pending while the active highlight stays aligned with the current transcript and TOC.
- Clicking **Load more** during the initial background refresh keeps the request and uses the updated page position.
- Account replies from an old connection no longer overwrite current account details.
- Session-list replies from a previous folder or connection are ignored.
