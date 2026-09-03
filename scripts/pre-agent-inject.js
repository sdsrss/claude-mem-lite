#!/usr/bin/env node
// claude-mem-lite: PreToolUse:Agent|Task hook — subagent dispatch-time memory injection.
// Subagents are memory-blind (plugin hooks do NOT fire inside them — #8848); this hook
// injects ONE relevant project lesson into a dispatched subagent's prompt by mutating
// tool_input.prompt via hookSpecificOutput.updatedInput. Verified live 2026-07-03
// (Phase 0a: the mutation reaches the subagent's task-prompt position; Phase 0b: an
// appended, attributed, reference-only block is adopted, whereas a raw imperative
// prepend trips the subagent's own prompt-injection detector and is refused).
//
// DEFAULT OFF (CLAUDE_MEM_SUBAGENT_INJECT=on|1). The off path costs one env check and
// returns — no stdin read, no DB, no heavy imports (schema/better-sqlite3 are dynamic,
// loaded only on the enabled Agent path). Fail-open: never exits non-zero, never blocks
// a dispatch (a thrown hook would abort the user's subagent).

const ENABLED = process.env.CLAUDE_MEM_SUBAGENT_INJECT === 'on'
  || process.env.CLAUDE_MEM_SUBAGENT_INJECT === '1';

// Telemetry via DYNAMIC import so the default-off fast path stays import-free
// (the file's stated contract). Only ever reached on the enabled path's failure
// branches — this script had zero recordHookError coverage, so a dead DB or
// schema drift silently disabled subagent injection with no trace (audit
// 2026-08-14 M-5). Swallows everything: telemetry must never break a dispatch.
async function recordFailure(scope, err, ctx) {
  try {
    const [{ recordHookError }, { resolveDataDir, resolveRuntimeDir }] = await Promise.all([
      import('../lib/hook-telemetry.mjs'),
      import('../lib/resolve-data-dir.mjs'),
    ]);
    // P1-14: the shared resolver, not a fourth hand-written `env || join(...)`. This is on
    // the error path, which already dynamic-imports, so the script's zero-import budget on
    // the HAPPY path is untouched.
    recordHookError(scope, err, resolveRuntimeDir(resolveDataDir(process.env.CLAUDE_MEM_DIR)), ctx);
  } catch { /* never */ }
}

// The ONE hand-written stdin reader left in the tree, and it stays deliberately (P1-9).
// The other five now share `lib/hook-stdin.mjs`; this script is the default-OFF path whose
// entire reason to exist is costing nothing when the feature is disabled, and it reaches
// this line before importing anything at all — even an import-free module is a module
// resolution. Its caliber (1.5 s, 262144, never rejects) is the same shape the shared
// reader implements with `rejectOnTimeout: false`, so if this ever gains an import, delete
// this function and call `readHookStdin({ timeoutMs: 1500, maxBytes: 262144 })`.
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => { try { process.stdin.destroy(); } catch { /* */ } resolve(data); }, 1500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      // cap: agent prompts can be large. destroy() so the loop can drain and exit on
      // its own (see the no-forced-exit note at the bottom) rather than streaming to
      // the 1.5s timeout. 262144 = MAX_HOOK_STDIN_BYTES (utils.mjs) repeated as a
      // literal ON PURPOSE: the default-off fast path above must stay import-free.
      if (data.length > 262144) { clearTimeout(timer); try { process.stdin.destroy(); } catch { /* */ } resolve(data.slice(0, 262144)); }
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
    process.stdin.resume();
  });
}

async function main() {
  if (!ENABLED) return;                             // default: cheapest possible no-op
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) return;  // recursion guard (background claude -p)

  const raw = await readStdin();
  let hook;
  try { hook = JSON.parse(raw); } catch { return; }
  if (!hook || typeof hook !== 'object') return;
  if (hook.tool_name !== 'Agent' && hook.tool_name !== 'Task') return;

  // Heavy deps loaded ONLY on the enabled Agent-dispatch path, so the default-off
  // hot path never pays the schema.mjs + better-sqlite3 native load on every dispatch.
  const { ensureDb } = await import('../schema.mjs');
  const { inferProject } = await import('../utils.mjs');
  const { buildSubagentInjection } = await import('../hook-memory.mjs');
  // D#154: single envelope writer. Deferred to this line, not hoisted to a static
  // import, because the file's stated contract is that the default-off path costs one
  // env check and nothing else — the deferral filed this as "shared module vs
  // import-free fast path, pick one", but the script already resolves that conflict
  // three lines up: dynamic import on the enabled path only. The fast path above is
  // untouched.
  const { queueHookUpdatedInput, flushHookStdout } = await import('../lib/hook-stdout.mjs');

  let db;
  try { db = ensureDb(); } catch (e) { await recordFailure('agent-inject:db-open', e); return; }
  try {
    const updatedInput = buildSubagentInjection(db, hook.tool_input, inferProject());
    if (updatedInput) {
      // Behaviour delta vs the hand-written envelope this replaced: it now carries
      // top-level `suppressOutput: true`. Verified display-only in the 2.1.241 bundle —
      // the field is documented "Hide stdout from transcript (default: false)" and is
      // read at exactly one place, the transcript-render branch
      // (`if (a6(he) && !he.suppressOutput && …)`); the updatedInput mutation is taken
      // from the parsed hookSpecificOutput regardless. Hiding it is also the right
      // audience call: this payload is the whole prompt echoed back, not a message.
      queueHookUpdatedInput('PreToolUse', updatedInput);
      flushHookStdout();
    }
  } catch (e) { await recordFailure('agent-inject:query', e); /* never break a dispatch */ } finally {
    try { db.close(); } catch { /* */ }
  }
}

// No forced process.exit(0): every readStdin path ends/destroys stdin and db.close()
// runs in main's finally, so the event loop drains and the process exits 0 on its own —
// which FLUSHES stdout. The emitted updatedInput echoes the whole prompt back, so the
// payload can exceed the ~64KB pipe buffer; a forced process.exit() would drop that
// pending async write and truncate the JSON (the gotcha every sibling hook avoids).
// Swallow any rejection so the exit code can never go non-zero — but record it
// first (recordFailure itself swallows everything, including its own failures).
main().catch((e) => recordFailure('agent-inject:main', e));
