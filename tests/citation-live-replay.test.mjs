// benchmark/citation-live-replay.mjs — the per-face ruler.
//
// Two classes of test, because this file's job is to be BELIEVED:
//   1. the two self-checks, driven with synthetic inputs so each is watched to FAIL.
//      A guard exercised only through the real CITATION_SURFACES is a guard nobody has
//      seen fire.
//   2. one subprocess run over a hand-built transcript root, asserting the numbers a
//      known corpus must produce — including the case this face got wrong until
//      v3.81.0: an id handed to subagent A and cited by subagent B is NOT a hit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  aggregate,
  assertFaceCoverage,
  assertRulerCanSayNo,
  byScope,
  mentionVsApplication,
  pollutionSensitivity,
} from '../benchmark/citation-live-replay.mjs';
import { wilson95 } from '../benchmark/wilson.mjs';
import { CITATION_SURFACES } from '../lib/citation-tracker.mjs';
import { TASK_IMPERATIVE_PREFIX } from '../lib/task-imperative.mjs';

// D#207: join(), not `new URL('../…mjs', …)` — the URL form makes knip drop the named
// module from its unused-export report. Enforced by tests/no-url-module-paths.test.mjs.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'citation-live-replay.mjs');

describe('face-coverage guard', () => {
  it('passes with the real face list — the binding this script actually ships with', () => {
    expect(() => assertFaceCoverage()).not.toThrow();
  });

  it('THROWS when a product face is neither scored nor declared unreachable', () => {
    // The failure this guard exists for: a face added to SURFACE_MATCHERS that this
    // replay silently cannot see would print a table missing a row, which reads as
    // "that face scored zero" rather than "that face was never measured".
    expect(() => assertFaceCoverage(
      ['pretool'], { keyctx: 'why' }, ['pretool', 'keyctx', 'brand_new_face'],
    )).toThrow(/brand_new_face/);
  });

  it('THROWS when it claims to score something that is not a product face', () => {
    expect(() => assertFaceCoverage(
      ['pretool', 'typo_face'], {}, ['pretool'],
    )).toThrow(/typo_face/);
  });

  it('THROWS when a face is claimed by BOTH lists — the two must partition, not overlap', () => {
    // `claimed` is a union, so a face in both satisfies the missing-check AND the
    // unknown-check; the run would then print "not replayable here: ups" directly above
    // a scored `ups` row. The case that used to sit here carried this title and asserted
    // only that CITATION_SURFACES was non-empty — it never checked the property it named.
    expect(() => assertFaceCoverage(
      ['pretool', 'ups'], { ups: 'bogus claim of unreachability' }, ['pretool', 'ups'],
    )).toThrow(/BOTH scored and declared unreachable/);
  });

  it('has a non-empty face list to check against', () => {
    // Anti-tautology for every case above: they would all pass on an empty face list.
    expect(CITATION_SURFACES.length).toBeGreaterThanOrEqual(7);
  });
});

