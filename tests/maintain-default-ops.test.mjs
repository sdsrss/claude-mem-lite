// v3.76.0: the automatic maintenance path promoted and never demoted.
//
// `demotePinned` (injection_count>=8 AND cited_count=0 -> importance floored: no lesson
// to 1, lesson-bearing to 2) is the only op
// that can reach a heavily-injected-but-uncited row — the regular decay op deliberately
// protects injection_count>0, on the theory that a row Claude was shown 8 times is
// contextually proven. But demote_pinned was in NO face's default op set, and hook.mjs
// did not even import it, so it ran only when a human typed `--ops demote_pinned`. Its
// opponent `boostAccessed` (access_count>3 -> importance+1) was in all three faces.
//
// Measured on the maintainer's live DB before this fix: 148 rows demoted by citation
// decay, never cited, and back at importance>=3 — 148/148 of them boost-eligible. Plus
// 17 rows sitting demote-eligible right then, carrying 265 recorded injections.
//
// READ THOSE TWO NUMBERS AS SEPARATE POPULATIONS, not as a before/after pair. The
// original wording put the 148 in the headline slot, which invites "this fix repairs
// 148 rows"; it does not. `boostAccessed` triggers on access_count, `demotePinned` on
// injection_count>=8, and the overlap is thin. Re-measured 2026-08-22 on the same DB:
// 178 rows now match the decayed/never-cited/back-at-3 shape, 152 of them boost-eligible
// — but only **7** are reachable by demotePinned (94 sit at injection_count=0, 77 at
// 1-7). So this op closes the loop for the heavily-injected tail, and the far larger
// access-driven population it does NOT touch is a separate, still-open question.
// Un-narrowable on current data, and deliberately so: injection_count is bumped only on
// the two query-conditioned UserPromptSubmit faces because scoring-sql.mjs reads it as a
// NOISE signal, and v3.66.1 already reverted an attempt to widen it (D#124).
//
// The two faces that DID wire the op ran it in OPPOSITE orders, and the order is
// load-bearing: mem-cli demoted then boosted, handing the row straight back (1 -> 2);
// server.mjs boosted then demoted (row lands at 1). So a fixture must be able to tell
// those two apart, which is why the seed row below is importance **2**, not 3:
//
//   importance 3 seed -> boostAccessed requires importance<3, so boost is a no-op and
//   the ordering mutation stays GREEN. The case would only prove "demote ran at all".
//   importance 2 seed -> correct order (boost 2->3, demote ->1) ends at 1
//                        wrong order   (demote ->1, boost 1->2) ends at 2
//                        opt-out       (boost 2->3, no demote)  ends at 3
//
// Three distinguishable terminal values, so every mutation this file is meant to catch
// changes an asserted number.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { DEFAULT_MAINTAIN_OPS, resolveDefaultMaintainOps, demotePinned, PINNED_INJ_THRESHOLD } from '../lib/maintain-core.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

const REPO = resolve(import.meta.dirname, '..');
const CLI = join(REPO, 'cli.mjs');
const SERVER = join(REPO, 'server.mjs');
const HOOK = join(REPO, 'hook.mjs');

let dir;

const baseEnv = (extra = {}) => ({
  ...process.env,
  // Scrubbed, not inherited: a dev or CI shell that exports the opt-out would turn most
  // of this file red for a reason that has nothing to do with the code under test.
  CLAUDE_MEM_SKIP_DEMOTE_PINNED: undefined,
  CLAUDE_MEM_DIR: dir,
  CLAUDE_MEM_SKIP_UPDATE: '1',
  CLAUDE_MEM_SKIP_COMPRESS: '1',
  CLAUDE_MEM_SKIP_OPTIMIZE: '1',
  CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
  CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
  MEM_QUIET_HOOKS: '1',
  MEM_NO_AUTO_ADOPT: '1',
  ...extra,
});

// Seed one row that is BOTH demote-eligible and boost-eligible. Kept fresh
// (created_at = now) so the 30-day decay / stale-purge ops cannot touch it and the
// only two ops in play are boost and demote_pinned.
function seedPinnedRow({ title = 'Pinned but never cited', lesson = null, importance = 2, accessCount = 9 } = {}) {
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  const now = Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)"
    + " VALUES ('s-pin','s-pin','projPin',?,?,'active')",
  ).run(new Date(now).toISOString(), now);
  db.prepare(
    "INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,"
    + " files_read, files_modified, importance, related_ids, access_count, injection_count, cited_count,"
    + " lesson_learned, created_at, created_at_epoch)"
    + " VALUES ('s-pin','projPin','','change',?,'','','','','[]','[]',?,'[]',?,9,0,?,?,?)",
  ).run(title, importance, accessCount, lesson, new Date(now).toISOString(), now);
  db.close();
}

