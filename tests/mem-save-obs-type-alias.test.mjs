// mem_save must not silently ignore `obs_type`.
//
// mem_search / mem_recall / mem_recent all name the observation-type field `obs_type`
// (mem_recent additionally accepts `type` as an alias). mem_save named it ONLY `type`, and
// the MCP input schemas are non-strict — so the shape a caller naturally reaches for right
// after a search:
//
//   mem_save({content: "…", obs_type: "bugfix"})
//
// dropped the unknown key and saved a `discovery` row, reporting success. That is not
// cosmetic: `type` feeds the type_quality ranking multiplier, and the row becomes
// invisible to every `--type bugfix` / `obs_type: "bugfix"` filter the user later runs —
// so the memory is stored and unfindable by the query that should find it. The CLI face
// rejects an unknown `--type` outright, making this a one-sided guard (the recurring
// "protection wired to one face" class).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { memSaveSchema } from '../tool-schemas.mjs';

const SERVER = resolve(import.meta.dirname, '../server.mjs');
let dir, env;

function callTool(name, args) {
  const reqs =
    [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
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
      if (m.id === 2) return m.result?.content?.[0]?.text || JSON.stringify(m.error);
    } catch {
      /* server also logs non-JSON lines */
    }
  }
  return '';
}

function call(args) {
  const reqs =
    [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'mem_save', arguments: args },
      }),
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
      if (m.id === 2) return m.result?.content?.[0]?.text || JSON.stringify(m.error);
    } catch {
      /* server also logs non-JSON lines */
    }
  }
  return '';
}

function typesInDb() {
  const db = new Database(join(dir, 'claude-mem-lite.db'), { readonly: true });
  try {
    return db.prepare('SELECT id, type FROM observations ORDER BY id').all();
  } finally {
    db.close();
  }
}

describe('mem_save — obs_type alias parity', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memsave-alias-'));
    env = {
      ...process.env,
      CLAUDE_MEM_DIR: dir,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_PROJECT_DIR: '/x/aliasproj',
      PWD: '/x/aliasproj',
    };
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  });

  it('declares obs_type so the field is not an unknown key', () => {
    expect(Object.keys(memSaveSchema)).toContain('obs_type');
  });

  it('honours obs_type instead of silently defaulting to discovery', () => {
    const out = call({
      content: 'shard retry budget was shared so one hot shard starved the rest',
      obs_type: 'bugfix',
    });
    expect(out).toContain('[bugfix]');
    expect(typesInDb()).toEqual([{ id: 1, type: 'bugfix' }]);
  });

  it('rejects an invalid obs_type rather than coercing it', () => {
    const out = call({ content: 'this row must not be written at all', obs_type: 'nonsense' });
    expect(out).toContain('Invalid arguments');
    expect(typesInDb()).toEqual([]);
  });

  it('mem_update honours obs_type too (the adjacent tool, same class)', () => {
    // Found by the same pre-tag review: `mem_update({id, importance, obs_type})` reported
    // "Updated observation #N: importance" and dropped the type silently. obs_type ALONE
    // errored loudly ("No fields to update"), so only the mixed call lost data.
    call({ content: 'a row to relabel later', type: 'discovery' });
    const out = callTool('mem_update', { id: 1, importance: 3, obs_type: 'bugfix' });
    expect(out).not.toMatch(/not found/);
    expect(typesInDb()).toEqual([{ id: 1, type: 'bugfix' }]);
  });

  it('lets the canonical `type` win when both are given', () => {
    const out = call({ content: 'both fields supplied on purpose', type: 'decision', obs_type: 'bugfix' });
    expect(out).toContain('[decision]');
    expect(typesInDb()).toEqual([{ id: 1, type: 'decision' }]);
  });
});
