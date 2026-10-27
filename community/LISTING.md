# Figma Community listing

What to paste into Figma's **Publish** form (Figma desktop → Plugins → Development → Retoucher → Publish).

| Field | Value |
| --- | --- |
| Name | Retoucher |
| Tagline | Leave notes on your layers. Your coding agent edits the file and answers in the panel. |
| Icon | `community/icon-128.png` (128 × 128) |
| Cover art | `community/cover-1920x1080.png` (thumbnail), then carousel `02-notes.png`, `03-stay.png`, `04-explore.png`, `05-everything.png`, `06-start.png` (1920 × 960) |
| Category | Design tools |
| Tags | ai, agent, claude, codex, cursor, comments, mcp |
| Support contact | https://github.com/alicorak/retoucher/issues |
| Network access | Already declared in `plugin/manifest.json` (localhost:4747 only, with the reason) |

## Description

Leave notes in Figma. Your coding agent does the work.

**Requires:** a coding agent on your computer (Claude Code, Codex or Cursor) with the free Retoucher agent plugin. Setup takes a minute: https://retoucher.alicorak.com. Without it, the panel shows these setup steps.

Select a layer, mark an area or drop a pin, and write what should change, like a comment. Your agent picks the note up, edits the file through the Figma MCP and answers in this panel. You see each step as it happens, answer its questions and approve its permissions without leaving Figma.

- Notes on layers, areas and pins, with @mentions for variables, styles and components
- Your own fonts: changes to text set in fonts installed on your computer run inside Figma
- Live steps, questions, plans and permission prompts in the panel
- Before and after pictures, and Undo
- Versions side by side, references, Figma comments, batches, whole-file notes
- Small mode: shrink the panel to a bar that shows when a note needs you

How to try it:
1. Open https://retoucher.alicorak.com and copy the setup prompt.
2. Paste it into your agent. It installs the Retoucher agent plugin and starts a small bridge on your computer.
3. Run Retoucher in Figma, paste the file's link once, select a layer and send a note.

Privacy: everything stays on your computer. The panel only talks to that local bridge (localhost:4747); notes, screenshots and files never leave your machine. Team library access is used only to list your library's variables and styles for @mentions.

Free and open source (MIT): https://github.com/alicorak/retoucher

## Data security

| Question | Answer |
| --- | --- |
| Does the plugin send data to a server? | No. Only to a bridge on the user's own computer (localhost:4747). |
| Does it collect personal data, analytics or usage data? | No. |
| Does it store data? | Notes and settings stay on the user's computer (~/.retoucher) and in Figma client storage. |
| Does it use AI? | The user's own coding agent, running on their own computer and account, does the edits. The plugin itself calls no AI service. |
| Third parties? | None. |

## Release notes

Paste the newest one into *Final details* when publishing a new version.

- **0.8.4:** Small mode. The button next to the status shrinks the panel to a small bar that shows when a note needs your answer or is in progress; click it to open the panel again. Retoucher opens the way you left it.
- **0.8.3:** Setup steps in the panel when no coding agent is connected yet, clearer listing.

## Plugin ID

The Community plugin ID is `1696122599848660328` (in `plugin/manifest.json`). Community page once approved: https://www.figma.com/community/plugin/1696122599848660328
