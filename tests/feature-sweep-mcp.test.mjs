// Feature sweep: every registered MCP tool of server.mjs, driven over the REAL
// JSON-RPC stdio transport (server spawned as a subprocess, MCP SDK client on the
// other end) — no handler is imported and called directly.
//
// WHY THIS FILE EXISTS (it does not duplicate the four MCP tests already here):
//   tests/mcp-tools-snapshot.test.mjs  — declaration-level: the `tools` array's
//     core/hidden split, descriptions, CLI-parity of the doc lines. Never spawns.
//   tests/mcp-protocol.test.mjs        — protocol-level regression museum: the
//     specific bugs that shipped (purge without confirm, sort=time no-op, single-
//     source totals, pagination double-offset, update validation parity). Ten of
//     the twenty tools are never called there.
//   tests/server-defer.test.mjs        — schema/handler-shape unit tests for the
//     defer family, plus a CLI proxy for the closes_deferred transaction.
//   tests/mcp-export-parity-r5.test.mjs— one tool (mem_export) via an in-process seam.
// None of them answers "does EVERY registered tool still answer a real tools/call
// with its documented payload?" — the question that catches a registration,
// transport or schema break in a tool nobody exercised this release. That is this
// file's only job: one case per tool, named after the tool, so a failure names the
// surface immediately.
//
// ISOLATION CONTRACT (all four are load-bearing):
//   1. CLAUDE_MEM_DIR → a mkdtempSync sandbox. vitest.config.mjs sets it to '' for
//      the runner, so a spawned child with no explicit value falls back to the LIVE
//      ~/.claude DB. The mem_stats case asserts `Data dir: <sandbox>` over the wire,
//      which is the one assertion that fails loudly if that ever leaks.
//   2. cwd → a sandbox dir, and CLAUDE_PROJECT_DIR + PWD are DELETED from the child
//      env (the runner's PWD is this repo). project-utils.mjs:18 resolves
//      CLAUDE_PROJECT_DIR || PWD || process.cwd(), so with both vars gone the server's
//      project name is derived from its cwd ALONE — which is what makes the
//      `Recent observations (work--mcpsweep)` assertion in the mem_recent case a real
//      pin on the spawned server's cwd. (Setting the two vars instead would leave that
//      assertion green even if the cwd option were dropped and the server ran here.)
//   3. No LLM, no network. CLAUDE_CODE_PATH points at a path that cannot exist, so
//      haiku-client's CLI mode fails fast instead of spawning a real `claude`; the API
//      keys stay empty; CLAUDE_MEM_SKIP_SAVE_ENRICH=1 stops mem_save from queueing a
//      background enrichment worker; CLAUDE_MEM_AUTO_DEEP=0 keeps mem_search single-query.
//      mem_optimize is exercised on its DEGRADED arm and asserts the degradation
//      (non-zero `skipped`), not a `\d+` that also matches an empty work queue.
//   4. afterAll closes the transport and removes the sandbox in a `finally`, so a
//      failing assertion cannot leak the dir. The prefix is `mem-` so
//      tests/global-setup.mjs reaps it even if the run is SIGKILL'd.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { tools as DECLARED_TOOLS } from '../tool-schemas.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(REPO, 'server.mjs');

// The 9 tools `tools/list` promises. Pinned as a literal ON PURPOSE: comparing the
// wire response against tool-schemas' own `hidden` flags would pass right through a
// flag flip (both sides move together). This literal is what makes a tool silently
// appearing in — or vanishing from — every agent's startup context a test failure.
const PUBLIC_TOOLS = [
  'mem_search',
  'mem_recent',
  'mem_recall',
  'mem_get',
  'mem_save',
  'mem_timeline',
  'mem_defer',
  'mem_defer_list',
  'mem_defer_drop',
];
// The 11 hidden-but-callable tools: absent from tools/call-time discovery, still
// routable by exact name (Claude Code agents reach them via the CLI).
const HIDDEN_TOOLS = [
  'mem_delete',
  'mem_update',
  'mem_export',
  'mem_compress',
  'mem_maintain',
  'mem_optimize',
  'mem_fts_check',
  'mem_stats',
  'mem_registry',
  'mem_use',
  'mem_browse',
];

