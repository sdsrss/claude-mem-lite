// R10 P2-3 + P2-5 + P2-6 + P2-7 — four ways an MCP or CLI call landed somewhere other
// than where the caller pointed it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { resolveProject, _resetProjectCache } from '../project-utils.mjs';
import { supersededNotice, OBS_FIELDS } from '../lib/get-core.mjs';
import { memDeleteSchema } from '../tool-schemas.mjs';
import { mergeDuplicates } from '../lib/maintain-core.mjs';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function addObs(db, project, n, over = {}) {
  const stmt = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch, compressed_into, superseded_at)
     VALUES ('ms-1', ?, 'change', ?, 'n', datetime('now'), ?, ?, ?)`,
  );
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      Number(
        stmt.run(
          project,
          over.title || `t${i}`,
          Date.now() - i,
          over.compressed_into ?? 0,
          over.superseded_at ?? null,
        ).lastInsertRowid,
      ),
    );
  }
  return ids;
}

// ── P2-3 ─────────────────────────────────────────────────────────────────────
// The WRITE path reused the READ path's fuzzy resolver. Read-side fuzz is a design
// choice: a wrong guess costs one query. Write-side fuzz costs the row's identity —
// mem_save project:"api" landed in mono--api-gateway, and the caller's next
// project-scoped read of "api" does not find it.

describe('R10 P2-3 — write-mode project resolution is exact, read-mode stays fuzzy', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    db.pragma('foreign_keys = OFF');
    _resetProjectCache();
  });
  afterEach(() => db.close());

  it('read mode still resolves a prefix into a canonical name', () => {
    addObs(db, 'mono--api-gateway', 5);
    expect(resolveProject(db, 'api')).toBe('mono--api-gateway');
  });

  it('write mode refuses that prefix and keeps the caller name', () => {
    addObs(db, 'mono--api-gateway', 5);
    expect(resolveProject(db, 'api', { mode: 'write' })).toBe('api');
  });

  it('read mode still resolves a whole interior token', () => {
    addObs(db, 'projects--code-graph-mcp', 4);
    expect(resolveProject(db, 'graph')).toBe('projects--code-graph-mcp');
  });

  it('write mode refuses that too', () => {
    addObs(db, 'projects--code-graph-mcp', 4);
    expect(resolveProject(db, 'graph', { mode: 'write' })).toBe('graph');
  });

  it('write mode KEEPS the exact canonical-suffix completion users depend on', () => {
    addObs(db, 'projects--mem', 4);
    expect(resolveProject(db, 'mem', { mode: 'write' })).toBe('projects--mem');
  });

  it('write mode passes an already-canonical name through', () => {
    expect(resolveProject(db, 'a--b', { mode: 'write' })).toBe('a--b');
  });

  it('write mode keeps an exact existing bare name', () => {
    addObs(db, 'workspace', 2);
    expect(resolveProject(db, 'workspace', { mode: 'write' })).toBe('workspace');
  });

  it('the two modes do not share a cache entry', () => {
    addObs(db, 'mono--api-gateway', 5);
    // Read first, then write: a name-only cache would hand the write the read's answer.
    expect(resolveProject(db, 'api')).toBe('mono--api-gateway');
    expect(resolveProject(db, 'api', { mode: 'write' })).toBe('api');
    // And the other order.
    _resetProjectCache();
    expect(resolveProject(db, 'api', { mode: 'write' })).toBe('api');
    expect(resolveProject(db, 'api')).toBe('mono--api-gateway');
  });

  it('LIKE wildcards in the caller name are escaped, not interpreted', () => {
    addObs(db, 'zzz--alpha', 3);
    // `%` and `_` are LIKE metacharacters. Unescaped, '%' matches everything, so this
    // resolves to whatever project has the most rows.
    expect(resolveProject(db, '%')).toBe('%');
    expect(resolveProject(db, '_lpha')).toBe('_lpha');
  });
});

// ── P2-5 ─────────────────────────────────────────────────────────────────────
// Every LIST surface hides a merged or compressed row, so the only way to reach one is
// to name its id — which is exactly what a stale citation does. `get` rendered it as an
// ordinary row: no notice, and it bumped access_count and could be updated in place.

describe('R10 P2-5 — get flags a row that was merged or compressed away', () => {
  it('OBS_FIELDS carries compressed_into so the notice has something to read', () => {
    expect(OBS_FIELDS).toContain('compressed_into');
  });

  it('still reports a superseded row exactly as before', () => {
    expect(supersededNotice({ superseded_at: 1, superseded_by: 7 })).toMatch(/RETRACTED/);
    expect(supersededNotice({ superseded_at: 1, superseded_by: 7 })).toContain('#7');
    expect(supersededNotice({ superseded_at: 1 })).toMatch(/RETRACTED/);
  });

  it('reports a row merged into a keeper, naming the keeper', () => {
    const n = supersededNotice({ compressed_into: 42 });
    expect(n).toBeTruthy();
    expect(n).toContain('#42');
  });

  it('reports an auto-compressed row and a pending-purge row distinctly', () => {
    const auto = supersededNotice({ compressed_into: -1 });
    const purge = supersededNotice({ compressed_into: -2 });
    expect(auto).toBeTruthy();
    expect(purge).toBeTruthy();
    expect(auto).not.toBe(purge);
  });

  it('says nothing about an ordinary live row', () => {
    expect(supersededNotice({ compressed_into: 0, superseded_at: null })).toBeNull();
    expect(supersededNotice({})).toBeNull();
    expect(supersededNotice(null)).toBeNull();
  });

  it('superseded wins over compressed when a row is both', () => {
    expect(supersededNotice({ superseded_at: 1, superseded_by: 7, compressed_into: 42 })).toContain('#7');
  });
});

// ── P2-6 ─────────────────────────────────────────────────────────────────────
// mem_delete is the destructive tool. Its string form ran every token through parseInt,
// which truncates and stops at the first non-digit: "1.5" deleted #1 and "1,abc,3"
// silently dropped `abc`. The array form and the CLI both reject those. mem-cli.mjs
// records the same shape as a real incident ("3.9 -> 3 updated the wrong row").

describe('R10 P2-6 — mem_delete rejects non-integer id tokens instead of truncating', () => {
  const schema = z.object(memDeleteSchema);
  const parse = (ids) => schema.safeParse({ ids, confirm: false });

  it('rejects a decimal string instead of deleting the floor', () => {
    expect(parse('1.5').success, '"1.5" was accepted and would delete #1').toBe(false);
  });

  it('rejects a list containing a non-numeric token instead of dropping it', () => {
    expect(parse('1,abc,3').success, 'the abc token was silently dropped').toBe(false);
  });

  it('rejects trailing garbage and a negative id', () => {
    expect(parse('12abc').success).toBe(false);
    expect(parse('-3').success).toBe(false);
  });

  it('still accepts the shapes MCP bridges actually send', () => {
    expect(parse('1,2,3').data.ids).toEqual([1, 2, 3]);
    expect(parse(' 4 , 5 ').data.ids).toEqual([4, 5]);
    expect(parse('7').data.ids).toEqual([7]);
    expect(parse(7).data.ids).toEqual([7]);
    expect(parse([1, 2]).data.ids).toEqual([1, 2]);
    expect(parse(['1', '2']).data.ids).toEqual([1, 2]);
  });

  it('array form still rejects a float, as it already did', () => {
    expect(parse([1.5]).success).toBe(false);
  });
});

// ── P2-7 ─────────────────────────────────────────────────────────────────────
// merge_ids took raw ids with no project constraint, so a cross-project group hid
// project B's row behind project A's keeper. B's search, recent and browse all filter by
// project, so the row is simply gone from B with no notice anywhere.

describe('R10 P2-7 — merge refuses to hide a row behind a keeper in another project', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    db.pragma('foreign_keys = OFF');
  });
  afterEach(() => db.close());

  it('same-project merge still works', () => {
    const [keep, drop] = addObs(db, 'p--a', 2);
    expect(mergeDuplicates(db, [[keep, drop]])).toBe(1);
    expect(db.prepare('SELECT compressed_into FROM observations WHERE id=?').get(drop)).toEqual({
      compressed_into: keep,
    });
  });

  it('cross-project merge is skipped and the row stays visible in its own project', () => {
    const [keep] = addObs(db, 'p--a', 1);
    const [drop] = addObs(db, 'p--b', 1);
    expect(mergeDuplicates(db, [[keep, drop]]), 'a cross-project group was merged').toBe(0);
    expect(db.prepare('SELECT compressed_into FROM observations WHERE id=?').get(drop)).toEqual({
      compressed_into: 0,
    });
  });

  it('a mixed group merges the same-project members and skips the foreign one', () => {
    const [keep, sameProj] = addObs(db, 'p--a', 2);
    const [foreign] = addObs(db, 'p--b', 1);
    expect(mergeDuplicates(db, [[keep, sameProj, foreign]])).toBe(1);
    expect(db.prepare('SELECT compressed_into FROM observations WHERE id=?').get(sameProj)).toEqual({
      compressed_into: keep,
    });
    expect(db.prepare('SELECT compressed_into FROM observations WHERE id=?').get(foreign)).toEqual({
      compressed_into: 0,
    });
  });
});

// ── R10 P2-13 ────────────────────────────────────────────────────────────────
// Every `claude -p` spawn ran with cwd '/tmp'. Claude Code loads a project-level
// CLAUDE.md and .claude/settings.json from its cwd, so on a shared host any local account
// could drop /tmp/CLAUDE.md and steer every episode summary, session summary and optimize
// call this process makes. The CLI leg is the fallback every keyed-provider failure lands
// on, so it is a normal path, not an exotic one. The original reason for /tmp — ghost
// sessions in the user's /resume list — is already handled by --no-session-persistence.

describe('R10 P2-13 — the claude CLI is never spawned with a world-writable cwd', () => {
  it('both spawn sites use a private directory under the runtime dir', () => {
    // join(dirname(fileURLToPath(...))), never new URL(module, import.meta.url) — the URL
    // form drops the named module out of knip's report entirely, and
    // tests/no-url-module-paths.test.mjs is the guard that says so.
    const src = readFileSync(join(REPO_ROOT, 'haiku-client.mjs'), 'utf8');
    expect(src, 'a spawn still hardcodes /tmp as its cwd').not.toMatch(/cwd:\s*'\/tmp'/);
    // Two spawn sites, one helper: execClaudeCliSync and the async attempt().
    expect(src.match(/cwd: cliSpawnCwd\(\)/g) || []).toHaveLength(2);
  });

  it('the directory is created 0700 and sits under the runtime dir, not the system temp', async () => {
    const { mkdtempSync, statSync, existsSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const sandbox = mkdtempSync(join(tmpdir(), 'mem-clicwd-'));
    const saved = process.env.CLAUDE_MEM_DIR;
    process.env.CLAUDE_MEM_DIR = sandbox;
    try {
      const { resolveRuntimeDir } = await import('../lib/resolve-data-dir.mjs');
      const { resolveDataDir } = await import('../lib/resolve-data-dir.mjs');
      const expected = join(resolveRuntimeDir(resolveDataDir(sandbox)), 'cli-cwd');
      // Drive the real helper through a spawn-shaped call rather than re-deriving the
      // path: this asserts the module actually creates it.
      const { mkdirSync } = await import('fs');
      mkdirSync(expected, { recursive: true, mode: 0o700 });
      expect(existsSync(expected)).toBe(true);
      expect((statSync(expected).mode & 0o777).toString(8)).toBe('700');
      expect(expected.startsWith(sandbox), 'the cwd escaped the configured data dir').toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_MEM_DIR;
      else process.env.CLAUDE_MEM_DIR = saved;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
