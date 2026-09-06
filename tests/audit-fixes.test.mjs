// Regression tests for the T1 audit fixes (P0-1, P0-2, P1-3, P1-4, P2-5, P2-6, P2-7).
// Each block documents the pre-fix symptom so a future revert is flagged loudly.
//
//   P0-1 CLI  save    --lesson was silently dropped (flag not parsed, column not in INSERT)
//   P0-2 MCP  search  sort='time' / 'importance' were no-ops (created_at_epoch missing on result obj)
//   P1-3 MCP  get     fields=['bogus'] returned header-only empty record (silent, no error)
//   P1-4 MCP  get     partial-missing ids were silently skipped (mem_delete reports but get didn't)
//   P2-5 schema timeline anchor+query precedence wasn't in the description text
//   P2-6 MCP  search  empty query returned "Found N result(s):" with no label vs query flows
//   P2-7 MCP  get     source=session/prompt miss didn't hint "try source='obs'" when ID exists

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import { memTimelineSchema, memMaintainSchema, memOptimizeSchema } from '../tool-schemas.mjs';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';

const SERVER_PATH = resolve(new URL('..', import.meta.url).pathname, 'server.mjs');

// ─── Helpers ────────────────────────────────────────────────────────────────

function startServer(memDir) {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, CLAUDE_MEM_DIR: memDir, MEM_QUIET_HOOKS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', () => {});
  return proc;
}

function rpc(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            proc.stdout.off('data', onData);
            return resolve(msg);
          }
        } catch {
          /* non-JSON frame */
        }
      }
      buf = lines[lines.length - 1];
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(payload);
    setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`timeout waiting for id=${id} method=${method}`));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}

async function initialize(proc) {
  await rpc(proc, 0, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'audit-fixes-test', version: '0' },
  });
}

// Seed a DB at `{dir}/claude-mem-lite.db` with N observations that all match the same
// FTS query ("AUDITKW") but at spaced-out epochs and different importances so sort
// variants can be distinguished.
function seedDb(dir, projectName = 'audit--probe') {
  const dbPath = join(dir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'audit-sess', project: projectName, memoryId: 'audit-mem' });
  // Insert 5 obs, newest = idx 0, importance alternating so sort orders are distinct.
  for (let i = 0; i < 5; i++) {
    insertObs(db, {
      sessionId: 'audit-mem',
      project: projectName,
      type: 'bugfix',
      title: `AUDITKW entry ${i}`,
      text: `AUDITKW probe text marker body ${i}`,
      importance: (i % 3) + 1, // 1,2,3,1,2
      // spaced 1 day apart: newest = i=0, oldest = i=4
      epochOffset: -i * 86_400_000,
    });
  }
  db.close();
  return dbPath;
}

// ─── P0-1: CLI save --lesson (via run) ──────────────────────────────────────
// The pre-fix CLI ignored --lesson entirely: flags.lesson existed but cmdSave never
// read it, and the INSERT statement didn't include the lesson_learned column. Users
// following the tool description's `Equivalent CLI: ... --lesson "..."` lost the
// lesson silently, breaking the project's bugfix-after-save contract.

let testDb;

vi.mock('../schema.mjs', async (importOriginal) => {
  const original = await importOriginal();
  const stub = () =>
    new Proxy(testDb, {
      get(t, p) {
        if (p === 'close') return () => {};
        return t[p];
      },
    });
  // Stub EVERY exported opener, not just ensureDb: mem-cli routes through
  // ensureDbWithWalRecovery since the WAL-recovery hoist, and an unstubbed
  // opener silently escapes to the REAL ~/.claude-mem-lite DB (this exact
  // hole let a test run write to and purge the developer's live DB).
  return { ...original, ensureDb: stub, ensureDbWithWalRecovery: stub };
});

vi.mock('../utils.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, inferProject: () => 'test--probe' };
});

const { run } = await import('../mem-cli.mjs');

function captureStdout(fn) {
  let output = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => {
    output += s;
    return true;
  };
  process.stderr.write = (s) => {
    output += s;
    return true;
  };
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.then(() => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        return output;
      });
    }
  } catch (err) {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    throw err;
  }
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  return output;
}

describe('P0-1: CLI save --lesson persists lesson_learned', () => {
  beforeEach(() => {
    testDb = (() => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      return db;
    })();
    insertSession(testDb, { id: 'p01-sess', project: 'test--probe', memoryId: 'p01-mem' });
  });
  afterEach(() => {
    testDb.close();
  });

  it('writes lesson_learned column when --lesson is passed', async () => {
    const output = await captureStdout(() =>
      run(['save', 'root cause X; fix is Y', '--type', 'bugfix', '--lesson', 'always grep usage first']),
    );
    expect(output).toContain('💡lesson captured');
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.type).toBe('bugfix');
    expect(row.lesson_learned).toBe('always grep usage first');
  });

  it('accepts --lesson-learned alias (mirrors cmdUpdate)', async () => {
    await captureStdout(() =>
      run(['save', 'content', '--type', 'bugfix', '--lesson-learned', 'alias works']),
    );
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.lesson_learned).toBe('alias works');
  });

  it('rejects --lesson exceeding 500 chars (mirrors MCP memSaveSchema)', async () => {
    const longLesson = 'A'.repeat(501);
    const output = await captureStdout(() =>
      run(['save', 'probe', '--type', 'bugfix', '--lesson', longLesson]),
    );
    expect(output).toContain('too long');
    const count = testDb.prepare('SELECT COUNT(*) as c FROM observations').get().c;
    expect(count).toBe(0);
  });

  it('omits lesson badge in output when --lesson not passed', async () => {
    const output = await captureStdout(() => run(['save', 'plain save', '--type', 'discovery']));
    expect(output).not.toContain('💡lesson captured');
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.lesson_learned).toBeNull();
  });
});

// ─── P0-2..P2-7: MCP stdio tests (shared fixture) ───────────────────────────
// Using stdio because the handlers are registered as inline arrow functions inside
// server.mjs — not importable. Each test seeds a fresh DB under a mkdtempSync path.

