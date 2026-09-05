// G1+G2 (roadmap 2026-07-18): save-time background enrichment — one Haiku call
// distills lesson_learned (obligated types only) + search_aliases (every manual
// save) and backfills FILL-ONLY-EMPTY. The v3.49 save-nudge reminds the agent;
// this is the system backstop for saves that ignore it. Daily llm-optimize
// remains the outer safety net (executeSaveEnrich never sets optimized_at, so
// rows stay eligible for the wide pass).
//
// Historical failure class this guards: empty-overwrite / preserve-on-empty
// (R4/R1 audits) — enrichment must NEVER replace content the caller (or a
// concurrent optimize pass) already wrote.
import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { shouldQueueSaveEnrich, executeSaveEnrich, ENRICH_OBLIGATED_TYPES } from '../lib/save-enrich.mjs';

const PROJECT = 'enrich--test';

function save(db, over = {}) {
  return saveObservation(db, {
    project: PROJECT,
    type: 'bugfix',
    content: 'Fixed FTS trigger not firing after schema rebuild — DROP and recreate the trigger',
    ...over,
  });
}

function row(db, id) {
  return db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
}

describe('shouldQueueSaveEnrich (trigger predicate)', () => {
  const saved = { kind: 'saved', id: 1, type: 'bugfix', lessonCaptured: false };

  it('queues a fresh save when no gate applies', () => {
    expect(shouldQueueSaveEnrich(saved, {})).toBe(true);
  });

  it('respects the kill switch and the test-env gate', () => {
    expect(shouldQueueSaveEnrich(saved, { CLAUDE_MEM_SKIP_SAVE_ENRICH: '1' })).toBe(false);
    // Without this gate every e2e save in vitest would spawn a REAL Haiku call
    // on dev machines with a logged-in claude CLI.
    expect(shouldQueueSaveEnrich(saved, { VITEST: 'true' })).toBe(false);
  });

  it('never queues dedup hits or missing results', () => {
    expect(shouldQueueSaveEnrich({ kind: 'dedup', id: 1 }, {})).toBe(false);
    expect(shouldQueueSaveEnrich(null, {})).toBe(false);
  });
});

