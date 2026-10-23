// Local bridge between the Figma plugin and Claude Code. Zero dependencies.
// Plugin  --POST /annotations-->  bridge  <--CLI (fa.mjs)--  Claude Code
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// installed as a Claude Code plugin, notes live in the plugin's data folder (FA_DATA), which survives updates
const DATA = process.env.FA_DATA ? path.resolve(process.env.FA_DATA) : path.join(ROOT, 'data');
const VERSION = (() => {
  for (const f of ['plugin.json', path.join('.claude-plugin', 'plugin.json')]) {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version; } catch {}
  }
  return 'dev';
})();
const IMAGES = path.join(DATA, 'images');
const DB = path.join(DATA, 'annotations.json');
const PORT = Number(process.env.FA_PORT || 4747);

fs.mkdirSync(IMAGES, { recursive: true });

let db = { seq: 0, items: [] };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}

function save() {
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB);
}

// Pairing: the first Figma panel that connects stores a random key here; after that, every request that comes
// from a page (it has an Origin header, as the panel's does) must carry it. Websites open in a browser can reach
// localhost too, and must not read notes, post notes or answer permission prompts. Local processes (Claude Code,
// the hook, fa) send no Origin and need no key.
const PAIR = path.join(DATA, 'pair.json');
const pairKey = () => { try { return JSON.parse(fs.readFileSync(PAIR, 'utf8')).key || null; } catch { return null; } };
const fromPage = req => req.headers.origin !== undefined;
const keyOk = req => { const k = pairKey(); return !!k && req.headers['x-annotate-key'] === k; };

const STATUSES = ['pending', 'working', 'question', 'done'];
// `fa watch` checks in every few seconds; the panel shows "Claude ready" only while it does
let presence = { at: 0 };
const LISTENING_MS = 12000;
const listening = () => Date.now() - presence.at < LISTENING_MS;
// the panel asks /health?panel=1 every couple of seconds; permission prompts go to it only while it is open
let panel = { at: 0 };
const panelOpen = () => Date.now() - panel.at < 8000;
// Claude Code permission prompts (from bridge/permission-hook.mjs), answered in the panel. Memory only.
const perms = new Map();
let permSeq = 0;
// kind: 'permission' (allow/deny a tool), 'question' (Claude's multiple-choice questions), 'plan' (approve a plan)
const publicPerm = p => ({ id: p.id, kind: p.kind, status: p.status, decision: p.decision, answers: p.answers, feedback: p.feedback,
  title: p.title, sub: p.sub, detail: p.detail, rule: p.rule, questions: p.questions, plan: p.plan, noteId: p.noteId, createdAt: p.createdAt });
const DECISIONS = { permission: ['once', 'always', 'deny'], question: ['answer', 'skip'], plan: ['approve', 'revise'] };
const cleanQuestions = qs => (Array.isArray(qs) ? qs : []).slice(0, 4).map(q => ({
  question: String(q?.question ?? '').slice(0, 500), header: String(q?.header ?? '').slice(0, 40), multiSelect: !!q?.multiSelect,
  options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map(o => ({ label: String(o?.label ?? '').slice(0, 120), description: String(o?.description ?? '').slice(0, 400) })),
})).filter(q => q.question);
const PATCH_KEYS = ['set', 'remove', 'move', 'swap', 'bind', 'variables', 'text'];

// Figma REST token for reading comments: FIGMA_TOKEN, or { "figmaToken": "..." } in data/config.json
function figmaToken() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN;
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).figmaToken || null; } catch { return null; }
}

