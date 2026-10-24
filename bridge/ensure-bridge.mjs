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
const DATA = path.resolve(process.env.FA_DATA || path.join(os.homedir(), '.retoucher'));
const LEGACY = process.argv[2] ? path.resolve(process.argv[2]) : null;
const VERSION = (() => {
  for (const f of ['plugin.json', path.join('.claude-plugin', 'plugin.json')]) {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version; } catch {}
  }
  return 'dev';
})();
// Before the rename to Retoucher (0.8.0) the shared folder was ~/.figma-annotate: it wins over a plugin data folder.
const OLD_SHARED = path.join(os.homedir(), '.figma-annotate');
if (!fs.existsSync(DATA)) {
  const from = [OLD_SHARED, LEGACY].find(d => d && fs.existsSync(path.join(d, 'annotations.json')));
  if (from) fs.cpSync(from, DATA, { recursive: true });
}

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
  console.log(`Retoucher: port ${PORT} is used by another program, so the Figma panel can't connect. Free it or set FA_PORT.`);
  process.exit(0);
}
// Several agents start this (Claude Code, Codex, Cursor), each from its own copy of the plugin, which may be
// older or newer. Replace a running bridge only with a newer version, so agents never take turns downgrading it.
// A bridge from a checkout ("dev") is left alone.
const newer = (a, b) => {
  const n = v => String(v).split(/[.+-]/).slice(0, 3).map(x => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (running && (running.version === 'dev' || VERSION === 'dev' || !newer(VERSION, running.version))) process.exit(0);
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
console.log(`Retoucher: the bridge did not start; see ${path.join(DATA, 'bridge.log')}.`);
