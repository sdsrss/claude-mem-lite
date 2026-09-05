// The Key Context marker is SESSION-scoped, but it is garbage-collected by AGE.
//
// hook.mjs sweeps `.claude-mem-keyctx-*` at 24h mtime, on the same policy as the
// pre-recall cooldown and injected-ids markers. That policy fits those two — their
// semantics ARE time-windowed (the dedup window is 5 minutes). It does not fit this one:
// injected-ids.mjs documents the marker as "session-lifetime validity (no time window)",
// because the SessionStart block stays in context for as long as the session lives. A
// session that outlives 24h therefore has its own exclude-set swept out from under it, and
// handleUserPrompt starts re-injecting rows the Key Context block is still showing.
//
// Keying the sweep on session liveness does not work: hook.mjs marks any session older
// than STALE_SESSION_MS 'abandoned' by started_at_epoch, so the >24h session — the exact
// case — reads as dead in the DB too. What genuinely separates a live session from a dead
// one is whether it is still USING the marker. So the reader refreshes the mtime, and the
// age sweep then measures time since last use.
//
// Second half: handlePreCompact skipped the recorder entirely when the re-rendered body was
// empty, while handleSessionStart writes the marker even when empty — keyctx-marker.mjs's
// header states why ("written even when empty, so a resumed session can never act on a
// previous session's stale semantics") and that the two callers must describe the same set.
// The empty-body early return left the previous render's ids standing as an exclude-set for
// content that is about to be compacted away: suppression of rows that are no longer shown,
// which is the failure D#123 review C-1 already fixed once on the other leg.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, utimesSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initSchema } from '../schema.mjs';
import { keyContextIdsFileName } from '../lib/injected-ids.mjs';
import {
  recordKeyContextInjection,
  touchKeyContextMarker,
  KEYCTX_TOUCH_AFTER_MS,
} from '../lib/keyctx-marker.mjs';
import { handlePreCompact } from '../hook-precompact.mjs';

const dirs = [];
function mkdir() {
  const d = mkdtempSync(join(tmpdir(), 'keyctx-life-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
});

const PROJECT = 'test--project';
const SESSION = 'sess-abc';
const DAY_MS = 24 * 60 * 60 * 1000;

let db;
beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
});

/** Age a file's mtime by `ms`, the way a long-running session ages its marker. */
function age(path, ms) {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
}

describe('touchKeyContextMarker — the age sweep must measure last USE', () => {
  it('refreshes the mtime of a marker older than the touch threshold', () => {
    // A session alive for two days: without the refresh the 24h sweep deletes this file
    // mid-session and handleUserPrompt loses its exclude-set.
    const runtimeDir = mkdir();
    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [1, 2] });
    const path = join(runtimeDir, keyContextIdsFileName(PROJECT, SESSION));
    age(path, 2 * DAY_MS);
    expect(Date.now() - statSync(path).mtimeMs).toBeGreaterThan(DAY_MS);

    expect(touchKeyContextMarker({ runtimeDir, project: PROJECT, sessionId: SESSION })).toBe(true);
    // Fresh enough that a 24h mtime sweep spares it — which is the whole point.
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(DAY_MS);
  });

  it('leaves a recently-written marker alone instead of stamping it every prompt', () => {
    // The reader runs on EVERY user prompt. Touching unconditionally would be a write per
    // prompt for no gain, so the refresh is gated on the stamp already being old.
    const runtimeDir = mkdir();
    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [1] });
    const path = join(runtimeDir, keyContextIdsFileName(PROJECT, SESSION));
    const before = statSync(path).mtimeMs;
    age(path, Math.floor(KEYCTX_TOUCH_AFTER_MS / 2));
    const aged = statSync(path).mtimeMs;
    expect(touchKeyContextMarker({ runtimeDir, project: PROJECT, sessionId: SESSION })).toBe(false);
    expect(statSync(path).mtimeMs).toBe(aged);
    expect(before).toBeGreaterThan(aged);
  });

  it('does not create a marker for a session that never rendered one', () => {
    // Fail open, never fabricate: a missing marker means "nothing was injected, exclude
    // nothing". Writing one here would invent an empty exclude-set for a session whose
    // Key Context block may in fact be on screen.
    const runtimeDir = mkdir();
    expect(touchKeyContextMarker({ runtimeDir, project: PROJECT, sessionId: SESSION })).toBe(false);
    expect(existsSync(join(runtimeDir, keyContextIdsFileName(PROJECT, SESSION)))).toBe(false);
  });

  it('never throws on an unreadable runtime dir', () => {
    // Runs inside the user-prompt hot path; a stat failure must not take the prompt down.
    expect(() =>
      touchKeyContextMarker({ runtimeDir: '/nonexistent/keyctx', project: PROJECT, sessionId: SESSION }),
    ).not.toThrow();
  });
});

describe('handlePreCompact — the twin must describe the same set as SessionStart', () => {
  it('clears the marker when the re-rendered block is empty', () => {
    // Empty DB → buildSessionContextLines returns nothing → PreCompact emits no block, so
    // after compaction NOTHING from Key Context is in context. A stale marker left standing
    // would keep excluding those ids from <memory-context> for the rest of the session.
    const runtimeDir = mkdir();
    const path = join(runtimeDir, keyContextIdsFileName(PROJECT, SESSION));
    writeFileSync(path, JSON.stringify({ ids: [11, 22, 33], ts: Date.now(), session: SESSION }));

    handlePreCompact({ db, project: PROJECT, sessionId: SESSION, runtimeDir });

    expect(existsSync(path), 'marker vanished — the exclude-set must exist and be empty, not absent').toBe(
      true,
    );
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.ids, `stale ids survived an empty re-render: ${JSON.stringify(after.ids)}`).toEqual([]);
    expect(after.session).toBe(SESSION);
  });
});
