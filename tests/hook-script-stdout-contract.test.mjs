// Every registered hook script writes its envelope through lib/hook-stdout.mjs — D#154.
//
// Claude Code parses a command hook's stdout with (2.1.241 bundle, same shape as the
// 2.1.233 one quoted in lib/hook-stdout.mjs):
//
//   let t = e.trim();
//   if (!t.startsWith("{")) return { plainText: e };   // whole stdout = prose
//   try { return XZf(t) } catch { return { plainText: e } }   // JSON.parse(WHOLE stdout)
//
// There is no line splitting, so a hook process's stdout has exactly three legal shapes:
// empty, ONE JSON document, or prose with no envelope anywhere in it. Two documents — or
// an envelope appended after prose — degrade to plainText, which SessionStart and
// UserPromptSubmit inject as literal escaped JSON and every other event drops in silence.
// That is the v3.70.0 defect.
//
// ─── what this file does NOT do ─────────────────────────────────────────────────────
//
// It does not re-test the shape. tests/feature-sweep-hooks.test.mjs::expectHookStdout
// already spawns all six registered entry points and asserts exactly that, and it was
// checked here by mutation rather than by reading: appending a second envelope in
// pre-tool-recall.js (twice, two different branches) and queueing one behind hook.mjs's
// prose user-prompt writer each turned that suite red on its own. A behavioural leg here
// would have been a slower copy with no additional kill-power.
//
// ─── what it does ───────────────────────────────────────────────────────────────────
//
// The shape guard cannot see the thing D#154 is actually about. A script that hand-writes
// ONE well-formed envelope passes every existing assertion — which is precisely the state
// the four standalone scripts were in, and precisely how a second write gets added later
// without anything going red until it ships. So:
//
//   1. STRUCTURAL — no registered entry point may CONSTRUCT an envelope; only
//      lib/hook-stdout.mjs assembles one. Stated precisely, because an earlier version of
//      this header overclaimed (pre-tag review, v3.80.0): this does NOT make a second
//      document impossible — a site that flushes immediately after queueing can still be
//      followed by another queue+flush. It makes the assembly checkable in one place, and
//      makes merging AVAILABLE to a caller that defers its flush. Reverting any one script
//      to a hand-written envelope — in object-literal OR assignment form — turns it red.
//   2. COVERAGE — every registered entry point must appear in the behavioural sweep. Both
//      lists were hand-maintained, so a hook added to the manifest was previously born
//      with no shape coverage and nothing said so.
//
// The registered set is DERIVED from hooks/hooks.json (following the .sh prefilters it
// names), not hand-listed here, for the same reason.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const REPO = resolve(import.meta.dirname, '..');
const HOOKS_JSON = join(REPO, 'hooks', 'hooks.json');
const SWEEP = join(REPO, 'tests', 'feature-sweep-hooks.test.mjs');

/** The one module allowed to assemble an envelope. */
const WRITER = 'lib/hook-stdout.mjs';

// ─── deriving the registered set ────────────────────────────────────────────

/**
 * Node entry points reachable from hooks/hooks.json.
 *
 * Two indirections have to be followed or the set comes back short:
 *   • every node hook runs through `hook-launcher.mjs <entry>`, so the entry is the
 *     launcher's ARGUMENT, not the command's script;
 *   • two events dispatch a bash prefilter (`pre-agent-inject.sh`, `post-tool-use.sh`)
 *     which then execs the real node entry — pre-agent-inject.js is reachable ONLY
 *     through that hop, and a manifest-only scan misses it silently.
 */
