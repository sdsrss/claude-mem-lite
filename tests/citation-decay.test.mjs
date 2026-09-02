import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractInjectedFromPreToolUse, extractCitationsFromTranscript, applyCitationDecay, redirectSupersededIds } from '../lib/citation-tracker.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('extractInjectedFromPreToolUse', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-decay-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeTranscript(entries) {
    const path = join(tmp, 't.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  function preToolAttachment(injectedIdsWithTypes) {
    const lines = ['[mem] PreToolUse recall — system-injected context, continue your planned action:', '[mem] Lessons for foo.js:'];
    for (const { id, type, body } of injectedIdsWithTypes) {
      lines.push(`  #${id} [${type}] ${body || 'placeholder lesson body'}`);
    }
    const stdout = JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') },
    });
    return {
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        hookName: 'PreToolUse:Read',
        command: 'node /home/u/.claude-mem-lite/scripts/pre-tool-recall.js',
        stdout,
        stderr: '',
        exitCode: 0,
      },
    };
  }

  it('extracts injected IDs from pre-tool-recall attachment stdout', () => {
    const path = writeTranscript([
      preToolAttachment([{ id: 42, type: 'bugfix' }, { id: 7556, type: 'decision' }]),
    ]);
    const ids = extractInjectedFromPreToolUse(path);
    expect(ids.has(42)).toBe(true);
    expect(ids.has(7556)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('ignores attachments from non-mem hooks', () => {
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          hookName: 'PreToolUse:Read',
          command: 'other-hook',
          stdout: 'mentions #99 but not from us',
          stderr: '',
          exitCode: 0,
        },
      },
    ]);
    const ids = extractInjectedFromPreToolUse(path);
    expect(ids.size).toBe(0);
  });

  it('ignores backfill-only "No prior lessons" lines (no #ID)', () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: '[mem] No prior lessons for foo.js — if you solve a bug, run /lesson',
      },
    });
    const path = writeTranscript([
      { type: 'attachment', attachment: { type: 'hook_success', hookName: 'PreToolUse:Edit', command: 'pre-tool-recall.js', stdout, stderr: '', exitCode: 0 } },
    ]);
    const ids = extractInjectedFromPreToolUse(path);
    expect(ids.size).toBe(0);
  });

  it('returns empty set on missing file', () => {
    expect(extractInjectedFromPreToolUse('/no/such/file').size).toBe(0);
  });

  it('returns empty set when transcriptPath is null/undefined', () => {
    expect(extractInjectedFromPreToolUse(null).size).toBe(0);
    expect(extractInjectedFromPreToolUse(undefined).size).toBe(0);
  });
});

describe('extractCitationsFromTranscript — mainOnly option', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-side-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  function writeTranscript(entries) {
    const path = join(tmp, 't.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('default behavior unchanged: includes sidechain (existing callers)', () => {
    const path = writeTranscript([
      { type: 'assistant', isSidechain: true,  message: { content: [{ type: 'text', text: 'sub-agent saw #100' }] } },
      { type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: 'main cited #200' }] } },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(100)).toBe(true);
    expect(ids.has(200)).toBe(true);
  });

  it('with {mainOnly:true}: drops sidechain text', () => {
    const path = writeTranscript([
      { type: 'assistant', isSidechain: true,  message: { content: [{ type: 'text', text: 'sub-agent saw #100' }] } },
      { type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: 'main cited #200' }] } },
    ]);
    const ids = extractCitationsFromTranscript(path, { mainOnly: true });
    expect(ids.has(100)).toBe(false);
    expect(ids.has(200)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('with {mainOnly:true}: treats missing isSidechain as main thread', () => {
    const path = writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'no isSidechain field → assume main, count #300' }] } },
    ]);
    const ids = extractCitationsFromTranscript(path, { mainOnly: true });
    expect(ids.has(300)).toBe(true);
  });
});

