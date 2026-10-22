# Working on this repo

This repo is a Figma plugin plus one agent plugin for Claude Code and Codex:

- **Figma plugin** in `plugin/` (`code.js` runs in Figma, `ui.html` is the panel).
- **Claude Code plugin** at the root: `.claude-plugin/` (manifest and marketplace), `hooks/hooks.json` (SessionStart starts the bridge, PermissionRequest asks in the panel), `bin/fa` (CLI on Claude's PATH), `skills/handle-figma-notes/` (how Claude handles a note), `commands/watch.md`.
- **Codex** reads the root `plugin.json` (Agent Plugins schema), `mcp.json` (the `figma-annotate` MCP server), `.agents/plugins/marketplace.json`, `skills/` and `hooks/hooks.json` (same hook format as Claude Code).
- **Cursor** reads `.cursor-plugin/plugin.json`, which points to `cursor/hooks.json` (Cursor's own hook format, `beforeMCPExecution` → `bridge/cursor-hook.mjs`, fail-closed) and the MCP server; skills are shared.
- `bridge/`: `server.mjs` (local HTTP bridge, zero dependencies), `fa.mjs` (CLI), `mcp-server.mjs` (the same as MCP tools, for Codex and other agents), `ensure-bridge.mjs`, `permission-hook.mjs` and `ask-hook.mjs` (with `hook-lib.mjs`). Data lives in `~/.figma-annotate` for every agent.

Handling notes from the panel follows [skills/handle-figma-notes/SKILL.md](skills/handle-figma-notes/SKILL.md); in a checkout without the plugin installed, use `node bridge/fa.mjs` where it says `fa`.

Rules for changes:

- The bridge stays zero-dependency Node 18+, and works on macOS, Windows and Linux.
- Every request from a page (it has an `Origin` header) must carry the pairing key; keep new routes behind that check. Local-only routes refuse any request with an `Origin`.
- Bump `version` in `plugin.json`, `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json` for every release: the SessionStart hook replaces an older running bridge only when the version differs.
- `claude plugin validate .` before a release.
