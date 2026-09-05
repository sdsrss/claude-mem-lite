// A retracted (superseded) observation fetched BY ID must say so before its body.
//
// Every list surface — search / recent / timeline / browse / all four injection faces —
// filters `superseded_at IS NOT NULL` out. So the only way to reach a retracted row is to
// name its id, which is exactly what a stale citation does: an old transcript line, a note
// in CLAUDE.md, a handoff, or a user typing `get 1`. Both detail faces render fields in
// OBS_FIELDS order, which puts `lesson_learned` near the top and `superseded_at` ~15 lines
// below — so the first actionable line a reader takes away is the WITHDRAWN advice, and
// the marker that invalidates it arrives last, if at all (both faces truncate long rows).
//
// Observed on v3.68.1 with a retracted row #1 superseded by #2:
//   $ claude-mem-lite get 1
//   #1 [bugfix] 2026-08-17
//   title: OAuth callback loops forever …
//   lesson_learned: WRONG ADVICE: disable state validation entirely     ← read first
//   … 10 more lines …
//   superseded_at: 1786984985036 (just now)                            ← read last
//
// Asserted on both faces because get-core's own header comment says each face keeps its
// own header rendering — the exact shape that drifted before (MCP 13 fields vs CLI 6).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { supersededNotice } from '../lib/get-core.mjs';

const CLI = resolve(import.meta.dirname, '../cli.mjs');
const SERVER = resolve(import.meta.dirname, '../server.mjs');
const BAD = 'WRONG ADVICE: disable state validation entirely';

let dir, env;

function seed() {
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  initSchema(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
              VALUES ('cc', 'mem', 'p--proj', datetime('now'), ?)`,
  ).run(now);
  const ins = db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts,
                              facts, files_read, files_modified, importance, lesson_learned,
                              superseded_at, superseded_by, created_at, created_at_epoch)
    VALUES ('mem', 'p--proj', ?, 'bugfix', ?, '', ?, '', '', '[]', '[]', 3, ?, ?, ?, ?, ?)`);
  const retracted = Number(
    ins.run(
      'OAuth callback loops forever because the state param is dropped',
      'OAuth callback loops forever',
      'OAuth callback loops forever because the state param is dropped',
      BAD,
      now,
      2,
      new Date(now).toISOString(),
      now,
    ).lastInsertRowid,
  );
  const keeper = Number(
    ins.run(
      'OAuth callback loop: persist the state param in the session store',
      'OAuth callback loop: persist the state param',
      'OAuth callback loop: persist the state param in the session store',
      'Persist the OAuth state param; never disable validation',
      null,
      null,
      new Date(now).toISOString(),
      now,
    ).lastInsertRowid,
  );
  db.close();
  return { retracted, keeper };
}

function cliGet(id) {
  return execFileSync(process.execPath, [CLI, 'get', String(id)], { env, encoding: 'utf8' });
}

function mcpGet(id) {
  const reqs =
    [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mem_get","arguments":{"ids":[${id}]}}}`,
    ].join('\n') + '\n';
  const raw = execFileSync(process.execPath, [SERVER], {
    env,
    input: reqs,
    encoding: 'utf8',
    timeout: 30000,
  });
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const m = JSON.parse(line);
      if (m.id === 2) return m.result?.content?.[0]?.text || '';
    } catch {
      /* server also logs non-JSON lines */
    }
  }
  return '';
}

describe('get / mem_get — retracted rows announce the retraction first', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retracted-'));
    env = {
      ...process.env,
      CLAUDE_MEM_DIR: dir,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
    };
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  });

  it('CLI `get` puts the notice ahead of the withdrawn lesson', () => {
    const { retracted, keeper } = seed();
    const out = cliGet(retracted);
    expect(out).toContain('RETRACTED');
    expect(out).toContain(`#${keeper}`);
    // Ordering is the whole point: a reader who stops early must hit the warning first.
    expect(out.indexOf('RETRACTED')).toBeLessThan(out.indexOf(BAD));
  });

  it('MCP `mem_get` does the same (no face drift)', () => {
    const { retracted, keeper } = seed();
    const out = mcpGet(retracted);
    expect(out).toContain('RETRACTED');
    expect(out).toContain(`#${keeper}`);
    expect(out.indexOf('RETRACTED')).toBeLessThan(out.indexOf(BAD));
  });

  it('says nothing on a live row', () => {
    const { keeper } = seed();
    expect(cliGet(keeper)).not.toContain('RETRACTED');
    expect(mcpGet(keeper)).not.toContain('RETRACTED');
  });

  it('still warns when the supersessor id is unknown (string marker rows)', () => {
    // auto-dedup writes non-numeric superseded_by values ('auto-dedup-fuzzy'); the row is
    // still retracted and must still say so, just without a "read #N instead" pointer.
    expect(supersededNotice({ superseded_at: 123, superseded_by: 'auto-dedup-fuzzy' })).toMatch(/RETRACTED/);
    expect(supersededNotice({ superseded_at: 123, superseded_by: 'auto-dedup-fuzzy' })).not.toMatch(/#/);
    expect(supersededNotice({ superseded_at: null, superseded_by: null })).toBe(null);
  });
});
