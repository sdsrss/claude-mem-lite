#!/usr/bin/env node
// benchmark/confine-tools.js — HARNESS-ONLY PreToolUse hook for the efficacy
// severe test (efficacy-harness.mjs --isolated). Denies Bash|Agent|Task so the
// orchestrator can't spawn a full-Bash worker subagent or sed-edit around the
// Edit tool — every mutation must flow through Edit, where pre-tool-recall.js
// (the injection channel under test) actually fires. Also removes the
// "ran the worktree's regression-excised tests for false confidence" escape (#8711).
//
// NEVER wire this into a user's real plugin hooks.json. It lives under benchmark/
// and is referenced only by makePinnedConfigDir in the harness.
// Safety: exit 0 always (deny via JSON, not a crash).

const DENY = new Set(['Bash', 'Agent', 'Task']);

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let toolName = null;
  try {
    toolName = JSON.parse(input).tool_name || null;
  } catch {
    return;
  }
  if (toolName && DENY.has(toolName)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `[efficacy-harness] ${toolName} is disabled in this cell — make the change directly with the Edit tool.`,
        },
      }),
    );
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
