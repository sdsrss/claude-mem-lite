// Tests for hook-optimize.mjs — LLM-powered database optimization
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  // Real export consumed by hook-optimize's LLM call sites; a mock without it
  // throws before any branch under test runs.
  BG_LLM_TIMEOUT_MS: 45000,
}));

import { callModelJSONAsync } from '../haiku-client.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// D#207: built with join(), never `new URL('../hook.mjs', import.meta.url)` — the URL
// form makes knip drop hook.mjs out of its unused-export report entirely.
const HOOK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs');

describe('schema: optimized_at column', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('observations table has optimized_at column', () => {
    const cols = db.prepare(`PRAGMA table_info(observations)`).all();
    const col = cols.find((c) => c.name === 'optimized_at');
    expect(col).toBeDefined();
    expect(col.dflt_value).toBe('NULL');
  });

  it('optimized_at defaults to NULL for new observations', () => {
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, { title: 'test obs' });
    const obs = db.prepare('SELECT optimized_at FROM observations LIMIT 1').get();
    expect(obs.optimized_at).toBeNull();
  });
});

describe('re-enrich', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('finds degraded observations missing concepts/facts/lesson/aliases', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Modified schema.mjs', narrative: 'Changed the schema' });
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(1);
    expect(candidates[0].title).toBe('Modified schema.mjs');
  });

  it('skips already-optimized observations', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Modified schema.mjs', narrative: 'Changed' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare('UPDATE observations SET optimized_at = ? WHERE id = ?').run(Date.now(), id);
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(0);
  });

  it('skips observations that have concepts', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Rich obs', narrative: 'Has data', text: 'auth jwt' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare("UPDATE observations SET concepts = 'auth jwt' WHERE id = ?").run(id);
    const candidates = findReenrichCandidates(db, 10);
    expect(candidates.length).toBe(0);
  });

  it('executes re-enrich and updates observation fields', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Error in utils.mjs', narrative: 'Fixed a bug in sanitizeFtsQuery' });
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Fix sanitizeFtsQuery edge case',
      narrative: 'Fixed edge case where special chars caused crash',
      concepts: ['FTS5', 'sanitize'],
      facts: ['sanitizeFtsQuery in utils.mjs crashes on parentheses'],
      importance: 2,
      lesson_learned: 'FTS5 special chars need escaping',
      search_aliases: ['fts query bug', 'sanitize crash'],
    });

    const result = await executeReenrich(db, 10);
    expect(result.processed).toBe(1);

    const obs = db.prepare('SELECT * FROM observations LIMIT 1').get();
    expect(obs.concepts).toContain('FTS5');
    expect(obs.lesson_learned).toBe('FTS5 special chars need escaping');
    expect(obs.optimized_at).toBeGreaterThan(0);
  });

  it('scrubs a secret straddling the title cut in the re-enriched output', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    // Degraded title makes it a re-enrich candidate.
    insertObs(db, { title: 'Error in config.mjs', narrative: 'rotated credentials' });
    // 93-char pad lands the AWS value head at ~char 116, inside the 120-char title
    // cut, so a post-truncate scrub would miss the 3-char head. Even though the LLM
    // input is scrubbed DB text, scrubRecord exists for untrusted LLM output — the
    // scrub-before-truncate fix keeps the boundary leak-free.
    const pad = 'x'.repeat(93);
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: `${pad} AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE done`,
      narrative: 'Re-enriched narrative body',
      concepts: ['cfg'],
      facts: [],
      importance: 2,
      lesson_learned: 'config rotation lesson with enough signal to persist',
      search_aliases: ['cfg rotate'],
    });

    const result = await executeReenrich(db, 10);
    expect(result.processed).toBe(1);
    const obs = db.prepare('SELECT title FROM observations LIMIT 1').get();
    expect(obs.title).not.toMatch(/ACCESS_KEY=[A-Za-z0-9]/);
  });
});

// P1 alias-backfill (scope='aliases'): a lesson-bearing manual save (mem_save)
// stores NO search_aliases (lib/save-observation.mjs), so it is paraphrase-
// unfindable — yet BOTH re-enrich scopes skip it: narrow needs lesson IS NULL,
// wide needs lesson IS NULL. This scope targets substantive rows missing
// search_aliases REGARDLESS of lesson, and must add ONLY aliases — never rewrite
// the user's curated title / narrative / lesson (the general re-enrich would).
describe("re-enrich scope='aliases' (P1 alias backfill)", () => {
  let db;
  const substantive =
    'The worker pool deadlocked when every connection was checked out and a callback tried to acquire another one, so the pool never drained.';
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('selects a lesson-bearing, alias-less substantive row that narrow+wide both skip', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed deadlock in the connection pool',
      narrative: substantive,
      text: 'deadlock connection pool worker timeout',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Never acquire a second pool connection inside a callback holding the first',
      searchAliases: null,
    });
    // narrow + wide both exclude it (it has a lesson); aliases must include it.
    expect(findReenrichCandidates(db, 10, { scope: 'narrow' }).length).toBe(0);
    expect(findReenrichCandidates(db, 10, { scope: 'wide' }).length).toBe(0);
    const aliases = findReenrichCandidates(db, 10, { scope: 'aliases' });
    expect(aliases.length).toBe(1);
    expect(aliases[0].title).toBe('Fixed deadlock in the connection pool');
  });

  it('excludes rows that already have search_aliases', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Already enriched',
      narrative: substantive,
      type: 'bugfix',
      lessonLearned: 'lesson',
      searchAliases: 'existing alias phrase',
    });
    expect(findReenrichCandidates(db, 10, { scope: 'aliases' }).length).toBe(0);
  });

  it('adds ONLY aliases and preserves title/narrative/lesson; appends aliases to FTS text', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed deadlock in the connection pool',
      narrative: substantive,
      text: 'deadlock connection pool worker timeout',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Never acquire a second pool connection inside a callback holding the first',
      searchAliases: null,
    });
    // The alias-only mock deliberately omits title/narrative/lesson — the general
    // re-enrich would skip on missing title; the aliases path must not need them.
    callModelJSONAsync.mockResolvedValue({
      search_aliases: ['connection deadlock', 'pool hang', 'db lock timeout'],
    });

    const result = await executeReenrich(db, 10, { scope: 'aliases' });
    expect(result.processed).toBe(1);

    const obs = db.prepare('SELECT * FROM observations LIMIT 1').get();
    expect(obs.search_aliases).toContain('connection deadlock');
    // Curated fields untouched.
    expect(obs.title).toBe('Fixed deadlock in the connection pool');
    expect(obs.narrative).toBe(substantive);
    expect(obs.lesson_learned).toBe(
      'Never acquire a second pool connection inside a callback holding the first',
    );
    // FTS text keeps original terms AND gains the alias terms (append, not rebuild).
    expect(obs.text).toContain('deadlock');
    expect(obs.text).toContain('pool hang');
  });

  // P1-2: the DEFAULT optimize run (no explicit scope) must ALSO backfill aliases on
  // lesson-bearing manual saves. Before the fix, optimizeRun's default reenrichScope='narrow'
  // ran narrow ONLY — which requires lesson_learned IS NULL — so a manual mem_save (narrative
  // = body, lesson present, no aliases) was NEVER reached by any automatic path, leaving it
  // paraphrase-unfindable (07-06-after new rows: only 11% had aliases). optimize is the async
  // re-enrich channel; the default pass now covers narrow + aliases.
  it('default-scope optimizeRun backfills aliases on a lesson-bearing manual save (P1-2)', async () => {
    const { optimizeRun } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed deadlock in the connection pool',
      narrative: substantive,
      text: 'deadlock connection pool worker timeout',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Never acquire a second pool connection inside a callback holding the first',
      searchAliases: null,
    });
    // narrow (the pre-fix default) has 0 candidates here → it never calls the model; only the
    // aliases sub-pass does, so a single alias-shaped mock is unambiguous.
    callModelJSONAsync.mockResolvedValue({
      search_aliases: ['connection deadlock', 'pool hang', 'db lock timeout'],
    });
    await optimizeRun(db, { tasks: ['re-enrich'], maxItems: 10 }); // no reenrichScope → default
    const obs = db.prepare('SELECT search_aliases FROM observations LIMIT 1').get();
    expect(obs.search_aliases).toContain('connection deadlock');
  });
});

