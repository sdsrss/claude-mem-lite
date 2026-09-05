// R4 E2E audit (HIGH) — export → restore silently dropped the observation body
// (`text` column) for every empty-`narrative` row. import-jsonl / cold-start-backfill
// observations store the real body in `text` and leave `narrative` empty
// (lib/import-jsonl.mjs:108-109), so a documented backup→restore of an imported
// transcript collapsed each row's content to its bare title — unrecoverable AND
// unsearchable (`text` is its own FTS5 column). The pre-fix export SELECT omitted
// `text`; restore reconstructed content from `narrative || title`.
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

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-exptext-${randomUUID().slice(0, 8)}`);
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

describe('R4 export→restore preserves the observation body (text column)', () => {
  let srcDir, dstDir, expFile;
  const BODY = 'UNIQUEBODYZZZ the suite output 42 passed root cause was a stale cache key in redis';

  beforeEach(() => {
    srcDir = makeTmpDir();
    dstDir = makeTmpDir();
    expFile = join(makeTmpDir(), 'backup.jsonl');
    const db = initDb(srcDir);
    insertSession(db, { id: 'imp-sess', project: 'srcproj', memoryId: 'imp-sess' });
    // Mimic an import-jsonl row: body lives in `text`, narrative is empty.
    insertObs(db, {
      sessionId: 'imp-sess',
      project: 'srcproj',
      type: 'discovery',
      title: 'Bash: run tests',
      narrative: '',
      text: BODY,
      importance: 2,
    });
    db.close();
  });
  afterEach(() => {
    for (const d of [srcDir, dstDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  it('exports the text column and restores it verbatim (body stays searchable)', () => {
    // Source row is searchable by a body term.
    const srcSearch = runCli(['search', 'UNIQUEBODYZZZ'], srcDir);
    expect(srcSearch.stdout).toContain('Bash: run tests');

    // export → restore into a fresh DB.
    const exp = runCli(['export', '--format', 'jsonl'], srcDir);
    expect(exp.stdout).toContain('"text"'); // export must carry the body column
    writeFileSync(expFile, exp.stdout);
    const res = runCli(['restore', expFile], dstDir);
    expect(res.stdout.toLowerCase()).toContain('restore');

    // The restored row must still contain the body (not collapsed to the title).
    const dst = new Database(join(dstDir, 'claude-mem-lite.db'));
    const row = dst.prepare("SELECT text, title FROM observations WHERE title = 'Bash: run tests'").get();
    dst.close();
    expect(row).toBeTruthy();
    expect(row.text).toContain('UNIQUEBODYZZZ');

    // …and searchable by a body term in the restored DB.
    const dstSearch = runCli(['search', 'UNIQUEBODYZZZ'], dstDir);
    expect(dstSearch.stdout).toContain('Bash: run tests');
  });
});
