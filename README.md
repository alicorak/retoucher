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

### 2. Start the bridge

```bash
./start.sh
```

Leave it running while you work. It listens on `http://localhost:4747` and keeps notes in `data/` (git-ignored, stays on your machine). Check it with:

```bash
curl localhost:4747/health
```

To use another port, set `FA_PORT`, and update `devAllowedDomains` in `plugin/manifest.json` to match.

### 3. Import the plugin into Figma

1. Open any Figma design file in the desktop app.
2. **Plugins → Development → Import plugin from manifest…**
3. Choose `plugin/manifest.json` from this repo.
4. Run it from **Plugins → Development → Annotate for Claude**.

The panel shows a green dot and "Claude connected" when it can reach the bridge. If it says "bridge offline", step 2 isn't running.

If Figma doesn't share the file key with the plugin, the panel asks you to paste the file's URL once. It is remembered afterwards.

### 4. Let Claude Code watch for notes

In a Claude Code session that has the Figma MCP connected, open this folder and ask Claude to watch the queue, for example:

> Watch the Figma annotation queue with `node bridge/fa.mjs watch` and handle each note as it arrives.

Claude then processes every note you send. The session must stay open; if it is closed, notes wait in the panel as "Waiting".

## Features

- **Batch:** *Add to batch* (⇧⌘↵) collects several notes, *Send all* delivers them together. Claude handles them in order.
- **Canvas markers:** each open note adds a native Figma annotation ("Claude #3 · Waiting") on its layers. It updates with the status and disappears when the note is done or deleted. Toggle with *Show markers on canvas*. Other people's annotations are never touched.
- **Several targets:** *Add selection* collects layers and frames, on any page, into the note. Each keeps its own screenshot. Nothing added: the current selection is used.
- **Areas:** *Select area* drops a box on the canvas. Drag and resize it over any part, then *Add area*. Claude gets the position, the screen it sits in and the layer underneath, like a pinned Figma comment.
- **Files:** add up to 8 files per note (12 MB each): photos, PDFs, text, anything. Drop them anywhere on the panel, paste (screenshots included), or use *Add file*. Photos are scaled to 1600 px.
- **Before / after + Undo:** finished notes show a before and after picture. *Undo change* restores the old values Claude recorded before editing (works without Claude being online). Changes Claude couldn't record show no Undo button.

## Using it

1. Select one or more layers in Figma.
2. Write the change in the panel, pick **Change / Fix / Add / Ask** and **Normal / Urgent**.
3. Press **Send to Claude** (⌘↵).

Each note shows its status in the panel: *Waiting → Claude is working → Done*, or *Needs your answer* when Claude has a question. Answer in the box under the note. Click a note to jump to its layers in Figma.

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
| `watch` | One line per new note or follow-up (for a Claude Code Monitor) |

The full per-note procedure (including recording undo data) is in [CLAUDE.md](CLAUDE.md); Claude Code reads it automatically when started in this folder.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Panel says "bridge offline" | Run `./start.sh`; check `curl localhost:4747/health` |
| Port already in use | Another bridge is running (`pkill -f bridge/server.mjs`), or change `FA_PORT` |
| Send button stays disabled | Needs a selection, a note, and a known file key (paste the file URL if asked) |
| Notes stay "Waiting" | No Claude Code session is watching; start step 4 |
| Claude can't edit the file | The Figma MCP isn't authorized in that Claude Code session, or your Figma seat has no edit access to the file |

## Privacy

Notes and layer screenshots are stored only in `data/` on your machine and are never committed (see `.gitignore`). The plugin talks to `localhost` only.