describe('applyCitationDecay', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
  });
  afterEach(() => { try { db.close(); } catch {} });

  function makeObs(overrides = {}) {
    const id = insertObs(db, {
      sessionId: 'sess-1',
      project: 'p',
      type: 'bugfix',
      title: 't',
      importance: 2,
      ...overrides,
    }).lastInsertRowid;
    // Post-INSERT updates for citation-decay columns (not in insertObs yet)
    if (overrides.uncited_streak !== undefined || overrides.cited_count !== undefined || overrides.last_decided_session_id !== undefined) {
      db.prepare(`
        UPDATE observations
        SET uncited_streak = ?, cited_count = ?, last_decided_session_id = ?
        WHERE id = ?
      `).run(
        overrides.uncited_streak ?? 0,
        overrides.cited_count ?? 0,
        overrides.last_decided_session_id ?? null,
        id
      );
    }
    return id;
  }

  // D#179 / D#198 — citation-decay no longer writes `importance` on ANY branch.
  //
  // `importance` was doing two jobs: a relevance prior AND a pool-admission gate.
  // Every injection surface gates on it (`>= 1`, `>= 2`, or the Key Context
  // tier arms `>= 1 / >= 2 / >= 3`), so a decay-driven 3 -> 2 was not a down-rank,
  // it REMOVED the row from the candidate population — the D#172 shape, confirmed
  // on the imperative pool (v3.82.0) and on the Key Context pool (D#198, 45 of
  // ~106 pool rows in that position). And the promote side cannot tell "acted on
  // this lesson" from "wrote about this lesson", so a release-note session lifts
  // exactly the rows it is discussing (D#179).
  //
  // The ranking loop does NOT need importance: cited_count / uncited_streak
  // already feed citeFactorClause, a BOUNDED [0.4, 3.0] pure ranking multiplier.
  // Dropping the importance writes leaves that intact while taking decay out of
  // population membership entirely — so a mis-read citation costs a bounded rank
  // shift instead of an eviction.
  //
  // One assertion per branch, because a single combined case would let a partial
  // revert (say, promote fixed, demote still writing) stay green.
  it('D#179: NO branch of the decay loop writes importance', () => {
    const promote = makeObs({ importance: 2, uncited_streak: 1, cited_count: 0 });
    const streakOnly = makeObs({ importance: 2, uncited_streak: 0 });
    const demote = makeObs({ importance: 2, uncited_streak: 2 });
    const atCap = makeObs({ importance: 3 });
    const atFloor = makeObs({ importance: 1, uncited_streak: 2 });

    applyCitationDecay(db, 'p',
      new Set([promote, streakOnly, demote, atCap, atFloor]),
      new Set([promote, atCap]), 'sess-1');

    const imp = (id) => db.prepare('SELECT importance FROM observations WHERE id=?').get(id).importance;
    expect(imp(promote), 'promote branch must not raise importance').toBe(2);
    expect(imp(streakOnly), 'streak-only branch must not touch importance').toBe(2);
    expect(imp(demote), 'demote branch must not lower importance').toBe(2);
    expect(imp(atCap), 'promote at the old cap is unchanged either way').toBe(3);
    expect(imp(atFloor), 'demote at the old floor is unchanged either way').toBe(1);

    // The behaviour signals the loop DOES own must still move, or "no importance
    // write" would be trivially satisfiable by disabling the loop altogether.
    const r = db.prepare('SELECT cited_count, uncited_streak, demoted_at, decay_seen_count FROM observations WHERE id=?').get(promote);
    expect(r.cited_count).toBe(1);
    expect(r.uncited_streak).toBe(0);
    expect(r.decay_seen_count).toBe(1);
    const d = db.prepare('SELECT uncited_streak, demoted_at FROM observations WHERE id=?').get(demote);
    expect(d.uncited_streak).toBe(0);          // streak still rolls over at the threshold
    expect(d.demoted_at).toBeGreaterThan(0);   // …and is still stamped
  });

  it('cited obs gets cited_count += 1, streak reset to 0, importance untouched', () => {
    const id = makeObs({ importance: 2, uncited_streak: 1, cited_count: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1');
    const row = db.prepare('SELECT importance, cited_count, uncited_streak, last_decided_session_id, decay_seen_count FROM observations WHERE id=?').get(id);
    expect(row.importance).toBe(2); // D#179: unchanged — the loop's output is cited_count/streak
    expect(row.cited_count).toBe(1);
    expect(row.uncited_streak).toBe(0);
    expect(row.last_decided_session_id).toBe('sess-1');
    // v34: every resolution branch bumps decay_seen_count
    expect(row.decay_seen_count).toBe(1);
  });

  it('decay_seen_count bumps on all 3 branches (promote, streak-only, demote)', () => {
    const p = makeObs({ importance: 2 }); // promote path
    const s = makeObs({ importance: 2, uncited_streak: 0 }); // streak-only path
    const d = makeObs({ importance: 2, uncited_streak: 2 }); // demote path
    applyCitationDecay(db, 'p', new Set([p, s, d]), new Set([p]), 'sess-1');
    const pSeen = db.prepare('SELECT decay_seen_count FROM observations WHERE id=?').get(p).decay_seen_count;
    const sSeen = db.prepare('SELECT decay_seen_count FROM observations WHERE id=?').get(s).decay_seen_count;
    const dSeen = db.prepare('SELECT decay_seen_count FROM observations WHERE id=?').get(d).decay_seen_count;
    expect(pSeen).toBe(1);
    expect(sSeen).toBe(1);
    expect(dSeen).toBe(1);
  });

  // D#204. The adoption gate suppressed the rollover in projects with a ~0
  // cite-rate, and the streak-only path then needed a CAP so the streak could not
  // climb without bound and pin citeFactorClause at its floor. Both halves existed
  // to protect a project that does not use the `#NN` convention from losing
  // `importance` it would never earn back.
  //
  // D#179 took importance out of the loop, so there is nothing left to suppress —
  // and what remained was INVERTED. A capped streak never returns to 0 except on a
  // citation, so a non-adopting project's uncited rows pinned at 0.5x forever,
  // while an adopting project's rolled over to 1.0x every third resolution. The
  // gate meant to be gentler on non-adopting projects had become strictly harsher
  // on them. The cap's own purpose — bounding the streak — is served by the
  // rollover anyway, and served better, because the rollover also recovers.
  //
  // So: one path for every project. This is the case that pins it.
  it('D#204: a project with ~0 cite-rate rolls the streak over like any other', () => {
    // Same construction the gate used to trip on: >= 8 resolutions on record,
    // nothing ever cited.
    const noise = makeObs({ importance: 1 });
    db.prepare('UPDATE observations SET decay_seen_count = 20, cited_count = 0 WHERE id = ?').run(noise);

    const id = makeObs({ importance: 2, uncited_streak: 0 });
    // Inject-but-never-cite across distinct sessions (a distinct sessionId bypasses
    // the idempotent skip). 6 resolutions = two full rollover cycles.
    const seen = [];
    for (let i = 1; i <= 6; i++) {
      applyCitationDecay(db, 'p', new Set([id]), new Set(), `s-${i}`);
      seen.push(db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(id).uncited_streak);
    }
    // The whole trajectory, not just the endpoint: a cap at 2 and a rollover at 3
    // agree on resolutions 1 and 2, so an endpoint-only assertion after an even
    // number of cycles would be weak evidence.
    expect(seen).toEqual([1, 2, 0, 1, 2, 0]);
    const row = db.prepare('SELECT importance, uncited_streak, demoted_at FROM observations WHERE id=?').get(id);
    expect(row.uncited_streak).toBe(0);          // recovered without a citation
    expect(row.demoted_at).toBeGreaterThan(0);   // rollover stamped here too
    expect(row.importance).toBe(2);              // still never a population change
  });

  it('importance cap: cited at importance=3 stays at 3', () => {
    const id = makeObs({ importance: 3 });
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1');
    expect(db.prepare('SELECT importance FROM observations WHERE id=?').get(id).importance).toBe(3);
  });

  it('uncited streak increment without demotion when streak < 3', () => {
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const r = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    expect(r.importance).toBe(2);
    expect(r.uncited_streak).toBe(1);
  });

  it('uncited at streak=2 → streak rolls over to 0 and demoted_at is stamped', () => {
    const id = makeObs({ importance: 2, uncited_streak: 2 });
    const before = Date.now();
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const r = db.prepare('SELECT importance, uncited_streak, demoted_at FROM observations WHERE id=?').get(id);
    expect(r.importance).toBe(2); // D#179/D#198: the rollover no longer lowers importance
    expect(r.uncited_streak).toBe(0);
    // v33: demoted_at gets a real timestamp on the rollover branch
    expect(r.demoted_at).toBeGreaterThanOrEqual(before);
    expect(r.demoted_at).toBeLessThanOrEqual(Date.now());
  });

  // These two used to pin the IMPORTANCE_FLOOR clamp (`MAX(1, imp - 1)`) — the
  // guard against burying a row at 0, where no injection surface can reach it and
  // it can never be re-cited. D#179/D#198 removed the subtraction that clamp
  // existed to bound, so the clamp is gone with it. Rewritten to pin the stronger
  // property that replaced it: the rollover leaves importance EXACTLY as it found
  // it, at every point on the scale including the two the clamp used to special-case.
  // Deleting them instead would have quietly dropped the only coverage of the
  // bottom of the range.
  it('the streak rollover leaves importance untouched at the old floor (imp=1)', () => {
    const id = makeObs({ importance: 1, uncited_streak: 2 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const r = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    expect(r.importance).toBe(1);
    expect(r.uncited_streak).toBe(0);
  });

  it('a legacy imp=0 row is left at 0 — the rollover no longer heals or buries it', () => {
    // Pre-D#179 this row healed 0 -> 1 via MAX(1, 0-1). It no longer does, and
    // that is the honest consequence: THIS LOOP leaves rows already buried at 0 by
    // the old one where they are. It is not the last word on them — `recoverBuriedLessons`
    // runs in the default auto-maintain set and lifts every LESSON-BEARING live row
    // 0 -> 1, so only lesson-less rows actually stay at 0. Said precisely because the
    // first version of this comment claimed they all do.
    // Nothing in this change is retroactive — 1199 of 2298 live rows
    // on the maintainer's DB carry at least one decay-driven importance write, and
    // that accumulated state is frozen, not reverted (there is no record of each
    // row's pre-decay value to revert to).
    const id = makeObs({ importance: 0, uncited_streak: 2 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    expect(db.prepare('SELECT importance FROM observations WHERE id=?').get(id).importance).toBe(0);
  });

  it('partial cite: of injected {100, 200}, cited={100} → 100 promoted, 200 streak++', () => {
    const id100 = makeObs({ importance: 2, uncited_streak: 0 });
    const id200 = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id100, id200]), new Set([id100]), 'sess-1');
    const a = db.prepare('SELECT importance, cited_count, uncited_streak FROM observations WHERE id=?').get(id100);
    const b = db.prepare('SELECT importance, cited_count, uncited_streak FROM observations WHERE id=?').get(id200);
    // D#179: both keep importance 2 — the two branches are told apart by
    // cited_count / uncited_streak, which is now the loop's entire output.
    expect(a.importance).toBe(2);  expect(a.cited_count).toBe(1);  expect(a.uncited_streak).toBe(0);
    expect(b.importance).toBe(2);  expect(b.cited_count).toBe(0);  expect(b.uncited_streak).toBe(1);
  });

  it('idempotency: running twice for same session is a no-op the second time', () => {
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const after1 = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    const after2 = db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id);
    expect(after2.importance).toBe(after1.importance);
    expect(after2.uncited_streak).toBe(after1.uncited_streak);
  });

  it('cross-project IDs silently ignored (no rows touched)', () => {
    insertSession(db, { id: 'sess-2', project: 'other' });
    const id = insertObs(db, { sessionId: 'sess-2', project: 'other', type: 'bugfix', title: 't', importance: 2 }).lastInsertRowid;
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    expect(db.prepare('SELECT importance, uncited_streak FROM observations WHERE id=?').get(id).importance).toBe(2);
  });

  it('returns summary { promoted, demoted, touched } for telemetry', () => {
    const a = makeObs({ importance: 2 });
    const b = makeObs({ importance: 2, uncited_streak: 2 });  // will demote
    const result = applyCitationDecay(db, 'p', new Set([a, b]), new Set([a]), 'sess-1');
    expect(result).toEqual({ promoted: 1, demoted: 1, touched: 2 });
  });

  it('escape hatch: MEM_DISABLE_CITATION_DECAY=1 → no writes, returns zeros', () => {
    const id = makeObs({ importance: 2 });
    process.env.MEM_DISABLE_CITATION_DECAY = '1';
    try {
      const result = applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1');
      expect(result).toEqual({ promoted: 0, demoted: 0, touched: 0 });
      expect(db.prepare('SELECT importance FROM observations WHERE id=?').get(id).importance).toBe(2);
    } finally { delete process.env.MEM_DISABLE_CITATION_DECAY; }
  });

  it('null/empty injected set → no-op', () => {
    const id = makeObs({ importance: 2 });
    applyCitationDecay(db, 'p', new Set(), new Set([id]), 'sess-1');
    expect(db.prepare('SELECT importance, last_decided_session_id FROM observations WHERE id=?').get(id).importance).toBe(2);
  });

  it('session dedup: same obs injected twice in one session resolves once', () => {
    // Mirrors spec Test #1: Read→Edit both inject #100 in one session.
    // The caller assembles ONE injected set per session — passing it twice
    // mimics the Stop hook firing twice (idempotent skip on second call).
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    expect(db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(id).uncited_streak).toBe(1);
    // Second invocation (whether from another Stop fire or a duplicate scan) — no change.
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    expect(db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(id).uncited_streak).toBe(1);
  });
});