function registeredNodeEntries() {
  const manifest = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const commands = [];
  for (const matchers of Object.values(manifest.hooks || {})) {
    for (const m of matchers) for (const h of m.hooks || []) if (h.command) commands.push(h.command);
  }
  for (const cmd of [...commands]) {
    const sh = cmd.match(/scripts\/([\w.-]+\.sh)/);
    if (!sh) continue;
    const p = join(REPO, 'scripts', sh[1]);
    if (existsSync(p)) commands.push(readFileSync(p, 'utf8'));
  }
  const entries = new Set();
  for (const text of commands) {
    for (const m of text.matchAll(/hook-launcher\.mjs["']?\s+(\S+)/g)) {
      const entry = m[1].replace(/["']/g, '');
      if (/\.(mjs|js)$/.test(entry)) entries.add(entry);
    }
  }
  return [...entries].sort();
}

/**
 * Strip comments so a prose mention of the envelope is not read as a write. Every one of
 * these files DISCUSSES hookSpecificOutput in its header; matching raw text would make
 * the guard fire on documentation and force it to be weakened into uselessness.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * An envelope being CONSTRUCTED — in EITHER position.
 *
 * The first version of this matched only `hookSpecificOutput:` (object-literal position),
 * which the v3.80.0 pre-tag review showed is the wrong half: the repo's own canonical way
 * to assemble one is ASSIGNMENT — `lib/hook-stdout.mjs` writes
 * `envelope.hookSpecificOutput = {...}`, and the assertion below pins exactly that shape.
 * So the guard's own neighbour documented the form that evaded it, and a hand-written
 * envelope in assignment form passed both this sweep and the behavioural one.
 *
 * The writer module is exempt by PATH (it is excluded from `entries`), never by syntax.
 */
const ENVELOPE_LITERAL = /\bhookSpecificOutput\s*[:=]/;

describe('hook stdout contract — one writer (D#154)', () => {
  const entries = registeredNodeEntries();

  // Self-check FIRST. A derivation that silently matched nothing would make every
  // assertion below vacuously green — the failure mode where a guard reports clean
  // because it never looked. Pinned to the exact set so adding a hook to the manifest
  // lands here deliberately rather than by omission.
  it('derives the registered node entry points from the manifest, including the .sh hop', () => {
    expect(entries).toEqual([
      'hook.mjs',
      'scripts/post-tool-recall.js',
      'scripts/pre-agent-inject.js',
      'scripts/pre-skill-bridge.js',
      'scripts/pre-tool-recall.js',
      'scripts/user-prompt-search.js',
    ]);
  });

  it.each(registeredNodeEntries())('%s assembles no envelope of its own', (entry) => {
    const src = stripComments(readFileSync(join(REPO, entry), 'utf8'));
    expect(
      ENVELOPE_LITERAL.test(src),
      `${entry} constructs a hookSpecificOutput literal. Route it through ${WRITER} ` +
        `(queueHookContext / queueHookUpdatedInput, then flushHookStdout) so a second emit ` +
        `merges into one document instead of appending a second one the host cannot read.`,
    ).toBe(false);
  });

  // The matcher above only proves something when it CAN fire, and the stripper only helps
  // if it does not eat a real construction. Both halves checked, because the whole guard
  // rests on this one regex.
  it('the structural matcher fires on BOTH construction forms and spares a comment', () => {
    const literalForm =
      'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "X" } }))';
    // Assignment form. Caught by the v3.80.0 pre-tag review as an unguarded door: it is
    // the shape lib/hook-stdout.mjs itself uses, so it is the shape a reverting author
    // would most plausibly copy.
    const assignForm =
      'const out = { suppressOutput: true };\nout.hookSpecificOutput = { hookEventName: "X" };';
    const discussed = '// we used to write hookSpecificOutput: here\n/* hookSpecificOutput = */ const x = 1;';
    expect(ENVELOPE_LITERAL.test(stripComments(literalForm))).toBe(true);
    expect(ENVELOPE_LITERAL.test(stripComments(assignForm))).toBe(true);
    expect(ENVELOPE_LITERAL.test(stripComments(discussed))).toBe(false);
  });

  it('the writer module is the single place an envelope is assembled', () => {
    expect(readFileSync(join(REPO, WRITER), 'utf8')).toMatch(/envelope\.hookSpecificOutput\s*=/);
  });
});

describe('hook stdout contract — every registered entry has behavioural coverage', () => {
  /** Surface labels the behavioural sweep passes to expectHookStdout. */
  function sweepLabels() {
    const src = readFileSync(SWEEP, 'utf8');
    return [...src.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
  }

  it('reads the sweep labels (a zero-label scrape would pass everything below)', () => {
    // Self-check on the scrape itself, not on the thing being scraped: if the label
    // syntax in the sweep changes, this fails loudly instead of green-lighting an
    // unguarded hook.
    expect(sweepLabels().length).toBeGreaterThanOrEqual(8);
  });

  it.each(registeredNodeEntries())('%s is exercised by feature-sweep-hooks', (entry) => {
    // Match on the file stem, not the path: pre-agent-inject.js is reached through
    // pre-agent-inject.sh, so the sweep labels it by the shell entry point.
    const stem = entry.replace(/^scripts\//, '').replace(/\.(mjs|js)$/, '');
    const labels = sweepLabels();
    expect(
      labels.some((l) => l.includes(stem)),
      `${entry} is registered in hooks/hooks.json but no expectHookStdout label in ` +
        `tests/feature-sweep-hooks.test.mjs mentions "${stem}" — its stdout shape is ` +
        `unguarded. Labels found: ${labels.join(', ')}`,
    ).toBe(true);
  });
});
