#!/usr/bin/env node
// Claude Code PermissionRequest hook (hooks/hooks.json): asks the question in the Figma panel instead of the terminal,
// only while the panel is open and Claude is working on a note; otherwise, or after WAIT_MS without an answer, it
// prints nothing and Claude Code asks in the terminal as usual. The designer decides every request, except plain
// `fa …` calls (the plugin's own CLI, which only talks to the local bridge), which are allowed without asking.
import { readStdin, noteInPanel, askPanel } from './hook-lib.mjs';
const WAIT_MS = 110_000; // keep under the hook's timeout in hooks.json

const out = decision => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })); process.exit(0); };
const passThrough = () => process.exit(0); // no decision: the terminal asks

// what the designer sees: a plain title, a line of context, and the raw detail behind a toggle
const MCP_TITLES = {
  use_figma: 'Edit the Figma file', get_screenshot: 'Take a Figma screenshot', get_metadata: 'Read the Figma file',
  get_design_context: 'Read the Figma file', get_variable_defs: 'Read Figma variables', upload_assets: 'Upload images to Figma',
  search_design_system: 'Search the design system', generate_image: 'Generate an image', whoami: 'Check the Figma account',
  search_screens: 'Search Mobbin screens', search_flows: 'Search Mobbin flows', search_sections: 'Search Mobbin sections',
};
function describe(tool, input = {}) {
  const json = s => JSON.stringify(s, null, 2);
  if (tool === 'Bash') return { title: 'Run a command', sub: input.description || '', detail: input.command || '' };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return { title: tool === 'Write' ? 'Write a file' : 'Edit a file', sub: input.file_path || input.notebook_path || '', detail: json(input).slice(0, 3000) };
  if (tool === 'Read') return { title: 'Read a file', sub: input.file_path || '', detail: '' };
  if (tool === 'WebFetch') return { title: 'Open a web page', sub: input.url || '', detail: input.prompt || '' };
  if (tool === 'WebSearch') return { title: 'Search the web', sub: input.query || '', detail: '' };
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (m) return { title: MCP_TITLES[m[2]] || `Use ${m[2].replace(/_/g, ' ')}`, sub: input.description || input.query || '', detail: json(input).slice(0, 3000) };
  return { title: `Use ${tool}`, sub: input.description || '', detail: json(input).slice(0, 3000) };
}

// "Always allow" saves what the terminal would offer as "don't ask again"
function alwaysRule(tool, suggestions) {
  const rules = (suggestions || []).filter(s => s.type === 'addRules' && s.behavior === 'allow');
  const updates = rules.length ? rules : [{ type: 'addRules', rules: [{ toolName: tool }], behavior: 'allow', destination: 'localSettings' }];
  const label = updates.flatMap(u => u.rules.map(r => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
  return { updates, label };
}

// The plugin's own `fa` command only talks to the local bridge, so a plain `fa …` call is allowed without asking.
// Plain means one command: no ; & | < > or backticks, and no $( or ${ outside single quotes.
function plainFa(cmd) {
  if (!/^fa(\s|$)/.test(cmd)) return false;
  let q = null; // the quote we are inside: ' " or $' (ANSI-C)
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], next = cmd[i + 1];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === "$'") { if (c === '\\') i++; else if (c === "'") q = null; continue; }
    if (q === '"') {
      if (c === '\\') { i++; continue; }
      if (c === '"') q = null;
      else if (c === '`' || (c === '$' && (next === '(' || next === '{'))) return false;
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '$' && next === "'") { q = "$'"; i++; continue; }
    if (';&|<>`\n\r'.includes(c) || c === '$') return false;
  }
  return q === null;
}

const input = JSON.parse((await readStdin()) || '{}');
const tool = input.tool_name || '';
// Claude Code sends the command as a string; Codex may send an argv array such as ["bash", "-lc", "fa list"]
const cmd = input.tool_input?.command;
const cmdText = Array.isArray(cmd) ? String(cmd.at(-1) ?? '') : String(cmd || '');
if (tool === 'Bash' && plainFa(cmdText.trim())) out({ behavior: 'allow' });
// questions and plan approval go through ask-hook.mjs (PreToolUse), which can pass the answers on
if (!tool || tool === 'AskUserQuestion' || tool === 'ExitPlanMode') passThrough();

const note = await noteInPanel();
if (!note) passThrough();
const { updates, label } = alwaysRule(tool, input.permission_suggestions);
const p = await askPanel({ kind: 'permission', ...describe(tool, input.tool_input), rule: label, noteId: note.id }, WAIT_MS);
if (!p) passThrough();
if (p.decision === 'once') out({ behavior: 'allow' });
if (p.decision === 'always') out({ behavior: 'allow', updatedPermissions: updates });
out({ behavior: 'deny', message: 'The designer declined this in the Figma panel. Do not retry it; say in the note what you could not do, or ask with fa ask.' });
