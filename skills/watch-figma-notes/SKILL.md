---
name: watch-figma-notes
description: Start watching the Annotate for Claude Figma panel for notes and handle each one as it arrives. Use when the user says "watch Figma notes", "watch my Figma notes", "start Figma annotate" or similar.
---

# Watching for Figma notes

1. Tell the panel which skills you have, so the designer can pick one per note: `offer_skills` (or `fa skills '<json>'`) with `{name, description}` for each skill that makes sense for design work in Figma (description under 100 characters).
2. Handle whatever is already waiting: `list_notes` (or `fa list`), each with the `handle-figma-notes` skill.
3. Watch:
   - **Claude Code:** start a Monitor on `fa watch` (timeout at the maximum, re-armed whenever it expires) and handle every note it reports.
   - **Other agents (MCP):** call `wait_for_note` in a loop. It returns new notes, follow-ups and messages as they arrive, or "nothing yet" after its timeout: then call it again right away. Between calls, handle each note it returned with the `handle-figma-notes` skill, then go back to waiting. Keep going until the user tells you to stop.
4. Tell the user in one line that you are watching.

While you are watching, the Figma panel shows "Claude ready".
