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
// The green line is also the proof of the write. `checkFTSIntegrity` cannot
// complete on a readonly handle, so "all indexes healthy" appearing at all is a
// write-capable open having happened. That is what these cases assert; the
// audit's `-wal`/`-shm` sidecar assertion is deliberately NOT carried, because
// `rwDb.close()` removes both and the residue is not observable after the run.
//
// The rebuild half is out of reach of a behavioural test — it needs skew AND a
// corrupt FTS index at once — so it is gated by construction (inside the same
// branch) rather than pinned here. Said plainly rather than implied.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';

const INSTALL_PATH = resolve(import.meta.dirname, '../install.mjs');
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
});