// D#6 concepts-backfill (scope='concepts'). Same defect class as P1-2 above, one
// column over, and the fix that closed P1-2 is what OPENED this one: save-enrich runs
// on every successful manual save and writes search_aliases (always) + lesson_learned
// (bugfix/decision) + scope. Those three columns ARE the other pools' predicates, so a
// save-enriched row matches NONE of them — narrow needs lesson AND aliases null, wide
// needs lesson null, aliases needs search_aliases null, scopes needs scope null. It
// therefore never receives concepts or facts, permanently. save-enrich's docblock says
// "the daily wide re-enrich stays the safety net"; that is true of optimized_at, which
// it does not stamp, and false in effect, because its own lesson write evicts the row
// from wide.
//
// Measured on the real DB 2026-09-07: 14/14 live observations have empty concepts AND
// empty facts, 14/14 have search_aliases, 13/14 have a lesson, 0/14 have optimized_at,
// and all four pools return 0 candidates. Worth closing, measured same day on the
// benchmark fixture (200 obs, 543 unique terms, 30 queries, same-tree back-to-back A/B
// with concepts blanked): hybrid R@10 0.8998 vs 0.8152 (+0.0846), nDCG +0.0579. For
// scale, all EIGHT scoring multipliers together buy +0.0002 R@10 on that fixture.
//
// This is deliberately NOT the fix D#6 proposed (riding save-enrich's existing Haiku
// call), for two reasons: that would change save-enrich's stated contract, which says
// concepts/facts stay byte-identical, and it could only ever help FUTURE saves. A pool
// keyed on the column it fills is what this file already does twice — see the aliases
// block above and the 'scopes' pool — and it is the only option that reaches the
// existing backlog.
describe("re-enrich scope='concepts' (D#6 concepts backfill)", () => {
  let db;
  const substantive =
    'The worker pool deadlocked when every connection was checked out and a callback tried to acquire another one, so the pool never drained.';
  /** A row exactly as save-enrich leaves it: lesson + aliases + scope written, concepts empty. */
  const saveEnriched = (over = {}) => ({
    title: 'Fixed deadlock in the connection pool',
    narrative: substantive,
    text: 'deadlock connection pool worker timeout connection deadlock pool hang',
    type: 'bugfix',
    importance: 2,
    lessonLearned: 'Never acquire a second pool connection inside a callback holding the first',
    searchAliases: 'connection deadlock pool hang db lock timeout',
    ...over,
  });
  const setScope = (value = 'module') =>
    db.prepare('UPDATE observations SET scope = ? WHERE scope IS NULL').run(value);

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('selects a save-enriched row that all four existing pools skip', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    setScope();
    // The premise, asserted rather than assumed: this row is invisible to every pool
    // that exists today. If any of these stops being 0, the finding has changed.
    expect(findReenrichCandidates(db, 10, { scope: 'narrow' }).length).toBe(0);
    expect(findReenrichCandidates(db, 10, { scope: 'wide' }).length).toBe(0);
    expect(findReenrichCandidates(db, 10, { scope: 'aliases' }).length).toBe(0);
    expect(findReenrichCandidates(db, 10, { scope: 'scopes' }).length).toBe(0);

    const found = findReenrichCandidates(db, 10, { scope: 'concepts' });
    expect(found.length).toBe(1);
    expect(found[0].title).toBe('Fixed deadlock in the connection pool');
  });

  it('is NOT gated on optimized_at — a fully re-enriched row that still lacks concepts qualifies', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    setScope();
    // The general pass preserves-on-empty, so a re-enrich whose LLM returned no
    // concepts leaves the row stamped AND conceptless. Gating on the stamp would
    // strand exactly those rows, which is the R10 P2-2 shape.
    db.prepare('UPDATE observations SET optimized_at = ?').run(Date.now());
    expect(findReenrichCandidates(db, 10, { scope: 'concepts' }).length).toBe(1);
  });

  it('excludes rows that already have concepts (idempotent via the column it fills)', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    // TWO rows, and the assertion is a name, not a count. Written the obvious way —
    // one row, expect 0 — this case passed BEFORE the pool existed, because an
    // unknown scope falls through to `narrow`, which also returns 0 here. A
    // no-rows-returned assertion cannot tell "correctly excluded" from "pool absent".
    insertObs(db, saveEnriched({ title: 'Already has concepts' }));
    db.prepare("UPDATE observations SET concepts = 'deadlock pool'").run();
    insertObs(db, saveEnriched({ title: 'Still conceptless' }));

    const found = findReenrichCandidates(db, 10, { scope: 'concepts' });
    expect(found.map((r) => r.title)).toEqual(['Still conceptless']);
  });

  it('excludes a superseded row', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    expect(findReenrichCandidates(db, 10, { scope: 'concepts' }).length).toBe(1);
    db.prepare('UPDATE observations SET superseded_at = ?').run(Date.now());
    expect(findReenrichCandidates(db, 10, { scope: 'concepts' }).length).toBe(0);
  });

  it('writes ONLY concepts/facts, preserves the curated fields, and appends to FTS text', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    // Deliberately omits title/narrative/lesson: the general re-enrich SKIPS on a
    // missing title, so a mock this thin proves the concepts path is its own branch.
    callModelJSONAsync.mockResolvedValue({
      concepts: ['connection pool', 'deadlock', 'callback reentrancy'],
      facts: ['the pool never drained once every connection was checked out'],
    });

    const result = await executeReenrich(db, 10, { scope: 'concepts' });
    expect(result.processed).toBe(1);

    const obs = db.prepare('SELECT * FROM observations LIMIT 1').get();
    expect(obs.concepts).toContain('callback reentrancy');
    expect(obs.facts).toContain('never drained');
    // Curated fields untouched — this is the contract the general pass cannot honour.
    expect(obs.title).toBe('Fixed deadlock in the connection pool');
    expect(obs.narrative).toBe(substantive);
    expect(obs.lesson_learned).toBe(
      'Never acquire a second pool connection inside a callback holding the first',
    );
    expect(obs.search_aliases).toBe('connection deadlock pool hang db lock timeout');
    expect(obs.importance).toBe(2);
    expect(obs.type).toBe('bugfix');
    // Append, not rebuild: rebuilding text from concepts/facts would drop the original
    // narrative and alias terms, which is the regression the aliases branch warns about.
    expect(obs.text).toContain('deadlock connection pool worker timeout');
    expect(obs.text).toContain('callback reentrancy');
  });

  it('never stamps optimized_at, so the wide pass keeps its own candidates', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    callModelJSONAsync.mockResolvedValue({ concepts: ['a concept'], facts: [] });
    const result = await executeReenrich(db, 10, { scope: 'concepts' });
    // Premise first: a null optimized_at proves nothing if the pass never ran, and
    // before the pool existed this case passed for exactly that reason.
    expect(result.processed).toBe(1);
    expect(db.prepare('SELECT optimized_at FROM observations LIMIT 1').get().optimized_at).toBeNull();
  });

  it('skips instead of writing when the model returns no concepts', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    callModelJSONAsync.mockResolvedValue({ concepts: [], facts: [] });
    const result = await executeReenrich(db, 10, { scope: 'concepts' });
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    const obs = db.prepare('SELECT concepts, text FROM observations LIMIT 1').get();
    expect(obs.concepts).toBe('');
    expect(obs.text).toBe('deadlock connection pool worker timeout connection deadlock pool hang');
  });

  it('does not resurrect a row superseded during the LLM round-trip (R10 P3-3 shape)', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    // 45 s is long enough for a concurrent hook to retire the row; the guard belongs on
    // the UPDATE's WHERE, not only on the SELECT that chose it.
    callModelJSONAsync.mockImplementation(async () => {
      db.prepare('UPDATE observations SET superseded_at = ?').run(Date.now());
      return { concepts: ['too late'], facts: [] };
    });
    const result = await executeReenrich(db, 10, { scope: 'concepts' });
    // Premise: the row WAS selected and the model WAS called, so an unwritten row is
    // the guard firing rather than the pass never starting. Without this the case
    // passed before the pool existed.
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(0);
    expect(db.prepare('SELECT concepts FROM observations LIMIT 1').get().concepts).toBe('');
  });

  it('reports the backlog under optimizePreview.reenrichConcepts', async () => {
    const { optimizePreview } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    setScope();
    const preview = optimizePreview(db);
    // A backlog nobody can see cannot be sized for a one-shot drain, and the other
    // three side-pools are all reported here. Premise on the same object: the other
    // pools really are empty, so this 1 is the new pool and not a mislabelled count.
    expect(preview.reenrichConcepts).toBe(1);
    expect(preview.reenrich).toBe(0);
    expect(preview.reenrichWide).toBe(0);
    expect(preview.reenrichAliases).toBe(0);
    expect(preview.reenrichScopes).toBe(0);
  });

  it('default-scope optimizeRun backfills concepts on a save-enriched row (D#6)', async () => {
    const { optimizeRun } = await import('../hook-optimize.mjs');
    insertObs(db, saveEnriched());
    setScope();
    // Every other sub-pass has 0 candidates here, so a concepts-shaped mock is
    // unambiguous — and this is the assertion that matters, because a pool nothing
    // schedules is the P1-2 defect repeated rather than fixed.
    callModelJSONAsync.mockResolvedValue({
      concepts: ['connection pool', 'deadlock'],
      facts: ['the pool never drained'],
    });
    await optimizeRun(db, { tasks: ['re-enrich'], maxItems: 10 }); // no reenrichScope → default
    expect(db.prepare('SELECT concepts FROM observations LIMIT 1').get().concepts).toContain('deadlock');
  });

  // Audit 2026-07-17 P4: the DAILY auto path (handleLLMOptimize via auto-maintain)
  // passes reenrichScope='wide' explicitly, which bypassed the v3.43 narrow+aliases
  // split — so the aliases backfill NEVER had an automatic cadence and live alias
  // coverage crawled at ~15%. The split must cover 'wide' too (adaptively: aliases
  // takes at most half the budget and only what its candidate pool holds).
  it("scope 'wide' (the daily auto path) also backfills aliases on a lesson-bearing manual save", async () => {
    const { optimizeRun } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed deadlock in the connection pool',
      narrative: substantive,
      text: 'deadlock connection pool worker timeout',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Never acquire a second pool connection inside a callback holding the first',
      searchAliases: null,
    });
    // wide requires lesson_learned NULL → 0 wide candidates here; only the aliases
    // sub-pass calls the model, so an alias-shaped mock is unambiguous.
    callModelJSONAsync.mockResolvedValue({ search_aliases: ['connection deadlock', 'pool hang'] });
    await optimizeRun(db, { tasks: ['re-enrich'], maxItems: 10, reenrichScope: 'wide' });
    const obs = db.prepare('SELECT search_aliases FROM observations LIMIT 1').get();
    expect(obs.search_aliases).toContain('connection deadlock');
  });

  // The adaptive half is a CAP, not a reservation: with zero aliases candidates the
  // main scope keeps its full budget (guards the wide-throughput semantics of the
  // maxItems:20 test below against the split).
  it("scope 'wide' with no aliases candidates gives wide the full budget", async () => {
    const { optimizeRun } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed race in scheduler',
      narrative: substantive,
      text: 'race scheduler',
      type: 'bugfix',
      importance: 2,
      searchAliases: 'already has aliases', // NOT an aliases candidate
    });
    db.prepare("UPDATE observations SET concepts = 'race', facts = 'scheduler'").run();
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Race in scheduler',
      narrative: 'Race fixed.',
      concepts: ['race'],
      facts: ['scheduler'],
      importance: 2,
      lesson_learned: 'Hold the lock',
      search_aliases: ['race fix'],
    });
    const result = await optimizeRun(db, { tasks: ['re-enrich'], maxItems: 10, reenrichScope: 'wide' });
    expect(result.reenrich.byScope.aliases.processed).toBe(0);
    expect(result.reenrich.byScope.wide.processed).toBe(1);
  });
});

