// D#135 P3 prerequisite — the observations.scope WRITE path.
//
// v44 added observations.scope + the CLAUDE_MEM_SCOPE_FILTER read lever
// (scripts/pre-tool-recall.js skips `environment`-scoped rows on file-triggered
// recalls). The lever was inert in practice: only ONE of the three write faces
// ever set the column.
//
// Live measurement 2026-08-19 (3650 obs): 3587 rows scope IS NULL. Rows created
// on 08-16/08-17 split cleanly by type — `change` 48/50 carried a scope, every
// bugfix/decision/discovery/refactor/feature row carried none (0/41). The one
// working face is hook-llm's episode summarizer; manual saves (mem_save / CLI /
// the lesson skill) and the daily re-enrich pass both left it NULL — and those
// are exactly the lesson-bearing rows pre-tool recall injects.
//
// Faces closed here:
//   B  lib/save-enrich.mjs      — new manual saves (rides the existing Haiku call)
//   C  hook-optimize narrow/wide/aliases — rides the existing re-enrich calls
//   D  hook-optimize scope='scopes'      — dedicated backfill for the 2041-row
//      legacy pool that none of the other faces can reach (they all require a
//      missing lesson or missing aliases; 1955 of those rows have BOTH).
//
// Cadence note (the v3.43 lesson re-applied): a new re-enrich scope with no slot
// in the DAILY split crawls — alias coverage sat at ~15% for months for exactly
// that reason. optimizeRun must drain the scopes pool on the default pass too.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { executeSaveEnrich } from '../lib/save-enrich.mjs';
import { normalizeScope } from '../lib/observation-write.mjs';

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

vi.mock('../haiku-client.mjs', () => ({
  callModelJSONAsync: vi.fn(),
  callModelJSON: vi.fn(),
  BG_LLM_TIMEOUT_MS: 45000,
}));

import { callModelJSONAsync } from '../haiku-client.mjs';

const PROJECT = 'scope--test';
// >100 chars so the substantive-narrative gate (shared by wide/aliases/scopes) opens.
const SUBSTANTIVE =
  'The npm proxy rejected the registry request because HTTPS_PROXY was set but Node built-in fetch ignores it, so the install hung until the agent was passed explicitly.';

function row(db, id) {
  return db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
}

// ─── Face B: save-time enrichment ───────────────────────────────────────────

describe('save-enrich writes observations.scope (face B)', () => {
  function save(db, over = {}) {
    return saveObservation(db, {
      project: PROJECT,
      type: 'bugfix',
      content: 'Fixed the npm install hang behind the corporate proxy by passing an explicit dispatcher',
      ...over,
    });
  }

  it('backfills scope alongside lesson + aliases on a manual save', async () => {
    const db = createTestDb();
    const { id } = save(db);
    const r = await executeSaveEnrich(db, id, {
      callJson: async () => ({
        lesson_learned: 'Node built-in fetch ignores HTTPS_PROXY — pass a ProxyAgent dispatcher explicitly',
        search_aliases: ['proxy hang', 'fetch ignores proxy'],
        scope: 'environment',
      }),
    });
    expect(r.enriched).toBe(true);
    expect(row(db, id).scope).toBe('environment');
    db.close();
  });

  it('enriches a row that needs ONLY scope (lesson + aliases already present)', async () => {
    const db = createTestDb();
    // saveObservation takes no search_aliases param (that gap is why save-enrich
    // exists) — stand in for a row the daily alias pass already filled.
    const { id } = save(db, { lesson_learned: 'caller-written lesson' });
    db.prepare('UPDATE observations SET search_aliases = ? WHERE id = ?').run('caller aliases', id);
    const r = await executeSaveEnrich(db, id, {
      callJson: async () => ({ scope: 'module' }),
    });
    expect(r.enriched).toBe(true);
    const o = row(db, id);
    expect(o.scope).toBe('module');
    // The fields that were already filled stay exactly as the caller wrote them.
    expect(o.lesson_learned).toBe('caller-written lesson');
    expect(o.search_aliases).toBe('caller aliases');
    db.close();
  });

  it('NEVER overwrites an existing scope (fill-only-empty)', async () => {
    const db = createTestDb();
    const { id } = save(db);
    db.prepare('UPDATE observations SET scope = ? WHERE id = ?').run('project', id);
    await executeSaveEnrich(db, id, {
      callJson: async () => ({ scope: 'environment', search_aliases: ['an alias'] }),
    });
    const o = row(db, id);
    expect(o.scope).toBe('project');
    expect(o.search_aliases).toContain('an alias');
    db.close();
  });

  // The check above only exercises the eligibility read at the top of the worker.
  // The BEGIN IMMEDIATE re-check is a SEPARATE guard, for a scope that lands while
  // the Haiku call is in flight (the daily optimize pass, or an episode upgrade of
  // the same row). Dropping it survives the test above untouched — mirrors the
  // existing "aliases filled concurrently between spawn and execution" case.
  it('NEVER overwrites a scope written while the LLM call is in flight', async () => {
    const db = createTestDb();
    const { id } = save(db);
    await executeSaveEnrich(db, id, {
      callJson: async () => {
        db.prepare('UPDATE observations SET scope = ? WHERE id = ?').run('project', id);
        return { scope: 'environment', search_aliases: ['an alias'] };
      },
    });
    const o = row(db, id);
    expect(o.scope).toBe('project');
    expect(o.search_aliases).toContain('an alias');
    db.close();
  });

  it('rejects an off-enum scope without blocking the lesson/alias write', async () => {
    const db = createTestDb();
    const { id } = save(db);
    const r = await executeSaveEnrich(db, id, {
      callJson: async () => ({
        lesson_learned: 'a real transferable lesson about proxies',
        search_aliases: ['proxy alias'],
        scope: 'GLOBAL', // not in the enum — and case variants must not slip through
      }),
    });
    expect(r.enriched).toBe(true);
    const o = row(db, id);
    expect(o.scope).toBeNull();
    expect(o.lesson_learned).toContain('proxies');
    db.close();
  });

  it('scope alone is not "usable" when the LLM returns nothing else and scope is invalid', async () => {
    const db = createTestDb();
    const { id } = save(db);
    const before = row(db, id);
    const r = await executeSaveEnrich(db, id, {
      callJson: async () => ({ lesson_learned: 'none', search_aliases: [], scope: 'nonsense' }),
    });
    expect(r.enriched).toBe(false);
    expect(row(db, id)).toEqual(before);
    db.close();
  });
});

