// Audit 2026-09-02 P1-4. Two rules, both about the same statement.
//
//   1. `INSERT ... INTO observation_vectors` shipped FIVE times — lib/observation-write.mjs,
//      hook-optimize's rebuildVector, hook-llm's enrich path, lib/compress-core's summary
//      write and maintain-core's bulk rebuild. It had already drifted: the hook-optimize
//      copy named the column `computed_at` instead of `created_at_epoch`, and its own catch
//      swallowed the error until an experiment surfaced it.
//   2. `lib/save-enrich.mjs` reached that copy with `await import('../hook-optimize.mjs')`
//      — the only edge from lib/ into a non-leaf hook-layer module, taken lazily precisely
//      because pulling a 1139-line optimize stack in to write one row was the cost.
//
// Both are structural, so both are guarded structurally: a sweep with a stated allowlist of
// two, and an import-direction rule with one named exception.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { upsertObservationVector } from '../lib/observation-write.mjs';
import { rebuildVocabulary, _resetVocabCache } from '../tfidf.mjs';

// D#207: join(), never new URL('../X.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'tmp', '.tmp', 'tasks', 'docs', 'tests', 'benchmark', 'experiment']);

function walkShipped(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkShipped(full, out);
    else if (/\.mjs$/.test(name)) out.push(full);
  }
  return out;
}

