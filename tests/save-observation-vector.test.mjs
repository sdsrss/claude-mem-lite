// I-1 (v3.39.2): the manual-save / promoted-events vector text must include
// lesson_learned. save-observation.mjs already builds `indexText` =
// [title, content, lesson] for the FTS `text` field, but the TF-IDF vector was
// fed only `title + ' ' + content` — so a lesson-only term was invisible to the
// vector arm (finding #8: the exact "invisible to cosine similarity" gap
// buildVecText was extracted to close, left un-applied on this write path).
//
// Vectors are choke-point-gated OFF by default (CLAUDE_MEM_VECTORS), so these
// tests turn the arm ON and seed a vocab to exercise the write path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';

describe('saveObservation vector text includes lesson_learned', () => {
  let db;
  let prevVec;
  beforeEach(async () => {
    prevVec = process.env.CLAUDE_MEM_VECTORS;
    process.env.CLAUDE_MEM_VECTORS = '1';
    db = createTestDb();
    insertSession(db, { id: 'manual-test', project: 'test' });
    // Seed 8 docs so BOTH "deadlock" (df=5) and "raceflux" (df=3) enter the vocab
    // with df < N → non-zero IDF. "deadlock" is the shared base term (so A and B
    // both get a non-zero vector); "raceflux" is the lesson-only differentiator.
    for (let i = 0; i < 8; i++) {
      const base = i < 5 ? 'deadlock' : 'filler';
      const extra = i < 3 ? 'raceflux' : 'otherterm';
      insertObs(db, {
        sessionId: 'manual-test',
        project: 'test',
        type: 'bugfix',
        title: `note ${i}`,
        narrative: `${base} ${extra} in the pool handler ${i}`,
        text: `${base} ${extra} pool handler ${i}`,
      });
    }
    const { rebuildVocabulary, _resetVocabCache } = await import('../tfidf.mjs');
    _resetVocabCache();
    rebuildVocabulary(db);
  });
  afterEach(() => {
    db.close();
    if (prevVec === undefined) delete process.env.CLAUDE_MEM_VECTORS;
    else process.env.CLAUDE_MEM_VECTORS = prevVec;
  });

  it('a lesson-only vocab term changes the stored vector', () => {
    // Two saves, identical title+content ("deadlock" → shared non-zero base),
    // differing ONLY in lesson_learned. "raceflux" is in vocab but appears in
    // neither title nor content, so the vectors can differ ONLY if lesson_learned
    // reaches the vector text.
    const T = new Date('2026-01-01T00:00:00Z');
    const withLesson = saveObservation(db, {
      content: 'deadlock occurred in the pool',
      title: 'shared title',
      type: 'discovery',
      project: 'test',
      lesson_learned: 'raceflux is the real cause',
      now: T,
    });
    // +6 min to clear the 5-min dedup window (identical title+content would
    // otherwise be flagged a near-duplicate and skipped).
    const noLesson = saveObservation(db, {
      content: 'deadlock occurred in the pool',
      title: 'shared title',
      type: 'discovery',
      project: 'test',
      now: new Date(T.getTime() + 6 * 60 * 1000),
    });
    expect(withLesson.kind).toBe('saved');
    expect(noLesson.kind).toBe('saved');

    const vecOf = (id) =>
      db.prepare('SELECT vector FROM observation_vectors WHERE observation_id = ?').get(id)?.vector;
    const a = vecOf(withLesson.id);
    const b = vecOf(noLesson.id);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Before the fix both vec texts = title+content → byte-identical vectors.
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});
