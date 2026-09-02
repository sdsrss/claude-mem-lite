// R3 V-F1/V-F2 (MED, off-default vector arm): the v3.39.2 "vector-arm parity" fix added
// lesson_learned + search_aliases to the SAVE-path vector text, but (V-F2) buildVocabulary
// never counted those fields — so a term living only in a lesson/alias got no vocab dimension
// and was silently dropped — and (V-F1) six REBUILD paths still used [title,narrative,concepts],
// so the documented `maintain rebuild_vectors` step re-encoded every vector WITHOUT the lesson.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { VEC_HIT_OBS_COLS } from '../search-engine.mjs';

// v3.42 F4 (MED, off-default vector arm): the FTS-empty/vector-hit fallback branch's SELECT
// had dropped lesson_learned while its RRF-merge twin kept it, so a vector-only hit returned
// lesson_learned: undefined (lost content + the 1.5× lesson scoring boost). The two branches
// now share ONE column constant so they cannot drift. This path is off-default
// (CLAUDE_MEM_VECTORS=1) AND near-unreachable at runtime (FTS-empty requires the query vector
// to be zero too, except under FTS/vector tokenization divergence), so the guard is
// structural: assert the shared constant carries the fields both branches read, and that no
// vector-hit fetch keeps its own hardcoded column list.
describe('vector-hit fetch column parity (F4)', () => {
  it('VEC_HIT_OBS_COLS carries every field both branches build (lesson_learned + created_at)', () => {
    for (const col of ['lesson_learned', 'created_at', 'created_at_epoch', 'title', 'importance', 'branch']) {
      expect(VEC_HIT_OBS_COLS.split(/\s*,\s*/), `VEC_HIT_OBS_COLS must include ${col}`).toContain(col);
    }
  });

  it('both vector-hit SELECTs use the shared constant — no hardcoded observation column list', () => {
    // D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to search-engine.mjs.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'search-engine.mjs'), 'utf8');
    // Both vector-hit fetches must read `SELECT ${VEC_HIT_OBS_COLS} FROM observations WHERE id = ?`.
    const shared = (src.match(/SELECT \$\{VEC_HIT_OBS_COLS\} FROM observations WHERE id = \?/g) || []).length;
    expect(shared, 'both vector-hit branches must fetch via VEC_HIT_OBS_COLS').toBe(2);
    // And no vector-hit fetch may keep a literal `SELECT id, type, title … FROM observations WHERE id = ?`.
    const literal = (src.match(/SELECT id, type, title[^`']*FROM observations WHERE id = \?/g) || []).length;
    expect(literal, 'no hardcoded per-branch column list may remain').toBe(0);
  });
});

// Row-shape parity, behavioral twin of the structural check above: VEC_HIT_OBS_COLS
// SELECTs created_at + created_at_epoch, but the two vector-hit row CONSTRUCTORS only
// copied `date`. A vector-only hit therefore reached consumers with created_at
// undefined — the CLI prints its date as undefined (mem-cli.mjs fmtDateShort) and
// applyUserSort reads `created_at_epoch ?? 0`, sinking the row to the bottom under
// --sort time. The FTS twin (ftsRowToResult) carries all three keys.
describe('vector-hit row shape carries the date keys the FTS row does', () => {
  let db, prevVec;
  beforeEach(() => {
    prevVec = process.env.CLAUDE_MEM_VECTORS;
    process.env.CLAUDE_MEM_VECTORS = '1';
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => {
    db.close();
    if (prevVec === undefined) delete process.env.CLAUDE_MEM_VECTORS; else process.env.CLAUDE_MEM_VECTORS = prevVec;
  });

  it('a vector-only hit (RRF-merge branch) has created_at and created_at_epoch', async () => {
    // ftsOnly carries BOTH query terms → matches the AND query. vecOnly carries only
    // the shared term → no FTS match, but a strong cosine to the query vector, so it
    // enters results exclusively through the vector-hit constructor.
    insertObs(db, { title: 'zylphqax quorumbeta rollout', narrative: 'zylphqax quorumbeta staged rollout across the fleet', text: 'zylphqax quorumbeta rollout' });
    insertObs(db, { title: 'zylphqax capacity note', narrative: 'zylphqax capacity planning across the fleet', text: 'zylphqax capacity note' });
    // filler so the shared terms clear the df>=2 vocabulary floor
    insertObs(db, { title: 'fleet capacity review', narrative: 'capacity planning rollout across the fleet', text: 'fleet capacity review' });

    const { getVocabulary, _resetVocabCache, computeVector } = await import('../tfidf.mjs');
    const { searchObservationsHybrid } = await import('../search-engine.mjs');
    _resetVocabCache();
    const vocab = getVocabulary(db);
    expect(vocab, 'vocabulary builds from the seeded corpus').toBeTruthy();
    for (const o of db.prepare('SELECT id, title, narrative FROM observations').all()) {
      const vec = computeVector(`${o.title} ${o.narrative}`, vocab);
      if (vec) {
        db.prepare('INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)')
          .run(o.id, Buffer.from(vec.buffer), vocab.version, Date.now());
      }
    }

    const rows = searchObservationsHybrid(db, {
      ftsQuery: 'zylphqax AND quorumbeta', args: { project: 'test' },
      epochFrom: null, epochTo: null,
      perSourceLimit: 10, perSourceOffset: 0, currentProject: 'test', limit: 10,
    });

    const vecOnly = rows.find(r => r.title === 'zylphqax capacity note');
    expect(vecOnly, 'vector arm surfaced the row FTS could not match').toBeTruthy();
    expect(vecOnly.created_at, 'vector-hit row must carry created_at like the FTS row').toBeTruthy();
    expect(typeof vecOnly.created_at_epoch, 'vector-hit row must carry created_at_epoch for --sort time').toBe('number');
  });
});

describe('vector field-set: lesson/aliases reach vocab + rebuild paths (R3 V-F1/V-F2)', () => {
  let db, prevVec;
  beforeEach(() => {
    prevVec = process.env.CLAUDE_MEM_VECTORS;
    process.env.CLAUDE_MEM_VECTORS = '1';
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => {
    db.close();
    if (prevVec === undefined) delete process.env.CLAUDE_MEM_VECTORS; else process.env.CLAUDE_MEM_VECTORS = prevVec;
  });

  it('buildVocabulary gives a dimension to a term that appears only in lesson_learned (V-F2)', async () => {
    for (let i = 0; i < 3; i++) insertObs(db, {
      title: `database migration note ${i}`,
      narrative: `narrative about a schema migration rollout number ${i} touching several tables and indexes`,
      lessonLearned: 'always exercise the redisfailover path before deploy',
    });
    const { buildVocabulary, _resetVocabCache, tokenize } = await import('../tfidf.mjs');
    _resetVocabCache();
    const vocab = buildVocabulary(db);
    expect(vocab, 'vocab builds from corpus').toBeTruthy();
    const stem = tokenize('redisfailover')[0]; // tokenizer stems; assert the term in its stored form
    expect([...vocab.terms.keys()], 'lesson-only term must get a vocab dimension').toContain(stem);
  });

  it('maintain rebuild_vectors encodes the lesson field, byte-identical to the save path (V-F1)', async () => {
    // target carries a distinctive lesson-only term; 2 sibling docs give it a vocab dimension
    insertObs(db, { type: 'decision', title: 'coordination service choice', narrative: 'we picked a coordination service for leader election across the cluster nodes reliably', lessonLearned: 'zookeeper session expiry needs careful watch re-registration' });
    for (let i = 0; i < 2; i++) insertObs(db, { type: 'discovery', title: `zookeeper watch note ${i}`, narrative: `zookeeper ephemeral node and watch semantics explored ${i} for the cluster` });

    const { rebuildVectors } = await import('../lib/maintain-core.mjs');
    const { getVocabulary, _resetVocabCache, computeVector } = await import('../tfidf.mjs');
    const { buildVecText } = await import('../hook-llm.mjs');
    _resetVocabCache();
    const r = rebuildVectors(db);
    expect(r.ok).toBe(true);

    const target = db.prepare("SELECT * FROM observations WHERE title = 'coordination service choice'").get();
    const vocab = getVocabulary(db);
    const saveVec = computeVector(buildVecText({ title: target.title, narrative: target.narrative, concepts: target.concepts, lessonLearned: target.lesson_learned, searchAliases: target.search_aliases }), vocab);
    const stored = db.prepare('SELECT vector FROM observation_vectors WHERE observation_id = ?').get(target.id);
    expect(stored, 'rebuild wrote a vector').toBeTruthy();
    expect(saveVec, 'save-path vector non-null (encodes the lesson term)').toBeTruthy();
    // parity: rebuild must encode the SAME field set as save (incl. lesson) → identical vector bytes
    expect(Buffer.from(saveVec.buffer).equals(stored.vector)).toBe(true);
  });
});
