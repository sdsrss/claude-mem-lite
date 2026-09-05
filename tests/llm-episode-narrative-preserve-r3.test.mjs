// R3 L-L2 (LOW): handleLLMEpisode's in-place upgrade of a pre-saved `change` row wrote
// narrative=? verbatim. When the Haiku enrich pass returns title+lesson but no narrative,
// that '' wiped the pre-saved rule-based narrative (the actual file/command actions). The
// UPDATE now uses COALESCE(NULLIF(?,''), narrative) — this guards that column preservation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

describe('in-place upgrade preserves a pre-saved narrative on empty (R3 L-L2)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });
  afterEach(() => {
    db.close();
  });

  it("COALESCE(NULLIF(?,''),narrative) keeps the existing narrative when the upgrade omits one", () => {
    insertObs(db, {
      title: 'pre-saved change',
      narrative: 'rule-based: edited foo.js; ran tests',
      type: 'change',
    });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    // exact SET expression the in-place upgrade uses, with an EMPTY narrative + a real lesson
    db.prepare(
      "UPDATE observations SET narrative=COALESCE(NULLIF(?, ''), narrative), lesson_learned=? WHERE id=?",
    ).run('', 'always run tests after an edit', id);
    const row = db.prepare('SELECT narrative, lesson_learned FROM observations WHERE id=?').get(id);
    expect(row.narrative, 'pre-saved narrative preserved').toBe('rule-based: edited foo.js; ran tests');
    expect(row.lesson_learned, 'enrichment still applied').toContain('run tests');
  });

  it('still overwrites the narrative when the upgrade provides a non-empty one', () => {
    insertObs(db, { title: 'pre-saved change', narrative: 'old narrative', type: 'change' });
    const id = db.prepare('SELECT id FROM observations LIMIT 1').get().id;
    db.prepare("UPDATE observations SET narrative=COALESCE(NULLIF(?, ''), narrative) WHERE id=?").run(
      'enriched narrative from the LLM',
      id,
    );
    expect(db.prepare('SELECT narrative FROM observations WHERE id=?').get(id).narrative).toBe(
      'enriched narrative from the LLM',
    );
  });
});
