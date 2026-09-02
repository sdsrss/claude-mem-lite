// Per-SURFACE citation funnel (schema v45, citation_surface_log).
//
// citation_log answers "is invocation effectiveness rising or falling" for a
// project as a whole; it cannot answer "WHICH injection face is burning the
// budget". Four query-conditioned faces feed the decay denominator
// (pre-tool-recall / UserPromptSubmit <memory-context> / PostToolUse
// error-recall / user-prompt-search FYI) plus the promotion-only Key Context
// render, and until now they were unioned before anything was recorded.
//
// Two contracts pinned here:
//   1. extractInjectedBySurface is the PRIMITIVE — extractAllInjected is built
//      on it, so the union can never drift from the per-face breakdown.
//   2. citation_surface_log rows are a per-face VIEW, not a partition, and are
//      not comparable to citation_log in EITHER direction: faces overlap (an
//      obs carried by two counts in both), while cite-back signals enter the
//      aggregate denominator belonging to no face.
//   3. The row key is the CC session id, not the memory session id. This table
//      OVERWRITES, and the memory session id is shared by concurrent same-project
//      CC sessions, so the wrong key silently erases a session's counts (D#60).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import {
  extractInjectedBySurface,
  extractAllInjected,
  extractInjectedFromPreToolUse,
  extractInjectedFromUserPromptSubmit,
  extractInjectedFromErrorRecall,
  extractInjectedFromFyi,
  recordCitationSurfaces,
  computeSurfaceFunnel,
  CITATION_SURFACES,
} from '../lib/citation-tracker.mjs';

// One attachment per face, ids chosen disjoint so a cross-fire is visible.
const PTR_ATT = {
  type: 'attachment',
  attachment: {
    type: 'hook_success',
    command: 'node "/home/sds/.claude-mem-lite/scripts/pre-tool-recall.js"',
    stdout: '[mem] Lessons for utils.mjs:\n  #101 [bugfix] boundary match beats suffix LIKE\n',
  },
};
const UPS_ATT = {
  type: 'attachment',
  attachment: {
    type: 'hook_success',
    command: 'node "/home/sds/.claude-mem-lite/hook.mjs" user-prompt',
    stdout: '<memory-context relevance="high">\n- [decision] picked X | Lesson: Y (#202)\n</memory-context>\n',
  },
};
const ERR_ATT = {
  type: 'attachment',
  attachment: {
    type: 'hook_success',
    command: 'bash "/home/sds/.claude-mem-lite/scripts/post-tool-use.sh"',
    stdout: '[claude-mem-lite] Related memories found for this error:\n  #303 [bugfix] EPIPE on forced exit\n',
  },
};
const FYI_ATT = {
  type: 'attachment',
  attachment: {
    type: 'hook_success',
    command: 'node "/home/sds/.claude-mem-lite/scripts/user-prompt-search.js"',
    stdout: '[mem] FYI — Related memories (continue your task):\n#404 🔴 superseded invariant reopened\n',
  },
};

