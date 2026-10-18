// Runs in Figma's sandbox. Owns selection, export, canvas markers and undo.
// The UI iframe talks to the bridge.
figma.showUI(__html__, { width: 340, height: 700, themeColors: true });

const MAX_NODES = 12;
const MAX_TARGETS = 6; // targets that get their own screenshot
const AREA_NAME = '✎ Annotate area (temp)';

async function exportNode(n, maxPx) {
  if (!('exportAsync' in n)) return null;
  const w = 'width' in n ? n.width : 1, h = 'height' in n ? n.height : 1;
  const scale = Math.max(0.1, Math.min(2, maxPx / Math.max(w, h, 1)));
  try { return await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }); } catch (e) { return null; }
}

// ---------- areas: a temporary slice the user drags over any part of the canvas ----------
function removeTempAreas() {
  try { for (const n of figma.currentPage.findAllWithCriteria({ types: ['SLICE'] })) if (n.name === AREA_NAME) n.remove(); } catch (e) {}
}

function makeArea() {
  removeTempAreas();
  const vb = figma.viewport.bounds;
  const w = Math.max(80, Math.round(vb.width * 0.4)), h = Math.max(60, Math.round(vb.height * 0.3));
  const slice = figma.createSlice();
  slice.name = AREA_NAME;
  slice.resize(w, h);
  slice.x = Math.round(vb.x + (vb.width - w) / 2);
  slice.y = Math.round(vb.y + (vb.height - h) / 2);
  figma.currentPage.selection = [slice];
}

// The screen (top-level frame) holding a point, and the deepest layer on top of it there.
function pointHit(cx, cy, skipId) {
  let kids = figma.currentPage.children, frame = null, hit = null, depth = 0;
  while (kids && depth < 8) {
    let next = null;
    for (let i = kids.length - 1; i >= 0; i--) { // last child is on top
      const k = kids[i];
      if (k.id === skipId || !k.visible || !k.absoluteBoundingBox) continue;
      const b = k.absoluteBoundingBox;
      if (cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height) { next = k; break; }
    }
    if (!next) break;
    hit = next;
    if (!frame && next.type !== 'SECTION' && next.type !== 'SLICE') frame = next;
    kids = 'children' in next ? next.children : null;
    depth++;
  }
  return { frame, hit };
}

// Everything selected becomes a target with its own picture; a temp slice becomes an area with coordinates.
async function targetsFromSelection() {
  const page = figma.currentPage;
  const out = [];
  for (const n of page.selection.slice(0, MAX_TARGETS)) {
    const t = { id: n.id, name: n.name, type: n.type, w: Math.round(n.width), h: Math.round(n.height), pageId: page.id, page: page.name };
    t.image = await exportNode(n, 1200);
    if (n.type === 'SLICE' && n.name === AREA_NAME) {
      const b = n.absoluteBoundingBox;
      const { frame, hit } = pointHit(b.x + b.width / 2, b.y + b.height / 2, n.id);
      const fb = frame ? frame.absoluteBoundingBox : null;
      t.name = 'Area'; t.type = 'AREA';
      t.region = { x: b.x, y: b.y, w: b.width, h: b.height, frameId: frame ? frame.id : null, frameName: frame ? frame.name : null,
        relX: fb ? b.x - fb.x : null, relY: fb ? b.y - fb.y : null, hitId: hit ? hit.id : null, hitName: hit ? hit.name : null };
      if (t.image) n.remove(); // keep the slice if the picture failed, so the user can retry
    }
    out.push(t);
  }
  return out;
}

