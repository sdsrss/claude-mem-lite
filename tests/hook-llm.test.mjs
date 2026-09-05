// Tests for hook-llm.mjs — saveObservation, dedup tiers, related linking, LLM episode/summary
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { computeMinHash, parseJsonFromLLM } from '../utils.mjs';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

vi.mock('../hook-shared.mjs', async () => {
  const actual = await vi.importActual('../hook-shared.mjs');
  return {
    ...actual,
    openDb: vi.fn(),
    callLLM: vi.fn(),
    sleep: vi.fn(async () => {}),
  };
});

import {
  saveObservation,
  handleLLMEpisode,
  handleLLMSummary,
  buildDegradedTitle,
  persistHaikuSummary,
  buildImmediateObservation,
  unwrapObservationEnvelope,
  isLowSignalLesson,
  hasEnrichmentContent,
  buildVecText,
} from '../hook-llm.mjs';
import { openDb, callLLM } from '../hook-shared.mjs';
import { acquireLLMSlot } from '../hook-semaphore.mjs';

// v2.58: callLLM now accepts string OR {system, user} (cso F#4 fix). Tests
// asserting prompt content should normalize both forms before string-matching.
function promptText(p) {
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object') return `${p.system || ''}\n${p.user || ''}`;
  return String(p ?? '');
}

// ─── saveObservation ─────────────────────────────────────────────────────────

