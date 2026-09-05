// D#123 — the user-prompt <memory-context> exclude-set must mirror the Key
// Context ids ACTUALLY rendered at SessionStart, not any query over the DB.
//
// History (review C-1, 2026-08-16): the shipped code excluded the 5 newest
// compressed-only rows; the first D#123 cut "aligned" that to the injector's
// QUERY (live pair, LIMIT 10) — and the adversarial review proved the alignment
// target was wrong: on quiet/adopted projects (this repo included) SessionStart
// renders NO Key Context at all, so a query-derived exclude-set is pure
// suppression (empirically 3 → 0 injected on a 314-row corpus; the same-project
// candidate leg is LIMIT 10, so excluding 10 same-project ids can blank it).
// The contract pinned here: exclusion = the keyctx marker handleSessionStart /
// handlePreCompact wrote (ids actually rendered, [] under quiet); no marker or
// other-session marker → exclude NOTHING (fail open: a duplicate line is
// cosmetic, a suppressed lesson is a real loss).
//
// Mutation coverage (review round 2 demanded both directions have teeth):
//   * case 1 fails if ANY query-based exclude-set returns (target is the newest
//     importance-2 row — every LIMIT >= 1 variant would exclude it);
//   * case 2 fails if the marker is ignored (dedup direction);
//   * case 3 fails if the session gate is dropped OR flipped to fail-closed;
//   * case 4 fails if the SessionStart write→user-prompt read loop breaks
//     (also the only case that runs non-quiet, so it pins "rendered ids land
//     in the marker" against the real renderer).
//
// ISOLATION: same contract as tests/audit-fixes-20260816.test.mjs — every
// spawned hook gets HOME + CLAUDE_PROJECT_DIR inside a mkdtemp sandbox; the
// runner's CLAUDE_MEM_* / MEM_* flags are stripped from the child env.

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { keyContextIdsFileName } from '../lib/injected-ids.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO, 'hook.mjs');
const PROMPT = 'zebra quantum flux dedup ledger story';
const CC_SESSION = 'cc-d123';

let BASE_ENV;