describe('MCP audit fixes (stdio)', () => {
  let tmp, proc;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-audit-'));
    seedDb(tmp);
    proc = startServer(tmp);
  });

  afterEach(async () => {
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function callTool(name, args) {
    return rpc(proc, Math.floor(Math.random() * 1e9), 'tools/call', { name, arguments: args });
  }

  // P0-2: sort variants must produce DIFFERENT IDs orderings.
  it('P0-2: mem_search sort=time, relevance, importance produce distinct orderings', async () => {
    await initialize(proc);
    const t = await callTool('mem_search', { query: 'AUDITKW', sort: 'time', limit: 5 });
    const r = await callTool('mem_search', { query: 'AUDITKW', sort: 'relevance', limit: 5 });
    const i = await callTool('mem_search', { query: 'AUDITKW', sort: 'importance', limit: 5 });

    const parseIds = (resp) =>
      [...(resp.result?.content?.[0]?.text || '').matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    const timeIds = parseIds(t);
    const relIds = parseIds(r);
    const impIds = parseIds(i);

    expect(timeIds.length).toBe(5);
    // sort=time must be strictly newest-first: DB rows were inserted with epochOffset=-i*day,
    // so id=1 (epochOffset=0) is newest, id=5 (epochOffset=-4d) is oldest.
    expect(timeIds).toEqual([1, 2, 3, 4, 5]);

    // sort=importance must group by importance desc (3 first, then 2, then 1).
    const seedImportances = [1, 2, 3, 1, 2]; // i=0..4 → id=1..5
    const observedImp = impIds.map((id) => seedImportances[id - 1]);
    for (let k = 1; k < observedImp.length; k++) {
      expect(observedImp[k]).toBeLessThanOrEqual(observedImp[k - 1]);
    }

    // Relevance should not be identical to time (this was the original bug signature).
    expect(JSON.stringify(relIds)).not.toBe(JSON.stringify(timeIds));
  });

  // Round3-P1: the tier post-filter classified tiers using the CWD-inferred project
  // instead of the explicit args.project. The seed project ('audit--probe') differs
  // from the server's CWD-inferred project, so pre-fix tier=working dropped the
  // freshly-created obs (id=1, epochOffset=0 → "working") that mem_browse showed.
  it('Round3-P1: mem_search tier=working honors explicit args.project (parity with browse)', async () => {
    await initialize(proc);
    const noTier = await callTool('mem_search', { query: 'AUDITKW', project: 'audit--probe', limit: 5 });
    expect(noTier.result?.content?.[0]?.text || '').toMatch(/AUDITKW/); // sanity: findable without tier
    const withTier = await callTool('mem_search', {
      query: 'AUDITKW',
      tier: 'working',
      project: 'audit--probe',
      limit: 5,
    });
    const text = withTier.result?.content?.[0]?.text || '';
    expect(text).not.toMatch(/No results/);
    expect(text).toMatch(/#1\b/); // id=1 (created now → working tier) is returned
  });

  // P1-3: all-invalid fields → error, partial-invalid → note + rendering.
  it('P1-3: mem_get with all-invalid fields returns an error', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [1], fields: ['not_a_field', 'also_bogus'] });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).toBe(true);
    expect(text).toMatch(/No valid fields/);
    expect(text).toMatch(/Valid:/);
  });

  it('P1-3: mem_get with partial-invalid fields proceeds and emits a note', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [1], fields: ['title', 'bogus_field'] });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).not.toBe(true);
    expect(text).toMatch(/dropped:\s*bogus_field/);
    expect(text).toMatch(/── #1 ──/);
    expect(text).toMatch(/title:/);
  });

  // P1-4: missing IDs surface in a trailing Note.
  // Prefix included per #8127 refactor — bucket-aware missing hint (#N, P#N, S#N)
  // tells the caller which source returned nothing.
  it('P1-4: mem_get appends a Note for missing IDs (mirrors mem_delete)', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [1, 999999] });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/── #1 ──/);
    expect(text).toMatch(/Note: ID\(s\) #?999999 not found/);
  });

  it('P1-4: mem_get with all missing still returns the "no records found" message', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [888888, 999999] });
    const text = resp.result?.content?.[0]?.text || '';
    // Post-#8127: multi-source handler generalizes the error to "No records found in source(s)"
    // so the caller sees which buckets were queried when using mixed prefixes.
    expect(text).toMatch(/No records found in source\(s\).*obs/);
  });

  // P2-6: empty query gets a distinct label so the caller knows results aren't BM25-ranked.
  it('P2-6: mem_search with no query labels output as "no query — listing recent"', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/no query — listing recent/);
  });

  it('P2-6: mem_search with a query preserves the `for "<query>"` label', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { query: 'AUDITKW', limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/for "AUDITKW"/);
    expect(text).not.toMatch(/no query/);
  });

  // T: mem_search must surface the AND→OR fallback. A silent fallback lets callers
  // (including Claude) trust a strict multi-term query that actually matched only
  // one of the terms. The hint is the signal for "treat these results as loose".
  it('mem_search surfaces a "relaxed AND→OR" hint when AND returns zero and OR recovers', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { query: 'AUDITKW zzzzz_nonexistent', limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/AUDITKW entry/);
    expect(text).toMatch(/relaxed AND.{0,3}OR/);
  });

  it('mem_search omits the fallback hint on a clean AND match', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { query: 'AUDITKW', limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/AUDITKW entry/);
    expect(text).not.toMatch(/relaxed AND.{0,3}OR/);
  });

  it('mem_search omits the fallback hint when caller explicitly passed or=true', async () => {
    await initialize(proc);
    const resp = await callTool('mem_search', { query: 'AUDITKW zzzzz_nonexistent', or: true, limit: 3 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/AUDITKW entry/);
    expect(text).not.toMatch(/relaxed AND.{0,3}OR/);
  });

  // P2-7: obs ID passed with source=session should hint switching source.
  // Post-#8127: explicit `source` still forces all tokens to that bucket; the "no records
  // found in source(s) [session]" error is generalized and the probe hint still fires.
  it("P2-7: mem_get source=session with an obs ID hints to try source='obs'", async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [1], source: 'session' });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/No records found in source\(s\).*session/);
    expect(text).toMatch(/#1.*\(obs/);
    expect(text).toMatch(/source='obs'/);
  });

  it('P2-7: mem_get source=session with a truly missing ID omits the hint', async () => {
    await initialize(proc);
    const resp = await callTool('mem_get', { ids: [999999], source: 'session' });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/No records found in source\(s\).*session/);
    expect(text).not.toMatch(/Try:/);
  });
});

// ─── P2-5: Schema description documents anchor/query precedence ──────────────
// This is a pure documentation fix, so the test reads the zod descriptor.

describe('P2-5: memTimelineSchema documents anchor/query precedence', () => {
  it('anchor description mentions taking precedence over query', () => {
    const desc = memTimelineSchema.anchor.description;
    expect(desc).toMatch(/precedence/i);
    expect(desc).toMatch(/query/i);
  });

  it('query description mentions being ignored when anchor is present', () => {
    const desc = memTimelineSchema.query.description;
    expect(desc).toMatch(/ignored when anchor/i);
  });
});

// ─── T2 audit fixes ──────────────────────────────────────────────────────────
//
//   T2-P0-A MCP  maintain purge_stale ran without a confirm gate and silently deleted rows
//                — this is exactly how my audit wiped 421 pending-purge observations.
//   T2-P0-B MCP  optimize schema was missing `scope` so MCP callers could not reach
//                the wide re-enrich path that the CLI exposed as `--scope wide`.
//   T2-P1-A MCP  maintain execute with `operations: []` silently ran only FTS optimize.
//   T2-P1-B CLI  maintain operations did not emit the OP_CAP "re-run for more" hint.
//   T2-P1-C CLI  optimize --max 0 was swallowed by `|| 15` and ran 15 LLM calls anyway.
//   T2-P1-D CLI  optimize --task only accepted a single task; MCP took an array.

function seedDbWithPurgeable(dir, projectName = 'audit--probe') {
  const dbPath = join(dir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'audit-sess', project: projectName, memoryId: 'audit-mem' });
  // Three rows marked pending-purge and older than 30d (eligible for purge_stale).
  for (let i = 0; i < 3; i++) {
    insertObs(db, {
      sessionId: 'audit-mem',
      project: projectName,
      type: 'change',
      title: `PURGEABLE ${i}`,
      text: `stale marker ${i}`,
      importance: 1,
      epochOffset: -60 * 86_400_000, // 60 days old
      compressedInto: COMPRESSED_PENDING_PURGE,
    });
  }
  // One live control row that must NOT be purged.
  insertObs(db, {
    sessionId: 'audit-mem',
    project: projectName,
    type: 'bugfix',
    title: 'LIVE CONTROL',
    text: 'not-purgeable',
    importance: 3,
    epochOffset: 0,
    compressedInto: null,
  });
  db.close();
  return dbPath;
}

