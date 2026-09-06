// P2-12 (audit 2026-08-14): twin consolidation — the five CLI/MCP pairs that were
// hand-copied line-for-line (the 16-vs-24-column export data-loss incident's
// precursor shape) now share lib/ cores per the cli/fts-check.mjs +
// server/fts-check.mjs thin-adapter template:
//
//   get      → lib/get-core.mjs        OBS_FIELDS + SESSION_DETAIL_FIELDS + fetchObsDetail
//   update   → lib/observation-write.mjs applyObsUpdate
//   delete   → lib/delete-core.mjs      previewDeleteRows
//   browse   → lib/browse-core.mjs      collectBrowseTiers
//
// Faces keep their own validation front-ends and header/footer conventions —
// only the data collection, field sets, and drift-prone row shapes are shared.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { OBS_FIELDS, SESSION_DETAIL_FIELDS, fetchObsDetail } from '../lib/get-core.mjs';
import { applyObsUpdate } from '../lib/observation-write.mjs';
import { previewDeleteRows } from '../lib/delete-core.mjs';
import { collectBrowseTiers } from '../lib/browse-core.mjs';

function seededDb() {
  const db = createTestDb();
  insertSession(db, { id: 's1', project: 'p' });
  return db;
}

describe('lib/get-core.mjs', () => {
  it('OBS_FIELDS matches the observations table (every field is a real column)', () => {
    const db = createTestDb();
    const cols = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info('observations')")
        .all()
        .map((r) => r.name),
    );
    for (const f of OBS_FIELDS) expect(cols.has(f), `OBS_FIELDS names unknown column "${f}"`).toBe(true);
    // Floor pins the OTHER direction (review 2026-08-16): a field silently
    // REMOVED from OBS_FIELDS vanishes from both faces' default `get` render —
    // the 16-vs-24-column shape this core exists to prevent.
    expect(OBS_FIELDS.length, 'OBS_FIELDS shrank below the 23-column baseline').toBeGreaterThanOrEqual(23);
    db.close();
  });

  // FAILS IF: the CLI session detail reverts to its old 6-field subset — a
  // remaining_items/notes/files_* hit found via FTS became a dead end in the CLI
  // detail view (searchable but never rendered).
  it('SESSION_DETAIL_FIELDS carries the full render set incl. remaining_items', () => {
    // remaining_items FIRST — it is the audited dead-end field, and the original
    // version of this loop managed to omit it (review 2026-08-16, mutation-verified).
    for (const f of [
      'remaining_items',
      'request',
      'investigated',
      'learned',
      'completed',
      'next_steps',
      'notes',
      'files_read',
      'files_edited',
      'project',
    ]) {
      expect(SESSION_DETAIL_FIELDS, `session detail lost "${f}"`).toContain(f);
    }
  });

  it('fetchObsDetail bumps access_count and returns rows in created order', () => {
    const db = seededDb();
    const a = Number(
      insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'older row' }).lastInsertRowid,
    );
    const b = Number(
      insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'newer row' }).lastInsertRowid,
    );
    const rows = fetchObsDetail(db, [b, a]);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    const bumped = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(a);
    expect(bumped.access_count).toBe(1);
    db.close();
  });
});

describe('lib/observation-write.mjs applyObsUpdate', () => {
  // Scrub coverage lives in tests/cli-write-scrub.test.mjs ("update --concepts
  // scrubs secrets"), which exercises this same applyObsUpdate choke point
  // end-to-end — this test pins atomicity + derived rebuild only.
  it('updates fields atomically and rebuilds derived text', () => {
    const db = seededDb();
    const id = Number(
      insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'before title' }).lastInsertRowid,
    );
    const updated = applyObsUpdate(db, id, { title: 'after title', importance: 3 });
    expect(updated.sort()).toEqual(['importance', 'title']);
    const row = db.prepare('SELECT title, importance, text FROM observations WHERE id = ?').get(id);
    expect(row.title).toBe('after title');
    expect(row.importance).toBe(3);
    expect(row.text, 'derived text not rebuilt').toContain('after title');
    db.close();
  });

  it('returns [] and writes nothing when no fields given', () => {
    const db = seededDb();
    const id = Number(
      insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'untouched' }).lastInsertRowid,
    );
    expect(applyObsUpdate(db, id, {})).toEqual([]);
    expect(db.prepare('SELECT title FROM observations WHERE id = ?').get(id).title).toBe('untouched');
    db.close();
  });
});