// ─── Face C: the existing re-enrich passes ──────────────────────────────────

describe('re-enrich narrow/wide/aliases carry scope (face C)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('narrow re-enrich persists the classified scope', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Error in install.mjs', narrative: 'npm install hung' });
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Fix npm install hang behind proxy',
      narrative: SUBSTANTIVE,
      concepts: ['npm', 'proxy'],
      facts: ['fetch ignores HTTPS_PROXY'],
      importance: 2,
      lesson_learned: 'Pass a ProxyAgent dispatcher to built-in fetch',
      search_aliases: ['proxy hang'],
      scope: 'environment',
    });
    expect((await executeReenrich(db, 10)).processed).toBe(1);
    expect(db.prepare('SELECT scope FROM observations LIMIT 1').get().scope).toBe('environment');
  });

  it('a re-enrich that omits scope must NOT wipe an existing one (COALESCE)', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, { title: 'Error in install.mjs', narrative: 'npm install hung' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare('UPDATE observations SET scope = ? WHERE id = ?').run('project', id);
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Fix npm install hang behind proxy',
      narrative: SUBSTANTIVE,
      concepts: ['npm'],
      facts: ['f'],
      importance: 2,
      lesson_learned: 'a lesson',
      search_aliases: ['alias'],
      // no scope key at all
    });
    expect((await executeReenrich(db, 10)).processed).toBe(1);
    expect(row(db, id).scope).toBe('project');
  });

  // The COALESCE on the aliases UPDATE was pinned by NOTHING: mutating it to a
  // plain `scope = ?` passed all 282 files / 4732 tests (pre-tag review, round 3,
  // reproduced here before this case was written). The sibling case below starts
  // from scope NULL, where COALESCE and plain-set are indistinguishable — so the
  // release's own headline invariant, "an omitted scope must never erase a
  // classification an earlier face wrote", had no guard on this face.
  it('an omitted scope must NOT blank a classification an earlier face wrote (aliases)', async () => {
    const { executeReenrich, findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed the proxy install hang',
      narrative: SUBSTANTIVE,
      text: 'npm proxy install hang',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Pass a ProxyAgent dispatcher to built-in fetch',
      searchAliases: null,
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare('UPDATE observations SET scope = ? WHERE id = ?').run('project', id);
    // The shape is reachable, not hypothetical: scope set + aliases missing is a
    // live aliases candidate (mem_save writes no aliases, the summarizer writes scope).
    expect(findReenrichCandidates(db, 10, { scope: 'aliases' }).length).toBe(1);

    // Haiku answers with aliases and no scope key — the ordinary partial response.
    callModelJSONAsync.mockResolvedValue({ search_aliases: ['proxy hang', 'registry timeout'] });
    await executeReenrich(db, 10, { scope: 'aliases' });

    const after = row(db, id);
    expect(after.scope).toBe('project');
    expect(after.search_aliases).toContain('registry timeout');
  });

  it('the aliases pass backfills scope while still touching nothing else', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed the proxy install hang',
      narrative: SUBSTANTIVE,
      text: 'npm proxy install hang',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Pass a ProxyAgent dispatcher to built-in fetch',
      searchAliases: null,
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    const before = row(db, id);
    callModelJSONAsync.mockResolvedValue({
      search_aliases: ['proxy hang', 'registry timeout'],
      scope: 'environment',
    });
    expect((await executeReenrich(db, 10, { scope: 'aliases' })).processed).toBe(1);
    const o = row(db, id);
    expect(o.scope).toBe('environment');
    expect(o.search_aliases).toContain('registry timeout');
    expect(o.title).toBe(before.title);
    expect(o.narrative).toBe(before.narrative);
    expect(o.lesson_learned).toBe(before.lesson_learned);
    expect(o.importance).toBe(before.importance);
  });
});