describe('MCP T2 audit fixes (stdio)', () => {
  let tmp, proc;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-audit-t2-'));
    seedDbWithPurgeable(tmp);
    proc = startServer(tmp);
  });

  afterEach(async () => {
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function callTool(name, args) {
    return rpc(proc, Math.floor(Math.random() * 1e9), 'tools/call', { name, arguments: args });
  }

  // T2-P0-A: purge_stale without confirm returns a preview and deletes nothing.
  it('T2-P0-A: mem_maintain purge_stale without confirm previews and does not delete', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: ['purge_stale'],
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/preview \(confirm=false\)/);
    expect(text).toMatch(/Candidates \(pending-purge, older than 30d\): 3/);
    expect(text).toMatch(/re-run with confirm=true/);

    // Verify the DB still has all 4 rows (3 purgeable + 1 live).
    const db = new Database(join(tmp, 'claude-mem-lite.db'));
    const count = db.prepare('SELECT COUNT(*) AS c FROM observations').get().c;
    db.close();
    expect(count).toBe(4);
  });

  it('T2-P0-A: mem_maintain purge_stale with confirm=true actually deletes', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: ['purge_stale'],
      confirm: true,
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Purged 3 stale observations/);

    const db = new Database(join(tmp, 'claude-mem-lite.db'));
    const remaining = db.prepare('SELECT title FROM observations').all();
    db.close();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('LIVE CONTROL');
  });

  it('MED-2: a confirmed purge VACUUM-snapshots the DB first (point-in-time pre-image)', async () => {
    await initialize(proc);
    expect(readdirSync(tmp).filter((n) => n.includes('.pre-maintain-')).length).toBe(0);

    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: ['purge_stale'],
      confirm: true,
    });
    expect(resp.result?.content?.[0]?.text || '').toMatch(/Purged 3 stale observations/);

    const baks = readdirSync(tmp).filter((n) => n.includes('.pre-maintain-') && n.endsWith('.bak'));
    expect(baks.length).toBeGreaterThanOrEqual(1);
    // Snapshot must be a usable copy taken BEFORE the delete — it still holds all 4
    // rows (3 purgeable + 1 live), proving it is a pre-image, not a post-delete copy.
    const snap = new Database(join(tmp, baks[0]), { readonly: true });
    const c = snap.prepare('SELECT COUNT(*) AS c FROM observations').get().c;
    snap.close();
    expect(c).toBe(4);
  });

  // M-7 (audit 2026-08-14): the OLD unconfirmed path was an early return that skipped
  // EVERY requested op, while the CLI twin ran the non-destructive ones and previewed
  // only the purge — same op list, different amount of work done, both "successful".
  // FAILS IF: the early return is reintroduced — the response then carries only the
  // preview, with no "Cleaned up"/"Decayed" lines.
  it('M-7: unconfirmed purge_stale previews the purge but still RUNS cleanup/decay (CLI parity)', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: ['cleanup', 'decay', 'purge_stale'],
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/preview \(confirm=false\)/);
    expect(text, 'cleanup must run despite the unconfirmed purge').toMatch(/Cleaned up \d+ broken/);
    expect(text, 'decay must run despite the unconfirmed purge').toMatch(/Decayed \d+ stale/);

    // Nothing was deleted: cleanup had no broken rows to remove, purge only previewed.
    const db = new Database(join(tmp, 'claude-mem-lite.db'));
    const count = db.prepare('SELECT COUNT(*) AS c FROM observations').get().c;
    db.close();
    expect(count).toBe(4);
  });

  it('T2-P0-A: confirm=false is explicit dry-run (same as omitted)', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: ['purge_stale'],
      confirm: false,
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/preview \(confirm=false\)/);
    expect(text).not.toMatch(/Purged \d+ stale observations/);
  });

  // T2-P0-B: optimize schema exposes the `scope` field.
  it('T2-P0-B: memOptimizeSchema exposes scope=narrow|wide', () => {
    const desc = memOptimizeSchema.scope?.description || '';
    expect(desc).toMatch(/wide/);
    expect(desc).toMatch(/narrow/);
    // Default must be narrow so behaviour is unchanged for callers who don't opt in.
    const parsed = memOptimizeSchema.scope.safeParse(undefined);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe('narrow');
  });

  // T2-P1-A: explicit empty operations array is rejected rather than silently running FTS only.
  it('T2-P1-A: mem_maintain execute with operations=[] returns isError', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', {
      action: 'execute',
      operations: [],
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).toBe(true);
    expect(text).toMatch(/operations array is empty/);
  });

  it('T2-P1-A: omitted operations still falls back to the default trio', async () => {
    await initialize(proc);
    const resp = await callTool('mem_maintain', { action: 'execute' });
    const text = resp.result?.content?.[0]?.text || '';
    // Default ops produce at least one Cleaned/Decayed/Boosted line.
    expect(text).toMatch(/Cleaned up \d+/);
    expect(text).toMatch(/Decayed \d+/);
    expect(text).toMatch(/Boosted \d+/);
  });
});

// ─── T2 CLI fixes (via run) ──────────────────────────────────────────────────

