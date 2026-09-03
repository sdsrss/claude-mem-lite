#!/usr/bin/env node
// claude-mem-lite: PreToolUse Skill bridge — loads managed skills from registry
// Intercepts Skill("name") calls for skills in ~/.claude-mem-lite/managed/
// Lightweight standalone (~30ms): only imports better-sqlite3, fs, path, os

import { existsSync, readFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import { recordHookError } from '../lib/hook-telemetry.mjs';
import { resolveDataDir, resolveRuntimeDir } from '../lib/resolve-data-dir.mjs';
// format-utils.mjs is import-free — pulling three defang helpers keeps this script
// inside its "lightweight standalone" budget (no heavy transitive deps).
import { neutralizeContextDelimiters, neutralizeSkillDelimiters, neutralizeSkillBridgeDelimiters } from '../format-utils.mjs';
// D#154: single envelope writer. Also import-free (no runtime deps), so it stays
// inside this script's "lightweight standalone" budget.
import { queueHookContext, flushHookStdout } from '../lib/hook-stdout.mjs';
// P1-9: bounded stdin. Also import-free, so it stays inside the "lightweight standalone"
// budget this script's header claims.
import { readHookStdin } from '../lib/hook-stdin.mjs';

// CLAUDE_MEM_DIR mirrors pre-tool-recall.js — one env var sandboxes everything.
const DATA_DIR = resolveDataDir(process.env.CLAUDE_MEM_DIR);
const RUNTIME_DIR = resolveRuntimeDir(DATA_DIR);
// D#29: all data artifacts follow DATA_DIR (CLAUDE_MEM_DIR-aware), not a hardcoded
// homedir — previously REGISTRY_DB_PATH/MANAGED_BASE/MARKER pinned homedir while line 12
// honored the env, so relocated installs opened the wrong DB and the marker never matched
// the relocated local_path. MANAGED_MARKER is only a coarse LIKE prefilter; the exact
// MANAGED_BASE prefix check below is the real confinement gate (so LIKE-wildcard chars in
// a relocated path can at worst over-admit to that gate, never bypass it).
const REGISTRY_DB_PATH = join(DATA_DIR, 'resource-registry.db');
const MANAGED_BASE = DATA_DIR;
const MANAGED_MARKER = join(DATA_DIR, 'managed') + sep;

try {
  // Skip if recursive hook
  if (process.env.CLAUDE_MEM_HOOK_RUNNING) process.exit(0);

  // Read stdin, bounded (P1-9). This used to be an unbounded `for await` accumulate: no
  // cap, no timeout, the only limit being the host's own fail-open — which looks exactly
  // like the hook having nothing to say.
  const { text: input } = await readHookStdin();

  // Parse event
  let skillName;
  try {
    const event = JSON.parse(input);
    skillName = event.tool_input?.skill;
  } catch (e) {
    recordHookError('skill-bridge:json', e, RUNTIME_DIR, { inputLen: input.length });
    process.exit(0);
  }

  if (!skillName || typeof skillName !== 'string') process.exit(0);

  // Skip if registry DB doesn't exist
  if (!existsSync(REGISTRY_DB_PATH)) process.exit(0);

  // Open DB readonly
  const Database = (await import('better-sqlite3')).default;
  let db;
  try {
    db = new Database(REGISTRY_DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 1000');
  } catch (e) {
    recordHookError('skill-bridge:db-open', e, RUNTIME_DIR);
    process.exit(0);
  }

  try {
    // Query: find by name or invocation_name, ONLY if managed path
    const row = db.prepare(`
      SELECT name, local_path FROM resources
      WHERE status = 'active'
        AND (name = ? OR invocation_name = ?)
        AND local_path LIKE ?
      LIMIT 1
    `).get(skillName, skillName, `%${MANAGED_MARKER}%`);

    if (!row || !row.local_path) process.exit(0);

    // Resolve path: directory skills → SKILL.md (agents always have full .md paths)
    let skillPath = row.local_path;
    if (!skillPath.endsWith('.md')) {
      const candidate = join(skillPath, 'SKILL.md');
      if (existsSync(candidate)) skillPath = candidate;
    }

    if (!existsSync(skillPath)) process.exit(0);

    // Path confinement check — prevent LIKE bypass via '../' in local_path
    const resolvedPath = resolve(skillPath);
    if (resolvedPath !== MANAGED_BASE && !resolvedPath.startsWith(MANAGED_BASE + sep)) process.exit(0);

    // Read and output
    const content = readFileSync(skillPath, 'utf8');
    // T4-P1-B: JSON hookSpecificOutput parity with pre-tool-recall.js. Some CC variants
    // (notably sdscc) silently drop plain-text stdout from PreToolUse — the previous
    // console.log() form would render on stock CC but no-op on those variants.
    // Token budget: ~4 chars per token, 4000 token limit = 16000 chars.
    const portablePath = resolvedPath.startsWith(homedir()) ? '~' + resolvedPath.slice(homedir().length) : resolvedPath;
    // Defang the untrusted skill body + name before wrapping (audit 2026-08-14 M-4):
    // registry rows come from third-party repos, and this was the one AUTO injection
    // surface of that data with zero neutralization — a body carrying a literal
    // `</skill-bridge>` + forged <system-reminder> (or a `<skill-loaded>` execute
    // block) escaped the wrapper verbatim. Name additionally drops quote/bracket
    // chars: it lands in an ATTRIBUTE position, where `"` breaks out of the wrapper
    // tag itself. Applied to the truncated summary too (a cut can't be trusted to
    // land mid-tag).
    const defang = (s) => neutralizeSkillBridgeDelimiters(neutralizeSkillDelimiters(neutralizeContextDelimiters(s)));
    const safeName = String(row.name).replace(/["'<>]/g, '');
    let additionalContext;
    if (content.length > 16000) {
      const summary = defang(content.slice(0, 800));
      // D#122 ③: the path interpolates OUTSIDE the wrapper — defang it too (a
      // locally-created managed dir can carry delimiter chars in its name).
      additionalContext = `<skill-bridge name="${safeName}" source="managed" truncated="true">\n${summary}\n...\n</skill-bridge>\n\nSkill content truncated. Read("${defang(portablePath)}") to load full content.`;
    } else {
      additionalContext = `<skill-bridge name="${safeName}" source="managed">\n${defang(content)}\n</skill-bridge>\n\nThis skill was loaded from the managed registry. Follow the instructions above.`;
    }
    queueHookContext('PreToolUse', additionalContext);
    flushHookStdout();
  } catch (e) {
    // Silent failure — never block Skill tool, but record for self-observation.
    recordHookError('skill-bridge:query', e, RUNTIME_DIR, { skillName });
  } finally {
    try { db.close(); } catch {}
  }
} catch (e) {
  // Top-level catch — exit 0 no matter what, but record what slipped past.
  try { recordHookError('skill-bridge:top', e, RUNTIME_DIR); } catch {}
}