describe('lib/delete-core.mjs previewDeleteRows', () => {
  it('returns rows + shared preview body lines', () => {
    const db = seededDb();
    const id = Number(
      insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'doomed row' }).lastInsertRowid,
    );
    const { rows, lines } = previewDeleteRows(db, [id, 99999]);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`#${id}`);
    expect(lines[0]).toContain('doomed row');
    expect(lines[0]).toContain('| p');
    db.close();
  });

  // Both faces computed the not-found set only in the CONFIRM branch, so the
  // PREVIEW — the step whose whole job is to show what will happen before it
  // happens — listed the found rows and said nothing about the rest. A user
  // previewing `delete 42,43,44`, seeing two rows and typing --confirm, learned
  // that 43 never existed only after the delete. The sibling `activity delete`
  // already warns in its preview; this puts the set in the shared core so both
  // the CLI and mem_delete report it from one place.
  it('reports which requested ids were not found (preview needs it, not just confirm)', () => {
    const db = seededDb();
    const id = Number(
      insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'doomed row' }).lastInsertRowid,
    );
    const { missing } = previewDeleteRows(db, [id, 99999, 88888]);
    expect(missing).toEqual([99999, 88888]);

    // All-found is an empty array, never undefined — callers gate on .length.
    expect(previewDeleteRows(db, [id]).missing).toEqual([]);
    db.close();
  });
});

describe('lib/browse-core.mjs collectBrowseTiers', () => {
  it('collects tier counts + rows with the superset column shape', () => {
    const db = seededDb();
    insertObs(db, { sessionId: 's1', project: 'p', type: 'bugfix', title: 'fresh row', importance: 2 });
    const { showTiers, tierData, tierCounts, grandTotal } = collectBrowseTiers(db, {
      project: 'p',
      tierFilter: null,
      limit: 5,
      now: Date.now(),
      currentSessionId: 's1',
    });
    expect(showTiers).toEqual(['working', 'active', 'archive']);
    expect(grandTotal).toBe(1);
    const withRow = showTiers.find((t) => tierData[t].rows.length > 0);
    expect(withRow, 'seeded row landed in no tier').toBeTruthy();
    const r = tierData[withRow].rows[0];
    // Superset shape: both faces render from these — importance was CLI-only pre-P2-12.
    for (const k of ['id', 'type', 'title', 'importance', 'created_at', 'created_at_epoch']) {
      expect(k in r, `browse row lost "${k}"`).toBe(true);
    }
    expect(tierCounts[withRow]).toBe(1);
    db.close();
  });
});

describe('CLI get S#N renders remaining_items (the audited dead-end field)', () => {
  it('a session summary with remaining_items shows it in the detail view', () => {
    const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
    const dataDir = mkdtempSync(join(tmpdir(), 'twin-sget-'));
    try {
      const db = new Database(join(dataDir, 'claude-mem-lite.db'));
      initSchema(db);
      db.prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
                  VALUES ('cs1', 'ms1', 'p', datetime('now'), ?, 'active')`,
      ).run(Date.now());
      const sid = Number(
        db
          .prepare(
            `INSERT INTO session_summaries
          (memory_session_id, project, request, remaining_items, created_at, created_at_epoch)
          VALUES ('ms1', 'p', 'do the thing', 'finish the widget migration', datetime('now'), ?)`,
          )
          .run(Date.now()).lastInsertRowid,
      );
      db.close();

      const stdout = execFileSync(process.execPath, [join(REPO, 'cli.mjs'), 'get', `S#${sid}`], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, CLAUDE_MEM_DIR: dataDir, MEM_QUIET_HOOKS: '1' },
      });
      expect(stdout).toContain(`S#${sid}`);
      expect(stdout, 'remaining_items still unrendered on the CLI detail face').toContain(
        'finish the widget migration',
      );
    } finally {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
});