describe('executeSaveEnrich (fill-only-empty worker)', () => {
  it('backfills lesson + aliases on an obligated-type save missing both', async () => {
    const db = createTestDb();
    const { id } = save(db);
    const callJson = async () => ({
      lesson_learned:
        'CREATE IF NOT EXISTS never updates an existing trigger body — bump schema version and DROP+recreate',
      search_aliases: ['trigger body stale', '触发器 不更新'],
    });
    const r = await executeSaveEnrich(db, id, { callJson });
    expect(r.enriched).toBe(true);
    const o = row(db, id);
    expect(o.lesson_learned).toContain('DROP+recreate');
    expect(o.search_aliases).toContain('trigger body stale');
    expect(o.search_aliases).toContain('触发器 不更新');
    // Aliases APPEND to FTS text (never rebuild) — CJK aliases ride as bigrams.
    expect(o.text).toContain('trigger body stale');
    expect(o.text).toContain('触发');
    // Row stays eligible for the daily wide re-enrich pass.
    expect(o.optimized_at).toBeNull();
    db.close();
  });

  it('makes the row findable via FTS by a backfilled alias term', async () => {
    const db = createTestDb();
    const { id } = save(db);
    await executeSaveEnrich(db, id, {
      callJson: async () => ({ lesson_learned: 'none', search_aliases: ['tombstone resurrection'] }),
    });
    const hit = db
      .prepare(
        `
      SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'tombstone' LIMIT 5
    `,
      )
      .all()
      .map((r) => r.rowid);
    expect(hit).toContain(id);
    db.close();
  });

  it('NEVER overwrites a caller-written lesson (fill-only-empty)', async () => {
    const db = createTestDb();
    const { id } = save(db, { lesson_learned: 'agent-written lesson — authoritative' });
    await executeSaveEnrich(db, id, {
      callJson: async () => ({ lesson_learned: 'distilled replacement', search_aliases: ['alias one'] }),
    });
    const o = row(db, id);
    expect(o.lesson_learned).toBe('agent-written lesson — authoritative');
    expect(o.search_aliases).toContain('alias one');
    db.close();
  });

  it('NEVER overwrites aliases filled concurrently between spawn and execution', async () => {
    const db = createTestDb();
    const { id } = save(db);
    db.prepare(`UPDATE observations SET search_aliases = 'optimize-pass aliases' WHERE id = ?`).run(id);
    await executeSaveEnrich(db, id, {
      callJson: async () => ({ lesson_learned: 'a lesson', search_aliases: ['worker aliases'] }),
    });
    const o = row(db, id);
    expect(o.search_aliases).toBe('optimize-pass aliases');
    expect(o.lesson_learned).toContain('a lesson');
    db.close();
  });

  it('does not write a lesson on non-obligated types (aliases still fill)', async () => {
    const db = createTestDb();
    const { id } = save(db, { type: 'discovery' });
    expect(ENRICH_OBLIGATED_TYPES.has('discovery')).toBe(false);
    await executeSaveEnrich(db, id, {
      callJson: async () => ({ lesson_learned: 'should not land', search_aliases: ['disco alias'] }),
    });
    const o = row(db, id);
    expect(o.lesson_learned).toBeNull();
    expect(o.search_aliases).toContain('disco alias');
    db.close();
  });

  it('treats "none" lesson as no-lesson and skips empty alias arrays', async () => {
    const db = createTestDb();
    const { id } = save(db);
    const r = await executeSaveEnrich(db, id, {
      callJson: async () => ({ lesson_learned: 'none', search_aliases: [] }),
    });
    const o = row(db, id);
    expect(o.lesson_learned).toBeNull();
    expect(o.search_aliases).toBeNull();
    expect(r.enriched).toBe(false);
    db.close();
  });

  it('no-ops without an LLM call on superseded rows', async () => {
    const db = createTestDb();
    const { id } = save(db);
    db.prepare(`UPDATE observations SET superseded_at = ? WHERE id = ?`).run(Date.now(), id);
    let called = 0;
    const r = await executeSaveEnrich(db, id, {
      callJson: async () => {
        called++;
        return {};
      },
    });
    expect(called).toBe(0);
    expect(r.enriched).toBe(false);
    db.close();
  });

  it('degrades silently when the LLM returns null', async () => {
    const db = createTestDb();
    const { id } = save(db);
    const before = row(db, id);
    const r = await executeSaveEnrich(db, id, { callJson: async () => null });
    expect(r.enriched).toBe(false);
    expect(row(db, id)).toEqual(before);
    db.close();
  });

  it('scrubs secrets in the distilled lesson before persisting', async () => {
    const db = createTestDb();
    const { id } = save(db);
    await executeSaveEnrich(db, id, {
      callJson: async () => ({
        lesson_learned: 'rotate with api_key=sk-live-abcdef1234567890 immediately',
        search_aliases: ['credential rotation'],
      }),
    });
    const o = row(db, id);
    expect(o.lesson_learned).not.toContain('sk-live-abcdef1234567890');
    db.close();
  });

  it('untouched columns stay byte-identical (title/narrative/type/importance)', async () => {
    const db = createTestDb();
    const { id } = save(db, { importance: 3 });
    const before = row(db, id);
    await executeSaveEnrich(db, id, {
      callJson: async () => ({
        lesson_learned: 'a lesson',
        search_aliases: ['x alias'],
        title: 'hostile title rewrite',
        narrative: 'hostile narrative',
        importance: 1,
        type: 'change',
      }),
    });
    const o = row(db, id);
    expect(o.title).toBe(before.title);
    expect(o.narrative).toBe(before.narrative);
    expect(o.type).toBe(before.type);
    expect(o.importance).toBe(before.importance);
    db.close();
  });
});