describe('applyCitationDecay — cross-turn late citation (uncited→cited upgrade within a session)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
  });
  afterEach(() => { try { db.close(); } catch {} });

  function makeObs(overrides = {}) {
    const id = insertObs(db, { sessionId: 'sess-1', project: 'p', type: 'bugfix', title: 't', importance: 2, ...overrides }).lastInsertRowid;
    if (overrides.uncited_streak !== undefined || overrides.cited_count !== undefined || overrides.last_decided_session_id !== undefined) {
      db.prepare(`UPDATE observations SET uncited_streak = ?, cited_count = ?, last_decided_session_id = ? WHERE id = ?`)
        .run(overrides.uncited_streak ?? 0, overrides.cited_count ?? 0, overrides.last_decided_session_id ?? null, id);
    }
    return id;
  }

  it('a citation in a LATER turn of the same session promotes a previously-uncited obs', () => {
    // Contract: "cite NEXT time you produce user-visible text" — may be several turns
    // later. Pre-fix, the turn-1 uncited resolution froze the verdict (last_decided=S),
    // and the turn-3 citation was skipped as an idempotent no-op → signal lost.
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    const r1 = applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');   // turn 1: not yet cited
    expect(r1).toEqual({ promoted: 0, demoted: 0, touched: 1 });
    expect(db.prepare('SELECT uncited_streak, importance FROM observations WHERE id=?').get(id).uncited_streak).toBe(1);

    const r2 = applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1'); // turn 3: now cited
    expect(r2.promoted).toBe(1);
    expect(r2.touched).toBe(0); // already in the injected denominator from turn 1 — not re-counted
    const row = db.prepare('SELECT importance, cited_count, uncited_streak, decay_seen_count, last_cited_session_id FROM observations WHERE id=?').get(id);
    expect(row.importance).toBe(2); // D#179: untouched
    expect(row.cited_count).toBe(1);
    expect(row.uncited_streak).toBe(0);
    expect(row.last_cited_session_id).toBe('sess-1');
    expect(row.decay_seen_count).toBe(1); // counted ONCE (turn 1), not double-counted on the upgrade
  });

  // Pre-D#179 this test read the undo off `importance` (1 -> 2). That column is no
  // longer written, so the undo is asserted on the state the rollover actually
  // owns: demoted_at set, then cleared by the late citation. Same property, read
  // through the signal that still moves.
  it('a late citation undoes a same-session streak rollover (demoted_at cleared)', () => {
    const id = makeObs({ importance: 2, uncited_streak: 2 }); // one more uncited → rollover
    const r1 = applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');
    expect(r1.demoted).toBe(1);
    const mid = db.prepare('SELECT importance, uncited_streak, demoted_at FROM observations WHERE id=?').get(id);
    expect(mid.importance).toBe(2);              // not lowered
    expect(mid.demoted_at).toBeGreaterThan(0);   // rollover stamped

    const r2 = applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1'); // late cite
    expect(r2.promoted).toBe(1);
    const row = db.prepare('SELECT importance, cited_count, uncited_streak, demoted_at FROM observations WHERE id=?').get(id);
    expect(row.importance).toBe(2);   // still untouched by either branch
    expect(row.demoted_at).toBeNull(); // the undo
    expect(row.cited_count).toBe(1);
    expect(row.uncited_streak).toBe(0);
  });

  it('the promote upgrade is itself idempotent (guarded by last_cited_session_id)', () => {
    // The "climb" this used to watch on importance is now watched on cited_count,
    // which is the counter the idempotency key actually guards.
    const id = makeObs({ importance: 1, uncited_streak: 0 });
    applyCitationDecay(db, 'p', new Set([id]), new Set(), 'sess-1');        // uncited
    applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1');    // upgrade → promote
    const after1 = db.prepare('SELECT importance, cited_count FROM observations WHERE id=?').get(id);
    expect(after1.importance).toBe(1);
    expect(after1.cited_count).toBe(1);

    const r3 = applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1'); // re-fire cited
    expect(r3.promoted).toBe(0); // already promoted this session
    const after2 = db.prepare('SELECT importance, cited_count FROM observations WHERE id=?').get(id);
    expect(after2.importance).toBe(1);
    expect(after2.cited_count).toBe(1); // NOT double-counted
  });

  it('first-resolution cited (injected + cited in one call) still counts touched AND promoted', () => {
    // Regression guard: the common "cite it right away" path must be unchanged —
    // it IS a first resolution, so it enters the injected denominator (touched=1).
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    const r = applyCitationDecay(db, 'p', new Set([id]), new Set([id]), 'sess-1');
    expect(r).toEqual({ promoted: 1, demoted: 0, touched: 1 });
    const row = db.prepare('SELECT decay_seen_count, last_cited_session_id, last_decided_session_id FROM observations WHERE id=?').get(id);
    expect(row.decay_seen_count).toBe(1);
    expect(row.last_cited_session_id).toBe('sess-1');
    expect(row.last_decided_session_id).toBe('sess-1');
  });
});

