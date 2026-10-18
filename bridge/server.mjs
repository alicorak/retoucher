// Local bridge between the Figma plugin and Claude Code. Zero dependencies.
// Plugin  --POST /annotations-->  bridge  <--CLI (fa.mjs)--  Claude Code
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
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

const STATUSES = ['pending', 'working', 'question', 'done'];
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
    'Access-Control-Allow-Headers': 'Content-Type',
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
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true, count: db.items.length });

    // list
    if (req.method === 'GET' && parts[0] === 'annotations' && parts.length === 1) {
      const status = url.searchParams.get('status');
      const fileKey = url.searchParams.get('fileKey');
      let items = db.items;
      if (status) items = items.filter(i => status.split(',').includes(i.status));
      if (fileKey) items = items.filter(i => i.fileKey === fileKey);
      return send(res, 200, items.map(publicItem));
    }

    // create
    if (req.method === 'POST' && parts[0] === 'annotations' && parts.length === 1) {
      const b = await readBody(req);
      if (!b.note || !String(b.note).trim()) return send(res, 400, { error: 'note required' });
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
        it.thread.push({ from, text: String(b.text).trim(), at: now() });
        // a user follow-up re-opens the item for Claude
        if (from === 'user') it.status = 'pending';
        if (from === 'claude' && b.status) {
          if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'bad status' });
          it.status = b.status;
        }
        it.updatedAt = now();
        save();
        return send(res, 200, publicItem(it));
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
        if (!b.patch || (!Array.isArray(b.patch.set) && !Array.isArray(b.patch.remove))) return send(res, 400, { error: 'patch.set and/or patch.remove required' });
        it.patch = { set: b.patch.set || [], remove: b.patch.remove || [], move: b.patch.move || [] };
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`figma-annotate bridge listening on http://localhost:${PORT}`);
});
