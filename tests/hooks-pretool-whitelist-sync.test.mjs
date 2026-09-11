// hooks.json PreToolUse matcher ↔ pre-tool-recall.js whitelist drift guard.
//
// Two sources independently encode the same tool list:
//   1. hooks/hooks.json — `matcher: "Edit|Write|NotebookEdit|Read"` decides
//      which CC tool events even reach the script.
//   2. scripts/pre-tool-recall.js — the `HANDLED_TOOLS` constant, which decides
//      whether an event with no recognizable path field is "a tool we handle,
//      so this is an upstream field rename worth recording" or "a tool we don't
//      recognize — unknown-tool noise."
//
// If the matcher gains a tool but HANDLED_TOOLS doesn't, that tool's path-less
// events are filed as unknown-tool noise forever. If HANDLED_TOOLS gains a tool
// but the matcher doesn't, the handler is silently dead for that tool. Either
// direction is drift; this test fails loudly when they fall out of sync. Cheaper
// than a shared-constant cross-module refactor (hooks.json is static; the script
// has top-level side effects and cannot be imported).
//
// The anchor was an inline `!['Edit',...].includes(toolName)` literal until the
// R12 B-2 fix gave the list a name. Restated rather than loosened — and the
// second assertion below is new, because a scan that only finds the declaration
// would stay green if the constant were declared and never used.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function loadMatcherTools() {
  const hooksJson = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks/hooks.json'), 'utf8'));
  const preToolUse = hooksJson.hooks?.PreToolUse;
  if (!Array.isArray(preToolUse)) throw new Error('hooks.PreToolUse not an array');
  const recallEntry = preToolUse.find(
    (e) => Array.isArray(e.hooks) && e.hooks.some((h) => (h.command || '').includes('pre-tool-recall')),
  );
  if (!recallEntry) throw new Error('PreToolUse entry for pre-tool-recall not found');
  const matcher = recallEntry.matcher;
  if (typeof matcher !== 'string') throw new Error('matcher missing on pre-tool-recall entry');
  return matcher
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

function readScript() {
  return readFileSync(join(REPO_ROOT, 'scripts/pre-tool-recall.js'), 'utf8');
}

function loadScriptWhitelist() {
  const src = readScript();
  // Anchor on the named constant. Breaks loudly if it is renamed or removed,
  // which would also signal semantic drift worth a maintainer's attention.
  const m = src.match(/const HANDLED_TOOLS\s*=\s*\[((?:\s*'[^']+'\s*,?)+)\s*\]/);
  if (!m) throw new Error('HANDLED_TOOLS declaration not found');
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]).sort();
}

describe('hooks.json matcher ↔ pre-tool-recall whitelist sync', () => {
  it('matcher tool set equals script whitelist', () => {
    const matcherTools = loadMatcherTools();
    const scriptTools = loadScriptWhitelist();
    expect(scriptTools).toEqual(matcherTools);
  });

  // Premise assertion: the declaration this file scans has to be the one the
  // shape probe consults. Without it a declared-but-unused constant keeps the
  // sync check green while the probe branches on something else entirely.
  it('the declaration this guard reads is the one the shape probe branches on', () => {
    expect(readScript()).toMatch(/HANDLED_TOOLS\.includes\(\s*toolName\s*\)/);
  });

  it('both lists are non-empty and contain Edit', () => {
    const matcherTools = loadMatcherTools();
    const scriptTools = loadScriptWhitelist();
    expect(matcherTools.length).toBeGreaterThan(0);
    expect(scriptTools.length).toBeGreaterThan(0);
    expect(matcherTools).toContain('Edit');
    expect(scriptTools).toContain('Edit');
  });
});
