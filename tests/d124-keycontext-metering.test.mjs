// D#124 — Key Context rows were shown but never reachable by citation decay.
//
// SessionStart (and PreCompact) render up to 10 obs into the
// <claude-mem-context> File Lessons / Key Context sections. No extractor
// matched them, so a row the agent DID cite off that block could never be
// promoted for it. v3.65.0 already persists the ACTUALLY-rendered ids to a
// per-session marker (the D#123 review C-1 fix); this reads that same list.
//
// TWO corrections landed in v3.66.1 after an independent pre-tag review arrived
// late (findings HIGH-2 / HIGH-3), and both are pinned below:
//
//   • NO injection_count bump. v3.66.0 added one "mirroring the UPS bump".
//     The mechanics matched; the semantics did not. injection_count is a NOISE
//     signal — noisePenaltyClause scores a row x0.5 at >=4 and x0.2 at >=8 when
//     access_count trails it, and nothing bumps access_count for a rendered row.
//     The UPS bump is query-conditioned ("injected on a match and never used");
//     an unconditional Key Context render measures only elapsed sessions, so the
//     bump deprioritised the highest-importance rows over time.
//
//   • PROMOTION-ONLY. The ids are NOT part of extractAllInjected's denominator.
//     keyObs gates on `importance >= 2`, so one demotion takes the common
//     importance-2 row to 1 and evicts it from Key Context permanently — each
//     departure promoting the next row into the same grinder. A cited row still
//     gets credited; an ignored one is left alone.
//
// Both render surfaces go through ONE recorder so the SessionStart / PreCompact
// pair cannot drift — the twin-drift class this repo has re-opened repeatedly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createTestDb } from './test-helpers.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { keyContextIdsFileName } from '../lib/injected-ids.mjs';
import { recordKeyContextInjection } from '../lib/keyctx-marker.mjs';
import { extractInjectedFromKeyContext, extractAllInjected } from '../lib/citation-tracker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'keyctx--test';
const SESSION = 'cc-session-aaa';

let runtimeDir;
let db;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'keyctx-'));
  db = createTestDb();
});
afterEach(() => {
  db.close();
  rmSync(runtimeDir, { recursive: true, force: true });
});

// Titles must be mutually dissimilar: saveObservation's tier-1 dedup drops a
// title within Jaccard 0.85 of one saved in the last 5 minutes, which would
// silently hand this test fewer rows than it asked for.
const SEED_TITLES = [
  'FTS trigger stopped firing after the schema rebuild',
  'Proxy CONNECT tunnel drops keep-alive on redirect',
  'Vector vocabulary omitted lesson text entirely',
];

function seed(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = saveObservation(db, {
      project: PROJECT,
      type: 'bugfix',
      content: `${SEED_TITLES[i]} — full body describing the root cause and the fix applied`,
      title: SEED_TITLES[i],
    });
    expect(r.kind, `seed ${i} was deduped`).toBe('saved');
    ids.push(r.id);
  }
  expect(new Set(ids).size).toBe(n);
  return ids;
}

function markerPath(session = SESSION) {
  return join(runtimeDir, keyContextIdsFileName(PROJECT, session));
}

describe('recordKeyContextInjection — marker only, never a counter', () => {
  it('does NOT touch injection_count (v3.66.1 revert)', () => {
    const [a, b] = seed(2);
    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [a, b] });
    const rows = db.prepare('SELECT id, injection_count, last_injected_at FROM observations').all();
    // FAILS-IF the bump is reintroduced. injection_count feeds noisePenaltyClause
    // (scoring-sql.mjs: x0.5 at >=4, x0.2 at >=8 when access_count stays 0), and
    // nothing bumps access_count for a rendered row — so counting renders here
    // deprioritises the highest-importance rows purely as a function of elapsed
    // sessions. scoring-sql.mjs states the invariant: injection_count is bumped
    // ONLY on UserPromptSubmit / hook-memory auto-inject.
    for (const r of rows) {
      expect(r.injection_count ?? 0, `id ${r.id} injection_count`).toBe(0);
      expect(r.last_injected_at ?? null, `id ${r.id} last_injected_at`).toBeNull();
    }
  });

  it('writes the marker with exactly the rendered ids', () => {
    const [a, b, c] = seed(3);
    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [a, c] });
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).ids.sort()).toEqual([a, c].sort());
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).ids).not.toContain(b);
  });

  it('writes the marker even when nothing rendered (quiet/adopted project)', () => {
    recordKeyContextInjection(db, { runtimeDir, project: PROJECT, sessionId: SESSION, ids: [] });
    expect(existsSync(markerPath())).toBe(true);
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).ids).toEqual([]);
  });

  it('never throws when the runtime dir is unwritable — rendering must not break', () => {
    const [a] = seed(1);
    expect(() =>
      recordKeyContextInjection(db, {
        runtimeDir: '/nonexistent-dir-for-keyctx-test',
        project: PROJECT,
        sessionId: SESSION,
        ids: [a],
      }),
    ).not.toThrow();
  });

  it('drops non-id junk before it reaches the marker', () => {
    // The recorder's own sanitiser, not the extractor's — pinned separately
    // because a caller could hand it anything the collector picked up.
    recordKeyContextInjection(db, {
      runtimeDir,
      project: PROJECT,
      sessionId: SESSION,
      ids: [7, 'abc', -1, 0, 1e9, null, 3.5],
    });
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).ids).toEqual([7]);
  });
});

