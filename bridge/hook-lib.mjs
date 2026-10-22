// Shared by the Claude Code hooks: talk to the bridge, find the note being worked on, wait for the panel's answer.
export const BASE = `http://localhost:${process.env.FA_PORT || 4747}`;

export const readStdin = () => new Promise(r => { let s = ''; process.stdin.on('data', c => (s += c)); process.stdin.on('end', () => r(s)); });

export async function get(p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, signal: AbortSignal.timeout(2000), headers: { 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// The panel takes over only while it is open and Claude is on a note; otherwise the person is at the terminal.
export async function noteInPanel() {
  try {
    if (!(await get('/health')).panel) return null;
    const working = await get('/annotations?status=working');
    return working.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
  } catch { return null; }
}

// Post a prompt to the panel and wait for the answer; null when nobody answers in time (it then goes back to the terminal).
export async function askPanel(body, waitMs) {
  let p;
  try { p = await get('/permissions', { method: 'POST', body: JSON.stringify(body) }); } catch { return null; }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 800));
    let cur;
    try { cur = await get(`/permissions/${p.id}`); } catch { continue; }
    if (cur.status === 'answered') return cur;
  }
  try { await get(`/permissions/${p.id}/expire`, { method: 'POST' }); } catch {}
  return null;
}
