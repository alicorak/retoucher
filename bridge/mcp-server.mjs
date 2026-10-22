#!/usr/bin/env node
// MCP server (stdio) for agents other than Claude Code (Codex, Cursor, …): the same note tools as the `fa` CLI,
// plus wait_for_note (a long poll, instead of a background monitor) and ask_designer (questions shown in the
// Figma panel). Zero dependencies: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr only.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = `http://localhost:${process.env.FA_PORT || 4747}`;
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8')).version; } catch { return 'dev'; } })();
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `bridge ${r.status}`);
  return j;
}

// the bridge is shared by every agent; start it if nobody has (ensure-bridge.mjs knows how)
const ensureBridge = () => new Promise(resolve => {
  const legacy = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || '';
  const p = spawn(process.execPath, [path.join(ROOT, 'bridge', 'ensure-bridge.mjs'), ...(legacy ? [legacy] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', c => (out += c));
  p.on('exit', () => { if (out.trim()) log(out.trim()); resolve(); });
});
const bridgeReady = ensureBridge();

// ---------- watching: one line per new note, follow-up or message, like `fa watch` ----------
const seen = new Map();
let watchingUntil = 0;
setInterval(() => { if (Date.now() < watchingUntil) fetch(BASE + '/presence', { method: 'POST' }).catch(() => {}); }, 4000).unref();
const noteLine = it => {
  const last = it.thread.at(-1);
  const fromUser = last?.from === 'user';
  const kind = fromUser ? (it.status === 'working' ? ' (message while working)' : ' (follow-up)') : '';
  const opts = [it.scope === 'file' ? 'whole file' : '', it.variations > 1 ? `${it.variations} versions` : '', it.useComments ? `comments: ${it.useComments}` : '',
    it.model ? `model ${it.model}` : '', it.planFirst ? 'plan first' : '', it.skill ? `skill ${it.skill}` : '', it.priority === 'urgent' ? 'urgent' : ''].filter(Boolean).join(', ');
  const where = it.scope === 'file' ? 'whole file' : it.nodes.length ? it.nodes.map(n => n.region ? `area in "${n.region.frameName || 'page'}"` : `${n.name} (${n.id})`).join(', ') : `page "${it.pageName || '?'}"`;
  return `#${it.id}${kind}${opts ? ` [${opts}]` : ''}: ${(fromUser ? last.text : it.note).replace(/\s+/g, ' ').slice(0, 300)} — ${where}`;
};
async function newNotes() {
  const items = await api('/annotations?status=pending&unread=1');
  const fresh = items.filter(it => seen.get(it.id) !== it.updatedAt);
  for (const it of fresh) seen.set(it.id, it.updatedAt);
  return fresh;
}

// ---------- tools ----------
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const id = { type: 'string', description: 'Note id, e.g. "15"' };
const text = d => ({ type: 'string', description: d });
const TOOLS = [
  { name: 'wait_for_note', description: 'Wait for the next note, follow-up or message from the Figma panel. Returns as soon as something arrives, or after timeout_sec with "nothing yet": then call it again. While you call it, the panel shows "Claude ready". Notes already waiting are returned on the first call.',
    inputSchema: S({ timeout_sec: { type: 'number', description: 'How long to wait (default 45; keep under your client\'s tool timeout)' } }),
    run: async a => {
      const until = Date.now() + Math.max(1, Math.min(Number(a.timeout_sec) || 45, 3600)) * 1000;
      for (;;) {
        watchingUntil = Date.now() + 90000;
        fetch(BASE + '/presence', { method: 'POST' }).catch(() => {});
        const fresh = await newNotes().catch(() => []);
        if (fresh.length) return fresh.map(noteLine).join('\n') + '\n\nHandle each with the handle-figma-notes skill (claim_note, show_note, …).';
        if (Date.now() > until) return 'nothing yet: call wait_for_note again';
        await sleep(1500);
      }
    } },
  { name: 'list_notes', description: 'Notes by status (pending, working, question, done; comma-separated).', inputSchema: S({ status: text('Default "pending"') }),
    run: async a => { const items = await api(`/annotations?status=${encodeURIComponent(a.status || 'pending')}`); return items.length ? items.map(noteLine).join('\n') : '(none)'; } },
  { name: 'show_note', description: 'Everything about a note: text, targets with screenshot paths, areas, attachments, options, thread, file key, Figma URL.', inputSchema: S({ id }, ['id']),
    run: async a => JSON.stringify(await api(`/annotations/${a.id}`), null, 2) },
  { name: 'claim_note', description: 'Mark a note as being worked on (the panel shows "Working").', inputSchema: S({ id }, ['id']),
    run: async a => { await api(`/annotations/${a.id}`, { method: 'PATCH', body: { status: 'working' } }); return `#${a.id} working`; } },
  { name: 'add_step', description: 'Show what you are doing now under "Working" in the panel. Short, in the designer\'s words.', inputSchema: S({ id, text: text('e.g. "Placing 5 of 12"') }, ['id', 'text']),
    run: async a => { await api(`/annotations/${a.id}/progress`, { method: 'POST', body: { text: a.text } }); return 'ok'; } },
  { name: 'finish_note', description: 'Reply and mark the note done. Markdown: short first line, a few "- " bullets, [name](url) links.', inputSchema: S({ id, text: text('The reply') }, ['id', 'text']),
    run: async a => { await api(`/annotations/${a.id}/messages`, { method: 'POST', body: { from: 'claude', text: a.text, status: 'done' } }); return `#${a.id} done`; } },
  { name: 'ask_in_note', description: 'Ask the designer an open question in the note and stop; the answer arrives later as a follow-up (wait_for_note).', inputSchema: S({ id, text: text('The question') }, ['id', 'text']),
    run: async a => { await api(`/annotations/${a.id}/messages`, { method: 'POST', body: { from: 'claude', text: a.text, status: 'question' } }); return `#${a.id} waiting for the designer`; } },
  { name: 'propose_plan', description: 'Show a plan with Approve plan / Change something buttons and stop; approval or changes arrive as a follow-up.', inputSchema: S({ id, text: text('The plan, numbered, in markdown') }, ['id', 'text']),
    run: async a => { await api(`/annotations/${a.id}/messages`, { method: 'POST', body: { from: 'claude', text: a.text, status: 'question', kind: 'plan' } }); return `#${a.id} plan shown`; } },
  { name: 'send_message', description: 'Write in the note without changing its status.', inputSchema: S({ id, text: text('The message') }, ['id', 'text']),
    run: async a => { await api(`/annotations/${a.id}/messages`, { method: 'POST', body: { from: 'claude', text: a.text } }); return 'ok'; } },
  { name: 'rewrite_reply', description: 'Replace your last reply on the note.', inputSchema: S({ id, text: text('The new reply') }, ['id', 'text']),
    run: async a => { await api(`/annotations/${a.id}/messages`, { method: 'POST', body: { from: 'claude', text: a.text, replaceLast: true } }); return 'ok'; } },
  { name: 'ask_designer', description: 'Ask 1–4 multiple-choice questions as a card in the Figma panel and wait for the answers (the designer can also write their own). If they don\'t answer within wait_sec, returns a prompt_id: call check_answer with it.',
    inputSchema: S({ id, questions: { type: 'array', minItems: 1, maxItems: 4, items: S({ question: { type: 'string' }, header: { type: 'string' }, multiSelect: { type: 'boolean' },
      options: { type: 'array', items: S({ label: { type: 'string' }, description: { type: 'string' } }, ['label']) } }, ['question', 'options']) },
      wait_sec: { type: 'number', description: 'Default 45' } }, ['id', 'questions']),
    run: async a => { const p = await api('/permissions', { method: 'POST', body: { kind: 'question', title: 'Claude has a question', questions: a.questions, noteId: String(a.id) } }); return waitAnswer(p.id, a.wait_sec); } },
  { name: 'check_answer', description: 'Wait for the answer to an ask_designer card.', inputSchema: S({ prompt_id: { type: 'string' }, wait_sec: { type: 'number' } }, ['prompt_id']),
    run: async a => waitAnswer(a.prompt_id, a.wait_sec) },
  { name: 'save_snapshot', description: 'Store a before or after screenshot (PNG file path) shown in the panel.', inputSchema: S({ id, kind: { type: 'string', enum: ['before', 'after'] }, png_path: { type: 'string' } }, ['id', 'kind', 'png_path']),
    run: async a => { await api(`/annotations/${a.id}/snapshot`, { method: 'POST', body: { kind: a.kind, image: fs.readFileSync(a.png_path).toString('base64') } }); return `${a.kind} saved`; } },
  { name: 'save_undo_patch', description: 'Store the revert patch behind the panel\'s Undo button: { set, remove, move, swap, bind, variables } (see the skill).', inputSchema: S({ id, patch: { type: 'object' } }, ['id', 'patch']),
    run: async a => { await api(`/annotations/${a.id}/patch`, { method: 'POST', body: { patch: a.patch } }); return 'undo saved'; } },
  { name: 'focus_layers', description: 'Layers the panel offers to select ("Select N layers").', inputSchema: S({ id, ids: { type: 'array', items: { type: 'string' } } }, ['id', 'ids']),
    run: async a => { await api(`/annotations/${a.id}`, { method: 'PATCH', body: { focus: a.ids } }); return 'ok'; } },
  { name: 'figma_comments', description: 'Open Figma comment threads of the note\'s file (needs a token, set in the panel).', inputSchema: S({ id, all: { type: 'boolean', description: 'Include resolved threads' } }, ['id']),
    run: async a => { const it = await api(`/annotations/${a.id}`); return JSON.stringify(await api(`/comments/${it.fileKey}${a.all ? '' : '?open=1'}`), null, 2); } },
  { name: 'offer_skills', description: 'Tell the panel which skills you have, so the designer can pick one per note.', inputSchema: S({ skills: { type: 'array', items: S({ name: { type: 'string' }, description: { type: 'string' } }, ['name']) } }, ['skills']),
    run: async a => { const r = await api('/skills', { method: 'POST', body: { skills: a.skills } }); return `${r.count} skills offered`; } },
];

async function waitAnswer(promptId, waitSec) {
  const until = Date.now() + Math.max(1, Math.min(Number(waitSec) || 45, 3600)) * 1000;
  while (Date.now() < until) {
    const p = await api(`/permissions/${promptId}`).catch(() => null);
    if (!p) return 'that question is gone (expired or answered elsewhere)';
    if (p.status === 'answered') return p.decision === 'skip' ? 'The designer skipped the questions: decide with the most sensible default and say which in the note.' : JSON.stringify({ answers: p.answers }, null, 2);
    await sleep(1000);
  }
  return `no answer yet: call check_answer with prompt_id "${promptId}"`;
}

// ---------- JSON-RPC over stdio ----------
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
async function handle(msg) {
  const { id: rid, method, params = {} } = msg;
  if (rid === undefined) return; // notifications
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id: rid, result: {
      protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'figma-annotate', version: VERSION },
      instructions: 'Notes from the Annotate for Claude Figma panel. Watch with wait_for_note in a loop; handle each note with the handle-figma-notes skill.' } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id: rid, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id: rid, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return send({ jsonrpc: '2.0', id: rid, error: { code: -32602, message: `unknown tool ${params.name}` } });
      await bridgeReady;
      try {
        const out = await tool.run(params.arguments || {});
        return send({ jsonrpc: '2.0', id: rid, result: { content: [{ type: 'text', text: String(out) }] } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id: rid, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } });
      }
    }
    send({ jsonrpc: '2.0', id: rid, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id: rid, error: { code: -32603, message: String(e.message || e) } });
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
