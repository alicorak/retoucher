#!/usr/bin/env node
// CLI used by Claude Code to read and answer annotations from the Figma plugin.
//   fa list [status]            open items (default: pending)
//   fa show <id>                full detail incl. screenshot path + Figma URL
//   fa claim <id>               mark as working (plugin shows "Claude is working")
//   fa done <id> "message"      reply and mark done
//   fa ask <id> "question"      reply and mark as needing the user's answer
//   fa say <id> "message"       reply without changing status
//   fa snapshot <id> before|after <png>   store a before/after screenshot (shown in the plugin)
//   fa patch <id> <json-file>   store the revert patch so the plugin can Undo (see CLAUDE.md)
//   fa focus <id> <json-file>   layers to select in Figma (JSON array of node ids); the plugin shows a Select button
//   fa watch                    print one line per new/updated pending item (for Monitor)
import fs from 'node:fs';
const BASE = `http://localhost:${process.env.FA_PORT || 4747}`;

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const oneLine = s => String(s).replace(/\s+/g, ' ').slice(0, 140);
const batchLabel = it => (it.batchId ? ` [batch ${it.batchId}]` : '') + (it.attachments?.length ? ` [+${it.attachments.length} file${it.attachments.length > 1 ? 's' : ''}]` : '');
const nodesLabel = it => it.nodes.map(n => n.region ? `area ${n.w}×${n.h} in "${n.region.frameName || 'page'}"` : `${n.name} (${n.id})`).join(', ') || 'no selection';

async function main() {
  const [cmd, a, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list': {
      const items = await api(`/annotations?status=${a || 'pending'}`);
      if (!items.length) return console.log('(none)');
      for (const it of items) console.log(`#${it.id} [${it.status}]${batchLabel(it)} ${it.intent}/${it.priority} — ${oneLine(it.note)} — ${nodesLabel(it)}`);
      return;
    }
    case 'show': {
      const it = await api(`/annotations/${a}`);
      console.log(JSON.stringify(it, null, 2));
      return;
    }
    case 'snapshot': {
      const [kind, file] = rest.length ? [rest[0], rest[1]] : [];
      if (!['before', 'after'].includes(kind) || !file) throw new Error('usage: fa snapshot <id> before|after <png>');
      await api(`/annotations/${a}/snapshot`, { method: 'POST', body: { kind, image: fs.readFileSync(file).toString('base64') } });
      return console.log(`#${a} ${kind} snapshot saved`);
    }
    case 'patch': {
      const file = rest[0];
      if (!file) throw new Error('usage: fa patch <id> <json-file>');
      await api(`/annotations/${a}/patch`, { method: 'POST', body: { patch: JSON.parse(fs.readFileSync(file, 'utf8')) } });
      return console.log(`#${a} revert patch saved`);
    }
    case 'focus': {
      const file = rest[0];
      if (!file) throw new Error('usage: fa focus <id> <json-file>');
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ids = Array.isArray(j) ? j : j.ids;
      await api(`/annotations/${a}`, { method: 'PATCH', body: { focus: ids } });
      return console.log(`#${a} focus ${ids.length} layers`);
    }
    case 'claim':
      await api(`/annotations/${a}`, { method: 'PATCH', body: { status: 'working' } });
      return console.log(`#${a} working`);
    case 'done':
    case 'ask':
    case 'say': {
      const text = rest.join(' ');
      if (!text) throw new Error('message required');
      const status = cmd === 'done' ? 'done' : cmd === 'ask' ? 'question' : undefined;
      await api(`/annotations/${a}/messages`, { method: 'POST', body: { from: 'claude', text, status } });
      return console.log(`#${a} ${status || 'replied'}`);
    }
    case 'watch': {
      const seen = new Map(); // id -> updatedAt already announced
      // Announce only what arrives after start, plus anything already pending once.
      for (;;) {
        try {
          const items = await api('/annotations?status=pending');
          for (const it of items) {
            if (seen.get(it.id) === it.updatedAt) continue;
            seen.set(it.id, it.updatedAt);
            const followup = it.thread.at(-1)?.from === 'user' ? ' (follow-up)' : '';
            console.log(`NEW #${it.id}${followup}${batchLabel(it)} ${it.intent}/${it.priority}:${oneLine(it.thread.at(-1)?.from === 'user' ? it.thread.at(-1).text : it.note)} — ${nodesLabel(it)}`);
          }
        } catch (e) {
          if (!seen.has('__down')) { console.log('bridge unreachable, retrying'); seen.set('__down', 1); }
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        seen.delete('__down');
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    default:
      console.log('usage: fa list|show|claim|snapshot|patch|focus|done|ask|say|watch');
  }
}

main().catch(e => { console.error('error:', e.message); process.exit(1); });
