// launch-preflight.mjs — Detect incomplete installs at MCP server launch.
//
// Why: issue #15 — published v2.53.0 npm tarball contains all files, but some
// users end up with a partial install (server.mjs present, search-engine.mjs
// missing) and the resulting ERR_MODULE_NOT_FOUND has no actionable message.
// We can't fix every cause (mirror lag / interrupted download / npm cache
// corruption / permission) on the user side, but we can detect the broken
// state and either fall back to ~/.claude-mem-lite/ (which hook-update.mjs
// keeps healthy) or print a clear repair command instead of a Node stack.
//
// Pure module — no I/O at import time, all deps injected. Tested in isolation;
// scripts/launch.mjs wires it to the actual filesystem + stderr.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Match relative `.mjs` imports — covers all four ESM forms:
//   from './x.mjs'                    (static named/default/namespace)
//   import './x.mjs'                  (side-effect static)
//   await import('./x.mjs')           (dynamic)
//   import('./x.mjs') without await   (dynamic)
// Skips 'node:*' / package imports / non-mjs paths.
const FROM_RE = /\bfrom\s+['"](\.\/[^'"]+\.mjs)['"]/g;
const IMPORT_RE = /\bimport\s*\(?\s*['"](\.\/[^'"]+\.mjs)['"]/g;

export function detectMissingImports(installRoot) {
  const serverPath = join(installRoot, 'server.mjs');
  if (!existsSync(serverPath)) return ['server.mjs'];

  let src;
  try {
    src = readFileSync(serverPath, 'utf8');
  } catch {
    return ['server.mjs'];
  }

  // Strip line + block comments so example strings in docblocks (e.g. the very
  // patterns this regex enumerates) can't false-fire as "missing files".
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

  const missing = new Set();
  for (const re of [FROM_RE, IMPORT_RE]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const rel = m[1].replace(/^\.\//, '');
      if (!existsSync(join(installRoot, rel))) missing.add(rel);
    }
  }
  return [...missing];
}

export function resolveLaunchEntry({ primaryRoot, fallbackRoot, warn = () => {} }) {
  const primaryMissing = detectMissingImports(primaryRoot);
  if (primaryMissing.length === 0) {
    return { path: join(primaryRoot, 'server.mjs'), source: 'primary' };
  }

  if (fallbackRoot && fallbackRoot !== primaryRoot) {
    const fallbackMissing = detectMissingImports(fallbackRoot);
    if (fallbackMissing.length === 0) {
      warn(
        `[claude-mem-lite] Primary install incomplete at ${primaryRoot} ` +
          `(missing: ${primaryMissing.join(', ')}). Falling back to ${fallbackRoot}.`,
      );
      return {
        path: join(fallbackRoot, 'server.mjs'),
        source: 'fallback',
        missingFromPrimary: primaryMissing,
      };
    }
  }

  const repairCmd = 'npm install -g claude-mem-lite@latest --force';
  const err = new Error(
    `[claude-mem-lite] Install incomplete at ${primaryRoot}\n` +
      `[claude-mem-lite]   Missing: ${primaryMissing.join(', ')}\n` +
      `[claude-mem-lite] Repair: ${repairCmd}\n` +
      `[claude-mem-lite] Or via Claude Code: /plugin uninstall claude-mem-lite && /plugin install claude-mem-lite@sdsrss`,
  );
  err.code = 'INSTALL_INCOMPLETE';
  err.missing = primaryMissing;
  throw err;
}