// D#12. R10 P3-3 put a live-row guard on the general re-enrich UPDATE because a
// BG_LLM_TIMEOUT_MS (45 s) round-trip sits between the SELECT that chose the row and
// the write, and a concurrent hook can retire or compress it inside that window. The
// D#6 concepts branch was written with the same guard. TWO SIBLING BRANCHES of the same
// function were left without it, and their harm is not the same — see each case.
describe('executeReenrich post-LLM writes are live-guarded (D#12)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  // The high-harm one. compressed_into is the child -> keeper POINTER, and
  // lib/maintain-core.mjs:316 recovers orphans with `WHERE compressed_into > 0`. Writing
  // COMPRESSED_AUTO (-1) over a positive keeper id does not merely stamp a dead row: it
  // destroys the link, putting the child out of recoverOrphanedChildren's reach AND out
  // of recoverChildrenOf's. The sibling write in lib/maintain-core.mjs:631 already carries
  // the guard, so this is a gap rather than a design choice.
  it('does not overwrite a keeper pointer won during the round-trip (auto-hide path)', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'A fully degraded row', narrative: 'short body', type: 'change' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    // Premise: this really is a narrow candidate before the call.
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    expect(findReenrichCandidates(db, 10, { scope: 'narrow' }).map((r) => r.id)).toEqual([id]);

    const KEEPER = 999;
    callModelJSONAsync.mockImplementation(async () => {
      // A concurrent cluster-merge / smart-compress lands mid-call and adopts this row.
      db.prepare('UPDATE observations SET compressed_into = ? WHERE id = ?').run(KEEPER, id);
      return { title: 'still worthless', importance: 0 };
    });

    const result = await executeReenrich(db, 10, { scope: 'narrow' });
    const row = db.prepare('SELECT compressed_into, optimized_at FROM observations WHERE id = ?').get(id);
    // The assertion that matters is the POINTER, not the skip: a test that only checked
    // `processed === 0` would still pass if the row were stamped some other way.
    expect(row.compressed_into).toBe(KEEPER);
    expect(row.optimized_at).toBeNull();
    expect(result.processed).toBe(0);
  });

  // The lower-harm one. A superseded row is hidden from every read path, so the FTS write
  // is inert for retrieval — but it still counts as `processed` and rebuilds a vector for
  // a dead row, and it is the one branch of executeReenrich that lacked what its three
  // siblings carry.
  it('does not write aliases to a row superseded during the round-trip', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed deadlock in the connection pool',
      narrative:
        'The worker pool deadlocked when every connection was checked out and a callback tried to acquire another one, so the pool never drained.',
      text: 'deadlock connection pool worker timeout',
      type: 'bugfix',
      lessonLearned: 'Never acquire a second pool connection inside a callback holding the first',
      searchAliases: null,
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    callModelJSONAsync.mockImplementation(async () => {
      db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(Date.now(), id);
      return { search_aliases: ['connection deadlock', 'pool hang'] };
    });

    const result = await executeReenrich(db, 10, { scope: 'aliases' });
    // Premise: the row was selected and the model WAS called, so an unwritten row is the
    // guard firing rather than an empty pool.
    expect(callModelJSONAsync).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(0);
    const row = db.prepare('SELECT search_aliases, text FROM observations WHERE id = ?').get(id);
    expect(row.search_aliases).toBeNull();
    expect(row.text).toBe('deadlock connection pool worker timeout');
  });
});