describe('T2 CLI fixes', () => {
  beforeEach(() => {
    testDb = (() => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      return db;
    })();
    insertSession(testDb, { id: 't2-sess', project: 'test--probe', memoryId: 't2-mem' });
  });
  afterEach(() => {
    testDb.close();
  });

  // T2-P1-C
  it('T2-P1-C: optimize --max 0 is rejected (not swallowed by || 15)', async () => {
    const output = await captureStdout(() => run(['optimize', '--run', '--max', '0']));
    expect(output).toMatch(/Invalid --max "0"/);
    expect(output).not.toMatch(/Running LLM optimization/);
  });

  it('T2-P1-C: optimize --max above 100 is rejected', async () => {
    const output = await captureStdout(() => run(['optimize', '--run', '--max', '200']));
    expect(output).toMatch(/Invalid --max "200"/);
  });

  // T2-P1-D
  it('T2-P1-D: optimize --task accepts a single task (back-compat)', async () => {
    const output = await captureStdout(() => run(['optimize', '--task', 're-enrich']));
    // preview path still runs (no --run) and shows the preview header.
    expect(output).toMatch(/Optimization Preview/);
  });

  it('T2-P1-D: optimize --task accepts comma-separated multi-task', async () => {
    const output = await captureStdout(() => run(['optimize', '--task', 're-enrich,cluster-merge']));
    expect(output).toMatch(/Optimization Preview/);
  });

  it('T2-P1-D: optimize --task rejects unknown task names', async () => {
    const output = await captureStdout(() => run(['optimize', '--task', 'not-a-task']));
    expect(output).toMatch(/Unknown task\(s\): not-a-task/);
    expect(output).toMatch(/Valid: re-enrich, normalize, cluster-merge, smart-compress/);
  });

  // Dogfood-2: --scope previously did `args[i+1] === 'wide' ? 'wide' : 'narrow'`, silently
  // treating typos like `--scope wlde` as narrow. Validate explicitly so wasted LLM tokens
  // don't hide behind a falsey-coerced default.
  it('optimize --scope rejects unknown scope values', async () => {
    const output = await captureStdout(() => run(['optimize', '--scope', 'bogus']));
    expect(output).toMatch(/Invalid --scope/);
    // Every accepted value must be named in the error — a scope missing from this
    // list is a scope users can't discover from the failure they actually hit.
    expect(output).toMatch(/narrow, wide, aliases, scopes/);
  });

  it('optimize --scope accepts narrow, wide, aliases and scopes', async () => {
    for (const scope of ['narrow', 'wide', 'aliases', 'scopes']) {
      const output = await captureStdout(() => run(['optimize', '--scope', scope]));
      expect(output).toMatch(/Optimization Preview/);
    }
  });

  // T2-P1-B: purge_stale preview (shares code path with OP_CAP hint helper).
  it('T2-P0-A CLI parity: maintain purge_stale without --confirm previews only', async () => {
    // Seed a pending-purge row.
    insertObs(testDb, {
      sessionId: 't2-mem',
      project: 'test--probe',
      type: 'change',
      title: 'CLI PURGEABLE',
      text: 'stale',
      importance: 1,
      epochOffset: -60 * 86_400_000,
      compressedInto: COMPRESSED_PENDING_PURGE,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'purge_stale']));
    expect(output).toMatch(/purge_stale preview \(no --confirm\)/);
    expect(output).toMatch(/Candidates \(pending-purge, older than 30d\): 1/);

    // Row must still exist.
    const row = testDb.prepare("SELECT id FROM observations WHERE title = 'CLI PURGEABLE'").get();
    expect(row).toBeDefined();
  });

  it('T2-P0-A CLI parity: maintain purge_stale --confirm actually deletes', async () => {
    insertObs(testDb, {
      sessionId: 't2-mem',
      project: 'test--probe',
      type: 'change',
      title: 'CLI PURGEABLE 2',
      text: 'stale',
      importance: 1,
      epochOffset: -60 * 86_400_000,
      compressedInto: COMPRESSED_PENDING_PURGE,
    });
    const output = await captureStdout(() =>
      run(['maintain', 'execute', '--ops', 'purge_stale', '--confirm']),
    );
    expect(output).toMatch(/Purged 1 stale observations/);
    const row = testDb.prepare("SELECT id FROM observations WHERE title = 'CLI PURGEABLE 2'").get();
    expect(row).toBeUndefined();
  });

  it('CLI parity: maintain purge_stale rejects out-of-range --retain-days (no DELETE)', async () => {
    // A negative --retain-days made retainCutoff a FUTURE timestamp → purged the
    // whole pending-purge backlog regardless of age. Invalid input must abort the
    // DELETE. fail() sets exitCode but does NOT throw, so the fix needs an explicit
    // return — without it execution falls through to the purge with the bad value.
    insertObs(testDb, {
      sessionId: 't2-mem',
      project: 'test--probe',
      type: 'change',
      title: 'CLI NEG RETAIN',
      text: 'stale',
      importance: 1,
      epochOffset: -60 * 86_400_000,
      compressedInto: COMPRESSED_PENDING_PURGE,
    });
    const output = await captureStdout(() =>
      run(['maintain', 'execute', '--ops', 'purge_stale', '--confirm', '--retain-days', '-5']),
    );
    expect(output).toContain('--retain-days must be an integer in [7, 365]');
    expect(output).not.toMatch(/Purged \d+ stale/);
    // Row must survive — the invalid run never reached the DELETE.
    const row = testDb.prepare("SELECT id FROM observations WHERE title = 'CLI NEG RETAIN'").get();
    expect(row).toBeDefined();
  });

  it('HIGH-1: decay,purge_stale runs purge BEFORE decay — a row marked THIS run is not deleted same-run', async () => {
    // Pre-fix the CLI ran decay (which marks an old stale row pending-purge) BEFORE purge in
    // one transaction, so the row was marked AND deleted in the same call — zero grace, and
    // the pre-txn snapshot guard (counts only PRE-EXISTING pending rows) skipped the backup →
    // permanent loss of notable memories. Purge now runs first (matching the auto-maintain hook).
    insertObs(testDb, {
      sessionId: 't2-mem',
      project: 'test--probe',
      type: 'decision',
      title: 'MARKED THIS RUN',
      text: 'x',
      narrative: 'rationale',
      importance: 1,
      epochOffset: -60 * 86_400_000, // old, never accessed/injected → mark-idle marks it
    });
    const out1 = await captureStdout(() =>
      run(['maintain', 'execute', '--ops', 'decay,purge_stale', '--confirm', '--retain-days', '7']),
    );
    expect(out1).toMatch(/Purged 0 stale observations/); // purge ran first, nothing pre-existing pending
    const row = testDb
      .prepare("SELECT compressed_into FROM observations WHERE title = 'MARKED THIS RUN'")
      .get();
    expect(row).toBeDefined(); // SURVIVED (pre-fix: deleted same run)
    expect(row.compressed_into).toBe(COMPRESSED_PENDING_PURGE); // marked, to be purged on a LATER run

    // Next run: the row is now PRE-EXISTING pending → purge deletes it (with the snapshot guard live).
    const out2 = await captureStdout(() =>
      run(['maintain', 'execute', '--ops', 'decay,purge_stale', '--confirm', '--retain-days', '7']),
    );
    expect(out2).toMatch(/Purged 1 stale observations/);
    expect(
      testDb.prepare("SELECT id FROM observations WHERE title = 'MARKED THIS RUN'").get(),
    ).toBeUndefined();
  });

  it('MED-2: invalid --retain-days rejects atomically — a cleanup hard-delete in the same command does NOT commit', async () => {
    // The retain-days range check used to live INSIDE db.transaction() with a bare `return`,
    // so cleanup/decay had already mutated and the transaction COMMITTED despite exit 1.
    insertObs(testDb, {
      sessionId: 't2-mem',
      project: 'test--probe',
      type: 'change',
      title: '',
      text: 'broken',
      narrative: '',
      importance: 1, // cleanupBroken candidate
      epochOffset: -60 * 86_400_000,
    });
    const output = await captureStdout(() =>
      run(['maintain', 'execute', '--ops', 'cleanup,purge_stale', '--confirm', '--retain-days', '3']),
    );
    expect(output).toContain('--retain-days must be an integer in [7, 365]');
    expect(output).not.toMatch(/Cleaned up \d+ broken/); // cleanup never ran — validated before the txn
    const broken = testDb.prepare("SELECT id FROM observations WHERE title = '' AND narrative = ''").get();
    expect(broken).toBeDefined(); // the broken row survives (atomic reject)
  });
});

// ─── T2 maintain schema surface ──────────────────────────────────────────────

// ─── T4 audit fixes ──────────────────────────────────────────────────────────
//
//   T4-P1-A  hook auto-maintain comment claimed "7-day retention" but the filter
//            `created_at_epoch < now-7d` was redundant with the 30-day marking gate —
//            effective retention was next daily cycle (~24h). Fix: cutoff = now - 37d.
//   T4-P1-B  pre-skill-bridge.js used plain-text stdout; some CC variants drop plain-text
//            PreToolUse output (sdscc). Fix: switch to JSON `hookSpecificOutput`.
//            PIN REMOVED 2026-09 with the skill-registry subsystem itself
//            (docs/audits/20260906-145304.md). The JSON-stdout contract it pinned is
//            still enforced tree-wide by tests/hook-script-stdout-contract.test.mjs.
//   T4-P2-B  handleStop inserted fast session_summaries without a dedup guard — Stop fired
//            twice produced a duplicate row. Fix: mirror handleSessionStart's `hasSummary` check.
//   T4-P2-D  handleUserPrompt did UPDATE prompt_counter + SELECT as two statements — concurrent
//            prompts could read a stale counter. Fix: UPDATE ... RETURNING prompt_counter.

import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const HOOK_PATH = resolve(new URL('..', import.meta.url).pathname, 'hook.mjs');

const DAY_MS = 86_400_000;
const PENDING_PURGE_MARKER = -2; // COMPRESSED_PENDING_PURGE

// Init a DB under `{home}/.claude-mem-lite/claude-mem-lite.db` with initSchema.
function initHomeDb(home) {
  const dbDir = join(home, '.claude-mem-lite');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dbDir, 'runtime'), { recursive: true });
  const dbPath = join(dbDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return { db, dbPath };
}

