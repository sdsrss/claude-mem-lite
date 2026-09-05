// Characterizes searchByFts's offline-replay options ({ nowT, epochTo }) added
// so a benchmark can reconstruct the exact scored candidate list a past
// UserPromptSubmit session saw. See scripts/user-prompt-search.js::searchByFts.
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { searchByFts } from '../scripts/user-prompt-search.js';

// Raw INSERT (not test-helpers' insertObs) so epoch can be an exact historical
// value rather than an offset from Date.now(). memory_session_id is required
// (observations.memory_session_id NOT NULL + FK -> sdk_sessions) — every seeded
// row is attached to the 'mem-s1' session created by insertSession() below.
function seed(db, rows) {
  const ins = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, lesson_learned, importance, created_at, created_at_epoch)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows)
    ins.run(
      'mem-s1',
      r.project ?? 'p',
      r.type ?? 'bugfix',
      r.title,
      r.lesson,
      r.importance ?? 2,
      new Date(r.epoch).toISOString(),
      r.epoch,
    );
}

// LOOKBACK_MS (60 days, scripts/user-prompt-search.js) applies independently of
// epochTo: the WHERE clause keeps its existing `created_at_epoch > cutoff` gate
// where cutoff = nowT - LOOKBACK_MS. Epochs below are chosen relative to Date.now()
// (test 1) / to a fixed T (test 2) so both stay well inside that 60-day window and
// each test isolates the thing it claims to check (see test-1-report.md for the
// brief's original absolute epochs, which straddle the lookback window and would
// fail regardless of epochTo correctness).
describe('searchByFts offline-replay options', () => {
  it('no-options behavior is unchanged (characterization)', () => {
    const db = createTestDb();
    insertSession(db, { id: 'mem-s1', project: 'p' });
    seed(db, [
      { title: 'rrf merge dedup', lesson: 'use rrfAccumulate for merge', epoch: Date.now() - 5 * 86400000 },
    ]);
    const { rows, mode } = searchByFts(db, 'rrf merge', 'p', 5, null);
    expect(mode).toBeTruthy();
    expect(rows[0]).toHaveProperty('relevance');
    expect(rows[0]).toHaveProperty('bm25_raw');
    expect(rows[0].title).toBe('rrf merge dedup');
  });

  it('epochTo excludes rows created after the snapshot instant', () => {
    const db = createTestDb();
    insertSession(db, { id: 'mem-s1', project: 'p' });
    const T = 1_750_000_000_000;
    seed(db, [
      { title: 'old rrf lesson', lesson: 'rrfAccumulate', epoch: T - 10 * 86400000 },
      { title: 'new rrf lesson', lesson: 'rrfAccumulate', epoch: T + 10 * 86400000 },
    ]);
    const { rows } = searchByFts(db, 'rrf', 'p', 10, null, { nowT: T, epochTo: T });
    const titles = rows.map((r) => r.title);
    expect(titles).toContain('old rrf lesson');
    expect(titles).not.toContain('new rrf lesson');
  });
});