// Comments of a file as threads: { id, nodeId, resolved, messages: [{ who, text, at }] }
async function fileComments(fileKey) {
  const token = figmaToken();
  if (!token) throw Object.assign(new Error('no Figma token: set FIGMA_TOKEN or data/config.json { "figmaToken": "..." }'), { code: 412 });
  const r = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/comments`, { headers: { 'X-Figma-Token': token } });
  if (!r.ok) throw Object.assign(new Error(`Figma API ${r.status}: ${(await r.text()).slice(0, 200)}`), { code: 502 });
  const { comments = [] } = await r.json();
  const threads = new Map();
  for (const c of comments.filter(c => !c.parent_id)) {
    threads.set(c.id, { id: c.id, nodeId: c.client_meta?.node_id || null, resolved: !!c.resolved_at, messages: [] });
  }
  for (const c of comments.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const t = threads.get(c.parent_id || c.id);
    if (t) t.messages.push({ who: c.user?.handle || 'someone', text: c.message, at: c.created_at });
  }
  return [...threads.values()];
}
const now = () => new Date().toISOString();

function publicItem(it) {
  const { imageFile, attachments = [], ...rest } = it;
  return {
    ...rest,
    attachments: attachments.map(a => ({ n: a.n, name: a.name, mime: a.mime, size: a.size || null, path: path.join(IMAGES, a.file) })),
    // every target (layer or area) with its own screenshot, if it has one
    nodes: (it.nodes || []).map((n, i) => ({ ...n, imagePath: n.hasImage ? path.join(IMAGES, `${it.id}-t${i + 1}.png`) : null })),
    imagePath: imageFile ? path.join(IMAGES, imageFile) : null,
    hasBefore: fs.existsSync(path.join(IMAGES, `${it.id}-before.png`)),
    hasAfter: fs.existsSync(path.join(IMAGES, `${it.id}-after.png`)),
  };
}

function figmaUrl(it) {
  if (!it.fileKey || !it.nodes?.length) return null;
  // areas have no layer of their own: link to the screen they sit in
  const first = it.nodes.find(n => n.type !== 'AREA') || it.nodes.find(n => n.region?.frameId);
  const realId = first && (first.type === 'AREA' ? first.region.frameId : first.id);
  if (!realId) return null;
  const id = realId.replace(':', '-');
  return `https://www.figma.com/design/${it.fileKey}/${encodeURIComponent(it.fileName || 'file')}?node-id=${id}`;
}

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Annotate-Key',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 120 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function find(id) { return db.items.find(i => i.id === String(id)); }

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    // Chrome asks before a page on the internet (figma.com in a browser) may call localhost; the pairing key still guards every call
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    return send(res, 204, {});
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (url.pathname === '/health') {
      const paired = keyOk(req);
      if (url.searchParams.get('panel') === '1' && paired) panel = { at: Date.now() };
      // a page only learns whether it is paired; the rest is for the panel and local tools
      if (fromPage(req) && !paired) return send(res, 200, { ok: true, paired: false, canPair: !pairKey(), version: VERSION });
      return send(res, 200, { ok: true, paired, version: VERSION, count: db.items.length, comments: !!figmaToken(), claude: listening(), panel: panelOpen(), root: ROOT });
    }

    // the panel offers its key once; only the first one is kept (fa unpair resets it)
    if (req.method === 'POST' && url.pathname === '/pair') {
      const b = await readBody(req);
      const key = String(b.key || '');
      if (!/^[A-Za-z0-9-]{20,80}$/.test(key)) return send(res, 400, { error: 'bad key' });
      const current = pairKey();
      if (current && current !== key) return send(res, 409, { error: 'paired with another panel' });
      if (!current) fs.writeFileSync(PAIR, JSON.stringify({ key, at: now() }), { mode: 0o600 });
      return send(res, 200, { ok: true });
    }
    // local-only housekeeping: forget the pairing, or stop (a newer version is starting)
    if (req.method === 'POST' && (url.pathname === '/unpair' || url.pathname === '/quit')) {
      if (fromPage(req)) return send(res, 403, { error: 'local only' });
      if (url.pathname === '/unpair') { fs.rmSync(PAIR, { force: true }); return send(res, 200, { ok: true }); }
      send(res, 200, { ok: true });
      return setTimeout(() => process.exit(0), 50);
    }

    if (fromPage(req) && !keyOk(req)) return send(res, 401, { error: 'not paired' });

    // the Figma token for reading comments, set from the panel (paired) or locally; kept in the data folder only
    if (req.method === 'POST' && url.pathname === '/config') {
      const b = await readBody(req);
      const token = String(b.figmaToken || '').trim();
      if (token && !/^figd_[A-Za-z0-9_-]{10,200}$/.test(token)) return send(res, 400, { error: 'that does not look like a Figma token (figd_…)' });
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch {}
      if (token) cfg.figmaToken = token; else delete cfg.figmaToken;
      fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
      return send(res, 200, { ok: true, comments: !!figmaToken() });
    }

    // skills of the watching Claude Code session (posted by `fa skills`), offered in the panel's Options
    if (url.pathname === '/skills') {
      if (req.method === 'GET') return send(res, 200, db.skills || []);
      if (req.method === 'POST') {
        if (fromPage(req)) return send(res, 403, { error: 'local only' });
        const b = await readBody(req);
        db.skills = (Array.isArray(b.skills) ? b.skills : []).slice(0, 200).filter(k => k && k.name)
          .map(k => ({ name: String(k.name).slice(0, 120), description: String(k.description || '').slice(0, 200) }));
        save();
        return send(res, 200, { ok: true, count: db.skills.length });
      }
    }

    // models the watching session can hand a note to (posted by `fa models`): [{ id, name }], shown in the panel's Options
    if (url.pathname === '/models') {
      if (req.method === 'GET') return send(res, 200, db.models || []);
      if (req.method === 'POST') {
        if (fromPage(req)) return send(res, 403, { error: 'local only' });
        const b = await readBody(req);
        db.models = (Array.isArray(b.models) ? b.models : []).slice(0, 20).filter(m => m && m.id && /^[A-Za-z0-9._:-]{1,60}$/.test(m.id))
          .map(m => ({ id: String(m.id), name: String(m.name || m.id).slice(0, 60) }));
        save();
        return send(res, 200, { ok: true, count: db.models.length });
      }
    }

    // permission prompts: the hook creates one and waits, the panel answers it
    if (parts[0] === 'permissions') {
      for (const [k, p] of perms) if (Date.now() - p.at > 15 * 60 * 1000) perms.delete(k);
      if (req.method === 'GET' && parts.length === 1) {
        const status = url.searchParams.get('status');
        return send(res, 200, [...perms.values()].filter(p => !status || p.status === status).map(publicPerm));
      }
      if (req.method === 'POST' && parts.length === 1) {
        const b = await readBody(req);
        const s = (v, n) => String(v ?? '').slice(0, n);
        const kind = DECISIONS[b.kind] ? b.kind : 'permission';
        const p = { id: String(++permSeq), kind, at: Date.now(), createdAt: now(), status: 'pending', decision: null, answers: null, feedback: null,
          title: s(b.title, 120), sub: s(b.sub, 300), detail: s(b.detail, 4000), rule: s(b.rule, 200), noteId: b.noteId ? s(b.noteId, 12) : null,
          questions: kind === 'question' ? cleanQuestions(b.questions) : null, plan: kind === 'plan' ? s(b.plan, 20000) : null };
        perms.set(p.id, p);
        return send(res, 201, publicPerm(p));
      }
      const p = perms.get(parts[1]);
      if (!p) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET' && parts.length === 2) return send(res, 200, publicPerm(p));
      // the panel's answer: once | always | deny
      if (req.method === 'POST' && parts.length === 2) {
        const b = await readBody(req);
        if (!DECISIONS[p.kind].includes(b.decision)) return send(res, 400, { error: 'decision: ' + DECISIONS[p.kind].join('|') });
        if (p.status !== 'pending') return send(res, 409, { error: 'already ' + p.status });
        // answers: { "<question text>": "<chosen label(s), comma-separated, or free text>" }
        const answers = p.kind === 'question' && b.answers && typeof b.answers === 'object'
          ? Object.fromEntries(p.questions.map(q => [q.question, String(b.answers[q.question] ?? '').slice(0, 2000)])) : null;
        Object.assign(p, { status: 'answered', decision: b.decision, answers, feedback: b.feedback ? String(b.feedback).slice(0, 4000) : null });
        return send(res, 200, publicPerm(p));
      }
      // the hook gave up waiting; the question goes back to the terminal
      if (req.method === 'POST' && parts[2] === 'expire') {
        if (p.status === 'pending') p.status = 'expired';
        return send(res, 200, publicPerm(p));
      }
    }

    if (req.method === 'POST' && url.pathname === '/presence') {
      presence = { at: Date.now() };
      return send(res, 200, { ok: true });
    }

    // Figma comments of a file (needs a token), optionally only open ones
    if (req.method === 'GET' && parts[0] === 'comments' && parts.length === 2) {
      try {
        let threads = await fileComments(parts[1]);
        if (url.searchParams.get('open') === '1') threads = threads.filter(t => !t.resolved);
        return send(res, 200, threads);
      } catch (e) { return send(res, e.code || 500, { error: e.message }); }
    }

    // list
    if (req.method === 'GET' && parts[0] === 'annotations' && parts.length === 1) {
      const status = url.searchParams.get('status');
      const fileKey = url.searchParams.get('fileKey');
      let items = db.items;
      // ?status=pending&unread=1: pending items, plus any item with a user message Claude hasn't seen
      const unread = url.searchParams.get('unread') === '1';
      if (status) items = items.filter(i => status.split(',').includes(i.status) || (unread && i.unread));
      if (fileKey) items = items.filter(i => i.fileKey === fileKey);
      return send(res, 200, items.map(publicItem));
    }

    // create
    if (req.method === 'POST' && parts[0] === 'annotations' && parts.length === 1) {
      const b = await readBody(req);
      if (!b.note || !String(b.note).trim()) return send(res, 400, { error: 'note required' });
      const str = (v, n = 120) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, n);
      const id = String(++db.seq);
      let imageFile = null;
      if (b.image) {
        imageFile = `${id}.png`;
        fs.writeFileSync(path.join(IMAGES, imageFile), Buffer.from(b.image, 'base64'));
      }
      // files the designer attached to the note: photos, PDFs, anything (reference images, assets to place, briefs)
      const attachments = [];
      for (const a of (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 8)) {
        if (!a || !a.data) continue;
        const buf = Buffer.from(a.data, 'base64');
        const mime = String(a.mime || 'application/octet-stream').slice(0, 80);
        const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(a.name || ''));
        const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : m ? m[1].toLowerCase() : 'bin';
        const n = attachments.length + 1;
        const file = `${id}-att${n}.${ext}`;
        fs.writeFileSync(path.join(IMAGES, file), buf);
        attachments.push({ n, file, mime, size: buf.length, name: String(a.name || file).replace(/[\u0000-\u001f]/g, '').slice(0, 120) });
      }
      // targets: layers/frames (any page) and areas, each with an optional screenshot of its own
      const nodes = [];
      for (const raw of (Array.isArray(b.nodes) ? b.nodes : []).slice(0, 12)) {
        if (!raw || !raw.id) continue;
        const i = nodes.length + 1;
        const node = { id: String(raw.id), name: String(raw.name || '').slice(0, 120), type: String(raw.type || ''), w: raw.w ?? null, h: raw.h ?? null };
        if (raw.page) node.page = String(raw.page).slice(0, 120);
        if (raw.pageId) node.pageId = String(raw.pageId);
        if (raw.region && typeof raw.region === 'object') {
          const g = raw.region, num = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null);
          node.region = { x: num(g.x), y: num(g.y), w: num(g.w), h: num(g.h), relX: num(g.relX), relY: num(g.relY), frameId: g.frameId ? String(g.frameId) : null, frameName: g.frameName ? String(g.frameName).slice(0, 120) : null, hitId: g.hitId ? String(g.hitId) : null, hitName: g.hitName ? String(g.hitName).slice(0, 120) : null };
        }
        if (raw.image) { fs.writeFileSync(path.join(IMAGES, `${id}-t${i}.png`), Buffer.from(raw.image, 'base64')); node.hasImage = true; }
        nodes.push(node);
      }
      // the first target's picture doubles as the note's main image
      if (!imageFile && nodes[0] && nodes[0].hasImage) imageFile = `${id}-t1.png`;
      const it = {
        id,
        status: 'pending',
        createdAt: now(),
        updatedAt: now(),
        fileKey: b.fileKey || null,
        fileName: b.fileName || null,
        pageName: b.pageName || null,
        nodes,
        note: String(b.note).trim(),
        intent: b.intent || 'change',
        priority: b.priority || 'normal',
        imageFile,
        batchId: b.batchId || null,
        batchMode: b.batchMode === 'parallel' ? 'parallel' : b.batchId ? 'order' : null,
        // no target: the note is about the page (or the whole file)
        pageId: b.pageId ? str(b.pageId, 40) : null,
        // things the designer @mentioned: variables, styles, components, libraries ({ kind, id?, key?, name, sub, library? })
        mentions: (Array.isArray(b.mentions) ? b.mentions : []).slice(0, 20).filter(m => m && m.name)
          .map(m => ({ kind: str(m.kind, 20), id: m.id ? str(m.id, 80) : null, key: m.key ? str(m.key, 80) : null, name: str(m.name), sub: str(m.sub, 40), library: m.library ? str(m.library) : null })),
        library: b.library ? str(b.library) : null,
        variations: Math.max(1, Math.min(6, Number(b.variations) || 1)),
        // Figma comments: 'apply' them, or 'summarize' them into themes and a plan
        useComments: b.useComments === 'summarize' ? 'summarize' : b.useComments ? 'apply' : null,
        // which model works on the note (a subagent), whether Claude shows a plan first, and a skill to use
        model: b.model && /^[A-Za-z0-9._:-]{1,60}$/.test(b.model) ? String(b.model) : null,
        modelName: b.model && b.modelName ? str(b.modelName, 60) : null,
        planFirst: !!b.planFirst,
        skill: b.skill ? str(b.skill, 120) : null,
        // 'file': the note is about every page of the file, not the selection or the current page
        scope: b.scope === 'file' ? 'file' : null,
        attachments,
        thread: [],
      };
      db.items.push(it);
      save();
      return send(res, 201, publicItem(it));
    }

    // serve stored images to the plugin: /annotations/:id/image/(selection|before|after)
    if (req.method === 'GET' && parts[0] === 'annotations' && parts[2] === 'image' && parts.length === 4) {
      const kind = parts[3];
      const item = find(parts[1]);
      const tgt = /^t(\d+)$/.exec(kind);
      const att = /^att(\d+)$/.exec(kind);
      const attachment = att && item && (item.attachments || []).find(a => a.n === Number(att[1]));
      const file = tgt && item && (item.nodes || [])[Number(tgt[1]) - 1]?.hasImage ? `${parts[1]}-t${tgt[1]}.png` : attachment ? attachment.file : kind === 'selection' ? `${parts[1]}.png` : (kind === 'before' || kind === 'after') ? `${parts[1]}-${kind}.png` : null;
      const full = file && path.join(IMAGES, file);
      if (!full || !fs.existsSync(full)) return send(res, 404, { error: 'no image' });
      res.writeHead(200, { 'Content-Type': attachment ? attachment.mime : 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(full));
    }

    // single item
    if (parts[0] === 'annotations' && parts.length >= 2) {
      const it = find(parts[1]);
      if (!it) return send(res, 404, { error: 'not found' });

      if (req.method === 'GET' && parts.length === 2) {
        return send(res, 200, { ...publicItem(it), figmaUrl: figmaUrl(it) });
      }

      // thread message from either side; optional status change
      if (req.method === 'POST' && parts[2] === 'messages') {
        const b = await readBody(req);
        const from = b.from === 'claude' ? 'claude' : 'user';
        if (!b.text || !String(b.text).trim()) return send(res, 400, { error: 'text required' });
        // Claude can rewrite its own last reply instead of adding another one
        const prev = from === 'claude' && b.replaceLast ? it.thread.findLast(t => t.from === 'claude') : null;
        if (prev) prev.text = String(b.text).trim();
        else it.thread.push({ from, text: String(b.text).trim(), at: now(), ...(from === 'claude' && b.kind === 'plan' ? { kind: 'plan' } : {}) });
        // a user message is unread until Claude answers; it re-opens a finished item, and reaches Claude mid-work too
        if (from === 'user') {
          it.unread = true;
          if (it.status !== 'working') it.status = 'pending';
        } else it.unread = false;
        if (from === 'claude' && b.status) {
          if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'bad status' });
          it.status = b.status;
        }
        it.updatedAt = now();
        save();
        return send(res, 200, publicItem(it));
      }

      // a step Claude is on, shown live under "Working" in the plugin: { text }
      if (req.method === 'POST' && parts[2] === 'progress') {
        const b = await readBody(req);
        if (!b.text || !String(b.text).trim()) return send(res, 400, { error: 'text required' });
        it.progress = [...(it.progress || []), { text: String(b.text).replace(/\s+/g, ' ').trim().slice(0, 200), at: now() }].slice(-40);
        save();
        return send(res, 200, publicItem(it));
      }

      // a job the panel runs inside Figma (it can load the designer's local fonts): { kind: 'fonts' | 'text', payload }
      if (req.method === 'POST' && parts[2] === 'job' && parts.length === 3) {
        const b = await readBody(req);
        if (!['fonts', 'text'].includes(b.kind)) return send(res, 400, { error: 'kind: fonts|text' });
        it.job = { id: String(Date.now()), kind: b.kind, payload: b.payload || {}, status: 'pending', createdAt: now() };
        save();
        return send(res, 201, it.job);
      }
      // the panel's result ({ result }), or the agent giving up on a job nobody ran ({ expire: true })
      if (req.method === 'POST' && parts[2] === 'job' && parts.length === 4) {
        const b = await readBody(req);
        if (!it.job || it.job.id !== parts[3]) return send(res, 404, { error: 'no such job' });
        if (it.job.status !== 'pending') return send(res, 409, { error: 'already ' + it.job.status });
        if (b.expire) { it.job.status = 'expired'; save(); return send(res, 200, it.job); }
        it.job.status = 'done';
        it.job.result = b.result || {};
        // the job's revert goes in front of the Undo patch: the latest change is undone first
        const revert = it.job.result.revert?.text || [];
        if (revert.length) {
          it.patch = it.patch || Object.fromEntries(PATCH_KEYS.map(k => [k, []]));
          it.patch.text = [...revert, ...(it.patch.text || [])];
          it.reverted = false;
        }
        it.updatedAt = now();
        save();
        return send(res, 200, it.job);
      }

      // before/after screenshots saved by Claude
      if (req.method === 'POST' && parts[2] === 'snapshot') {
        const b = await readBody(req);
        if (!['before', 'after'].includes(b.kind) || !b.image) return send(res, 400, { error: 'kind (before|after) and image required' });
        fs.writeFileSync(path.join(IMAGES, `${it.id}-${b.kind}.png`), Buffer.from(b.image, 'base64'));
        it.updatedAt = now();
        save();
        return send(res, 200, publicItem(it));
      }

      // revert patch recorded by Claude before it edits: { set: [{id, props}], remove: [ids] }
      if (req.method === 'POST' && parts[2] === 'patch') {
        const b = await readBody(req);
        if (!b.patch || !PATCH_KEYS.some(k => Array.isArray(b.patch[k]) && b.patch[k].length)) return send(res, 400, { error: `patch needs one of: ${PATCH_KEYS.join(', ')}` });
        // text reverts recorded by panel jobs stay: they are not part of what the agent sends
        const keepText = it.patch?.text || [];
        it.patch = Object.fromEntries(PATCH_KEYS.map(k => [k, Array.isArray(b.patch[k]) ? b.patch[k] : []]));
        it.patch.text = [...it.patch.text, ...keepText];
        it.reverted = false;
        it.updatedAt = now();
        save();
        return send(res, 200, publicItem(it));
      }

      // plugin reports an undo
      if (req.method === 'POST' && parts[2] === 'reverted') {
        it.reverted = true;
        it.thread.push({ from: 'system', text: 'Change reverted from the plugin.', at: now() });
        it.updatedAt = now();
        save();
        return send(res, 200, publicItem(it));
      }

      if (req.method === 'PATCH' && parts.length === 2) {
        const b = await readBody(req);
        if (b.status) {
          if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'bad status' });
          // claiming reads the latest message and starts a fresh list of steps
          if (b.status === 'working' && it.status !== 'working') it.progress = [];
          if (b.status === 'working') it.unread = false;
          it.status = b.status;
        }
        // layers Claude points to; the plugin offers a "Select N layers" button for them
        if (Array.isArray(b.focus)) it.focus = b.focus.map(String).slice(0, 500);
        it.updatedAt = now();
        save();
        return send(res, 200, publicItem(it));
      }

      if (req.method === 'DELETE' && parts.length === 2) {
        db.items = db.items.filter(i => i !== it);
        if (it.imageFile) fs.rmSync(path.join(IMAGES, it.imageFile), { force: true });
        for (const k of ['before', 'after']) fs.rmSync(path.join(IMAGES, `${it.id}-${k}.png`), { force: true });
        for (const a of it.attachments || []) fs.rmSync(path.join(IMAGES, a.file), { force: true });
        (it.nodes || []).forEach((n, i) => { if (n.hasImage) fs.rmSync(path.join(IMAGES, `${it.id}-t${i + 1}.png`), { force: true }); });
        save();
        return send(res, 200, { ok: true });
      }
    }

    send(res, 404, { error: 'no route' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is taken: a bridge is probably already running (curl localhost:${PORT}/health).`);
  else console.error(e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Annotate for Claude bridge ${VERSION} on http://localhost:${PORT}, data in ${DATA}`);
});