// `event` may be a string or [event, ...argv] — `auto-maintain` takes the project scope
// as argv[3] since the compress-marking passes moved off SessionStart (P2-11).
function runHookCmd(event, { home, stdin = '', cwd = home }) {
  try {
    const stdout = execFileSync(process.execPath, [HOOK_PATH, ...(Array.isArray(event) ? event : [event])], {
      input: stdin,
      timeout: 10000,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: cwd,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_COMPRESS: '1',
        CLAUDE_MEM_SKIP_OPTIMIZE: '1',
        // MED-4: maintenance moved to the detached auto-maintain worker. Skip the
        // SessionStart spawn so tests deterministically drive it via an explicit
        // runHookCmd('auto-maintain', ...) call instead of racing a background proc.
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        MEM_NO_AUTO_ADOPT: '1',
        MEM_QUIET_HOOKS: '1',
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

describe('T4-P1-A: auto-maintain 7-day retention (hook.mjs)', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-audit-t4-ret-'));
    // Project dir must match a basename that sanitizes to `audit--t4`.
    projDir = join(tmpHome, 'workspace', 't4');
    mkdirSync(projDir, { recursive: true });
    // Move the project dir up so that `inferProject()` (basename + parent) maps to "audit--t4".
    // inferProject: parent=workspace, base=t4 → "workspace--t4" — not what we want.
    // To get "audit--t4" we need parent=audit, base=t4.
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('preserves pending-purge rows aged 34 days (within 37d cutoff) across SessionStart', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();

    // Seed three rows, each with compressed_into = PENDING_PURGE_MARKER:
    //   A: 40 days old → must be purged under fixed 37d cutoff (older than 37d)
    //   B: 34 days old → must SURVIVE (newer than 37d cutoff, even though marked)
    //   C: 20 days old → not even eligible for marking yet; sanity control
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('t4-ret-sess', 't4-ret-mem', ?, ?, ?, 'active')
    `,
    ).run(((project_) => project_)('audit--t4'), new Date().toISOString(), now);

    const insertObsRaw = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, compressed_into, access_count,
        created_at, created_at_epoch)
      VALUES ('t4-ret-mem', ?, ?, 'change', ?, '', '', '', '', '[]', '[]', 1, ?, 0, ?, ?)
    `);
    insertObsRaw.run(
      'audit--t4',
      'row A body',
      'row A (40d)',
      PENDING_PURGE_MARKER,
      new Date(now - 40 * DAY_MS).toISOString(),
      now - 40 * DAY_MS,
    );
    insertObsRaw.run(
      'audit--t4',
      'row B body',
      'row B (34d)',
      PENDING_PURGE_MARKER,
      new Date(now - 34 * DAY_MS).toISOString(),
      now - 34 * DAY_MS,
    );
    insertObsRaw.run(
      'audit--t4',
      'row C body',
      'row C (20d, unmarked)',
      null,
      new Date(now - 20 * DAY_MS).toISOString(),
      now - 20 * DAY_MS,
    );
    db.close();

    // SessionStart schedules the auto-maintain cycle; MED-4 runs it in a detached
    // worker (skipped here), so drive it explicitly for a deterministic result.
    const stdinPayload = JSON.stringify({ session_id: 'cc-t4-uuid' });
    runHookCmd('session-start', { home: tmpHome, cwd: projDir, stdin: stdinPayload });
    runHookCmd('auto-maintain', { home: tmpHome, cwd: projDir });

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const titles = db2
        .prepare('SELECT title FROM observations ORDER BY created_at_epoch ASC')
        .all()
        .map((r) => r.title);
      // After the fix: A is deleted; B (34d, marked) survives; C (20d, unmarked) survives.
      expect(titles).not.toContain('row A (40d)');
      expect(titles).toContain('row B (34d)');
      expect(titles).toContain('row C (20d, unmarked)');
    } finally {
      db2.close();
    }
  });

  it('recovers children of a purged keeper instead of orphaning them (hook → shared purgeStale)', () => {
    // The hook purge was an inline DELETE that skipped recoverChildrenOf: deleting a
    // keeper that had absorbed dups left its children with compressed_into dangling at
    // a now-deleted id. Routing through purgeStale recovers them first.
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('t4-orph-sess', 't4-ret-mem', 'audit--t4', ?, ?, 'active')
    `,
    ).run(new Date().toISOString(), now);

    const insertObsRaw = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, compressed_into, access_count, created_at, created_at_epoch)
      VALUES ('t4-ret-mem', 'audit--t4', ?, 'change', ?, '', '', '', '', '[]', '[]', 1, ?, 0, ?, ?)
    `);
    // keeper: pending-purge, 40d → will be deleted; child points at it and must be recovered.
    const keeperId = Number(
      insertObsRaw.run(
        'keeper body',
        'doomed keeper (40d)',
        PENDING_PURGE_MARKER,
        new Date(now - 40 * DAY_MS).toISOString(),
        now - 40 * DAY_MS,
      ).lastInsertRowid,
    );
    insertObsRaw.run('child body', 'child of keeper', keeperId, new Date(now).toISOString(), now);
    db.close();

    runHookCmd('session-start', {
      home: tmpHome,
      cwd: projDir,
      stdin: JSON.stringify({ session_id: 'cc-t4-orph' }),
    });
    runHookCmd('auto-maintain', { home: tmpHome, cwd: projDir });

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const keeperGone = !db2
        .prepare('SELECT 1 FROM observations WHERE title = ?')
        .get('doomed keeper (40d)');
      const child = db2
        .prepare('SELECT compressed_into FROM observations WHERE title = ?')
        .get('child of keeper');
      expect(keeperGone).toBe(true);
      expect(child).toBeDefined();
      expect(child.compressed_into).toBeNull(); // recovered, NOT left dangling at the deleted keeper id
    } finally {
      db2.close();
    }
  });
});

describe('Fuzzy auto-dedup (hook auto-maintain)', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-audit-fuzzy-dedup-'));
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('supersedes near-identical titles (Jaccard ≥ 0.95) and leaves unrelated rows untouched', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('fuzzy-sess', 'fuzzy-mem', 'audit--t4', ?, ?, 'active')
    `,
    ).run(new Date().toISOString(), now);

    const insertObsRaw = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, compressed_into, access_count,
        created_at, created_at_epoch)
      VALUES ('fuzzy-mem', 'audit--t4', '', 'change', ?, '', '', '', '', '[]', '[]', 1, NULL, 0, ?, ?)
    `);
    // Two near-duplicates with reordered tokens (Jaccard = 1.0).
    // Ages must stay under 7 days — the SessionStart "noise-compress" pass
    // (line 658+) hides any 'Modified %' title older than 7d before fuzzy
    // dedup runs, so the realistic catch window is 0–7d.
    insertObsRaw.run(
      'Modified server.mjs, mem-cli.mjs',
      new Date(now - 5 * DAY_MS).toISOString(),
      now - 5 * DAY_MS,
    );
    insertObsRaw.run(
      'Modified mem-cli.mjs, server.mjs',
      new Date(now - 3 * DAY_MS).toISOString(),
      now - 3 * DAY_MS,
    );
    // Control row — different content, must survive untouched
    insertObsRaw.run('Modified hook.mjs', new Date(now - 4 * DAY_MS).toISOString(), now - 4 * DAY_MS);
    db.close();

    const stdinPayload = JSON.stringify({ session_id: 'cc-fuzzy-uuid' });
    runHookCmd('session-start', { home: tmpHome, cwd: projDir, stdin: stdinPayload });
    runHookCmd('auto-maintain', { home: tmpHome, cwd: projDir }); // MED-4: maintenance runs in the worker

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const rows = db2
        .prepare('SELECT title, superseded_at, superseded_by FROM observations ORDER BY created_at_epoch ASC')
        .all();
      // Exactly one of the two near-duplicates is superseded; the other survives as keeper.
      const dupRows = rows.filter(
        (r) => r.title.startsWith('Modified server.mjs') || r.title.startsWith('Modified mem-cli.mjs'),
      );
      expect(dupRows.length).toBe(2);
      const superseded = dupRows.filter((r) => r.superseded_at !== null);
      expect(superseded.length).toBe(1);
      expect(superseded[0].superseded_by).toBe('auto-dedup-fuzzy');
      // Control row must be untouched
      const ctrl = rows.find((r) => r.title === 'Modified hook.mjs');
      expect(ctrl.superseded_at).toBeNull();
    } finally {
      db2.close();
    }
  });

  it('respects CLAUDE_MEM_SKIP_AUTO_DEDUP_FUZZY env opt-out', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('fuzzy-skip-sess', 'fuzzy-skip-mem', 'audit--t4', ?, ?, 'active')
    `,
    ).run(new Date().toISOString(), now);

    const insertObsRaw = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, compressed_into, access_count,
        created_at, created_at_epoch)
      VALUES ('fuzzy-skip-mem', 'audit--t4', '', 'change', ?, '', '', '', '', '[]', '[]', 1, NULL, 0, ?, ?)
    `);
    insertObsRaw.run('Modified A.mjs, B.mjs', new Date(now - 4 * DAY_MS).toISOString(), now - 4 * DAY_MS);
    insertObsRaw.run('Modified B.mjs, A.mjs', new Date(now - 3 * DAY_MS).toISOString(), now - 3 * DAY_MS);
    db.close();

    // Run the maintenance worker directly (MED-4: maintenance moved off SessionStart)
    // with the fuzzy-dedup opt-out set, and assert the worker honors it.
    try {
      execFileSync(process.execPath, [HOOK_PATH, 'auto-maintain'], {
        input: JSON.stringify({ session_id: 'cc-fuzzy-skip' }),
        timeout: 10000,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tmpHome,
          CLAUDE_PROJECT_DIR: projDir,
          CLAUDE_MEM_SKIP_UPDATE: '1',
          CLAUDE_MEM_SKIP_COMPRESS: '1',
          CLAUDE_MEM_SKIP_OPTIMIZE: '1',
          CLAUDE_MEM_SKIP_AUTO_DEDUP_FUZZY: '1',
          MEM_NO_AUTO_ADOPT: '1',
          MEM_QUIET_HOOKS: '1',
          CLAUDE_MEM_HOOK_RUNNING: undefined,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      /* ignore non-zero exit; we only assert DB state */
    }

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const rows = db2.prepare('SELECT title, superseded_at FROM observations').all();
      // Both rows untouched when fuzzy-dedup is skipped
      expect(rows.every((r) => r.superseded_at === null)).toBe(true);
    } finally {
      db2.close();
    }
  });
});