describe('ruler-can-say-no guard', () => {
  const rows = (pairs, hits) => [{ face: 'pretool', pairs, hits }];

  it('accepts a mixed corpus', () => {
    expect(() => assertRulerCanSayNo(rows(10, 4))).not.toThrow();
  });

  it('THROWS when every injected pair reads as cited (always-true membership)', () => {
    expect(() => assertRulerCanSayNo(rows(10, 10))).toThrow(/ALWAYS-TRUE/);
  });

  it('THROWS when no injected pair reads as cited (numerator cannot see the denominator)', () => {
    expect(() => assertRulerCanSayNo(rows(10, 0))).toThrow(/cannot \n?see the denominator|cannot see the denominator/);
  });

  it('THROWS when nothing was injected at all', () => {
    expect(() => assertRulerCanSayNo(rows(0, 0))).toThrow(/no injections in scope/);
  });

  it('names the LIKELY CAUSE of an empty scope rather than one fixed cause', () => {
    // The message used to always say "point CLAUDE_MEM_TRANSCRIPT_ROOT at a real
    // transcript root" — irrelevant under --corpus, where the root is never walked, and
    // wrong under a --since that excludes everything. Advice that does not fit the run
    // sends the reader to check the one thing that is not the problem.
    expect(() => assertRulerCanSayNo(rows(0, 0))).toThrow(/CLAUDE_MEM_TRANSCRIPT_ROOT/);
    expect(() => assertRulerCanSayNo(rows(0, 0), { windowed: true })).toThrow(/--since\/--until window/);
    expect(() => assertRulerCanSayNo(rows(0, 0), { frozen: true })).toThrow(/--corpus/);
    // …and the three are actually different, not one string with a decorative branch.
    const msg = (o) => { try { assertRulerCanSayNo(rows(0, 0), o); } catch (e) { return e.message; } return ''; };
    expect(new Set([msg({}), msg({ windowed: true }), msg({ frozen: true })]).size).toBe(3);
  });

  it('THROWS on a single saturated FACE that the global sums wash out', () => {
    // The probe from the v3.82.0 pre-tag review: one face always-true and one face blind,
    // presented together, reduce to 20/10 and the global checks stay silent. Each face
    // has its own extractor in SURFACE_MATCHERS, so per-face is the unit a broken one
    // shows up in.
    const mixed = [
      { face: 'pretool', pairs: 25, hits: 25 },
      { face: 'error_recall', pairs: 25, hits: 0 },
    ];
    const global = mixed.reduce((a, r) => a + r.hits, 0) / mixed.reduce((a, r) => a + r.pairs, 0);
    expect(global).toBeGreaterThan(0);   // the global checks cannot fire on this input…
    expect(global).toBeLessThan(1);
    expect(() => assertRulerCanSayNo(mixed)).toThrow(/pretool/);  // …and the per-face one must.
  });

  it('does NOT throw on a small face that happens to be saturated', () => {
    // Asymmetry, on purpose: 3/3 is an ordinary small sample, 25/25 is a broken predicate.
    expect(() => assertRulerCanSayNo([
      { face: 'pretool', pairs: 40, hits: 12 },
      { face: 'task_imperative', pairs: 3, hits: 3 },
    ])).not.toThrow();
  });

  it('FLAGS rather than throws a face at exactly 0% — a narrow slice can legitimately be 0', () => {
    const flags = assertRulerCanSayNo([
      { face: 'pretool', pairs: 40, hits: 12 },
      { face: 'error_recall', pairs: 30, hits: 0 },
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatch(/error_recall/);
    // And a healthy corpus produces no flags at all — otherwise the array is decorative.
    expect(assertRulerCanSayNo([{ face: 'pretool', pairs: 40, hits: 12 }])).toEqual([]);
  });
});

describe('wilson95', () => {
  // The module had zero coverage when it was extracted: a mutation making it always
  // return [0, 0] survived the whole suite, because its only reachable use here is the
  // unasserted `ci95` field of --json.
  it('matches the published interval for 5/10', () => {
    const [lo, hi] = wilson95(5, 10);
    expect(lo).toBeCloseTo(0.2366, 4);
    expect(hi).toBeCloseTo(0.7634, 4);
  });

  it('clamps to [0,1] at the boundaries instead of going negative', () => {
    expect(wilson95(0, 10)[0]).toBe(0);
    expect(wilson95(0, 10)[1]).toBeCloseTo(0.2775, 4);
    expect(wilson95(10, 10)[1]).toBe(1);
    expect(wilson95(10, 10)[0]).toBeCloseTo(0.7225, 4);
  });

  it('returns [0,0] for an empty sample, and NOT for a non-empty one', () => {
    expect(wilson95(0, 0)).toEqual([0, 0]);
    // The decoy the always-return-[0,0] mutation needs to trip on.
    expect(wilson95(1, 4)).not.toEqual([0, 0]);
  });
});

describe('aggregate', () => {
  it('counts (session, id) PAIRS — one obs per session per face, not per injection', () => {
    const recs = [
      { project: 'p', session: 's1', ts: 1, anyCite: true, faces: { pretool: { inj: [1, 2], hit: [1] } } },
      { project: 'p', session: 's2', ts: 2, anyCite: true, faces: { pretool: { inj: [1], hit: [1] } } },
    ];
    const [row] = aggregate(recs);
    // id 1 appears in both sessions and counts TWICE — the house caliber.
    expect(row).toMatchObject({ face: 'pretool', sessions: 2, pairs: 3, hits: 2 });
  });

  it('attributes pairs from a session that cited nothing to silentPairs', () => {
    const recs = [
      { project: 'p', session: 's1', ts: 1, anyCite: false, faces: { ups: { inj: [7, 8], hit: [] } } },
      { project: 'p', session: 's2', ts: 2, anyCite: true, faces: { ups: { inj: [9], hit: [9] } } },
    ];
    const [row] = aggregate(recs);
    expect(row.pairs).toBe(3);
    expect(row.silentPairs).toBe(2);
  });
});

// D#153's ruler. The failure this case is built to catch is a bucketing that quietly drops
// pairs: a scope breakdown whose buckets do not sum to the face's own pair count is
// comparing rates over populations that are not the face, and the FIRST thing that goes
// missing in practice is the id whose row has since left the table. So the fixture
// deliberately contains one such id, and the assertions pin BOTH the per-bucket rates and
// the sum. A `scopeOf` that returned only known scopes (dropping the unknown) would keep
// every rate below identical and fail only on the sum — which is why the sum is asserted.
describe('byScope (D#153 — is `environment` the low-relevance class on the file face?)', () => {
  const scopeOf = (id) => ({ 1: 'environment', 2: 'environment', 3: 'project' }[id] ?? '(gone)');
  const recs = [
    // env: 1 cited / 2 injected. project: 1/1. gone: 0/1.
    { project: 'p', session: 's1', ts: 1, anyCite: true, faces: { pretool: { inj: [1, 2, 3, 99], hit: [1, 3] } } },
  ];

  it('rates each scope over its OWN pairs, and the buckets sum to the face total', () => {
    const rows = byScope(recs, scopeOf);
    const get = (scope) => rows.find((r) => r.face === 'pretool' && r.scope === scope);
    expect(get('environment')).toMatchObject({ pairs: 2, cited: 1, rate: '50.0%' });
    expect(get('project')).toMatchObject({ pairs: 1, cited: 1, rate: '100.0%' });
    // The row whose observation is gone from the DB is bucketed, never dropped.
    expect(get('(gone)')).toMatchObject({ pairs: 1, cited: 0 });
    expect(rows.reduce((a, r) => a + r.pairs, 0),
      'the scope buckets do not sum to the face pair count — some pairs were silently dropped')
      .toBe(aggregate(recs)[0].pairs);
  });

  it('keeps faces separate — a scope rate must not pool two faces', () => {
    const two = [{
      project: 'p', session: 's1', ts: 1, anyCite: true,
      faces: { pretool: { inj: [1], hit: [1] }, ups: { inj: [2], hit: [] } },
    }];
    const rows = byScope(two, scopeOf);
    expect(rows.find((r) => r.face === 'pretool' && r.scope === 'environment')).toMatchObject({ pairs: 1, cited: 1 });
    expect(rows.find((r) => r.face === 'ups' && r.scope === 'environment')).toMatchObject({ pairs: 1, cited: 0 });
  });
});

// ── end-to-end over a hand-built transcript root ────────────────────────────

let root;

/** One `hook_success` attachment record, the shape Claude Code writes. */
const attach = (command, stdout, ts) => JSON.stringify({
  type: 'attachment', timestamp: ts, attachment: { type: 'hook_success', command, stdout },
});
const assistant = (text, ts, extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra,
});

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cite-replay-'));
  const proj = join(root, 'proj-a');
  mkdirSync(proj, { recursive: true });
  const T = '2026-08-20T10:00:00.000Z';
  const T_AFTER = '2026-08-22T10:00:00.000Z';   // the far side of the --split date below

  writeFileSync(join(proj, 's1.jsonl'), [
    // pretool: 3 injected, 2 cited below.
    attach('node "/x/scripts/pre-tool-recall.js"',
      '  #101 [lesson] alpha\n  #102 [bugfix] beta\n  #103 [decision] gamma', T),
    // ups + task_imperative ride the SAME attachment — the overlap that kept the
    // imperative face unmetered since v3.23. They must land in different buckets.
    attach('node "/x/hook.mjs" user-prompt',
      `<memory-context>\n- [lesson] alpha | Lesson: a (#201)\n- [bugfix] beta (#202)\n</memory-context>\n${TASK_IMPERATIVE_PREFIX} You must: do the thing. (#301)`, T),
    // fyi
    attach('node "/x/scripts/user-prompt-search.js"',
      '[mem] FYI — Related memories\n#401 🟡 alpha\n#402 🔵 beta', T),
    // error_recall
    attach('bash /x/scripts/post-tool-use.sh',
      '[claude-mem-lite] Related memories found for this error:\n  #501 [bugfix] boom', T),
    // A sidechain-flagged attachment INSIDE the main transcript. The attachment faces
    // are scored mainOnly, matching the citation-decay loop, so #104 must not become a
    // pretool pair — otherwise the denominator counts an injection whose citation the
    // main thread was never in a position to make.
    JSON.stringify({
      type: 'attachment', timestamp: T, isSidechain: true,
      attachment: { type: 'hook_success', command: 'node "/x/scripts/pre-tool-recall.js"', stdout: '  #104 [lesson] delta' },
    }),
    assistant('Fixed per #101 and #102, and #201, and #301, and #401.', T),
    // The mirror of the record above, on the CITED side: a sidechain-flagged assistant
    // turn naming #103. The numerator is main-thread-only for the same reason the
    // denominator is, so #103 must stay uncited — a face is not credited for a citation
    // the main thread never made.
    assistant('Also relevant: #103.', T, { isSidechain: true }),
  ].join('\n') + '\n');

  // Sidechains, built so the two calibers give DIFFERENT answers. The first version of
  // this fixture had agent-a cite the very lesson it was handed, which makes
  // receiver-attribution and a session union agree — a union mutation survived it.
  //   agent-a: handed #601, cites #999 (never injected anywhere)
  //   agent-b: handed #602, cites #601 — another agent's lesson
  //   agent-c: handed #603, cites #603 — the only genuine adoption
  // receiver-attributed → 1 of 3.   session union → cited {999, 601, 603} → 3 of 3.
  const sub = join(proj, 's1', 'subagents');
  mkdirSync(sub, { recursive: true });
  const dispatched = (id, said) => [
    JSON.stringify({
      type: 'user', timestamp: T, isSidechain: true,
      message: { role: 'user', content: [{ type: 'text', text: `[Project memory — surfaced by your operator's claude-mem-lite]\n  #${id} — a lesson.` }] },
    }),
    assistant(`Proceeding, see #${said}.`, T, { isSidechain: true }),
  ].join('\n') + '\n';
  writeFileSync(join(sub, 'agent-a.jsonl'), dispatched(601, 999));
  writeFileSync(join(sub, 'agent-b.jsonl'), dispatched(602, 601));
  writeFileSync(join(sub, 'agent-c.jsonl'), dispatched(603, 603));

  // A SECOND session, stamped AFTER the split date used below. Without it every record
  // sits on one side and `--split` is never exercised as a partition: the pre-tag review
  // showed that both `before: aggregate(everything)` and `after: []` survived the suite,
  // because `expect(after).toHaveLength(0)` is a negative assertion with no decoy planted.
  // This is the decoy. It carries pretool only, so it moves exactly one face's totals.
  writeFileSync(join(proj, 's2.jsonl'), [
    attach('node "/x/scripts/pre-tool-recall.js"', '  #701 [lesson] epsilon\n  #702 [bugfix] zeta', T_AFTER),
    assistant('Applied #701.', T_AFTER),
  ].join('\n') + '\n');

});

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function run(extra = []) {
  const out = execFileSync(process.execPath, [SCRIPT, '--json', ...extra], {
    env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: root },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  return Object.fromEntries(parsed.overall.map((r) => [r.face, r]));
}

describe('end-to-end over a known corpus', () => {
  it('scores each face through the SHIPPED extractors', () => {
    const faces = run();
    expect(faces.pretool).toMatchObject({ pairs: 5, cited: 3 });  // s1 3/2 + s2 2/1
    expect(faces.ups).toMatchObject({ pairs: 2, cited: 1 });
    expect(faces.fyi).toMatchObject({ pairs: 2, cited: 1 });
    expect(faces.error_recall).toMatchObject({ pairs: 1, cited: 0 });
  });

  it('splits task_imperative from the ups block it shares an attachment with', () => {
    const faces = run();
    expect(faces.task_imperative).toMatchObject({ pairs: 1, cited: 1 });
    // …and the imperative id must NOT also be counted as a ups pair.
    expect(faces.ups.pairs).toBe(2);
  });

  it('credits a subagent citation only to the agent that RECEIVED the lesson', () => {
    const faces = run();
    // 3 dispatches, exactly ONE genuine adoption (agent-c). agent-b naming #601 is not
    // adoption of what agent-b was handed, and agent-a's #999 was never injected at all.
    // A session-union numerator — the caliber this face shipped with until v3.81.0 —
    // reads 3 of 3 on this same fixture; verified by mutating collectSubagentSurface.
    expect(faces.subagent).toMatchObject({ pairs: 3, cited: 1 });
  });

  // Review S2: the transcript -> `applied` path, end to end through the subprocess.
  // The unit assertions on mentionVsApplication drive hand-built records and would all
  // pass with `applied:` hardcoded to 0 in scanSession; this is the arm that fails then.
  //
  // Its OWN transcript root, deliberately. The corpus above encodes exact pair/cited
  // counts chosen to discriminate specific calibers, and adding two more pretool ids to
  // it would have meant editing those numbers to fit a new test — which is how a
  // discriminating fixture quietly stops discriminating.
  it('splits an injected id by whether the response naming it also called a tool', () => {
    const r2 = mkdtempSync(join(tmpdir(), 'cite-mentions-'));
    try {
      const proj = join(r2, 'proj-m');
      mkdirSync(proj, { recursive: true });
      const T = '2026-08-20T10:00:00.000Z';
      const resp = (requestId, blocks) => JSON.stringify({
        type: 'assistant', timestamp: T, requestId,
        message: { role: 'assistant', id: `msg-${requestId}`, content: blocks },
      });
      // #801 is named in a response that ALSO calls a tool; #802 only in prose. They sit
      // in DIFFERENT responses, so a per-file or per-user-turn bucket marks both applied
      // and this case reddens — that is the caliber the requestId unit exists for.
      writeFileSync(join(proj, 's.jsonl'), [
        // #803 is injected and never cited. Without it the corpus is 2 pairs / 2 hits and
        // the ruler's own ALWAYS-TRUE self-check refuses the run — correctly, since a
        // 100% face is indistinguishable from a broken membership test. Watching that
        // guard fire on a fixture built for a different purpose is itself confirmation
        // it is live.
        attach('node "/x/scripts/pre-tool-recall.js"', '  #801 [lesson] eta\n  #802 [bugfix] theta\n  #803 [decision] iota', T),
        resp('r1', [{ type: 'text', text: 'Applying #801 to the scheduler.' }]),
        resp('r1', [{ type: 'tool_use', name: 'Edit', id: 'tu1', input: {} }]),
        resp('r2', [{ type: 'text', text: 'For the record, #802 explains the earlier failure.' }]),
      ].join('\n') + '\n');

      const out = execFileSync(process.execPath, [SCRIPT, '--json', '--mentions'], {
        env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: r2 }, encoding: 'utf8',
      });
      const parsed = JSON.parse(out);
      const rows = parsed.mention_vs_application;
      expect(rows, '--mentions produced null — `applied` never reached the records').not.toBeNull();
      const pretool = rows.find((r) => r.face === 'pretool');
      expect(pretool).toMatchObject({ hits: 2, applied: 1, mentionOnly: 1, mentionOnlyPct: '50.0%' });
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });

  it('declares keyctx unreachable rather than omitting it', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--json'], {
      env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: root }, encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed.not_replayable)).toContain('keyctx');
    // Not silently absent: every product face is accounted for one way or the other.
    const scored = new Set(parsed.overall.map((r) => r.face));
    for (const face of CITATION_SURFACES) {
      expect(scored.has(face) || face in parsed.not_replayable).toBe(true);
    }
  });

  it('--split PARTITIONS one walk: both arms non-empty and summing to overall', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--json', '--split', '2026-08-21'], {
      env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: root }, encoding: 'utf8',
    });
    const parsed = JSON.parse(out);
    const byFace = (rows) => Object.fromEntries(rows.map((r) => [r.face, r]));
    const before = byFace(parsed.before);
    const after = byFace(parsed.after);
    const overall = byFace(parsed.overall);

    // s1 (2026-08-20) lands before, s2 (2026-08-22) lands after. BOTH arms carry rows —
    // an arm that is empty by construction cannot detect an arm that is empty by defect.
    expect(parsed.before.length).toBeGreaterThan(0);
    expect(parsed.after.length).toBeGreaterThan(0);
    expect(before.pretool).toMatchObject({ pairs: 3, cited: 2 });
    expect(after.pretool).toMatchObject({ pairs: 2, cited: 1 });

    // The partition property itself, asserted rather than described in a comment: every
    // face's pairs and cites split across the two arms with nothing lost or double-counted.
    for (const face of Object.keys(overall)) {
      expect((before[face]?.pairs ?? 0) + (after[face]?.pairs ?? 0)).toBe(overall[face].pairs);
      expect((before[face]?.cited ?? 0) + (after[face]?.cited ?? 0)).toBe(overall[face].cited);
    }
    // A face that exists on only ONE side must still be absent from the other, not
    // silently duplicated: the single-session faces all sit in `before`.
    expect(after.task_imperative).toBeUndefined();
  });

  it('runs its self-checks on the REAL path, not only in unit tests', () => {
    // The two guards used to be two separate calls in main(); commenting BOTH out left
    // every case green, because each test drove the exported functions directly. They now
    // share one wiring point and this case binds it: a corpus where the assistant cites
    // every injected id makes the membership test look always-true, and the process must
    // refuse to print a table rather than publish six 100% rows.
    const saturated = mkdtempSync(join(tmpdir(), 'cite-replay-sat-'));
    try {
      const p = join(saturated, 'proj-sat');
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 's1.jsonl'), [
        attach('node "/x/scripts/pre-tool-recall.js"', '  #101 [lesson] alpha', '2026-08-20T10:00:00.000Z'),
        assistant('Per #101.', '2026-08-20T10:00:00.000Z'),
      ].join('\n') + '\n');
      expect(() => execFileSync(process.execPath, [SCRIPT, '--json'], {
        env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: saturated }, encoding: 'utf8', stdio: 'pipe',
      })).toThrow(/ALWAYS-TRUE/);
    } finally {
      rmSync(saturated, { recursive: true, force: true });
    }
  });

  it('--dump then --corpus re-scores the SAME frozen corpus', () => {
    const frozen = join(root, 'frozen.json');
    execFileSync(process.execPath, [SCRIPT, '--json', '--dump', frozen], {
      env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: root }, encoding: 'utf8',
    });
    // Re-scored with the transcript root pointed at an EMPTY dir: the numbers must come
    // from the frozen file, otherwise `--corpus` is silently re-walking.
    const empty = mkdtempSync(join(tmpdir(), 'cite-replay-empty-'));
    try {
      const out = execFileSync(process.execPath, [SCRIPT, '--json', '--corpus', frozen], {
        env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: empty }, encoding: 'utf8',
      });
      const faces = Object.fromEntries(JSON.parse(out).overall.map((r) => [r.face, r]));
      expect(faces.pretool).toMatchObject({ pairs: 5, cited: 3 });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('REFUSES a frozen corpus this build cannot read, instead of half-scoring it', () => {
    const stale = join(root, 'stale.json');
    writeFileSync(stale, JSON.stringify({ format: 'citation-live-replay/0', files: 1, records: [] }));
    expect(() => execFileSync(process.execPath, [SCRIPT, '--json', '--corpus', stale], {
      env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: root }, encoding: 'utf8', stdio: 'pipe',
    })).toThrow(/citation-live-replay\/0/);
  });

  it('REFUSES a /1 corpus specifically — the version whose records lack citedTotal', () => {
    // Binds the format BUMP, not just the format check (pre-tag review S-5). A /1 record
    // has no `citedTotal`, and pollutionSensitivity reads `(r.citedTotal ?? 0)` — so if the
    // constant were reverted to /1 the file would be accepted and every frozen session
    // would read as pollution-free. That is the silently-wrong published number this whole
    // guard exists to prevent, and nothing failed when the bump was reverted.
    const v1 = join(root, 'v1.json');
    writeFileSync(v1, JSON.stringify({
      format: 'citation-live-replay/1',
      files: 1,
      records: [{ project: 'p', session: 's1', ts: 1, anyCite: true, faces: { pretool: { inj: [1], hit: [1] } } }],
    }));
    expect(() => execFileSync(process.execPath, [SCRIPT, '--json', '--corpus', v1], {
      env: { ...process.env, CLAUDE_MEM_TRANSCRIPT_ROOT: root }, encoding: 'utf8', stdio: 'pipe',
    })).toThrow(/citation-live-replay\/1/);
  });
});

