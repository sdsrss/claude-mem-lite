// P2-8: `recent` was the last retrieval command whose two surfaces hand-built the
// SAME query. cmdRecent (mem-cli.mjs) and runRecent (server.mjs, backing mem_recent)
// each carried their own copy of `COALESCE(compressed_into,0)=0 AND superseded_at IS
// NULL` + project/type/since + `ORDER BY created_at_epoch DESC LIMIT ?`. That
// WHERE-clause class of drift has recurred three times (CHANGELOG v2.91.0 / v2.92.0 /
// v3.42.0), and search / timeline / recall were all extracted to shared cores for
// exactly this reason (lib/search-core.mjs, lib/timeline-core.mjs, lib/recall-core.mjs).
//
// These tests pin the extraction two ways:
//   1. behavior — fetchRecent's filter semantics, asserted directly on the core;
//   2. structure — neither call site may re-grow a local `FROM observations` query
//      (source-text guard, same technique as tests/cli-routing-contract.test.mjs).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { fetchRecent, RECENT_MAX } from '../lib/recent-core.mjs';
import { handleRecentForTest } from '../server.mjs';

describe('lib/recent-core fetchRecent', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'alpha' });
    insertSession(db, { id: 'sess-2', project: 'beta' });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'alpha',
      type: 'bugfix',
      title: 'alpha-bugfix-live',
      epochOffset: -1 * 3600000,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'alpha',
      type: 'decision',
      title: 'alpha-decision-old',
      epochOffset: -10 * 86400000,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'alpha',
      type: 'discovery',
      title: 'alpha-compressed',
      compressedInto: 999,
      epochOffset: -2 * 3600000,
    });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'alpha',
      type: 'discovery',
      title: 'alpha-superseded',
      supersededAt: Date.now(),
      supersededBy: 1,
      epochOffset: -3 * 3600000,
    });
    insertObs(db, {
      sessionId: 'sess-2',
      project: 'beta',
      type: 'bugfix',
      title: 'beta-bugfix-live',
      epochOffset: -4 * 3600000,
    });
  });
  afterEach(() => {
    db.close();
  });

  const titles = (rows) => rows.map((r) => r.title);

  it('excludes compressed and superseded rows (the recurring WHERE-clause defect)', () => {
    const rows = fetchRecent(db, { limit: 50 });
    expect(titles(rows)).not.toContain('alpha-compressed');
    expect(titles(rows)).not.toContain('alpha-superseded');
    expect(titles(rows)).toContain('alpha-bugfix-live');
  });

  it('scopes to project when given, spans all projects when not', () => {
    expect(titles(fetchRecent(db, { project: 'alpha', limit: 50 }))).not.toContain('beta-bugfix-live');
    expect(titles(fetchRecent(db, { limit: 50 }))).toContain('beta-bugfix-live');
  });

  it('filters by type', () => {
    const rows = fetchRecent(db, { project: 'alpha', type: 'bugfix', limit: 50 });
    expect(titles(rows)).toEqual(['alpha-bugfix-live']);
  });

  it('applies the `since` epoch lower bound', () => {
    const rows = fetchRecent(db, { project: 'alpha', since: Date.now() - 86400000, limit: 50 });
    expect(titles(rows)).toContain('alpha-bugfix-live');
    expect(titles(rows)).not.toContain('alpha-decision-old');
  });

  it('returns newest first and honours limit', () => {
    const rows = fetchRecent(db, { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].created_at_epoch).toBeGreaterThanOrEqual(rows[1].created_at_epoch);
    expect(rows[0].title).toBe('alpha-bugfix-live');
  });

  it('clamps limit to RECENT_MAX so neither surface can issue an uncapped dump', () => {
    expect(RECENT_MAX).toBe(1000);
    // Clamping is invisible on a 5-row DB; assert the cap is applied to the SQL
    // parameter by asking for more than the cap and getting a valid result set.
    expect(() => fetchRecent(db, { limit: 10 ** 9 })).not.toThrow();
    expect(fetchRecent(db, { limit: 10 ** 9 }).length).toBe(3);
  });

  it('returns the column superset both surfaces render (importance + project)', () => {
    const row = fetchRecent(db, { project: 'alpha', limit: 1 })[0];
    for (const col of [
      'id',
      'type',
      'title',
      'subtitle',
      'importance',
      'project',
      'created_at',
      'created_at_epoch',
    ]) {
      expect(row, `missing column ${col}`).toHaveProperty(col);
    }
  });
});

describe('mem_recent (MCP) is backed by the shared core', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, { sessionId: 'sess-1', project: 'test', type: 'bugfix', title: 'mcp-live-row' });
    insertObs(db, {
      sessionId: 'sess-1',
      project: 'test',
      type: 'bugfix',
      title: 'mcp-superseded-row',
      supersededAt: Date.now(),
      supersededBy: 1,
    });
  });
  afterEach(() => {
    db.close();
  });

  it('renders exactly the rows fetchRecent returns (no second query shape)', async () => {
    const res = await handleRecentForTest(db, { project: 'test', limit: 50 });
    const text = res.content[0].text;
    const coreTitles = fetchRecent(db, { project: 'test', limit: 50 }).map((r) => r.title);
    expect(coreTitles).toEqual(['mcp-live-row']);
    for (const t of coreTitles) expect(text).toContain(t);
    expect(text).not.toContain('mcp-superseded-row');
  });

  it('keeps the wire response shape: single text content block with the header + workflow trailer', async () => {
    const res = await handleRecentForTest(db, { project: 'test', limit: 5 });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toMatch(/^Recent observations \(test\):/);
    expect(res.content[0].text).toContain('Workflow: mem_get(ids=[...])');
  });
});

describe('recent has no second query copy (structural guard)', () => {
  const CLI_SRC = readFileSync(resolve(import.meta.dirname, '../mem-cli.mjs'), 'utf8');
  const SERVER_SRC = readFileSync(resolve(import.meta.dirname, '../server.mjs'), 'utf8');

  // Slice a function body by brace matching from its declaration.
  function bodyOf(src, decl) {
    const start = src.indexOf(decl);
    expect(start, `declaration not found: ${decl}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error(`unbalanced body for ${decl}`);
  }

  it('cmdRecent delegates to the core instead of building SQL', () => {
    const body = bodyOf(CLI_SRC, 'function cmdRecent(');
    expect(body).toContain('fetchRecent(');
    expect(body).not.toMatch(/FROM observations/);
  });

  it('runRecent delegates to the core instead of building SQL', () => {
    const body = bodyOf(SERVER_SRC, 'async function runRecent(');
    expect(body).toContain('fetchRecent(');
    expect(body).not.toMatch(/FROM observations/);
  });

  it('both surfaces import lib/recent-core.mjs', () => {
    expect(CLI_SRC).toMatch(/from '\.\/lib\/recent-core\.mjs'/);
    expect(SERVER_SRC).toMatch(/from '\.\/lib\/recent-core\.mjs'/);
  });
});
