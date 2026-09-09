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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'fs';
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