describe('Stop hook integration — fixture transcript composition', () => {
  let db, tmp;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-int', project: 'p' });
    tmp = mkdtempSync(join(tmpdir(), 'cite-int-'));
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  function makeObs(overrides = {}) {
    const result = insertObs(db, {
      sessionId: 'sess-int', project: 'p', type: 'bugfix', title: 't', importance: 2,
      ...overrides,
    });
    const id = result.lastInsertRowid;
    // Apply the citation-decay defaults via raw update (test-helpers doesn't know about new columns).
    if (overrides.uncited_streak !== undefined || overrides.cited_count !== undefined || overrides.last_decided_session_id !== undefined) {
      db.prepare(`
        UPDATE observations
        SET uncited_streak = ?, cited_count = ?, last_decided_session_id = ?
        WHERE id = ?
      `).run(
        overrides.uncited_streak ?? 0,
        overrides.cited_count ?? 0,
        overrides.last_decided_session_id ?? null,
        id
      );
    }
    return id;
  }

  it('fixture transcript with one injected #ID and a citation → promotion', () => {
    const id = makeObs({ importance: 2 });
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, [
      // PreToolUse mem injection
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_success', hookName: 'PreToolUse:Read',
          command: 'pre-tool-recall.js',
          stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `  #${id} [bugfix] sample` } }),
          stderr: '', exitCode: 0,
        },
      }),
      // Assistant cites it (main thread)
      JSON.stringify({
        type: 'assistant', isSidechain: false,
        message: { content: [{ type: 'text', text: `applied #${id}, all good` }] },
      }),
    ].join('\n'));

    const injected = extractInjectedFromPreToolUse(path);
    const cited = extractCitationsFromTranscript(path, { mainOnly: true });
    const result = applyCitationDecay(db, 'p', injected, cited, 'sess-int');
    expect(result).toEqual({ promoted: 1, demoted: 0, touched: 1 });
    // D#179: the promote lands in cited_count, not importance.
    const r = db.prepare('SELECT importance, cited_count FROM observations WHERE id=?').get(id);
    expect(r.cited_count).toBe(1);
    expect(r.importance).toBe(2);
  });

  it('cite-back signal promotes an injected obs the agent edited but never cited (P5 ①)', async () => {
    const { extractCiteBackSignals } = await import('../lib/cite-back-hint.mjs');
    const id = makeObs({ importance: 2, uncited_streak: 0 });
    const path = join(tmp, 'transcript.jsonl');
    const hint = `[mem] ⚠ Cite-back: edited 1 file(s) with 1 prior lesson(s) this session. Save now if any was the root cause:\n  • foo.mjs ← #${id} — /lesson --file foo.mjs "<root cause + fix>"`;
    writeFileSync(path, [
      // PreToolUse injected the lesson…
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_success', hookName: 'PreToolUse:Edit', command: 'pre-tool-recall.js',
          stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `  #${id} [bugfix] sample` } }),
          stderr: '', exitCode: 0,
        },
      }),
      // …PostToolUse cite-back hint fired (agent edited the warned file)…
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_success', hookName: 'PostToolUse', command: 'hook.mjs post-tool-use',
          stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: hint } }),
          stderr: '', exitCode: 0,
        },
      }),
      // …but the assistant produced text WITHOUT citing #NN.
      JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'text', text: 'fixed the bug, no explicit cite' }] } }),
    ].join('\n'));

    // Replicate the Stop handler union.
    const injected = extractInjectedFromPreToolUse(path);
    const citeBack = extractCiteBackSignals(path);
    for (const cid of citeBack) injected.add(cid);
    const cited = extractCitationsFromTranscript(path, { mainOnly: true });
    for (const cid of citeBack) cited.add(cid);

    const result = applyCitationDecay(db, 'p', injected, cited, 'sess-int');
    expect(result.promoted).toBe(1);
    const rb = db.prepare('SELECT importance, cited_count, uncited_streak FROM observations WHERE id=?').get(id);
    expect(rb.cited_count).toBe(1);   // D#179: cite-back credits the counter…
    expect(rb.importance).toBe(2);    // …and leaves the population gate alone
  });

  it('fixture transcript: injection from sidechain agent does NOT promote main', () => {
    const id = makeObs({ importance: 2 });
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_success', hookName: 'PreToolUse:Read',
          command: 'pre-tool-recall.js',
          stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `  #${id} [bugfix] sample` } }),
          stderr: '', exitCode: 0,
        },
      }),
      // Only the sub-agent cites it — main thread silent
      JSON.stringify({
        type: 'assistant', isSidechain: true,
        message: { content: [{ type: 'text', text: `sub-agent used #${id}` }] },
      }),
    ].join('\n'));

    const injected = extractInjectedFromPreToolUse(path);
    const cited = extractCitationsFromTranscript(path, { mainOnly: true });
    const result = applyCitationDecay(db, 'p', injected, cited, 'sess-int');
    expect(result.touched).toBe(1);
    expect(result.promoted).toBe(0);
    expect(db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(id).uncited_streak).toBe(1);
  });
});