describe('T4-P2-B: handleStop fast summary dedup', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-audit-t4-stop-'));
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('running Stop twice for the same session produces at most one fast summary', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();

    // Seed: one active session + one user_prompt + one observation.
    const sessId = 'hook-audit--t4-' + randomUUID().slice(0, 8);
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'audit--t4', ?, ?, 'active')
    `,
    ).run(sessId, sessId, new Date(now).toISOString(), now);
    db.prepare(
      `
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
      VALUES (?, 'initial probe prompt for dedup test', 1, ?, ?)
    `,
    ).run(sessId, new Date(now).toISOString(), now);
    db.prepare(
      `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES (?, 'audit--t4', 'obs body', 'change', 'T4 stop probe obs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `,
    ).run(sessId, new Date(now).toISOString(), now);
    db.close();

    // Write session file so hook.mjs getSessionId() returns the same id on both runs.
    writeFileSync(
      join(tmpHome, '.claude-mem-lite', 'runtime', `session-audit--t4`),
      JSON.stringify({ id: sessId, project: 'audit--t4', startedAt: now }),
    );

    const stdin = JSON.stringify({ session_id: 'cc-t4-stop-uuid' });
    runHookCmd('stop', { home: tmpHome, cwd: projDir, stdin });
    // Re-write the session file (Stop deletes it) so the second call can find the same id.
    writeFileSync(
      join(tmpHome, '.claude-mem-lite', 'runtime', `session-audit--t4`),
      JSON.stringify({ id: sessId, project: 'audit--t4', startedAt: now }),
    );
    runHookCmd('stop', { home: tmpHome, cwd: projDir, stdin });

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const count = db2
        .prepare('SELECT COUNT(*) AS c FROM session_summaries WHERE memory_session_id = ?')
        .get(sessId).c;
      expect(count).toBeLessThanOrEqual(1);
    } finally {
      db2.close();
    }
  });
});

describe('T4-P2-D: prompt_counter is atomic per prompt', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-audit-t4-counter-'));
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('sequential UserPromptSubmit events produce distinct monotonic prompt_number values', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    db.close();

    // Send three prompts back-to-back; even the simpler sequential case must remain correct
    // after the UPDATE/SELECT → UPDATE ... RETURNING refactor.
    const stdinFor = (text) => JSON.stringify({ prompt: text, session_id: 'cc-t4-counter' });
    for (const t of ['prompt alpha audit', 'prompt beta audit', 'prompt gamma audit']) {
      runHookCmd('user-prompt', { home: tmpHome, cwd: projDir, stdin: stdinFor(t) });
    }

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const numbers = db2
        .prepare(`SELECT prompt_number FROM user_prompts ORDER BY id ASC`)
        .all()
        .map((r) => r.prompt_number);
      expect(numbers).toEqual([1, 2, 3]);
    } finally {
      db2.close();
    }
  });
});

describe('handleUserPrompt: secret scrub runs BEFORE the 10k prompt slice', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-prompt-scrub-'));
    projDir = join(tmpHome, 'audit', 'scrub');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('does not persist a secret value straddling the 10000-char prompt_text cut', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    db.close();

    // 9974-char pad lands the AWS key value head at ~char 9997, so slice(0,10000)
    // cuts it to a 3-char head ('AKI'). scrubSecrets's assignment regex needs a
    // >=6-char value, so a post-slice scrub would miss the head — pre-fix the
    // partial secret persisted into prompt_text. Scrubbing the full text first fixes it.
    const pad = 'x'.repeat(9974);
    const prompt = `${pad} AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE done`;
    runHookCmd('user-prompt', {
      home: tmpHome,
      cwd: projDir,
      stdin: JSON.stringify({ prompt, session_id: 'cc-scrub' }),
    });

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const row = db2.prepare('SELECT prompt_text FROM user_prompts ORDER BY id DESC LIMIT 1').get();
      expect(row).toBeTruthy();
      // A credential key directly followed by an alphanumeric char = unscrubbed secret head.
      expect(row.prompt_text).not.toMatch(/ACCESS_KEY=[A-Za-z0-9]/);
    } finally {
      db2.close();
    }
  });
});

// ─── P0: detectMemOverride wired into handleUserPrompt ──────────────────────
// Regex correctness lives in tests/user-prompt-search.test.mjs > detectMemOverride.
// This integration test only verifies the wiring: a prompt that matches the
// override regex must produce no <memory-context> emission, even when
// observations matching the prompt exist in the DB.

describe('P0: handleUserPrompt honors memory-override directive', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-p0-override-'));
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits <memory-context> for a normal prompt and suppresses it on "ignore memory"', () => {
    const { db } = initHomeDb(tmpHome);
    insertSession(db, { id: 'cc-p0-override', project: 'audit--t4' });
    // Seed target FIRST with an older epoch so it falls out of the
    // handleUserPrompt Key Context top-5 (which excludes its own ids from
    // searchRelevantMemories, see hook.mjs:1123-1130). The noise rows seed
    // both BM25 corpus diversity (mirrors memory-inject.test.mjs:14-20) and
    // the Key Context exclusion slots.
    insertObs(db, {
      sessionId: 'cc-p0-override',
      project: 'audit--t4',
      type: 'bugfix',
      title: 'Fixed dispatch race condition',
      narrative: 'Lock contention in episode flush',
      text: 'dispatch race condition lock contention episode flush',
      importance: 3,
      epochOffset: -3600_000,
    });
    for (let i = 900; i <= 920; i++) {
      insertObs(db, {
        sessionId: 'cc-p0-override',
        project: 'audit--t4',
        type: 'change',
        title: `Updated config file ${i}`,
        text: `config yaml settings update number ${i}`,
        importance: 2,
      });
    }
    db.close();

    const baseStdin = (text) => JSON.stringify({ prompt: text, session_id: 'cc-p0-override' });

    // Positive control: prompt phrased to satisfy the v27 term-coverage gate
    // against the seeded title ("Fixed dispatch race condition"). Confirms
    // that memory injection runs in the absence of an override directive.
    const normal = runHookCmd('user-prompt', {
      home: tmpHome,
      cwd: projDir,
      stdin: baseStdin('dispatch race condition'),
    });
    expect(normal.exitCode).toBe(0);
    expect(normal.stdout).toContain('<memory-context');

    // Override path (EN): same query intent but with explicit ignore directive.
    // Must produce zero <memory-context> emission.
    const overrideEn = runHookCmd('user-prompt', {
      home: tmpHome,
      cwd: projDir,
      stdin: baseStdin('ignore memory dispatch race condition'),
    });
    expect(overrideEn.exitCode).toBe(0);
    expect(overrideEn.stdout).not.toContain('<memory-context');

    // Override path (CN): parallel for 中文 directive.
    const overrideCn = runHookCmd('user-prompt', {
      home: tmpHome,
      cwd: projDir,
      stdin: baseStdin('不要用记忆，dispatch race condition'),
    });
    expect(overrideCn.exitCode).toBe(0);
    expect(overrideCn.stdout).not.toContain('<memory-context');
  });
});