function importanceOf(title = 'Pinned but never cited') {
  const db = new Database(join(dir, 'claude-mem-lite.db'), { readonly: true });
  try {
    return db.prepare('SELECT importance FROM observations WHERE title = ?').get(title).importance;
  } finally { db.close(); }
}

const importanceOfPinnedRow = () => importanceOf();

function runCli(args, extraEnv = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: REPO, env: baseEnv(extraEnv), stdio: 'pipe', encoding: 'utf8', timeout: 60_000,
  });
}

function callMcp(name, args, extraEnv = {}) {
  const reqs = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  ].join('\n') + '\n';
  const raw = execFileSync(process.execPath, [SERVER], {
    env: baseEnv(extraEnv), input: reqs, encoding: 'utf8', timeout: 60_000,
  });
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const m = JSON.parse(line);
      if (m.id === 2) return m.result?.content?.[0]?.text || JSON.stringify(m.error);
    } catch { /* server also logs non-JSON lines */ }
  }
  return '';
}

function runAutoMaintain(extraEnv = {}) {
  return execFileSync(process.execPath, [HOOK, 'auto-maintain', 'projPin'], {
    cwd: REPO, env: baseEnv(extraEnv), stdio: 'pipe', encoding: 'utf8', timeout: 60_000,
  });
}

// ─── In-process: the op set, the opt-out parser, and the floor itself ───────
//
// These need neither a subprocess nor a temp DB dir. They used to sit inside the
// three-face describe below, so each one paid that block's beforeEach — a real
// `cli.mjs stats` spawn plus a seed write (~150ms apiece, ~450ms total) to assert
// a pure function. Split out here; the face-level suite keeps every case that
// genuinely needs a face.

describe('demote_pinned: default op set and opt-out parsing (pure)', () => {
  it('the shared default set contains demote_pinned, ordered after boost', () => {
    expect(DEFAULT_MAINTAIN_OPS).toContain('demote_pinned');
    expect(DEFAULT_MAINTAIN_OPS.indexOf('demote_pinned'))
      .toBeGreaterThan(DEFAULT_MAINTAIN_OPS.indexOf('boost'));
  });

  it('the opt-out drops demote_pinned from the default set and nothing else', () => {
    expect(resolveDefaultMaintainOps({ CLAUDE_MEM_SKIP_DEMOTE_PINNED: '1' }))
      .toEqual(['cleanup', 'decay', 'boost']);
    expect(resolveDefaultMaintainOps({})).toEqual([...DEFAULT_MAINTAIN_OPS]);
  });

  it('the opt-out honours `true`/`yes` and refuses to read `0`/`false` as skip', () => {
    // First cut compared `=== '1'`, so `=true` silently got the new behaviour — the same
    // class of surprise the opt-out exists to prevent.
    for (const on of ['1', 'true', 'yes', ' 1 ', 'ON']) {
      expect(resolveDefaultMaintainOps({ CLAUDE_MEM_SKIP_DEMOTE_PINNED: on }))
        .toEqual(['cleanup', 'decay', 'boost']);
    }
    for (const off of ['', '0', 'false', 'no', 'off']) {
      expect(resolveDefaultMaintainOps({ CLAUDE_MEM_SKIP_DEMOTE_PINNED: off }))
        .toEqual([...DEFAULT_MAINTAIN_OPS]);
    }
  });
});