beforeAll(() => {
  BASE_ENV = { ...process.env };
  for (const k of Object.keys(BASE_ENV)) {
    if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  }
  Object.assign(BASE_ENV, {
    CLAUDE_CODE_PATH: join(tmpdir(), 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
    MEM_QUIET_HOOKS: '1',
    MEM_NO_AUTO_ADOPT: '1',
  });
  delete BASE_ENV.CLAUDE_PROJECT_DIR;
  delete BASE_ENV.PWD;
});

describe('D#123 — exclude-set mirrors rendered Key Context, never a query', () => {
  let tmpHome, projDir, dbPath, runtimeDir;
  const PROJECT = 'd123--kx';

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-d123-keyobs-'));
    projDir = join(tmpHome, 'd123', 'kx');
    mkdirSync(projDir, { recursive: true });
    const dbDir = join(tmpHome, '.claude-mem-lite');
    runtimeDir = join(dbDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    dbPath = join(dbDir, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, 'd123-mem', ?, ?, ?, 'active')
    `,
    ).run(CC_SESSION, PROJECT, new Date(now).toISOString(), now);
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function seed(db, { title, epoch, importance = 2, lesson = null, files = null }) {
    return Number(
      db
        .prepare(
          `
      INSERT INTO observations (memory_session_id, project, type, title, narrative,
        lesson_learned, files_modified, importance, compressed_into, created_at, created_at_epoch)
      VALUES ('d123-mem', ?, 'bugfix', ?, ?, ?, ?, ?, 0, ?, ?)
    `,
        )
        .run(PROJECT, title, title, lesson, files, importance, new Date(epoch).toISOString(), epoch)
        .lastInsertRowid,
    );
  }

  function fireHook(event, extraEnv = {}) {
    return execFileSync(process.execPath, [HOOK_PATH, event], {
      input: JSON.stringify({ session_id: CC_SESSION, prompt: PROMPT }),
      timeout: 20000,
      encoding: 'utf8',
      env: {
        ...BASE_ENV,
        HOME: tmpHome,
        CLAUDE_PROJECT_DIR: projDir,
        CLAUDE_MEM_HOOK_RUNNING: undefined,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  function markerPath() {
    return join(runtimeDir, keyContextIdsFileName(PROJECT, CC_SESSION));
  }

  // FAILS IF: exclusion regresses to ANY query over the DB (old half-pair,
  // "aligned" live pair, any LIMIT) — the target is the newest importance-2 row,
  // so every query variant would exclude it. No marker exists → nothing was
  // rendered at SessionStart → nothing may be suppressed.
  it('no marker → nothing excluded: the newest key-context-eligible obs still injects', () => {
    const db = new Database(dbPath);
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      seed(db, { title: `unrelated live filler ${i}`, epoch: now - (i + 2) * 60000 });
    }
    const targetId = seed(db, { title: 'Zebra quantum flux dedup ledger target', epoch: now - 60000 });
    const controlId = seed(db, {
      title: 'zebra quantum flux control marker',
      epoch: now - 40 * 60000,
      importance: 1,
    });
    db.close();

    const out = fireHook('user-prompt');
    expect(out, 'control line must appear — proves the injection path fired').toContain(`(#${controlId})`);
    expect(out, 'nothing was rendered at SessionStart — target must NOT be suppressed').toContain(
      `(#${targetId})`,
    );
  });

  // FAILS IF: the marker is ignored — an id genuinely rendered at SessionStart
  // would be re-injected as a <memory-context> duplicate.
  it('marker ids are excluded (dedup against what was really shown)', () => {
    const db = new Database(dbPath);
    const now = Date.now();
    const targetId = seed(db, { title: 'Zebra quantum flux dedup ledger target', epoch: now - 60000 });
    const controlId = seed(db, {
      title: 'zebra quantum flux control marker',
      epoch: now - 40 * 60000,
      importance: 1,
    });
    db.close();
    writeFileSync(markerPath(), JSON.stringify({ ids: [targetId], ts: Date.now(), session: CC_SESSION }));

    const out = fireHook('user-prompt');
    expect(out, 'control line must appear — proves the injection path fired').toContain(`(#${controlId})`);
    expect(out, 'target was rendered at SessionStart — must NOT be re-injected').not.toContain(
      `(#${targetId})`,
    );
  });

  // FAILS IF: the session gate is dropped (another session's marker suppresses
  // this session) or inverted. A concurrent window's Key Context is not in THIS
  // window's context — fail open.
  it("another session's marker does not suppress this session", () => {
    const db = new Database(dbPath);
    const now = Date.now();
    const targetId = seed(db, { title: 'Zebra quantum flux dedup ledger target', epoch: now - 60000 });
    db.close();
    writeFileSync(
      join(runtimeDir, keyContextIdsFileName(PROJECT, 'cc-other')),
      JSON.stringify({ ids: [targetId], ts: Date.now(), session: 'cc-other' }),
    );
    // Same-name marker written by another session (legacy overwrite shape).
    writeFileSync(markerPath(), JSON.stringify({ ids: [targetId], ts: Date.now(), session: 'cc-other' }));

    const out = fireHook('user-prompt');
    expect(out, "other-session ids must not gate this session's injection").toContain(`(#${targetId})`);
  });

  // FAILS IF: the SessionStart write → user-prompt read loop breaks anywhere:
  // renderer stops collecting rendered ids, handleSessionStart stops writing the
  // marker, or handleUserPrompt stops reading it. Runs NON-quiet so Key Context
  // actually renders (the sandbox is not adopted; MEM_QUIET_HOOKS is cleared).
  it('e2e: ids rendered by session-start are excluded at prompt time', () => {
    const db = new Database(dbPath);
    const now = Date.now();
    const targetId = seed(db, {
      title: 'Zebra quantum flux dedup ledger target',
      epoch: now - 60000,
      importance: 3,
      lesson: 'zebra quantum flux: always flush the ledger',
      files: JSON.stringify(['lib/zebra.mjs']),
    });
    const controlId = seed(db, {
      title: 'zebra quantum flux control marker',
      epoch: now - 40 * 60000,
      importance: 1,
    });
    db.close();

    const startOut = fireHook('session-start', { MEM_QUIET_HOOKS: undefined });
    expect(startOut, 'session-start must render the target in Key Context/File Lessons').toContain(
      `(#${targetId})`,
    );
    expect(existsSync(markerPath()), 'session-start must write the keyctx marker').toBe(true);
    const marker = JSON.parse(readFileSync(markerPath(), 'utf8'));
    expect(marker.ids, 'marker must carry the rendered id').toContain(targetId);

    const out = fireHook('user-prompt', { MEM_QUIET_HOOKS: undefined });
    expect(out, 'control line must appear — proves the injection path fired').toContain(`(#${controlId})`);
    expect(out, 'target was rendered at session-start — must NOT be re-injected').not.toContain(
      `(#${targetId})`,
    );
  });
});