describe('saveObservation', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });

  afterEach(() => {
    db.close();
  });

  it('inserts observation and returns row ID', () => {
    const obs = {
      type: 'feature',
      title: 'Add user authentication',
      subtitle: 'auth.mjs',
      narrative: 'Implemented JWT auth flow',
      concepts: ['auth', 'jwt'],
      facts: ['Uses RS256 signing'],
      files: ['auth.mjs'],
      filesRead: ['config.mjs'],
      importance: 2,
    };

    const id = saveObservation(obs, 'test', 'sess-1', db);
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row.title).toBe('Add user authentication');
    expect(row.type).toBe('feature');
    expect(row.narrative).toBe('Implemented JWT auth flow');
    expect(row.importance).toBe(2);
    expect(row.minhash_sig).not.toBeNull();
    expect(JSON.parse(row.files_modified)).toEqual(['auth.mjs']);
    expect(JSON.parse(row.files_read)).toEqual(['config.mjs']);
    expect(row.text).toBe('auth jwt Uses RS256 signing');
  });

  it('drops a low-yield change obs at the choke-point (substantive-title band, imp<2, no lesson)', () => {
    // isLowYieldChangeObs targets change-rows with SUBSTANTIVE titles that isNoiseObservation
    // (title-pattern keyed) misses. It previously ran ONLY on the LLM-success path
    // (handleLLMEpisode:832); the pre-save write (buildImmediateObservation) bypassed it, so
    // on LLM-failure — which keeps the pre-saved row — these low-yield change rows survived.
    const obs = {
      type: 'change',
      title: 'Adjusted retry backoff in the API client',
      narrative: 'edited the client for the task',
      importance: 1,
      lessonLearned: null,
    };
    const id = saveObservation(obs, 'test', 'sess-1', db);
    expect(id).toBeNull();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) c FROM observations WHERE title = 'Adjusted retry backoff in the API client'",
        )
        .get().c,
    ).toBe(0);
  });

  it('keeps a change obs carrying a real lesson (gate is signal-gated, not a type blanket)', () => {
    const obs = {
      type: 'change',
      title: 'Switched to connection pooling',
      narrative: 'refactor',
      importance: 1,
      lessonLearned: 'pool size must exceed worker count or requests deadlock',
    };
    expect(saveObservation(obs, 'test', 'sess-1', db)).toBeGreaterThan(0);
  });

  it('keeps a change obs at importance>=2 (explicit signal overrides the low-yield gate)', () => {
    const obs = {
      type: 'change',
      title: 'Reworked the auth token refresh flow',
      narrative: 'change',
      importance: 2,
      lessonLearned: null,
    };
    expect(saveObservation(obs, 'test', 'sess-1', db)).toBeGreaterThan(0);
  });

  it('returns null for Tier 1 Jaccard dedup within 5 minutes', () => {
    const obs = { type: 'discovery', title: 'Fix login bug in auth module' };
    const id1 = saveObservation(obs, 'test', 'sess-1', db);
    expect(id1).toBeGreaterThan(0);

    const id2 = saveObservation(obs, 'test', 'sess-1', db);
    expect(id2).toBeNull();
  });

  it('returns null for Tier 2 MinHash dedup within 7 days', () => {
    const title = 'Implementing redis caching for database queries';
    const narrative = 'Added caching layer with TTL support and invalidation logic for the service';
    const sig = computeMinHash(title + ' ' + narrative);

    // Insert existing obs 6 min ago (outside Tier 1 5-min window, inside Tier 2 7-day window)
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, created_at, created_at_epoch)
      VALUES (?, ?, '', 'discovery', ?, '', ?, '', '', '[]', '[]', 1, ?, ?, ?)
    `,
    ).run('sess-1', 'test', title, narrative, sig, new Date(sixMinAgo).toISOString(), sixMinAgo);

    // Same content should be deduped by Tier 2
    const id = saveObservation({ type: 'discovery', title, narrative }, 'test', 'sess-1', db);
    expect(id).toBeNull();
  });

  it('auto-creates session if absent', () => {
    const id = saveObservation({ type: 'discovery', title: 'Test observation' }, 'test', 'new-session', db);
    expect(id).toBeGreaterThan(0);

    const session = db.prepare('SELECT * FROM sdk_sessions WHERE content_session_id = ?').get('new-session');
    expect(session).toBeDefined();
    expect(session.project).toBe('test');
    expect(session.status).toBe('active');
  });

  it('handles null concepts and facts arrays', () => {
    const id = saveObservation(
      { type: 'change', title: 'Null arrays test', concepts: null, facts: null, importance: 2 },
      'test',
      'sess-1',
      db,
    );
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row.concepts).toBe('');
    expect(row.facts).toBe('');
    expect(row.text).toBe('');
  });

  it('handles empty concepts and facts arrays', () => {
    const id = saveObservation(
      { type: 'change', title: 'Empty arrays test', concepts: [], facts: [], importance: 2 },
      'test',
      'sess-1',
      db,
    );
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row.concepts).toBe('');
    expect(row.facts).toBe('');
  });

  it('handles missing optional fields gracefully', () => {
    const id = saveObservation({ type: 'discovery', title: 'Minimal observation' }, 'test', 'sess-1', db);
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    expect(row.subtitle).toBe('');
    expect(row.narrative).toBe('');
    expect(JSON.parse(row.files_read)).toEqual([]);
    expect(JSON.parse(row.files_modified)).toEqual([]);
    expect(row.importance).toBe(1);
  });

  it('does not dedup across different projects', () => {
    const obs = { type: 'discovery', title: 'Fix login bug in auth module' };

    const id1 = saveObservation(obs, 'project-a', 'sess-1', db);
    expect(id1).toBeGreaterThan(0);

    const id2 = saveObservation(obs, 'project-b', 'sess-1', db);
    expect(id2).toBeGreaterThan(0);
  });

  it('returns null when DB is unavailable (no externalDb)', () => {
    openDb.mockReturnValue(null);
    const id = saveObservation({ type: 'discovery', title: 'Test' }, 'test', 'sess-1');
    expect(id).toBeNull();
  });

  it('includes CJK bigrams in text field for Chinese titles', () => {
    const id = saveObservation(
      { type: 'bugfix', title: '修复系统崩溃的问题', narrative: '通过重启服务解决' },
      'test',
      'sess-1',
      db,
    );
    expect(id).toBeGreaterThan(0);
    const row = db.prepare('SELECT text FROM observations WHERE id = ?').get(id);
    // text field should contain bigrams from title+narrative
    expect(row.text).toContain('修复');
    expect(row.text).toContain('系统');
    expect(row.text).toContain('崩溃');
  });

  it('does not add empty bigrams for English-only content', () => {
    const id = saveObservation(
      { type: 'feature', title: 'Add caching', concepts: ['cache'], facts: ['TTL 1h'] },
      'test',
      'sess-1',
      db,
    );
    const row = db.prepare('SELECT text FROM observations WHERE id = ?').get(id);
    expect(row.text).toBe('cache TTL 1h');
  });
});

// ─── handleLLMEpisode ────────────────────────────────────────────────────────

describe('handleLLMEpisode', () => {
  let db;
  let tmpFile;
  const filesToCleanup = [];
  const originalArgv3 = process.argv[3];

  beforeEach(() => {
    tmpFile = join(tmpdir(), `hook-llm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    filesToCleanup.push(tmpFile);
    process.argv[3] = tmpFile;
    process.env.CLAUDE_MEM_NO_DELAY = '1';

    db = createTestDb();
    // Prevent handleLLMEpisode from closing our test DB
    db._realClose = db.close;
    db.close = () => {};

    openDb.mockReturnValue(db);
    // v2.54.0: include lesson_learned in default mock so tests that assert
    // importance=2 pass under the lesson-cap rule (no-lesson feature/refactor/
    // bugfix is now demoted to imp=1). Tests that specifically exercise the
    // no-lesson path override this default with their own mock.
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'feature',
        title: 'Add user authentication',
        narrative: 'Implemented JWT-based auth flow',
        concepts: ['auth', 'jwt'],
        facts: ['Uses RS256 signing'],
        importance: 2,
        lesson_learned: 'JWT auth flow chose RS256 over HS256 for key rotation support',
      }),
    );
  });

  afterEach(() => {
    if (db?._realClose) db._realClose();
    process.argv[3] = originalArgv3;
    delete process.env.CLAUDE_MEM_NO_DELAY;
    while (filesToCleanup.length) {
      try {
        rmSync(filesToCleanup.pop(), { force: true });
      } catch {}
    }
    vi.clearAllMocks();
  });

  it('scrubs a secret that straddles the title/narrative truncation boundary', async () => {
    // Haiku occasionally regurgitates input verbatim. If a secret value lands
    // across the 120-char title (or 500-char narrative) cut, truncate-before-
    // scrub would leave a head the value-length-gated regex no longer matches.
    // Place the cut so only a 3-char head of the AWS value survives. The
    // assignment-keyword scrub needs a >=6-char value to fire, so a truncated
    // head slips past it — the exact leak the scrub-before-truncate fix closes.
    const titlePad = 'x'.repeat(93); // value head 'AKI' lands at char 116-118, inside the 120 cut
    const narrPad = 'y'.repeat(473); // same 3-char straddle against the 500-char narrative cut
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'feature',
        title: `${titlePad} AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE done`,
        narrative: `${narrPad} AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE done`,
        concepts: ['cfg'],
        facts: [],
        importance: 2,
        lesson_learned: 'Config rotation lesson with enough signal to persist as a feature observation row',
      }),
    );
    const episode = {
      sessionId: 'ep-sess',
      project: 'sec-boundary',
      files: ['config.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Rotate credentials', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    // 'feature' (like most LLM-extracted types except 'change') routes to the
    // events table; 'body' carries the narrative. Assert the scrubbed form on
    // whichever table the row landed in.
    const ev = db.prepare('SELECT title, body FROM events WHERE project = ?').get('sec-boundary');
    const obs = db.prepare('SELECT title, narrative FROM observations WHERE project = ?').get('sec-boundary');
    const row = ev ? { title: ev.title, narrative: ev.body } : obs;
    expect(row).toBeTruthy();
    // A credential key directly followed by an alphanumeric char = unscrubbed secret.
    expect(row.title).not.toMatch(/ACCESS_KEY=[A-Za-z0-9]/);
    expect(row.narrative || '').not.toMatch(/ACCESS_KEY=[A-Za-z0-9]/);
  });

  it('P3: bugfix with null lesson retries and merges substantive lesson', async () => {
    // First pass returns type='bugfix' but lesson_learned=null.
    // P3 retry fires and recovers a real lesson. Observation saved (to events
    // table since bugfix is EVENT_TYPE) carries the retry lesson.
    callLLM
      .mockReturnValueOnce(
        JSON.stringify({
          type: 'bugfix',
          title: 'Fixed FTS corruption on access_count UPDATE',
          narrative: 'Wrapped in try/catch to prevent cascade',
          concepts: ['fts5'],
          facts: ['observations_au trigger re-inserts FTS row on any UPDATE'],
          importance: 2,
          lesson_learned: 'none',
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          lesson:
            'FTS5 trigger fires on ANY column UPDATE including access_count — wrap writes in try/catch so SQLITE_CORRUPT_VTAB does not cascade.',
        }),
      );

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['schema.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Wrap FTS update in try/catch', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    // bugfix lands in events (EVENT_TYPE). Body carries the retry lesson.
    const ev = db.prepare(`SELECT * FROM events WHERE project = ?`).all('test-proj');
    expect(ev.length).toBe(1);
    expect(ev[0].event_type).toBe('bugfix');
    expect(ev[0].body).toContain('FTS5 trigger fires on ANY column UPDATE');
    // callLLM was called exactly twice (initial + retry)
    expect(callLLM.mock.calls.length).toBe(2);
  });

  it('P3: decision with null lesson retries', async () => {
    callLLM
      .mockReturnValueOnce(
        JSON.stringify({
          type: 'decision',
          title: 'Rejected schema migration for signal filter',
          narrative: 'Went with pure-data module + CI sync test instead',
          concepts: ['schema'],
          facts: [],
          importance: 2,
          lesson_learned: '',
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          lesson:
            'Before schema migration, measure drift points — 1 inline call site, not 4 — pure-data module avoids DB touch.',
        }),
      );

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['lib/low-signal.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Add isNoiseObservation helper', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const ev = db
      .prepare(`SELECT * FROM events WHERE project = ? AND event_type = ?`)
      .all('test-proj', 'decision');
    expect(ev.length).toBe(1);
    expect(ev[0].body).toContain('Before schema migration');
    expect(callLLM.mock.calls.length).toBe(2);
  });

  it('P3: change type does NOT trigger lesson retry (scoped to bugfix/decision)', async () => {
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        type: 'change',
        title: 'Refactored config loading',
        narrative: 'Extracted env parsing into loader',
        concepts: ['config'],
        facts: [],
        importance: 1,
        lesson_learned: 'none',
      }),
    );

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['config.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Refactor config', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    // Only 1 callLLM call — no retry for 'change'
    expect(callLLM.mock.calls.length).toBe(1);
  });

  it('P3: recovered bugfix lesson keeps full importance (not capped to 1)', async () => {
    // Regression: isLessonLowSignal was computed once from the FIRST pass and
    // never recomputed after the retry recovered a lesson, so a bugfix with a
    // recovered lesson was stored at importance=1, dropping it out of
    // --importance 2 searches and the working tier — negating the whole point
    // of the retry. Post-fix importance = max(ruleImportance, Haiku importance)
    // = max(1, 2) = 2 (the Haiku-rated "notable" flows through instead of cap).
    callLLM
      .mockReturnValueOnce(
        JSON.stringify({
          type: 'bugfix',
          title: 'Fix FTS corruption on access_count UPDATE',
          narrative: 'Wrapped in try/catch',
          concepts: ['fts5'],
          facts: ['au trigger re-inserts FTS row'],
          importance: 2,
          lesson_learned: 'none',
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          lesson:
            'FTS5 trigger fires on ANY column UPDATE including access_count — wrap writes in try/catch so SQLITE_CORRUPT_VTAB does not cascade.',
        }),
      );

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['schema.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Wrap FTS update', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const ev = db.prepare(`SELECT importance, body FROM events WHERE project = ?`).all('test-proj');
    expect(ev.length).toBe(1);
    expect(ev[0].body).toContain('FTS5 trigger fires on ANY column UPDATE');
    // Recovered lesson → importance NOT capped to 1; Haiku's 2 flows through.
    expect(ev[0].importance).toBe(2);
  });

  it('still caps importance to 1 when retry does NOT recover a lesson', async () => {
    // Counterpart to the above: when the retry also returns low-signal, the cap
    // must still fire so genuinely lesson-less bugfixes stay low-importance.
    callLLM
      .mockReturnValueOnce(
        JSON.stringify({
          type: 'bugfix',
          title: 'Touched schema file',
          narrative: 'n',
          concepts: ['x'],
          facts: ['y'],
          importance: 2,
          lesson_learned: 'none',
        }),
      )
      .mockReturnValueOnce(JSON.stringify({ lesson: 'none' }));

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['schema.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'edit', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const ev = db.prepare(`SELECT importance FROM events WHERE project = ?`).all('test-proj');
    expect(ev.length).toBe(1);
    expect(ev[0].importance).toBe(1);
  });

  it('v3.23: file-path heuristic caps at 2 — a schema edit Haiku rates low is not force-promoted to imp=3', async () => {
    // computeRuleImportance returns 3 for any entry touching schema./.env/.key; via Math.max
    // that force-promoted thin-lesson schema edits to "critical" imp=3 regardless of Haiku's
    // judgment (audit: auto imp=3 = 34.8%). The rule contribution is now capped at 2.
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        type: 'change', // not an EVENT_TYPE → lands in observations
        title: 'Adjusted schema column default',
        narrative: 'changed default, reran',
        concepts: ['schema'],
        facts: [],
        importance: 1, // Haiku judged it minor
        lesson_learned: 'a column default change still needs a backfill plan for existing rows',
      }),
    );
    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['schema.mjs'],
      filesRead: [],
      // entry.files (not episode.files) is what computeRuleImportance inspects → ruleImportance=3
      entries: [{ tool: 'Edit', desc: 'edit schema default', isError: false, files: ['schema.mjs'] }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obs = db.prepare(`SELECT importance FROM observations WHERE project = ?`).all('test-proj');
    expect(obs.length).toBe(1);
    expect(obs[0].importance).toBe(2); // rule 3 capped to 2; max(2, Haiku 1) = 2 (was 3 pre-fix)
  });

  it('does not crash and cleans up tmp file when episode.files is missing', async () => {
    // Regression: episode.files.map() / .join() threw on a malformed tmp file
    // lacking the `files` field, BEFORE any cleanup — leaking the tmp file,
    // which was then retried and crashed forever.
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        type: 'change',
        title: 'Some edit',
        narrative: 'n',
        concepts: ['x'],
        facts: ['y'],
        importance: 1,
        lesson_learned: 'A genuine lesson worth keeping for later sessions here.',
      }),
    );

    // Note: NO `files` key.
    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'edit something', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await expect(handleLLMEpisode()).resolves.not.toThrow();
    // tmp file must be cleaned up, not leaked.
    expect(existsSync(tmpFile)).toBe(false);
  });

  // v2.56.0 #1 paired-gate DROP. Catches Haiku-titled change obs with null
  // lesson + capped importance — the dominant noise band (16.5% hit-rate).
  // Pairs with capNoiseImportance demote (#8152). End-to-end assertion: obs
  // lands NOWHERE (not events, not observations), no upgrade, no insert.
  it('v2.56.0 #1: drops type=change with null lesson and importance=1 (no DB write)', async () => {
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        type: 'change',
        title: 'Refactored config loading helper',
        narrative: 'Extracted env parsing into a single loader function',
        concepts: ['config'],
        facts: [],
        importance: 1,
        lesson_learned: 'none',
      }),
    );

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['config.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Refactor config', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obsRows = db.prepare(`SELECT id FROM observations WHERE project = ?`).all('test-proj');
    expect(obsRows.length).toBe(0);
    const evRows = db.prepare(`SELECT id FROM events WHERE project = ?`).all('test-proj');
    expect(evRows.length).toBe(0);
  });

  it('v2.56.0 #1: deletes pre-saved obs when Haiku reclassifies as low-yield change', async () => {
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        type: 'change',
        title: 'Refactored config loading helper',
        narrative: 'Extracted env parsing into a single loader function',
        concepts: [],
        facts: [],
        importance: 1,
        lesson_learned: 'none',
      }),
    );

    // Pre-save a row to mimic the foreground rule-fallback insert.
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    const preSavedId = db
      .prepare(
        `
      INSERT INTO observations (memory_session_id, project, type, title, importance, created_at, created_at_epoch, narrative, concepts, facts, files_read, files_modified, text)
      VALUES (?, ?, 'change', 'Modified config.mjs', 1, ?, ?, '', '', '', '[]', '[]', '')
    `,
      )
      .run('ep-sess', 'test-proj', new Date().toISOString(), Date.now()).lastInsertRowid;

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      savedId: preSavedId,
      files: ['config.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Refactor config', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const stillExists = db.prepare(`SELECT id FROM observations WHERE id = ?`).get(preSavedId);
    expect(stillExists).toBeUndefined();
  });

  // ── FLOW-7 (2026-08-29 audit): the pre-saved row can stop being live mid-flight ──
  //
  // This worker runs 2-5s behind the foreground pre-save, and auto-dedup can supersede or
  // compress that row inside the window. Both upgrade paths addressed it by `id` alone:
  // the UPDATE reported changes=1 while writing the entire enrichment onto a tombstone
  // that liveObsFilterSql excludes from every read face, and the DELETE hard-removed a row
  // a keeper may have absorbed and children may point at through compressed_into.
  describe('FLOW-7: upgrade paths guard on the row still being live', () => {
    const CHANGE_ENRICHMENT = JSON.stringify({
      type: 'change',
      title: 'Enriched title from Haiku',
      narrative: 'Extracted env parsing into a single loader function',
      concepts: ['config'],
      facts: [],
      importance: 1,
      lesson_learned: 'BM25 rank is ascending in FTS5 — sorting DESC silently inverts relevance.',
    });

    /** Foreground rule-fallback insert, as the pre-save leaves it. */
    function preSave(title = 'Modified config.mjs') {
      insertSession(db, { id: 'ep-sess', project: 'test-proj' });
      return db
        .prepare(
          `
        INSERT INTO observations (memory_session_id, project, type, title, importance, created_at, created_at_epoch, narrative, concepts, facts, files_read, files_modified, text)
        VALUES (?, ?, 'change', ?, 1, ?, ?, '', '', '', '[]', '[]', '')
      `,
        )
        .run('ep-sess', 'test-proj', title, new Date().toISOString(), Date.now()).lastInsertRowid;
    }

    function runEpisode(preSavedId) {
      writeFileSync(
        tmpFile,
        JSON.stringify({
          sessionId: 'ep-sess',
          project: 'test-proj',
          savedId: preSavedId,
          files: ['config.mjs'],
          filesRead: [],
          entries: [{ tool: 'Edit', desc: 'Refactor config', isError: false }],
        }),
      );
      return handleLLMEpisode();
    }

    const titleOf = (id) => db.prepare('SELECT title FROM observations WHERE id = ?').get(id)?.title;

    it('CONTROL: a live pre-saved row is still upgraded in place', async () => {
      callLLM.mockReturnValueOnce(CHANGE_ENRICHMENT);
      const id = preSave();
      await runEpisode(id);
      // Without this, the guarded cases below could not tell "protected the tombstone"
      // apart from "the upgrade path stopped working".
      expect(titleOf(id)).toBe('Enriched title from Haiku');
      expect(db.prepare('SELECT COUNT(*) c FROM observations WHERE project = ?').get('test-proj').c).toBe(1);
    });

    it('does not write the enrichment onto a superseded row, and does not drop it either', async () => {
      callLLM.mockReturnValueOnce(CHANGE_ENRICHMENT);
      const id = preSave();
      db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(Date.now(), id);

      await runEpisode(id);

      expect(titleOf(id)).toBe('Modified config.mjs'); // tombstone untouched
      // The enrichment is not silently discarded — it lands on a fresh live row.
      const live = db
        .prepare('SELECT id, title FROM observations WHERE project = ? AND superseded_at IS NULL')
        .all('test-proj');
      expect(live.length).toBe(1);
      expect(live[0].id).not.toBe(id);
      expect(live[0].title).toBe('Enriched title from Haiku');
    });

    it('applies the same guard to a compressed pre-saved row', async () => {
      callLLM.mockReturnValueOnce(CHANGE_ENRICHMENT);
      const id = preSave();
      db.prepare('UPDATE observations SET compressed_into = -2 WHERE id = ?').run(id);

      await runEpisode(id);

      expect(titleOf(id)).toBe('Modified config.mjs');
      const live = db
        .prepare('SELECT id FROM observations WHERE project = ? AND COALESCE(compressed_into, 0) = 0')
        .all('test-proj');
      expect(live.length).toBe(1);
      expect(live[0].id).not.toBe(id);
    });

    it('upgrade-delete leaves a superseded pre-saved row in place and still writes the event', async () => {
      callLLM.mockReturnValueOnce(
        JSON.stringify({
          type: 'feature',
          title: 'Add user authentication',
          narrative: 'Implemented JWT-based auth flow',
          concepts: ['auth'],
          facts: [],
          importance: 2,
          lesson_learned: 'JWT auth flow chose RS256 over HS256 for key rotation support',
        }),
      );
      const id = preSave();
      db.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(Date.now(), id);

      await runEpisode(id);

      // Hard-deleting it would orphan anything the keeper's compression points at; the
      // maintenance path removes it properly (recoverChildrenOf first).
      expect(db.prepare('SELECT id FROM observations WHERE id = ?').get(id)).toBeTruthy();
      expect(db.prepare('SELECT COUNT(*) c FROM events WHERE project = ?').get('test-proj').c).toBe(1);
    });
  });

  it('v2.56.0 #1: KEEPS type=change with substantive lesson', async () => {
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        type: 'change',
        title: 'Updated FTS5 query in scoring-sql',
        narrative: 'Switched from hand-built MATCH to sanitizeFtsQuery helper',
        concepts: ['fts5'],
        facts: [],
        importance: 1,
        lesson_learned: 'BM25 score sign flipped — lower is better in SQLite FTS5; rank ASC, not DESC.',
      }),
    );

    insertSession(db, { id: 'ep-sess', project: 'test-proj' });

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['scoring-sql.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Update query', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obsRows = db
      .prepare(`SELECT title, lesson_learned FROM observations WHERE project = ?`)
      .all('test-proj');
    expect(obsRows.length).toBe(1);
    expect(obsRows[0].lesson_learned).toContain('BM25 score sign flipped');
  });

  it('v2.56.0 #1 opt-out: CLAUDE_MEM_KEEP_LOW_SIGNAL=1 disables drop', async () => {
    vi.stubEnv('CLAUDE_MEM_KEEP_LOW_SIGNAL', '1');
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        type: 'change',
        title: 'Refactored config loading helper',
        narrative: 'Extracted env parsing into a single loader function',
        concepts: [],
        facts: [],
        importance: 1,
        lesson_learned: 'none',
      }),
    );

    insertSession(db, { id: 'ep-sess', project: 'test-proj' });

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['config.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Refactor config', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obsRows = db.prepare(`SELECT id FROM observations WHERE project = ?`).all('test-proj');
    expect(obsRows.length).toBe(1);
  });

  it('P3 opt-out: CLAUDE_MEM_NO_LESSON_RETRY=1 skips retry for bugfix', async () => {
    vi.stubEnv('CLAUDE_MEM_NO_LESSON_RETRY', '1');
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        type: 'bugfix',
        title: 'Fixed something',
        narrative: 'Fixed it',
        concepts: [],
        facts: [],
        importance: 2,
        lesson_learned: 'none',
      }),
    );

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['x.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Fix x.mjs', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    try {
      await handleLLMEpisode();
      expect(callLLM.mock.calls.length).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('P3: retry returning "none" leaves lesson null (no false promotion)', async () => {
    callLLM
      .mockReturnValueOnce(
        JSON.stringify({
          type: 'bugfix',
          title: 'Routine fix',
          narrative: 'Mechanical fix',
          concepts: [],
          facts: [],
          importance: 2,
          lesson_learned: 'none',
        }),
      )
      .mockReturnValueOnce(JSON.stringify({ lesson: 'none' }));

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['y.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Mechanical fix', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const ev = db
      .prepare(`SELECT * FROM events WHERE project = ? AND event_type = ?`)
      .all('test-proj', 'bugfix');
    expect(ev.length).toBe(1);
    // Retry "none" must NOT be promoted to lesson. persistHaikuSummary.body falls
    // back to narrative when lesson_learned is null — verify body is the narrative.
    expect(ev[0].body).toBe('Mechanical fix');
    expect(ev[0].body).not.toContain('none');
    expect(callLLM.mock.calls.length).toBe(2);
  });

  it('P1: Haiku prompt contains decision-type trigger examples (single-entry)', async () => {
    // v2.36 P1: ensure decision classification guidance reaches the LLM. The
    // trigger string is a prompt-level addition, so the test captures what was
    // actually sent to callLLM and checks the guidance survived.
    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['auth.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Add JWT middleware', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const calls = callLLM.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastPrompt = promptText(calls[calls.length - 1][0]);
    expect(lastPrompt).toContain('decision = explicit tradeoff');
    expect(lastPrompt).toContain('chose X over Y because Z');
  });

  it('P1: Haiku prompt contains decision-type trigger examples (multi-entry)', async () => {
    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['auth.mjs'],
      filesRead: [],
      entries: [
        { tool: 'Edit', desc: 'Add JWT middleware', isError: false },
        { tool: 'Edit', desc: 'Update config loader', isError: false },
      ],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const calls = callLLM.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastPrompt = promptText(calls[calls.length - 1][0]);
    expect(lastPrompt).toContain('decision = explicit tradeoff');
    expect(lastPrompt).toContain('bugfix = prior-failing path');
  });

  it('audit-fix: lesson_learned prompt does not recommend "none" string output (single-entry)', async () => {
    // Audit finding: previous prompt "non-obvious insight or 'none' if routine"
    // taught Haiku to write 'none' as a fallback, then downstream lowSignalLesson
    // gate rejected 'none' as noise — prompt fighting its own gates. Per cite-recall
    // baseline 67% of `change` obs were dropped post-Haiku. Regression guard: prompt
    // must (a) not present 'none' as a valid output, (b) tell model to use JSON null
    // for the no-insight case, (c) explicitly forbid the noise tokens.
    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['auth.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Bump version', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const calls = callLLM.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastPrompt = promptText(calls[calls.length - 1][0]);
    expect(lastPrompt).not.toMatch(/['"]none['"]\s+if\s+routine/i);
    expect(lastPrompt).not.toMatch(/write\s+['"]none['"]/i);
    expect(lastPrompt).toContain('output JSON null');
    expect(lastPrompt).toMatch(/Do NOT invent a lesson/i);
  });

  it('audit-fix: lesson_learned prompt does not recommend "none" string output (multi-entry)', async () => {
    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['auth.mjs'],
      filesRead: [],
      entries: [
        { tool: 'Edit', desc: 'Bump version', isError: false },
        { tool: 'Edit', desc: 'Update lock file', isError: false },
      ],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const calls = callLLM.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastPrompt = promptText(calls[calls.length - 1][0]);
    expect(lastPrompt).not.toMatch(/['"]none['"]\s+if\s+routine/i);
    expect(lastPrompt).not.toMatch(/write\s+['"]none['"]/i);
    expect(lastPrompt).toContain('output JSON null');
  });

  it('extracts and saves event from single-entry episode (feature type → events table)', async () => {
    // Default mock returns type='feature' → EVENT_TYPE → routes to events.
    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['auth.mjs'],
      filesRead: ['config.mjs'],
      entries: [{ tool: 'Edit', desc: 'Add JWT middleware', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    // Feature-typed Haiku summary lands in `events`, not `observations`.
    const obs = db.prepare('SELECT * FROM observations').all();
    expect(obs.length).toBe(0);
    const ev = db.prepare(`SELECT * FROM events WHERE project = ?`).all('test-proj');
    expect(ev.length).toBe(1);
    expect(ev[0].title).toBe('Add user authentication');
    expect(ev[0].event_type).toBe('feature');
    expect(ev[0].importance).toBe(2);
    expect(JSON.parse(ev[0].file_paths)).toEqual(['auth.mjs']);
  });

  it('extracts event from multi-entry episode (feature type)', async () => {
    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['auth.mjs', 'config.mjs'],
      filesRead: [],
      entries: [
        { tool: 'Edit', desc: 'Add JWT middleware', isError: false },
        { tool: 'Bash', desc: 'npm test', isError: true },
        { tool: 'Edit', desc: 'Fix test assertion', isError: false },
      ],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    // Feature-typed Haiku summary lands in `events`, not `observations`.
    const obs = db.prepare('SELECT * FROM observations').all();
    expect(obs.length).toBe(0);
    const ev = db.prepare(`SELECT * FROM events WHERE project = ?`).all('test-proj');
    expect(ev.length).toBe(1);
  });

  it('P0: degraded fallback drops pure-noise episode (LOW_SIGNAL title + no signal)', async () => {
    // v2.36: P0 write-side filter blocks low-signal pre-save/fallback inserts.
    // A bare Edit episode produces "Modified app.mjs" (LOW_SIGNAL) with no facts
    // and no lesson — isNoiseObservation() drops it before saveObservation inserts.
    acquireLLMSlot.mockResolvedValueOnce(false);

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['app.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Update configuration', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
    expect(obs.length).toBe(0);
  });

  it('P0 opt-out: CLAUDE_MEM_KEEP_LOW_SIGNAL=1 preserves pre-v2.36 fallback save', async () => {
    vi.stubEnv('CLAUDE_MEM_KEEP_LOW_SIGNAL', '1');
    acquireLLMSlot.mockResolvedValueOnce(false);

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['app.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Update configuration', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    try {
      await handleLLMEpisode();
      const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
      expect(obs.length).toBe(1);
      expect(obs[0].title).toBe('Modified app.mjs');
      expect(obs[0].type).toBe('change');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('infers bugfix type in fallback when entry has error (routes to events)', async () => {
    // Fallback path with error → buildImmediateObservation infers type='bugfix',
    // which is an EVENT_TYPE → dispatcher routes to `events`, not `observations`.
    acquireLLMSlot.mockResolvedValueOnce(false);

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['app.mjs'],
      filesRead: [],
      entries: [{ tool: 'Bash', desc: 'npm test failed', isError: true }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    expect(db.prepare(`SELECT COUNT(*) c FROM observations WHERE type='bugfix'`).get().c).toBe(0);
    const ev = db.prepare(`SELECT * FROM events WHERE event_type='bugfix' AND project = ?`).all('test-proj');
    expect(ev.length).toBe(1);
    // buildDegradedTitle: file + error → "Error: app.mjs"
    expect(ev[0].title).toBe('Error: app.mjs');
  });

  // ─── Bad-title / envelope recovery: Haiku's lesson must survive ───────────
  // A valid extraction whose `title` is empty/non-string, or whose object is
  // wrapped in a single-element array / single object-valued key, previously
  // failed the `typeof parsed.title === 'string' && parsed.title` gate → the
  // whole enrichment block was skipped and the lesson was discarded. Recovery
  // degrades ONLY the title and keeps the lesson.
  const lessonSurvives = (project, needle) => {
    const obs = db.prepare('SELECT lesson_learned FROM observations WHERE project = ?').all(project);
    const ev = db.prepare('SELECT body FROM events WHERE project = ?').all(project);
    return (
      obs.some((r) => (r.lesson_learned || '').includes(needle)) ||
      ev.some((r) => (r.body || '').includes(needle))
    );
  };

  it('empty-string title: lesson survives on the pre-saved row (change → upgraded in place)', async () => {
    const needle = 'config loader must read env before defaults or overrides are ignored';
    insertSession(db, { id: 'ep-sess', project: 'badtitle-empty' });
    const preSaved = db
      .prepare(
        `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', 'Modified config.mjs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
      )
      .run('ep-sess', 'badtitle-empty', new Date().toISOString(), Date.now());
    const savedId = Number(preSaved.lastInsertRowid);

    callLLM.mockReturnValue(
      JSON.stringify({ type: 'change', title: '', importance: 1, lesson_learned: needle }),
    );
    const episode = {
      sessionId: 'ep-sess',
      project: 'badtitle-empty',
      savedId,
      files: ['config.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Edit config', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const row = db.prepare('SELECT lesson_learned FROM observations WHERE id = ?').get(savedId);
    expect(row.lesson_learned).toBe(needle); // was NULL (pre-saved row kept lessonless) before the fix
  });

  it('array-wrapped [{...}]: lesson survives (bugfix → events)', async () => {
    const needle = 'FTS5 trigger fires on ANY column UPDATE — wrap access_count writes in try/catch';
    insertSession(db, { id: 'ep-sess', project: 'badtitle-array' });
    const preSaved = db
      .prepare(
        `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', 'Modified schema.mjs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
      )
      .run('ep-sess', 'badtitle-array', new Date().toISOString(), Date.now());
    const savedId = Number(preSaved.lastInsertRowid);

    callLLM.mockReturnValue(
      JSON.stringify([
        {
          type: 'bugfix',
          title: 'Fixed FTS corruption on access_count UPDATE',
          importance: 2,
          lesson_learned: needle,
        },
      ]),
    );
    const episode = {
      sessionId: 'ep-sess',
      project: 'badtitle-array',
      savedId,
      files: ['schema.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Wrap FTS update in try/catch', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    expect(lessonSurvives('badtitle-array', needle)).toBe(true); // no events row existed before the fix
  });

  it('key-wrapped {"observation":{...}}: lesson survives on a clean insert (no pre-save)', async () => {
    const needle = 'env loader must read process.env before applying config defaults';
    callLLM.mockReturnValue(
      JSON.stringify({
        observation: {
          type: 'change',
          title: 'Reworked env loader',
          importance: 1,
          lesson_learned: needle,
        },
      }),
    );
    const episode = {
      sessionId: 'ep-sess',
      project: 'badtitle-keywrap',
      files: ['env.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'edit env loader', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    expect(lessonSurvives('badtitle-keywrap', needle)).toBe(true); // buildImmediateObservation fallback dropped the lesson before the fix
  });

  it('importance=0 + substantive lesson: row is kept, not deleted (Finding 3)', async () => {
    const needle = 'connection pool size must exceed worker count or requests deadlock';
    insertSession(db, { id: 'ep-sess', project: 'imp0-lesson' });
    const preSaved = db
      .prepare(
        `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', 'Modified pool.mjs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
      )
      .run('ep-sess', 'imp0-lesson', new Date().toISOString(), Date.now());
    const savedId = Number(preSaved.lastInsertRowid);

    // Valid title (isolates Finding 3 from the title-recovery path) + importance 0 + a real lesson.
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Reworked connection pooling',
        importance: 0,
        lesson_learned: needle,
      }),
    );
    const episode = {
      sessionId: 'ep-sess',
      project: 'imp0-lesson',
      savedId,
      files: ['pool.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'switch to pooling', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const row = db.prepare('SELECT lesson_learned FROM observations WHERE id = ?').get(savedId);
    expect(row).toBeTruthy(); // pre-saved row was DELETED by the importance=0 discard before the fix
    expect(row.lesson_learned).toBe(needle);
  });

  it('importance=0 + no substantive lesson still discards the pre-saved row (behavior preserved)', async () => {
    insertSession(db, { id: 'ep-sess', project: 'imp0-nolesson' });
    const preSaved = db
      .prepare(
        `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', 'Modified notes.mjs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
      )
      .run('ep-sess', 'imp0-nolesson', new Date().toISOString(), Date.now());
    const savedId = Number(preSaved.lastInsertRowid);

    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Browsed the notes file',
        importance: 0,
        lesson_learned: 'none',
      }),
    );
    const episode = {
      sessionId: 'ep-sess',
      project: 'imp0-nolesson',
      savedId,
      files: ['notes.mjs'],
      filesRead: [],
      entries: [{ tool: 'Read', desc: 'read notes', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    expect(db.prepare('SELECT 1 FROM observations WHERE id = ?').get(savedId)).toBeFalsy();
  });

  // v2.44+: buildImmediateObservation cap logic. computeRuleImportance uses
  // coarse file-name heuristics (schema.*, migration, auth.*, .env, .pem)
  // that fire on incidental file touches in broad multi-file episodes. For
  // LOW_SIGNAL titles (Haiku couldn't extract meaning) or auto-generated
  // review titles, we can't distinguish "critical file was primary focus"
  // from "one of N files read" — cap importance at 2 even when rule=3.
  // Production baseline (2026-04-23): 34/100 discovery/imp=3 obs had
  // LOW_SIGNAL titles with this leak; fix closes that path.
  describe('buildImmediateObservation importance cap', () => {
    it('caps isReviewPattern importance at 2 even when rule says 3', () => {
      // 5+ Read tools without edits/errors → isReviewPattern=true.
      // schema.js file → computeRuleImportance returns 3.
      // Prior: Math.max(2, 3) = 3 → leaked as imp=3.
      // New: cap at 2 regardless of rule.
      const episode = {
        entries: Array.from({ length: 5 }, (_, i) => ({
          tool: 'Read',
          files: [`/src/file${i}.js`],
          bashSig: null,
        })),
        files: ['/src/file0.js', '/src/schema.js', '/src/file2.js', '/src/file3.js', '/src/file4.js'],
        filesRead: ['/src/file0.js', '/src/schema.js'],
      };
      const obs = buildImmediateObservation(episode);
      expect(obs.title).toMatch(/^Reviewed \d+ files:/);
      expect(obs.importance).toBe(2);
    });

    it('caps LOW_SIGNAL title with rule=3 at importance 2', () => {
      // Edit on schema.* triggers rule=3 but title is "Modified schema.js"
      // (LOW_SIGNAL). Prior: else branch set imp=3. New: cap at 2.
      const episode = {
        entries: [{ tool: 'Edit', files: ['/src/schema.js'], bashSig: null }],
        files: ['/src/schema.js'],
        filesRead: [],
      };
      const obs = buildImmediateObservation(episode);
      // buildDegradedTitle produces "Modified schema.js" — LOW_SIGNAL
      expect(obs.importance).toBe(2);
    });

    it('keeps LOW_SIGNAL title with rule<=2 at importance 1 (cap preserved)', () => {
      // Edit on non-critical file → rule=1, title LOW_SIGNAL. Stays at 1.
      const episode = {
        entries: [{ tool: 'Edit', files: ['/src/app.mjs'], bashSig: null }],
        files: ['/src/app.mjs'],
        filesRead: [],
      };
      const obs = buildImmediateObservation(episode);
      expect(obs.importance).toBe(1);
    });

    it('preserves non-LOW_SIGNAL rule=3 at importance 3', () => {
      // This path isn't directly reachable via buildImmediateObservation
      // (which always produces degraded titles), but exercises the else
      // branch contract: non-LOW_SIGNAL + rule=3 → 3. The Haiku path
      // invokes the same cap logic via persistHaikuSummary isLowSignal
      // check — Haiku-generated titles typically clear LOW_SIGNAL.
      const episode = {
        entries: [
          {
            tool: 'Bash',
            files: [],
            bashSig: { isError: true, isTest: true, isBuild: false, isGit: false, isDeploy: false },
          },
        ],
        files: [],
        filesRead: [],
      };
      const obs = buildImmediateObservation(episode);
      // Degraded title for error → "Error: <file>" or similar — LOW_SIGNAL
      // so hits the isLowSignal branch → rule=3 → cap to 2. Verifies cap
      // also applies when rule=3 from error-signature path, not just files.
      expect(obs.importance).toBe(2);
    });
  });

  it('returns early when no tmpFile specified', async () => {
    process.argv[3] = undefined;
    await handleLLMEpisode();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('returns early when episode has no entries', async () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({
        sessionId: 'ep-sess',
        project: 'test-proj',
        files: [],
        filesRead: [],
        entries: [],
      }),
    );

    await handleLLMEpisode();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('returns early for invalid JSON in tmpFile', async () => {
    writeFileSync(tmpFile, 'not valid json {{{');

    await handleLLMEpisode();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('links related observations by FTS5 title match', async () => {
    // Linking only applies to rows in `observations` — use type='change' (not an
    // EVENT_TYPE) so both the seed and the new row land in observations.
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', ?, '', 'Previous auth work', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run('ep-sess', 'test-proj', 'Authentication middleware setup', new Date().toISOString(), Date.now());

    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Add authentication validation layer',
        narrative: 'Extended authentication with validation',
        concepts: ['auth'],
        facts: [],
        importance: 1,
        // v2.56.0 #1: substantive lesson required to bypass paired-DROP gate
        // for type=change + null lesson + imp<2. The test exercises link logic,
        // not the gate; mock a real lesson so the obs is saved.
        lesson_learned:
          'Authentication middleware must guard validation layer before route handlers — order matters.',
      }),
    );

    writeFileSync(
      tmpFile,
      JSON.stringify({
        sessionId: 'ep-sess',
        project: 'test-proj',
        files: ['auth.mjs'],
        filesRead: [],
        entries: [{ tool: 'Edit', desc: 'Add auth check', isError: false }],
      }),
    );

    await handleLLMEpisode();

    const allObs = db.prepare('SELECT id, related_ids FROM observations ORDER BY id').all();
    expect(allObs.length).toBe(2);

    const firstRelated = JSON.parse(allObs[0].related_ids || '[]');
    const secondRelated = JSON.parse(allObs[1].related_ids || '[]');
    const hasBidirectional = firstRelated.includes(allObs[1].id) && secondRelated.includes(allObs[0].id);
    expect(hasBidirectional).toBe(true);
  });

  it('links related observations by file overlap', async () => {
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', ?, '', '', '', '', '[]', ?, 1, ?, ?)
    `,
    ).run(
      'ep-sess',
      'test-proj',
      'Previous edit to shared file',
      '["shared.mjs"]',
      new Date().toISOString(),
      Date.now(),
    );

    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Completely different title here',
        narrative: 'Unrelated narrative text',
        concepts: [],
        facts: [],
        importance: 1,
        // v2.56.0 #1: bypass paired-DROP gate (see "links related observations by FTS5 title match" comment)
        lesson_learned:
          'Shared module edits must update consumer call sites in the same change to keep type contract aligned.',
      }),
    );

    writeFileSync(
      tmpFile,
      JSON.stringify({
        sessionId: 'ep-sess',
        project: 'test-proj',
        files: ['shared.mjs'],
        filesRead: [],
        entries: [{ tool: 'Edit', desc: 'Update shared module', isError: false }],
      }),
    );

    await handleLLMEpisode();

    const allObs = db.prepare('SELECT id, related_ids FROM observations ORDER BY id').all();
    expect(allObs.length).toBe(2);

    const firstRelated = JSON.parse(allObs[0].related_ids || '[]');
    const secondRelated = JSON.parse(allObs[1].related_ids || '[]');
    const hasLink = firstRelated.includes(allObs[1].id) || secondRelated.includes(allObs[0].id);
    expect(hasLink).toBe(true);
  });

  it('caps related_ids at 5', async () => {
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });

    for (let i = 0; i < 7; i++) {
      db.prepare(
        `
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, ?, '', 'change', ?, '', '', '', '', '[]', ?, 1, ?, ?)
      `,
      ).run(
        'ep-sess',
        'test-proj',
        `Performance optimization step ${i}`,
        '["perf.mjs"]',
        new Date().toISOString(),
        Date.now() + i,
      );
    }

    // Use type='change' (non-EVENT_TYPE) so the new row lands in `observations`
    // and `linkRelatedObservations` runs — the cap-at-5 contract is an
    // observations-linking concern.
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Final performance optimization pass',
        narrative: 'Completed performance optimization work',
        concepts: ['optimization'],
        facts: [],
        importance: 1,
        // v2.56.0 #1: bypass paired-DROP gate
        lesson_learned:
          'Bulk perf passes must respect related_ids cap=5 so historic linkage does not unbounded-grow.',
      }),
    );

    writeFileSync(
      tmpFile,
      JSON.stringify({
        sessionId: 'ep-sess',
        project: 'test-proj',
        files: ['perf.mjs'],
        filesRead: [],
        entries: [{ tool: 'Edit', desc: 'Optimize perf.mjs', isError: false }],
      }),
    );

    await handleLLMEpisode();

    const newObs = db.prepare('SELECT related_ids FROM observations ORDER BY id DESC LIMIT 1').get();
    const relatedIds = JSON.parse(newObs.related_ids || '[]');
    expect(relatedIds.length).toBeLessThanOrEqual(5);
  });

  it('upgrade-delete: pre-saved observation replaced by event when Haiku classifies as EVENT_TYPE', async () => {
    // Pre-save a rule-based observation (simulating what flushEpisode does).
    // Default mock returns type='feature' → EVENT_TYPE → pre-saved observations
    // row must be DELETED and a fresh event inserted.
    // v2.36 P0: pre-save uses importance=2 to simulate a rule-signal episode
    // (e.g. error-in-test / config-change) so isNoiseObservation does NOT block.
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    const preSavedId = saveObservation(
      { type: 'change', title: 'Modified auth.mjs', narrative: 'Edit auth.mjs', importance: 2 },
      'test-proj',
      'ep-sess',
      db,
    );
    expect(preSavedId).toBeGreaterThan(0);

    writeFileSync(
      tmpFile,
      JSON.stringify({
        sessionId: 'ep-sess',
        project: 'test-proj',
        savedId: preSavedId,
        files: ['auth.mjs'],
        filesRead: ['config.mjs'],
        entries: [{ tool: 'Edit', desc: 'Add JWT middleware', isError: false }],
      }),
    );

    await handleLLMEpisode();

    // Pre-saved observations row is gone.
    const deleted = db.prepare('SELECT * FROM observations WHERE id = ?').get(preSavedId);
    expect(deleted).toBeUndefined();
    // No other observations for this session either.
    const allObs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
    expect(allObs.length).toBe(0);

    // A fresh event exists with the LLM-enriched fields.
    const evs = db.prepare(`SELECT * FROM events WHERE project = ?`).all('test-proj');
    expect(evs.length).toBe(1);
    expect(evs[0].title).toBe('Add user authentication');
    expect(evs[0].event_type).toBe('feature');
    expect(evs[0].importance).toBe(2);
    expect(JSON.parse(evs[0].file_paths)).toEqual(['auth.mjs']);
  });

  it('upgrade-in-place: pre-saved observation stays in observations when Haiku classifies as non-EVENT_TYPE', async () => {
    // Pre-save a rule-based observation, LLM classifies as 'change' (not an
    // EVENT_TYPE) → UPDATE existing observations row, do not touch events.
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Refactored config loading',
        narrative: 'Extracted env parsing into loader module',
        concepts: ['config'],
        facts: [],
        importance: 2,
        // v2.33.1: supply a real lesson so the low-signal downgrade doesn't trip.
        // Without this, type='change' + missing lesson → importance capped at 1.
        lesson_learned: 'Loader extraction clarifies config-path resolution order.',
      }),
    );

    // v2.36 P0: importance=2 bypasses isNoiseObservation so pre-save lands.
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    const preSavedId = saveObservation(
      { type: 'change', title: 'Modified config.mjs', narrative: 'Edit config', importance: 2 },
      'test-proj',
      'ep-sess',
      db,
    );
    expect(preSavedId).toBeGreaterThan(0);

    writeFileSync(
      tmpFile,
      JSON.stringify({
        sessionId: 'ep-sess',
        project: 'test-proj',
        savedId: preSavedId,
        files: ['config.mjs'],
        filesRead: [],
        entries: [{ tool: 'Edit', desc: 'Refactor config', isError: false }],
      }),
    );

    await handleLLMEpisode();

    // Same row, enriched.
    const allObs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
    expect(allObs.length).toBe(1);
    expect(allObs[0].id).toBe(preSavedId);
    expect(allObs[0].title).toBe('Refactored config loading');
    expect(allObs[0].type).toBe('change');
    expect(allObs[0].importance).toBe(2);
    // No events written.
    expect(db.prepare(`SELECT COUNT(*) c FROM events`).get().c).toBe(0);
  });

  it('keeps pre-saved observation when LLM fails and savedId present', async () => {
    acquireLLMSlot.mockResolvedValueOnce(false);

    // v2.36 P0: importance=2 bypasses isNoiseObservation so pre-save lands.
    // v2.47 P0-3: capNoiseImportance now demotes LOW_SIGNAL+no-signal imp=2
    // down to 1 at write time. Attach a lesson so the cap is bypassed and
    // importance=2 survives (the pre-save scenario the test exercises).
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    const preSavedId = saveObservation(
      {
        type: 'change',
        title: 'Modified app.mjs',
        narrative: 'Quick edit',
        importance: 2,
        lessonLearned: 'Quick edit landed; background LLM fills the enriched fields later.',
      },
      'test-proj',
      'ep-sess',
      db,
    );

    writeFileSync(
      tmpFile,
      JSON.stringify({
        sessionId: 'ep-sess',
        project: 'test-proj',
        savedId: preSavedId,
        files: ['app.mjs'],
        filesRead: [],
        entries: [{ tool: 'Edit', desc: 'Update app', isError: false }],
      }),
    );

    await handleLLMEpisode();

    // Pre-saved observation should remain unchanged
    const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(preSavedId);
    expect(obs.title).toBe('Modified app.mjs');
    expect(obs.importance).toBe(2);

    // No duplicate observations
    const allObs = db
      .prepare('SELECT COUNT(*) as c FROM observations WHERE memory_session_id = ?')
      .get('ep-sess');
    expect(allObs.c).toBe(1);
  });

  it('handleLLMEpisode routes bugfix Haiku summary to events, not observations (T9)', async () => {
    // Full wired-path integration: LLM returns bugfix, handleLLMEpisode must
    // dispatch through persistHaikuSummary, landing in `events`.
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'bugfix',
        title: 'fixed null deref in session init',
        narrative: 'session file was created without atomic rename causing TOCTOU',
        concepts: ['race-condition'],
        facts: [],
        importance: 2,
        lesson_learned: 'Always use atomic write (tmp+rename) for concurrent file access',
        search_aliases: ['TOCTOU', 'file race'],
      }),
    );

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['session.mjs'],
      filesRead: [],
      entries: [{ tool: 'Edit', desc: 'Add atomic rename to session init', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    expect(db.prepare(`SELECT COUNT(*) c FROM observations WHERE type='bugfix'`).get().c).toBe(0);
    const ev = db.prepare(`SELECT * FROM events WHERE event_type='bugfix' AND project = ?`).get('test-proj');
    expect(ev).toBeDefined();
    expect(ev.title).toBe('fixed null deref in session init');
    expect(ev.body).toBe('Always use atomic write (tmp+rename) for concurrent file access');
    expect(JSON.parse(ev.file_paths)).toEqual(['session.mjs']);
    expect(ev.importance).toBe(2);
  });

  it('discards observation when LLM returns importance=0', async () => {
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'discovery',
        title: 'Browsed some files',
        narrative: 'Just looking around',
        concepts: [],
        facts: [],
        importance: 0,
      }),
    );

    const episode = {
      sessionId: 'ep-sess',
      project: 'test-proj',
      files: ['readme.md'],
      filesRead: ['readme.md'],
      entries: [{ tool: 'Read', desc: 'Read readme.md', isError: false }],
    };
    writeFileSync(tmpFile, JSON.stringify(episode));

    await handleLLMEpisode();

    const obs = db.prepare('SELECT * FROM observations WHERE memory_session_id = ?').all('ep-sess');
    expect(obs.length).toBe(0);
  });

  it('discards and deletes pre-saved observation when LLM returns importance=0', async () => {
    insertSession(db, { id: 'ep-sess', project: 'test-proj' });
    const preSavedId = saveObservation(
      { type: 'discovery', title: 'Read readme.md', narrative: 'Browsing', importance: 1 },
      'test-proj',
      'ep-sess',
      db,
    );
    expect(preSavedId).toBeGreaterThan(0);

    // The discard path calls openDb() to get a DB handle for deleting the pre-saved obs.
    // We return a wrapper around our test db that tracks close() but doesn't actually close.
    // `{ ...db }` copies OWN properties only, and better-sqlite3's API lives on the
    // prototype — so every method this proxy is expected to forward has to be re-bound by
    // hand. `prepare` always was; `transaction` was not, and the proxy therefore modelled a
    // handle that cannot open one. That is a defect in the double, not a constraint on the
    // code: the real callers pass a real handle, and `retractPreSavedObs` needs a
    // transaction so recover-then-delete cannot be interrupted half-done.
    const deleteDbProxy = {
      ...db,
      close: vi.fn(),
      prepare: (...a) => db.prepare(...a),
      transaction: (...a) => db.transaction(...a),
    };
    openDb.mockReturnValueOnce(deleteDbProxy);

    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'discovery',
        title: 'Read readme.md',
        narrative: 'Browsing',
        concepts: [],
        facts: [],
        importance: 0,
      }),
    );

    writeFileSync(
      tmpFile,
      JSON.stringify({
        sessionId: 'ep-sess',
        project: 'test-proj',
        savedId: preSavedId,
        files: ['readme.md'],
        filesRead: ['readme.md'],
        entries: [{ tool: 'Read', desc: 'Read readme.md', isError: false }],
      }),
    );

    await handleLLMEpisode();

    // The pre-saved observation should be deleted
    const deleted = db.prepare('SELECT * FROM observations WHERE id = ?').get(preSavedId);
    expect(deleted).toBeUndefined();
    // The delete DB handle should have been closed
    expect(deleteDbProxy.close).toHaveBeenCalled();
  });
});

// ─── handleLLMSummary ────────────────────────────────────────────────────────

describe('handleLLMSummary', () => {
  let db;
  const originalArgv3 = process.argv[3];
  const originalArgv4 = process.argv[4];

  beforeEach(() => {
    process.argv[3] = 'test-session';
    process.argv[4] = 'test-proj';
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = '0';

    db = createTestDb();
    db._realClose = db.close;
    db.close = () => {};

    openDb.mockReturnValue(db);
    callLLM.mockReturnValue(
      JSON.stringify({
        request: 'Implementing auth system',
        investigated: 'JWT vs session tokens',
        learned: 'JWT is stateless and scalable',
        completed: 'Basic auth flow with login/logout',
        next_steps: 'Add refresh token rotation',
      }),
    );
  });

  afterEach(() => {
    if (db?._realClose) db._realClose();
    process.argv[3] = originalArgv3;
    process.argv[4] = originalArgv4;
    delete process.env.CLAUDE_MEM_FLUSH_TIMEOUT;
    vi.clearAllMocks();
  });

  it('creates session summary from observations', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, ?, '', 'feature', ?, '', 'Narrative text', '', '', '[]', '[]', 1, ?, ?)
      `,
      ).run('test-session', 'test-proj', `Observation ${i}`, new Date().toISOString(), Date.now() + i);
    }

    await handleLLMSummary();

    const summaries = db
      .prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?')
      .all('test-session');
    expect(summaries.length).toBe(1);
    expect(summaries[0].request).toBe('Implementing auth system');
    expect(summaries[0].completed).toBe('Basic auth flow with login/logout');
    expect(summaries[0].next_steps).toBe('Add refresh token rotation');
  });

  it('preserves structural extractor content when Haiku returns empty for a field', async () => {
    // Regression: the fast-baseline write now pre-populates remaining_items from
    // CLAUDE.md §10 Done/Not done markers in the tail assistant message. A later
    // Haiku pass that returns empty remaining_items must NOT clobber that floor.
    insertSession(db, { id: 'test-session', project: 'test-proj' });
    db.prepare(
      `
      INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, 'first prompt', '', '', 'structured-done', '', 'structured-notdone: Gap #3 data backfill', '[]', '[]', 'fast', ?, ?)
    `,
    ).run('test-session', 'test-proj', new Date().toISOString(), Date.now());

    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'feature', 'obs title', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run('test-session', 'test-proj', new Date().toISOString(), Date.now());

    // Haiku returns rich completed but empty remaining_items — common degraded
    // return shape observed in prod.
    callLLM.mockReturnValueOnce(
      JSON.stringify({
        request: 'Implementing auth system',
        completed: 'Basic auth flow with login/logout',
        remaining_items: '',
        next_steps: 'Add refresh token rotation',
      }),
    );

    await handleLLMSummary();

    const row = db.prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?').get('test-session');
    expect(row.completed).toBe('Basic auth flow with login/logout'); // Haiku richer → overwritten
    expect(row.remaining_items).toBe('structured-notdone: Gap #3 data backfill'); // Haiku empty → preserved
    expect(row.next_steps).toBe('Add refresh token rotation');
    expect(row.notes).toBe('llm');
  });

  it('upgrades existing fast summary instead of creating duplicate', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });
    // Simulate fast summary created by handleStop
    db.prepare(
      `
      INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, 'fast request', '', '', 'fast completed', '', '', '[]', '[]', 'fast', ?, ?)
    `,
    ).run('test-session', 'test-proj', new Date().toISOString(), Date.now());

    for (let i = 0; i < 3; i++) {
      db.prepare(
        `
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?, ?, '', 'feature', ?, '', 'Narrative text', '', '', '[]', '[]', 1, ?, ?)
      `,
      ).run('test-session', 'test-proj', `Observation ${i}`, new Date().toISOString(), Date.now() + i);
    }

    await handleLLMSummary();

    const summaries = db
      .prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?')
      .all('test-session');
    // Should have exactly 1 summary (upgraded, not duplicated)
    expect(summaries.length).toBe(1);
    expect(summaries[0].notes).toBe('llm');
    expect(summaries[0].request).toBe('Implementing auth system');
    expect(summaries[0].completed).toBe('Basic auth flow with login/logout');
  });

  it('skips summary when no observations exist', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });

    await handleLLMSummary();

    const count = db.prepare('SELECT COUNT(*) as cnt FROM session_summaries').get();
    expect(count.cnt).toBe(0);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('skips summary when LLM slot unavailable', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', 'Test obs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run('test-session', 'test-proj', new Date().toISOString(), Date.now());

    acquireLLMSlot.mockResolvedValueOnce(false);

    await handleLLMSummary();

    const count = db.prepare('SELECT COUNT(*) as cnt FROM session_summaries').get();
    expect(count.cnt).toBe(0);
  });

  it('persists lessons + key_decisions even when Haiku returns an empty request (Finding 2)', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'feature', 'Auth work', '', 'Narrative', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run('test-session', 'test-proj', new Date().toISOString(), Date.now());

    // Empty request but a rich completed + lessons + key_decisions — a common
    // degraded Haiku shape. The old `if (llmParsed.request)` gate dropped the whole
    // INSERT, losing the session's highest-value fields (lessons + key_decisions).
    callLLM.mockReturnValue(
      JSON.stringify({
        request: '',
        completed: 'Fixed auth token refresh in auth.mjs',
        lessons: ['JWT needs RS256 for key rotation support'],
        key_decisions: ['Chose SQLite over Postgres for zero-config deploys'],
      }),
    );

    await handleLLMSummary();

    const row = db.prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?').get('test-session');
    expect(row).toBeTruthy(); // no summary row was written at all before the fix
    expect(row.completed).toBe('Fixed auth token refresh in auth.mjs');
    expect(row.lessons).toBe(JSON.stringify(['JWT needs RS256 for key rotation support']));
    expect(row.key_decisions).toBe(JSON.stringify(['Chose SQLite over Postgres for zero-config deploys']));
  });

  it('coerces an array-valued completed/remaining_items to a string instead of throwing (R3)', async () => {
    insertSession(db, { id: 'test-session', project: 'test-proj' });
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'feature', 'Auth work', '', 'Narrative', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run('test-session', 'test-proj', new Date().toISOString(), Date.now());

    // Haiku returns completed/remaining_items as LISTS (plausible — they read as lists) with no
    // request. Binding a non-string straight to SQL used to throw "Too many parameter values",
    // dropping the whole summary incl. lessons. asText joins the array before scrub/bind.
    callLLM.mockReturnValue(
      JSON.stringify({
        request: '',
        completed: ['Fixed token refresh', 'Added retry'],
        remaining_items: ['Write integration tests'],
        lessons: ['JWT needs RS256 for key rotation'],
        key_decisions: ['Chose SQLite for zero-config'],
      }),
    );

    await handleLLMSummary(); // must NOT throw (handleLLMSummary has no catch — a throw would surface here)

    const row = db.prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?').get('test-session');
    expect(row).toBeTruthy();
    expect(row.completed).toBe('Fixed token refresh; Added retry'); // array joined by asText
    expect(row.remaining_items).toBe('Write integration tests');
    expect(row.lessons).toBe(JSON.stringify(['JWT needs RS256 for key rotation'])); // lessons survived
  });
});

// ─── session summary structured knowledge ────────────────────────────────────

describe('session summary structured knowledge', () => {
  it('parses lessons array from summary', () => {
    const raw = JSON.stringify({
      request: 'Fix authentication flow',
      completed: 'Fixed token refresh in auth.ts',
      remaining_items: '',
      next_steps: 'Add integration tests',
      lessons: ['Token refresh needs exponential backoff', 'OAuth state must be crypto random'],
      key_decisions: ['Chose jose over jsonwebtoken for ESM compatibility'],
    });
    const parsed = parseJsonFromLLM(raw);
    expect(parsed.lessons).toHaveLength(2);
    expect(parsed.key_decisions).toHaveLength(1);
  });

  it('handles missing lessons gracefully', () => {
    const raw = JSON.stringify({
      request: 'Update readme',
      completed: 'Done',
      remaining_items: '',
      next_steps: '',
    });
    const parsed = parseJsonFromLLM(raw);
    expect(parsed.lessons).toBeUndefined();
    expect(parsed.key_decisions).toBeUndefined();
  });

  it('persists lessons and key_decisions in session_summaries table', async () => {
    const db = createTestDb();
    db._realClose = db.close;
    db.close = () => {};

    const origArgv3 = process.argv[3];
    const origArgv4 = process.argv[4];
    process.argv[3] = 'lessons-sess';
    process.argv[4] = 'test-proj';
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = '0';

    openDb.mockReturnValue(db);
    callLLM.mockReturnValue(
      JSON.stringify({
        request: 'Fix auth flow',
        completed: 'Fixed token refresh',
        remaining_items: '',
        next_steps: 'Add tests',
        lessons: ['Exponential backoff needed for token refresh'],
        key_decisions: ['Chose jose for ESM compat'],
      }),
    );

    insertSession(db, { id: 'lessons-sess', project: 'test-proj' });
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'feature', 'Auth fix', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run('lessons-sess', 'test-proj', new Date().toISOString(), Date.now());

    await handleLLMSummary();

    const summary = db
      .prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?')
      .get('lessons-sess');
    expect(summary).toBeDefined();
    expect(summary.lessons).toBe(JSON.stringify(['Exponential backoff needed for token refresh']));
    expect(summary.key_decisions).toBe(JSON.stringify(['Chose jose for ESM compat']));

    process.argv[3] = origArgv3;
    process.argv[4] = origArgv4;
    delete process.env.CLAUDE_MEM_FLUSH_TIMEOUT;
    db._realClose();
  });

  it('stores null for empty lessons and key_decisions arrays', async () => {
    const db = createTestDb();
    db._realClose = db.close;
    db.close = () => {};

    const origArgv3 = process.argv[3];
    const origArgv4 = process.argv[4];
    process.argv[3] = 'no-lessons-sess';
    process.argv[4] = 'test-proj';
    process.env.CLAUDE_MEM_FLUSH_TIMEOUT = '0';

    openDb.mockReturnValue(db);
    callLLM.mockReturnValue(
      JSON.stringify({
        request: 'Update readme',
        completed: 'Done',
        remaining_items: '',
        next_steps: '',
        lessons: [],
        key_decisions: [],
      }),
    );

    insertSession(db, { id: 'no-lessons-sess', project: 'test-proj' });
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, ?, '', 'change', 'Update readme', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run('no-lessons-sess', 'test-proj', new Date().toISOString(), Date.now());

    await handleLLMSummary();

    const summary = db
      .prepare('SELECT * FROM session_summaries WHERE memory_session_id = ?')
      .get('no-lessons-sess');
    expect(summary).toBeDefined();
    expect(summary.lessons).toBeNull();
    expect(summary.key_decisions).toBeNull();

    process.argv[3] = origArgv3;
    process.argv[4] = origArgv4;
    delete process.env.CLAUDE_MEM_FLUSH_TIMEOUT;
    db._realClose();
  });
});

// ─── lesson_learned and search_aliases extraction ────────────────────────────

describe('lesson_learned and search_aliases extraction', () => {
  const filesToCleanup = [];

  afterEach(() => {
    while (filesToCleanup.length) {
      try {
        rmSync(filesToCleanup.pop(), { force: true });
      } catch {}
    }
  });

  it('parses lesson_learned from LLM response', () => {
    const raw = JSON.stringify({
      type: 'bugfix',
      title: 'Fix race condition in session init',
      narrative: 'Session file was created without atomic rename',
      concepts: ['race-condition', 'atomicity'],
      facts: ['session file write needs atomic rename to prevent TOCTOU'],
      importance: 2,
      lesson_learned: 'Always use atomic write (tmp+rename) for concurrent file access',
      search_aliases: ['TOCTOU', 'file race', 'concurrent write', '原子写入'],
    });
    const parsed = parseJsonFromLLM(raw);
    expect(parsed.lesson_learned).toBe('Always use atomic write (tmp+rename) for concurrent file access');
    expect(parsed.search_aliases).toEqual(['TOCTOU', 'file race', 'concurrent write', '原子写入']);
  });

  it('lesson_learned is null for routine observations', () => {
    const raw = JSON.stringify({
      type: 'change',
      title: 'Updated config',
      narrative: 'Changed port',
      concepts: ['config'],
      facts: ['port changed to 3001'],
      importance: 1,
      lesson_learned: null,
      search_aliases: ['config change'],
    });
    const parsed = parseJsonFromLLM(raw);
    expect(parsed.lesson_learned).toBeNull();
  });

  // v2.56.0 #1: under the paired-DROP gate, type=change + lesson="none" + imp<2
  // is now DROPPED entirely (not saved with null lesson). The pre-v2.56 normalize
  // path is preserved at line 638-641 — what changed is the downstream drop.
  it('lesson_learned "none" causes drop for change type (v2.56.0)', async () => {
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Minor config update',
        narrative: 'Updated port settings',
        concepts: ['config'],
        facts: ['Port changed to 3001'],
        importance: 1,
        lesson_learned: 'none',
        search_aliases: ['config change'],
      }),
    );

    const db = createTestDb();
    db._realClose = db.close;
    db.close = () => {};
    openDb.mockReturnValue(db);

    const tmpFile2 = join(tmpdir(), `hook-llm-test-none-${Date.now()}.json`);
    filesToCleanup.push(tmpFile2);
    const origArgv3 = process.argv[3];
    process.argv[3] = tmpFile2;
    process.env.CLAUDE_MEM_NO_DELAY = '1';

    writeFileSync(
      tmpFile2,
      JSON.stringify({
        sessionId: 'none-sess',
        project: 'test-proj',
        files: ['config.mjs'],
        filesRead: [],
        entries: [{ tool: 'Edit', desc: 'Update port config', isError: false }],
      }),
    );

    await handleLLMEpisode();

    const obs = db
      .prepare('SELECT lesson_learned FROM observations WHERE memory_session_id = ?')
      .get('none-sess');
    expect(obs).toBeUndefined(); // v2.56.0: dropped, not saved

    process.argv[3] = origArgv3;
    db._realClose();
  });

  it('lesson_learned "None" (capitalized) causes drop for change type (v2.56.0)', async () => {
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Routine file edit',
        narrative: 'Standard update',
        concepts: [],
        facts: [],
        importance: 1,
        lesson_learned: 'None',
        search_aliases: [],
      }),
    );

    const db = createTestDb();
    db._realClose = db.close;
    db.close = () => {};
    openDb.mockReturnValue(db);

    const tmpFile2 = join(tmpdir(), `hook-llm-test-None-${Date.now()}.json`);
    filesToCleanup.push(tmpFile2);
    const origArgv3 = process.argv[3];
    process.argv[3] = tmpFile2;
    process.env.CLAUDE_MEM_NO_DELAY = '1';

    writeFileSync(
      tmpFile2,
      JSON.stringify({
        sessionId: 'none-cap-sess',
        project: 'test-proj',
        files: ['app.mjs'],
        filesRead: [],
        entries: [{ tool: 'Edit', desc: 'Standard edit', isError: false }],
      }),
    );

    await handleLLMEpisode();

    const obs = db
      .prepare('SELECT lesson_learned FROM observations WHERE memory_session_id = ?')
      .get('none-cap-sess');
    expect(obs).toBeUndefined(); // v2.56.0: dropped, not saved

    process.argv[3] = origArgv3;
    db._realClose();
  });

  // v2.33.1 Fix 2: extended low-signal filter — 'n/a', 'todo', '-', ultra-short
  // lessons are normalized to null and noise-prone types get importance capped.
  it.each([
    ['n/a', 'n-a'],
    ['TODO', 'todo'],
    ['-', 'dash'],
    ['nil', 'nil'],
    ['ok', 'too-short'],
  ])(
    'v2.56.0: lesson_learned %s causes drop for change type (was: normalized + capped)',
    async (lessonText, tag) => {
      // v2.33.1 capped imp=2→1 for low-signal lesson via line 686. v2.56.0 #1
      // adds the paired DROP gate so this combo (change + low-signal lesson +
      // capped imp=1) lands NOWHERE — the same noise band, just a stricter exit.
      callLLM.mockReturnValue(
        JSON.stringify({
          type: 'change',
          title: `Routine change ${tag}`,
          narrative: 'Nothing notable',
          concepts: [],
          facts: [],
          importance: 2, // Haiku over-rates; capped to 1 by line 686, then dropped by gate
          lesson_learned: lessonText,
          search_aliases: [],
        }),
      );

      const db = createTestDb();
      db._realClose = db.close;
      db.close = () => {};
      openDb.mockReturnValue(db);

      const sessId = `low-sig-${tag}`;
      const tmpFile2 = join(tmpdir(), `hook-llm-lowsig-${tag}-${Date.now()}.json`);
      filesToCleanup.push(tmpFile2);
      const origArgv3 = process.argv[3];
      process.argv[3] = tmpFile2;
      process.env.CLAUDE_MEM_NO_DELAY = '1';

      writeFileSync(
        tmpFile2,
        JSON.stringify({
          sessionId: sessId,
          project: 'test-proj',
          files: [`file-${tag}.mjs`],
          filesRead: [],
          entries: [{ tool: 'Edit', desc: 'Edit', isError: false }],
        }),
      );

      await handleLLMEpisode();

      const obs = db
        .prepare('SELECT lesson_learned, importance FROM observations WHERE memory_session_id = ?')
        .get(sessId);
      expect(obs).toBeUndefined(); // v2.56.0: dropped, not saved

      process.argv[3] = origArgv3;
      db._realClose();
    },
  );

  it('v2.33.1: real lesson text passes through and importance is preserved', async () => {
    // Using type='change' (observations path, not events) since we assert on
    // the observations table. A real lesson means isLessonLowSignal=false,
    // so the v2.33.1 downgrade does not apply regardless of type.
    callLLM.mockReturnValue(
      JSON.stringify({
        type: 'change',
        title: 'Refactored token refresh',
        narrative: 'Extracted per-user lock to prevent 401 under concurrent refresh',
        concepts: [],
        facts: [],
        importance: 2,
        lesson_learned: 'Refresh locks must be per-user, not per-process — mutex collision under load.',
        search_aliases: [],
      }),
    );

    const db = createTestDb();
    db._realClose = db.close;
    db.close = () => {};
    openDb.mockReturnValue(db);

    const tmpFile2 = join(tmpdir(), `hook-llm-reallesson-${Date.now()}.json`);
    filesToCleanup.push(tmpFile2);
    const origArgv3 = process.argv[3];
    process.argv[3] = tmpFile2;
    process.env.CLAUDE_MEM_NO_DELAY = '1';

    writeFileSync(
      tmpFile2,
      JSON.stringify({
        sessionId: 'real-lesson-sess',
        project: 'test-proj',
        files: ['auth.mjs'],
        filesRead: [],
        entries: [{ tool: 'Edit', desc: 'Refactor refresh', isError: false }],
      }),
    );

    await handleLLMEpisode();

    const obs = db
      .prepare('SELECT lesson_learned, importance FROM observations WHERE memory_session_id = ?')
      .get('real-lesson-sess');
    expect(obs).toBeDefined();
    expect(obs.lesson_learned).toContain('per-user');
    expect(obs.importance).toBe(2); // preserved — not downgraded

    process.argv[3] = origArgv3;
    db._realClose();
  });
});

// ─── buildDegradedTitle ─────────────────────────────────────────────────────

// ─── persistHaikuSummary (T9 routing) ───────────────────────────────────────
// T9: routes event-typed summaries to the `events` table, keeps non-event
// types on the legacy observations path so memdir semantics stay intact.

describe('persistHaikuSummary (T9 routing)', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'mem' });
  });

  afterEach(() => {
    db.close();
  });

  it('bugfix-type summary writes to events, not observations', () => {
    persistHaikuSummary(
      db,
      {
        type: 'bugfix',
        title: 'fixed null deref in foo',
        lesson_learned: 'always nullcheck bar() before deref',
        importance: 2,
        files_modified: ['foo.mjs'],
      },
      { project: 'mem', session_id: 'sess-1' },
    );

    expect(db.prepare(`SELECT COUNT(*) c FROM events WHERE event_type='bugfix'`).get().c).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) c FROM observations WHERE type='bugfix'`).get().c).toBe(0);

    const ev = db.prepare(`SELECT * FROM events WHERE event_type='bugfix'`).get();
    expect(ev.title).toBe('fixed null deref in foo');
    expect(ev.body).toBe('always nullcheck bar() before deref');
    expect(JSON.parse(ev.file_paths)).toEqual(['foo.mjs']);
    expect(ev.importance).toBe(2);
  });

  it('change-type summary still writes to observations (legacy path)', () => {
    // `change` is not in EVENT_TYPES and is the actual non-event type Haiku
    // emits for routine file edits — it must stay on the legacy observations
    // path so existing consumers (session-summary, compression, FTS5) keep working.
    persistHaikuSummary(
      db,
      {
        type: 'change',
        title: 'refactored config loading',
        narrative: 'moved env parsing into loader',
        importance: 1,
        // Real lesson so the low-yield-change gate keeps it — this test asserts change-type
        // ROUTING (observations vs events), not the noise-drop behavior.
        lesson_learned: 'extracting the loader clarifies config-path resolution order',
        files_modified: ['config.mjs'],
      },
      { project: 'mem', session_id: 'sess-1' },
    );

    expect(db.prepare(`SELECT COUNT(*) c FROM observations WHERE type='change'`).get().c).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) c FROM events`).get().c).toBe(0);
  });

  it('discovery / decision / observation / refactor / feature / lesson / bug all route to events', () => {
    const eventTypes = ['discovery', 'decision', 'observation', 'refactor', 'feature', 'lesson', 'bug'];
    for (const type of eventTypes) {
      persistHaikuSummary(
        db,
        {
          type,
          title: `a ${type}`,
          importance: 1,
          files_modified: [],
        },
        { project: 'mem', session_id: 'sess-1' },
      );
    }
    expect(db.prepare(`SELECT COUNT(*) c FROM events`).get().c).toBe(eventTypes.length);
    expect(db.prepare(`SELECT COUNT(*) c FROM observations`).get().c).toBe(0);
  });

  it('falls back to narrative for event body when lesson_learned absent', () => {
    persistHaikuSummary(
      db,
      {
        type: 'discovery',
        title: 'noticed cache invalidation gap',
        narrative: 'cache misses after rotation',
        importance: 2,
        files_modified: [],
      },
      { project: 'mem', session_id: 'sess-1' },
    );

    const ev = db.prepare(`SELECT * FROM events WHERE event_type='discovery'`).get();
    expect(ev.body).toBe('cache misses after rotation');
  });

  it('leaves file_paths NULL when files_modified is empty or missing', () => {
    persistHaikuSummary(
      db,
      {
        type: 'decision',
        title: 'picked vitest over jest',
        importance: 2,
      },
      { project: 'mem', session_id: 'sess-1' },
    );

    const ev = db.prepare(`SELECT file_paths FROM events WHERE event_type='decision'`).get();
    expect(ev.file_paths).toBeNull();
  });
});

// ─── buildDegradedTitle ─────────────────────────────────────────────────────

describe('buildVecText (finding #8: vector text mirrors FTS content)', () => {
  const obs = {
    title: 'Fix pool deadlock',
    narrative: 'reordered acquisition order',
    concepts: ['deadlock', 'pool'],
    lessonLearned: 'never acquire a second connection inside a callback',
    searchAliases: 'connection hang db lock timeout',
  };
  it('includes lesson_learned and search_aliases (the paraphrase-bridge terms)', () => {
    const vt = buildVecText(obs);
    expect(vt).toContain('never acquire a second connection');
    expect(vt).toContain('db lock timeout');
  });
  it('still includes title, narrative, and concepts', () => {
    const vt = buildVecText(obs);
    expect(vt).toContain('Fix pool deadlock');
    expect(vt).toContain('reordered acquisition');
    expect(vt).toContain('deadlock');
  });
});

describe('buildDegradedTitle', () => {
  it('strips tab characters and CI status from error hints', () => {
    const episode = {
      files: ['plugin.json'],
      entries: [
        {
          tool: 'Bash',
          desc: 'gh run list → ERROR: in_progress\t\tchore(release): bump version',
          isError: true,
        },
      ],
    };
    const title = buildDegradedTitle(episode);
    expect(title).not.toMatch(/\t/);
    expect(title).not.toMatch(/in_progress/);
    expect(title).toMatch(/^Error: plugin\.json/);
  });

  it('strips tabs from no-file fallback desc', () => {
    const episode = {
      files: [],
      entries: [
        {
          tool: 'Bash',
          desc: 'check\tstatus\there',
          isError: false,
        },
      ],
    };
    const title = buildDegradedTitle(episode);
    expect(title).not.toMatch(/\t/);
    expect(title).toBe('check status here');
  });
});

// ─── Haiku extraction recovery helpers ──────────────────────────────────────

describe('unwrapObservationEnvelope', () => {
  it('unwraps a single-element array [{...}]', () => {
    expect(unwrapObservationEnvelope([{ title: 'x', lesson_learned: 'y' }])).toEqual({
      title: 'x',
      lesson_learned: 'y',
    });
  });

  it('unwraps a single object-valued wrapper key {"observation":{...}}', () => {
    expect(unwrapObservationEnvelope({ observation: { title: 'x' } })).toEqual({ title: 'x' });
  });

  it('leaves a normal observation object untouched (has a string title)', () => {
    const o = { title: 'x', lesson_learned: 'y' };
    expect(unwrapObservationEnvelope(o)).toBe(o);
  });

  it('leaves a multi-element array untouched (ambiguous — cannot pick one)', () => {
    const a = [{ title: 'x' }, { title: 'y' }];
    expect(unwrapObservationEnvelope(a)).toBe(a);
  });

  it('does not unwrap a single-key object whose value is not an object', () => {
    const o = { lesson_learned: 'just a lesson, no title here' };
    expect(unwrapObservationEnvelope(o)).toBe(o);
  });
});

describe('isLowSignalLesson', () => {
  it('treats sentinels and <12-char lessons as low-signal', () => {
    for (const s of ['none', '  N/A ', 'null', 'nothing', 'too short', '', '-']) {
      expect(isLowSignalLesson(s)).toBe(true);
    }
    expect(isLowSignalLesson(null)).toBe(true);
    expect(isLowSignalLesson(42)).toBe(true);
  });

  it('treats a substantive lesson (>=12 chars, not a sentinel) as signal', () => {
    expect(isLowSignalLesson('wrap FTS writes in a try/catch block')).toBe(false);
  });
});

describe('hasEnrichmentContent', () => {
  it('is true for a substantive lesson / narrative / fact', () => {
    expect(hasEnrichmentContent({ lesson_learned: 'read env before applying defaults' })).toBe(true);
    expect(hasEnrichmentContent({ narrative: 'refactored the loader' })).toBe(true);
    expect(hasEnrichmentContent({ facts: ['loader reads env first'] })).toBe(true);
  });

  it('is false for an empty / sentinel-only parse', () => {
    expect(hasEnrichmentContent({})).toBe(false);
    expect(hasEnrichmentContent({ lesson_learned: 'none', narrative: '', facts: [] })).toBe(false);
    expect(hasEnrichmentContent(null)).toBe(false);
  });
});
