// D#147: a non-hook writer stores `<prefix><project>` as both session ids, and sdk_sessions
// refuses a row whose two ids are equal and shaped like a uuid. For one project length and dash
// layout per prefix the id has that shape, and every write in that project failed. The smart-
// compress and cluster-merge paths are covered in tests/hook-optimize.test.mjs (they need the
// model mock).
import { describe, it, expect } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { writerSessionId, hookSessionId, isAutoWritten } from '../lib/provenance.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { saveEvent, promoteInsightEvents } from '../lib/activity.mjs';
import { compressGroup } from '../lib/compress-core.mjs';

// The project that makes `<prefix><project>` exactly the trigger's shape.
const uuidTail = (prefix) => '00000000-0000-0000-0000-000000000000'.slice(prefix.length).replace(/0/g, 'a');

const insertWriterRow = (db, id) =>
  db
    .prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
       VALUES (?, ?, 'p', '', 0, 'active')`,
    )
    .run(id, id);

describe('writerSessionId', () => {
  it('leaves an ordinary id unchanged', () => {
    expect(writerSessionId('manual-', 'dev--claude-mem-lite')).toBe('manual-dev--claude-mem-lite');
    expect(writerSessionId('compress-', 'test')).toBe('compress-test');
    // 36 characters, but the dashes are not where a uuid has them.
    expect(writerSessionId('compress-', 'a'.repeat(27))).toBe(`compress-${'a'.repeat(27)}`);
  });

  // The trigger is the definition of the shape, so the helper is checked against it: every id
  // the trigger refuses is changed, every id it accepts is left alone, and the changed id is
  // accepted.
  it('changes exactly the ids the sdk_sessions trigger refuses', () => {
    const db = createTestDb();
    const cases = [
      ['manual-', uuidTail('manual-')],
      ['promote-', uuidTail('promote-')],
      ['compress-', uuidTail('compress-')],
      // One character short and one over: accepted, unchanged.
      ['compress-', uuidTail('compress-').slice(1)],
      ['compress-', `${uuidTail('compress-')}a`],
      // SQLite counts code points: 27 of them here, 28 UTF-16 units.
      ['compress-', `${uuidTail('compress-').slice(0, -1)}😀`],
    ];
    for (const [prefix, project] of cases) {
      const raw = `${prefix}${project}`;
      let refused = false;
      try {
        insertWriterRow(db, raw);
      } catch (e) {
        expect(e.message).toMatch(/sdk_sessions invariant/);
        refused = true;
      }
      const id = writerSessionId(prefix, project);
      expect(id !== raw, `${JSON.stringify(raw)} refused=${refused}`).toBe(refused);
      if (refused) expect(() => insertWriterRow(db, id)).not.toThrow();
    }
    db.close();
  });
});

// D#156: the hook's own id is `hook-<project>-<8 hex>`, the uuid shape for a 22-character project
// with dashes at 3, 8, 13 and 18. `dev/abc-efgh-jklm-opq` is such a project; the hook e2e case is in
// tests/e2e.test.mjs.
describe('hookSessionId', () => {
  const PROJECT = 'dev--abc-efgh-jklm-opq';

  it('changes exactly the hook ids the sdk_sessions trigger refuses', () => {
    const db = createTestDb();
    const cases = [PROJECT, PROJECT.slice(1), `${PROJECT}x`, 'dev--claude-mem-lite'];
    let refusedSeen = 0;
    for (const project of cases) {
      const raw = `hook-${project}-1a2b3c4d`;
      let refused = false;
      try {
        insertWriterRow(db, raw);
      } catch (e) {
        expect(e.message).toMatch(/sdk_sessions invariant/);
        refused = true;
        refusedSeen++;
      }
      const id = hookSessionId(project, '1a2b3c4d');
      expect(id.startsWith(`hook-${project}-1a2b3c4d`)).toBe(true);
      expect(id !== raw, `${JSON.stringify(raw)} refused=${refused}`).toBe(refused);
      if (refused) expect(() => insertWriterRow(db, id)).not.toThrow();
    }
    // Premise: the case list reaches the refused shape at all.
    expect(refusedSeen).toBe(1);
    db.close();
  });
});

describe('writers in a project whose writer id would look like a uuid', () => {
  it('mem_save stores the row, still as an explicit save', () => {
    const db = createTestDb();
    const project = uuidTail('manual-');
    const r = saveObservation(db, { content: 'a deliberate note about the gizmo', project });
    expect(r.kind).toBe('saved');
    const row = db.prepare('SELECT memory_session_id FROM observations WHERE project = ?').get(project);
    expect(row.memory_session_id).toBe(`manual-${project}~`);
    expect(isAutoWritten(row.memory_session_id)).toBe(false);
    db.close();
  });

  it('activity promote promotes the event instead of skipping it', () => {
    const db = createTestDb();
    db.pragma('foreign_keys = ON');
    const project = uuidTail('promote-');
    saveEvent(db, {
      project,
      event_type: 'lesson',
      title: 'httpOnly cookies e2e',
      body: 'session cookies must be httpOnly or the e2e tests bleed across browsers',
      importance: 2,
      created_at_epoch: 1_600_000_000_000,
    });
    const r = promoteInsightEvents(db, { execute: true });
    expect(r).toMatchObject({ promoted: 1, skipped: 0 });
    const row = db.prepare('SELECT memory_session_id FROM observations WHERE project = ?').get(project);
    expect(isAutoWritten(row.memory_session_id)).toBe(true);
    db.close();
  });

  it('compressGroup writes its weekly summary', () => {
    const db = createTestDb();
    db.pragma('foreign_keys = ON');
    const project = uuidTail('compress-');
    insertSession(db, { id: 'sess-u', project });
    const obs = ['x', 'y', 'z'].map((t) => {
      const r = insertObs(db, { sessionId: 'sess-u', project, title: t, importance: 1 });
      return db
        .prepare('SELECT id, project, type, title, created_at_epoch FROM observations WHERE id = ?')
        .get(Number(r.lastInsertRowid));
    });
    const { summaryId, compressed } = compressGroup(db, project, obs);
    expect(compressed).toBe(3);
    const summary = db.prepare('SELECT memory_session_id FROM observations WHERE id = ?').get(summaryId);
    expect(summary.memory_session_id).toBe(`compress-${project}~`);
    db.close();
  });
});