describe('extractInjectedBySurface', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cite-surface-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

  const writeTranscript = (entries) => {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
    return path;
  };

  it('splits a mixed transcript into the four query-conditioned faces', () => {
    const path = writeTranscript([PTR_ATT, UPS_ATT, ERR_ATT, FYI_ATT]);
    const bySurface = extractInjectedBySurface(path);
    expect([...bySurface.pretool]).toEqual([101]);
    expect([...bySurface.ups]).toEqual([202]);
    expect([...bySurface.error_recall]).toEqual([303]);
    expect([...bySurface.fyi]).toEqual([404]);
  });

  it('carries no keyctx key — Key Context leaves no hook attachment', () => {
    const path = writeTranscript([PTR_ATT]);
    expect(extractInjectedBySurface(path).keyctx).toBeUndefined();
  });

  // Drift guard: the union wrapper MUST be derived from the breakdown. Before
  // v45 the two were independent walks; a face added to one and forgotten in
  // the other is exactly how a surface goes silently unmetered (#10379).
  it('union of the faces equals extractAllInjected', () => {
    const path = writeTranscript([PTR_ATT, UPS_ATT, ERR_ATT, FYI_ATT]);
    const bySurface = extractInjectedBySurface(path);
    const union = new Set([
      ...bySurface.pretool, ...bySurface.ups, ...bySurface.error_recall, ...bySurface.fyi,
    ]);
    expect([...extractAllInjected(path)].sort()).toEqual([...union].sort());
  });

  // The per-face exports predate this module and have their own callers/tests.
  // They must stay byte-identical in behavior to the single-walk breakdown, or
  // the shared matcher table has been bypassed on one path.
  it('agrees with each standalone per-face extractor', () => {
    const path = writeTranscript([PTR_ATT, UPS_ATT, ERR_ATT, FYI_ATT]);
    const s = extractInjectedBySurface(path);
    expect([...s.pretool]).toEqual([...extractInjectedFromPreToolUse(path)]);
    expect([...s.ups]).toEqual([...extractInjectedFromUserPromptSubmit(path)]);
    expect([...s.error_recall]).toEqual([...extractInjectedFromErrorRecall(path)]);
    expect([...s.fyi]).toEqual([...extractInjectedFromFyi(path)]);
  });

  it('honors mainOnly per face (sidechain attachment excluded)', () => {
    const path = writeTranscript([
      PTR_ATT,
      { ...UPS_ATT, isSidechain: true },
    ]);
    const all = extractInjectedBySurface(path);
    expect([...all.ups]).toEqual([202]);
    const main = extractInjectedBySurface(path, { mainOnly: true });
    expect([...main.pretool]).toEqual([101]);
    expect(main.ups.size).toBe(0);
  });

  // Pre-tag review L-3: this gate was never pinned, before or after the
  // refactor. The UPS command matches `hook.mjs user-prompt`, which is the SAME
  // hook entry that emits non-memory output; without the block gate, a `- [x]`
  // markdown checklist or any `- [`-prefixed line carrying a `(#NN)` in other
  // user-prompt hook output would be counted as an injection and demote a real
  // observation that was never shown.
  it('ignores a user-prompt attachment that carries no <memory-context> block', () => {
    const path = writeTranscript([{
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        command: 'node "/home/sds/.claude-mem-lite/hook.mjs" user-prompt',
        stdout: '[mem] some other user-prompt output\n- [decision] not a memory line (#777)\n',
      },
    }]);
    expect(extractInjectedBySurface(path).ups.size).toBe(0);
    expect(extractAllInjected(path).has(777)).toBe(false);
  });

  it('returns empty sets (never undefined) for a missing transcript', () => {
    const s = extractInjectedBySurface(join(tmp, 'nope.jsonl'));
    for (const face of ['pretool', 'ups', 'error_recall', 'fyi']) {
      expect(s[face]).toBeInstanceOf(Set);
      expect(s[face].size).toBe(0);
    }
    expect(() => extractInjectedBySurface(null)).not.toThrow();
  });

  // The read-count guard for this lives in citation-surface-single-walk.test.mjs:
  // it needs `vi.mock('fs')` at module scope (ESM namespaces are not
  // configurable, so vi.spyOn(fs, 'readFileSync') throws), and this file needs
  // the real fs to write its fixtures.
});

