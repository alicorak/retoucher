#!/usr/bin/env node
// Cursor beforeMCPExecution and beforeShellExecution hook (cursor/hooks.json): while the Figma panel is open and the
// agent is on a note, MCP tool and shell command approvals are asked in the panel (Allow once / Always allow /
// Decline). Otherwise it answers "ask", so Cursor shows its own prompt as usual. The plugin's own retoucher tools
// and commands only talk to the local bridge and are allowed without asking. Always prints a decision: the hook is
// registered fail-closed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdin, noteInPanel, askPanel, plainCommand } from './hook-lib.mjs';
const WAIT_MS = 100_000; // keep under the hook's timeout in cursor/hooks.json

const decide = (permission, agent_message) => {
  process.stdout.write(JSON.stringify({ permission, ...(agent_message ? { agent_message } : {}) }));
  process.exit(0);
};
// "Always allow" answers, remembered per MCP tool ("server:tool"), command prefix ("shell:npm run") or exact command;
// used only while a note is being worked on
const ALWAYS = path.join(process.env.FA_DATA || path.join(os.homedir(), '.retoucher'), 'cursor-always.json');
const always = () => { try { return JSON.parse(fs.readFileSync(ALWAYS, 'utf8')); } catch { return []; } };

let input = {};
try { input = JSON.parse((await readStdin()) || '{}'); } catch { decide('ask'); }
const shell = input.hook_event_name === 'beforeShellExecution' || (!input.mcp_server_name && typeof input.command === 'string');

let ask, key;
if (shell) {
  const cmd = String(input.command || '').trim();
  if (!cmd) decide('ask');
  const plain = plainCommand(cmd);
  if (plain && /^(retoucher|fa)(\s|$)/.test(cmd)) decide('allow');
  const note = await noteInPanel();
  if (!note) decide('ask');
  // A prefix rule covers one plain command only, so "always allow git status" never lets "git status; rm …" through.
  // Program plus its subcommand when there is one: "npm run", "git push", "node".
  const words = cmd.split(/\s+/);
  const prefix = words.slice(0, /^[a-z][\w:-]*$/i.test(words[1] || '') ? 2 : 1).join(' ');
  // Anything else (pipes, ;, &&, $(…)) is remembered only as the exact same command
  key = plain ? `shell:${prefix}` : `shell=${cmd}`;
  if (always().includes(key)) decide('allow');
  const cwd = String(input.cwd || '');
  ask = { kind: 'permission', title: 'Run a command', sub: cwd ? path.basename(cwd) : '', detail: cmd.slice(0, 3000), rule: plain ? `${prefix} …` : 'this exact command', noteId: note.id };
} else {
  const server = String(input.mcp_server_name || '');
  const tool = String(input.tool_name || '');
  if (/retoucher/.test(server)) decide('allow');
  const note = await noteInPanel();
  if (!note) decide('ask');
  key = `${server}:${tool}`;
  if (always().includes(key)) decide('allow');
  let detail = '';
  try { detail = JSON.stringify(typeof input.tool_input === 'string' ? JSON.parse(input.tool_input) : input.tool_input, null, 2).slice(0, 3000); } catch { detail = String(input.tool_input || '').slice(0, 3000); }
  const TITLES = { use_figma: 'Edit the Figma file', upload_assets: 'Upload images to Figma', get_screenshot: 'Take a Figma screenshot', get_metadata: 'Read the Figma file', generate_image: 'Generate an image' };
  ask = { kind: 'permission', title: TITLES[tool] || `Use ${tool.replace(/_/g, ' ')}`, sub: server, detail, rule: key, noteId: note.id };
}

const p = await askPanel(ask, WAIT_MS);
if (!p) decide('ask');
if (p.decision === 'always') {
  try { fs.writeFileSync(ALWAYS, JSON.stringify([...new Set([...always(), key])], null, 2)); } catch {}
  decide('allow');
}
if (p.decision === 'once') decide('allow');
decide('deny', 'The designer declined this in the Figma panel. Do not retry it; say in the note what you could not do, or ask with ask_in_note.');
