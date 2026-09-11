// doctor's STARTUP surface, driven as a subprocess against a copy install.
//
// Audit 2026-09-08 (P1-1). Four rounds listed doctor as "next round's scope" and never
// ran it; when it finally was, the finding was not in its verdicts — those hold — but in
// whether it starts at all. install.mjs pulled `lib/db-unusable.mjs` through a STATIC
// import, and that one edge dragged the whole retrieval/NLP subtree (utils → nlp,
// synonyms, stop-words, scoring-sql, …) into doctor's load graph. Its only consumer is
// `dbCheckRemedy`, which runs inside a catch. So a copy install missing any one of those
// files — a half-finished update, a trimmed tarball (this repo has shipped three), a user
// deleting a file — got a bare ERR_MODULE_NOT_FOUND stack from the one command whose job
// is to say "this file is missing, run repair".
//
// This is CLAUDE.md's "a recovery path must not import the thing it recovers", recurring
// on a different edge: last time it was two path constants, this time it is a remedy
// string builder.
//
// The closure is asserted BEHAVIOURALLY (does doctor speak?) rather than by counting
// modules: a count is a smoke alarm, and a count-based pin would go green the moment
// someone re-exported the same subtree through a different edge.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { SOURCE_FILES } from '../source-files.mjs';

const REPO = resolve(import.meta.dirname, '..');
let home;

/** A copy install: every SOURCE_FILES entry materialised, node_modules re-exported. */
function buildCopyInstall(root) {
  for (const rel of SOURCE_FILES) {
    const src = join(REPO, rel);
    if (!existsSync(src)) continue;
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  const pkgDir = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }));
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '12.10.0', main: 'index.js' }),
  );
  writeFileSync(
    join(pkgDir, 'index.js'),
    `module.exports = require(${JSON.stringify(join(REPO, 'node_modules', 'better-sqlite3'))});\n`,
  );
  return root;
}

function runDoctor(root) {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'install.mjs'), 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, MEM_NO_AUTO_ADOPT: '1', CLAUDE_MEM_DIR: join(home, 'data') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    // doctor exits 1 whenever it finds an issue, which is the ordinary case here.
    return { stdout: e.stdout || '', stderr: e.stderr || '', code: e.status };
  }
}

describe('doctor starts on the broken install it exists to diagnose', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'doctor-closure-'));
  });
  afterEach(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });

  it('premise: an intact copy install produces a real report', () => {
    const root = buildCopyInstall(join(home, 'intact'));
    const { stdout } = runDoctor(root);
    // Without this the case below could pass because doctor prints nothing either way.
    expect(stdout.length, 'the intact fixture must produce a report to compare against').toBeGreaterThan(200);
    expect(stdout).toMatch(/Node\.js/);
  });

  // Pre-ship review 2026-09-09. Making dbCheckRemedy lazy did not remove the failure, it
  // MOVED it: from load time into the Database check's catch, where an unhandled rejection
  // aborts the run just as fatally. The compound shape is the one a real broken install
  // has — a file is missing AND the database will not open — and `--json` still emitted
  // zero bytes there. FAILS IF: the try/catch around the remedy call is removed.
  it('still reports when a module is missing AND the database will not open', () => {
    const root = buildCopyInstall(join(home, 'compound'));
    rmSync(join(root, 'stop-words.mjs'));
    // A file SQLite will refuse: right name, wrong bytes.
    const dataDir = join(home, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'claude-mem-lite.db'), 'this is not a database');

    const { stdout, stderr } = runDoctor(root);
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stdout.length, 'doctor emitted nothing on the compound broken install').toBeGreaterThan(200);
    expect(stdout, 'it must still name the database failure').toMatch(/Database/);
  });

  it('still reports when a retrieval-subtree module is missing', () => {
    // stop-words.mjs has nothing to do with diagnosis. It was reachable ONLY as
    // install.mjs → lib/db-unusable.mjs → lib/db-backup.mjs → utils.mjs → here, which is
    // why it is the probe: if doctor needs THIS file to start, its load graph is wrong.
    // FAILS IF: dbCheckRemedy's import goes back to the top of the file.
    const root = buildCopyInstall(join(home, 'trimmed'));
    rmSync(join(root, 'stop-words.mjs'));

    const { stdout, stderr } = runDoctor(root);
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stdout.length, 'doctor produced no output at all — it died before check 1').toBeGreaterThan(200);
    // And it must actually notice the file is gone rather than report a clean bill.
    expect(stdout).toMatch(/stop-words\.mjs|missing/i);
  });
});