describe('recordCitationSurfaces', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p1' });
    insertSession(db, { id: 'sess-2', project: 'p2' });
  });
  afterEach(() => { try { db.close(); } catch {} });

  const obs = (project = 'p1') => Number(insertObs(db, {
    sessionId: project === 'p1' ? 'sess-1' : 'sess-2',
    project, type: 'bugfix', title: 't', importance: 2,
  }).lastInsertRowid);
  const row = (surface, project = 'p1', session = 'sess-1') =>
    db.prepare('SELECT * FROM citation_surface_log WHERE project=? AND session_id=? AND surface=?')
      .get(project, session, surface);

  it('writes one row per surface with injected/cited counts', () => {
    const a = obs(), b = obs(), c = obs();
    recordCitationSurfaces(db, 'p1', 'sess-1', {
      pretool: new Set([a, b]),
      ups: new Set([c]),
    }, new Set([b]));
    expect(row('pretool').injected_n).toBe(2);
    expect(row('pretool').cited_n).toBe(1);
    expect(row('ups').injected_n).toBe(1);
    expect(row('ups').cited_n).toBe(0);
    expect(row('pretool').resolved_at).toBeGreaterThan(0);
  });

  it('counts an obs injected by two faces in BOTH rows (view, not partition)', () => {
    const a = obs();
    recordCitationSurfaces(db, 'p1', 'sess-1', {
      pretool: new Set([a]),
      fyi: new Set([a]),
    }, new Set([a]));
    expect(row('pretool').injected_n).toBe(1);
    expect(row('fyi').injected_n).toBe(1);
    expect(row('pretool').cited_n).toBe(1);
    expect(row('fyi').cited_n).toBe(1);
  });

  it('skips ids that are not observations of this project', () => {
    const mine = obs();
    const theirs = obs('p2');
    recordCitationSurfaces(db, 'p1', 'sess-1', {
      pretool: new Set([mine, theirs, 999999]), // cross-project + ghost (events id)
    }, new Set());
    expect(row('pretool').injected_n).toBe(1);
  });

  it('is overwrite-idempotent — a Stop re-fire does not double the counts', () => {
    const a = obs(), b = obs();
    const sets = { pretool: new Set([a, b]) };
    recordCitationSurfaces(db, 'p1', 'sess-1', sets, new Set([a]));
    recordCitationSurfaces(db, 'p1', 'sess-1', sets, new Set([a]));
    expect(row('pretool').injected_n).toBe(2);
    expect(row('pretool').cited_n).toBe(1);
  });

  it('absorbs a cross-turn late citation (cited rises, injected unchanged)', () => {
    const a = obs(), b = obs();
    const sets = { pretool: new Set([a, b]) };
    recordCitationSurfaces(db, 'p1', 'sess-1', sets, new Set());
    expect(row('pretool').cited_n).toBe(0);
    recordCitationSurfaces(db, 'p1', 'sess-1', sets, new Set([a, b]));
    expect(row('pretool').injected_n).toBe(2);
    expect(row('pretool').cited_n).toBe(2);
  });

  it('writes no row for an empty surface (no telemetry noise)', () => {
    const a = obs();
    recordCitationSurfaces(db, 'p1', 'sess-1', {
      pretool: new Set([a]),
      ups: new Set(),
    }, new Set());
    expect(row('ups')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) n FROM citation_surface_log').get().n).toBe(1);
  });

  it('credits the keeper when an injected id was superseded mid-session (D#61 parity)', () => {
    const keeper = obs();
    const old = obs();
    db.prepare('UPDATE observations SET superseded_at=?, superseded_by=? WHERE id=?')
      .run(Date.now(), keeper, old);
    recordCitationSurfaces(db, 'p1', 'sess-1', { pretool: new Set([old]) }, new Set([old]));
    // Redirected to the keeper: still exactly one injected, and it counts as cited.
    expect(row('pretool').injected_n).toBe(1);
    expect(row('pretool').cited_n).toBe(1);
  });

  it('keeps separate rows per session and per project', () => {
    const a = obs();
    const b = obs('p2');
    recordCitationSurfaces(db, 'p1', 'sess-1', { pretool: new Set([a]) }, new Set());
    recordCitationSurfaces(db, 'p1', 'sess-9', { pretool: new Set([a]) }, new Set([a]));
    recordCitationSurfaces(db, 'p2', 'sess-1', { pretool: new Set([b]) }, new Set());
    expect(row('pretool', 'p1', 'sess-1').cited_n).toBe(0);
    expect(row('pretool', 'p1', 'sess-9').cited_n).toBe(1);
    expect(row('pretool', 'p2', 'sess-1').injected_n).toBe(1);
  });

  // Pre-tag review M-1. Overwrite semantics make the KEY load-bearing: two
  // concurrent CC sessions in one project share a memory session id (one file
  // per project, 12h), so keying on it would let the second Stop erase the
  // first session's counts outright rather than accumulate them. Distinct keys
  // must produce distinct rows — this is the same hazard D#60 fixed for
  // applyCitationDecay, one table over.
  it('does not let a second session erase a first session\'s counts', () => {
    const a = obs(), b = obs(), c = obs(), d = obs(), e = obs();
    // Session A resolves 5 injections, 3 cited.
    recordCitationSurfaces(db, 'p1', 'cc-A', { pretool: new Set([a, b, c, d, e]) }, new Set([a, b, c]));
    // Session B, same project, walks its own (smaller) transcript.
    recordCitationSurfaces(db, 'p1', 'cc-B', { pretool: new Set([a, b]) }, new Set([a]));
    expect(row('pretool', 'p1', 'cc-A').injected_n).toBe(5);
    expect(row('pretool', 'p1', 'cc-A').cited_n).toBe(3);
    expect(row('pretool', 'p1', 'cc-B').injected_n).toBe(2);
    expect(row('pretool', 'p1', 'cc-B').cited_n).toBe(1);
  });

  // The partial-erase variant: a face that is EMPTY in the second session hits
  // the "no telemetry noise" skip, so a shared key would leave a mixed row set
  // (one face from session A, another from session B) — worse than either.
  it('keeps per-face rows of two sessions independent even when a face is empty in one', () => {
    const a = obs(), b = obs();
    recordCitationSurfaces(db, 'p1', 'cc-A', { pretool: new Set([a]), ups: new Set([b]) }, new Set([a]));
    recordCitationSurfaces(db, 'p1', 'cc-B', { pretool: new Set([b]), ups: new Set() }, new Set());
    expect(row('ups', 'p1', 'cc-A').injected_n).toBe(1);
    expect(row('ups', 'p1', 'cc-B')).toBeUndefined();
    expect(row('pretool', 'p1', 'cc-A').cited_n).toBe(1);
    expect(row('pretool', 'p1', 'cc-B').cited_n).toBe(0);
  });

  // keyctx is the one face whose semantics differ (promotion-only) and the one
  // the Stop handler passes in on top of the breakdown — but the unit tests
  // reached it only through the enum, never as a written label (pre-tag review
  // b3). Recording it must be ordinary: a row like any other, and — critically
  // — writing it here must not be what widens anything, since the decay
  // denominator is computed before this call and from a different object.
  it('writes keyctx as an ordinary row (promotion-only lives in the decay loop, not here)', () => {
    const a = obs(), b = obs();
    const written = recordCitationSurfaces(db, 'p1', 'cc-A',
      { pretool: new Set([a]), keyctx: new Set([a, b]) }, new Set([a]));
    expect(row('keyctx', 'p1', 'cc-A').injected_n).toBe(2);
    expect(row('keyctx', 'p1', 'cc-A').cited_n).toBe(1);
    expect(written.keyctx).toEqual({ injected: 2, cited: 1 });
    // Reported alongside, never merged into, the query-conditioned faces.
    expect(row('pretool', 'p1', 'cc-A').injected_n).toBe(1);
  });

  it('rejects an unknown surface label instead of writing an unqueryable row', () => {
    const a = obs();
    recordCitationSurfaces(db, 'p1', 'sess-1', { bogus_face: new Set([a]) }, new Set());
    expect(db.prepare('SELECT COUNT(*) n FROM citation_surface_log').get().n).toBe(0);
  });

  it('is best-effort — bad args never throw (telemetry must not break Stop)', () => {
    expect(() => recordCitationSurfaces(null, 'p', 's', { pretool: new Set([1]) }, new Set())).not.toThrow();
    expect(() => recordCitationSurfaces(db, '', 's', { pretool: new Set([1]) }, new Set())).not.toThrow();
    expect(() => recordCitationSurfaces(db, 'p', '', { pretool: new Set([1]) }, new Set())).not.toThrow();
    expect(() => recordCitationSurfaces(db, 'p', 's', null, null)).not.toThrow();
  });

  it('exposes the surface enum so callers cannot invent labels', () => {
    // Order matters here only as a change-detector: recordCitationSurfaces drops labels
    // absent from this list, so an addition should be a deliberate edit in both places.
    // task_imperative joined in v3.76 (metered only at first; it entered the decay
    // denominator on 2026-08-25 once its rate was read — see
    // citation-surface-imperative.test.mjs). subagent joined in v3.77
    // (D#152; see citation-surface-subagent.test.mjs — it is a non-attachment
    // face, so it is fed by its own recordCitationSurfaces call at Stop).
    expect(CITATION_SURFACES).toEqual(['pretool', 'ups', 'error_recall', 'fyi', 'task_imperative', 'keyctx', 'subagent']);
  });
});

