#!/usr/bin/env node
// scripts/green-stamp.mjs — let the pre-commit gate reuse a full-suite pass on the SAME tree.
//
// Why: the session-history audit (docs/audits/20260925-200912-session-history-analysis.md
// §3) measured 395 `git commit` calls at a 44.2 s median, 4.35 h in total, and the agent's
// habit is "run the full suite, then commit" — so pre-commit re-ran a suite that had just
// passed on byte-identical files, once per commit.
//
// The contract, in the order it is checked:
//   1. The stamp is written ONLY by scripts/green-stamp-reporter.mjs, at the end of a vitest
//      run that (a) passed, (b) ran every test file the config collects, with no name
//      filter, shard or changed/related scoping, and (c) saw the same key at its start and
//      at its end — so an edit made while the suite ran cannot be certified by it.
//   2. `check` reuses the stamp only when the working tree has no unstaged change to a
//      tracked file. The commit is the INDEX; with nothing unstaged the index and the
//      tested tracked content are the same bytes.
//   3. The key covers every tracked and untracked-but-not-ignored file by content (git
//      blob ids), every symlink by its target and every gitlink by its index commit, plus
//      the node version. Untracked files are in the key because vitest collects them too —
//      tests/obs-id-caliber-sync.test.mjs emits a case per source file, scratch included.
//   4. The stamp expires after STAMP_MAX_AGE_MS: a date-dependent test (the benchmark
//      baseline expires by date) can go red on bytes that never changed.
//   5. A run that does not load the reporter cannot judge itself, so `setup` below (a
//      vitest globalSetup) clears the stamp when the resolved reporters lack it: a
//      `--reporter=dot` run REPLACES the configured reporters, and a red one used to leave
//      the older green in place (v6.13.0 delta review P3-1). A green one clears it too;
//      that costs one full run at the next commit, which is the safe direction.
//
// Nothing here can make a red suite pass: a miss runs `npm test` exactly as before, and
// CI still runs the full matrix on push. `PRE_COMMIT_FULL_TEST=1` forces the run.
//
// The stamp lives under the repository's own git dir (`git rev-parse --git-path`), so it
// is per worktree, never committed and never user-global.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, isAbsolute, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

export const STAMP_NAME = 'mem-lite-green-stamp.json';
export const STAMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function git(args, cwd, input) {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function stampPath(cwd) {
  const p = git(['rev-parse', '--git-path', STAMP_NAME], cwd).trim();
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Content key of what a vitest run in `cwd` would collect: every tracked and
 * untracked-not-ignored path that exists as a regular file, with its blob id, every such
 * path that is a symlink, with its target text, and every gitlink, with the commit the
 * index records for it.
 * A tracked file deleted from the working tree drops out of the list, which changes the key.
 */
export function computeTreeKey(cwd, { nodeVersion = process.version } = {}) {
  const top = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const paths = git(['ls-files', '-z', '-c', '-o', '--exclude-standard'], top).split('\0').filter(Boolean);
  // `ls-files` repeats a path once per index stage during a conflicted merge; dedupe, and
  // sort so the key does not depend on listing order.
  const files = [];
  const links = [];
  for (const p of [...new Set(paths)].sort()) {
    let st;
    try {
      st = lstatSync(join(top, p));
    } catch {
      continue;
    }
    // `hash-object` follows a symlink, so retargeting one to an identical file would not move
    // the key; the target text does (v6.13.0 defect review P3-2).
    if (st.isSymbolicLink()) links.push(`link ${readlinkSync(join(top, p))} ${p}`);
    else if (st.isFile()) files.push(p);
  }
  // A gitlink is a directory on disk, so the loop above skips it; its identity is the commit
  // in the index. `git diff --quiet` in checkStamp already sees a submodule whose checkout
  // moved away from that commit.
  const gitlinks = git(['ls-files', '-z', '-s'], top)
    .split('\0')
    .filter((e) => e.startsWith('160000 '))
    .map((e) => `gitlink ${e}`)
    .sort();
  const ids = files.length
    ? git(['hash-object', '--stdin-paths'], top, files.join('\n') + '\n').split('\n')
    : [];
  const h = createHash('sha256');
  h.update(`runtime ${nodeVersion}\n`);
  files.forEach((p, i) => h.update(`${ids[i]} ${p}\n`));
  [...links, ...gitlinks].forEach((l) => h.update(`${l}\n`));
  return h.digest('hex');
}

function hasUnstagedTrackedChange(cwd) {
  try {
    git(['diff', '--quiet'], cwd);
    return false;
  } catch {
    return true;
  }
}

export function recordStamp(cwd, key, { now = Date.now() } = {}) {
  const path = stampPath(cwd);
  atomicWriteFileSync(path, JSON.stringify({ key, node: process.version, at: now }) + '\n');
  return path;
}

export function clearStamp(cwd) {
  rmSync(stampPath(cwd), { force: true });
}

/** Whether a resolved vitest `reporters` list loads green-stamp-reporter.mjs. */
export function loadsStampReporter(reporters) {
  if (!Array.isArray(reporters)) return false;
  return reporters.some((r) => {
    const name = Array.isArray(r) ? r[0] : r;
    return typeof name === 'string' && basename(name) === 'green-stamp-reporter.mjs';
  });
}

/**
 * vitest globalSetup (registered in vitest.config.mjs): a run whose reporters do not include
 * the stamp reporter can neither certify nor de-certify its tree, so it clears the stamp.
 */
export function setup(project) {
  const config = project?.vitest?.config;
  if (!config || loadsStampReporter(config.reporters)) return;
  try {
    clearStamp(config.root);
  } catch {
    /* not a git checkout: there is no stamp */
  }
}

/**
 * @returns {{ reuse: boolean, reason: string }}
 */
export function checkStamp(cwd, { env = process.env, now = Date.now() } = {}) {
  if (env.PRE_COMMIT_FULL_TEST === '1') return { reuse: false, reason: 'PRE_COMMIT_FULL_TEST=1' };
  const path = stampPath(cwd);
  if (!existsSync(path)) return { reuse: false, reason: 'no green stamp' };
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { reuse: false, reason: 'unreadable green stamp' };
  }
  const age = now - stamp.at;
  if (!(age >= 0 && age <= STAMP_MAX_AGE_MS)) {
    return { reuse: false, reason: `green stamp older than ${STAMP_MAX_AGE_MS / 3_600_000} h` };
  }
  if (hasUnstagedTrackedChange(cwd)) return { reuse: false, reason: 'unstaged changes to tracked files' };
  const key = computeTreeKey(cwd);
  if (stamp.key !== key) return { reuse: false, reason: 'tree differs from the last full green run' };
  return {
    reuse: true,
    reason: `full suite passed on this exact tree at ${new Date(stamp.at).toISOString()}`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'check') {
    let res;
    try {
      res = checkStamp(process.cwd());
    } catch (e) {
      res = { reuse: false, reason: `stamp check failed: ${e?.message || e}` };
    }
    process.stdout.write(`${res.reason}\n`);
    process.exit(res.reuse ? 0 : 1);
  } else if (cmd === 'key') {
    process.stdout.write(`${computeTreeKey(process.cwd())}\n`);
  } else {
    process.stderr.write('usage: green-stamp.mjs check|key\n');
    process.exit(2);
  }
}
