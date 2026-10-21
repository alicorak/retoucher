#!/usr/bin/env node
// SessionStart hook of the Claude Code plugin: makes sure one bridge runs on this machine, for every session.
// The bridge outlives the session that started it, so the Figma panel stays connected; a newer plugin version
// replaces an older bridge. A bridge started from a repo checkout ("dev") is left alone.
// Prints nothing when all is well (SessionStart output becomes context in every session).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.FA_PORT || 4747);
const BASE = `http://localhost:${PORT}`;
const DATA = path.resolve(process.argv[2] || process.env.FA_DATA || path.join(ROOT, 'data'));
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { return 'dev'; } })();

const health = async () => {
  try {
    const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) });
    return r.ok ? await r.json() : { foreign: true };
  } catch (e) {
    return e.cause?.code === 'ECONNREFUSED' || e.name === 'TimeoutError' ? null : { foreign: true };
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const running = await health();
if (running?.foreign) {
  console.log(`Annotate for Claude: port ${PORT} is used by another program, so the Figma panel can't connect. Free it or set FA_PORT.`);
  process.exit(0);
}
if (running && (running.version === VERSION || running.version === 'dev')) process.exit(0);
if (running) { // older version: ask it to stop, then start ours
  await fetch(BASE + '/quit', { method: 'POST' }).catch(() => {});
  for (let i = 0; i < 20 && await health(); i++) await sleep(100);
}

fs.mkdirSync(DATA, { recursive: true });
const log = fs.openSync(path.join(DATA, 'bridge.log'), 'a');
spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.mjs')], {
  detached: true, stdio: ['ignore', log, log], env: { ...process.env, FA_DATA: DATA }, windowsHide: true,
}).unref();

for (let i = 0; i < 30; i++) {
  await sleep(100);
  if (await health()) process.exit(0);
}
console.log(`Annotate for Claude: the bridge did not start; see ${path.join(DATA, 'bridge.log')}.`);