async function focusRegion(r, pageId) {
  const page = pageId ? await figma.getNodeByIdAsync(pageId) : null;
  if (page && page.type === 'PAGE' && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  const vb = figma.viewport.bounds;
  figma.viewport.center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  figma.viewport.zoom = figma.viewport.zoom * Math.min(vb.width / (r.w * 1.6), vb.height / (r.h * 1.6));
}
figma.on('close', removeTempAreas);

// ---------- area picker: a picture of a frame (or of what is on screen) to mark up inside the panel ----------
// Nothing is dragged on the canvas, so nothing can end up between frames.
async function openPicker() {
  removeTempAreas();
  const page = figma.currentPage, sel = page.selection;
  const one = sel.length === 1 ? sel[0] : null;
  let box, image, name, id = null, type = 'VIEWPORT';
  if (one && one.absoluteBoundingBox && one.visible !== false) {
    box = one.absoluteBoundingBox; image = await exportNode(one, 2400); name = one.name; id = one.id; type = one.type;
  } else {
    const vb = figma.viewport.bounds;
    const slice = figma.createSlice(); // exists only for the instant it takes to photograph the screen
    slice.name = AREA_NAME; slice.resize(Math.max(1, vb.width), Math.max(1, vb.height)); slice.x = vb.x; slice.y = vb.y;
    image = await exportNode(slice, 2000); slice.remove();
    box = { x: vb.x, y: vb.y, width: vb.width, height: vb.height }; name = 'What is on screen';
  }
  if (!image) { figma.notify('Could not take a picture of that.'); return; }
  figma.ui.postMessage({ type: 'picker-open', backdrop: { id, type, name, x: box.x, y: box.y, w: box.width, h: box.height, image, pageId: page.id, page: page.name } });
}

// Fractions of the picture -> canvas coordinates, the screen each area sits in and the layer on top there.
function pickerCommit(b, regions) {
  const page = figma.currentPage;
  const stamp = Date.now().toString(36);
  const targets = regions.map((r, i) => {
    const x = b.x + r.fx * b.w, y = b.y + r.fy * b.h, w = r.fw * b.w, h = r.fh * b.h;
    const { frame, hit } = pointHit(x + w / 2, y + h / 2, null);
    const fb = frame ? frame.absoluteBoundingBox : null;
    return { id: 'area-' + stamp + '-' + (i + 1), name: 'Area ' + (i + 1), type: 'AREA', w: Math.round(w), h: Math.round(h), pageId: page.id, page: page.name,
      region: { x, y, w, h, frameId: frame ? frame.id : null, frameName: frame ? frame.name : null,
        relX: fb ? x - fb.x : null, relY: fb ? y - fb.y : null, hitId: hit ? hit.id : null, hitName: hit ? hit.name : null } };
  });
  figma.ui.postMessage({ type: 'picker-result', targets });
}
const LABEL = { pending: 'Waiting', working: 'Claude is working', question: 'Needs your answer', done: 'Done' };

function describe(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    w: 'width' in node ? Math.round(node.width) : null,
    h: 'height' in node ? Math.round(node.height) : null,
  };
}

async function snapshot(nodes) {
  const target = nodes[0];
  if (!target || !('exportAsync' in target)) return null;
  const w = 'width' in target ? target.width : 1;
  const h = 'height' in target ? target.height : 1;
  const scale = Math.min(2, 1600 / Math.max(w, h, 1));
  try {
    return await target.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.max(0.1, scale) } });
  } catch (e) {
    return null;
  }
}

let seq = 0;
async function pushSelection() {
  const mine = ++seq;
  const sel = figma.currentPage.selection.slice(0, MAX_NODES);
  const bytes = await snapshot(sel);
  if (mine !== seq) return; // a newer selection superseded this one
  figma.ui.postMessage({
    type: 'selection',
    nodes: sel.map(describe),
    total: figma.currentPage.selection.length,
    image: bytes,
  });
}

function pushContext() {
  figma.ui.postMessage({
    type: 'context',
    fileKey: figma.fileKey || null,
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
  });
}

figma.on('selectionchange', pushSelection);
figma.on('currentpagechange', () => { pushContext(); pushSelection(); });

// ---------- canvas markers (native Figma annotations) ----------
// One annotation per note per layer, prefixed "Claude #<id>". Removed when the note is done or deleted.
// Annotations of other people are never touched.
const markerState = new Map(); // note id -> signature last applied ('none' = removed)

function isMine(a, id) {
  const text = (a.labelMarkdown || a.label || '');
  return new RegExp('^\\W*Claude #' + id + '\\b').test(text);
}

async function setMarker(nodeId, id, markdown) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || !('annotations' in node)) return false;
  const others = (node.annotations || []).filter(a => !isMine(a, id));
  node.annotations = markdown ? others.concat([{ labelMarkdown: markdown }]) : others;
  return true;
}

async function syncMarkers(items, enabled) {
  for (const it of items) {
    const want = enabled && it.status !== 'done' ? it.status + '|' + it.note : 'none';
    if (markerState.get(it.id) === want) continue;
    const md = want === 'none' ? null :
      '**Claude #' + it.id + '** · ' + (LABEL[it.status] || it.status) + '\n' + it.note.slice(0, 220);
    for (const nodeId of it.nodeIds) {
      try { await setMarker(nodeId, it.id, md); } catch (e) { /* layer gone or unsupported type */ }
    }
    markerState.set(it.id, want);
  }
}

// ---------- undo: apply the revert patch Claude recorded before editing ----------
const SIMPLE_PROPS = [
  'name', 'visible', 'locked', 'opacity', 'rotation', 'clipsContent',
  'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'layoutMode', 'layoutWrap', 'primaryAxisSizingMode', 'counterAxisSizingMode',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'itemSpacing', 'counterAxisSpacing',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
  'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutPositioning',
  'strokeWeight', 'strokeAlign', 'fills', 'strokes', 'effects',
  'fontName', 'fontSize', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'characters',
];

