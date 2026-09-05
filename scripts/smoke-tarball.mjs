#!/usr/bin/env node
// Real-install smoke test (audit item ①).
//
// The riskiest install path — `npm pack` → real `npm install` of the tarball →
// better-sqlite3 native rebuild → import entry points → open a DB — is exercised
// by NOTHING else in CI:
//   * install-e2e.test.mjs runs `--dev` (symlinks, skips `npm install`);
//   * hook-update.test.mjs mocks ALL tarball download/extract I/O;
//   * npm-tarball-completeness.test.mjs checks file inclusion STATICALLY.
// This script closes that gap end-to-end: it builds the actual publishable
// artifact and proves a clean machine can install it, (re)build the native
// addon, import the package, and open the DB.
//
// Guards in one shot: #8719 (lockfile / native-binding shape drift between the
// developer's npm and the user's npm), a better-sqlite3 ABI break, and tarball
// runtime completeness (a missing root .mjs that static import analysis misses
// surfaces here as an import crash).
//
// Dev-only: NOT listed in package.json "files", so it never ships in the
// tarball. Run locally with `node scripts/smoke-tarball.mjs`; CI runs it in the
// `smoke` job (.github/workflows/ci.yml). Exit 0 = pass, non-zero = the
// published tarball is broken.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const KEEP = process.argv.includes('--keep'); // leave the workdir for debugging
const log = (m) => process.stdout.write(`[smoke] ${m}\n`);
const fail = (m) => {
  process.stderr.write(`[smoke] FAIL: ${m}\n`);
  process.exit(1);
};

// Run a command; inherit stderr so npm/native build errors stay visible, capture
// stdout for assertions. Throws (non-zero exit) propagate as a failed smoke run.
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

const work = mkdtempSync(join(tmpdir(), 'mem-smoke-'));
const installDir = join(work, 'install');
const dataDir = join(work, 'data'); // sandboxed CLAUDE_MEM_DIR — never touches the real ~/.claude-mem-lite
mkdirSync(installDir, { recursive: true });
// CI npm-12 job sets this: REQUIRE the script block to occur and the shipped
// heal to fire (see step 3b).
const expectBlock = process.env.SMOKE_EXPECT_SCRIPT_BLOCK === '1';