describe('applyCitationDecay — the removed adoption-rate gate (D#204)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
  });
  afterEach(() => { try { db.close(); } catch {} });

  // makeObs + raw set of the citation-decay history columns (incl. decay_seen_count,
  // which insertObs doesn't know about) so we can simulate a project's prior
  // citation history.
  function makeObs({ importance = 2, uncited_streak = 0, cited_count = 0, decay_seen_count = 0 } = {}) {
    const id = insertObs(db, { sessionId: 'sess-1', project: 'p', type: 'bugfix', title: 't', importance }).lastInsertRowid;
    db.prepare(`UPDATE observations SET uncited_streak = ?, cited_count = ?, decay_seen_count = ? WHERE id = ?`)
      .run(uncited_streak, cited_count, decay_seen_count, id);
    return id;
  }

  // D#204 removed this gate. What is left to pin is that its three former inputs
  // — a ~0 cite-rate, a below-min-seen history, and the env override — now select
  // the SAME behaviour, and that the env var says so instead of going quiet.
  //
  // Each case names the cite-rate it used to trip on, so if the gate is ever
  // re-introduced these turn red at the exact populations it discriminated.
  it('a ~0 cite-rate project (the old suppression band) rolls over like any other', () => {
    const target = makeObs({ importance: 2, uncited_streak: 2, decay_seen_count: 20, cited_count: 0 });
    const r = applyCitationDecay(db, 'p', new Set([target]), new Set(), 'sess-1');
    const row = db.prepare('SELECT importance, uncited_streak, demoted_at FROM observations WHERE id=?').get(target);
    expect(row.demoted_at).toBeGreaterThan(0); // used to be NULL under suppression
    expect(row.uncited_streak).toBe(0);        // used to be capped at 2, forever
    expect(row.importance).toBe(2);
    expect(r.demoted).toBe(1);                 // used to be 0
    expect(r.touched).toBe(1);
  });

  it('an adopting project (cite-rate well over the old threshold) is indistinguishable', () => {
    const target = makeObs({ importance: 2, uncited_streak: 2, decay_seen_count: 20, cited_count: 5 });
    applyCitationDecay(db, 'p', new Set([target]), new Set(), 'sess-1');
    const row = db.prepare('SELECT importance, uncited_streak, demoted_at FROM observations WHERE id=?').get(target);
    expect(row.demoted_at).toBeGreaterThan(0);
    expect(row.uncited_streak).toBe(0);
    expect(row.importance).toBe(2);
  });

  it('a low-data project (under the old min-seen) is indistinguishable', () => {
    const target = makeObs({ importance: 2, uncited_streak: 2, decay_seen_count: 2, cited_count: 0 });
    applyCitationDecay(db, 'p', new Set([target]), new Set(), 'sess-1');
    const row = db.prepare('SELECT uncited_streak, demoted_at FROM observations WHERE id=?').get(target);
    expect(row.demoted_at).toBeGreaterThan(0);
    expect(row.uncited_streak).toBe(0);
  });

  it('CLAUDE_MEM_CITATION_ADOPTION_THRESHOLD is inert AND warns — not silently ignored', () => {
    // 0.5 used to suppress a 15%-cite-rate project. It must now change nothing,
    // and must not do that quietly: an accepted setting that means nothing is
    // worse than an unsupported one (the CLAUDE_MEM_RECOMMEND_MODE=live precedent).
    const target = makeObs({ importance: 2, uncited_streak: 2, decay_seen_count: 20, cited_count: 3 });
    const realWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    process.env.CLAUDE_MEM_CITATION_ADOPTION_THRESHOLD = '0.5';
    try {
      applyCitationDecay(db, 'p', new Set([target]), new Set(), 'sess-1');
    } finally {
      process.stderr.write = realWrite;
      delete process.env.CLAUDE_MEM_CITATION_ADOPTION_THRESHOLD;
    }
    const row = db.prepare('SELECT uncited_streak, demoted_at FROM observations WHERE id=?').get(target);
    expect(row.demoted_at).toBeGreaterThan(0); // NOT suppressed
    expect(row.uncited_streak).toBe(0);
    expect(captured).toMatch(/CITATION_ADOPTION_THRESHOLD/);
    expect(captured).toMatch(/no longer has any effect/);
  });

  it('promotion is never gated — a cited obs still promotes in a non-adopting project', () => {
    const target = makeObs({ importance: 2, uncited_streak: 0, decay_seen_count: 20, cited_count: 0 });
    applyCitationDecay(db, 'p', new Set([target]), new Set([target]), 'sess-1');
    const row = db.prepare('SELECT importance, cited_count FROM observations WHERE id=?').get(target);
    expect(row.cited_count).toBe(1); // promote ran despite the suppression gate
    expect(row.importance).toBe(2);
  });
});