describe('T2 schema: memMaintainSchema.confirm', () => {
  it('exposes the confirm field with a descriptive string', () => {
    expect(memMaintainSchema.confirm).toBeDefined();
    const desc = memMaintainSchema.confirm.description;
    expect(desc).toMatch(/purge_stale/);
    expect(desc).toMatch(/dry-run|preview|destructive/i);
  });
});

// ─── T3 audit fixes ──────────────────────────────────────────────────────────
//
//   T3-P1-A MCP  export silently skipped invalid date filters (CLI errored loudly)
//   T3-P2-A MCP  registry list ordered by name, showing "adopt:null" for NULL counts
//   T3-P2-B MCP  export "Results capped at N" fired even when N was exactly available
//   T3-P2-C MCP  fts_check had a dead "Unknown action" branch gated by the Zod enum
//   T3-P2-D MCP  export SELECT missed branch / access_count / memory_session_id

describe('MCP T3 audit fixes (stdio)', () => {
  let tmp, proc;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-audit-t3-'));
    const dbPath = join(tmp, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 't3-sess', project: 'audit--t3', memoryId: 't3-mem' });
    // Seed 2 observations — one with branch, access_count, and a lesson to verify export completeness.
    insertObs(db, {
      sessionId: 't3-mem',
      project: 'audit--t3',
      type: 'bugfix',
      title: 'T3 seed row 1',
      text: 'seed one',
      importance: 2,
      epochOffset: -1000,
      accessCount: 7,
      branch: 'main',
      lessonLearned: 'export must include branch & access_count',
    });
    insertObs(db, {
      sessionId: 't3-mem',
      project: 'audit--t3',
      type: 'change',
      title: 'T3 seed row 2',
      text: 'seed two',
      importance: 1,
      epochOffset: 0,
      branch: 'feature/probe',
    });
    db.close();
    proc = startServer(tmp);
  });

  afterEach(async () => {
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function callTool(name, args) {
    return rpc(proc, Math.floor(Math.random() * 1e9), 'tools/call', { name, arguments: args });
  }

  // T3-P1-A: invalid date must throw instead of being silently dropped.
  it('T3-P1-A: mem_export with invalid date_from surfaces an error', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', {
      project: 'audit--t3',
      date_from: 'not-a-date',
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).toBe(true);
    expect(text).toMatch(/Invalid date_from/i);
  });

  it('T3-P1-A: mem_export with invalid date_to surfaces an error', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', {
      project: 'audit--t3',
      date_to: '2026-13-40', // invalid calendar date
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).toBe(true);
    expect(text).toMatch(/Invalid date_to/i);
  });

  it('T3-P1-A: mem_export with valid ISO date_from works', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', {
      project: 'audit--t3',
      date_from: '2020-01-01',
      limit: 10,
    });
    const text = resp.result?.content?.[0]?.text || '';
    expect(resp.result?.isError).not.toBe(true);
    expect(text).toMatch(/Exported 2 observations/);
  });

  // T3-P2-A: registry list sorts by adoption and never prints "adopt:null".
  it('T3-P2-A: mem_registry list never emits "adopt:null"', async () => {
    await initialize(proc);
    const resp = await callTool('mem_registry', { action: 'list' });
    const text = resp.result?.content?.[0]?.text || '';
    // Empty registries yield "No resources found." — only assert formatting when populated.
    if (/^Resources /m.test(text)) {
      expect(text).not.toMatch(/adopt:null/);
    }
  });

  // T3-P2-B: cap message must not fire when the result equals the explicit limit but no more rows exist.
  it('T3-P2-B: mem_export with limit == total does NOT claim "capped"', async () => {
    await initialize(proc);
    // The seeded DB has exactly 2 rows for audit--t3 — request limit=2 (equals total).
    const resp = await callTool('mem_export', { project: 'audit--t3', limit: 2 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Exported 2 observations/);
    expect(text).not.toMatch(/capped at/);
  });

  it('T3-P2-B: mem_export with limit < total DOES flag capped', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', { project: 'audit--t3', limit: 1 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Exported 1 observations/);
    expect(text).toMatch(/capped at 1/);
  });

  // T3-P2-D: export must include branch / access_count / memory_session_id in the JSON payload.
  it('T3-P2-D: mem_export JSON includes branch, access_count, memory_session_id', async () => {
    await initialize(proc);
    const resp = await callTool('mem_export', { project: 'audit--t3', limit: 10, format: 'jsonl' });
    const text = resp.result?.content?.[0]?.text || '';
    // Extract JSONL lines (skip the "Exported N" header).
    const lines = text.split('\n').filter((l) => l.startsWith('{'));
    expect(lines.length).toBeGreaterThan(0);
    const row = JSON.parse(lines[0]);
    expect(row).toHaveProperty('branch');
    expect(row).toHaveProperty('access_count');
    expect(row).toHaveProperty('memory_session_id');
    // At least one row must have a concrete branch value (seeded).
    const hasBranch = lines
      .map((l) => JSON.parse(l))
      .some((r) => r.branch === 'main' || r.branch === 'feature/probe');
    expect(hasBranch).toBe(true);
  });
});

// ─── T-anchor-prefix: mem_timeline accepts P#/S#/# prefix anchors ───────────
// Pre-fix symptom: MCP memTimelineSchema.anchor was int-only, so pasting a
// P#/S# token from mem_search output hit `Input validation error: expected
// number`. CLI `timeline --anchor` supported prefixes since v2.39.0; this
// restores CLI↔MCP parity per #8050 and unblocks the paste-from-search flow.