try {
  // 1. Build the real publishable tarball (same artifact `npm publish` ships).
  log('npm pack …');
  const packJson = sh('npm', ['pack', '--json', '--pack-destination', work], { cwd: REPO_ROOT });
  // npm 10 `npm pack --json` returns an array [{filename,…}]; npm 12 returns an
  // object keyed by package name {"<name>": {…}} with NO filename field. Handle
  // both: normalize to the single entry, then use its filename or derive the
  // canonical pack name (scope '@' dropped, '/' → '-').
  const packOut = JSON.parse(packJson);
  const packInfo = Array.isArray(packOut) ? packOut[0] : Object.values(packOut)[0];
  const packName =
    packInfo.filename || `${packInfo.name.replace(/^@/, '').replace(/\//g, '-')}-${packInfo.version}.tgz`;
  const tgz = join(work, packName);
  log(`packed ${packName}`);

  // 1b. Shrinkwrap inclusion (v3.58.0 regression class): when the release
  //     pipeline has generated npm-shrinkwrap.json (publish.yml runs
  //     `npm shrinkwrap` before this smoke), the tarball MUST carry it — npm's
  //     packlist silently drops it unless files[] lists it, which is exactly
  //     how v3.58.0 shipped unlocked despite the workflow step running. In dev
  //     and plain CI the file doesn't exist, so the check self-skips.
  if (existsSync(join(REPO_ROOT, 'npm-shrinkwrap.json'))) {
    const entries = sh('tar', ['-tzf', tgz]);
    if (!entries.includes('package/npm-shrinkwrap.json')) {
      fail(
        'repo has npm-shrinkwrap.json but the packed tarball does not — packlist dropped it (files[] entry missing?)',
      );
    }
    log('shrinkwrap OK — npm-shrinkwrap.json is in the tarball');
  }

  // 2. Install into a clean throwaway project. This is where better-sqlite3 is
  //    fetched/rebuilt for the target runtime — the step --dev installs skip.
  //    Under SMOKE_EXPECT_SCRIPT_BLOCK=1, pin the npm >= 12 script block via a
  //    project .npmrc (npm 12 rejects --allow-scripts/env for project-scoped
  //    installs with EALLOWSCRIPTS; a project .npmrc is the sanctioned place,
  //    beats any user-level allowlist, and is an ignored unknown key on npm 10).
  log('npm install <tarball> (clean dir, rebuilds better-sqlite3) …');
  if (expectBlock) {
    writeFileSync(join(installDir, '.npmrc'), 'allow-scripts=none\n');
    log('SMOKE_EXPECT_SCRIPT_BLOCK=1 — pinned project .npmrc allow-scripts=none');
  }
  sh('npm', ['init', '-y'], { cwd: installDir });
  sh('npm', ['install', tgz, '--no-audit', '--no-fund'], { cwd: installDir });

  const cli = join(installDir, 'node_modules', 'claude-mem-lite', 'cli.mjs');

  // 3a. Entry point loads + package wiring is intact.
  const ver = sh('node', [cli, '--version'], { cwd: installDir }).trim();
  if (!/^claude-mem-lite v\d+\.\d+\.\d+/.test(ver)) fail(`unexpected --version output: ${ver}`);
  log(`entry OK — ${ver}`);

  // 3b. Native binding works: resolve better-sqlite3 from the INSTALLED tree
  //     (exactly as the package does) and open :memory:. Isolates a native ABI
  //     failure from a JS/CLI failure.
  //
  //     npm >= 12 blocks install/lifecycle scripts by default, so on a pristine
  //     npm-12 machine step 2 leaves better-sqlite3 present-but-uncompiled and
  //     this probe fails. That is the -32000 class the shipped self-heal exists
  //     for — so instead of failing outright, exercise the heal the way
  //     launch.mjs does: run the INSTALLED package's own
  //     lib/binding-probe.mjs::ensureBetterSqlite3Working, then re-probe.
  //     SMOKE_EXPECT_SCRIPT_BLOCK=1 (the CI npm-12 job) additionally REQUIRES
  //     the block to occur and the heal to fire — if npm's default changes and
  //     the block stops happening, the job fails loudly rather than silently
  //     testing nothing.
  const probe = join(work, 'probe.mjs');
  writeFileSync(
    probe,
    [
      "import { createRequire } from 'node:module';",
      `const require = createRequire(${JSON.stringify(join(installDir, 'package.json'))});`,
      "const Database = require('better-sqlite3');",
      "const db = new Database(':memory:');",
      "db.exec('CREATE TABLE t(x)'); db.prepare('INSERT INTO t VALUES (1)').run();",
      "const n = db.prepare('SELECT count(*) AS c FROM t').get().c; db.close();",
      "if (n !== 1) { console.error('bad count', n); process.exit(3); }",
      "process.stdout.write('native-ok');",
    ].join('\n'),
  );
  // Unlike sh(), the probe swallows stderr: its FIRST run is EXPECTED to fail
  // under the npm >= 12 block, and an expected failure should not dump a full
  // Node error stack into the smoke log.
  const tryProbe = () => {
    try {
      return (
        execFileSync('node', [probe], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: installDir,
        }) === 'native-ok'
      );
    } catch {
      return false;
    }
  };
  let healed = false;
  if (!tryProbe()) {
    log(
      'binding unusable after npm install (npm >= 12 script block or ABI drift) — exercising the shipped heal …',
    );
    const healSrc = [
      `const m = await import(${JSON.stringify(pathToFileURL(join(installDir, 'node_modules', 'claude-mem-lite', 'lib', 'binding-probe.mjs')).href)});`,
      `const r = await m.ensureBetterSqlite3Working(${JSON.stringify(installDir)});`,
      'if (!r.ok) { console.error(r.error); process.exit(1); }',
      'process.stdout.write(r.action);',
    ].join('\n');
    const action = sh('node', ['--input-type=module', '-e', healSrc], { cwd: installDir }).trim();
    if (!tryProbe()) fail(`binding still unusable after shipped heal (heal reported: ${action})`);
    healed = true;
    log(`heal OK — ensureBetterSqlite3Working reported "${action}", re-probe passed`);
  } else if (expectBlock) {
    fail(
      'SMOKE_EXPECT_SCRIPT_BLOCK=1 but the binding compiled on plain npm install — the script block did not occur, so the heal path was NOT exercised. npm default changed or the runner pre-allows scripts; update the CI job.',
    );
  }
  log(
    `native OK — better-sqlite3 opened :memory: and round-tripped a row${healed ? ' (via shipped heal)' : ''}`,
  );

  // 3c. Full runtime path: real import chain → schema init → DB open → query,
  //     against a fresh sandboxed data dir. `stats` reads the DB and exits 0 on
  //     an empty one, creating the schema on first open (the import-+-open-DB
  //     check the audit asked for).
  sh('node', [cli, 'stats'], { cwd: installDir, env: { ...process.env, CLAUDE_MEM_DIR: dataDir } });
  log('runtime OK — cli stats initialised schema and opened DB on a fresh data dir');

  log('PASS — published tarball installs, rebuilds native, imports, and opens a DB');
} finally {
  if (KEEP) process.stderr.write(`[smoke] --keep: left workdir at ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}