// ── D#26: the other half of P1-1 ──────────────────────────────────────────────
//
// Making dbCheckRemedy lazy shrank install.mjs's static closure from ~28 modules
// to ~13. It did not remove the symptom, it narrowed it: lose one of the
// remaining 13 and `doctor` still dies with a bare ERR_MODULE_NOT_FOUND before
// its first line of code, stdout 0 bytes. A static import cannot be caught from
// inside the module that declares it, so the catch has to live one entry up.
//
// The deferred note expected that host to be unavailable — "cli.mjs 自己也有静态
// 闭包，同样可断". Measured on this tree, cli.mjs's static closure is exactly ONE
// file: itself. It has no static local imports at all; every route is an
// `await import()`. It is also the published `bin`. So it is the host, and these
// cases drive the path a user actually types.
//
// Deviation from the audit's written acceptance, stated rather than smuggled: the
// message goes to STDERR, not stdout. `doctor --json` consumers parse stdout, and
// a prose line prepended there would break them. What is asserted instead is that
// stderr carries the filename plus a repair command and NOT a raw module stack.
//
// `node install.mjs doctor` invoked directly is still a bare stack, and is left
// that way: guarding it means splitting install.mjs into a shim plus a body, and
// the value is in the path the tooling prints, which now points here.
describe('the CLI entry explains a broken install instead of stack-tracing', () => {
  // Its OWN fixture root. Leaning on the block above's `beforeEach` made every case
  // here pass in a whole-file run and fail under `-t` — `home` was simply whatever
  // the previous block had left behind, and the copy builder recreated the tree by
  // accident. Caught by a mutation run whose premise arm went red for a reason that
  // had nothing to do with the mutation.
  let cliHome;
  beforeEach(() => {
    cliHome = mkdtempSync(join(tmpdir(), 'doctor-cli-entry-'));
  });
  afterEach(() => {
    try {
      rmSync(cliHome, { recursive: true, force: true });
    } catch {}
  });

  /** install.mjs's STATIC local imports — the ones that must resolve at load time. */
  function staticLocalImports(root) {
    const src = readFileSync(join(root, 'install.mjs'), 'utf8');
    // `from '<path>'` is static by construction; every dynamic route in this repo
    // is `await import('<path>')`, which has no `from` and fails inside its own
    // catch rather than at load time.
    return [...src.matchAll(/from\s+'(\.\/[^']+)'/g)].map((m) => m[1].replace(/^\.\//, ''));
  }

  function runCli(root, args) {
    try {
      const stdout = execFileSync(process.execPath, [join(root, 'cli.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: cliHome, MEM_NO_AUTO_ADOPT: '1', CLAUDE_MEM_DIR: join(cliHome, 'data') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', code: 0 };
    } catch (e) {
      return { stdout: e.stdout || '', stderr: e.stderr || '', code: e.status };
    }
  }

  it('premise: the intact copy install answers `cli.mjs doctor` with a real report', () => {
    const root = buildCopyInstall(join(cliHome, 'cli-intact'));
    const { stdout } = runCli(root, ['doctor']);
    expect(stdout.length, 'the intact fixture must produce a report through cli.mjs').toBeGreaterThan(200);
    expect(stdout).toMatch(/Node\.js/);
  });

  it('premise: the closure this case sweeps is non-empty and names real files', () => {
    const root = buildCopyInstall(join(cliHome, 'cli-closure'));
    const imports = staticLocalImports(root);
    expect(imports.length, 'nothing to sweep — the extraction regex stopped matching').toBeGreaterThan(5);
    for (const rel of imports) {
      expect(existsSync(join(root, rel)), `${rel} is imported but absent from the fixture`).toBe(true);
    }
  });

  // The counter-example shape is "delete ONE file", per the audit: deleting a
  // whole directory cannot even be constructed from a fixture, and would pass for
  // the wrong reason.
  //
  // FAILS IF: cli.mjs's `await import('./install.mjs')` is left unguarded.
  it('names the missing file and a repair command for every module in the closure', () => {
    const root = buildCopyInstall(join(cliHome, 'cli-sweep'));
    const imports = staticLocalImports(root);
    const failures = [];

    for (const rel of imports) {
      const victim = join(root, rel);
      const saved = readFileSync(victim);
      rmSync(victim);
      try {
        const { stdout, stderr } = runCli(root, ['doctor']);
        const out = `${stdout}${stderr}`;
        if (!out.includes(rel)) failures.push(`${rel}: output never named the missing file`);
        else if (!/repair/i.test(out)) failures.push(`${rel}: named the file but offered no repair command`);
        else if (/ERR_MODULE_NOT_FOUND/.test(out))
          failures.push(`${rel}: raw module-resolution error reached the user`);
      } finally {
        writeFileSync(victim, saved);
      }
    }

    // Report the NAME SET, not a count — a count says a smoke alarm went off.
    expect(failures, `${failures.length}/${imports.length} modules still fail opaquely`).toEqual([]);
  });
});
