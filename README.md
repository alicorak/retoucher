# Annotate for Claude (Figma plugin + bridge)

Select a layer in Figma, write what should change, press Send. Claude Code picks it up, edits the file through the Figma MCP, and replies in the plugin panel.

## One-time setup
1. `./start.sh` (keeps the local bridge on http://localhost:4747)
2. Figma desktop → Plugins → Development → Import plugin from manifest… → `plugin/manifest.json`
3. Run it from Plugins → Development → Annotate for Claude

## Claude Code side
`node bridge/fa.mjs list|show|claim|done|ask|say|watch` — see bridge/fa.mjs.
Workflow for each note: `claim` → `show` (read screenshot at imagePath) → inspect node via Figma MCP → edit → verify screenshot → `done` or `ask`.
