// A database doctor has just declared unusable must not then be opened for writing.
//
// R12 audit 2026-09-08, partition C (P2-5). The schema-skew check exists for one
// reason, stated in lib/schema-skew.mjs's own header: a DB written by a NEWER
// claude-mem-lite locks every older code home out, permanently. doctor computes
// that verdict, prints it as a `fail` — and then, with nothing gating it, opens
// the same file READ-WRITE, runs `checkFTSIntegrity` (an
// `INSERT INTO fts VALUES('integrity-check')`, which needs a write lock), and on
// an unhealthy index would go on to `rebuildFTS`. Two things go wrong at once:
// the machine that is behind is handed a path to write the newer layout, and the
// screen reports "all indexes healthy" about a store the same screen just said
// this install cannot use.
//
// The green line is the proof of the write — but not for the reason the first
// draft of this comment gave, which review measured and found false.
// `checkFTSIntegrity` does NOT throw on a readonly handle: its INSERT sits inside
// a per-table try (schema.mjs), so it completes and returns
// `{healthy: false, details: [... "CORRUPT (attempt to write a readonly database)"]}`.
// The conclusion survives, by the other half: on a readonly handle the line that
// appears says CORRUPT, so "all indexes healthy" appearing AT ALL means a
// write-capable handle ran it. Assert the observable, not the mechanism you
// assumed produced it.
//
// The audit's `-wal`/`-shm` sidecar assertion is deliberately NOT carried, because
// `rwDb.close()` removes both and the residue is not observable after the run.
//
// The rebuild half is out of reach of a behavioural test — it needs skew AND a
// corrupt FTS index at once — so it is gated by construction (inside the same
// branch) rather than pinned here. Said plainly rather than implied.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const INSTALL_PATH = join(REPO_ROOT, 'install.mjs');
let home;
let dataDir;

function seedDb({ version }) {
  const db = new Database(join(dataDir, 'claude-mem-lite.db'));
  initSchema(db);
  if (version !== undefined) db.prepare('UPDATE schema_version SET version = ?').run(version);
  db.close();
}

function doctorChecks() {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [INSTALL_PATH, 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, MEM_NO_AUTO_ADOPT: '1', CLAUDE_MEM_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    stdout = e.stdout || '';
  }
  expect(stdout.length, 'doctor emitted zero bytes').toBeGreaterThan(0);
  return JSON.parse(stdout).checks;
}

const messagesOf = (checks) => checks.map((c) => c.message).join('\n');