async function loadTextFonts(node) {
  if (node.type !== 'TEXT') return;
  if (node.fontName === figma.mixed) {
    const segs = node.getStyledTextSegments(['fontName']);
    for (const s of segs) await figma.loadFontAsync(s.fontName);
  } else {
    await figma.loadFontAsync(node.fontName);
  }
}

async function applyPatch(patch) {
  const result = { restored: 0, removed: 0, missing: [], errors: [] };
  // moves first: a layer is put back into its old parent (and size) before the layers that held it are removed
  for (const m of patch.move || []) {
    const node = await figma.getNodeByIdAsync(m.id);
    const parent = await figma.getNodeByIdAsync(m.parentId);
    if (!node || !parent || !('insertChild' in parent)) { result.missing.push(m.id); continue; }
    try {
      parent.insertChild(typeof m.index === 'number' ? Math.min(m.index, parent.children.length) : parent.children.length, node);
      if (m.width && m.height && 'resize' in node) node.resize(m.width, m.height);
      result.restored++;
    } catch (e) { result.errors.push(m.id + ' move: ' + e.message); }
  }
  for (const entry of patch.set || []) {
    const node = await figma.getNodeByIdAsync(entry.id);
    if (!node) { result.missing.push(entry.id); continue; }
    try {
      await loadTextFonts(node);
      const props = entry.props || {};
      if (props.fontName) await figma.loadFontAsync(props.fontName); // the font being restored must be loaded before it is set
      // layout mode first, size last: order matters in auto layout
      for (const key of SIMPLE_PROPS) {
        if (!(key in props) || !(key in node)) continue;
        try { node[key] = props[key]; } catch (e) { result.errors.push(entry.id + '.' + key + ': ' + e.message); }
      }
      if (('x' in props || 'y' in props) && 'x' in node) {
        try { if ('x' in props) node.x = props.x; if ('y' in props) node.y = props.y; } catch (e) { result.errors.push(entry.id + '.xy: ' + e.message); }
      }
      if (('width' in props || 'height' in props) && 'resize' in node) {
        try { node.resize('width' in props ? props.width : node.width, 'height' in props ? props.height : node.height); } catch (e) { result.errors.push(entry.id + '.size: ' + e.message); }
      }
      result.restored++;
    } catch (e) {
      result.errors.push(entry.id + ': ' + e.message);
    }
  }
  for (const id of patch.remove || []) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) { result.missing.push(id); continue; }
    try { node.remove(); result.removed++; } catch (e) { result.errors.push(id + ': ' + e.message); }
  }
  figma.commitUndo();
  return result;
}

// ---------- messages from the UI ----------
figma.ui.onmessage = async msg => {
  if (msg.type === 'ready') {
    removeTempAreas();
    pushContext();
    pushSelection();
    const saved = await figma.clientStorage.getAsync('fileUrl');
    figma.ui.postMessage({ type: 'saved-file-url', value: saved || '' });
    const markers = await figma.clientStorage.getAsync('markers');
    figma.ui.postMessage({ type: 'markers-pref', value: markers !== false });
  }
  if (msg.type === 'save-file-url') await figma.clientStorage.setAsync('fileUrl', msg.value);
  if (msg.type === 'set-markers') await figma.clientStorage.setAsync('markers', !!msg.value);
  if (msg.type === 'sync-markers') await syncMarkers(msg.items, msg.enabled);
  if (msg.type === 'clear-markers') {
    for (const nodeId of msg.nodeIds) { try { await setMarker(nodeId, msg.id, null); } catch (e) {} }
    markerState.delete(msg.id);
  }
  if (msg.type === 'apply-patch') {
    const result = await applyPatch(msg.patch);
    figma.ui.postMessage({ type: 'patch-result', id: msg.id, result });
  }
  if (msg.type === 'focus') {
    const found = [];
    for (const id of msg.ids) {
      const n = await figma.getNodeByIdAsync(id);
      if (n && n.type !== 'DOCUMENT' && n.type !== 'PAGE') found.push(n);
    }
    if (!found.length) { figma.notify('Those layers no longer exist.'); return; }
    const page = findPage(found[0]);
    if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = found;
    figma.viewport.scrollAndZoomIntoView(found);
  }
  if (msg.type === 'open-picker') await openPicker();
  if (msg.type === 'picker-commit') pickerCommit(msg.backdrop, msg.regions);
  if (msg.type === 'resize') figma.ui.resize(Math.round(msg.w), Math.round(msg.h));
  if (msg.type === 'make-area') makeArea();
  if (msg.type === 'add-selection') figma.ui.postMessage({ type: 'targets-added', targets: await targetsFromSelection() });
  if (msg.type === 'focus-region') await focusRegion(msg.region, msg.pageId);
  if (msg.type === 'notify') figma.notify(msg.text);
};

function findPage(node) {
  let n = node;
  while (n && n.type !== 'PAGE') n = n.parent;
  return n;
}
