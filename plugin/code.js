// Runs in Figma's sandbox. Owns selection, export, canvas markers and undo.
// The UI iframe talks to the bridge.
figma.showUI(__html__, { width: 340, height: 600, themeColors: true });

const MAX_NODES = 12;
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
  'fontSize', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'characters',
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
  for (const entry of patch.set || []) {
    const node = await figma.getNodeByIdAsync(entry.id);
    if (!node) { result.missing.push(entry.id); continue; }
    try {
      await loadTextFonts(node);
      const props = entry.props || {};
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
  if (msg.type === 'notify') figma.notify(msg.text);
};

function findPage(node) {
  let n = node;
  while (n && n.type !== 'PAGE') n = n.parent;
  return n;
}
