// Cross-surface parity: the CLI (cmdSearch) and MCP (mem_search) search surfaces
// now share ONE orchestrator (coreRunSearchPipeline, lib/search-core.mjs). This is
// the structural guarantee that replaced the ~34 hand-maintained "paired-path"
// sync comments (audit P1-2): for the same query + equivalent explicit args, both
// surfaces must return the identical result set — same source+id order, the same
// scores, and the same total.
//
// The two surfaces have legitimately different DEFAULTS (MCP deep=auto vs CLI
// normal; the obs-only force rule). To measure ORCHESTRATOR parity rather than
// default-policy parity, every scenario drives both seams with explicit equivalent
// args and passes no llm (so auto-escalation never fires on either side).

import { describe, test, expect, beforeAll } from 'vitest';
import { createTestDb, insertSession, insertObs, insertPrompt } from './test-helpers.mjs';
import { handleSearchForTest } from '../server.mjs';
import { cmdSearchForTest } from '../mem-cli.mjs';

// Minimal LLM stub (mirrors tests/deep-search.test.mjs:29): async fn returning the
// configured response, clamped to the last; .calls() tracks invocations. A fresh
// stub per surface keeps each call counter independent.
function stubLLM(...responses) {
  let i = 0;
  const fn = async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof r === 'function' ? r() : r;
  };
  fn.calls = () => i;
  return fn;
}

let db;