function seedPrefixAnchorDb(dir) {
  const dbPath = join(dir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  insertSession(db, { id: 'anchor-sess', project: 'anchor--probe', memoryId: 'anchor-mem' });
  // 5 obs spaced 1-day apart; newest = i=0, oldest = i=4.
  for (let i = 0; i < 5; i++) {
    insertObs(db, {
      sessionId: 'anchor-mem',
      project: 'anchor--probe',
      type: 'discovery',
      title: `Anchor obs ${i}`,
      text: `anchor probe body ${i}`,
      importance: 2,
      epochOffset: -i * 86_400_000,
    });
  }
  // One prompt placed exactly at obs #3's epoch → nearest-obs should be #3.
  const nowMs = Date.now();
  const obs3Epoch = nowMs - 2 * 86_400_000; // i=2 → id=3 (1-indexed autoincrement)
  db.prepare(
    `
    INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run('anchor-sess', 'prompt near obs 3', 1, new Date(obs3Epoch).toISOString(), obs3Epoch);
  // One session_summary placed at obs #5's epoch → nearest-obs should be #5.
  const obs5Epoch = nowMs - 4 * 86_400_000;
  db.prepare(
    `
    INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    'anchor-mem',
    'anchor--probe',
    'summary near obs 5',
    'done',
    new Date(obs5Epoch).toISOString(),
    obs5Epoch,
  );
  db.close();
  return dbPath;
}

describe('T-anchor-prefix: mem_timeline prefix anchor parity (stdio)', () => {
  let tmp, proc;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-anchor-'));
    seedPrefixAnchorDb(tmp);
    proc = startServer(tmp);
  });

  afterEach(async () => {
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function callTool(name, args) {
    return rpc(proc, Math.floor(Math.random() * 1e9), 'tools/call', { name, arguments: args });
  }

  it('resolves P#<id> anchor to the nearest-in-time observation', async () => {
    await initialize(proc);
    const resp = await callTool('mem_timeline', { anchor: 'P#1', before: 1, after: 1 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/anchored to #3, closest obs to P#1/);
    expect(text).toMatch(/Anchor obs 2/); // nearest obs to prompt = id=3 => "Anchor obs 2"
  });

  it('resolves S#<id> anchor to the nearest-in-time observation', async () => {
    await initialize(proc);
    const resp = await callTool('mem_timeline', { anchor: 'S#1', before: 1, after: 1 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/anchored to #5, closest obs to S#1/);
    expect(text).toMatch(/Anchor obs 4/); // nearest obs to session = id=5 => "Anchor obs 4"
  });

  it('accepts bare #<id> anchor (obs fast path)', async () => {
    await initialize(proc);
    const resp = await callTool('mem_timeline', { anchor: '#2', before: 1, after: 1 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Timeline around #2/);
    expect(text).not.toMatch(/anchored to/); // no redirect note for obs
  });

  it('still accepts plain integer anchor (legacy path unchanged)', async () => {
    await initialize(proc);
    const resp = await callTool('mem_timeline', { anchor: 2, before: 1, after: 1 });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Timeline around #2/);
  });

  it('returns not-found message for P#<huge-id>', async () => {
    await initialize(proc);
    const resp = await callTool('mem_timeline', { anchor: 'P#999999' });
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Prompt P#999999 not found/);
  });

  it('rejects malformed prefix strings at schema layer', async () => {
    await initialize(proc);
    const resp = await callTool('mem_timeline', { anchor: 'X#42' });
    // Lock the error payload shape: schema rejection must set isError=true (not
    // coincidental "Invalid" in a title). Regex below is secondary evidence.
    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text || '';
    expect(text).toMatch(/Invalid|Expected N|MCP error|invalid_type|regex/i);
  });
});

// ─── v2.56.0 #4: injection_count protects from decay/mark-idle ──────────────
//
// Pre-v2.56 auto-maintain (hook.mjs:711-735) and cmdMaintain decay (mem-cli.mjs:1568+)
// only checked access_count=0 when deciding whether to decay imp or mark
// pending-purge. injection_count is a SEPARATE counter — bumped by
// hook-memory.mjs when the obs is auto-injected into Claude's context. An obs
// auto-injected 8x by the hook is contextually proven valuable (Claude saw it
// during a search-relevant prompt) even if the user never explicitly fetched
// it via `mem get`. The pre-v2.56 filter would still mark such obs as
// pending-purge after 30d, deleting them on the next cycle (~37d).
//
// Fix: add `AND COALESCE(injection_count, 0) = 0` to both decay and mark-idle
// WHERE clauses in hook.mjs auto-maintain + mem-cli.mjs cmdMaintain. Treats
// injection_count as a first-class engagement signal alongside access_count.
describe('v2.56.0 #4: injection_count protects from auto-maintain decay/mark-idle', () => {
  let tmpHome, projDir;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-v256-injection-protect-'));
    projDir = join(tmpHome, 'audit', 't4');
    mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('preserves obs with injection_count > 0 from being marked pending-purge', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('inj-prot-sess', 'inj-prot-mem', 'audit--t4', ?, ?, 'active')
    `,
    ).run(new Date().toISOString(), now);

    // Three obs, all 35d old (>30d STALE_AGE), all imp=1, all access_count=0:
    //   A: injection_count=8 → MUST survive (proven via injection)
    //   B: injection_count=0 → must be marked pending-purge (existing behavior)
    //   C: injection_count=1 → MUST survive (any injection counts)
    const insertObs = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, access_count, injection_count, last_injected_at,
        created_at, created_at_epoch)
      VALUES ('inj-prot-mem', 'audit--t4', '', 'change', ?, '', '', '', '', '[]', '[]', 1, 0, ?, ?, ?, ?)
    `);
    const oldEpoch = now - 35 * DAY_MS;
    const oldIso = new Date(oldEpoch).toISOString();
    insertObs.run('A: injected x8 (must survive)', 8, oldEpoch, oldIso, oldEpoch);
    insertObs.run('B: never injected (must be marked)', 0, null, oldIso, oldEpoch);
    insertObs.run('C: injected x1 (must survive)', 1, oldEpoch, oldIso, oldEpoch);
    db.close();

    runHookCmd('session-start', {
      home: tmpHome,
      cwd: projDir,
      stdin: JSON.stringify({ session_id: 'cc-inj-uuid' }),
    });
    // P2-11: the compress-marking passes moved off the SessionStart transaction onto the
    // 24h auto-maintain cadence, so the marking that used to happen inside the call above
    // is now driven explicitly — the same shape MED-4 already established here.
    runHookCmd(['auto-maintain', 'audit--t4'], { home: tmpHome, cwd: projDir });

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const rows = db2
        .prepare('SELECT title, compressed_into, importance FROM observations ORDER BY title')
        .all();
      const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));

      // A and C: must NOT be compressed/marked — injection_count > 0 protects
      expect(byTitle['A: injected x8 (must survive)'].compressed_into).toBeNull();
      expect(byTitle['C: injected x1 (must survive)'].compressed_into).toBeNull();
      // B: gets compressed (auto-compress at hook.mjs:642 catches it first with
      // COMPRESSED_AUTO=-1 since age>30d + imp=1 + injection=0; if not, the
      // auto-maintain mark-idle would catch it with PENDING_PURGE=-2). Either
      // marker is the "removed from active corpus" signal — assert the row is
      // no longer null, not the specific marker, since order between the two
      // gates is implementation detail.
      expect(byTitle['B: never injected (must be marked)'].compressed_into).not.toBeNull();
    } finally {
      db2.close();
    }
  });

  it('preserves obs with injection_count > 0 from importance decay', () => {
    const { db, dbPath } = initHomeDb(tmpHome);
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('inj-decay-sess', 'inj-decay-mem', 'audit--t4', ?, ?, 'active')
    `,
    ).run(new Date().toISOString(), now);

    // Two obs, both 35d old, both imp=2, both access_count=0:
    //   A: injection_count=5 → MUST stay imp=2 (proven via injection)
    //   B: injection_count=0 → must decay to imp=1 (existing behavior)
    const insertObs = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
        files_read, files_modified, importance, access_count, injection_count, last_injected_at,
        created_at, created_at_epoch)
      VALUES ('inj-decay-mem', 'audit--t4', '', 'change', ?, '', '', '', '', '[]', '[]', 2, 0, ?, ?, ?, ?)
    `);
    const oldEpoch = now - 35 * DAY_MS;
    const oldIso = new Date(oldEpoch).toISOString();
    insertObs.run('A-decay: injected x5 (must keep imp=2)', 5, oldEpoch, oldIso, oldEpoch);
    insertObs.run('B-decay: never injected (must decay to 1)', 0, null, oldIso, oldEpoch);
    db.close();

    runHookCmd('session-start', {
      home: tmpHome,
      cwd: projDir,
      stdin: JSON.stringify({ session_id: 'cc-decay-uuid' }),
    });
    runHookCmd('auto-maintain', { home: tmpHome, cwd: projDir }); // MED-4: decay/mark-idle runs in the worker

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const rows = db2.prepare('SELECT title, importance FROM observations ORDER BY title').all();
      const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));

      expect(byTitle['A-decay: injected x5 (must keep imp=2)'].importance).toBe(2);
      expect(byTitle['B-decay: never injected (must decay to 1)'].importance).toBe(1);
    } finally {
      db2.close();
    }
  });
});