// Every per-tool case registers through itTool, so the coverage guard below reads the
// set of cases REALLY registered with vitest rather than a third hand-maintained list
// (two literals agreeing with each other prove nothing about coverage). Collection runs
// all describe callbacks before the first test body, so SWEPT_TOOLS is complete by then.
const SWEPT_TOOLS = new Set();
function itTool(tool, fn, timeout) {
  if (SWEPT_TOOLS.has(tool)) throw new Error(`duplicate sweep case for "${tool}"`);
  SWEPT_TOOLS.add(tool);
  return it(tool, fn, timeout);
}

let ROOT, DATA_DIR, WORK_DIR, client, transport;

// inferProject() derives "<parent>--<dir>" from the project dir; WORK_DIR is
// <sandbox>/work/mcpsweep, so this is deterministic. With CLAUDE_PROJECT_DIR and PWD
// removed from the child env (see isolation contract #2), the server can only reach
// this name through its own process.cwd() — so the mem_recent assertion is the proof
// that it really ran with the sandbox cwd.
const PROJECT = 'work--mcpsweep';

/** Join the text blocks of a tools/call result. */
const textOf = (res) =>
  (res?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** Call a tool over the wire, requiring a non-error result with a non-empty payload. */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError, `${name} returned an error result: ${textOf(res)}`).toBeFalsy();
  const text = textOf(res);
  expect(text, `${name} returned an empty content payload`).toBeTruthy();
  return text;
}

/** Open the sandbox memory DB for verification independent of the server's read path. */
function withDb(fn) {
  const db = new Database(join(DATA_DIR, 'claude-mem-lite.db'));
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Same, for the registry DB (mem_registry / mem_use). */
function withRegistryDb(fn) {
  const db = new Database(join(DATA_DIR, 'resource-registry.db'));
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Backdate a project's rows so the age-gated tools (compress/maintain) engage. */
function ageProject(project, days) {
  return withDb((db) => {
    const epoch = Date.now() - days * 86400000;
    return db
      .prepare('UPDATE observations SET created_at_epoch = ?, created_at = ? WHERE project = ?')
      .run(epoch, new Date(epoch).toISOString(), project).changes;
  });
}

/** Extract the "#N" of a `Saved as observation #N` confirmation. */
function savedId(text) {
  const m = text.match(/Saved as observation #(\d+)/);
  expect(m, `expected a "Saved as observation #N" confirmation, got: ${text}`).toBeTruthy();
  return Number(m[1]);
}

/** Save through the protocol and return the new id. */
async function save(args) {
  return savedId(await call('mem_save', args));
}

/** A local SKILL.md the registry can index; under DATA_DIR so mem_use's path-confinement passes. */
function writeSkill(name, body) {
  const dir = join(DATA_DIR, 'managed', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, `---\nname: ${name}\ndescription: mcp sweep fixture skill\n---\n\n${body}\n`);
  return p;
}

// Seeded ids in PROJECT, filled in beforeAll. Every OTHER case writes to its own
// project so this trio stays the complete content of PROJECT (mem_recent asserts on it).
let SEED_BUGFIX_ID, SEED_DECISION_ID, SEED_DISCOVERY_ID;
const SEED_LESSON = 'Invalidate the widget cache on write, never on read';

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-mcpsweep-'));
  DATA_DIR = join(ROOT, 'data');
  WORK_DIR = join(ROOT, 'work', 'mcpsweep');
  mkdirSync(join(ROOT, 'home', '.claude'), { recursive: true });
  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const env = {
    ...process.env,
    HOME: join(ROOT, 'home'),
    CLAUDE_MEM_DIR: DATA_DIR,
    // haiku-client detectMode() falls back to 'cli' with no API key and would spawn the
    // real `claude`. Point it at a path that cannot exist → fail fast, no spend.
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_AUTO_DEEP: '0',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    MEM_QUIET_HOOKS: '1',
    CLAUDE_MEM_QUIET_TRACE: '0',
  };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  // Both project-dir env vars are removed so the transport's `cwd` is the ONLY source
  // inferProject() can read (isolation contract #2). The runner inherits PWD=<this repo>,
  // so leaving it in place would both hide a cwd leak and put the sweep's rows under the
  // repo's own project name.
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PWD;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: WORK_DIR,
    env,
  });
  client = new Client({ name: 'mem-featsweep-client', version: '0.0.0' });
  await client.connect(transport);

  // Three distinct seeds in PROJECT — distinct wording matters, saveObservation dedups
  // near-identical text inside a 5-minute window. Saved sequentially so their epochs are
  // strictly increasing (mem_recent / mem_timeline assert on that order).
  SEED_BUGFIX_ID = await save({
    content: 'Fixed the widget cache invalidation race in lib/widget-cache.mjs',
    title: 'Widget cache invalidation race',
    type: 'bugfix',
    importance: 3,
    lesson_learned: SEED_LESSON,
    files: ['lib/widget-cache.mjs'],
  });
  SEED_DECISION_ID = await save({
    content: 'Chose a write-through widget layer over read-through for predictable latency',
    title: 'Write-through widget layer',
    type: 'decision',
    importance: 2,
  });
  SEED_DISCOVERY_ID = await save({
    content: 'Discovered the retry backoff timer resets on every redirect hop',
    title: 'Retry backoff resets on redirect',
    type: 'discovery',
    importance: 2,
  });
}, 60000);

