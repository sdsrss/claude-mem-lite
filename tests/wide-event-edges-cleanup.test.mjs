// Report §9-D (docs/audits/20260929-sandbox-usage-eval.md): events written before 9503efe
// carry every file their episode MENTIONED as edges — package.json, README.md, the host's own
// auto-memory notes — so PreToolUse keeps recalling a coupon lesson on every `cat package.json`
// (21 of 79 injections in the sandbox, none about package.json). New events are keyed to the
// edited files; this one-shot pass narrows the old ones.
//
// Rules, per event:
//   - a path the capture now drops (host state under ~/.claude/projects/<dir>/, the harness
//     scratchpad, node_modules, tool-results) is removed, even if it was the only edge;
//   - a hub file read in nearly every episode (package.json and lock files, README*,
//     CLAUDE.md, AGENTS.md, .gitignore) is removed only while another edge remains.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { createTestDb } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';
import {
  pruneWideEventEdges,
  runWideEdgeCleanupOnce,
  WIDE_EDGE_CLEANUP_NAME,
} from '../lib/maintain-core.mjs';

const P = '/home/u/app';
const MEM = '/home/u/.claude/projects/-home-u-app/memory/MEMORY.md';

function addEvent(db, filePaths) {
  return db
    .prepare(
      `INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
       VALUES ('u--app', 'feature', 't', 'b', ?, 1, ?)`,
    )
    .run(filePaths === null ? null : JSON.stringify(filePaths), Date.now()).lastInsertRowid;
}
const pathsOf = (db, id) => {
  const v = db.prepare('SELECT file_paths FROM events WHERE id = ?').get(id).file_paths;
  return v === null ? null : JSON.parse(v);
};

describe('pruneWideEventEdges', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('drops hubs next to a real edge, host state always, and leaves a lone hub alone', () => {
    const wide = addEvent(db, [
      `${P}/package.json`,
      `${P}/README.md`,
      `${P}/src/invoice.mjs`,
      MEM,
      `${P}/CLAUDE.md`,
    ]);
    const loneHub = addEvent(db, [`${P}/README.md`]);
    const onlyHost = addEvent(db, [MEM]);
    const clean = addEvent(db, [`${P}/src/money.mjs`, `${P}/test/money.test.mjs`]);
    const none = addEvent(db, null);
    const scratch = addEvent(db, ['/tmp/claude-1000/-home-u-app/abc/scratchpad/p.py', `${P}/src/cli.mjs`]);

    const r = pruneWideEventEdges(db);

    expect(pathsOf(db, wide)).toEqual([`${P}/src/invoice.mjs`]);
    expect(pathsOf(db, loneHub)).toEqual([`${P}/README.md`]);
    expect(pathsOf(db, onlyHost)).toBeNull();
    expect(pathsOf(db, clean)).toEqual([`${P}/src/money.mjs`, `${P}/test/money.test.mjs`]);
    expect(pathsOf(db, none)).toBeNull();
    expect(pathsOf(db, scratch)).toEqual([`${P}/src/cli.mjs`]);
    expect(r).toMatchObject({ changed: 3, removed: 6 });
  });

  it('a dry run reports without writing, and a second pass changes nothing', () => {
    const id = addEvent(db, [`${P}/package.json`, `${P}/src/a.mjs`]);
    expect(pruneWideEventEdges(db, { dryRun: true })).toMatchObject({ changed: 1, removed: 1 });
    expect(pathsOf(db, id)).toEqual([`${P}/package.json`, `${P}/src/a.mjs`]);
    pruneWideEventEdges(db);
    expect(pruneWideEventEdges(db)).toMatchObject({ changed: 0, removed: 0 });
  });

  it('survives an unparseable row without losing the rest', () => {
    db.prepare(
      `INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
       VALUES ('u--app', 'feature', 't', 'b', '{not json', 1, 1)`,
    ).run();
    const id = addEvent(db, [`${P}/yarn.lock`, `${P}/src/a.mjs`]);
    expect(() => pruneWideEventEdges(db)).not.toThrow();
    expect(pathsOf(db, id)).toEqual([`${P}/src/a.mjs`]);
  });
});

describe('runWideEdgeCleanupOnce', () => {
  let dir;
  let db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cml-edge-prune-'));
    db = new Database(join(dir, 'claude-mem-lite.db'));
    initSchema(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('snapshots before a change, marks itself done, and never runs twice', () => {
    const id = addEvent(db, [`${P}/package.json`, `${P}/src/a.mjs`]);
    const first = runWideEdgeCleanupOnce(db);
    expect(first).toMatchObject({ ran: true, changed: 1 });
    expect(pathsOf(db, id)).toEqual([`${P}/src/a.mjs`]);
    expect(readdirSync(dir).some((f) => f.includes('.pre-edge-prune-') && f.endsWith('.bak'))).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) c FROM migration_cleanups WHERE name = ?').get(WIDE_EDGE_CLEANUP_NAME).c,
    ).toBe(1);

    addEvent(db, [`${P}/package.json`, `${P}/src/b.mjs`]);
    expect(runWideEdgeCleanupOnce(db)).toMatchObject({ ran: false });
  });

  it('takes no snapshot when nothing would change, and still marks itself done', () => {
    addEvent(db, [`${P}/src/a.mjs`]);
    expect(runWideEdgeCleanupOnce(db)).toMatchObject({ ran: true, changed: 0 });
    expect(readdirSync(dir).some((f) => f.endsWith('.bak'))).toBe(false);
    expect(runWideEdgeCleanupOnce(db)).toMatchObject({ ran: false });
  });
});

describe('the daily auto-maintain worker runs the cleanup', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  let dataDir;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cml-edge-prune-e2e-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('hook.mjs auto-maintain narrows an old wide edge and records the pass', () => {
    const seed = new Database(join(dataDir, 'claude-mem-lite.db'));
    initSchema(seed);
    const id = addEvent(seed, [`${P}/package.json`, `${P}/src/invoice.mjs`, MEM]);
    seed.close();
    execFileSync(process.execPath, [join(REPO, 'hook.mjs'), 'auto-maintain', 'u--app'], {
      cwd: dataDir,
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_COMPRESS: '1',
        CLAUDE_MEM_SKIP_OPTIMIZE: '1',
        CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      },
      stdio: 'pipe',
      timeout: 60_000,
    });
    const after = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    try {
      expect(pathsOf(after, id)).toEqual([`${P}/src/invoice.mjs`]);
      expect(
        after.prepare('SELECT COUNT(*) c FROM migration_cleanups WHERE name = ?').get(WIDE_EDGE_CLEANUP_NAME)
          .c,
      ).toBe(1);
    } finally {
      after.close();
    }
  });
});
