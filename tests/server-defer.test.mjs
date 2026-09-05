import { describe, it, expect } from 'vitest';
import { tools } from '../tool-schemas.mjs';
import { createTestDb } from './test-helpers.mjs';
import { insertDeferred, resolveDeferredIds, closeDeferredItems } from '../lib/deferred-work.mjs';
import { execSync } from 'child_process';
import { rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

describe('MCP tool registration — defer family', () => {
  it('registers mem_defer / mem_defer_list / mem_defer_drop', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('mem_defer');
    expect(names).toContain('mem_defer_list');
    expect(names).toContain('mem_defer_drop');
  });

  it('mem_defer description follows DO-NOT/USE-when template', () => {
    const t = tools.find((t) => t.name === 'mem_defer');
    expect(t.description).toMatch(/DO NOT use when/);
    expect(t.description).toMatch(/USE when/);
    expect(t.description).toMatch(/Equivalent CLI/);
  });

  it('mem_defer schema requires title + accepts priority 1..3', () => {
    const t = tools.find((t) => t.name === 'mem_defer');
    // title required
    expect(() => t.inputSchema.title.parse(undefined)).toThrow();
    expect(t.inputSchema.title.parse('hello')).toBe('hello');
    // priority bounded
    expect(t.inputSchema.priority.parse(2)).toBe(2);
    expect(() => t.inputSchema.priority.parse(4)).toThrow();
  });

  it('memSaveSchema gains optional closes_deferred mixed array', () => {
    const t = tools.find((t) => t.name === 'mem_save');
    // closes_deferred should be optional (parse undefined OK)
    expect(t.inputSchema.closes_deferred.parse(undefined)).toBeUndefined();
    // accepts mixed [number, "D#N"]
    expect(t.inputSchema.closes_deferred.parse([1, 'D#42'])).toEqual([1, 'D#42']);
    // rejects unknown string shape
    expect(() => t.inputSchema.closes_deferred.parse(['#5'])).toThrow();
  });
});

describe('mem_save closes_deferred end-to-end', () => {
  it('closes deferred via ordinal in same transaction (real path simulation)', () => {
    const db = createTestDb();
    const project = 'test-proj';
    const a = insertDeferred(db, { project, title: 'Round 2 zero-byte', priority: 3 });
    // FK to observations(id) — disable BEFORE the transaction (pragma changes
    // don't take effect mid-transaction for FK enforcement).
    db.pragma('foreign_keys = OFF');
    // Simulate what the mem_save handler does: resolve, insert obs, close items.
    db.transaction(() => {
      const ids = resolveDeferredIds(db, project, [1]); // ordinal 1
      // fake obs insert returning id 1234 — in real handler this is saveObservation
      const obsId = 1234;
      closeDeferredItems(db, ids, obsId);
    })();
    const row = db.prepare(`SELECT status, closed_by_obs_id FROM deferred_work WHERE id=?`).get(a.id);
    expect(row.status).toBe('done');
    expect(row.closed_by_obs_id).toBe(1234);
    db.close();
  });

  it('closes via mixed [ordinal, "D#N"] array', () => {
    const db = createTestDb();
    const project = 'p';
    const a = insertDeferred(db, { project, title: 'A', priority: 2 });
    const b = insertDeferred(db, { project, title: 'B', priority: 3 });
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      // Ordinal 1 = B (priority 3), D#a.id = A
      const ids = resolveDeferredIds(db, project, [1, `D#${a.id}`]);
      closeDeferredItems(db, ids, 5678);
    })();
    expect(db.prepare(`SELECT status FROM deferred_work WHERE id=?`).get(a.id).status).toBe('done');
    expect(db.prepare(`SELECT status FROM deferred_work WHERE id=?`).get(b.id).status).toBe('done');
    db.close();
  });
});

describe('mem_save closes_deferred MCP-side dedup-replay (parity with CLI)', () => {
  it('duplicate save with closes_deferred returns idempotent skip via CLI (proxy for MCP handler)', () => {
    // CLI uses the same handler shape as MCP after the parity fix; this test
    // pins both. A pure-MCP spawn fixture would be heavier; the CLI shortcut
    // exercises the same db.transaction body.
    const dir = join(tmpdir(), 'mem-mcp-defer-replay-' + randomUUID().slice(0, 8));
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, CLAUDE_MEM_DIR: dir, CLAUDE_PROJECT_DIR: '/tmp/proj-mcp-defer-replay' };
    delete env.CLAUDE_MEM_HOOK_RUNNING;
    try {
      const cli = join(process.cwd(), 'cli.mjs');
      // Add a deferred item
      execSync(`node ${cli} defer add "subject" --priority 2`, { env, encoding: 'utf8' });
      // First save with --closes-deferred 1 — closes the item
      const out1 = execSync(
        `node ${cli} save "fix subject" --type bugfix --lesson "fix" --closes-deferred 1`,
        { env, encoding: 'utf8' },
      );
      expect(out1).toMatch(/Closed: D#\d+/);
      // Second save with same args — must return Skipped, NOT throw
      const out2 = execSync(
        `node ${cli} save "fix subject" --type bugfix --lesson "fix" --closes-deferred 1`,
        { env, encoding: 'utf8' },
      );
      expect(out2).toMatch(/Skipped: similar to existing #\d+/);
      // Critical: the second call must NOT include "Closed: D#" (closure was skipped on dedup path)
      expect(out2).not.toMatch(/Closed: D#/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