describe('extractInjectedFromKeyContext — the 5th extractor face', () => {
  it('returns the ids the marker says were rendered', () => {
    writeFileSync(markerPath(), JSON.stringify({ ids: [11, 22], ts: Date.now(), session: SESSION }));
    expect(
      [...extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION })].sort(),
    ).toEqual([11, 22]);
  });

  it('ignores a marker written by a DIFFERENT session', () => {
    writeFileSync(
      markerPath(),
      JSON.stringify({ ids: [11, 22], ts: Date.now(), session: 'cc-session-other' }),
    );
    expect(extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION }).size).toBe(0);
  });

  it('is empty (not throwing) when no marker exists or the file is corrupt', () => {
    expect(extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION }).size).toBe(0);
    writeFileSync(markerPath(), 'not json{');
    expect(extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION }).size).toBe(0);
  });

  it('rejects non-id junk in the marker', () => {
    writeFileSync(markerPath(), JSON.stringify({ ids: [7, 'abc', -1, 0, 1e9, null], session: SESSION }));
    expect([...extractInjectedFromKeyContext({ runtimeDir, project: PROJECT, sessionId: SESSION })]).toEqual([
      7,
    ]);
  });
});

describe('extractAllInjected must NOT carry the Key Context face', () => {
  it('ignores marker coordinates entirely (promotion-only lives at the call site)', () => {
    writeFileSync(markerPath(), JSON.stringify({ ids: [4242], ts: 1, session: SESSION }));
    // FAILS-IF the face is unioned back into the denominator. Every other face is
    // query-conditioned, so an uncited appearance is evidence; an unconditional
    // Key Context render is not, and keyObs gates on importance >= 2 so one
    // demotion evicts the row permanently.
    const all = extractAllInjected(null, {
      mainOnly: true,
      runtimeDir,
      project: PROJECT,
      sessionId: SESSION,
    });
    expect(all.has(4242)).toBe(false);
  });
});

describe('the Stop handler wires Key Context as promotion-only', () => {
  const src = readFileSync(join(ROOT, 'hook.mjs'), 'utf8');

  // The query-conditioned extraction — whichever of the two entry points the
  // Stop handler uses (v45 swapped extractAllInjected for its per-face
  // primitive extractInjectedBySurface, which it then unions) — must never be
  // handed the marker coordinates. Receiving them is how Key Context would slide
  // back into the decay denominator.
  it('does not pass marker coordinates into the query-conditioned extraction', () => {
    // EVERY call site, not the first one. `src.match()` returns only the first
    // occurrence, and v45 widened this pattern to a two-name alternation — so a
    // clean call of either name appearing earlier in the file would shadow a
    // dirty one below it. At HEAD that was unreachable (one name, one site);
    // "keep extractAllInjected for a non-mainOnly path" makes it reachable.
    const calls = [
      ...src.matchAll(/(?:extractAllInjected|extractInjectedBySurface)\(transcriptPath,\s*\{[^}]*\}/gs),
    ];
    expect(calls.length, 'query-conditioned extraction call site not found').toBeGreaterThan(0);
    for (const [call] of calls) {
      expect(call, 'marker coordinates must not reach the query-conditioned extraction').not.toContain(
        'runtimeDir',
      );
      expect(call).not.toContain('keyCtx');
    }
  });

  it('resolves the marker with runtimeDir + project + sessionId', () => {
    const call = src.match(/extractInjectedFromKeyContext\(\{[^}]*\}/s);
    expect(call, 'extractInjectedFromKeyContext call site not found').not.toBeNull();
    for (const arg of ['runtimeDir', 'project', 'sessionId']) {
      // sessionId was unpinned in v3.66.0: dropping it makes the reader look for
      // `.claude-mem-keyctx-<project>` while the writer wrote `...-<session>`,
      // so the face silently returns empty forever.
      expect(call[0], `missing ${arg}`).toContain(arg);
    }
  });

  it('adds Key Context ids only where they were cited', () => {
    // The whole of the promotion-only contract in one line of production code.
    expect(src).toMatch(/for \(const id of keyCtxIds\) if \(citedMain\.has\(id\)\) injected\.add\(id\);/);
  });
});

describe('both render surfaces go through the one recorder', () => {
  // FAILS-IF a future edit re-inlines writeFileSync at either surface: the twin
  // that skips the recorder silently loses the injection_count bump again.
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');

  for (const file of ['hook.mjs', 'hook-precompact.mjs']) {
    it(`${file} calls recordKeyContextInjection`, () => {
      // Must match the CALL, not the import line — an earlier version of this
      // pin passed while the surface had stopped calling the recorder entirely,
      // because `import { recordKeyContextInjection }` still satisfied it.
      expect(read(file)).toMatch(/\brecordKeyContextInjection\(\s*db\b/);
    });

    it(`${file} no longer hand-writes the keyctx marker`, () => {
      const src = read(file);
      // The marker filename helper may only be referenced by the recorder now
      // (hook.mjs still reads the marker back on the prompt path, so allow reads
      // — what must be gone is a writeFileSync whose path is the keyctx name).
      expect(src).not.toMatch(/writeFileSync\(\s*\n?\s*join\([^)]*keyContextIdsFileName/);
    });
  }
});
