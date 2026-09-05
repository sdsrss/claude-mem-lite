// Regression: every CLI write path that persists observation text must route it
// through the scrub choke-point, matching the MCP twins (mem_update scrubs `concepts`;
// import-jsonl / compress-core scrub on re-persist). Two CLI paths bypassed it:
//   - cmdUpdate `--concepts` (siblings title/narrative/lesson scrubbed, concepts raw)
//   - cmdRestore's signal-field UPDATE (subtitle/concepts/facts/search_aliases raw)
// Both fields are FTS-indexed, so an unscrubbed secret becomes searchable + exportable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';

const CLI_PATH = resolve('cli.mjs');
// Canonical AWS access-key-id shape — scrubs to '***' (see secret-scrub-coverage.test.mjs).
const SECRET = 'AKIAIOSFODNN7EXAMPLE';

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-wscrub-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function initDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'claude-mem-lite.db'));
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}
function runCli(args, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_PROJECT_DIR: dataDir,
        CLAUDE_MEM_HOOK_RUNNING: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

describe('CLI write-path secret scrubbing', () => {
  let dir;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('update --concepts scrubs secrets before persisting (parity with mem_update)', () => {
    const db = initDb(dir);
    insertSession(db, { id: 'ws', project: 'wsproj', memoryId: 'ws' });
    const id = Number(
      insertObs(db, { sessionId: 'ws', project: 'wsproj', title: 'obs', text: 'body' }).lastInsertRowid,
    );
    db.close();

    const r = runCli(['update', String(id), '--concepts', `leaked ${SECRET} token`], dir);
    expect(r.exitCode).toBe(0);

    const db2 = new Database(join(dir, 'claude-mem-lite.db'), { readonly: true });
    const row = db2.prepare('SELECT concepts, text FROM observations WHERE id = ?').get(id);
    db2.close();
    expect(row.concepts).not.toContain(SECRET);
    expect(row.concepts).toContain('***');
    // rebuildObservationDerived folds concepts into the FTS `text` column — must not leak there either.
    expect(row.text || '').not.toContain(SECRET);
  });

  it('restore scrubs subtitle/concepts/facts/search_aliases from a backup file', () => {
    // Simulate an unscrubbed/older backup (e.g. made before a SECRET_PATTERNS entry existed):
    // restore re-scrubs title/narrative/lesson via saveObservation but not the signal fields.
    const backup = [
      {
        type: 'bugfix',
        title: 'restored row',
        narrative: 'narrative body',
        project: 'rp',
        created_at_epoch: Date.now() - 86400000,
        subtitle: `sub ${SECRET}`,
        concepts: `con ${SECRET}`,
        facts: `fac ${SECRET}`,
        search_aliases: `alias ${SECRET}`,
      },
    ];
    const bfile = join(dir, 'backup.json');
    writeFileSync(bfile, JSON.stringify(backup));
    initDb(dir).close();

    const r = runCli(['restore', bfile, '--project', 'rp'], dir);
    expect(r.exitCode).toBe(0);

    const db = new Database(join(dir, 'claude-mem-lite.db'), { readonly: true });
    const row = db
      .prepare(
        "SELECT subtitle, concepts, facts, search_aliases FROM observations WHERE title = 'restored row'",
      )
      .get();
    db.close();
    expect(row, 'restored row missing').toBeTruthy();
    for (const f of ['subtitle', 'concepts', 'facts', 'search_aliases']) {
      expect(row[f], `${f} leaked the secret`).not.toContain(SECRET);
    }
  });
});