afterAll(async () => {
  try {
    try {
      await client?.close();
    } catch {
      /* already gone */
    }
    try {
      await transport?.close();
    } catch {
      /* already gone */
    }
  } finally {
    // In a `finally` so a failure above still removes the sandbox.
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ─── Surface guards ─────────────────────────────────────────────────────────

describe('MCP feature sweep: registered surface', () => {
  it('tools/list returns exactly the 9 public tools, and no hidden one', async () => {
    const { tools: listed } = await client.listTools();
    const names = listed.map((t) => t.name).sort();
    // Exact set BOTH ways: a missing tool and an extra tool are equally a failure.
    expect(names).toEqual([...PUBLIC_TOOLS].sort());
    for (const hidden of HIDDEN_TOOLS) expect(names).not.toContain(hidden);
    // …and the wire response agrees with what tool-schemas declares. This leg catches a
    // registration/filter break (declared public, missing on the wire) that the literal
    // above cannot distinguish from an intentional list change.
    expect(names).toEqual(
      DECLARED_TOOLS.filter((t) => !t.hidden)
        .map((t) => t.name)
        .sort(),
    );
  });

  it('every tool tool-schemas registers has a sweep case (coverage guard)', () => {
    // SWEPT_TOOLS is the set of cases actually registered with vitest, so a tool added to
    // tool-schemas without a case fails here and cannot be silenced by editing a literal.
    const declared = DECLARED_TOOLS.map((t) => t.name).sort();
    expect(declared).toEqual([...SWEPT_TOOLS].sort());
    expect(declared).toEqual([...PUBLIC_TOOLS, ...HIDDEN_TOOLS].sort());
    expect(declared).toHaveLength(20);
  });
});

// ─── Public tools (the 9 in tools/list) ─────────────────────────────────────

describe('MCP feature sweep: public tools', () => {
  itTool('mem_search', async () => {
    const all = await call('mem_search', { query: 'widget', project: PROJECT });
    const ids = [...all.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
    expect(ids).toContain(SEED_BUGFIX_ID);
    expect(ids).toContain(SEED_DECISION_ID);

    // obs_type must actually narrow — a dropped filter shows the bugfix row too.
    const narrowed = await call('mem_search', { query: 'widget', project: PROJECT, obs_type: 'decision' });
    const narrowedIds = [...narrowed.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
    expect(narrowedIds).toEqual([SEED_DECISION_ID]);
  });

  itTool('mem_recent', async () => {
    const text = await call('mem_recent', { limit: 2 });
    // Header names the project inferred from the SERVER's cwd — the proof that the
    // subprocess really ran inside the sandbox and not in this repo.
    expect(text).toContain(`Recent observations (${PROJECT}):`);
    const ids = [...text.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([SEED_DISCOVERY_ID, SEED_DECISION_ID]); // newest first, limit honored
  });

  itTool('mem_recall', async () => {
    const text = await call('mem_recall', { file: 'widget-cache.mjs' });
    expect(text).toContain('History for widget-cache.mjs (1 observation');
    expect(text).toContain(`#${SEED_BUGFIX_ID}`);
    expect(text).toContain(SEED_LESSON);
    // A file nobody touched must say so rather than fall back to a broad match.
    const none = await call('mem_recall', { file: 'no-such-file-xyzzy.mjs' });
    expect(none).toContain('No history for "no-such-file-xyzzy.mjs"');
  });

  itTool('mem_get', async () => {
    const text = await call('mem_get', { ids: [String(SEED_BUGFIX_ID), '999999'] });
    expect(text).toContain(`── #${SEED_BUGFIX_ID} ──`);
    expect(text).toContain(`lesson_learned: ${SEED_LESSON}`);
    expect(text).toContain('importance: 3');
    // `files` reaches the row, and is rendered under the `files` label — the raw
    // `files_modified` column name claimed a modification for a path the caller may only
    // have read (audit 2026-08-14 F3); tests/audit-findings-20260814.test.mjs pins the CLI
    // half of the same label, so the two `get` surfaces agree.
    expect(text).toMatch(/^files: .*lib\/widget-cache\.mjs/m);
    expect(text).not.toMatch(/^files_modified:/m);
    // Missing ids are reported, not silently dropped from the answer.
    expect(text).toContain('Note: ID(s) #999999 not found.');
  });

  itTool('mem_save', async () => {
    const text = await call('mem_save', {
      content: 'Traced a flaky upload to an unclosed multipart stream',
      title: 'Flaky upload from unclosed stream',
      type: 'bugfix',
      importance: 3,
      project: 'mcpsweep-save',
      lesson_learned: 'Close the stream in a finally block',
    });
    expect(text).toMatch(/Saved as observation #\d+ \[bugfix\] in project "mcpsweep-save"/);
    expect(text).toContain('lesson captured');
    // Cross-check the row in the sandbox DB — the response text alone is the server
    // quoting its own input back.
    const id = savedId(text);
    const row = withDb((db) =>
      db
        .prepare('SELECT type, importance, project, title, lesson_learned FROM observations WHERE id = ?')
        .get(id),
    );
    expect(row).toMatchObject({
      type: 'bugfix',
      importance: 3,
      project: 'mcpsweep-save',
      title: 'Flaky upload from unclosed stream',
      lesson_learned: 'Close the stream in a finally block',
    });
  });

  itTool('mem_timeline', async () => {
    // Anchored on the MIDDLE seed, so which row lands before and which after is fully
    // determined: the rendered order must be bugfix → decision(anchor) → discovery.
    const text = await call('mem_timeline', {
      anchor: SEED_DECISION_ID,
      before: 1,
      after: 1,
      project: PROJECT,
    });
    expect(text).toContain(`Timeline around #${SEED_DECISION_ID}`);
    const ids = [...text.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([SEED_BUGFIX_ID, SEED_DECISION_ID, SEED_DISCOVERY_ID]);
    expect(text).toMatch(new RegExp(`^#${SEED_DECISION_ID} .*◀$`, 'm')); // anchor marker on the anchor
  });

  itTool('mem_defer', async () => {
    const text = await call('mem_defer', {
      title: 'Benchmark the widget cache under load',
      priority: 3,
      detail: 'needs a load fixture first',
      project: 'mcpsweep-defer',
    });
    const m = text.match(/Deferred as D#(\d+) \(item (\d+)\) in project "mcpsweep-defer"/);
    expect(m, `unexpected mem_defer confirmation: ${text}`).toBeTruthy();
    const row = withDb((db) =>
      db
        .prepare('SELECT title, priority, detail, status, project FROM deferred_work WHERE id = ?')
        .get(Number(m[1])),
    );
    expect(row).toMatchObject({
      title: 'Benchmark the widget cache under load',
      priority: 3,
      detail: 'needs a load fixture first',
      status: 'open',
      project: 'mcpsweep-defer',
    });
  });

  itTool('mem_defer_list', async () => {
    // Seeds its own rows (no dependency on the mem_defer case) in its own project.
    const P = 'mcpsweep-deferlist';
    expect(await call('mem_defer_list', { project: P })).toContain(
      `No open deferred items in project "${P}".`,
    );
    const a = (
      await call('mem_defer', { title: 'Split the retry helper out of transport', priority: 3, project: P })
    ).match(/D#(\d+)/)[1];
    const b = (
      await call('mem_defer', { title: 'Document the backoff ceiling', priority: 1, project: P })
    ).match(/D#(\d+)/)[1];

    const list = await call('mem_defer_list', { project: P });
    expect(list).toContain('Split the retry helper out of transport');
    expect(list).toContain('Document the backoff ceiling');
    expect(list).toContain(`D#${a}`);
    expect(list).toContain(`D#${b}`);
    // Priority order (3 before 1) and the detail affordance are part of the contract.
    expect(list.indexOf('Split the retry helper')).toBeLessThan(list.indexOf('Document the backoff ceiling'));
    expect(list).toContain('Full detail: mem_get ids=["D#<id>"]');
  });

  itTool('mem_defer_drop', async () => {
    const P = 'mcpsweep-deferdrop';
    const id = Number(
      (await call('mem_defer', { title: 'Retire the legacy uploader shim', priority: 2, project: P })).match(
        /D#(\d+)/,
      )[1],
    );

    const dropped = await call('mem_defer_drop', { id: `D#${id}`, reason: 'covered elsewhere', project: P });
    expect(dropped).toContain(`Dropped D#${id} in project "${P}". Reason: covered elsewhere`);
    const row = withDb((db) =>
      db.prepare('SELECT status, drop_reason FROM deferred_work WHERE id = ?').get(id),
    );
    expect(row).toMatchObject({ status: 'dropped', drop_reason: 'covered elsewhere' });
    expect(await call('mem_defer_list', { project: P })).toContain('No open deferred items');
  });
});

// ─── Hidden-but-callable tools (absent from tools/list, routable by exact name) ──

describe('MCP feature sweep: hidden tools', () => {
  itTool('mem_stats', async () => {
    const text = await call('mem_stats', { days: 30 });
    // Isolation proof: the server resolved the SANDBOX data dir, not ~/.claude-mem-lite.
    expect(text).toContain(`Data dir: ${DATA_DIR}`);
    const total = text.match(/Total: (\d+) observations \| (\d+) sessions/);
    expect(total, `no parseable totals line in:\n${text}`).toBeTruthy();
    // Must agree with the DB it claims to describe (all live rows, any project).
    const live = withDb((db) => db.prepare('SELECT COUNT(*) c FROM observations').get().c);
    expect(Number(total[1])).toBe(live);
    expect(text).toContain('🔴 Working:');
  });

  itTool('mem_browse', async () => {
    const text = await call('mem_browse', { project: PROJECT });
    expect(text).toContain(`Memory Dashboard (${PROJECT})`);
    expect(text).toContain('🔴 Working Memory (3)'); // exactly the three seeds
    expect(text).toContain(`#${SEED_BUGFIX_ID}`);
    expect(text).toMatch(/Totals: 3 observations \| Working: 3 \| Active: 0 \| Archive: 0/);

    // tier filter drops the other tiers entirely (not merely reorders them).
    const scoped = await call('mem_browse', { project: PROJECT, tier: 'working' });
    expect(scoped).toContain('🔴 Working Memory (3)');
    expect(scoped).not.toContain('Archive');
  });

  itTool('mem_update', async () => {
    const id = await save({
      content: 'Initial note about the nightly export job schedule',
      title: 'Nightly export note',
      project: 'mcpsweep-update',
    });
    const text = await call('mem_update', {
      id,
      title: 'Nightly export job window moved',
      importance: 3,
      lesson_learned: 'Coordinate window changes with the data team',
    });
    expect(text).toContain(`Updated observation #${id}: title, importance, lesson_learned`);
    const row = withDb((db) =>
      db.prepare('SELECT title, importance, lesson_learned FROM observations WHERE id = ?').get(id),
    );
    expect(row).toMatchObject({
      title: 'Nightly export job window moved',
      importance: 3,
      lesson_learned: 'Coordinate window changes with the data team',
    });
  });

  itTool('mem_delete', async () => {
    const id = await save({
      content: 'Scratch row created only to be deleted by the sweep',
      title: 'Scratch delete row',
      project: 'mcpsweep-delete',
    });
    const rows = () =>
      withDb((db) => db.prepare('SELECT COUNT(*) c FROM observations WHERE id = ?').get(id).c);

    const preview = await call('mem_delete', { ids: [id], confirm: false });
    expect(preview).toContain('Preview: 1 observation(s) will be deleted');
    expect(preview).toContain(`#${id}`);
    expect(rows()).toBe(1); // preview must not mutate

    const confirmed = await call('mem_delete', { ids: [id], confirm: true });
    expect(confirmed).toContain('Deleted 1 observation(s).');
    expect(rows()).toBe(0);
  });

  itTool('mem_export', async () => {
    const text = await call('mem_export', { project: PROJECT, format: 'jsonl' });
    expect(text).toMatch(/^Exported 3 observations:/);
    const rows = text
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(3);
    const seeded = rows.find((r) => r.id === SEED_BUGFIX_ID);
    expect(seeded, `seeded row missing from export: ${rows.map((r) => r.id).join(',')}`).toBeTruthy();
    // The round-trippable column set restore reads back (v3.42 HIGH-2) must be present.
    expect(seeded.project).toBe(PROJECT);
    expect(seeded.lesson_learned).toBe(SEED_LESSON);
    expect(seeded.title).toContain('Widget cache invalidation race');
    for (const col of ['text', 'files_read', 'search_aliases', 'cited_count', 'importance']) {
      expect(Object.keys(seeded), `export row missing "${col}"`).toContain(col);
    }
  });

  itTool(
    'mem_compress',
    async () => {
      // Compression needs ≥3 rows in one project-week that are ≥30d old, importance ≤1,
      // never accessed and lesson-free. Seed through the real save path, then backdate.
      const P = 'mcpsweep-compress';
      for (const [title, content] of [
        ['Changelog heading rename', 'Renamed the changelog heading ahead of the quarterly audit'],
        ['Vendor trailing-comma rule', 'Bumped the linter rule covering trailing commas in vendor files'],
        ['Onboarding screenshot removal', 'Removed an obsolete screenshot from the onboarding docs folder'],
      ])
        await save({ content, title, importance: 1, project: P });
      expect(ageProject(P, 60)).toBe(3);

      const preview = await call('mem_compress', { project: P, preview: true });
      expect(preview).toContain('Total candidates: 3');
      expect(preview).toContain('Compressable groups (≥3 obs): 1');
      expect(preview).toContain('Observations to compress: 3');
      const uncompressed = () =>
        withDb(
          (db) =>
            db
              .prepare(
                'SELECT COUNT(*) c FROM observations WHERE project = ? AND COALESCE(compressed_into,0) = 0',
              )
              .get(P).c,
        );
      expect(uncompressed()).toBe(3); // preview must not mutate

      const executed = await call('mem_compress', { project: P, preview: false });
      expect(executed).toBe('Compressed 3 observations into 1 weekly summaries.');
      // The three originals now point at a summary row; exactly one live row remains.
      expect(
        withDb(
          (db) =>
            db
              .prepare(
                'SELECT COUNT(*) c FROM observations WHERE project = ? AND COALESCE(compressed_into,0) != 0',
              )
              .get(P).c,
        ),
      ).toBe(3);
      expect(uncompressed()).toBe(1);
      expect(await call('mem_compress', { project: P, preview: true })).toBe(
        'No candidates for compression.',
      );
    },
    30000,
  );

  itTool(
    'mem_maintain',
    async () => {
      const P = 'mcpsweep-maintain';
      for (const [title, content] of [
        ['Stale feature flag list', 'Tidied the stale feature flag list inside the deployment runbook'],
        ['Legacy migration notes', 'Archived the legacy migration notes from the operations wiki space'],
        ['Unused gradle task', 'Dropped an unused gradle task from the android build configuration'],
      ])
        await save({ content, title, importance: 1, project: P });

      const fresh = await call('mem_maintain', { action: 'scan', project: P });
      expect(fresh).toContain('Total active observations: 3');
      expect(fresh).toMatch(/Stale \(>30d, imp=1, no access, never injected\): 0/);

      expect(ageProject(P, 90)).toBe(3);
      expect(await call('mem_maintain', { action: 'scan', project: P })).toMatch(
        /Stale \(>30d, imp=1, no access, never injected\): 3/,
      );

      const executed = await call('mem_maintain', { action: 'execute', operations: ['decay'], project: P });
      expect(executed).toMatch(/marked 3 idle as pending-purge/);
      const after = await call('mem_maintain', { action: 'scan', project: P });
      expect(after).toContain('Total active observations: 0');
      expect(after).toMatch(/Pending purge \(idle-marked\): 3/);
    },
    30000,
  );

  itTool(
    'mem_optimize',
    async () => {
      // A plain save with no lesson/concepts/aliases is a narrow re-enrich candidate.
      const P = 'mcpsweep-optimize';
      await save({
        content: 'Sketch of the queue drain sequence for the optimize sweep',
        title: 'Queue drain sketch',
        project: P,
      });

      const preview = await call('mem_optimize', { action: 'preview', project: P });
      expect(preview).toContain('🔍 LLM Optimization Preview:');
      const num = (re) => {
        const m = preview.match(re);
        expect(m, `no line matching ${re} in:\n${preview}`).toBeTruthy();
        return Number(m[1]);
      };
      const reenrich = num(/^\s*Re-enrich candidates: (\d+)$/m);
      const clusterMerge = num(/^\s*Cluster-merge candidates: (\d+) clusters$/m);
      const smartCompress = num(/^\s*Smart-compress candidates: (\d+) clusters$/m);
      const normalizeLine = preview.match(/^\s*Normalize: (?:(\d+) unique concepts|gate closed .*)$/m);
      expect(normalizeLine, `no parseable Normalize line in:\n${preview}`).toBeTruthy();
      const normalizeUnits = Number(normalizeLine[1] || 0) > 0 ? 1 : 0;
      // The headline total is the sum of the four task figures — a Total computed over a
      // different scope (e.g. one leg ignoring `project`) fails here.
      expect(num(/^\s*Total: (\d+) items$/m)).toBe(reenrich + normalizeUnits + clusterMerge + smartCompress);
      expect(reenrich).toBeGreaterThan(0);

      // The run arm must DEGRADE — candidates picked up, every Haiku call refused because
      // CLAUDE_CODE_PATH points nowhere. "0 processed, 0 skipped" (an empty work queue, or
      // a task that never ran at all) is a failure, not a pass.
      const run = await call('mem_optimize', {
        action: 'run',
        tasks: ['re-enrich'],
        max_items: 1,
        project: P,
      });
      expect(run).toContain('🔧 LLM Optimization Results:');
      expect(run).toMatch(/Re-enrich: 0 processed, [1-9]\d* skipped/);
      expect(run).not.toMatch(/ENOTFOUND|ETIMEDOUT|fetch failed/);
      // Degraded means UNCHANGED, not half-written: the candidate keeps its empty fields.
      const row = withDb((db) =>
        db
          .prepare('SELECT lesson_learned, concepts, optimized_at FROM observations WHERE project = ?')
          .get(P),
      );
      expect(row).toMatchObject({ lesson_learned: null, optimized_at: null });
    },
    60000,
  );

  itTool(
    'mem_fts_check',
    async () => {
      expect(await call('mem_fts_check', { action: 'check' })).toBe(
        'FTS5 indexes are healthy — all integrity checks passed.',
      );

      const rebuilt = await call('mem_fts_check', { action: 'rebuild' });
      for (const table of ['observations_fts', 'session_summaries_fts', 'user_prompts_fts', 'events_fts']) {
        expect(rebuilt).toContain(table);
      }
      expect(rebuilt).not.toContain('Errors:');
      // The rebuilt index must still answer — a rebuild that empties it would pass on the
      // message alone.
      expect(await call('mem_search', { query: 'widget', project: PROJECT })).toContain(`#${SEED_BUGFIX_ID}`);
    },
    30000,
  );

  itTool('mem_registry', async () => {
    const skillPath = writeSkill('mcpsweep-registry-skill', 'Body of the registry sweep fixture.');
    const imported = await call('mem_registry', {
      action: 'import',
      name: 'mcpsweep-registry-skill',
      resource_type: 'skill',
      local_path: skillPath,
      use_cases: 'exercising the registry surface',
      capability_summary: 'registry sweep fixture skill',
    });
    expect(imported).toMatch(/^Imported: skill:mcpsweep-registry-skill \(id=\d+\)$/);
    expect(
      withRegistryDb((db) =>
        db.prepare('SELECT status, local_path FROM resources WHERE name = ?').get('mcpsweep-registry-skill'),
      ),
    ).toMatchObject({ status: 'active', local_path: skillPath });

    expect(await call('mem_registry', { action: 'list' })).toContain('mcpsweep-registry-skill');
    expect(await call('mem_registry', { action: 'stats' })).toMatch(/Total active: [1-9]\d*/);
    expect(await call('mem_registry', { action: 'search', query: 'mcpsweep-registry-skill' })).toContain(
      'mcpsweep-registry-skill',
    );
    expect(await call('mem_registry', { action: 'reindex' })).toMatch(
      /FTS5 reindexed\. \d+ active resources\./,
    );

    // P2-6's semantics, pinned on the MCP face. The CLI face got a `not.toMatch(/\n\s*Path:/)`
    // when the two renderers were collapsed; this face — whose semantics were the ones KEPT —
    // had no assertion on its rendered output at all, so the v3.93.0 pre-tag review could
    // reintroduce the exact leak at `server.mjs`'s call site with every suite still green.
    //
    // The pair is the assertion, not the negative half alone: the fixture above is MANAGED
    // (writeSkill puts it under <data>/managed), so it MUST still render a Path line, while a
    // resource outside that prefix must not. A lone `not.toMatch` would also pass on a face
    // that stopped rendering anything.
    const unmanagedDir = join(DATA_DIR, 'unmanaged', 'skills', 'mcpsweep-unmanaged-skill');
    mkdirSync(unmanagedDir, { recursive: true });
    const unmanagedPath = join(unmanagedDir, 'SKILL.md');
    writeFileSync(
      unmanagedPath,
      '---\nname: mcpsweep-unmanaged-skill\ndescription: mcp sweep unmanaged fixture\n---\n\nBody.\n',
    );
    await call('mem_registry', {
      action: 'import',
      name: 'mcpsweep-unmanaged-skill',
      resource_type: 'skill',
      local_path: unmanagedPath,
      use_cases: 'exercising the non-managed render path',
      capability_summary: 'registry sweep unmanaged fixture skill',
    });

    // Per-ROW, not per-response. A whole-response `not.toMatch(/Path:/)` is satisfied by the
    // OTHER row: both fixtures share the `mcpsweep`/`skill` tokens, so either query returns
    // both, and the managed row's legitimate Path line would clear the negative assertion for
    // the unmanaged one. That is the "assertion satisfied by something other than its target"
    // shape this repo keeps recording — hit while writing this very case.
    const blockFor = (out, name) => out.split(/\n(?=\[)/).find((b) => b.includes(`**${name}**`));

    const hits = await call('mem_registry', { action: 'search', query: 'mcpsweep' });
    const managedBlock = blockFor(hits, 'mcpsweep-registry-skill');
    const unmanagedBlock = blockFor(hits, 'mcpsweep-unmanaged-skill');
    expect(managedBlock, 'premise: the managed fixture must be in the result set').toBeTruthy();
    expect(unmanagedBlock, 'premise: the unmanaged fixture must be in the result set').toBeTruthy();

    expect(managedBlock, 'a MANAGED hit must still render its portable path').toMatch(/\n\s*Path:/);
    expect(unmanagedBlock, 'the P2-6 path leak is back on the MCP face').not.toMatch(/\n\s*Path:/);
    expect(unmanagedBlock).toMatch(/Use: (Skill\(|mem_use\(name=)/);

    await call('mem_registry', {
      action: 'remove',
      name: 'mcpsweep-unmanaged-skill',
      resource_type: 'skill',
    });

    expect(
      await call('mem_registry', {
        action: 'remove',
        name: 'mcpsweep-registry-skill',
        resource_type: 'skill',
      }),
    ).toBe('Removed: skill:mcpsweep-registry-skill');
    expect(await call('mem_registry', { action: 'search', query: 'mcpsweep-registry-skill' })).toContain(
      'No matching resources for: "mcpsweep-registry-skill"',
    );
  });

  itTool('mem_use', async () => {
    const BODY = 'MCPSWEEPUSEBODY — the loaded skill body must reach the caller verbatim.';
    const skillPath = writeSkill('mcpsweep-use-skill', BODY);
    await call('mem_registry', {
      action: 'import',
      name: 'mcpsweep-use-skill',
      resource_type: 'skill',
      local_path: skillPath,
      capability_summary: 'use sweep fixture skill',
    });

    const loaded = await call('mem_use', { name: 'mcpsweep-use-skill' });
    expect(loaded).toContain('<skill-loaded name="mcpsweep-use-skill" type="skill"');
    expect(loaded).toContain(BODY); // file contents, not just a pointer
    expect(loaded).toContain('</skill-loaded>');
    // The load is recorded against the resource (adoption signal, not a no-op read).
    const invocations = withRegistryDb(
      (db) =>
        db
          .prepare(
            `
      SELECT COUNT(*) c FROM invocations i JOIN resources r ON r.id = i.resource_id WHERE r.name = ?
    `,
          )
          .get('mcpsweep-use-skill').c,
    );
    expect(invocations).toBe(1);

    // A name that shares no token with any registered resource reports a miss. A name that
    // DOES share a token now gets the closest-match SUGGESTION instead (audit F1 — it used
    // to get the top hit's body); that path is pinned in tests/audit-findings-20260814, so
    // this case stays on the no-candidate arm.
    expect(await call('mem_use', { name: 'zqxwvrunk' })).toContain('No skill found for "zqxwvrunk"');
  });
});
