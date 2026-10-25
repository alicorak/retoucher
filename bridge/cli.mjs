#!/usr/bin/env node
// CLI used by Claude Code to read and answer annotations from the Figma plugin.
//   retoucher list [status]            open items (default: pending)
//   retoucher show <id>                full detail incl. screenshot path + Figma URL
//   retoucher claim <id>               mark as working (plugin shows "Claude is working")
//   retoucher done <id> "message"      reply and mark done
//   retoucher ask <id> "question"      reply and mark as needing the user's answer
//   retoucher say <id> "message"       reply without changing status
//                               (done/ask/say/edit take --images <json-file>: [{"path","link","caption"}] shown with the message)
//   retoucher edit <id> "message"      rewrite Claude's last reply on the note
//   retoucher step <id> "what now"     live progress line shown under "Working" in the plugin
//   retoucher plan <id> "plan"         show a plan for the designer to approve (Approve / Change), and wait
//   retoucher fonts <id> [query]       fonts installed on the designer's computer, as Figma sees them (run by the panel)
//   retoucher text <id> <json-file>    change text in Figma through the panel, local fonts included; Undo is recorded
//   retoucher models '<json>'          tell the panel which models this session can hand a note to: [{"id","name"}]
//   retoucher skills '<json>'          tell the panel which skills this session has: [{"name","description"}]
//   retoucher snapshot <id> before|after <png>   store a before/after screenshot (shown in the plugin)
//   retoucher patch <id> <json-file>   store the revert patch so the plugin can Undo (see CLAUDE.md)
//   retoucher focus <id> <json-file>   layers to select in Figma (JSON array of node ids); the plugin shows a Select button
//   retoucher comments <fileKey|id> [--all]   Figma comment threads of the file (open ones unless --all); needs a token
//   retoucher unpair                   forget the paired Figma panel, so another one can pair
//   retoucher watch                    print one line per new note, follow-up or message while working (for Monitor)
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

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function readImages(file) {
  if (!file) throw new Error('--images needs a JSON file: [{ "path", "link", "caption" }]');
  return JSON.parse(fs.readFileSync(file, 'utf8')).map(im => ({
    mime: MIME[String(im.path).split('.').pop().toLowerCase()] || 'image/png',
    data: fs.readFileSync(im.path).toString('base64'), link: im.link, caption: im.caption,
  }));
}

// jobs run by the Figma panel (it can load local fonts); wait for its answer
async function runJob(id, kind, payload) {
  const job = await api(`/annotations/${id}/job`, { method: 'POST', body: { kind, payload } });
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const it = await api(`/annotations/${id}`);
    if (it.job?.id === job.id && it.job.status === 'done') return it.job.result;
  }
  await api(`/annotations/${id}/job/${job.id}`, { method: 'POST', body: { expire: true } }).catch(() => {});
  const it = await api(`/annotations/${id}`).catch(() => ({}));
  throw new Error(`the Figma panel didn't run this. It has to be open in "${it.fileName || 'the note\'s file'}" (these changes run inside Figma, where the local fonts are). Ask the designer to open it, then try again.`);
}

const oneLine = s => String(s).replace(/\s+/g, ' ').slice(0, 140);
const batchLabel = it => (it.batchId ? ` [batch ${it.batchId}${it.batchMode === 'parallel' ? ', parallel' : ''}]` : '')
  + (it.attachments?.length ? ` [+${it.attachments.length} file${it.attachments.length > 1 ? 's' : ''}]` : '')
  + (it.variations > 1 ? ` [${it.variations} variations]` : '')
  + (it.mentions?.length ? ` [@ ${it.mentions.map(m => m.name).join(', ')}]` : '')
  + (it.library ? ` [library ${it.library}]` : '')
  + (it.useComments ? ` [comments: ${it.useComments === 'summarize' ? 'summarize' : 'apply'}]` : '')
  + (it.model ? ` [model ${it.modelName || it.model} (id ${it.model})]` : '') + (it.planFirst ? ' [plan first]' : '') + (it.skill ? ` [skill ${it.skill}]` : '')
  + (it.references ? ` [references: ${it.references.count} from Mobbin]` : '');
