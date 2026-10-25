# Figma Community listing

What to paste into Figma's **Publish** form (Figma desktop → Plugins → Development → Retoucher → Publish).

| Field | Value |
| --- | --- |
| Name | Retoucher |
| Tagline | Leave notes on your layers. Claude Code, Codex or Cursor edits the file and answers here. |
| Icon | `community/icon-128.png` (128 × 128) |
| Cover art | `community/cover-1920x960.png` (1920 × 960) |
| Category | Design tools |
| Tags | ai, agent, claude, codex, cursor, comments, mcp |
| Support contact | https://github.com/alicorak/retoucher/issues |
| Network access | Already declared in `plugin/manifest.json` (localhost:4747 only, with the reason) |

## Description

Leave notes in Figma. Your coding agent does the work.

Select a layer, mark an area or drop a pin, and write what should change, like a comment. Claude Code, Codex or Cursor picks the note up, edits the file through the Figma MCP and answers in this panel. You see each step as it happens, answer its questions and approve its permissions without leaving Figma.

- Notes on layers, areas and pins, with @mentions for variables, styles and components
- Your own fonts: changes to text set in fonts installed on your computer run inside Figma
- Live steps, questions, plans and permission prompts in the panel
- Before and after pictures, and Undo
- Versions side by side, references from any MCP, Figma comments, batches, whole-file notes

Retoucher needs its agent plugin, which starts a small bridge on your computer. Open the website, copy the setup prompt and paste it into your agent: https://retoucher.alicorak.com

Everything stays on your computer. The panel only talks to that local bridge (localhost:4747); notes, screenshots and files never leave your machine.

Free and open source (MIT): https://github.com/alicorak/retoucher

## Plugin ID

The Community plugin ID is `1696121338242482533` (in `plugin/manifest.json`). Community page once approved: https://www.figma.com/community/plugin/1696121338242482533
