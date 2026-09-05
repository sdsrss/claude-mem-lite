// MCP protocol subprocess test — validates the server over real stdio JSON-RPC,
// not the handler functions in isolation.
//
// Why this is separate from unit tests: lessons #7837, #7843, #8126, #8127,
// #8139 are all CLI↔MCP parity / protocol-layer bugs (silent no-op,
// no-confirm destructive, prefix-token drift, read-path filter mismatch).
// Handler-level unit tests missed them because they hit function shapes,
// not the registered-tool surface. This file guards that layer.
//
// Shape:
//   1. Spawn server.mjs with an isolated CLAUDE_MEM_DIR (fresh DB).
//   2. Connect via StdioClientTransport (same as Claude Code).
//   3. Assert tools/list surface + a handful of critical tools/call contracts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';

const SERVER_PATH = resolve(import.meta.dirname, '../server.mjs');

// Per-suite isolated DB + runtime dir so the test never touches the user's
// real ~/.claude-mem-lite. Cleanup in afterAll.
const DB_DIR = `/tmp/mem-mcp-test-${process.pid}`;

let client;
let transport;

beforeAll(async () => {
  try {
    rmSync(DB_DIR, { recursive: true });
  } catch {}
  mkdirSync(`${DB_DIR}/runtime`, { recursive: true });

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: DB_DIR,
      CLAUDE_PROJECT_DIR: '/test/project',
      PWD: '/test/project',
      CLAUDE_MEM_AUTO_DEEP: '0',
    },
  });
  client = new Client({ name: 'mem-test-client', version: '0.0.0' });
  await client.connect(transport);
}, 15_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {}
  try {
    await transport?.close();
  } catch {}
  try {
    rmSync(DB_DIR, { recursive: true });
  } catch {}
});

