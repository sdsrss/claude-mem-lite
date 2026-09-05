// D#152: the `subagent` injection face — metering the one surface that leaves
// no trace in the parent transcript.
//
// pre-agent-inject.js appends formatSubagentContext to a DISPATCHED subagent's
// task prompt via PreToolUse `updatedInput`. Claude Code writes that turn to
// <session>/subagents/agent-<name>-<hash>.jsonl, not the parent file, so every
// attachment-based extractor reads 0 and citation_surface_log had no row for
// this face at all — its contribution to every denominator was zero by
// construction rather than by measurement.
//
// Two search shapes that silently find nothing (#10801, the reason this sat
// blocked): the files are NOT at the transcript directory's top level, and
// grepping the PARENT transcript for isSidechain returns 0 records.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  findSubagentTranscripts,
  collectSubagentSurface,
  recordCitationSurfaces,
  computeSurfaceFunnel,
  CITATION_SURFACES,
  DECAY_DENOMINATOR_SURFACES,
  NON_ATTACHMENT_SURFACES,
  extractInjectedBySurface,
} from '../lib/citation-tracker.mjs';
import { formatSubagentContext } from '../lib/task-imperative.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

const writeJsonl = (path, entries) => writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));

// The subagent's own first turn: the task prompt with our block appended.
const promptTurn = (...idLessons) => ({
  type: 'user',
  isSidechain: true,
  message: {
    content: [
      {
        type: 'text',
        text: 'Do the thing.\n' + idLessons.map(([id, l]) => formatSubagentContext(l, id)).join('\n'),
      },
    ],
  },
});
const subagentCite = (text) => ({
  type: 'assistant',
  isSidechain: true,
  message: { content: [{ type: 'text', text }] },
});

