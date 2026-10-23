---
description: Watch the Figma plugin for notes and handle each one as it arrives
---

Start a Monitor on `fa watch` (timeout at the maximum, re-armed whenever it expires while I still work in Figma) so you are told about every new note, follow-up and message. While it runs, the Figma panel shows "Claude ready".

Tell the panel which skills you have, so the designer can pick one per note: `fa skills '<json>'` with a JSON array of `{"name", "description"}` (name exactly as the Skill tool takes it, description under 100 characters; leave out skills that make no sense for design work in Figma). Use single quotes around the JSON and no apostrophes inside it.

Also tell it which models you can hand a note to, with their full names as your environment lists them (the Agent tool's model options): `fa models '<json>'` with a JSON array of `{"id", "name"}`, for example `{"id":"opus","name":"Claude Opus 5.5"}`. Never guess a version.

Then handle whatever is already waiting (`fa list`), and every note the Monitor reports, following the `handle-figma-notes` skill. Tell me in one line that you are watching.
