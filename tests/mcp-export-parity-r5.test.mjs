// v3.42 audit HIGH-2: the MCP `mem_export` tool carried its own narrower 16-column SELECT
// while CLI `export` carried the full 24-column round-trippable set. The 8 missing columns
// (text / files_read / search_aliases / cited_count / uncited_streak / injection_count /
// decay_seen_count / last_accessed_at) are EXACTLY what `restore` reads back — so a backup
// taken via the (explicitly advertised) MCP export → restored via CLI silently collapsed
// every empty-`narrative` row (import-jsonl / cold-start bodies live in `text`) to its bare
// title: unrecoverable AND unsearchable. Fix = both surfaces share EXPORT_COLUMNS_SQL.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { EXPORT_COLUMNS } from '../lib/export-columns.mjs';
import { handleExportForTest } from '../server.mjs';

const CLI_PATH = resolve('cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-mcpexp-${randomUUID().slice(0, 8)}`);
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
    return { stdout, exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

describe('MCP mem_export ↔ CLI export parity (v3.42 HIGH-2)', () => {
  // The shared contract must cover every column restore reads back. This is the structural
  // guard that keeps the two surfaces from drifting again.
  it('EXPORT_COLUMNS covers the columns cmdRestore reads back', () => {
    const restoreReads = [
      'text',
      'subtitle',
      'concepts',
      'facts',
      'search_aliases',
      'files_read',
      'branch',
      'scope',
      'access_count',
      'cited_count',
      'uncited_streak',
      'injection_count',
      'decay_seen_count',
      'last_accessed_at',
    ];
    const missing = restoreReads.filter((c) => !EXPORT_COLUMNS.includes(c));
    expect(missing, `EXPORT_COLUMNS missing restore-read columns: ${missing.join(', ')}`).toEqual([]);
  });

  describe('behavioral round-trip: MCP export → CLI restore', () => {
    let srcDir, dstDir, expFile;
    const BODY = 'UNIQUEMCPBODY the pytest suite 42 passed root cause stale redis cache key';
    const ALIAS = 'ALTQUERYTERM';

    beforeEach(() => {
      srcDir = makeTmpDir();
      dstDir = makeTmpDir();
      expFile = join(makeTmpDir(), 'mcp-backup.jsonl');
      const db = initDb(srcDir);
      insertSession(db, { id: 'imp-sess', project: 'srcproj', memoryId: 'imp-sess' });
      // Mimic an import-jsonl / cold-start row: body in `text`, narrative empty, plus an
      // alias (FTS-indexed) so we can prove searchability survives the round trip.
      insertObs(db, {
        sessionId: 'imp-sess',
        project: 'srcproj',
        type: 'discovery',
        title: 'Bash: run tests',
        narrative: '',
        text: BODY,
        importance: 2,
        searchAliases: ALIAS,
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

    it('MCP export carries the body + aliases; restore keeps the row searchable', async () => {
      const db = new Database(join(srcDir, 'claude-mem-lite.db'));
      const res = await handleExportForTest(db, { format: 'jsonl', include_compressed: false });
      db.close();
      const text = res.content[0].text;
      // The MCP export payload itself must carry the body column (pre-fix: absent).
      expect(text).toContain('"text"');
      expect(text).toContain('UNIQUEMCPBODY');

      // Strip the "Exported N observations:\n" preamble → jsonl lines only.
      const jsonl = text
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .join('\n');
      writeFileSync(expFile, jsonl);

      const restore = runCli(['restore', expFile], dstDir);
      expect(restore.stdout.toLowerCase()).toContain('restore');

      // Body preserved (not collapsed to the bare title) …
      const dst = new Database(join(dstDir, 'claude-mem-lite.db'));
      const row = dst.prepare("SELECT text FROM observations WHERE title = 'Bash: run tests'").get();
      dst.close();
      expect(row?.text).toContain('UNIQUEMCPBODY');

      // … and still searchable by both a body term and an alias term.
      expect(runCli(['search', 'UNIQUEMCPBODY'], dstDir).stdout).toContain('Bash: run tests');
      expect(runCli(['search', ALIAS], dstDir).stdout).toContain('Bash: run tests');
    });
  });
});