// Bug #1: rebuildVector was writing to a non-existent column `computed_at`.
// Every executeReenrich silently caught SqliteError: observation_vectors has no column named computed_at.
// The catch is intentional (non-critical path), so the bug was invisible at runtime.
// This test calls rebuildVector directly and asserts the row actually lands.
describe('rebuildVector (Bug #1)', () => {
  let db;
  let prevVec;
  beforeEach(async () => {
    // rebuildVector writes observation_vectors — exercise it with the vector arm ON
    // (choke-point-gated OFF by default since the 2026-06 memory-quality audit).
    prevVec = process.env.CLAUDE_MEM_VECTORS;
    process.env.CLAUDE_MEM_VECTORS = '1';
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    // Seed several observations so rebuildVocabulary has enough corpus to build a vocab
    for (let i = 0; i < 5; i++) {
      insertObs(db, {
        type: 'bugfix',
        title: `Fix issue ${i} in module X`,
        narrative: `Detailed narrative about issue ${i}: a concurrency bug in the handler released the lock before the side-effect finished, causing a race window that let the second caller overwrite state.`,
        text: `concurrency lock race handler side-effect state issue-${i}`,
      });
    }
    // Force vocab rebuild so rebuildVector has something to embed against
    const { rebuildVocabulary, _resetVocabCache } = await import('../tfidf.mjs');
    _resetVocabCache();
    rebuildVocabulary(db);
  });
  afterEach(() => {
    db.close();
    if (prevVec === undefined) delete process.env.CLAUDE_MEM_VECTORS;
    else process.env.CLAUDE_MEM_VECTORS = prevVec;
  });

  it('writes a row to observation_vectors for the target observation', async () => {
    const { rebuildVector } = await import('../hook-optimize.mjs');
    const obsId = db.prepare('SELECT id FROM observations ORDER BY id LIMIT 1').get().id;

    rebuildVector(db, obsId, ['concurrency race lock', 'handler side-effect state overwrite']);

    const row = db
      .prepare('SELECT COUNT(*) as c FROM observation_vectors WHERE observation_id = ?')
      .get(obsId);
    expect(row.c).toBe(1);
  });

  it('writes the correct column set (schema-aligned: created_at_epoch)', async () => {
    const { rebuildVector } = await import('../hook-optimize.mjs');
    const obsId = db.prepare('SELECT id FROM observations ORDER BY id LIMIT 1').get().id;

    rebuildVector(db, obsId, ['concurrency race lock', 'handler side-effect state overwrite']);

    // Row should have a non-null created_at_epoch populated by the helper
    const row = db
      .prepare(
        'SELECT observation_id, vocab_version, created_at_epoch FROM observation_vectors WHERE observation_id = ?',
      )
      .get(obsId);
    expect(row).toBeDefined();
    expect(row.created_at_epoch).toBeGreaterThan(0);
    expect(row.vocab_version).toBeTruthy();
  });
});

// I-1 (v3.39.2): the alias-only backfill APPENDs aliases to the FTS text but,
// before the fix, never rebuilt the TF-IDF vector — so the newly generated
// aliases (the whole point of the pass) were invisible to the vector arm. The
// branch must refresh the vector like the narrow/wide branch does.
describe('re-enrich --scope aliases rebuilds the vector (I-1)', () => {
  let db;
  let prevVec;
  beforeEach(async () => {
    prevVec = process.env.CLAUDE_MEM_VECTORS;
    process.env.CLAUDE_MEM_VECTORS = '1';
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    for (let i = 0; i < 5; i++) {
      insertObs(db, {
        type: 'bugfix',
        title: `Fix issue ${i} in module X`,
        narrative: `Detailed narrative about issue ${i}: a concurrency bug in the handler released the lock before the side-effect finished, causing a race window that let the second caller overwrite state.`,
        text: `concurrency lock race handler side-effect state issue-${i}`,
      });
    }
    const { rebuildVocabulary, _resetVocabCache } = await import('../tfidf.mjs');
    _resetVocabCache();
    rebuildVocabulary(db);
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
    if (prevVec === undefined) delete process.env.CLAUDE_MEM_VECTORS;
    else process.env.CLAUDE_MEM_VECTORS = prevVec;
  });

  it('writes an observation_vectors row for the alias-backfilled observation', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    // Alias-less, substantive row (narrative > 100 chars, real title) → qualifies
    // for scope=aliases. insertObs writes no vector, so none exists yet.
    const id = Number(
      insertObs(db, {
        type: 'bugfix',
        title: 'Race in the credit deduction path',
        narrative:
          'IntegrityError under concurrent credit deduction: the balance was read then written without a row lock, so two in-flight requests overwrote each other. Fixed with SELECT FOR UPDATE inside the transaction.',
        text: 'credit deduction race balance row lock integrityerror',
      }).lastInsertRowid,
    );
    expect(db.prepare('SELECT COUNT(*) c FROM observation_vectors WHERE observation_id = ?').get(id).c).toBe(
      0,
    );

    callModelJSONAsync.mockResolvedValue({
      search_aliases: ['concurrency race', 'double spend', 'lost update'],
    });
    const r = await executeReenrich(db, 10, { scope: 'aliases' });
    expect(r.processed).toBeGreaterThanOrEqual(1);

    // The backfill must refresh the vector (before the fix: UPDATE ran but no rebuild).
    expect(db.prepare('SELECT COUNT(*) c FROM observation_vectors WHERE observation_id = ?').get(id).c).toBe(
      1,
    );
  });
});

