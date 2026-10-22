#!/usr/bin/env node
// Cursor beforeMCPExecution hook (cursor/hooks.json): while the Figma panel is open and the agent is on a note,
// MCP tool approvals are asked in the panel (Allow once / Always allow / Decline). Otherwise it answers "ask",
// so Cursor shows its own prompt as usual. The plugin's own figma-annotate tools only talk to the local bridge
// and are allowed without asking. Always prints a decision: the hook is registered fail-closed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdin, noteInPanel, askPanel } from './hook-lib.mjs';
const WAIT_MS = 100_000; // keep under the hook's timeout in cursor/hooks.json

const decide = (permission, agent_message) => {
  process.stdout.write(JSON.stringify({ permission, ...(agent_message ? { agent_message } : {}) }));
  process.exit(0);
};
// "Always allow" answers, remembered per server and tool; used only while a note is being worked on
const ALWAYS = path.join(process.env.FA_DATA || path.join(os.homedir(), '.figma-annotate'), 'cursor-always.json');
const always = () => { try { return JSON.parse(fs.readFileSync(ALWAYS, 'utf8')); } catch { return []; } };

let input = {};
try { input = JSON.parse((await readStdin()) || '{}'); } catch { decide('ask'); }
const server = String(input.mcp_server_name || '');
const tool = String(input.tool_name || '');
if (/figma-annotate/.test(server)) decide('allow');

const note = await noteInPanel();
if (!note) decide('ask');
const key = `${server}:${tool}`;
if (always().includes(key)) decide('allow');

let detail = '';
try { detail = JSON.stringify(typeof input.tool_input === 'string' ? JSON.parse(input.tool_input) : input.tool_input, null, 2).slice(0, 3000); } catch { detail = String(input.tool_input || '').slice(0, 3000); }
const TITLES = { use_figma: 'Edit the Figma file', upload_assets: 'Upload images to Figma', get_screenshot: 'Take a Figma screenshot', get_metadata: 'Read the Figma file', generate_image: 'Generate an image' };
const p = await askPanel({ kind: 'permission', title: TITLES[tool] || `Use ${tool.replace(/_/g, ' ')}`, sub: server, detail, rule: key, noteId: note.id }, WAIT_MS);
if (!p) decide('ask');
if (p.decision === 'always') {
  try { fs.writeFileSync(ALWAYS, JSON.stringify([...new Set([...always(), key])], null, 2)); } catch {}
  decide('allow');
}
if (p.decision === 'once') decide('allow');
decide('deny', 'The designer declined this in the Figma panel. Do not retry it; say in the note what you could not do, or ask with ask_in_note.');
