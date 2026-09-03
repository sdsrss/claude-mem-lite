// Contract tests for the cross-hook injected-ids marker — lib/injected-ids.mjs.
//
// Written when the freshness + same-session gate was consolidated out of its five
// hand-typed copies (audit 2026-09-02 P1-2). Mutation-checking that consolidation turned up
// something worse than the duplication: deleting the M-6 SAME-SESSION GATE outright left
// all 5,569 tests in the suite green. That gate is the entire fix for "two concurrent CC
// windows in one project share one suppression state" — session A's injections silently
// deduping session B's, and B inheriting A's count cap — and nothing anywhere pinned it.
// So these are not tests of a refactor; they are the first tests this contract has had.
//
// Deliberately NOT in tests/pathA-exclude-inert.test.mjs, whose own header instructs a
// future reader to DELETE that file in the commit that repairs D#213. The union/replace
// typing rule and the session gate outlive that repair, so they need a home that survives it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readInjectedMarker, mergeInjectedMarker, injectedIdsFileName } from '../lib/injected-ids.mjs';

let dir, file;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inj-marker-')); file = join(dir, 'marker.json'); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

const onDisk = () => JSON.parse(readFileSync(file, 'utf8'));
const seed = (payload) => writeFileSync(file, JSON.stringify(payload));
const W = 60000;

describe('readInjectedMarker — the M-6 same-session gate', () => {
  it('rejects a payload written by a DIFFERENT session', () => {
    seed({ ids: [1, 2], ts: Date.now(), count: 3, session: 'other-window' });
    // Premise first: the same payload IS accepted by its own session, so a `fresh:false`
    // below cannot be the staleness gate or a parse failure wearing this gate's name.
    expect(readInjectedMarker(file, { sessionId: 'other-window', maxAgeMs: W }).fresh).toBe(true);
    expect(readInjectedMarker(file, { sessionId: 'mine', maxAgeMs: W })).toEqual({ ids: [], count: 0, fresh: false });
  });

  it('accepts a LEGACY payload that carries no session at all', () => {
    // Pre-M-6 files must keep the old window-only behaviour rather than being dropped —
    // the marker rotates within minutes, but dropping them would disable dedup meanwhile.
    seed({ ids: [7], ts: Date.now(), count: 1 });
    expect(readInjectedMarker(file, { sessionId: 'mine', maxAgeMs: W }).ids).toEqual([7]);
  });

  it('accepts when the READER has no session id (env-less harnesses)', () => {
    seed({ ids: [8], ts: Date.now(), count: 1, session: 'someone' });
    expect(readInjectedMarker(file, { maxAgeMs: W }).ids).toEqual([8]);
  });
});

describe('readInjectedMarker — freshness and malformed input', () => {
  it('rejects a payload older than the window and keeps a fresh one', () => {
    seed({ ids: [1], ts: Date.now() - 5000, count: 2, session: 's' });
    expect(readInjectedMarker(file, { sessionId: 's', maxAgeMs: 1000 }).fresh).toBe(false);
    expect(readInjectedMarker(file, { sessionId: 's', maxAgeMs: 60000 }).fresh).toBe(true);
  });

  it('returns the empty shape for a missing file, invalid JSON, or a non-array ids', () => {
    // A torn concurrent write leaving invalid JSON is the exact failure M-6's atomic write
    // exists to prevent; the reader must fail closed, never throw into a hook.
    expect(readInjectedMarker(join(dir, 'nope.json'), { maxAgeMs: W }).fresh).toBe(false);
    writeFileSync(file, '{"ids":[1],"ts":');
    expect(readInjectedMarker(file, { maxAgeMs: W }).fresh).toBe(false);
    seed({ ids: 'not-an-array', ts: Date.now() });
    expect(readInjectedMarker(file, { maxAgeMs: W }).fresh).toBe(false);
    seed({ ids: [1] }); // no ts
    expect(readInjectedMarker(file, { maxAgeMs: W }).fresh).toBe(false);
  });
});

describe('mergeInjectedMarker — union vs replace', () => {
  it('union merges with a fresh same-session payload and stringifies the result', () => {
    seed({ ids: ['1'], ts: Date.now(), count: 4, session: 's' });
    mergeInjectedMarker(file, [2, 'D3'], { sessionId: 's', maxAgeMs: W, mode: 'union' });
    const got = onDisk();
    expect(got.ids.sort()).toEqual(['1', '2', 'D3']);
    expect(got.count).toBe(5);          // inherited and incremented
    expect(got.session).toBe('s');
  });

  it('replace writes newIds verbatim, preserving the raw-number/string mix', () => {
    seed({ ids: ['9'], ts: Date.now(), count: 4, session: 's' });
    mergeInjectedMarker(file, [10, 'P11'], { sessionId: 's', maxAgeMs: W, mode: 'replace' });
    expect(onDisk().ids).toEqual([10, 'P11']); // NOT ['10','P11'] — see D#213
  });

  it('does not inherit another session\'s ids or count, in either mode', () => {
    seed({ ids: ['99'], ts: Date.now(), count: 7, session: 'other-window' });
    mergeInjectedMarker(file, [1], { sessionId: 'mine', maxAgeMs: W, mode: 'union' });
    const got = onDisk();
    expect(got.ids, "another window's ids leaked into this session").toEqual(['1']);
    expect(got.count, "another window's count cap was inherited").toBe(1);
  });

  it('does not inherit a STALE same-session payload', () => {
    seed({ ids: ['99'], ts: Date.now() - 5000, count: 7, session: 's' });
    mergeInjectedMarker(file, [1], { sessionId: 's', maxAgeMs: 1000, mode: 'union' });
    expect(onDisk()).toMatchObject({ ids: ['1'], count: 1 });
  });

  it('omits `session` entirely when the caller has no session id (legacy shape)', () => {
    mergeInjectedMarker(file, [1], { maxAgeMs: W, mode: 'union' });
    expect(Object.keys(onDisk())).not.toContain('session');
  });
});

describe('injectedIdsFileName — one file per session', () => {
  it('separates two sessions in one project and falls back to a project-keyed name', () => {
    const a = injectedIdsFileName('proj', 'sess-a');
    const b = injectedIdsFileName('proj', 'sess-b');
    expect(a).not.toBe(b);                                  // D#120: not one shared file
    expect(injectedIdsFileName('proj')).toBe('.claude-mem-injected-proj');
    // Sanitized and capped, so a session id with path separators cannot escape the dir.
    expect(injectedIdsFileName('proj', '../../etc/passwd')).not.toContain('/');
  });
});
