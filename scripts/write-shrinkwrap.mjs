#!/usr/bin/env node
// Write npm-shrinkwrap.json for the published tarball: package-lock.json without its dev-only
// entries (D#170).
//
// npm never packs package-lock.json, so publish.yml locks the registry tarball with a
// shrinkwrap. It used `npm shrinkwrap`, which copies the lockfile whole, and npm installs a
// dependency's shrinkwrap whole: `npm install claude-mem-lite@6.19.3` put vitest, eslint, knip
// and prettier under node_modules/claude-mem-lite (npm 11.19.0: 300 packages / 533 MB; npm
// 10.9.2: 237 / 172 MB; unlocked: 97 / 57 MB — docs/audits/20260929-v6.19.4-release-review.md
// P2-2), and `npm audit --omit=dev` never looked at that tree. npm 10's `npm shrinkwrap` also
// dropped the `libc` fields of 18 dev-optional bindings; copying the lockfile's own entries
// keeps every field as it is.
//
// Dropped: entries flagged `dev` (dev-only, including dev AND optional). Kept: everything a
// dependent installs — production, `optional`, `devOptional` (reached from production through
// an optional edge), and `peer` entries that are not dev-only.
//
// Self-checking: the kept set must be exactly the closure of the root's dependencies,
// optionalDependencies and peerDependencies, resolved the way node_modules resolves a name
// (nearest ancestor first). A dropped entry that production reaches, or a kept entry nothing
// reaches, fails the script, so a lockfile whose flags disagree with its own graph cannot
// ship a broken lock.
//
// Usage: node scripts/write-shrinkwrap.mjs [--lock <path>] [--out <path>]   (default: repo root)

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where node_modules resolution finds `name` from the package at `fromKey`, or null.
 * @param {Record<string, object>} packages lockfile `packages`
 * @param {string} fromKey '' for the root, else a `node_modules/...` key
 * @param {string} name
 * @returns {string|null}
 */
function resolveFrom(packages, fromKey, name) {
  let base = fromKey;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i === -1 ? '' : base.slice(0, i);
  }
}

/**
 * Keys production reaches: the closure over dependencies, optionalDependencies and
 * peerDependencies from the root. A missing optional or optional-peer target is allowed
 * (a platform binding absent from the lock); any other missing target is returned in `missing`.
 * @param {Record<string, object>} packages
 * @returns {{reached: Set<string>, missing: string[]}}
 */
export function productionClosure(packages) {
  const reached = new Set();
  const missing = [];
  const queue = [''];
  while (queue.length) {
    const from = queue.shift();
    const e = packages[from] || {};
    const optionalPeers = new Set(
      Object.entries(e.peerDependenciesMeta || {})
        .filter(([, m]) => m?.optional)
        .map(([n]) => n),
    );
    const edges = [
      ...Object.keys(e.dependencies || {}).map((n) => [n, false]),
      ...Object.keys(e.optionalDependencies || {}).map((n) => [n, true]),
      ...Object.keys(e.peerDependencies || {}).map((n) => [n, optionalPeers.has(n)]),
    ];
    for (const [name, optional] of edges) {
      const to = resolveFrom(packages, from, name);
      if (!to) {
        if (!optional) missing.push(`${from || '(root)'} -> ${name}`);
        continue;
      }
      if (!reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
    }
  }
  return { reached, missing };
}

/**
 * Throws unless `sw` is a publishable shrinkwrap: no dev-only entry, and closed under
 * production's dependency graph (nothing it needs missing, nothing kept that it does not reach).
 * smoke-tarball.mjs runs this on the copy inside the packed tarball.
 * @param {object} sw parsed npm-shrinkwrap.json
 */
export function verifyShrinkwrap(sw) {
  const packages = sw?.packages;
  if (!packages || typeof packages !== 'object') throw new Error('shrinkwrap has no `packages` map');
  const dev = Object.keys(packages).filter((k) => k && packages[k]?.dev === true);
  if (dev.length)
    throw new Error(`shrinkwrap carries ${dev.length} dev-only entries (${dev.slice(0, 3).join(', ')}…)`);
  const { reached, missing } = productionClosure(packages);
  const unreached = Object.keys(packages).filter((k) => k && !reached.has(k) && !packages[k].link);
  if (missing.length || unreached.length) {
    throw new Error(
      `shrinkwrap is not closed under production deps: missing ${JSON.stringify(missing)}, ` +
        `kept but unreached ${JSON.stringify(unreached)}`,
    );
  }
}

/**
 * The shrinkwrap object for a lockfile: same document, dev-only entries dropped.
 * Throws when the result is not closed under production's dependency graph.
 * @param {object} lock parsed package-lock.json (lockfileVersion 2 or 3)
 * @returns {{shrinkwrap: object, dropped: string[]}}
 */
export function buildShrinkwrap(lock) {
  if (!lock?.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json has no `packages` map (lockfileVersion >= 2 required)');
  }
  const packages = {};
  const dropped = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key && entry?.dev === true) dropped.push(key);
    else packages[key] = entry;
  }
  // `dependencies` is the lockfileVersion 1 tree, written only for npm 6; v3 has none.
  const { dependencies: _legacyTree, ...rest } = lock;
  const shrinkwrap = { ...rest, packages };
  verifyShrinkwrap(shrinkwrap);
  return { shrinkwrap, dropped };
}

function main(argv) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const arg = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i === -1 ? dflt : argv[i + 1];
  };
  const lockPath = arg('--lock', join(repo, 'package-lock.json'));
  const outPath = arg('--out', join(repo, 'npm-shrinkwrap.json'));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const { shrinkwrap, dropped } = buildShrinkwrap(lock);
  writeFileSync(outPath, JSON.stringify(shrinkwrap, null, 2) + '\n');
  const kept = Object.keys(shrinkwrap.packages).length - 1;
  console.log(`[write-shrinkwrap] ${outPath}: kept ${kept} entries, dropped ${dropped.length} dev-only`);
}

// Compared by real path: node resolves a symlinked entry to the module's real file, so a plain
// string compare made a run through a symlink exit 0 having written nothing.
const invokedDirectly = (() => {
  try {
    return (
      !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[write-shrinkwrap] ${e.message}`);
    process.exit(1);
  }
}