// ─── Face D: the dedicated scopes backfill ──────────────────────────────────

describe("re-enrich scope='scopes' (D#135 legacy backfill)", () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  function legacyRow(over = {}) {
    insertObs(db, {
      title: 'Fixed the proxy install hang',
      narrative: SUBSTANTIVE,
      text: 'npm proxy install hang',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Pass a ProxyAgent dispatcher to built-in fetch',
      searchAliases: 'proxy hang registry timeout',
      ...over,
    });
    return db.prepare('SELECT id FROM observations ORDER BY id DESC LIMIT 1').get().id;
  }

  it('selects the scope-less row that narrow, wide AND aliases all skip', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    legacyRow();
    // This is the 1955-row shape: lesson present, aliases present, scope NULL.
    expect(findReenrichCandidates(db, 10, { scope: 'narrow' }).length).toBe(0);
    expect(findReenrichCandidates(db, 10, { scope: 'wide' }).length).toBe(0);
    expect(findReenrichCandidates(db, 10, { scope: 'aliases' }).length).toBe(0);
    const found = findReenrichCandidates(db, 10, { scope: 'scopes' });
    expect(found.length).toBe(1);
    expect(found[0].title).toBe('Fixed the proxy install hang');
  });

  it('excludes rows that already carry a scope (idempotent)', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    const id = legacyRow();
    db.prepare('UPDATE observations SET scope = ? WHERE id = ?').run('file', id);
    expect(findReenrichCandidates(db, 10, { scope: 'scopes' }).length).toBe(0);
  });

  it('excludes superseded and compressed rows', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    const sup = legacyRow();
    db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(Date.now(), sup);
    const comp = legacyRow();
    db.prepare('UPDATE observations SET compressed_into = 999 WHERE id = ?').run(comp);
    expect(findReenrichCandidates(db, 10, { scope: 'scopes' }).length).toBe(0);
  });

  it('orders lesson-bearing rows first (they are what the recall filter gates on)', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    legacyRow({ title: 'Lessonless row', lessonLearned: null });
    const withLesson = legacyRow({ title: 'Lesson-bearing row' });
    const found = findReenrichCandidates(db, 10, { scope: 'scopes' });
    expect(found.length).toBe(2);
    expect(found[0].id).toBe(withLesson);
  });

  it('writes ONLY scope — every other column stays byte-identical', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = legacyRow();
    const before = row(db, id);
    // Hostile payload: the classifier reply carries fields the general re-enrich
    // would happily apply. This branch must ignore all of them.
    callModelJSONAsync.mockResolvedValue({
      scope: 'environment',
      title: 'hostile title rewrite',
      narrative: 'hostile narrative',
      lesson_learned: 'hostile lesson',
      search_aliases: ['hostile alias'],
      importance: 0,
      type: 'change',
    });
    expect((await executeReenrich(db, 10, { scope: 'scopes' })).processed).toBe(1);
    const after = row(db, id);
    expect(after.scope).toBe('environment');
    expect({ ...after, scope: null }).toEqual({ ...before, scope: null });
    // Never sets optimized_at: the daily wide pass must stay the outer safety net.
    expect(after.optimized_at).toBeNull();
  });

  it('skips (does not write) when the classifier returns an off-enum value', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = legacyRow();
    callModelJSONAsync.mockResolvedValue({ scope: 'repository' });
    const r = await executeReenrich(db, 10, { scope: 'scopes' });
    expect(r.processed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(row(db, id).scope).toBeNull();
  });

  it('never clobbers a scope written between candidate selection and update', async () => {
    const { executeReenrich } = await import('../hook-optimize.mjs');
    const id = legacyRow();
    callModelJSONAsync.mockImplementation(async () => {
      // A concurrent save-enrich / episode upgrade lands while the LLM is in flight.
      db.prepare('UPDATE observations SET scope = ? WHERE id = ?').run('project', id);
      return { scope: 'environment' };
    });
    await executeReenrich(db, 10, { scope: 'scopes' });
    expect(row(db, id).scope).toBe('project');
  });

  it('respects the project filter', async () => {
    const { findReenrichCandidates } = await import('../hook-optimize.mjs');
    insertSession(db, { id: 'sess-2', project: 'other' });
    legacyRow();
    legacyRow({ sessionId: 'sess-2', project: 'other', title: 'Other project row' });
    expect(findReenrichCandidates(db, 10, { scope: 'scopes' }).length).toBe(2);
    const scoped = findReenrichCandidates(db, 10, { scope: 'scopes', project: 'other' });
    expect(scoped.length).toBe(1);
    expect(scoped[0].title).toBe('Other project row');
  });
});