const nodesLabel = it => it.scope === 'file' ? `whole file "${it.fileName || '?'}"` : it.nodes.map(n => n.region ? `area ${n.w}×${n.h} in "${n.region.frameName || 'page'}"` : `${n.name} (${n.id})`).join(', ') || `whole page "${it.pageName || '?'}"`;

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
      if (!['before', 'after'].includes(kind) || !file) throw new Error('usage: retoucher snapshot <id> before|after <png>');
      await api(`/annotations/${a}/snapshot`, { method: 'POST', body: { kind, image: fs.readFileSync(file).toString('base64') } });
      return console.log(`#${a} ${kind} snapshot saved`);
    }
    case 'patch': {
      const file = rest[0];
      if (!file) throw new Error('usage: retoucher patch <id> <json-file>');
      await api(`/annotations/${a}/patch`, { method: 'POST', body: { patch: JSON.parse(fs.readFileSync(file, 'utf8')) } });
      return console.log(`#${a} revert patch saved`);
    }
    case 'focus': {
      const file = rest[0];
      if (!file) throw new Error('usage: retoucher focus <id> <json-file>');
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
    case 'say':
    case 'edit': {
      // optional pictures shown with the message: --images <json-file> of [{ "path", "link"?, "caption"? }]
      const at = rest.indexOf('--images');
      const images = at >= 0 ? readImages(rest.splice(at, 2)[1]) : undefined;
      const text = rest.join(' ');
      if (!text) throw new Error('message required');
      const status = cmd === 'done' ? 'done' : cmd === 'ask' ? 'question' : undefined;
      await api(`/annotations/${a}/messages`, { method: 'POST', body: { from: 'claude', text, status, replaceLast: cmd === 'edit', images } });
      return console.log(`#${a} ${cmd === 'edit' ? 'reply rewritten' : status || 'replied'}`);
    }
    case 'plan': {
      const text = rest.join(' ');
      if (!text) throw new Error('usage: retoucher plan <id> "the plan, in markdown"');
      await api(`/annotations/${a}/messages`, { method: 'POST', body: { from: 'claude', text, status: 'question', kind: 'plan' } });
      return console.log(`#${a} plan shown, waiting for approval`);
    }
    case 'fonts': {
      const r = await runJob(a, 'fonts', { query: rest.join(' ') });
      if (r.error) throw new Error(r.error);
      if (!r.fonts.length) return console.log('(no matching fonts on the designer\'s computer)');
      for (const f of r.fonts) console.log(`${f.family}: ${f.styles.join(', ')}`);
      return;
    }
    case 'text': {
      const src = rest.join(' ');
      if (!src) throw new Error('usage: retoucher text <id> <json-file>  (an array of ops, see the skill)');
      const json = JSON.parse(fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : src);
      const r = await runJob(a, 'text', { ops: Array.isArray(json) ? json : json.ops });
      if (r.error) throw new Error(r.error);
      console.log(`#${a} changed ${r.changedLayers} text layer${r.changedLayers === 1 ? '' : 's'} (${r.changedRanges} ranges); Undo recorded`);
      for (const k of r.skipped || []) console.log(`  skipped ${k.name ? `${k.name} (${k.id})` : k.id || k.op}: ${k.reason}`);
      return;
    }
    case 'models': {
      if (!a) throw new Error(`usage: retoucher models '[{"id":"opus","name":"Claude Opus 5.5"}]'`);
      const r = await api('/models', { method: 'POST', body: { models: JSON.parse([a, ...rest].join(' ')) } });
      return console.log(`${r.count} models offered in the panel`);
    }
    case 'skills': {
      if (!a) throw new Error(`usage: retoucher skills '[{"name":"…","description":"…"}]'`);
      const skills = JSON.parse([a, ...rest].join(' '));
      const r = await api('/skills', { method: 'POST', body: { skills } });
      return console.log(`${r.count} skills offered in the panel`);
    }
    case 'step': {
      const text = rest.join(' ');
      if (!text) throw new Error('usage: retoucher step <id> "what you are doing"');
      await api(`/annotations/${a}/progress`, { method: 'POST', body: { text } });
      return console.log(`#${a} step: ${oneLine(text)}`);
    }
    case 'unpair':
      await api('/unpair', { method: 'POST' });
      return console.log('Pairing reset. The next Figma panel that opens pairs with this bridge.');
    case 'comments': {
      if (!a) throw new Error('usage: retoucher comments <fileKey|note id> [--all]');
      const key = /^\d+$/.test(a) ? (await api(`/annotations/${a}`)).fileKey : a;
      const threads = await api(`/comments/${key}${rest.includes('--all') ? '' : '?open=1'}`);
      if (!threads.length) return console.log('(no comments)');
      for (const t of threads) {
        console.log(`thread ${t.id}${t.nodeId ? ` on ${t.nodeId}` : ''}${t.resolved ? ' [resolved]' : ''}`);
        for (const m of t.messages) console.log(`  ${m.who}: ${oneLine(m.text)}`);
      }
      return;
    }
    case 'watch': {
      const seen = new Map(); // id -> updatedAt already announced
      // tell the bridge someone is listening, so the panel can say "Claude ready"
      const beat = () => fetch(BASE + '/presence', { method: 'POST' }).catch(() => {});
      beat(); setInterval(beat, 4000);
      // Announce only what arrives after start, plus anything already pending once.
      for (;;) {
        try {
          const items = await api('/annotations?status=pending&unread=1');
          for (const it of items) {
            if (seen.get(it.id) === it.updatedAt) continue;
            seen.set(it.id, it.updatedAt);
            const followup = it.thread.at(-1)?.from === 'user' ? (it.status === 'working' ? ' (message while working)' : ' (follow-up)') : '';
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
      console.log('usage: retoucher list|show|claim|snapshot|patch|focus|done|ask|say|edit|step|plan|fonts|text|models|skills|comments|unpair|watch');
  }
}

main().catch(e => { console.error('error:', e.message); process.exit(1); });
