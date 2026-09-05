// D#25 — `restore` is the inverse of `export` (the backup/restore half README:690
// promises). These tests run the real CLI as a subprocess against isolated
// CLAUDE_MEM_DIR temp dirs, so export (DB-A) → restore (DB-B) exercises the true
// cross-DB round-trip the pre-fix codebase had no command for.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';

const CLI_PATH = resolve('cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-restore-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'claude-mem-lite.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return db;
}

// spawnSync (not execFileSync): stderr must be readable on SUCCESS too, since the
// backup-fidelity caveat rides stderr so stdout stays a clean JSON/JSONL stream.
function runCli(args, dataDir, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: dataDir,
      CLAUDE_PROJECT_DIR: dataDir,
      CLAUDE_MEM_HOOK_RUNNING: undefined,
      ...extraEnv,
    },
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status ?? 1 };
}

describe('D#25 export → restore round-trip', () => {
  let srcDir, dstDir, expFile;
  beforeEach(() => {
    srcDir = makeTmpDir();
    dstDir = makeTmpDir();
    expFile = join(makeTmpDir(), 'backup.jsonl');
    // Seed source DB with value-signal-bearing observations
    const db = initDb(srcDir);
    insertSession(db, { id: 'src-sess', project: 'srcproj', memoryId: 'src-sess' });
    insertObs(db, {
      sessionId: 'src-sess',
      project: 'srcproj',
      type: 'bugfix',
      title: 'auth token refresh crash',
      narrative: 'the auth token refresh path crashed under load',
      importance: 3,
      accessCount: 7,
      citedCount: 4,
      uncitedStreak: 2,
      injectionCount: 9,
      branch: 'feat/auth',
      filesModified: '["auth.mjs","token.mjs"]',
      epochOffset: -5 * 86400000,
    });
    insertObs(db, {
      sessionId: 'src-sess',
      project: 'srcproj',
      type: 'decision',
      title: 'use redis for the cache layer',
      narrative: 'chose redis over memcached for ttl support',
      importance: 2,
      accessCount: 1,
      epochOffset: -2 * 86400000,
    });
    db.close();
  });
  afterEach(() => {
    for (const d of [srcDir, dstDir, join(expFile, '..')]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('restores observations (count + content + importance) into a fresh DB', () => {
    const exp = runCli(['export', '--format', 'jsonl'], srcDir);
    writeFileSync(expFile, exp.stdout);
    const r = runCli(['restore', expFile], dstDir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/2 restored/);
    const db = new Database(join(dstDir, 'claude-mem-lite.db'));
    const rows = db
      .prepare('SELECT title, type, importance FROM observations ORDER BY importance DESC')
      .all();
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('auth token refresh crash');
    expect(rows[0].importance).toBe(3);
    expect(rows[1].title).toBe('use redis for the cache layer');
  });

  it('preserves value-signals (access/cited/uncited/injection) + branch + created_at (full fidelity)', () => {
    writeFileSync(expFile, runCli(['export', '--format', 'jsonl'], srcDir).stdout);
    runCli(['restore', expFile], dstDir);
    const db = new Database(join(dstDir, 'claude-mem-lite.db'));
    const row = db.prepare("SELECT * FROM observations WHERE title = 'auth token refresh crash'").get();
    db.close();
    expect(row.access_count).toBe(7);
    expect(row.cited_count).toBe(4);
    expect(row.uncited_streak).toBe(2);
    expect(row.injection_count).toBe(9);
    expect(row.branch).toBe('feat/auth');
    // created_at preserved (5 days ago, not "now"): created_at_epoch < 2 days ago
    expect(row.created_at_epoch).toBeLessThan(Date.now() - 4 * 86400000);
  });

  it('round-trips the v44 scope label (review D#78 — twin-drift guard)', () => {
    // Stamp a scope on the seeded bugfix row, then export → restore into a fresh DB.
    const src = new Database(join(srcDir, 'claude-mem-lite.db'));
    src
      .prepare("UPDATE observations SET scope = 'environment' WHERE title = 'auth token refresh crash'")
      .run();
    src.close();
    writeFileSync(expFile, runCli(['export', '--format', 'jsonl'], srcDir).stdout);
    runCli(['restore', expFile], dstDir);
    const db = new Database(join(dstDir, 'claude-mem-lite.db'));
    const scopes = db.prepare('SELECT title, scope FROM observations ORDER BY title').all();
    db.close();
    expect(scopes.find((r) => r.title === 'auth token refresh crash').scope).toBe('environment');
    // Row exported without a scope restores as NULL (old-backup degradation path).
    expect(scopes.find((r) => r.title === 'use redis for the cache layer').scope).toBeNull();
  });

  it('is idempotent: re-restoring the same file skips duplicates (durable, not 5-min window)', () => {
    writeFileSync(expFile, runCli(['export', '--format', 'jsonl'], srcDir).stdout);
    runCli(['restore', expFile], dstDir);
    const second = runCli(['restore', expFile], dstDir);
    expect(second.stdout).toMatch(/0 restored, 2 duplicate/);
    const db = new Database(join(dstDir, 'claude-mem-lite.db'));
    const count = db.prepare('SELECT COUNT(*) c FROM observations').get().c;
    db.close();
    expect(count).toBe(2); // no duplication
  });

  it('round-trips search_aliases and keeps them FTS-searchable after restore', () => {
    // Regression: export dropped the search_aliases column, so a restored memory
    // became unfindable by its LLM-generated alternate query terms. Seed an obs
    // whose alias term ("zqxwombat") appears ONLY in search_aliases — not in
    // title/narrative — so a hit proves the alias column survived + re-indexed.
    const db = initDb(srcDir + '-alias');
    insertSession(db, { id: 'a-sess', project: 'aliasproj', memoryId: 'a-sess' });
    insertObs(db, {
      sessionId: 'a-sess',
      project: 'aliasproj',
      type: 'bugfix',
      title: 'sqlite vtab cascade fix',
      narrative: 'fixed the cascade on UPDATE',
      searchAliases: 'zqxwombat promisor blobless',
      importance: 2,
    });
    db.close();

    writeFileSync(expFile, runCli(['export', '--format', 'jsonl'], srcDir + '-alias').stdout);
    runCli(['restore', expFile], dstDir);

    const rdb = new Database(join(dstDir, 'claude-mem-lite.db'));
    const row = rdb
      .prepare("SELECT search_aliases FROM observations WHERE title = 'sqlite vtab cascade fix'")
      .get();
    rdb.close();
    expect(row.search_aliases).toBe('zqxwombat promisor blobless');

    // Alias-only term must find the restored obs (proves FTS index re-synced).
    const search = runCli(['search', 'zqxwombat'], dstDir);
    expect(search.stdout).toMatch(/sqlite vtab cascade fix/);

    try {
      rmSync(srcDir + '-alias', { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('--dry-run previews without writing', () => {
    writeFileSync(expFile, runCli(['export', '--format', 'jsonl'], srcDir).stdout);
    const r = runCli(['restore', expFile, '--dry-run'], dstDir);
    expect(r.stdout).toMatch(/dry-run/);
    // Conditional wording: the preview must not claim past-tense work (tests/restore-dry-run-honesty).
    expect(r.stdout).toMatch(/2 would be restored/);
    const db = new Database(join(dstDir, 'claude-mem-lite.db'));
    const count = db.prepare('SELECT COUNT(*) c FROM observations').get().c;
    db.close();
    expect(count).toBe(0); // nothing written
  });

  it('round-trips the JSON-array (default) format too, not just JSONL', () => {
    const jsonFile = join(dstDir, 'backup.json');
    writeFileSync(jsonFile, runCli(['export'], srcDir).stdout); // default = json array
    const r = runCli(['restore', jsonFile], dstDir);
    expect(r.stdout).toMatch(/2 restored/);
  });

  // P3-8: restore saves via saveObservation (vector text = title + content + lesson),
  // then re-applies concepts / facts / search_aliases / text with a raw UPDATE. The FTS
  // `text` column re-syncs through the _au trigger, but nothing rebuilt the TF-IDF
  // vector — so a restored row's vector silently omitted every field applied by that
  // second write. Here "zqxwombat" lives ONLY in search_aliases, so the stored vector
  // can match the canonical vector for the row's final field state only if the rebuild
  // fires. Vectors are off by default, so the arm is switched on for this test.
  it('rebuilds the TF-IDF vector after the restored signal fields are applied', async () => {
    const { rebuildVocabulary, getVocabulary, computeVector, vecTextForRow, _resetVocabCache } =
      await import('../tfidf.mjs');
    const prevVec = process.env.CLAUDE_MEM_VECTORS;
    process.env.CLAUDE_MEM_VECTORS = '1';
    try {
      // Seed the DESTINATION db with a vocabulary: 8 docs so "deadlock" (df=5) and
      // "zqxwombat" (df=3) both land in vocab with non-zero IDF.
      const seed = initDb(dstDir);
      insertSession(seed, { id: 'vocab-sess', project: 'vocabfill', memoryId: 'vocab-sess' });
      for (let i = 0; i < 8; i++) {
        insertObs(seed, {
          sessionId: 'vocab-sess',
          project: 'vocabfill',
          type: 'discovery',
          title: `filler ${i}`,
          narrative: `${i < 5 ? 'deadlock' : 'filler'} ${i < 3 ? 'zqxwombat' : 'otherterm'} in the pool handler ${i}`,
        });
      }
      _resetVocabCache();
      rebuildVocabulary(seed);
      seed.close();

      // Backup row: alias term appears in NEITHER title nor narrative.
      const vecFile = join(dstDir, 'vec.jsonl');
      writeFileSync(
        vecFile,
        JSON.stringify({
          title: 'restored vector row',
          type: 'bugfix',
          project: 'restoredproj',
          narrative: 'deadlock occurred in the pool',
          search_aliases: 'zqxwombat',
          importance: 2,
          created_at_epoch: Date.now(),
        }) + '\n',
      );

      const r = runCli(['restore', vecFile], dstDir, { CLAUDE_MEM_VECTORS: '1' });
      expect(r.stdout).toMatch(/1 restored/);

      const db = new Database(join(dstDir, 'claude-mem-lite.db'));
      const row = db
        .prepare(
          `SELECT id, title, narrative, concepts, lesson_learned, search_aliases
                              FROM observations WHERE title = 'restored vector row'`,
        )
        .get();
      const stored = db
        .prepare('SELECT vector FROM observation_vectors WHERE observation_id = ?')
        .get(row.id)?.vector;
      _resetVocabCache();
      const vocab = getVocabulary(db);
      db.close();

      expect(row.search_aliases).toBe('zqxwombat');
      expect(stored, 'restored row has no vector at all').toBeDefined();
      const canonical = Buffer.from(computeVector(vecTextForRow(row), vocab).buffer);
      // Pre-fix the stored vector was built from title+narrative only → mismatch.
      expect(Buffer.compare(stored, canonical)).toBe(0);
    } finally {
      if (prevVec === undefined) delete process.env.CLAUDE_MEM_VECTORS;
      else process.env.CLAUDE_MEM_VECTORS = prevVec;
      _resetVocabCache();
    }
  });

  it('leaves observation_vectors untouched when the vector arm is disabled (default)', () => {
    writeFileSync(expFile, runCli(['export', '--format', 'jsonl'], srcDir).stdout);
    runCli(['restore', expFile], dstDir);
    const db = new Database(join(dstDir, 'claude-mem-lite.db'));
    const count = db.prepare('SELECT COUNT(*) c FROM observation_vectors').get().c;
    db.close();
    expect(count).toBe(0);
  });

  it('rejects a non-export file gracefully (no crash)', () => {
    const bad = join(dstDir, 'bad.txt');
    writeFileSync(bad, 'this is not an export\n');
    const r = runCli(['restore', bad], dstDir);
    expect(r.exitCode).not.toBe(0);
    // Single garbage line goes the JSONL path → all-failed-to-parse rejection.
    expect(r.stderr + r.stdout).toMatch(/not valid export|failed to parse/);
  });

  it('JSONL: recovers valid rows when some lines are corrupt (does not abort the whole import)', () => {
    // A single broken line in a large backup must not discard every valid row —
    // a backup tool recovers what it can. Parse failures fold into malformed/failed.
    const mixed = join(dstDir, 'mixed.jsonl');
    const now = new Date().toISOString();
    writeFileSync(
      mixed,
      [
        JSON.stringify({
          title: 'valid alpha',
          type: 'bugfix',
          project: 'p',
          narrative: 'fixed the auth token refresh crash under load',
          created_at: now,
        }),
        '{ this line is broken json',
        JSON.stringify({
          title: 'valid beta',
          type: 'decision',
          project: 'p',
          narrative: 'chose redis over memcached for ttl support',
          created_at: now,
        }),
      ].join('\n'),
    );
    const r = runCli(['restore', mixed], dstDir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/2 restored/);
    expect(r.stdout).toMatch(/1 malformed\/failed from 3 row\(s\)/);
  });

  // P3-6: export/restore is framed as "backup" in the README and in cmdRestore's own
  // header, but the format deliberately drops the relationship graph — export filters
  // superseded rows and omits related_ids, and restore re-inserts under fresh
  // AUTOINCREMENT ids, so no cross-link could survive even if it were exported. The
  // omission is a documented design tradeoff (id remap makes stored ids stale); the
  // defect is that nothing at the point of use says so, so a user reasonably reads
  // "2 restored" as full fidelity.
  it('restore output states that related_ids / supersession links are not carried across', () => {
    writeFileSync(expFile, runCli(['export', '--format', 'jsonl'], srcDir).stdout);
    const r = runCli(['restore', expFile], dstDir);
    const all = r.stdout + r.stderr;
    expect(all).toMatch(/related_ids/);
    expect(all).toMatch(/supersession|superseded/i);
    expect(all).toMatch(/not carried|not preserved|dropped/i);
  });

  it('export warns at backup-creation time that the relationship graph is omitted', () => {
    const exp = runCli(['export', '--format', 'jsonl'], srcDir);
    // stdout must stay a clean machine-readable stream — the caveat rides stderr.
    expect(exp.stdout).not.toMatch(/related_ids/);
    expect(exp.stderr).toMatch(/related_ids/);
  });

  it('remaps ids — no PK collision when restoring into a DB that already has rows', () => {
    // Pre-populate dst with its own obs (ids 1..N), then restore the export on top.
    const db2 = initDb(dstDir);
    insertSession(db2, { id: 'dst-sess', project: 'dstproj', memoryId: 'dst-sess' });
    insertObs(db2, { sessionId: 'dst-sess', project: 'dstproj', type: 'change', title: 'pre-existing row' });
    db2.close();
    writeFileSync(expFile, runCli(['export', '--format', 'jsonl'], srcDir).stdout);
    const r = runCli(['restore', expFile], dstDir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/2 restored/);
    const db = new Database(join(dstDir, 'claude-mem-lite.db'));
    const count = db.prepare('SELECT COUNT(*) c FROM observations').get().c;
    db.close();
    expect(count).toBe(3); // 1 pre-existing + 2 restored, no collision
  });
});
