// Runs in Figma's sandbox. Owns selection + export; the UI iframe talks to the bridge.
figma.showUI(__html__, { width: 340, height: 560, themeColors: true });

const MAX_NODES = 12;

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
  // Export the selection as one PNG. Multiple nodes: export each, UI shows the first.
  const target = nodes[0];
  if (!target || !('exportAsync' in target)) return null;
  const w = 'width' in target ? target.width : 1;
  const h = 'height' in target ? target.height : 1;
  const scale = Math.min(2, 1600 / Math.max(w, h, 1));
  try {
    const bytes = await target.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.max(0.1, scale) } });
    return bytes;
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

figma.ui.onmessage = async msg => {
  if (msg.type === 'ready') {
    pushContext();
    pushSelection();
    const saved = await figma.clientStorage.getAsync('fileUrl');
    figma.ui.postMessage({ type: 'saved-file-url', value: saved || '' });
  }
  if (msg.type === 'save-file-url') {
    await figma.clientStorage.setAsync('fileUrl', msg.value);
  }
  if (msg.type === 'focus') {
    // Jump to the nodes an annotation was about.
    const found = [];
    for (const id of msg.ids) {
      const n = await figma.getNodeByIdAsync(id);
      if (n && n.type !== 'DOCUMENT' && n.type !== 'PAGE') found.push(n);
    }
    if (!found.length) {
      figma.notify('Those layers no longer exist.');
      return;
    }
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
