// Regression test for GitHub issue #14: npm package ships without files that
// user-facing entry points (hook.mjs / server.mjs / mem-cli.mjs) statically
// import, causing ERR_MODULE_NOT_FOUND on first SessionStart.
//
// The test parses every `import ... from './xxx.mjs'` in a fixed set of
// user-facing entry modules, walks the resulting static dependency graph,
// and asserts that every relative-imported local module is listed in
// package.json's `files` array. This catches additions to SOURCE_FILES in
// install.mjs that forgot to also update package.json.
//
// Dynamic imports (await import(...)) are ALSO walked because hook.mjs does
// `await import('./lib/startup-dashboard.mjs')` and a missing file there
// breaks lazy code paths just as surely (only lazier).

import { test, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, resolve, relative } from 'path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const FILES = new Set(PKG.files);

const ENTRY_MODULES = ['cli.mjs', 'hook.mjs', 'server.mjs', 'mem-cli.mjs', 'install.mjs'];

function extractLocalImports(sourcePath) {
  const src = readFileSync(sourcePath, 'utf8');
  const out = new Set();
  // Static: `import ... from './path'` or `import './path'`
  for (const m of src.matchAll(/(?:from|import)\s+['"](\.\/[^'"]+)['"]/g)) {
    out.add(m[1]);
  }
  // Dynamic: `import('./path')` or `await import('./path')`
  for (const m of src.matchAll(/import\s*\(\s*['"](\.\/[^'"]+)['"]/g)) {
    out.add(m[1]);
  }
  return out;
}

function walk(entryRel, seen = new Set()) {
  if (seen.has(entryRel)) return seen;
  seen.add(entryRel);
  const abs = resolve(ROOT, entryRel);
  if (!existsSync(abs)) return seen;
  const imports = extractLocalImports(abs);
  for (const rel of imports) {
    const resolved = resolve(dirname(abs), rel);
    const relFromRoot = relative(ROOT, resolved);
    // Only follow .mjs/.js — .md files are static assets.
    if (/\.(mjs|js)$/.test(relFromRoot)) walk(relFromRoot, seen);
    else seen.add(relFromRoot);
  }
  return seen;
}

test('every module statically or dynamically imported by an entry point is shipped in the npm tarball', () => {
  const shipped = new Set(FILES);
  const missing = [];
  for (const entry of ENTRY_MODULES) {
    const reached = walk(entry);
    for (const mod of reached) {
      if (mod === entry) continue; // entries themselves are listed
      if (!shipped.has(mod)) missing.push(`${mod} (transitively reached from ${entry})`);
    }
  }
  const unique = [...new Set(missing)].sort();
  expect(unique, `\npackage.json "files" is missing:\n  ${unique.join('\n  ')}\n`).toEqual([]);
});

test('no stale entry in package.json files points at a non-existent path', () => {
  // npm-shrinkwrap.json exists ONLY at release time (`npm shrinkwrap` runs in
  // publish.yml; npm packs it solely when files[] lists it — v3.58.1). Never
  // present in the dev tree, so it is release-generated, not stale.
  const RELEASE_GENERATED = new Set(['npm-shrinkwrap.json']);
  const dangling = [];
  for (const f of FILES) {
    if (RELEASE_GENERATED.has(f)) continue;
    const abs = resolve(ROOT, f);
    if (!existsSync(abs)) dangling.push(f);
  }
  expect(dangling).toEqual([]);
});

test('every slash command in commands/ ships in the npm tarball (v2.32.3 code-review finding)', () => {
  // The static-import walker above only follows .mjs/.js files, so asset-style
  // markdown files (commands/<name>.md, read by Claude Code's slash-command
  // registry) can slip past the gate. This test catches that blind spot: all
  // commands/*.md on disk must appear in package.json.files.
  const commandsDir = resolve(ROOT, 'commands');
  const onDisk = readdirSync(commandsDir).filter((f) => f.endsWith('.md'));
  const missing = onDisk.map((f) => `commands/${f}`).filter((p) => !FILES.has(p));
  expect(missing, `\npackage.json "files" missing slash commands:\n  ${missing.join('\n  ')}\n`).toEqual([]);
});