// ── FLOW-2(b) / D#179: make the mention-inflation in these readings legible ──
//
// A face's `hit` list can only contain ids that face injected, so nothing already in a
// record could see a session that names fifty ids none of which were ever injected. The
// annotation needs the session's WHOLE cited count, which is why records carry
// `citedTotal` and the corpus format went to /2.
describe('pollutionSensitivity', () => {
  const rec = (session, citedTotal, faces) => ({
    project: 'p', session, ts: 1, anyCite: true, citedTotal, faces,
  });

  it('recomputes each face with document-shaped sessions excluded', () => {
    const records = [
      // Ordinary session: the face's two picks, one cited.
      rec('s1', 3, { pretool: { inj: [1, 2], hit: [1] } }),
      // Document-shaped: 40 ids named in prose, and its picks read as fully cited.
      rec('s2', 40, { pretool: { inj: [3, 4], hit: [3, 4] } }),
    ];
    const rows = aggregate(records);
    const out = pollutionSensitivity(records, rows);
    expect(out.docSessions).toBe(1);
    const pretool = out.rows.find((r) => r.face === 'pretool');
    expect(pretool.rate).toBe('75.0%');            // 3/4 with the document session in
    expect(pretool.pairsFromDocSessions).toBe(2);
    expect(pretool.rateExclDocSessions).toBe('50.0%'); // 1/2 without it
    expect(pretool.delta).toBe('-25.0pp');
  });

  it('reports nothing to discount when no session is document-shaped', () => {
    const records = [rec('s1', 3, { pretool: { inj: [1, 2], hit: [1] } })];
    const out = pollutionSensitivity(records, aggregate(records));
    expect(out.docSessions).toBe(0);
    expect(out.rows).toEqual([]);
  });

  it('treats a missing citedTotal as not-document-shaped rather than as zero pollution', () => {
    // A /1 record has no citedTotal. The format gate refuses those corpora outright, but
    // the reducer must not silently treat the absence as "measured, and clean".
    const records = [{ project: 'p', session: 's1', ts: 1, anyCite: true, faces: { pretool: { inj: [1], hit: [1] } } }];
    expect(pollutionSensitivity(records, aggregate(records)).docSessions).toBe(0);
  });

  it('the threshold can say NO — a face made entirely of document sessions reads n/a', () => {
    // Anti-vacuity for `rateExclDocSessions`: if every pair for a face comes from
    // document-shaped sessions there is no clean sub-population, and the cell must say so
    // rather than quietly reporting 0%.
    const records = [rec('s1', 50, { fyi: { inj: [1, 2], hit: [1] } })];
    const out = pollutionSensitivity(records, aggregate(records));
    expect(out.docSessions).toBe(1);
    expect(out.rows.find((r) => r.face === 'fyi').rateExclDocSessions).toBe('n/a');
  });
});