// The user- and LLM-visible copy for this op. v3.76.0 wrote "importance→1" into the
// MCP tool description and the CLI help; v3.76.1 changed the behaviour to a dual floor
// and updated NEITHER, so the released schema told the model the wrong thing for one
// whole patch version. Nothing failed, because no test read that string. These do.
//
// FAILS IF: the floor semantics change again without both texts following, or the
// threshold constant moves away from the number the copy quotes.
describe('demote_pinned copy matches the shipped behaviour', () => {
  const SRC = {
    'tool-schemas.mjs (MCP, LLM-visible)': readFileSync(join(REPO, 'tool-schemas.mjs'), 'utf8'),
    'mem-cli.mjs (CLI help)': readFileSync(join(REPO, 'mem-cli.mjs'), 'utf8'),
  };

  // A window, not a line: the CLI help wraps this description across four physical
  // lines, so a per-line filter reads only its first clause and would pass on copy
  // that never mentions the second floor at all.
  const copyAround = (src) => {
    const at = src.indexOf('demote_pinned:');
    const i = at === -1 ? src.indexOf('demote_pinned=') : at;
    return i === -1 ? '' : src.slice(i, i + 420);
  };

  for (const [label, src] of Object.entries(SRC)) {
    it(`${label} states both floors, not just 1`, () => {
      const copy = copyAround(src);
      expect(copy, 'no demote_pinned copy found').not.toBe('');
      // The pre-v3.76.1 wording, which is now false for lesson-bearing rows.
      expect(copy).not.toMatch(/importance\u21921\b/);
      // Bind each FLOOR to its CONDITION, in one regex per arm. The first cut
      // asserted /to 1/, /to 2/ and /lesson/i independently, and a pre-tag review
      // proved that copy stating the exact OPPOSITE mapping ("to 1 when it HAS a
      // lesson_learned, to 2 when it has none") satisfied all three and kept the
      // suite green on both files. Three necessary conditions read as one
      // sufficient condition — and inverting the clause while editing is the most
      // likely way this copy actually goes wrong, which is the recurrence this
      // suite was written to prevent.
      expect(copy, 'the no-lesson arm must name floor 1').toMatch(/to 1 with no[\s|]+lesson_learned/);
      expect(copy, 'the lesson-bearing arm must name floor 2').toMatch(/to 2 with one\b/);
    });

    it(`${label} quotes the real injection threshold (${PINNED_INJ_THRESHOLD})`, () => {
      // Two legal spellings, and the difference is not cosmetic.
      //
      //   `>=8`                        — a literal that HAPPENS to equal the constant today
      //   `>=${PINNED_INJ_THRESHOLD}`  — a template that cannot fall out of step
      //
      // tool-schemas.mjs is a plain string in an LLM-visible tool description and stays a
      // literal (changing that text is an L3 change on its own terms); mem-cli.mjs's help
      // is a template literal, so P1-5 moved it to the interpolated form after
      // tests/maintain-ops-sequence.test.mjs started forbidding hardcoded thresholds in
      // the shipped renderers. This assertion has to accept both or the two guards
      // contradict each other — which they did, and this is that resolution.
      expect(copyAround(src)).toMatch(
        new RegExp(`>=\\s*(?:${PINNED_INJ_THRESHOLD}\\b|\\$\\{PINNED_INJ_THRESHOLD\\})`),
      );
    });
  }
});

// The dual floor asserted at the core, where it is written. Every other case in
// this file reaches demotePinned through a face, so a floor regression could only
// ever be read off a terminal importance after cleanup/decay/boost also ran —
// three ops of interference between the change and the assertion.
describe('demotePinned floor (maintain-core, in-process)', () => {
  let db;
  beforeEach(() => { db = createTestDb(); insertSession(db, { id: 'sess-1', project: 'p' }); });
  afterEach(() => { db?.close(); });

  const pinned = (extra) => insertObs(db, {
    project: 'p', type: 'change', importance: 3, injectionCount: 8, citedCount: 0, ...extra,
  }).lastInsertRowid;
  const impOf = (id) => db.prepare('SELECT importance FROM observations WHERE id = ?').get(Number(id)).importance;
  const run = () => demotePinned(db, { projectFilter: 'AND project = ?', baseParams: ['p'] });

  it('floors a lesson-bearing row at 2 and a lessonless row at 1', () => {
    const withLesson = pinned({ title: 'Pinned with a lesson', lessonLearned: 'the takeaway' });
    const noLesson = pinned({ title: 'Pinned with no lesson' });
    expect(run()).toBe(2);
    expect(impOf(withLesson)).toBe(2);
    expect(impOf(noLesson)).toBe(1);
  });

  it("treats the literal string 'none' as no lesson", () => {
    // NO_LESSON_SQL spells out three empties; 'none' is the one a reader drops.
    const id = pinned({ title: 'Pinned lesson none', lessonLearned: 'none' });
    expect(run()).toBe(1);
    expect(impOf(id)).toBe(1);
  });

  it('reports 0 changes when every candidate already sits at its floor', () => {
    // SQLite counts a same-value UPDATE in `changes`, so the floor doubles as the
    // WHERE bound — without that, this run reports phantom demotions forever.
    pinned({ title: 'Already floored lesson', lessonLearned: 'takeaway', importance: 2 });
    pinned({ title: 'Already floored lessonless', importance: 1 });
    expect(run()).toBe(0);
  });

  it('leaves a cited row alone however heavily injected', () => {
    const id = pinned({ title: 'Pinned but cited', injectionCount: 99, citedCount: 1 });
    expect(run()).toBe(0);
    expect(impOf(id)).toBe(3);
  });

  // Pre-tag review of v3.76.2 (S-2): neutering `projectFilter` while preserving SQL
  // arity kept 279 tests green across all three maintain suites, because every fixture
  // in this file lives in project 'p' — there was no second project for a leak to
  // reach. For an op that writes `importance` across the whole observations table,
  // "it only touched my project" is precisely the property that needs a fixture.
  //
  // FAILS IF: demotePinned stops honouring projectFilter (e.g. the interpolation is
  // dropped, or widened to `OR 1=1`).
  it('scopes to the requested project and leaves other projects untouched', () => {
    insertSession(db, { id: 'sess-2', project: 'other' });
    const mine = pinned({ title: 'Pinned in the target project' });
    const theirs = insertObs(db, {
      sessionId: 'sess-2', project: 'other', type: 'change', importance: 3,
      title: 'Pinned in a different project', injectionCount: 40, citedCount: 0,
    }).lastInsertRowid;

    expect(run()).toBe(1);
    expect(impOf(mine)).toBe(1);
    expect(impOf(theirs), 'a row in another project must not be demoted').toBe(3);
  });

  it('does not reach a row below the injection threshold', () => {
    const id = pinned({ title: 'Injected seven times', injectionCount: 7 });
    expect(run()).toBe(0);
    expect(impOf(id)).toBe(3);
  });
});

