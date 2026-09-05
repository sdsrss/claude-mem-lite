// hooks.json PreToolUse matcher ↔ pre-tool-recall.js whitelist drift guard.
//
// Two sources independently encode the same tool list:
//   1. hooks/hooks.json — `matcher: "Edit|Write|NotebookEdit|Read"` decides
//      which CC tool events even reach the script.
//   2. scripts/pre-tool-recall.js — the `!['Edit',...].includes(toolName)`
//      guard distinguishes "real tool name we know about, just no file_path"
//      from "tool name we don't recognize — log as unknown-tool noise."
//
// If the matcher gains a tool but the whitelist doesn't, the new tool's
// file-path-less events trip pre-recall:unknown-tool telemetry forever.
// If the whitelist gains a tool but the matcher doesn't, the handler is
// silently dead for that tool. Either direction is drift; this test fails
// loudly when they fall out of sync. Cheaper than a shared-constant
// cross-module refactor (hooks.json is static; can't import from JS).

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

function loadScriptWhitelist() {
  const src = readFileSync(join(REPO_ROOT, 'scripts/pre-tool-recall.js'), 'utf8');
  // Anchor on the exact unknown-tool branch — survives surrounding edits,
  // breaks loudly if the branch is renamed/removed (which would also signal
  // semantic drift worth a maintainer's attention).
  const m = src.match(/!\[\s*((?:'[^']+'\s*,?\s*)+)\]\.includes\(\s*toolName\s*\)/);
  if (!m) throw new Error('script whitelist array literal not found');
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]).sort();
}

describe('hooks.json matcher ↔ pre-tool-recall whitelist sync', () => {
  it('matcher tool set equals script whitelist', () => {
    const matcherTools = loadMatcherTools();
    const scriptTools = loadScriptWhitelist();
    expect(scriptTools).toEqual(matcherTools);
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