// R-7 micro: widened scope — target observations that have concepts/facts populated
// but still no lesson_learned. These are the "Haiku filled in everything except the
// lesson" cases that the narrow filter misses entirely.
describe('re-enrich --scope wide (R-7)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('wide scope finds bugfix with narrative but no lesson (narrow scope misses it)', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    // This observation has concepts + facts + a substantive narrative, but no lesson.
    // Represents the common case: Haiku ran successfully except for the lesson field.
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix race condition in credit deduction',
      narrative:
        'IntegrityError appeared when two concurrent requests deducted credit from the same account. Root cause: balance read-then-write without SELECT FOR UPDATE. Added row-level lock via SELECT FOR UPDATE in the transaction.',
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare("UPDATE observations SET concepts = 'credit race', facts = 'credit balance' WHERE id = ?").run(
      id,
    );

    // Narrow scope (default) should miss it — concepts is populated
    const narrow = findReenrichCandidates(db, 10);
    expect(narrow.length).toBe(0);

    // Wide scope should find it
    const wide = findReenrichCandidates(db, 10, { scope: 'wide' });
    expect(wide.length).toBe(1);
    expect(wide[0].title).toContain('credit deduction');
  });

  it('wide scope excludes LOW_SIGNAL titles (no source material to extract from)', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, {
      type: 'bugfix',
      title: 'Modified schema.mjs',
      narrative:
        'long narrative that would otherwise be substantive but the title marks it as a fallback/degraded observation from hook-llm without LLM enrichment — not a real lesson candidate because the episode captured raw tool output',
    });
    const wide = findReenrichCandidates(db, 10, { scope: 'wide' });
    expect(wide.length).toBe(0);
  });

  // Bug #2: LOW_SIGNAL filter only matched title == '(error)' exactly, not
  // '... (error)' suffix. makeEntryDesc in utils.mjs appends ' (error)' to the
  // entry description whenever a tool call failed, which then becomes the title
  // in degraded-title mode. 110 obs (~4% of wide pool) were leaking through.
  it('wide scope excludes titles with (error) suffix (Bug #2)', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, {
      type: 'bugfix',
      title: 'gh release list --repo sdsrss/claude-mem-lite --l… (error)',
      narrative:
        'Tool invocation output captured as the degraded title; narrative is the raw gh CLI output with no actual fix or root cause — lesson extraction is impossible from this.',
    });
    const wide = findReenrichCandidates(db, 10, { scope: 'wide' });
    expect(wide.length).toBe(0);
  });

  it('wide scope excludes observations with too-short narratives', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    // Substantive title but thin narrative — nothing to extract from
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix off-by-one in pager',
      narrative: 'Fixed it.',
    });
    const wide = findReenrichCandidates(db, 10, { scope: 'wide' });
    expect(wide.length).toBe(0);
  });

  it('wide scope excludes observations already having lesson_learned', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix memory leak in parser',
      narrative:
        'Long enough narrative describing the problem and the fix in detail with technical specifics',
      lessonLearned: 'already has a lesson that is long enough',
    });
    const wide = findReenrichCandidates(db, 10, { scope: 'wide' });
    expect(wide.length).toBe(0);
  });

  it('wide scope excludes non-substantive types (change observations)', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    // change type with long narrative but no lesson — should NOT be picked up by wide scope
    // (wide scope only targets bugfix/refactor/feature/decision where a lesson is plausible)
    insertObs(db, {
      type: 'change',
      title: 'Bumped version to 2.30.0',
      narrative:
        'Updated package.json, Cargo.toml, and the version constant in cli.mjs. Ran the sync-versions script to propagate the change across all build manifests and verified consistency.',
    });
    const wide = findReenrichCandidates(db, 10, { scope: 'wide' });
    expect(wide.length).toBe(0);
  });

  it('wide scope respects optimized_at marker (idempotent reruns)', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix CJK tokenization in FTS5',
      narrative:
        'FTS5 porter stemmer does not tokenize CJK — needed to add bigram generation in utils.mjs. Applied a workaround that splits on unicode category and emits overlapping bigrams.',
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;

    // First call: should find it
    expect(findReenrichCandidates(db, 10, { scope: 'wide' }).length).toBe(1);

    // Mark optimized
    db.prepare('UPDATE observations SET optimized_at = ? WHERE id = ?').run(Date.now(), id);

    // Second call: should be excluded
    expect(findReenrichCandidates(db, 10, { scope: 'wide' }).length).toBe(0);
  });

  it('optimizeRun({tasks:[re-enrich], maxItems:20, reenrichScope:wide}) gives re-enrich the full 20 budget', async () => {
    const { optimizeRun } = await import('../hook-optimize.mjs');

    // Seed 25 wide-scope-eligible observations
    for (let i = 0; i < 25; i++) {
      insertObs(db, {
        type: 'bugfix',
        title: `Fix issue #${i} in module X`,
        narrative: `Long enough narrative for observation ${i}: traced a concurrency bug in the handler and found that the lock was released before the side-effect completed, causing a race window that let the second caller overwrite state.`,
      });
    }
    // Populate concepts/facts so they're in the WIDE (not narrow) pool
    db.prepare("UPDATE observations SET concepts = 'race lock', facts = 'handler side-effect'").run();

    // Mock Haiku to always return a real lesson
    callModelJSONAsync.mockImplementation(async () => ({
      type: 'bugfix',
      title: 'Race condition in handler lock release',
      narrative: 'Lock released before side-effect completed.',
      concepts: ['race', 'lock'],
      facts: ['lock released early'],
      importance: 2,
      lesson_learned: 'Hold the lock until the side-effect is fully committed',
      search_aliases: ['race lock bug', 'early unlock'],
    }));

    const result = await optimizeRun(db, {
      tasks: ['re-enrich'],
      maxItems: 20,
      reenrichScope: 'wide',
    });

    // Without the fix, distributeBudget(20) would give reenrich only 8.
    // The test verifies that single-task mode bypasses distribution AND scope=wide is honored.
    expect(result.reenrich.processed).toBe(20);
  });

  it('executeReenrich with scope=wide passes through and processes candidates', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix timezone bug in report generator',
      narrative:
        'Report dates were off by one day in some reports because date.today() returned UTC dates but downstream code expected Beijing dates. Needed a consistent timezone-aware helper.',
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare("UPDATE observations SET concepts = 'timezone', facts = 'date helper' WHERE id = ?").run(id);

    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Use timezone-aware helpers for all date operations',
      narrative:
        'Report dates were off by one day because date.today() returned UTC but downstream code expected Beijing.',
      concepts: ['timezone', 'beijing', 'date'],
      facts: ['date.today() returns UTC', 'reports need Beijing dates'],
      importance: 2,
      lesson_learned:
        'In timezone-sensitive apps, never call date.today() directly — always use a timezone-aware helper',
      search_aliases: ['timezone bug', 'utc beijing mismatch'],
    });

    const result = await executeReenrich(db, 10, { scope: 'wide' });
    expect(result.processed).toBe(1);

    const obs = db.prepare('SELECT lesson_learned, optimized_at FROM observations WHERE id = ?').get(id);
    expect(obs.lesson_learned).toContain('timezone-aware helper');
    expect(obs.optimized_at).toBeGreaterThan(0);
  });

  it('preserves existing concepts/facts/search_aliases when a wide re-enrich response omits them (preserve-on-empty)', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, {
      type: 'bugfix',
      title: 'Fix deadlock in balance deduction',
      narrative:
        'A race condition let two concurrent deductions read the same balance and double-spend; needed SELECT ... FOR UPDATE row locking to serialize them so the second reader waits.',
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare(
      "UPDATE observations SET concepts = 'race-condition locking', facts = 'SELECT FOR UPDATE needed', search_aliases = 'deadlock; concurrent deduct' WHERE id = ?",
    ).run(id);

    // The LLM returns a good lesson/title but OMITS the metadata (empty arrays / missing key) —
    // the common partial shape. Without preserve-on-empty this wipes the row's retrieval metadata
    // AND sets optimized_at, locking it out of any future re-enrich (permanent loss).
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Serialize balance deductions with row locking',
      narrative: 'Concurrent deductions double-spent; row locking serializes them.',
      concepts: [],
      facts: [],
      importance: 2,
      lesson_learned: 'Money-mutating reads need SELECT ... FOR UPDATE, not a plain SELECT',
      // search_aliases omitted entirely
    });

    const result = await executeReenrich(db, 10, { scope: 'wide' });
    expect(result.processed).toBe(1);

    const obs = db
      .prepare('SELECT concepts, facts, search_aliases, lesson_learned FROM observations WHERE id = ?')
      .get(id);
    expect(obs.concepts, 'existing concepts must survive an empty LLM response').toBe(
      'race-condition locking',
    );
    expect(obs.facts).toBe('SELECT FOR UPDATE needed');
    expect(obs.search_aliases).toBe('deadlock; concurrent deduct');
    expect(obs.lesson_learned).toContain('FOR UPDATE');
  });

  it('wide re-enrich clamps importance:0 to 1 (keeps the row visible) instead of hiding it at -1', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, {
      type: 'decision',
      title: 'Chose RRF over union-by-max for hybrid fusion',
      narrative:
        'Union-by-max let one strong lexical hit dominate the fused ranking; RRF blends rank positions so the vector and lexical signals contribute evenly. Kept RRF k=60 after measuring recall on the eval set.',
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;

    callModelJSONAsync.mockResolvedValue({
      type: 'decision',
      title: 'RRF chosen for hybrid fusion',
      narrative: 'RRF blends rank positions evenly across signals.',
      concepts: ['rrf', 'fusion'],
      facts: ['k=60'],
      importance: 0, // a single Haiku misjudgment on a substantive row
      lesson_learned: 'none',
    });

    const result = await executeReenrich(db, 10, { scope: 'wide' });
    expect(result.processed).toBe(1);

    const obs = db.prepare('SELECT compressed_into, importance FROM observations WHERE id = ?').get(id);
    expect(obs.compressed_into ?? 0, 'wide importance:0 must not hide a substantive row at -1').toBe(0);
    expect(obs.importance).toBe(1); // clampImportance floored 0 -> 1, row stays visible
  });

  it('narrow re-enrich still hides importance:0 rows at COMPRESSED_AUTO (unchanged behavior)', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'trivial log tweak', narrative: 'changed a log string' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    callModelJSONAsync.mockResolvedValue({
      type: 'change',
      title: 'log tweak',
      narrative: 'x',
      importance: 0,
    });

    const result = await executeReenrich(db, 10); // narrow scope (default)
    expect(result.processed).toBe(1);
    const obs = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id);
    expect(obs.compressed_into).toBe(-1); // COMPRESSED_AUTO — narrow auto-hide preserved
  });
});

