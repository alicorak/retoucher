#!/usr/bin/env node
// Retoucher installs as an agent plugin (Claude Code, Codex, Cursor) plus a Figma plugin.
// This package only prints how to set it up; it doesn't install anything itself.
const PROMPT = "Set up Retoucher for me. It lets me leave notes on my Figma layers that you pick up, apply in the Figma file and answer in a panel inside Figma.\n\n1. Install the Retoucher agent plugin for the agent you are:\n   - Claude Code: run `claude plugin install retoucher --marketplace alicorak/retoucher`\n   - Codex: run `codex plugin marketplace add alicorak/retoucher`, then install it from /plugins and tell me to trust its hooks once\n   - Cursor: run `git clone https://github.com/alicorak/retoucher.git ~/.retoucher-plugin` and `mkdir -p ~/.cursor/plugins/local && ln -s ~/.retoucher-plugin ~/.cursor/plugins/local/retoucher`, then tell me to restart Cursor\n2. Check that Node.js 18 or newer is installed and that the Figma MCP server is connected. If either is missing, tell me exactly how to fix it.\n3. Tell me to open the Retoucher plugin in Figma (Plugins \u2192 Retoucher; first time, add it from https://www.figma.com/community/plugin/1696122599848660328/retoucher).\n4. Start watching my Figma notes: in Claude Code run /retoucher:watch, in Codex or Cursor use the watch-figma-notes skill.\n\nSetup details: https://github.com/alicorak/retoucher#readme";

const arg = process.argv[2];
if (arg === 'prompt') {
  process.stdout.write(PROMPT + '\n');
} else {
  console.log(`Retoucher: your coding agent, inside Figma.

Set it up by pasting this prompt into Claude Code, Codex or Cursor:
  npx retoucher prompt

Or install by hand:
  Claude Code  claude plugin install retoucher --marketplace alicorak/retoucher
  Codex        codex plugin marketplace add alicorak/retoucher   (then /plugins)
  Cursor       see https://github.com/alicorak/retoucher#1-agent-plugin

Then open the Retoucher plugin in Figma:
  https://www.figma.com/community/plugin/1696122599848660328/retoucher

Website  https://retoucher.alicorak.com
Docs     https://github.com/alicorak/retoucher#readme`);
}