describe('demote_pinned is in the default maintenance set on all three faces', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maintain-ops-'));
    // Materialize the schema through the real path, then seed.
    runCli(['stats']);
    seedPinnedRow();
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });

  it('CLI `maintain execute` with no --ops lands the row at importance 1', () => {
    expect(importanceOfPinnedRow()).toBe(2);
    runCli(['maintain', 'execute']);
    // 1, not 2: boost runs first (2->3), demote second (->1). A demote-then-boost
    // ordering ends at 2 and reddens here.
    expect(importanceOfPinnedRow()).toBe(1);
  });

  it('MCP mem_maintain with no operations lands the row at importance 1', () => {
    callMcp('mem_maintain', { action: 'execute' });
    expect(importanceOfPinnedRow()).toBe(1);
  });

  it('hook auto-maintain lands the row at importance 1', () => {
    runAutoMaintain();
    expect(importanceOfPinnedRow()).toBe(1);
  });

  it('CLAUDE_MEM_SKIP_DEMOTE_PINNED=1 leaves the row boosted to 3 on every face', () => {
    const optOut = { CLAUDE_MEM_SKIP_DEMOTE_PINNED: '1' };
    runCli(['maintain', 'execute'], optOut);
    // 3, not 2: boost still runs. Asserting "not 1" alone would also pass if the whole
    // maintain run had silently no-opped.
    expect(importanceOfPinnedRow()).toBe(3);
  });

  // Pre-tag review finding: `importance >= 2` is a hard WHERE on the injection faces that
  // earn citations (pre-tool-recall, Key Context, cross-project), while `injection_count`
  // — the signal that triggers this op — is only ever bumped on the two UserPromptSubmit
  // faces. Flooring a lesson at 1 convicts it on its weakest surface and evicts it from
  // its strongest. On the maintainer's live DB, 16 of the 17 affected rows carried lessons.
  it('floors a LESSON-bearing pinned row at 2, not 1', () => {
    seedPinnedRow({ title: 'Pinned lesson', lesson: 'always check the second face', importance: 3 });
    runCli(['maintain', 'execute']);
    // 2, not 1: still de-ranked out of the top tier, still eligible on every
    // importance>=2 face. The no-lesson row in the same run must still land at 1, or this
    // would pass just as well with the op disabled entirely.
    expect(importanceOf('Pinned lesson')).toBe(2);
    expect(importanceOfPinnedRow()).toBe(1);
  });

  it('does not re-demote a row already sitting at its floor', () => {
    // accessCount 0 on purpose: boostAccessed needs >3, so this row is NOT lifted off its
    // floor first. With accessCount 9 it would go 2 -> 3 (boost) -> 2 (demote) and the
    // case would prove nothing about the floor being a WHERE bound.
    seedPinnedRow({ title: 'Pinned lesson', lesson: 'already floored', importance: 2, accessCount: 0 });
    const out = runCli(['maintain', 'execute']);
    // Exactly 1 — the beforeEach no-lesson row. The lesson row is already at its floor of
    // 2, and a same-value UPDATE still counts in SQLite's `changes`, so without the floor
    // being part of the WHERE bound this would read "Demoted 2" here and report a phantom
    // demotion on every run, forever.
    expect(out).toContain('Demoted 1 pinned-but-uncited');
    expect(importanceOf('Pinned lesson')).toBe(2);
  });

  it('a demoted row is not then auto-hidden by the 7-day noise pass', () => {
    // The chain pre-tag review reproduced end to end: markAutoCompressible's noise pass
    // was gated on `importance <= 1` with no `injection_count = 0` clause (its sibling
    // aged pass has had one since v2.56.0). Nothing could satisfy both until demote_pinned
    // joined the default set. COMPRESSED_AUTO hides the row from every
    // `COALESCE(compressed_into,0)=0` read path — so it can never be injected, never
    // cited, and has no path back.
    const db = new Database(join(dir, 'claude-mem-lite.db'));
    const old = Date.now() - 10 * 86400000;
    db.prepare(
      "INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts,"
      + " facts, files_read, files_modified, importance, related_ids, access_count, injection_count, cited_count,"
      + " created_at, created_at_epoch)"
      + " VALUES ('s-pin','projPin','','change','Modified hook.mjs, server.mjs','','','','[]','[]','[]',3,'[]',0,9,0,?,?)",
    ).run(new Date(old).toISOString(), old);
    db.close();

    const runtime = join(dir, 'runtime');
    runAutoMaintain();
    // Both 24h gates must be cleared or the second pass is a no-op and the case proves
    // nothing — the hiding happens on the run AFTER the demotion.
    for (const f of ['last-auto-maintain.json', 'last-mark-compressible-projPin.json']) {
      try { rmSync(join(runtime, f)); } catch { /* not written */ }
    }
    runAutoMaintain();

    const check = new Database(join(dir, 'claude-mem-lite.db'), { readonly: true });
    const row = check.prepare("SELECT importance, compressed_into FROM observations WHERE title = 'Modified hook.mjs, server.mjs'").get();
    check.close();
    expect(row.importance).toBe(1);          // demoted — no lesson, so floor 1
    expect(row.compressed_into).toBeNull();  // but NOT hidden
  });

  // v3.76.1: the scan forecast and the op drifted the moment demotePinned gained a second
  // floor — the forecast still said `importance > 1`, so a lesson row already at 2 was
  // counted as pinned forever while every execute reported "Demoted 0". Pair the two
  // numbers so they cannot disagree again; asserting either alone is what let this ship.
  it('the scan forecast equals what execute actually moves', () => {
    seedPinnedRow({ title: 'Lesson at floor', lesson: 'already floored', importance: 2, accessCount: 0 });
    const pinnedInScan = (out) => Number(/above floor\): (\d+)/.exec(out)[1]);
    const demotedInExecute = (out) => Number(/Demoted (\d+) pinned-but-uncited/.exec(out)[1]);

    const before = pinnedInScan(runCli(['maintain', 'scan']));
    const moved = demotedInExecute(runCli(['maintain', 'execute']));
    const after = pinnedInScan(runCli(['maintain', 'scan']));

    // Only the beforeEach no-lesson row is above its floor; the lesson row is AT its floor
    // of 2 and must not be forecast. Pre-fix: before=2, moved=1, after=1 forever.
    expect(before).toBe(1);
    expect(moved).toBe(1);
    expect(after).toBe(0);
  });

  it('honours the opt-out on the hook and MCP faces too, not just the CLI', () => {
    // The previous cut asserted the opt-out through runCli only, while calling itself
    // "on every face". Deleting the hook's opt-out check — the ONE face that runs
    // unattended, and therefore the one a user setting this var actually needs — passed
    // all 4857 tests.
    const optOut = { CLAUDE_MEM_SKIP_DEMOTE_PINNED: '1' };
    runAutoMaintain(optOut);
    expect(importanceOfPinnedRow()).toBe(3);

    seedPinnedRow({ title: 'Second pinned row' });
    callMcp('mem_maintain', { action: 'execute' }, optOut);
    expect(importanceOf('Second pinned row')).toBe(3);
  });

  it('the opt-out does NOT gag an explicit --ops demote_pinned', () => {
    // An accepted value that silently means something else is worse than an
    // unsupported one — the opt-out scopes to the DEFAULT set only.
    runCli(['maintain', 'execute', '--ops', 'demote_pinned'], { CLAUDE_MEM_SKIP_DEMOTE_PINNED: '1' });
    expect(importanceOfPinnedRow()).toBe(1);
  });
});