// Helper: extract text payload from a tools/call result.
function textOf(result) {
  return (result?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

describe('MCP protocol surface', () => {
  it('tools/list exposes exactly the 9 promised core tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'mem_defer',
      'mem_defer_drop',
      'mem_defer_list',
      'mem_get',
      'mem_recall',
      'mem_recent',
      'mem_save',
      'mem_search',
      'mem_timeline',
    ]);
  });

  it('every exposed tool carries a non-empty description', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(50);
    }
  });

  it('hidden tool mem_stats is callable by exact name despite not being listed', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('mem_stats');
    // Direct call should still work (hidden, not unregistered).
    const res = await client.callTool({ name: 'mem_stats', arguments: {} });
    const text = textOf(res);
    expect(text).toMatch(/observations|sessions|prompts|Stats|projects/i);
  });

  // Regression guard for #7843: mem_maintain purge_stale silently deleted rows
  // without a confirm gate. The fix added `confirm: boolean` and makes the
  // default a dry-run preview. Real guard asserts row counts are invariant —
  // the earlier prose-only check passed even if the SQL fired, so long as
  // the response contained the word "preview" anywhere.
  it('mem_maintain execute purge_stale without confirm does NOT delete rows', async () => {
    // Seed 3 observations via the protocol so they live in the server's DB.
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'mem_save',
        arguments: {
          content: `Purge guard seed ${i}`,
          title: `guard-seed-${i}`,
          type: 'discovery',
        },
      });
    }
    // Baseline: read totals from the server's authoritative view.
    const before = await client.callTool({ name: 'mem_stats', arguments: {} });
    const beforeText = textOf(before);
    const beforeCount = Number(
      (beforeText.match(/Total:\s*([\d,]+)\s*observations/i) || [])[1]?.replace(/,/g, '') || 0,
    );
    expect(beforeCount).toBeGreaterThanOrEqual(3);

    // Actual call under test: execute purge_stale WITHOUT confirm.
    const res = await client.callTool({
      name: 'mem_maintain',
      arguments: { action: 'execute', operations: ['purge_stale'] },
    });
    const resText = textOf(res);
    // Response should clearly signal a dry-run — but text-only isn't enough.
    expect(resText.toLowerCase()).toMatch(/confirm|preview|dry|would/);

    // Hard assertion: row count is invariant after a no-confirm execute.
    const after = await client.callTool({ name: 'mem_stats', arguments: {} });
    const afterText = textOf(after);
    const afterCount = Number(
      (afterText.match(/Total:\s*([\d,]+)\s*observations/i) || [])[1]?.replace(/,/g, '') || 0,
    );
    expect(afterCount).toBe(beforeCount);
  });

  // Audit 2026-07-17 P4: mem_save on bugfix/decision without lesson_learned must
  // nudge in the response text (naming mem_update with the new id) — the model
  // still holds the debugging context at save time; a later backfill pass cannot
  // reconstruct it. With a lesson, or for low-obligation types, no nudge.
  it('mem_save nudges when a bugfix arrives without lesson_learned', async () => {
    const res = await client.callTool({
      name: 'mem_save',
      arguments: { content: 'Fixed a race in the flush path', title: 'nudge-probe-bugfix', type: 'bugfix' },
    });
    const text = textOf(res);
    expect(text).toMatch(/Saved as observation #\d+/);
    expect(text).toContain('without lesson_learned');
    expect(text).toMatch(/mem_update\(id=\d+/);
  });

  it('mem_save does NOT nudge with a lesson present or for discovery', async () => {
    const withLesson = textOf(
      await client.callTool({
        name: 'mem_save',
        arguments: {
          content: 'Fixed a race',
          title: 'nudge-probe-lesson',
          type: 'bugfix',
          lesson_learned: 'Hold the lock until the side-effect commits',
        },
      }),
    );
    expect(withLesson).toContain('lesson captured');
    expect(withLesson).not.toContain('without lesson_learned');

    const discovery = textOf(
      await client.callTool({
        name: 'mem_save',
        arguments: { content: 'Interesting corner', title: 'nudge-probe-discovery', type: 'discovery' },
      }),
    );
    expect(discovery).not.toContain('without lesson_learned');
  });

  // Regression guard for #7837: mem_search sort=time was a silent no-op
  // pre-v2.34.0. Calling with sort=time on an empty DB should at minimum
  // return a well-formed response (not throw), and not contradict its input.
  it('mem_search sort=time responds cleanly on empty DB', async () => {
    const res = await client.callTool({
      name: 'mem_search',
      arguments: { query: 'nonexistent-term-xyzq', sort: 'time' },
    });
    const text = textOf(res);
    expect(text).toBeTruthy();
    expect(text.toLowerCase()).toMatch(/no (results|match)|empty|0 /);
  });

  it('mem_recent returns a valid (possibly empty) list on fresh DB', async () => {
    const res = await client.callTool({ name: 'mem_recent', arguments: { limit: 5 } });
    const text = textOf(res);
    expect(text).toBeTruthy();
    expect(text.toLowerCase()).toMatch(/recent|no (recent|observ)/);
  });

  it('unknown tool name surfaces an explicit isError result (not a silent success)', async () => {
    // The MCP SDK returns { isError: true, content: [...] } rather than
    // throwing — callers must check isError. Assert shape, not rejection.
    const res = await client.callTool({ name: 'mem_totally_not_a_tool', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not found|unknown/i);
  });

  // Regression guard: single-source mem_search (obs_type / type / importance
  // filter) must report the TRUE total ("N of M"), not just the page size.
  // Pre-fix, formatSearchOutput gated the "of M" suffix on isCrossSource, so a
  // type-filtered search showing 2 of 6 rendered "Found 2 result(s)" — hiding
  // that more pages exist. The CLI never had this gate (mem-cli.mjs "N of M"),
  // so the two paths diverged on Claude's primary interface. countSearchTotal
  // already computes the true population; this asserts it reaches the header.
  it('mem_search with obs_type filter reports the true total, not the page size', async () => {
    // Seed 6 distinct bugfix observations sharing one search term. Distinct
    // content avoids saveObservation's 5-min Jaccard dedup window.
    for (let i = 0; i < 6; i++) {
      await client.callTool({
        name: 'mem_save',
        arguments: {
          content: `paginationmarker bugfix root cause number ${i} distinct-detail-${i}-${i * 7 + 3}`,
          title: `paginationmarker fix ${i}`,
          type: 'bugfix',
          importance: 2,
        },
      });
    }
    const res = await client.callTool({
      name: 'mem_search',
      arguments: { query: 'paginationmarker', obs_type: 'bugfix', limit: 2 },
    });
    const text = textOf(res);
    // Must surface the full population, not just the 2 shown on this page.
    expect(text).toMatch(/2 of 6 result/);
  });

  // Regression guard: explicit single-source pagination (type='observations')
  // must not overlap or gap. Pre-fix the server pushed `offset` into the SQL
  // (perSourceOffset=offset) AND re-sliced by offset at the merge step — a
  // double-offset — while perSourceLimit=limit fetched too few rows to page at
  // all. Result: offset 0 and offset 3 returned identical rows and the oldest
  // rows were never reachable. The CLI never had this (it over-fetches from
  // offset 0 and slices once); this asserts the server matches that contract.
  it('mem_search type=observations paginates without overlap or gaps', async () => {
    for (let i = 0; i < 9; i++) {
      await client.callTool({
        name: 'mem_save',
        arguments: {
          content: `explicitpagemarker observation sequence ${i} unique-body-${i}-${i * 5 + 2}`,
          title: `explicitpagemarker seq ${i}`,
          type: 'discovery',
          importance: 1,
        },
      });
    }
    const seen = [];
    for (const offset of [0, 3, 6]) {
      const res = await client.callTool({
        name: 'mem_search',
        arguments: { query: 'explicitpagemarker', type: 'observations', sort: 'time', limit: 3, offset },
      });
      const ids = [...textOf(res).matchAll(/#(\d+) /g)].map((m) => m[1]);
      seen.push(...ids);
    }
    // 3 pages × 3 = 9 ids, all distinct (no overlap), covering all 9 (no gap).
    expect(seen.length).toBe(9);
    expect(new Set(seen).size).toBe(9);
  });

  // CLI/MCP validation parity (convergence audit 2026-06-13): cmdUpdate rejects
  // empty titles and >500-char lessons; the MCP schema validated importance/type
  // but let these two through. Invariant asserted on the DB, not the transport:
  // a rejected update must not persist.
  it('mem_update rejects an empty/whitespace title (parity with CLI)', async () => {
    const saveRes = await client.callTool({
      name: 'mem_save',
      arguments: {
        content: 'parity probe original body',
        title: 'parity-title-probe',
        type: 'discovery',
        importance: 1,
      },
    });
    const id = Number((textOf(saveRes).match(/#(\d+)/) || [])[1]);
    expect(id).toBeGreaterThan(0);

    let rejected;
    try {
      const res = await client.callTool({ name: 'mem_update', arguments: { id, title: '   ' } });
      rejected = res.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    const getRes = await client.callTool({ name: 'mem_get', arguments: { ids: String(id) } });
    expect(textOf(getRes)).toContain('parity-title-probe');
  });

  it('mem_update rejects a lesson_learned over 500 chars (parity with CLI)', async () => {
    const saveRes = await client.callTool({
      name: 'mem_save',
      arguments: {
        content: 'lesson cap probe body',
        title: 'lesson-cap-probe',
        type: 'discovery',
        importance: 1,
      },
    });
    const id = Number((textOf(saveRes).match(/#(\d+)/) || [])[1]);
    expect(id).toBeGreaterThan(0);

    let rejected;
    try {
      const res = await client.callTool({
        name: 'mem_update',
        arguments: { id, lesson_learned: 'L'.repeat(501) },
      });
      rejected = res.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    const getRes = await client.callTool({ name: 'mem_get', arguments: { ids: String(id) } });
    expect(textOf(getRes)).not.toContain('LLLLLLLL');
  });
});

// ─── D#N over real stdio: mem_get deferred routing + defer_list hint ─────────
// (2026-07-18) Protocol-layer guard per the #8127 lesson: schema acceptance
// alone doesn't prove the registered surface routes D# tokens.
describe('mem_get D#N deferred read surface (stdio)', () => {
  const DETAIL = 'stdio-detail: docs/specs/deferred-read-surface.md, three-state exit contract';
  let deferredId;

  it('mem_defer → mem_get D#N returns full detail', async () => {
    const added = await client.callTool({
      name: 'mem_defer',
      arguments: { title: 'stdio deferred read test', detail: DETAIL, priority: 2 },
    });
    const addedText = added.content?.map((c) => c.text).join('\n') || '';
    const m = /D#(\d+)/.exec(addedText);
    expect(m).toBeTruthy();
    deferredId = m[1];

    const res = await client.callTool({
      name: 'mem_get',
      arguments: { ids: [`D#${deferredId}`] },
    });
    const text = res.content?.map((c) => c.text).join('\n') || '';
    expect(text).toContain(`D#${deferredId}`);
    expect(text).toContain('stdio deferred read test');
    expect(text).toContain(DETAIL);
  });

  it('mem_defer_list carries the detail-hint line and per-row age tag (G11)', async () => {
    const res = await client.callTool({ name: 'mem_defer_list', arguments: {} });
    const text = res.content?.map((c) => c.text).join('\n') || '';
    // Row created in the previous test this session → age is 0d.
    expect(text).toMatch(/\(D#\d+, 0d\)/);
    expect(text).toMatch(/mem_get|get D#/);
    // Fresh-only DB: the >30d stale refresh hint must NOT render.
    expect(text).not.toMatch(/30 days/);
  });
});

// ─── P2: mem_search surfaces deferred items (stdio) ──────────────────────────
describe('mem_search deferred trailer (stdio)', () => {
  it('keyword search over deferred title reaches the item', async () => {
    await client.callTool({
      name: 'mem_defer',
      arguments: {
        title: 'stdio deferred search probe item',
        detail: 'trailer reachability check',
        priority: 2,
      },
    });
    const res = await client.callTool({
      name: 'mem_search',
      arguments: { query: 'deferred search probe' },
    });
    const text = res.content?.map((c) => c.text).join('\n') || '';
    expect(text).toContain('stdio deferred search probe item');
    expect(text).toMatch(/D#\d+/);
  });

  it('obs_type-filtered search skips the trailer', async () => {
    const res = await client.callTool({
      name: 'mem_search',
      arguments: { query: 'deferred search probe', obs_type: 'bugfix' },
    });
    const text = res.content?.map((c) => c.text).join('\n') || '';
    expect(text).not.toContain('stdio deferred search probe item');
  });
});

// ─── Data dir line in mem_stats (stdio) ──────────────────────────────────────
describe('mem_stats names the data dir', () => {
  it('output contains the resolved Data dir path', async () => {
    const res = await client.callTool({ name: 'mem_stats', arguments: {} });
    const text = res.content?.map((c) => c.text).join('\n') || '';
    expect(text).toMatch(/Data dir: \S+/);
  });
});
