// `update` must never destroy an observation's body.
//
// `observations.text` is a DERIVED search blob: applyObsUpdate → rebuildObservationDerived
// recomputes it as title + subtitle + narrative + concepts + facts + lesson + aliases
// (+ CJK bigrams). That is sound only while `narrative` actually holds the body — and two
// ingest paths break that invariant: import-jsonl writes `narrative: ''` with the whole
// payload in `text`, and insertObservationRow's OBS_DEFAULTS default `narrative` to ''
// for any caller that omits it.
//
// Reproduced on v3.68.1 against a real import:
//
//   $ claude-mem-lite import-jsonl session.jsonl     # 1 observation
//   $ claude-mem-lite get 1 --fields title,text
//     text: {"file_path":"src/CartService.java","old_string":"items.size()", …}
//   $ claude-mem-lite update 1 --importance 3
//     [mem] Updated #1: importance
//   $ claude-mem-lite get 1 --fields title,text
//     text: Edit: src/CartService.java              ← the payload is gone, unrecoverably
//
// Note the trigger: `--importance`, a field that has nothing to do with the body. No
// snapshot is taken on update (only `delete` snapshots), so the content is unrecoverable,
// and the row also stops matching any search for its own contents.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { applyObsUpdate, insertObservationRow } from '../lib/observation-write.mjs';
import { cjkBigrams } from '../utils.mjs';

let db;

function seedBodyOnlyInText({ title, text }) {
  db.prepare(
    `INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
              VALUES ('cc-1', 'mem-1', 'p', datetime('now'), ?)`,
  ).run(Date.now());
  // Deliberately omits `narrative` — exactly what import-jsonl and any other caller
  // relying on OBS_DEFAULTS produce.
  return insertObservationRow(db, {
    memory_session_id: 'mem-1',
    project: 'p',
    type: 'change',
    title,
    text,
    importance: 1,
    created_at: new Date().toISOString(),
    created_at_epoch: Date.now(),
  });
}

describe('applyObsUpdate — body preservation when narrative is empty', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  const BODY =
    '{"file_path":"src/CartService.java","old_string":"items.size()",' +
    '"new_string":"items == null ? 0 : items.size()"}\n---\n[tool_use without result]';

  it('an importance-only update keeps the body searchable', () => {
    const id = seedBodyOnlyInText({ title: 'Edit: src/CartService.java', text: BODY });
    applyObsUpdate(db, id, { importance: 3 });
    const row = db.prepare('SELECT text, narrative, importance FROM observations WHERE id = ?').get(id);
    expect(row.importance).toBe(3);
    expect(row.text).toContain('items == null ? 0 : items.size()');
    // FTS is content='observations', so the search index must carry it too.
    const hit = db
      .prepare(`SELECT count(*) AS c FROM observations_fts WHERE observations_fts MATCH 'CartService'`)
      .get();
    expect(hit.c).toBe(1);
  });

  it('a title update keeps the body and adopts the new title', () => {
    const id = seedBodyOnlyInText({ title: 'Edit: src/CartService.java', text: BODY });
    applyObsUpdate(db, id, { title: 'Guarded null cart items' });
    const row = db.prepare('SELECT title, text FROM observations WHERE id = ?').get(id);
    expect(row.title).toBe('Guarded null cart items');
    expect(row.text).toContain('items == null ? 0 : items.size()');
    expect(row.text).toContain('Guarded null cart items');
  });

  it('repeated updates neither lose nor duplicate the body (idempotent repair)', () => {
    const id = seedBodyOnlyInText({ title: 'Edit: src/CartService.java', text: BODY });
    applyObsUpdate(db, id, { importance: 2 });
    const once = db.prepare('SELECT text FROM observations WHERE id = ?').get(id).text;
    applyObsUpdate(db, id, { importance: 3 });
    const twice = db.prepare('SELECT text FROM observations WHERE id = ?').get(id).text;
    expect(twice).toBe(once);
    // One copy of the payload, not two.
    expect(twice.split('items == null ? 0 : items.size()').length - 1).toBe(1);
  });

  it('does NOT promote an already-derived search blob into narrative', () => {
    // The mirror hazard, found by pre-tag review. hook-llm.mjs / persistHaikuSummary /
    // hook-optimize.mjs write rows whose narrative is legitimately EMPTY and whose `text`
    // is the derived FTS blob — buildFtsTextField joins concepts + facts + aliases +
    // cjkBigrams(title+narrative) and omits title and narrative entirely. Promoting that
    // blob writes bigram fragments into a user-visible field, irreversibly (update takes
    // no snapshot). Fixture mirrors buildFtsTextField's composition exactly, because a
    // hand-written approximation is what made the first attempt at this guard pass.
    db.prepare(
      `INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
                VALUES ('cc-1', 'mem-1', 'p', datetime('now'), ?)`,
    ).run(Date.now());
    const title = '重构认证模块';
    const concepts = 'auth jwt refresh';
    const blob = [concepts, cjkBigrams(`${title} `)].filter(Boolean).join(' ');
    const id = insertObservationRow(db, {
      memory_session_id: 'mem-1',
      project: 'p',
      type: 'refactor',
      title,
      narrative: '',
      concepts,
      text: blob,
      importance: 2,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    });
    applyObsUpdate(db, id, { importance: 3 });
    const row = db.prepare('SELECT narrative FROM observations WHERE id = ?').get(id);
    expect(row.narrative, `derived blob leaked into narrative: ${row.narrative}`).toBe('');
  });

  it('leaves a well-formed row (narrative already set) deriving from narrative', () => {
    // The normal save path: narrative holds the body. The repair must not fire, and the
    // derived text must stay the plain concatenation it has always been.
    db.prepare(
      `INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
                VALUES ('cc-1', 'mem-1', 'p', datetime('now'), ?)`,
    ).run(Date.now());
    const id = insertObservationRow(db, {
      memory_session_id: 'mem-1',
      project: 'p',
      type: 'bugfix',
      title: 'Shared retry budget',
      narrative: 'the retry budget was shared across shards',
      text: 'the retry budget was shared across shards',
      importance: 2,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    });
    applyObsUpdate(db, id, { importance: 3 });
    const row = db.prepare('SELECT narrative, text FROM observations WHERE id = ?').get(id);
    expect(row.narrative).toBe('the retry budget was shared across shards');
    expect(row.text).toBe('Shared retry budget the retry budget was shared across shards');
  });
});