// ─── Cadence: the default daily pass must drain the scopes pool ─────────────

describe('optimizeRun gives the scopes backfill a daily slot', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    callModelJSONAsync.mockReset();
  });
  afterEach(() => {
    db.close();
  });

  it('default-scope run classifies a scope-less row (no explicit --scope)', async () => {
    const { optimizeRun } = await import('../hook-optimize.mjs');
    insertObs(db, {
      title: 'Fixed the proxy install hang',
      narrative: SUBSTANTIVE,
      text: 'npm proxy install hang',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Pass a ProxyAgent dispatcher to built-in fetch',
      searchAliases: 'proxy hang registry timeout',
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    callModelJSONAsync.mockResolvedValue({ scope: 'environment' });
    const res = await optimizeRun(db, { tasks: ['re-enrich'], maxItems: 6 });
    expect(res.reenrich.byScope.scopes.processed).toBe(1);
    expect(row(db, id).scope).toBe('environment');
  });

  it('a zero-candidate scopes pool costs the main scope nothing', async () => {
    const { optimizeRun } = await import('../hook-optimize.mjs');
    // Degraded row: a narrow candidate, and (scope NULL but narrative too thin)
    // NOT a scopes candidate.
    insertObs(db, { title: 'Error in utils.mjs', narrative: 'short' });
    callModelJSONAsync.mockResolvedValue({
      type: 'bugfix',
      title: 'Fixed sanitizeFtsQuery',
      narrative: SUBSTANTIVE,
      concepts: ['fts'],
      facts: ['f'],
      importance: 2,
      lesson_learned: 'escape FTS specials',
      search_aliases: ['fts crash'],
    });
    const res = await optimizeRun(db, { tasks: ['re-enrich'], maxItems: 6 });
    expect(res.reenrich.byScope.scopes.processed).toBe(0);
    expect(res.reenrich.byScope.narrow.processed).toBe(1);
  });
});

// ─── Preview + CLI surface ──────────────────────────────────────────────────

describe('optimizePreview reports the scopes backlog', () => {
  it('counts scope-less substantive rows under reenrichScopes', async () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, {
      title: 'Fixed the proxy install hang',
      narrative: SUBSTANTIVE,
      text: 'npm proxy install hang',
      type: 'bugfix',
      importance: 2,
      lessonLearned: 'Pass a ProxyAgent dispatcher',
      searchAliases: 'proxy hang',
    });
    const { optimizePreview } = await import('../hook-optimize.mjs');
    expect(optimizePreview(db).reenrichScopes).toBe(1);
    db.close();
  });
});

describe('normalizeScope guards the enum', () => {
  it('accepts the four enum values and rejects everything else', () => {
    for (const s of ['file', 'module', 'project', 'environment']) {
      expect(normalizeScope(s)).toBe(s);
    }
    for (const s of ['File', 'ENVIRONMENT', 'repo', '', null, undefined, 42, {}]) {
      expect(normalizeScope(s)).toBeNull();
    }
  });
});