// D#179 aggregation. The two properties worth pinning are both about NOT reporting
// something that was never measured: an absent `applied` field (an older frozen corpus)
// must come back as null rather than 0%, and only faces that actually carry the field
// may appear at all.
describe('mentionVsApplication (D#179)', () => {
  const rec = (faces) => ({ project: 'p', session: 's', ts: 1, anyCite: true, citedTotal: 1, faces });

  it('splits hits into applied and mention-only per face', () => {
    const rows = mentionVsApplication([
      rec({ pretool: { inj: [1, 2, 3], hit: [1, 2, 3], applied: 1 } }),
      rec({ pretool: { inj: [4], hit: [4], applied: 0 } }),
    ]);
    expect(rows).toEqual([{ face: 'pretool', hits: 4, applied: 1, mentionOnly: 3, mentionOnlyPct: '75.0%' }]);
  });

  it('returns null — not zeros — when no record carries the field', () => {
    // A frozen corpus dumped before D#179 has hits but no `applied`. Reporting that as
    // "0 applied / 100% mention-only" would be a fabricated finding, and it is exactly
    // the shape that reads most like a dramatic result.
    expect(mentionVsApplication([rec({ pretool: { inj: [1], hit: [1] } })])).toBeNull();
  });

  it('omits a face whose records lack the field while keeping one that has it', () => {
    const rows = mentionVsApplication([
      rec({ pretool: { inj: [1], hit: [1], applied: 1 }, subagent: { inj: [2], hit: [2] } }),
    ]);
    expect(rows.map((r) => r.face)).toEqual(['pretool']);
  });

  it('ignores faces with no hits at all', () => {
    expect(mentionVsApplication([rec({ ups: { inj: [1], hit: [], applied: 0 } })])).toBeNull();
  });
});
