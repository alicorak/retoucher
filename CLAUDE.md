# Working on this repo

This repo is two plugins:

- **Figma plugin** in `plugin/` (`code.js` runs in Figma, `ui.html` is the panel).
- **Claude Code plugin** at the root: `.claude-plugin/` (manifest and marketplace), `hooks/hooks.json` (SessionStart starts the bridge, PermissionRequest asks in the panel), `bin/fa` (CLI on Claude's PATH), `skills/handle-figma-notes/` (how Claude handles a note), `commands/watch.md`.
- `bridge/`: `server.mjs` (local HTTP bridge, zero dependencies), `fa.mjs` (CLI), `ensure-bridge.mjs`, `permission-hook.mjs`.

Handling notes from the panel follows [skills/handle-figma-notes/SKILL.md](skills/handle-figma-notes/SKILL.md); in a checkout without the plugin installed, use `node bridge/fa.mjs` where it says `fa`.

Rules for changes:

- The bridge stays zero-dependency Node 18+, and works on macOS, Windows and Linux.
- Every request from a page (it has an `Origin` header) must carry the pairing key; keep new routes behind that check. Local-only routes refuse any request with an `Origin`.
- Bump `version` in `.claude-plugin/plugin.json` for every release: the SessionStart hook replaces an older running bridge only when the version differs.
- `claude plugin validate .` before a release.