beforeAll(() => {
  db = createTestDb();
  // Session first — observations FK-reference sdk_sessions(memory_session_id), and
  // initSchema leaves foreign_keys ON (#8611). sess-1 also backs the prompt FTS join.
  insertSession(db, { id: 'sess-1', project: 'test' });
  // Observations sharing the keyword "parity", varied type / recency / files.
  insertObs(db, {
    type: 'bugfix',
    title: 'parity drift in finalizeSearchPage',
    text: 'parity tail count',
    importance: 3,
    epochOffset: -1000,
    filesModified: JSON.stringify(['lib/search-core.mjs']),
  });
  insertObs(db, {
    type: 'decision',
    title: 'parity via paired-path comments',
    text: 'parity sync',
    importance: 2,
    epochOffset: -2000,
  });
  insertObs(db, {
    type: 'discovery',
    title: 'parity test seam threads db',
    text: 'parity ctx',
    importance: 1,
    epochOffset: -3000,
  });
  insertObs(db, {
    type: 'bugfix',
    title: 'parity score normalization',
    text: 'parity bm25',
    importance: 2,
    epochOffset: -4000,
    filesModified: JSON.stringify(['server.mjs', 'mem-cli.mjs']),
  });
  insertObs(db, {
    type: 'refactor',
    title: 'unrelated cache change',
    text: '缓存 优化 路径',
    importance: 1,
    epochOffset: -5000,
  });

  // Pad the live corpus past AUTO_DEEP_MIN_CORPUS (10) so auto-escalation's corpus
  // guard (hasEscalatableCorpus) fires; all carry "parity" so deep-fusion variants
  // hit them. Distinct epochs avoid score/recency ties (stable order across surfaces).
  for (let i = 0; i < 7; i++) {
    insertObs(db, {
      type: 'discovery',
      title: `parity corpus filler ${i}`,
      text: 'parity corpus filler',
      importance: 1,
      epochOffset: -6000 - i * 100,
    });
  }

  // Sessions (session_summaries drives session FTS via the au trigger; its
  // memory_session_id FK-references sdk_sessions, so seed those rows first).
  insertSession(db, { id: 'csess-1', memoryId: 'msess-1', project: 'test' });
  insertSession(db, { id: 'csess-2', memoryId: 'msess-2', project: 'test' });
  const ins = db.prepare(
    `INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ins.run(
    'msess-1',
    'test',
    'investigate parity between CLI and MCP search',
    'unified the orchestrator',
    new Date(Date.now() - 1500).toISOString(),
    Date.now() - 1500,
  );
  ins.run(
    'msess-2',
    'test',
    'parity follow-up: delete sync comments',
    'done',
    new Date(Date.now() - 2500).toISOString(),
    Date.now() - 2500,
  );

  // Prompts (sess-1 sdk_sessions row seeded above backs the FTS join).
  insertPrompt(db, {
    contentSessionId: 'sess-1',
    text: 'how do we keep search parity across surfaces?',
    promptNumber: 1,
    epochOffset: -1200,
  });
  insertPrompt(db, {
    contentSessionId: 'sess-1',
    text: '缓存 路径 parity 检查',
    promptNumber: 2,
    epochOffset: -2200,
  });

  // Events — the canonical event-typed store (events_fts populated via the ai trigger). P1-3
  // wired this as the 4th cross-source leg, so both surfaces must interleave events identically.
  const insE = db.prepare(
    `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insE.run(
    'test',
    'bugfix',
    'parity event: fixed cross-source count',
    'the parity total now includes events',
    2,
    Date.now() - 1800,
  );
  insE.run(
    'test',
    'decision',
    'parity event: interleave events by score',
    'parity ranking decision body',
    2,
    Date.now() - 2800,
  );
});

/** Run the MCP seam → normalized [{source,id,score}] + total + deepRan. */
async function runMcp(args, llm = null) {
  const res = await handleSearchForTest(db, args, llm ? { llm } : {});
  return {
    total: res.total,
    rows: res.results.map((r) => ({ source: r.source, id: r.id, score: r.score ?? null })),
    deepRan: res.variants !== null, // variants is null-or-array; non-null whenever deep ran (explicit or auto-escalated)
  };
}

/** Run the CLI seam (--json) capturing stdout → normalized [{source,id,score}] + total + deepRan. */
async function runCli(argv, llm = null) {
  let stdout = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => {
    stdout += s;
    return true;
  };
  process.stderr.write = () => true; // swallow the deep/escalation notes
  try {
    await cmdSearchForTest(db, [...argv, '--json'], llm ? { llm } : {});
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const parsed = JSON.parse(stdout.trim());
  return {
    total: parsed.total,
    rows: parsed.results.map((r) => ({ source: r.source, id: r.id, score: r.score ?? null })),
    deepRan: parsed.deep === true,
  };
}

function key(rows) {
  return rows.map((r) => `${r.source}#${r.id}`);
}

/**
 * @param {string} name
 * @param {object} mcpArgs  explicit MCP args
 * @param {string[]} cliArgv equivalent CLI argv (positional query + flags)
 * @param {{ llm?: () => Function, autoDeep?: boolean, expectDeep?: boolean }} [opts]
 *   llm: factory returning a FRESH stub per surface (independent call counters);
 *   autoDeep: set CLAUDE_MEM_AUTO_DEEP=1 around the run (CLI opts into auto-escalation);
 *   expectDeep: assert BOTH surfaces took the deep path — guards the scenario against
 *   passing as a silent no-op (e.g. escalation that never fired).
 */
function parity(name, mcpArgs, cliArgv, { llm = null, autoDeep = false, expectDeep = false } = {}) {
  test(name, async () => {
    const prevEnv = process.env.CLAUDE_MEM_AUTO_DEEP;
    if (autoDeep) process.env.CLAUDE_MEM_AUTO_DEEP = '1';
    try {
      const mcp = await runMcp(mcpArgs, llm ? llm() : null);
      const cli = await runCli(cliArgv, llm ? llm() : null);
      // Identical id-order (the load-bearing parity assertion).
      expect(key(cli.rows)).toEqual(key(mcp.rows));
      // Identical population.
      expect(cli.total).toBe(mcp.total);
      // Identical scores. Tolerance 6 digits: the only difference is recency decay
      // (EXP over Date.now()), since the two seams run a few ms apart — a real
      // scoring divergence would be orders of magnitude larger. (Deep/RRF scores are
      // rank-based, so they compare exactly.)
      expect(cli.rows.length).toBe(mcp.rows.length);
      for (let i = 0; i < mcp.rows.length; i++) {
        if (mcp.rows[i].score === null || cli.rows[i].score === null) {
          expect(cli.rows[i].score).toBe(mcp.rows[i].score);
        } else {
          expect(cli.rows[i].score).toBeCloseTo(mcp.rows[i].score, 6);
        }
      }
      if (expectDeep) {
        expect(mcp.deepRan).toBe(true);
        expect(cli.deepRan).toBe(true);
      }
    } finally {
      if (autoDeep) {
        if (prevEnv === undefined) delete process.env.CLAUDE_MEM_AUTO_DEEP;
        else process.env.CLAUDE_MEM_AUTO_DEEP = prevEnv;
      }
    }
  });
}

describe('CLI ↔ MCP search parity (audit P1-2 — one orchestrator)', () => {
  parity('cross-source FTS query', { query: 'parity', deep: false }, ['parity', '--no-deep']);
  parity('obs-only by type (bugfix)', { query: 'parity', obs_type: 'bugfix', deep: false }, [
    'parity',
    '--type',
    'bugfix',
    '--no-deep',
  ]);
  parity('source=sessions', { query: 'parity', type: 'sessions', deep: false }, [
    'parity',
    '--source',
    'sessions',
    '--no-deep',
  ]);
  parity('source=prompts', { query: 'parity', type: 'prompts', deep: false }, [
    'parity',
    '--source',
    'prompts',
    '--no-deep',
  ]);
  parity('source=events', { query: 'parity', type: 'events', deep: false }, [
    'parity',
    '--source',
    'events',
    '--no-deep',
  ]);
  parity('paging (offset 1, limit 2)', { query: 'parity', offset: 1, limit: 2, deep: false }, [
    'parity',
    '--offset',
    '1',
    '--limit',
    '2',
    '--no-deep',
  ]);
  parity('sort=time', { query: 'parity', sort: 'time', deep: false }, [
    'parity',
    '--sort',
    'time',
    '--no-deep',
  ]);
  parity('CJK query (prompt CJK fallback path)', { query: '缓存', deep: false }, ['缓存', '--no-deep']);

  // Obs-only field filters (importance/branch/tier) must force observations-only on BOTH
  // surfaces. The session/prompt legs have no importance/branch/tier column, so if the
  // surface doesn't force obs-only they come back UNFILTERED — session/prompt rows that
  // can't possibly be scoped to the filter leak in. The CLI forced this (mem-cli.mjs:177);
  // MCP forced only for obs_type, so importance/branch/tier leaked cross-source rows.
  parity(
    'importance filter forces obs-only (no session/prompt leak)',
    { query: 'parity', importance: 3, deep: false },
    ['parity', '--importance', '3', '--no-deep'],
  );
  parity(
    'branch filter forces obs-only (no session/prompt leak)',
    { query: 'parity', branch: 'main', deep: false },
    ['parity', '--branch', 'main', '--no-deep'],
  );

  // tier: full CLI/MCP parity is NOT assertable — tierPosition is a deliberate per-surface
  // asymmetry (#8786: CLI 'early' filters inside the obs block so `total` drops; MCP 'late'
  // post-filters after re-rank so `total` counts pre-tier). The M4 contract for tier is only
  // that it forces obs-only so no session/prompt row (which has no tier column) leaks — those
  // rows otherwise bypass applyTierFilter entirely (search-core.mjs:245) and survive.
  test('tier filter forces observations-only on MCP (no session/prompt leak)', async () => {
    const res = await handleSearchForTest(db, { query: 'parity', tier: 'working', deep: false }, {});
    expect(res.results.some((r) => r.source === 'session' || r.source === 'prompt')).toBe(false);
  });

  // Deep path: both surfaces route through the SAME injected deepSearch (LLM rewrite
  // → RRF fusion), so the fused obs set + order must match exactly. rerankPolicy
  // differs (mcp/cli) but converges here — both re-rank with the same project.
  parity(
    'explicit --deep (LLM rewrite + RRF fusion)',
    { query: 'parity', deep: true },
    ['parity', '--deep'],
    { llm: () => stubLLM({ variants: ['parity drift', 'parity normalization'] }), expectDeep: true },
  );

  // Auto-escalation: a 0-hit query over a >MIN_CORPUS corpus escalates on BOTH
  // surfaces (MCP auto by default; CLI via CLAUDE_MEM_AUTO_DEEP=1) and fuses the same
  // variant set. The stub variant ('parity') hits the seeded corpus.
  parity('auto-escalation on a weak query', { query: 'zzznomatchqxz' }, ['zzznomatchqxz'], {
    llm: () => stubLLM({ variants: ['parity'] }),
    autoDeep: true,
    expectDeep: true,
  });
});

describe('date_since end-to-end (MCP date_since == CLI --since)', () => {
  test('excludes rows older than the relative window on both surfaces, identically', async () => {
    // Fresh DB so the relative window discriminates (the shared corpus is all ms-old).
    const fdb = createTestDb();
    try {
      insertSession(fdb, { id: 'ds-sess', project: 'dstest' });
      insertObs(fdb, {
        sessionId: 'ds-sess',
        project: 'dstest',
        title: 'sincetoken fresh',
        text: 'sincetoken fresh',
        epochOffset: -2 * 3600000,
      }); // 2h ago
      insertObs(fdb, {
        sessionId: 'ds-sess',
        project: 'dstest',
        title: 'sincetoken stale',
        text: 'sincetoken stale',
        epochOffset: -10 * 86400000,
      }); // 10d ago

      const mcp = await handleSearchForTest(
        fdb,
        { query: 'sincetoken', project: 'dstest', date_since: '24h' },
        {},
      );

      let stdout = '';
      const o = process.stdout.write,
        e = process.stderr.write;
      process.stdout.write = (s) => {
        stdout += s;
        return true;
      };
      process.stderr.write = () => true;
      try {
        await cmdSearchForTest(fdb, ['sincetoken', '--project', 'dstest', '--since', '24h', '--json'], {});
      } finally {
        process.stdout.write = o;
        process.stderr.write = e;
      }
      const cli = JSON.parse(stdout.trim());

      // 24h window keeps only the 2h-old row on the MCP surface…
      expect(mcp.results.length).toBe(1);
      expect(mcp.results[0].title).toContain('fresh');
      // …and the CLI --since surface returns the identical id set (parity).
      expect(cli.results.map((r) => `${r.source}#${r.id}`)).toEqual(
        mcp.results.map((r) => `${r.source}#${r.id}`),
      );

      // Invalid relative duration is rejected by the MCP handler.
      await expect(
        handleSearchForTest(fdb, { query: 'sincetoken', date_since: '7days' }, {}),
      ).rejects.toThrow(/date_since/);
    } finally {
      fdb.close();
    }
  });
});

describe('P1-3: events are reachable by mem_search (canonical event-typed store)', () => {
  test('cross-source search surfaces event rows that were previously unreachable', async () => {
    const mcp = await runMcp({ query: 'parity', deep: false });
    const events = mcp.rows.filter((r) => r.source === 'event');
    expect(events.length).toBeGreaterThanOrEqual(1); // seeded "parity event" rows now surface
  });

  test('source=events returns ONLY events (and the total counts them)', async () => {
    const mcp = await runMcp({ query: 'parity', type: 'events', deep: false });
    expect(mcp.rows.length).toBeGreaterThanOrEqual(1);
    expect(mcp.rows.every((r) => r.source === 'event')).toBe(true);
    expect(mcp.total).toBeGreaterThanOrEqual(mcp.rows.length);
  });

  test('superseded events stay out of search', async () => {
    const fdb = createTestDb();
    try {
      insertSession(fdb, { id: 's-sup', project: 'sup' });
      const insE = fdb.prepare(
        `INSERT INTO events (project, event_type, title, body, importance, created_at_epoch, superseded_at_epoch) VALUES (?, ?, ?, ?, 2, ?, ?)`,
      );
      insE.run('sup', 'bugfix', 'zebracrossing live event', 'body', Date.now(), null);
      insE.run('sup', 'bugfix', 'zebracrossing retired event', 'body', Date.now(), Date.now());
      const mcp = await handleSearchForTest(fdb, { query: 'zebracrossing', type: 'events', deep: false }, {});
      expect(mcp.results.length).toBe(1);
      expect(mcp.results[0].title).toContain('live');
    } finally {
      fdb.close();
    }
  });
});