describe('observation_vectors has one writer (plus one declared exception)', () => {
  // Both entries are deliberate, and the second is the interesting one:
  // maintain-core.rebuildVectors rebuilds the vocabulary itself (so it must pass its own,
  // not read the cache), reuses ONE prepared statement across every live row, and lets a
  // throw abort the whole rebuild instead of skipping a row. Routing it through a per-row
  // best-effort helper would change all three, so its SQL is a copy on purpose.
  const ALLOWED = new Set(['lib/observation-write.mjs', 'lib/maintain-core.mjs']);
  const WRITE_RE = /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+observation_vectors/i;

  it('the sweep walks a plausible number of shipped modules', () => {
    // A broken walk returning [] makes the rule below pass vacuously.
    expect(walkShipped(REPO).length).toBeGreaterThan(60);
  });

  it('no other shipped module writes the table', () => {
    const offenders = [];
    for (const f of walkShipped(REPO)) {
      const rel = relative(REPO, f);
      if (ALLOWED.has(rel)) continue;
      const src = readFileSync(f, 'utf8').split('\n')
        .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      if (WRITE_RE.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the sweep can say NO, and both allowlisted files really do carry the statement', () => {
    // Without the first arm a regex that matched nothing would report a clean tree; without
    // the second, the allowlist could rot into two names that no longer write anything —
    // and the rule would then be guarding an empty set while reading as enforced.
    expect('db.prepare("INSERT OR REPLACE INTO observation_vectors (observation_id) VALUES (?)")')
      .toMatch(WRITE_RE);
    for (const rel of ALLOWED) {
      expect(readFileSync(join(REPO, rel), 'utf8'), `${rel} is allowlisted but writes nothing`).toMatch(WRITE_RE);
    }
  });
});

describe('lib/ does not depend on the hook layer', () => {
  // No exceptions. `hook-shared.mjs` used to be one — two lib modules imported it for
  // callLLM and two constants, so a lib module loaded the whole hook constellation and
  // this rule read as enforced while carving out a name (audit 2026-09-02 P2-9 →
  // 2026-09-05 P1-2). Those three symbols now live in lib/llm-call.mjs,
  // lib/quiet-scope.mjs and lib/handoff-constants.mjs; hook-shared re-exports them for
  // its own callers. lib/save-enrich.mjs's `await import('../hook-optimize.mjs')` was
  // the other one, removed earlier.
  const HOOK_IMPORT_RE = /(?:from|import\()\s*['"]\.\.\/(hook-[a-z-]+\.mjs)['"]/g;

  it('the detector fires on a hook import and not on a sibling lib import', () => {
    const fires = (s) => { HOOK_IMPORT_RE.lastIndex = 0; return HOOK_IMPORT_RE.test(s); };
    expect(fires("import { x } from '../hook-optimize.mjs';")).toBe(true);
    expect(fires("const m = await import('../hook-llm.mjs');")).toBe(true);
    expect(fires("import { y } from './observation-write.mjs';")).toBe(false);
  });

  it('no lib module imports a hook-layer module at all', () => {
    const offenders = [];
    for (const f of walkShipped(join(REPO, 'lib'))) {
      const src = readFileSync(f, 'utf8').split('\n')
        .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
      HOOK_IMPORT_RE.lastIndex = 0;
      for (const m of src.matchAll(HOOK_IMPORT_RE)) {
        offenders.push(`${relative(REPO, f)} -> ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('upsertObservationVector behaviour', () => {
  let db;
  beforeEach(() => { _resetVocabCache(); db = createTestDb(); });
  afterEach(() => { _resetVocabCache(); try { db.close(); } catch { /* closed */ } });

  // Via the helper, not hand-written SQL: its parameter names do NOT mirror the columns
  // (`sessionId`, not `memory_session_id`) and it returns a better-sqlite3 result, so the
  // id has to come off `.lastInsertRowid` (#8581).
  //
  // FOUR rows with OVERLAPPING terms, not one: the vocabulary prunes by document
  // frequency, so a single observation yields terms nothing can be embedded against and
  // `computeVector` returns null — every case below would then assert `false === false`
  // for a reason that has nothing to do with the code under test. The seed text mirrors
  // tests/tfidf.test.mjs for the same reason.
  const VEC_TEXT = 'database schema migration';
  const seed = () => {
    insertSession(db, { id: 'sess-1', project: 'p' });
    const first = insertObs(db, { sessionId: 'sess-1', project: 'p', title: 'database schema migration', narrative: 'alter table add column' });
    insertObs(db, { sessionId: 'sess-1', project: 'p', title: 'database schema fix', narrative: 'schema migration update' });
    insertObs(db, { sessionId: 'sess-1', project: 'p', title: 'search query optimization', narrative: 'FTS5 BM25 ranking search' });
    insertObs(db, { sessionId: 'sess-1', project: 'p', title: 'another schema discussion', narrative: 'database migration ownership' });
    return Number(first.lastInsertRowid);
  };
  const vectorRow = (id) => db.prepare('SELECT * FROM observation_vectors WHERE observation_id = ?').get(id);

  it('accepts all three input shapes and writes the same way', () => {
    process.env.CLAUDE_MEM_VECTORS = '1';
    try {
      const id = seed();
      const vocab = rebuildVocabulary(db);
      expect(vocab, 'vocabulary must build or every case below is vacuous').toBeTruthy();

      expect(upsertObservationVector(db, id, VEC_TEXT, { vocab })).toBe(true);
      const fromString = vectorRow(id);
      expect(fromString).toBeTruthy();

      db.prepare('DELETE FROM observation_vectors').run();
      expect(upsertObservationVector(db, id, ['database schema', 'migration'], { vocab })).toBe(true);
      const fromArray = vectorRow(id);
      expect(fromArray).toBeTruthy();
      // "the same way" has to be asserted, not just implied by the title: the array arm
      // must JOIN ON A SPACE, and joining on anything else still writes a row. A mutation
      // to `.join('')` survived the first version of this case, which only checked that a
      // row existed.
      expect(Buffer.compare(fromArray.vector, fromString.vector), 'array and string forms must embed identically').toBe(0);

      db.prepare('DELETE FROM observation_vectors').run();
      const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
      expect(upsertObservationVector(db, id, row, { vocab })).toBe(true);
      expect(vectorRow(id)).toBeTruthy();
    } finally { delete process.env.CLAUDE_MEM_VECTORS; }
  });

  it('stamps created_at_epoch from `at` when given — compress-core needs the median date', () => {
    process.env.CLAUDE_MEM_VECTORS = '1';
    try {
      const id = seed();
      const vocab = rebuildVocabulary(db);
      const at = 1_600_000_000_000;
      expect(upsertObservationVector(db, id, VEC_TEXT, { vocab, at })).toBe(true);
      expect(vectorRow(id).created_at_epoch).toBe(at);
    } finally { delete process.env.CLAUDE_MEM_VECTORS; }
  });

  it('writes to created_at_epoch, not to any other column name', () => {
    // The historical drift: the hook-optimize copy used `computed_at`, and the error was
    // swallowed by its own catch. Assert the column the row actually lands in.
    process.env.CLAUDE_MEM_VECTORS = '1';
    try {
      const id = seed();
      const vocab = rebuildVocabulary(db);
      upsertObservationVector(db, id, VEC_TEXT, { vocab, at: 42 });
      const cols = db.prepare('PRAGMA table_info(observation_vectors)').all().map(c => c.name);
      expect(cols).toContain('created_at_epoch');
      expect(vectorRow(id).created_at_epoch).toBe(42);
    } finally { delete process.env.CLAUDE_MEM_VECTORS; }
  });

  it('gate:true respects CLAUDE_MEM_VECTORS, gate:false ignores it', () => {
    const id = seed();
    process.env.CLAUDE_MEM_VECTORS = '1';
    const vocab = rebuildVocabulary(db);
    delete process.env.CLAUDE_MEM_VECTORS;

    // Passing `vocab` explicitly is what makes this test about the GATE rather than about
    // getVocabulary's own null-when-disabled behaviour, which would mask the difference.
    expect(upsertObservationVector(db, id, VEC_TEXT, { vocab, gate: true })).toBe(false);
    expect(vectorRow(id)).toBeUndefined();
    expect(upsertObservationVector(db, id, VEC_TEXT, { vocab, gate: false })).toBe(true);
    expect(vectorRow(id)).toBeTruthy();
  });

  it('swallows a write failure and reports false rather than throwing', () => {
    // Best-effort is the contract: a caller's transaction must not roll an observation back
    // over a missing vector.
    process.env.CLAUDE_MEM_VECTORS = '1';
    try {
      // seed() FIRST. Without it `rebuildVocabulary` returns null on an empty DB, the helper
      // returns false above the prepare, and the case asserts "no throw" about a statement
      // it never reaches — a mutation making the catch rethrow survived the first version
      // for exactly that reason.
      const id = seed();
      const vocab = rebuildVocabulary(db);
      expect(vocab, 'vocabulary must build or the failing statement is never reached').toBeTruthy();
      expect(upsertObservationVector(db, id, VEC_TEXT, { vocab }), 'premise: the write works before we break it').toBe(true);

      db.exec('DROP TABLE observation_vectors');
      expect(() => upsertObservationVector(db, id, VEC_TEXT, { vocab })).not.toThrow();
      expect(upsertObservationVector(db, id, VEC_TEXT, { vocab })).toBe(false);
    } finally { delete process.env.CLAUDE_MEM_VECTORS; }
  });
});
