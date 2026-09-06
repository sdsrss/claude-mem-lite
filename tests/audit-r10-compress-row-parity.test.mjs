// R10 P3-8 — smart-compress hand-wrote its observations INSERT instead of going through
// insertObservationRow, and the two had already drifted. That shared writer exists for
// exactly this reason: "The column list lives only here, so a schema column can never
// drift between the two ingest paths again" (lib/observation-write.mjs). A third path
// spelling the INSERT itself is the twin-drift class CLAUDE.md names by name.
//
// What the hand-written copy dropped:
//   minhash_sig  NULL, so the summary is invisible to the MinHash prefilter that
//                findDuplicates and selectFuzzyDedupeIds run before Jaccard — the summary
//                can never be deduplicated against anything.
//   branch       NULL, while every other write path records it.
//   subtitle     written as '' rather than the schema/OBS_DEFAULTS NULL.
//   scope        absent from the column list entirely.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));
vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  BG_LLM_TIMEOUT_MS: 45000,
}));
import { callModelJSONAsync } from '../haiku-client.mjs';

const NARR =
  'A long-running background compaction pass groups observations by project and week, ' +
  'summarizes each group with one model call, and hides the originals behind the summary. ';

describe('R10 P3-8 — the smart-compress summary row is written like every other row', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => db.close());

  async function compressOne() {
    const { executeSmartCompress } = await import('../hook-optimize.mjs');
    // findSmartCompressCandidates requires importance 1, access_count 0, no lesson, and
    // created_at_epoch older than 30 days. Age the rows explicitly rather than hoping.
    const old = Date.now() - 45 * 24 * 3600 * 1000;
    for (let i = 0; i < 4; i++) {
      insertObs(db, { type: 'change', importance: 1, title: `compaction note ${i}`, narrative: NARR });
    }
    db.prepare('UPDATE observations SET created_at_epoch = ?, access_count = 0').run(old);
    callModelJSONAsync.mockResolvedValue({
      title: 'Weekly compaction summary',
      narrative: 'Four notes about the same compaction pass.',
      concepts: ['compaction', 'summary'],
      facts: ['one model call per group'],
      lesson_learned: 'group before summarizing',
      search_aliases: ['weekly digest'],
    });
    return executeSmartCompress(db, 5, {});
  }

  it('gives the summary a minhash_sig, so it can be deduplicated like any other row', async () => {
    await compressOne();
    const summary = db.prepare(`SELECT * FROM observations WHERE title = 'Weekly compaction summary'`).get();
    expect(summary, 'premise: no summary row was written, so this case proves nothing').toBeTruthy();
    expect(summary.minhash_sig, 'summary is invisible to the MinHash dedup prefilter').toBeTruthy();
  });

  it('leaves subtitle NULL, matching OBS_DEFAULTS and every other writer', async () => {
    await compressOne();
    const summary = db
      .prepare(`SELECT subtitle FROM observations WHERE title = 'Weekly compaction summary'`)
      .get();
    expect(summary.subtitle).toBeNull();
  });

  it('writes through the shared column list', async () => {
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(join(repo, 'hook-optimize.mjs'), 'utf8');
    // The forbidden shape is a hand-spelled column list with VALUES — a second copy of
    // OBS_COLUMNS that drifts. NOT `INSERT INTO observations (...) SELECT ...`: the
    // keeper-snapshot at hook-optimize.mjs:845 is one of those, its column list is read out
    // of PRAGMA table_info at runtime so it cannot drift, and it copies a whole row
    // including columns OBS_COLUMNS does not carry. Routing that through the shared writer
    // would lose data, which is why the predicate names VALUES specifically.
    expect(
      src,
      'hook-optimize still spells an observations INSERT ... VALUES by hand — the drift class this fix closed',
    ).not.toMatch(/INSERT INTO observations[\s\S]{0,400}?VALUES\s*\(/);
    expect(src).toContain('insertObservationRow(');
    // And the snapshot form is still there, still schema-derived — the exemption is real,
    // not a hole someone can widen into a new hand-spelled INSERT.
    expect(src).toMatch(/INSERT INTO observations \(\$\{snapColList\}/);
    expect(src).toContain('PRAGMA table_info(observations)');
  });
});