describe('regression: extractor + decay defensive paths (D#21)', () => {
  let tmp, db;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cite-reg-'));
    db = createTestDb();
    insertSession(db, { id: 'sess-r', project: 'p' });
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it('extractInjectedFromPreToolUse: falls back to raw-text scan when stdout is not JSON', () => {
    const path = join(tmp, 't.jsonl');
    writeFileSync(path, JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        hookName: 'PreToolUse:Read',
        command: 'pre-tool-recall.js',
        stdout: '[mem] Lessons for foo.js:\n  #404 [bugfix] raw-text fallback path',
        stderr: '',
        exitCode: 0,
      },
    }));
    const ids = extractInjectedFromPreToolUse(path);
    expect(ids.has(404)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('applyCitationDecay: silently skips IDs that are not in observations (events-table ID case)', () => {
    const realId = insertObs(db, { sessionId: 'sess-r', project: 'p', type: 'bugfix', title: 't', importance: 2 }).lastInsertRowid;
    const ghostId = 99999999;
    const result = applyCitationDecay(db, 'p', new Set([realId, ghostId]), new Set(), 'sess-r');
    expect(result.touched).toBe(1);
    expect(result.demoted).toBe(0);
    expect(result.promoted).toBe(0);
    const realRow = db.prepare('SELECT uncited_streak FROM observations WHERE id=?').get(realId);
    expect(realRow.uncited_streak).toBe(1);
    const ghost = db.prepare('SELECT id FROM observations WHERE id=?').get(ghostId);
    expect(ghost).toBeUndefined();
  });
});