describe('findSubagentTranscripts — the layout that blocked D#152', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sub-face-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('derives <session>/subagents/ from the parent transcript path', () => {
    const parent = join(tmp, 'sess-a.jsonl');
    writeJsonl(parent, [{ type: 'assistant', message: { content: [] } }]);
    const dir = join(tmp, 'sess-a', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeJsonl(join(dir, 'agent-explore-1a2b.jsonl'), [promptTurn([11, 'lesson one'])]);
    writeJsonl(join(dir, 'agent-review-3c4d.jsonl'), [promptTurn([22, 'lesson two'])]);

    const found = findSubagentTranscripts(parent);
    expect(found).toHaveLength(2);
    expect(found.every((p) => p.includes(join('sess-a', 'subagents')))).toBe(true);
  });

  it('returns [] for a session that dispatched no subagents (no throw on missing dir)', () => {
    const parent = join(tmp, 'sess-lonely.jsonl');
    writeJsonl(parent, [{ type: 'assistant', message: { content: [] } }]);
    expect(findSubagentTranscripts(parent)).toEqual([]);
  });

  it('ignores non-.jsonl siblings (the per-agent .meta.json files)', () => {
    const parent = join(tmp, 'sess-b.jsonl');
    writeJsonl(parent, [{ type: 'assistant', message: { content: [] } }]);
    const dir = join(tmp, 'sess-b', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeJsonl(join(dir, 'agent-x-9f9f.jsonl'), [promptTurn([11, 'lesson one'])]);
    writeFileSync(join(dir, 'agent-x-9f9f.meta.json'), '{"name":"x"}');
    expect(findSubagentTranscripts(parent)).toHaveLength(1);
  });

  // The decoy is load-bearing: without it, `'not-a-transcript'.slice(0, -6)`
  // names a directory that does not exist, `readdirSync` throws, and the catch
  // returns the same [] the guard would have — so dropping the `.endsWith`
  // guard killed nothing (found in the v3.77.0 pre-tag review). With a real
  // subagents dir at the sliced path, the unguarded version leaks a file.
  it('tolerates a null / non-.jsonl transcript path', () => {
    expect(findSubagentTranscripts(null)).toEqual([]);
    const sliced = join(tmp, 'not-a-tran'); // 'not-a-transcript'.slice(0, -'.jsonl'.length)
    mkdirSync(join(sliced, 'subagents'), { recursive: true });
    writeJsonl(join(sliced, 'subagents', 'agent-decoy-9z9z.jsonl'), [promptTurn([99, 'decoy lesson'])]);
    expect(findSubagentTranscripts(join(tmp, 'not-a-transcript'))).toEqual([]);
  });
});

describe('collectSubagentSurface — injected from the prompt, cited from the sidechain', () => {
  let tmp;
  let parent;
  let dir;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sub-face2-'));
    parent = join(tmp, 'sess-c.jsonl');
    writeJsonl(parent, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'parent turn' }] } },
    ]);
    dir = join(tmp, 'sess-c', 'subagents');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('unions injected ids across every dispatched subagent', () => {
    writeJsonl(join(dir, 'agent-a-1.jsonl'), [promptTurn([11, 'first lesson'])]);
    writeJsonl(join(dir, 'agent-b-2.jsonl'), [promptTurn([22, 'second lesson'])]);
    const { injected, files } = collectSubagentSurface(parent);
    expect(files).toBe(2);
    expect([...injected].sort((a, b) => a - b)).toEqual([11, 22]);
  });

  // The load-bearing asymmetry: the citation lands in the SUBAGENT's text. If
  // this face were scored against the main thread's cited set it would read 0%
  // for every session, which is a measurement artifact, not a rate.
  it('reads the citation from the subagent transcript, not the parent', () => {
    writeJsonl(join(dir, 'agent-a-1.jsonl'), [
      promptTurn([11, 'first lesson'], [22, 'second lesson']),
      subagentCite('Applying #11 to the fix; #22 n/a here.'),
    ]);
    const { injected, cited } = collectSubagentSurface(parent);
    expect([...injected].sort((a, b) => a - b)).toEqual([11, 22]);
    expect(cited.has(11)).toBe(true);
    expect(cited.has(22)).toBe(true);
    // …and the parent transcript carries neither the injection nor the cite,
    // which is exactly why the attachment extractors read this face as absent.
    const parentFaces = extractInjectedBySurface(parent);
    for (const face of Object.keys(parentFaces)) expect(parentFaces[face].size).toBe(0);
  });

  it('an uncited dispatch yields injections with an empty cited set (a real 0%, not a missing row)', () => {
    writeJsonl(join(dir, 'agent-a-1.jsonl'), [
      promptTurn([33, 'ignored lesson']),
      subagentCite('Done. No lesson applied.'),
    ]);
    const { injected, cited } = collectSubagentSurface(parent);
    expect([...injected]).toEqual([33]);
    expect(cited.size).toBe(0);
  });

  // Same anchoring discipline as every other face (#8584 / #8850): only the
  // `#NN — ` tag line counts, so a lesson body quoting an obs id does not
  // inflate the denominator.
  it('does not count a #NN quoted inside the lesson body as injected', () => {
    writeJsonl(join(dir, 'agent-a-1.jsonl'), [
      promptTurn([44, 'root cause matched #9999 from the earlier round']),
    ]);
    const { injected } = collectSubagentSurface(parent);
    expect(injected.has(44)).toBe(true);
    expect(injected.has(9999)).toBe(false);
  });

  it('is empty when the session dispatched no subagents', () => {
    const { injected, cited, files } = collectSubagentSurface(parent);
    expect(files).toBe(0);
    expect(injected.size).toBe(0);
    expect(cited.size).toBe(0);
  });

  // D#164. `subagent` is the ONLY face where the injection and the citation can
  // land in different contexts: every other face injects into the main thread and
  // looks for the cite in that same thread. Unioning `cited` across the whole
  // subagents/ directory credits this face when agent B cites a lesson that agent
  // A received — B got that id from somewhere else (the parent quoted it, or its
  // own prompt did), so the credit is unearned. Measured on the live corpus before
  // this guard existed: 13/48 under the union, 12/48 receiver-attributed.
  //
  // The decoy is the second agent's OWN lesson (#22, received AND cited by B).
  // Without it, "cited must be empty" would also pass for a fix that simply
  // stopped reading the sidechains at all.
  it('credits a cite only to the agent that RECEIVED the lesson', () => {
    writeJsonl(join(dir, 'agent-a-1.jsonl'), [
      promptTurn([11, 'lesson handed to A']),
      subagentCite('A did the work without referring to anything.'),
    ]);
    writeJsonl(join(dir, 'agent-b-2.jsonl'), [
      promptTurn([22, 'lesson handed to B']),
      subagentCite('Applying #22 here; also noting #11 which the parent mentioned.'),
    ]);
    const { injected, cited } = collectSubagentSurface(parent);
    expect([...injected].sort((a, b) => a - b)).toEqual([11, 22]);
    // B's own lesson is credited…
    expect(cited.has(22)).toBe(true);
    // …A's is not, even though the string `#11` appears in the same session.
    expect(cited.has(11)).toBe(false);
  });

  // Consequence of the rule above, stated on its own so a future change that
  // widens `cited` back to the union fails on the invariant and not only on the
  // one hand-built case: the face can never report cited > injected.
  it('never credits an id that no agent was handed', () => {
    writeJsonl(join(dir, 'agent-a-1.jsonl'), [
      promptTurn([11, 'lesson handed to A']),
      subagentCite('Citing #11 and, separately, #77 which was never injected.'),
    ]);
    const { injected, cited } = collectSubagentSurface(parent);
    expect(cited.has(11)).toBe(true);
    expect(cited.has(77)).toBe(false);
    expect([...cited].every((id) => injected.has(id))).toBe(true);
  });
});

