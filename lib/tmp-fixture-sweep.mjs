// Sweep stale claude-mem-lite test-fixture directories from temp dirs.
//
// Tests create sandboxes via mkdtempSync(join(tmpdir(), '<prefix>')) and clean
// them in afterEach — but an interrupted or SIGKILL'd vitest run never reaches
// afterEach, leaking the dir (and its DBs) forever. The cross-project audit
// found ~795MB of such residue (mem-e2e-* / mem-audit-* dominating). Per-test
// cleanup cannot survive SIGKILL, so we ALSO reap at the next run's start
// (globalSetup) and via `node install.mjs cleanup`.
//
// Safety: depth-1 only (no recursion — §8 forbids deep traversal of ~/.claude),
// age-gated so a concurrently-running suite isn't disturbed, and restricted to a
// conservative allowlist of clearly mem-namespaced prefixes so we never delete
// another tool's temp dirs (e.g. code-graph-mcp's `.tmp*`/`index.db`).

import { readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Prefixes used by THIS repo's mkdtempSync fixtures. Deliberately only the
// clearly mem-namespaced ones — generic prefixes some tests use (plans-/tasks-/
// metrics-/drift-/projects-/git-fixture-) are EXCLUDED to avoid collateral
// deletion of unrelated /tmp dirs.
export const TEST_FIXTURE_PREFIXES = [
  'mem-',
  'cite-',
  'memdir-',
  'adopt-',
  'citation-test-',
  'text-floor-',
  'unsaved-bugfix-',
  'hook-telemetry-',
  'hook-latency-',
  'quiet-hooks-',
  'silent-adopt-',
  'sweep-orphan-',
  'pre-recall-sandbox-',
  'err-sampler-',
  'cml-preflight-',
  'cli-audit-',
];

export const DEFAULT_FIXTURE_AGE_MS = 60 * 60 * 1000; // 1h — wide margin over the longest test

function isFixtureName(name) {
  return TEST_FIXTURE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Remove (or, with dryRun, list) stale test-fixture directories.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.dirs] temp roots to scan, depth-1 (default [os.tmpdir()])
 * @param {number} [opts.ageMs] only act on entries older than this (default 1h)
 * @param {boolean} [opts.dryRun] when true, list but do not delete
 * @param {number} [opts.now] injectable clock for tests
 * @returns {{removed: number, names: string[]}} absolute paths removed (or that would be)
 */
export function sweepStaleTestFixtures({
  dirs,
  ageMs = DEFAULT_FIXTURE_AGE_MS,
  dryRun = false,
  now = Date.now(),
} = {}) {
  const roots = dirs && dirs.length ? dirs : [tmpdir()];
  const cutoff = now - ageMs;
  const names = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!isFixtureName(name)) continue;
      const full = join(root, name);
      try {
        const st = statSync(full);
        if (!st.isDirectory()) continue;
        if (st.mtimeMs >= cutoff) continue; // too fresh — may be an in-flight run
        if (!dryRun) rmSync(full, { recursive: true, force: true });
        names.push(full);
      } catch {
        /* concurrent unlink / permission — ignore */
      }
    }
  }
  return { removed: names.length, names };
}