// ─── D#61 (G10, roadmap Phase 2): superseded → keeper credit redirect ─────────

describe('applyCitationDecay — superseded keeper redirect (D#61)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
  });
  afterEach(() => { try { db.close(); } catch {} });

  function obs(over = {}) {
    return insertObs(db, { sessionId: 'sess-1', project: 'p', type: 'bugfix', title: 't', importance: 2, ...over }).lastInsertRowid;
  }
  function supersede(oldId, keeperId) {
    db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?')
      .run(Date.now(), keeperId, oldId);
  }
  const row = (id) => db.prepare('SELECT importance, cited_count, uncited_streak, decay_seen_count FROM observations WHERE id=?').get(id);

  it('citing a mid-session-superseded lesson credits the keeper', () => {
    const oldId = obs();
    const keeper = obs();
    supersede(oldId, keeper);
    // Injected live as oldId, then auto-dedup superseded it before Stop resolved.
    const r = applyCitationDecay(db, 'p', new Set([oldId]), new Set([oldId]), 'sess-1');
    expect(r.promoted).toBe(1);
    const k = row(keeper);
    expect(k.cited_count).toBe(1);
    expect(k.importance).toBe(2); // D#179: credit lands in cited_count only
    // The tombstone itself stays untouched (defense-in-depth parity holds).
    expect(row(oldId).cited_count).toBe(0);
  });

  it('an uncited superseded injection streaks the keeper (denominator follows content)', () => {
    const oldId = obs();
    const keeper = obs();
    supersede(oldId, keeper);
    const r = applyCitationDecay(db, 'p', new Set([oldId]), new Set(), 'sess-1');
    expect(r.touched).toBe(1);
    expect(row(keeper).uncited_streak).toBe(1);
    expect(row(oldId).uncited_streak).toBe(0);
  });

  it('non-numeric / self-referential superseded_by credits nobody and does not throw', () => {
    const a = obs();
    db.prepare(`UPDATE observations SET superseded_at = ?, superseded_by = 'sess-string-junk' WHERE id = ?`).run(Date.now(), a);
    const b = obs();
    db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?').run(Date.now(), b, b);
    const r = applyCitationDecay(db, 'p', new Set([a, b]), new Set([a, b]), 'sess-1');
    expect(r.promoted).toBe(0);
    expect(r.touched).toBe(0);
  });

  it('redirect dedups: old id and keeper both injected → keeper resolved once', () => {
    const oldId = obs();
    const keeper = obs();
    supersede(oldId, keeper);
    const r = applyCitationDecay(db, 'p', new Set([oldId, keeper]), new Set([oldId]), 'sess-1');
    expect(r.touched).toBe(1);
    const k = row(keeper);
    expect(k.cited_count).toBe(1);
    expect(k.decay_seen_count).toBe(1);
  });
});

