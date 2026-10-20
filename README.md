# Annotate for Claude (Figma plugin + bridge)

Select a layer in Figma, write what should change, press Send. Claude Code picks the note up, edits the file through the Figma MCP, and replies in the plugin panel. No screenshots or links to copy between Figma and Claude Code.

```
Figma plugin  ──POST──▶  local bridge (localhost:4747)  ◀──fa CLI──  Claude Code
   (panel)                 stores notes + screenshots                  (edits via Figma MCP)
```

## Requirements

- macOS or Linux, [Node.js](https://nodejs.org) 18 or newer (uses built-in `fetch`; no `npm install` needed)
- Figma **desktop app** (development plugins can't be imported in the browser)
- [Claude Code](https://claude.com/claude-code) with the **Figma MCP server** connected and authorized, and edit access to the Figma file you want to change

## Setup

### 1. Get the code

```bash
git clone https://github.com/madebyecho/figma-annotate.git
cd figma-annotate
```

### 2. Install the bridge

```bash
./install.sh
```

The bridge connects the plugin to Claude Code. On macOS this runs it in the background: it starts at login and restarts itself, so no terminal has to stay open. It listens on `http://localhost:4747`, keeps notes in `data/` (git-ignored, stays on your machine) and logs to `data/bridge.log`. Remove it with `./install.sh uninstall`.

On Linux, or to run it by hand, use `./start.sh` and leave that terminal open.

To use another port, set `FA_PORT` (for example `FA_PORT=4848 ./install.sh`), and update `devAllowedDomains` in `plugin/manifest.json` to match.

### 3. Import the plugin into Figma

1. Open any Figma design file in the desktop app.
2. **Plugins → Development → Import plugin from manifest…**
3. Choose `plugin/manifest.json` **from this folder** (not a copy elsewhere: Figma loads the code next to the manifest). `./install.sh` prints the full path.
4. Run it from **Plugins → Development → Annotate for Claude**.

If Figma doesn't share the file key with the plugin, the panel asks you to paste the file's URL once. It is remembered afterwards.

### 4. Let Claude Code watch for notes

Open this folder in Claude Code (with the Figma MCP connected) and type:

```
/watch-notes
```

The top of the panel tells you where things stand, and what to do when something is missing:

| Panel | Meaning |
| --- | --- |
| 🟢 Claude ready | Claude is watching; notes are picked up right away |
| 🟡 Claude not watching | The bridge runs, but no Claude Code session watches. Notes wait until you run `/watch-notes` |
| 🔴 Bridge off | Run the command the panel shows (`./install.sh`) |

## Features

- **Quick action:** press ⌘/ in Figma, type "Annotate for Claude", Tab, write the note, Enter. It goes out with the current selection without opening anything else.
- **Chat with every note:** write under any note at any time, also while Claude is working. Claude gets the message right away.
- **@mentions:** type `@` in the note to pick a variable, style, component or library. Claude uses exactly those. Library components show up once they are used on the page.
- **Design system:** *Any library* / *This file only* / a library name tells Claude what to build with. Claude builds from the file's components and variables, follows a Figma Spec if there is one, and uses hard-coded values only when nothing fits.
- **Versions:** pick 2–4 and Claude makes that many different directions side by side, leaving the original alone.
- **Whole page:** send a note with nothing selected and it is about the page.
- **Selecting opens the note:** select a layer on the canvas and the note about it is highlighted in the panel.
- **Options:** versions, design system, comments, urgent and canvas markers sit behind *Options*. The button shows what is switched on.
- **Batch:** *Add to batch* (⇧⌘↵) collects several notes, *Send all* delivers them together. Claude handles them in order, or *At the same time* when they don't depend on each other.
- **Canvas markers:** each open note adds a native Figma annotation ("Claude #3 · Waiting") on its layers. It updates with the status and disappears when the note is done or deleted. Toggle with *Show markers on canvas*. Other people's annotations are never touched.
- **Several targets:** *Add selection* collects layers and frames, on any page, into the note. Each keeps its own screenshot. Nothing added: the current selection is used.
- **Areas:** select a frame (or nothing, for what is on screen) and press *Mark area*. A big picture opens in the panel: drag to mark an area, click to drop a pin, then *Add*. Claude gets each area's crop, its position, the screen it sits in and the layer underneath, like a pinned Figma comment.
- **Figma comments:** tick *Use Figma comments* and Claude reads the open comment threads on those layers and applies them (needs a token, see below).
- **Files:** add up to 8 files per note (12 MB each): photos, PDFs, text, anything. Drop them anywhere on the panel, paste (screenshots included), or use *Add file*. Photos are scaled to 1600 px.
- **Before / after + Undo:** finished notes show a before and after picture. *Undo change* restores the old values Claude recorded before editing (works without Claude being online): layer properties, styles, instance properties and swaps, variable bindings, variables, moved layers and new layers. Changes Claude couldn't record show no Undo button.

### Figma comments

Reading comments goes through Figma's REST API and needs a personal access token (Figma → Settings → Security → Personal access tokens, scope *File comments: read*). Give it to the bridge in one of two ways, then restart it:

```bash
FIGMA_TOKEN=figd_... ./start.sh
```

or put `{ "figmaToken": "figd_..." }` in `data/config.json` (git-ignored). `curl localhost:4747/health` shows `"comments": true` when it is set.

## Using it

1. Select one or more layers in Figma (or nothing, for the whole page).
2. Write the change in the box at the bottom of the panel.
3. Press **Send** (⌘↵).

Notes read like a chat, newest at the bottom. Each one shows its status: *Waiting → Claude is working → Done*, or *Needs your answer* when Claude has a question. Answer in the box under the note. Click a note to jump to its layers in Figma.

Tip: select the specific layer you mean. A selection that covers a whole row of screens is ambiguous, and Claude will ask what you meant.

## How Claude handles a note

`node bridge/fa.mjs <command>`:

| Command | What it does |
| --- | --- |
| `list [status]` | Notes by status (default `pending`) |
| `show <id>` | Full detail: file key, layer IDs, screenshot path, Figma URL |
| `claim <id>` | Mark as working |
| `done <id> "msg"` | Reply and mark done |
| `ask <id> "question"` | Reply and ask the user something |
| `say <id> "msg"` | Reply without changing status |
| `snapshot <id> before\|after <png>` | Store a before/after screenshot shown in the panel |
| `patch <id> <json>` | Store the revert patch behind the Undo button |
| `focus <id> <json>` | Layers to select; the panel shows a *Select N layers* button |
| `comments <fileKey\|id> [--all]` | The file's open Figma comment threads (needs a token) |
| `watch` | One line per new note, follow-up or message while Claude works (for a Claude Code Monitor) |

The full per-note procedure (including recording undo data) is in [CLAUDE.md](CLAUDE.md); Claude Code reads it automatically when started in this folder.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Panel says "Bridge off" | Run `./install.sh` (or `./start.sh`); check `curl localhost:4747/health` |
| "An error occurred while loading the plugin environment" | The plugin was imported from a copy of `manifest.json` (e.g. in Downloads). Remove it under Plugins → Development → Manage plugins in development, and import `plugin/manifest.json` from this folder |
| Port already in use | A bridge already runs (the background one, or a terminal). `./install.sh` stops a terminal one and takes over |
| Send button stays disabled | Needs a note and a known file key (paste the file URL if asked) |
| No quick action or no libraries after updating | Re-import the plugin (the manifest changed): Plugins → Development → Import plugin from manifest… |
| Notes stay "Waiting" | Panel says "Claude not watching": run `/watch-notes` in Claude Code |
| Claude can't edit the file | The Figma MCP isn't authorized in that Claude Code session, or your Figma seat has no edit access to the file |

## Privacy

Notes and layer screenshots are stored only in `data/` on your machine and are never committed (see `.gitignore`). The plugin talks to `localhost` only.
