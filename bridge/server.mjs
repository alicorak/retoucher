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
  const { imageFile, ...rest } = it;
  return { ...rest, imagePath: imageFile ? path.join(IMAGES, imageFile) : null };
}

function figmaUrl(it) {
  if (!it.fileKey || !it.nodes?.length) return null;
  const id = it.nodes[0].id.replace(':', '-');
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
      if (size > 25 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
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
      const it = {
        id,
        status: 'pending',
        createdAt: now(),
        updatedAt: now(),
        fileKey: b.fileKey || null,
        fileName: b.fileName || null,
        pageName: b.pageName || null,
        nodes: Array.isArray(b.nodes) ? b.nodes : [],
        note: String(b.note).trim(),
        intent: b.intent || 'change',
        priority: b.priority || 'normal',
        imageFile,
        thread: [],
      };
      db.items.push(it);
      save();
      return send(res, 201, publicItem(it));
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

      if (req.method === 'PATCH' && parts.length === 2) {
        const b = await readBody(req);
        if (b.status) {
          if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'bad status' });
          it.status = b.status;
        }
        it.updatedAt = now();
        save();
        return send(res, 200, publicItem(it));
      }

      if (req.method === 'DELETE' && parts.length === 2) {
        db.items = db.items.filter(i => i !== it);
        if (it.imageFile) fs.rmSync(path.join(IMAGES, it.imageFile), { force: true });
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