describe('normalize', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('extracts unique concepts from active observations', async () => {
    const { extractUniqueConcepts } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'obs1', text: 'FTS5 search' });
    db.prepare("UPDATE observations SET concepts = 'FTS5 full-text' WHERE id = 1").run();
    insertObs(db, { title: 'obs2', text: 'FTS query' });
    db.prepare("UPDATE observations SET concepts = 'FTS search query' WHERE id = 2").run();

    const concepts = extractUniqueConcepts(db);
    expect(concepts).toContain('FTS5');
    expect(concepts).toContain('full-text');
    expect(concepts).toContain('search');
  });

  it('applies synonym groups to observations', async () => {
    const { applyNormalization } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'obs1', text: 'full-text search' });
    db.prepare("UPDATE observations SET concepts = 'full-text search' WHERE id = 1").run();

    const groups = [{ canonical: 'FTS5', aliases: ['full-text', 'FTS', '全文搜索'] }];
    const result = applyNormalization(db, groups);
    expect(result.updated).toBeGreaterThan(0);

    const obs = db.prepare('SELECT concepts, search_aliases FROM observations WHERE id = 1').get();
    expect(obs.concepts).toContain('FTS5');
  });

  it('returns 0 updated for empty groups', async () => {
    const { applyNormalization } = await import('../hook-optimize.mjs');
    const result = applyNormalization(db, []);
    expect(result.updated).toBe(0);
  });

  // Gate-decision skeleton (no IO). A malformed-but-valid-JSON gate file must
  // FAIL OPEN — a missing/non-numeric/future epoch produced NaN >= INTERVAL = false,
  // which permanently disabled normalize with no recovery (contradicting the
  // corrupt-file catch branch which already returns true).
  it('_normalizeGateOpen fails open on a malformed/missing/future epoch', async () => {
    const { _normalizeGateOpen } = await import('../hook-optimize.mjs');
    const now = 1_800_000_000_000;
    const WEEK = 7 * 86400000;
    // fail-open (run)
    expect(_normalizeGateOpen({}, now)).toBe(true); // missing epoch
    expect(_normalizeGateOpen({ epoch: 'x' }, now)).toBe(true); // non-numeric
    expect(_normalizeGateOpen({ epoch: null }, now)).toBe(true); // null
    expect(_normalizeGateOpen({ epoch: NaN }, now)).toBe(true); // NaN
    expect(_normalizeGateOpen({ epoch: now + WEEK }, now)).toBe(true); // future
    expect(_normalizeGateOpen(null, now)).toBe(true); // no object
    // honor the interval for a valid epoch
    expect(_normalizeGateOpen({ epoch: now }, now)).toBe(false); // just ran
    expect(_normalizeGateOpen({ epoch: now - 86400000 }, now)).toBe(false); // 1d ago
    expect(_normalizeGateOpen({ epoch: now - WEEK - 1 }, now)).toBe(true); // >7d ago
  });
});