// D#139 — redirectSupersededIds promises "callers own their input sets": every
// return, including the two bail-outs, is a COPY. Both callers (applyCitationDecay,
// recordCitationSurfaces) happen not to mutate the result today, so reverting either
// bail-out to `return src` left all 71 surface-funnel + decay cases green. Nothing
// pinned the alias contract itself — this does, at the only two places it can break.
describe('redirectSupersededIds copy-on-bail contract (D#139)', () => {
  // FAILS IF: `if (!db || !project) return new Set(src)` becomes `return src` —
  // the caller's own Set is handed back and a downstream .add() mutates it.
  it('the no-db bail-out returns a copy, not the caller\'s Set', () => {
    const input = new Set([1, 2]);
    const out = redirectSupersededIds(null, 'p1', input);
    expect(out).not.toBe(input);
    out.add(999);
    expect([...input], 'caller\'s Set was mutated through the returned alias').toEqual([1, 2]);
  });

  it('the no-project bail-out returns a copy too', () => {
    const input = new Set([7]);
    const out = redirectSupersededIds({}, null, input);
    expect(out).not.toBe(input);
    out.add(8);
    expect([...input]).toEqual([7]);
  });

  // FAILS IF: the prepare-catch bail-out becomes `return src`. A db handle whose
  // prepare() throws is the real shape here (closed/corrupt DB mid-Stop).
  it('the prepare-failure bail-out returns a copy', () => {
    const input = new Set([42]);
    const brokenDb = { prepare() { throw new Error('database connection is closed'); } };
    const out = redirectSupersededIds(brokenDb, 'p1', input);
    expect(out).not.toBe(input);
    expect([...out]).toEqual([42]);   // contents preserved: bail-out is pass-through
    out.add(43);
    expect([...input]).toEqual([42]);
  });
});
