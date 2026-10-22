#!/usr/bin/env node
// Claude Code PreToolUse hook for AskUserQuestion and ExitPlanMode (hooks/hooks.json): while the Figma panel is open
// and Claude is on a note, the questions or the plan show in the panel, and the answer goes back as the tool's input.
// Otherwise, or when nobody answers in time, it prints nothing and Claude Code shows them in the terminal as usual.
import { readStdin, noteInPanel, askPanel } from './hook-lib.mjs';
const WAIT_MS = 290_000; // keep under the hook's timeout in hooks.json

const decide = (permissionDecision, extra) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...extra } }));
  process.exit(0);
};

const input = JSON.parse((await readStdin()) || '{}');
const tool = input.tool_name;
const args = input.tool_input || {};
if (tool !== 'AskUserQuestion' && tool !== 'ExitPlanMode') process.exit(0);
const note = await noteInPanel();
if (!note) process.exit(0);

if (tool === 'AskUserQuestion') {
  const p = await askPanel({ kind: 'question', title: 'Claude has a question', questions: args.questions, noteId: note.id }, WAIT_MS);
  if (!p) process.exit(0);
  if (p.decision === 'skip') decide('deny', { permissionDecisionReason: 'The designer skipped these questions in the Figma panel. Decide yourself with the most sensible default, and say which in the note.' });
  decide('allow', { updatedInput: { ...args, answers: p.answers || {} } });
}

const p = await askPanel({ kind: 'plan', title: 'Claude made a plan', plan: String(args.plan || ''), noteId: note.id }, WAIT_MS);
if (!p) process.exit(0);
if (p.decision === 'approve') decide('allow', { updatedInput: args });
decide('deny', { permissionDecisionReason: `The designer wants changes to the plan before you start: ${p.feedback || '(no details given)'}. Revise the plan and present it again.` });
