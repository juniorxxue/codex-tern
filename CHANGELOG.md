# Changelog

Notable changes, newest first. This log starts with the update below.

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