describe('computeSurfaceFunnel', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { try { db.close(); } catch {} });

  const seed = (project, session, surface, inj, cited, agoMs = 0) => {
    db.prepare(`INSERT INTO citation_surface_log (project, session_id, surface, resolved_at, injected_n, cited_n)
                VALUES (?, ?, ?, ?, ?, ?)`).run(project, session, surface, Date.now() - agoMs, inj, cited);
  };

  it('aggregates per surface inside the window, sorted by injected volume', () => {
    seed('p1', 's1', 'pretool', 10, 1);
    seed('p1', 's2', 'pretool', 10, 3);
    seed('p1', 's1', 'ups', 4, 2);
    const r = computeSurfaceFunnel(db, { days: 7 });
    expect(r.surfaces[0]).toMatchObject({ surface: 'pretool', injected: 20, cited: 4 });
    expect(r.surfaces[0].rate).toBeCloseTo(0.2, 5);
    expect(r.surfaces[1]).toMatchObject({ surface: 'ups', injected: 4, cited: 2 });
    expect(r.surfaces[1].rate).toBeCloseTo(0.5, 5);
  });

  it('excludes rows outside the window', () => {
    seed('p1', 's1', 'pretool', 10, 5, 30 * 24 * 3600 * 1000);
    seed('p1', 's2', 'ups', 2, 1);
    const r = computeSurfaceFunnel(db, { days: 7 });
    expect(r.surfaces.map((s) => s.surface)).toEqual(['ups']);
  });

  it('filters by project', () => {
    seed('p1', 's1', 'pretool', 10, 5);
    seed('p2', 's1', 'pretool', 3, 0);
    const r = computeSurfaceFunnel(db, { days: 7, project: 'p2' });
    expect(r.surfaces).toEqual([expect.objectContaining({ surface: 'pretool', injected: 3, cited: 0 })]);
  });

  it('returns an empty shape on an empty table and never throws on a null db', () => {
    expect(computeSurfaceFunnel(db, { days: 7 }).surfaces).toEqual([]);
    expect(() => computeSurfaceFunnel(null, { days: 7 })).not.toThrow();
    expect(computeSurfaceFunnel(null, { days: 7 }).surfaces).toEqual([]);
  });

  // b4: "the query could not run" and "the query returned nothing" used to be the
  // same value — surfaces: []. That is the #10650 shape: the table was never
  // created, the reader swallowed `no such table`, and the CLI printed it as
  // "no data yet" for as long as the surface stayed unmetered. The caller must be
  // able to tell the two apart WITHOUT reading the debug log.
  it('an empty table reports no failure — absence of data is not an error', () => {
    expect(computeSurfaceFunnel(db, { days: 7 }).unavailable).toBeUndefined();
  });

  it('a missing table reports `unavailable`, not a benign empty result', () => {
    db.prepare('DROP TABLE citation_surface_log').run();
    const r = computeSurfaceFunnel(db, { days: 7 });
    expect(r.surfaces).toEqual([]);
    expect(r.unavailable, 'a query that could not run must say so').toBeTruthy();
    expect(String(r.unavailable)).toMatch(/citation_surface_log/);
  });

  it('a null db reports `unavailable` — no handle is not an empty window', () => {
    expect(computeSurfaceFunnel(null, { days: 7 }).unavailable).toBeTruthy();
  });
});