describe('subagent face in the surface enum and the decay denominator', () => {
  it('is a declared CITATION_SURFACES member (recordCitationSurfaces drops unknown labels)', () => {
    expect(CITATION_SURFACES).toContain('subagent');
  });

  // READ THE NAME CAREFULLY — this pins the DERIVATION, not the behaviour, and since
  // v3.83.0 those differ. `subagent` leaves no hook attachment, so it can never enter
  // `DECAY_DENOMINATOR_SURFACES` (derived from ATTACHMENT_SURFACES); D#177 admitted it to
  // the decay loop at the CALL SITE in hook.mjs instead, because its numerator has to
  // travel with it. So this assertion still holds and still catches a refactor that folds
  // the face into the attachment table — but it is NOT the guard for "does this face
  // demote lessons". That guard is tests/citation-surface-funnel-e2e.test.mjs's D#177
  // block, which drives a real Stop.
  //
  // The old name was 'stays OUT of the decay denominator', which went on passing while
  // the opposite shipped — the class of green test this repo keeps having to rename.
  it('stays out of the DECAY_DENOMINATOR_SURFACES derivation (admitted at the call site since v3.83.0 — see D#177)', () => {
    expect(DECAY_DENOMINATOR_SURFACES).not.toContain('subagent');
  });

  // The counterpart of the imperative suite's "leaves no face undeclared" guard,
  // for the other direction: a face in the enum but not in the attachment table
  // is invisible to that guard, so it needs its own declaration.
  it('every enum face is either an attachment face or explicitly non-attachment', () => {
    const attachmentFaces = Object.keys(extractInjectedBySurface(null));
    const declared = new Set([...attachmentFaces, ...NON_ATTACHMENT_SURFACES]);
    expect(CITATION_SURFACES.filter((f) => !declared.has(f))).toEqual([]);
    // …and the two sets are disjoint, so nothing is declared twice.
    expect(NON_ATTACHMENT_SURFACES.filter((f) => attachmentFaces.includes(f))).toEqual([]);
  });
});

describe('subagent face round-trips into citation_surface_log', () => {
  let db;
  let tmp;
  let parent;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-sub', project: 'p1' });
    tmp = mkdtempSync(join(tmpdir(), 'sub-face3-'));
    parent = join(tmp, 'cc-sess.jsonl');
    writeJsonl(parent, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'parent' }] } }]);
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  const mk = (title) =>
    Number(
      insertObs(db, {
        sessionId: 'sess-sub',
        project: 'p1',
        type: 'bugfix',
        title,
        importance: 2,
      }).lastInsertRowid,
    );

  it('records injected/cited under its own surface row, readable by the funnel', () => {
    const usedId = mk('lesson the subagent applied');
    const ignoredId = mk('lesson the subagent ignored');
    const dir = join(tmp, 'cc-sess', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeJsonl(join(dir, 'agent-r-1.jsonl'), [
      promptTurn([usedId, 'applied lesson'], [ignoredId, 'ignored lesson']),
      subagentCite(`Applied #${usedId} to the change.`),
    ]);

    const sub = collectSubagentSurface(parent);
    const written = recordCitationSurfaces(db, 'p1', 'cc-sess', { subagent: sub.injected }, sub.cited);
    expect(written.subagent).toEqual({ injected: 2, cited: 1 });

    const funnel = computeSurfaceFunnel(db, { days: 7, project: 'p1' });
    const row = funnel.surfaces.find((s) => s.surface === 'subagent');
    expect(row).toBeTruthy();
    expect(row.injected).toBe(2);
    expect(row.cited).toBe(1);
    expect(row.rate).toBeCloseTo(0.5, 5);
  });

  // Two recordCitationSurfaces calls for one session is the shape the Stop path
  // uses (main faces + citedMain, then subagent + citedSub). The upsert key is
  // (project, session, surface), so the second call must not disturb the first.
  it('a second call for a different face does not overwrite the main-face rows', () => {
    const mainId = mk('main-thread lesson');
    const subId = mk('subagent lesson');
    recordCitationSurfaces(db, 'p1', 'cc-sess', { pretool: new Set([mainId]) }, new Set([mainId]));
    recordCitationSurfaces(db, 'p1', 'cc-sess', { subagent: new Set([subId]) }, new Set());

    const funnel = computeSurfaceFunnel(db, { days: 7, project: 'p1' });
    const pretool = funnel.surfaces.find((s) => s.surface === 'pretool');
    const subagent = funnel.surfaces.find((s) => s.surface === 'subagent');
    expect(pretool).toMatchObject({ injected: 1, cited: 1 });
    expect(subagent).toMatchObject({ injected: 1, cited: 0 });
    // One session, two faces — the "over N sessions" column must not double it.
    expect(pretool.sessions).toBe(1);
    expect(subagent.sessions).toBe(1);
  });
});