describe('cluster-merge', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('finds merge candidates with moderate similarity', async () => {
    const { findMergeCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fix FTS5 query sanitization bug in utils.mjs',
      narrative: 'Fixed special char handling',
    });
    insertObs(db, {
      title: 'Fix FTS5 query sanitization edge case in utils.mjs',
      narrative: 'Fixed parentheses handling',
    });
    const candidates = findMergeCandidates(db, 10);
    expect(candidates.length).toBeGreaterThanOrEqual(0);
  });

  it('executes merge when LLM approves', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Fix FTS5 bug A', narrative: 'Handled special chars', accessCount: 3 });
    insertObs(db, { title: 'Fix FTS5 bug B', narrative: 'Handled parentheses', accessCount: 1 });

    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
    callModelJSONAsync.mockResolvedValue({
      should_merge: true,
      merged_title: 'Fix FTS5 query sanitization bugs',
      merged_narrative: 'Fixed multiple edge cases in FTS5 query sanitization',
      merged_concepts: ['FTS5', 'sanitize', 'query'],
      merged_facts: ['FTS5 special chars crash sanitizeFtsQuery', 'Parentheses need escaping'],
      merged_lesson: 'FTS5 requires comprehensive input sanitization',
      importance: 2,
    });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(true);

    const keeper = db.prepare('SELECT * FROM observations WHERE id = ?').get(obs[0].id);
    expect(keeper.title).toBe('Fix FTS5 query sanitization bugs');
    expect(keeper.optimized_at).toBeGreaterThan(0);

    const other = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(obs[1].id);
    expect(other.compressed_into).toBe(obs[0].id);
  });

  it('snapshots the keeper original text before in-place overwrite (HIGH-3: data loss)', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Keeper original title',
      narrative: 'irreplaceable repro steps',
      importance: 3,
      accessCount: 5,
    });
    insertObs(db, { title: 'Other member', narrative: 'minor', importance: 1, accessCount: 1 });
    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
    const keeperId = obs.find((o) => o.importance === 3).id;

    callModelJSONAsync.mockResolvedValue({
      should_merge: true,
      merged_title: 'Merged summary title',
      merged_narrative: 'lossy summary that drops the repro steps',
      merged_concepts: ['x'],
      merged_facts: ['y'],
      merged_lesson: null,
      importance: 2,
    });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(true);

    // keeper holds the merged content in place (id stable — no caller breakage)
    const keeper = db.prepare('SELECT * FROM observations WHERE id = ?').get(keeperId);
    expect(keeper.title).toBe('Merged summary title');

    // the keeper's ORIGINAL text survives as a recoverable compressed_into child
    const snap = db
      .prepare("SELECT * FROM observations WHERE compressed_into = ? AND title = 'Keeper original title'")
      .get(keeperId);
    expect(snap, 'keeper original must be snapshotted, not lost').toBeTruthy();
    expect(snap.narrative).toBe('irreplaceable repro steps');
  });

  it('preserves cluster lessons when the LLM returns merged_lesson:null (never-auto-GC)', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Fix FTS5 keeper', narrative: 'keeper narrative', importance: 2, accessCount: 5 });
    insertObs(db, { title: 'Fix FTS5 other', narrative: 'other narrative', importance: 1, accessCount: 1 });
    const rows = db.prepare('SELECT id FROM observations ORDER BY id').all();
    const keeperId = rows[0].id,
      otherId = rows[1].id;
    db.prepare(
      "UPDATE observations SET lesson_learned = 'FTS5 special chars MUST be escaped' WHERE id = ?",
    ).run(keeperId);
    db.prepare("UPDATE observations SET lesson_learned = 'parentheses need balancing too' WHERE id = ?").run(
      otherId,
    );

    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
    // LLM approves the merge but declines to synthesize a lesson — the prompt explicitly permits null.
    callModelJSONAsync.mockResolvedValue({
      should_merge: true,
      merged_title: 'Merged FTS5 sanitization',
      merged_narrative: 'consolidated',
      merged_concepts: ['x'],
      merged_facts: ['y'],
      merged_lesson: null,
      importance: 2,
    });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(true);

    // The keeper (the surviving live row) must still carry a lesson — the union of the members', never null.
    const keeper = db.prepare('SELECT lesson_learned FROM observations WHERE id = ?').get(keeperId);
    expect(keeper.lesson_learned, 'merge must not null out the lesson on merged_lesson:null').toBeTruthy();
    expect(keeper.lesson_learned).toContain('FTS5 special chars');
    expect(keeper.lesson_learned).toContain('parentheses need balancing');

    // Invariant: at least one lesson stays on a LIVE (compressed_into=0) surface after the merge.
    const liveLessons = db
      .prepare(
        "SELECT COUNT(*) c FROM observations WHERE COALESCE(compressed_into,0)=0 AND lesson_learned IS NOT NULL AND lesson_learned != ''",
      )
      .get().c;
    expect(liveLessons).toBeGreaterThan(0);
  });

  it('excludes superseded members from merge clusters (no tombstoned-lesson resurrection)', async () => {
    const { findMergeCandidates } = await import('../hook-optimize.mjs');
    // Three similar-title rows; the third is tombstoned (auto-dedup superseded it) with a
    // retired lesson. Without the superseded_at filter, findMergeCandidates returns it as a
    // valid cluster member (auto-dedup sets superseded_at but not compressed_into/optimized_at),
    // so the union-fallback would resurrect its retired lesson onto the keeper AND the keeper
    // reduce could pick the invisible superseded row (whole-cluster data loss).
    insertObs(db, { title: 'Fix FTS5 query sanitization bug in utils.mjs', narrative: 'n1' });
    insertObs(db, { title: 'Fix FTS5 query sanitization edge case in utils.mjs', narrative: 'n2' });
    insertObs(db, { title: 'Fix FTS5 query sanitization crash in utils.mjs', narrative: 'n3' });
    const rows = db.prepare('SELECT id FROM observations ORDER BY id').all();
    const supId = rows[2].id;
    db.prepare("UPDATE observations SET lesson_learned = 'live lesson' WHERE id IN (?, ?)").run(
      rows[0].id,
      rows[1].id,
    );
    db.prepare(
      "UPDATE observations SET lesson_learned = 'STALE retired lesson', superseded_at = ?, superseded_by = 'auto-dedup' WHERE id = ?",
    ).run(Date.now(), supId);

    const members = findMergeCandidates(db, 5, {}).flat();
    const memberIds = members.map((o) => o.id);
    expect(memberIds, 'a superseded (tombstoned) row must not be a merge candidate').not.toContain(supId);
    expect(members.some((o) => o.lesson_learned === 'STALE retired lesson')).toBe(false);
  });

  it('skips merge when LLM says should_merge=false', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Obs A', narrative: 'About auth' });
    insertObs(db, { title: 'Obs B', narrative: 'About database' });
    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();

    callModelJSONAsync.mockResolvedValue({ should_merge: false });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(false);
  });

  it('keeps the highest-importance member and never downgrades importance on merge', async () => {
    const { executeMergeCluster } = await import('../hook-optimize.mjs');
    // #1: critical (importance=3) but never accessed.  #2: trivial (importance=1) but
    // accessed often. Pre-fix the keeper was chosen by access_count alone, so the critical
    // observation was compressed away and the merged importance fell to the LLM default (2).
    insertObs(db, {
      title: 'Critical FTS bug A',
      narrative: 'data-loss root cause',
      importance: 3,
      accessCount: 0,
    });
    insertObs(db, {
      title: 'Critical FTS bug B',
      narrative: 'trivial follow-up',
      importance: 1,
      accessCount: 9,
    });
    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();
    const criticalId = obs.find((o) => o.importance === 3).id;

    callModelJSONAsync.mockResolvedValue({
      should_merge: true,
      merged_title: 'Critical FTS bug (merged)',
      merged_narrative: 'merged narrative',
      merged_concepts: ['fts'],
      merged_facts: ['fact'],
      merged_lesson: 'lesson',
      importance: 2, // LLM proposes 2 — must be floored up to 3
    });

    const result = await executeMergeCluster(db, obs);
    expect(result.merged).toBe(true);
    expect(result.keeperId).toBe(criticalId); // critical member kept as the survivor
    const keeper = db.prepare('SELECT importance FROM observations WHERE id = ?').get(criticalId);
    expect(keeper.importance).toBe(3); // max(LLM 2, cluster-max 3) — not downgraded
  });
});