describe('doctor does not write to a database it has declared too new', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'doctor-skew-'));
    dataDir = join(home, 'data');
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });

  // Premise. Without this the skew cases below would pass on a doctor that never
  // reaches the database section at all — the blind-instrument shape.
  it('premise: on a current-version DB the write-requiring checks do run and report green', () => {
    seedDb({});
    const checks = doctorChecks();
    const messages = messagesOf(checks);

    expect(messages, 'the FTS integrity check must run on a healthy fixture').toMatch(
      /FTS5 integrity: all indexes healthy/,
    );
    expect(messages, 'the DB stats check must run on a healthy fixture').toMatch(/DB stats:/);
    expect(messages).not.toMatch(/DB schema v\d+ is newer/);
  });

  it('reports the skew as a failure', () => {
    seedDb({ version: 99 });
    const checks = doctorChecks();

    const skew = checks.filter((c) => /DB schema v99 is newer/.test(c.message));
    expect(skew.length, 'the skew verdict must be present').toBe(1);
    expect(skew[0].level).toBe('fail');
  });

  // FAILS IF: the read-write open is left ungated. The green line cannot be
  // produced without one.
  it('does not run the write-requiring FTS integrity check, and says so', () => {
    seedDb({ version: 99 });
    const messages = messagesOf(doctorChecks());

    expect(messages, 'doctor wrote to a DB it just said this install cannot use').not.toMatch(
      /FTS5 integrity: all indexes healthy/,
    );
    // "I could not look" must be distinguishable from "I looked and it is fine" —
    // a silent skip would end the reader's search just as a false green does.
    expect(messages).toMatch(/FTS5 integrity: not checked/);
  });

  // The same honesty rule one check over: counting rows succeeds on a v99 file
  // because the tables are still there, so this one printed a ✓ about a store the
  // screen had already called unusable.
  it('does not report DB stats as healthy under skew', () => {
    seedDb({ version: 99 });
    const checks = doctorChecks();

    const stats = checks.filter((c) => /^DB stats/.test(c.message));
    expect(stats.length, 'the stats check must still say something').toBe(1);
    expect(stats[0].level, 'a ✓ here contradicts the fail two checks up').not.toBe('ok');
  });

  // ── The multi-root half (pre-ship review P1) ──────────────────────────────
  //
  // `probeSchemaCompat` deliberately probes EVERY code home on the machine, and
  // its own docblock says why: so a report can NAME the one that is behind
  // "instead of asserting something global about 'the install'". The first cut of
  // this gate did exactly that — `behind.length > 0`, any home — while the two
  // lines it gates say "this install".
  //
  // On the shape this feature was BUILT for, those differ. install.mjs's own
  // rationale names it: a current npm-global CLI beside a stale plugin cache is
  // reached routinely. There, the process running doctor can read and write the
  // database perfectly well, and the old gate both told the user otherwise and
  // switched off checkFTSIntegrity + rebuildFTS — doctor's only non-destructive
  // DB repair, on the machine most likely to need it.
  //
  // The cases above cannot see this: they build ONE code home, so "any root is
  // behind" and "the running root is behind" are the same sentence.
  describe('with a second, older code home on the machine', () => {
    /**
     * A plugin cache dir old enough to be judged behind, but not the running tree.
     *
     * The native binding is not optional garnish. probeSchemaCompat reads BOTH
     * numbers — the home's CURRENT_SCHEMA_VERSION and the DB's — in a fresh process
     * rooted at that home, and a home that cannot open the DB returns `unknown`
     * rather than `skew`. Without the re-export shim the fixture produces a second
     * root that is never judged behind, and the two cases below pass vacuously; the
     * premise case above exists because that is exactly what happened first.
     */
    function seedStalePluginCache(version, supportedSchema) {
      const root = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', version);
      mkdirSync(join(root, 'scripts'), { recursive: true });
      // listPluginCacheVersions requires scripts/launch.mjs before it counts a dir.
      writeFileSync(join(root, 'scripts', 'launch.mjs'), '// fixture\n');
      writeFileSync(join(root, 'schema.mjs'), `export const CURRENT_SCHEMA_VERSION = ${supportedSchema};\n`);
      const pkgDir = join(root, 'node_modules', 'better-sqlite3');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'better-sqlite3', version: '12.10.0', main: 'index.js' }),
      );
      writeFileSync(
        join(pkgDir, 'index.js'),
        `module.exports = require(${JSON.stringify(join(REPO_ROOT, 'node_modules', 'better-sqlite3'))});\n`,
      );
      return root;
    }

    it('premise: the stale cache really is reported as the home that is behind', () => {
      seedDb({});
      seedStalePluginCache('1.0.0', 1);
      const messages = messagesOf(doctorChecks());

      // Without this the case below could pass because the fixture never produced
      // a second root at all.
      expect(messages, 'the fixture did not produce a skewed second code home').toMatch(
        /DB schema v\d+ is newer than plugin cache v1\.0\.0/,
      );
    });

    // FAILS IF: the gate asks "is ANY home behind" instead of "is the home I am
    // running from behind".
    it('still runs the write-requiring check when the running install is current', () => {
      seedDb({});
      seedStalePluginCache('1.0.0', 1);
      const checks = doctorChecks();
      const messages = messagesOf(checks);

      expect(
        messages,
        'doctor withheld its only non-destructive FTS repair from an install that can use the DB',
      ).toMatch(/FTS5 integrity: all indexes healthy/);
      expect(messages).not.toMatch(/FTS5 integrity: not checked/);

      const stats = checks.filter((c) => /^DB stats/.test(c.message));
      expect(stats.length).toBe(1);
      expect(stats[0].level, 'the running install CAN use this database').toBe('ok');
    });

    // NOT GUARDED, and said out loud rather than left to be discovered: two arms of
    // the gate are mutation-green here. Flipping `unknown` on the running root to
    // "safe to write", and keying the DB-stats checkmark on dbWriteBlocked instead
    // of dbUnusableHere, both leave every case in this file passing. Neither is
    // reachable from a fixture on this machine — making the RUNNING root probe
    // `unknown` means breaking the tree doctor is executing from, and the readonly
    // open two checks earlier fails first — so the conservative direction was chosen
    // by symmetry with the three-outcome rule, not by measurement. If a later round
    // finds a way to construct that root, these are the two arms owed a case.

    // And the gate must still fire on the case that matters: the running tree is
    // the one that is behind. Same two-root fixture, so this is not the
    // single-root case above wearing a different name.
    it('still withholds the write when the running install is the one behind', () => {
      seedDb({ version: 99 });
      seedStalePluginCache('1.0.0', 1);
      const messages = messagesOf(doctorChecks());

      expect(messages).toMatch(/FTS5 integrity: not checked/);
      expect(messages).not.toMatch(/FTS5 integrity: all indexes healthy/);
    });
  });
});
