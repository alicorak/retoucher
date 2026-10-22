#!/usr/bin/env node
// Makes sure one bridge runs on this machine, shared by every agent and session: run by the Claude Code / Codex
// SessionStart hook and by the MCP server when it starts.
// The bridge outlives the session that started it, so the Figma panel stays connected; a newer plugin version
// replaces an older bridge. A bridge started from a repo checkout ("dev") is left alone.
// Prints nothing when all is well (SessionStart output becomes context in every session).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.FA_PORT || 4747);
const BASE = `http://localhost:${PORT}`;
// One data folder for every agent, so notes, pairing and the Figma token are the same whichever agent starts the
// bridge. The argument is the folder an older version used (the agent's plugin data folder): copied over once.
const DATA = path.resolve(process.env.FA_DATA || path.join(os.homedir(), '.figma-annotate'));
const LEGACY = process.argv[2] ? path.resolve(process.argv[2]) : null;
const VERSION = (() => {
  for (const f of ['plugin.json', path.join('.claude-plugin', 'plugin.json')]) {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version; } catch {}
  }
  return 'dev';
})();
if (!fs.existsSync(DATA) && LEGACY && fs.existsSync(path.join(LEGACY, 'annotations.json'))) fs.cpSync(LEGACY, DATA, { recursive: true });

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