describe('hook.mjs Stop wiring', () => {
  // D#207: join(), not new URL('../X.mjs', …) — that form blinds knip to hook.mjs.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs'), 'utf8');

  it('feeds the decay denominator from the per-surface breakdown', () => {
    expect(src).toMatch(/extractInjectedBySurface\(transcriptPath,\s*\{[^}]*mainOnly:\s*true/);
  });

  it('records the surface funnel next to the aggregate funnel', () => {
    expect(src).toMatch(/recordCitationSurfaces\(/);
    // Both anchors must EXIST before slicing: `indexOf` returns -1 on a rename,
    // and `slice(-1, -1)` / `slice(i, -1)` silently degrades to "most of the
    // file", which matches anything and disarms the assertion.
    const start = src.indexOf('const citedMain');
    const end = src.indexOf('handleStop-edge-attribution');
    expect(start, 'gate-block start anchor missing').toBeGreaterThan(0);
    expect(end, 'gate-block end anchor missing').toBeGreaterThan(start);
    expect(src.slice(start, end), 'recordCitationSurfaces must live inside the text-floor-gated block')
      .toMatch(/recordCitationSurfaces\(/);
  });

  // Pre-tag review M-1, pinned at the call site: the aggregate funnel keys on
  // the memory sessionId (safe — it accumulates) and this one MUST NOT, because
  // it overwrites. Reverting the argument to `sessionId` is a one-token edit
  // that silently drops a concurrent session's counts, so the argument is
  // asserted rather than left to the reader.
  it('keys the surface funnel on the CC session id, not the memory session id', () => {
    const call = src.match(/recordCitationSurfaces\(db, project,\s*([^,]+),/);
    expect(call, 'recordCitationSurfaces call site not found').not.toBeNull();
    expect(call[1].trim()).toBe('ccSessionId || sessionId');
  });

  // v3.66.1 invariant, re-pinned at a new call site: Key Context is
  // promotion-only. It may be REPORTED as a surface, but its ids must never
  // widen the decay denominator — the block re-renders the same fixed top-10
  // every session, so an uncited render is evidence of nothing.
  it('does not union keyctx ids into the decay denominator', () => {
    const call = src.match(/const keyCtxIds = extractInjectedFromKeyContext\(\{[\s\S]{0,200}?\}\);/);
    expect(call, 'keyCtx call site not found').not.toBeNull();
    const start = src.indexOf(call[0]) + call[0].length;
    const end = src.indexOf('applyCitationDecay(db');
    expect(end, 'applyCitationDecay anchor missing').toBeGreaterThan(start);

    // Spelling-independent. Matching ONE literal form (`for (const id of
    // keyCtxIds) injected.add(id)`) only catches a REPLACEMENT of the gated
    // line; the v3.66.0 defect could just as well come back ADDITIVELY, as a
    // `keyCtxIds.forEach(...)` or a spread sitting next to the correct line.
    // So: between the marker read and the decay call, every line that mentions
    // keyCtxIds at all must be gated on an actual citation.
    const offending = src.slice(start, end).split('\n')
      .filter((line) => line.includes('keyCtxIds'))
      .filter((line) => !line.trimStart().startsWith('//'))
      // Only lines that actually FEED `injected` count — reading keyCtxIds.size
      // to short-circuit the whole block is legitimate and must not trip this.
      .filter((line) => /injected\s*\.\s*add|\.\.\.\s*keyCtxIds/.test(line))
      .filter((line) => !line.includes('citedMain.has('));
    expect(offending, 'keyCtxIds may only enter `injected` gated on a citation').toEqual([]);
  });
});
