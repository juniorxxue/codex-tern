# Changelog

Notable changes, newest first. This log starts with the update below.

## 2026-10-27

### Added

- The session TOC follows the current reading position and keeps the active heading visible. Collapsed topics stay collapsed and highlight their parent.

### Changed

- Projects open the sessions sidebar while the selected conversation loads.
- The first session list loads from the index, then refreshes in the background to update stale details and find missing sessions.
- Account details load in the background, so conversations can become usable before those details arrive.
- TOC headings, active topics and return-visit controls are easier to read. Long outlines fit the card as it resizes.

### Fixed

- Clicking **Load more** during the initial background refresh keeps the request and uses the updated page position.
- Account replies from an old connection no longer overwrite current account details.
- Session-list replies from a previous folder or connection are ignored.