describe('smart-compress', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('finds compress candidates (old, low-importance, no access)', async () => {
    const { findSmartCompressCandidates } = await import('../hook-optimize.mjs');
    const oldEpoch = -(31 * 86400000);
    insertObs(db, { title: 'Old obs 1', epochOffset: oldEpoch, importance: 1, accessCount: 0 });
    insertObs(db, { title: 'Old obs 2', epochOffset: oldEpoch - 1000, importance: 1, accessCount: 0 });
    insertObs(db, { title: 'Old obs 3', epochOffset: oldEpoch - 2000, importance: 1, accessCount: 0 });
    const candidates = findSmartCompressCandidates(db);
    expect(candidates.length).toBe(3);
  });

  it('skips recent or important observations', async () => {
    const { findSmartCompressCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Recent obs', importance: 1, accessCount: 0 });
    insertObs(db, { title: 'Important obs', epochOffset: -(31 * 86400000), importance: 2, accessCount: 0 });
    const candidates = findSmartCompressCandidates(db);
    expect(candidates.length).toBe(0);
  });

  it('creates smart summary from a cluster', async () => {
    const { executeSmartCompressCluster } = await import('../hook-optimize.mjs');
    const oldEpoch = -(31 * 86400000);
    insertObs(db, { title: 'Modified utils.mjs', narrative: 'Changed sanitize fn', epochOffset: oldEpoch });
    insertObs(db, {
      title: 'Updated utils.mjs tests',
      narrative: 'Added test cases',
      epochOffset: oldEpoch - 1000,
    });
    insertObs(db, {
      title: 'Fixed utils.mjs lint',
      narrative: 'Resolved lint warnings',
      epochOffset: oldEpoch - 2000,
    });

    const obs = db.prepare('SELECT * FROM observations ORDER BY id').all();

    callModelJSONAsync.mockResolvedValue({
      // D#10: the verdict is now required. This mock predates it, and leaving it out
      // would make the case assert the OLD contract (no way for the model to refuse).
      should_compress: true,
      title: 'Utils.mjs maintenance: sanitize improvements and cleanup',
      narrative:
        'Series of changes to utils.mjs including sanitize function updates, test additions, and lint fixes.',
      concepts: ['utils', 'sanitize', 'lint'],
      facts: ['sanitize function in utils.mjs was updated', 'lint warnings resolved'],
      lesson_learned: 'none',
      search_aliases: ['utils cleanup', 'sanitize refactor'],
    });

    const result = await executeSmartCompressCluster(db, obs, 'test');
    expect(result.compressed).toBe(true);
    expect(result.summaryId).toBeGreaterThan(0);

    for (const o of obs) {
      const row = db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(o.id);
      expect(row.compressed_into).toBe(result.summaryId);
    }

    const summary = db.prepare('SELECT * FROM observations WHERE id = ?').get(result.summaryId);
    expect(summary.importance).toBe(2);
    expect(summary.title).toContain('Utils.mjs');
  });

  // D#10. This path HIDES its inputs — the originals get compressed_into set, which
  // removes them from every injection and search surface and puts them out of
  // recoverBuriedLessons' reach. It ran with no way for the model to refuse: the prompt
  // ASSERTED the premise ("Summarize these related …") and the only bail was a missing
  // title. Its sibling executeMergeCluster has had `should_merge` all along, so the two
  // LLM cluster paths disagreed about whether the model may say no.
  //
  // That mattered because the relatedness check upstream is not always on. Measured
  // 2026-09-07 with a control arm: three observations with nothing in common but project
  // and era (a CSS variable bump, a Kafka consumer-group rename, a Terraform provider pin)
  // over 12 days. With CLAUDE_MEM_VECTORS=1 clusterForCompression forms 0 clusters; on the
  // DEFAULT config (vector arm off -> getVocabulary returns null -> the `if (vocab)` else
  // branch groups by a 14-day window alone) it forms ONE cluster of all three.
  const cluster3 = (db) => {
    const oldEpoch = -(31 * 86400000);
    insertObs(db, {
      title: 'Bumped the sidebar hover colour',
      narrative: 'CSS var change',
      epochOffset: oldEpoch,
    });
    insertObs(db, {
      title: 'Renamed the Kafka consumer group',
      narrative: 'Billing topic',
      epochOffset: oldEpoch - 1000,
    });
    insertObs(db, {
      title: 'Pinned the Terraform AWS provider',
      narrative: 'Spurious diffs',
      epochOffset: oldEpoch - 2000,
    });
    return db.prepare('SELECT * FROM observations ORDER BY id').all();
  };

  it('refuses when the model says the cluster is not one story', async () => {
    const { executeSmartCompressCluster } = await import('../hook-optimize.mjs');
    const obs = cluster3(db);
    callModelJSONAsync.mockResolvedValue({
      should_compress: false,
      title: 'Assorted unrelated maintenance',
      narrative: 'These three changes have nothing to do with each other.',
    });
    const result = await executeSmartCompressCluster(db, obs, 'test');
    expect(result.compressed).toBe(false);
    // The assertion that matters is that the INPUTS survive visible, not just the return
    // value: compressed_into is what removes them from every surface.
    // Asserted with the system's OWN liveness predicate, not a literal: a fresh row's
    // compressed_into is NULL, not 0, and COALESCE(...,0)=0 is what every read path uses.
    const hidden = db
      .prepare(
        `SELECT COUNT(*) c FROM observations WHERE id IN (${obs.map(() => '?').join(',')}) AND COALESCE(compressed_into,0) <> 0`,
      )
      .get(...obs.map((o) => o.id)).c;
    expect(hidden).toBe(0);
  });

  it('refuses when the model omits the verdict (fail closed, like should_merge)', async () => {
    const { executeSmartCompressCluster } = await import('../hook-optimize.mjs');
    const obs = cluster3(db);
    // A response that is otherwise perfectly usable. Fail-closed is the deliberate
    // direction: the bad outcome of refusing is "no compression happened", the bad
    // outcome of proceeding is "unrelated observations were hidden".
    callModelJSONAsync.mockResolvedValue({
      title: 'Assorted maintenance',
      narrative: 'Three changes.',
      concepts: ['maintenance'],
    });
    const result = await executeSmartCompressCluster(db, obs, 'test');
    expect(result.compressed).toBe(false);
    // Asserted with the system's OWN liveness predicate, not a literal: a fresh row's
    // compressed_into is NULL, not 0, and COALESCE(...,0)=0 is what every read path uses.
    const hidden = db
      .prepare(
        `SELECT COUNT(*) c FROM observations WHERE id IN (${obs.map(() => '?').join(',')}) AND COALESCE(compressed_into,0) <> 0`,
      )
      .get(...obs.map((o) => o.id)).c;
    expect(hidden).toBe(0);
  });

  it('asks for the verdict in the prompt it actually sends', async () => {
    const { executeSmartCompressCluster } = await import('../hook-optimize.mjs');
    const obs = cluster3(db);
    callModelJSONAsync.mockResolvedValue({ should_compress: true, title: 'T', narrative: 'N' });
    await executeSmartCompressCluster(db, obs, 'test');
    // A veto nothing asks for is a veto that always fires — with fail-closed semantics
    // that would silently stop ALL compression. Assert on the prompt the mock received,
    // not on the source text.
    const [prompt] = callModelJSONAsync.mock.calls[0];
    // QUOTED, so it matches the JSON TEMPLATE and not the prose line that explains the
    // field. The bare-string form was walked straight past by the real revert shape
    // (delete the key from the template, keep the explanation) — mutation M16.
    expect(prompt).toContain('"should_compress"');
    expect(prompt).not.toContain('Summarize these related');
  });
});

describe('hook integration', () => {
  it('BG_EVENTS includes llm-optimize', async () => {
    const { readFileSync } = await import('fs');
    // D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to hook.mjs.
    const hookSrc = readFileSync(HOOK_PATH, 'utf8');
    expect(hookSrc).toContain("'llm-optimize'");
  });

  it('hook.mjs imports handleLLMOptimize', async () => {
    const { readFileSync } = await import('fs');
    // D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to hook.mjs.
    const hookSrc = readFileSync(HOOK_PATH, 'utf8');
    expect(hookSrc).toContain('handleLLMOptimize');
  });

  it('hook.mjs spawns llm-optimize after auto-compress', async () => {
    const { readFileSync } = await import('fs');
    // D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to hook.mjs.
    const hookSrc = readFileSync(HOOK_PATH, 'utf8');
    const autoCompressIdx = hookSrc.indexOf("spawnBackground('auto-compress')");
    const llmOptimizeIdx = hookSrc.indexOf("spawnBackground('llm-optimize')");
    expect(autoCompressIdx).toBeGreaterThan(-1);
    expect(llmOptimizeIdx).toBeGreaterThan(autoCompressIdx);
  });
});

describe('pipeline', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('preview returns candidate counts without executing', async () => {
    const { optimizePreview } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Degraded obs', narrative: 'No enrichment' });
    const result = optimizePreview(db);
    expect(result).toHaveProperty('reenrich');
    expect(result).toHaveProperty('normalize');
    expect(result).toHaveProperty('clusterMerge');
    expect(result).toHaveProperty('smartCompress');
    expect(result.reenrich).toBeGreaterThanOrEqual(0);
  });

  it('distributeBudget allocates correctly', async () => {
    const { distributeBudget } = await import('../hook-optimize.mjs');
    const budget = distributeBudget(15);
    expect(budget.reenrich).toBe(6);
    expect(budget.normalize).toBe(1);
    expect(budget.clusterMerge).toBe(4);
    expect(budget.smartCompress).toBe(4);
    expect(
      budget.reenrich + budget.normalize + budget.clusterMerge + budget.smartCompress,
    ).toBeLessThanOrEqual(15);
  });

  it('distributeBudget clamps for small totals', async () => {
    const { distributeBudget } = await import('../hook-optimize.mjs');
    const budget = distributeBudget(4);
    const sum = budget.reenrich + budget.normalize + budget.clusterMerge + budget.smartCompress;
    expect(sum).toBeLessThanOrEqual(4);
    expect(budget.normalize).toBe(1);
  });
});
