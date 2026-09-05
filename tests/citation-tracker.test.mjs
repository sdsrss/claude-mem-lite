// P4 citation tracker — transcript scanning + access_count bump.
//
// Verifies #NN citations in assistant text are extracted (not from user/tool
// messages), deduped, and bumped against observations scoped by project.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractCitationsFromTranscript,
  classifyCitationContext,
  extractUserTypedIds,
  buildCitationRelevanceSet,
  assertRelevanceCoversAllFaces,
  CITATION_SURFACES,
  bumpCitationAccess,
  computeCiteRecall,
} from '../lib/citation-tracker.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { keyContextIdsFileName } from '../lib/injected-ids.mjs';

describe('extractCitationsFromTranscript', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'citation-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('extracts #NN from assistant text blocks', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Per #42 and #7556, I avoided the regression.' }] },
      },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(42)).toBe(true);
    expect(ids.has(7556)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('dedupes repeated citations', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '#42 and #42 again' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'still #42' }] },
      },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.size).toBe(1);
    expect(ids.has(42)).toBe(true);
  });

  it('ignores #NN in user messages', () => {
    const path = writeTranscript([
      { type: 'user', message: { content: [{ type: 'text', text: 'look at #99' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I see #42' }] } },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(99)).toBe(false);
    expect(ids.has(42)).toBe(true);
  });

  it('ignores non-text content blocks (tool_use / tool_result / thinking)', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: 'x' } },
            { type: 'thinking', thinking: 'Considering #77 but not citing' },
            { type: 'text', text: 'Actually, per #42 it works.' },
          ],
        },
      },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.size).toBe(1);
    expect(ids.has(42)).toBe(true);
    expect(ids.has(77)).toBe(false);
  });

  it('rejects out-of-range IDs (0, >= 1e7, negative)', () => {
    const path = writeTranscript([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '#0 and #99999999 and #1234567 are weird' }] },
      },
    ]);
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(0)).toBe(false);
    expect(ids.has(99999999)).toBe(false);
    expect(ids.has(1234567)).toBe(true); // boundary: 7 digits OK, 8 digits rejected
  });

  it('returns empty set for missing transcript path', () => {
    expect(extractCitationsFromTranscript('/nonexistent/path').size).toBe(0);
    expect(extractCitationsFromTranscript('').size).toBe(0);
    expect(extractCitationsFromTranscript(null).size).toBe(0);
  });

  it('tolerates malformed JSONL lines', () => {
    const path = join(tmp, 'bad.jsonl');
    writeFileSync(
      path,
      'not json\n{"type":"assistant","message":{"content":[{"type":"text","text":"#42"}]}}\nalso bad',
    );
    const ids = extractCitationsFromTranscript(path);
    expect(ids.has(42)).toBe(true);
    expect(ids.size).toBe(1);
  });
});

describe('bumpCitationAccess', () => {
  let db;
  // FLOW-2: the function now takes the relevance gate as a required 4th argument.
  // These pre-existing cases are about the UPDATE mechanics (project scoping,
  // accumulation, iterable shapes), so they pass a gate that admits everything they
  // cite; the gate's own behaviour is covered in its own describe below.
  const ALL = (...ids) => new Set(ids);

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'projects--test' });
  });

  afterEach(() => {
    db.close();
  });

  const newObs = (opts) => Number(insertObs(db, opts).lastInsertRowid);

  it('increments access_count for matched project obs', () => {
    const id1 = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    const id2 = newObs({ title: 'Y', type: 'decision', project: 'projects--test' });

    const n = bumpCitationAccess(db, [id1, id2], 'projects--test', ALL(id1, id2));
    expect(n).toBe(2);
    const rows = db
      .prepare('SELECT id, access_count, last_accessed_at FROM observations WHERE id IN (?, ?)')
      .all(id1, id2);
    for (const r of rows) {
      expect(r.access_count).toBe(1);
      expect(r.last_accessed_at).toBeGreaterThan(0);
    }
  });

  it('ignores IDs belonging to other projects', () => {
    insertSession(db, { id: 'sess-other', project: 'projects--other' });
    const id1 = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    const id2 = newObs({ title: 'Y', type: 'bugfix', project: 'projects--other', sessionId: 'sess-other' });

    const n = bumpCitationAccess(db, [id1, id2], 'projects--test', ALL(id1, id2));
    expect(n).toBe(1);
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id1).access_count).toBe(1);
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id2).access_count).toBe(0);
  });

  it('returns 0 for empty id list', () => {
    expect(bumpCitationAccess(db, [], 'projects--test', ALL())).toBe(0);
    expect(bumpCitationAccess(db, new Set(), 'projects--test', ALL())).toBe(0);
  });

  it('returns 0 for non-existent IDs (no crash)', () => {
    expect(bumpCitationAccess(db, [999999], 'projects--test', ALL(999999))).toBe(0);
  });

  it('accumulates across multiple citation rounds', () => {
    const id1 = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    bumpCitationAccess(db, [id1], 'projects--test', ALL(id1));
    bumpCitationAccess(db, [id1], 'projects--test', ALL(id1));
    bumpCitationAccess(db, [id1], 'projects--test', ALL(id1));
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id1).access_count).toBe(3);
  });

  it('accepts Set and Array iterables', () => {
    const id1 = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    const n = bumpCitationAccess(db, new Set([id1]), 'projects--test', ALL(id1));
    expect(n).toBe(1);
  });

  // ── FLOW-2 / D#179: the relevance gate ──
  //
  // The cited set is "every #NN in this session's assistant text" and cannot tell a
  // citation from a mention. In THIS repository a CHANGELOG- or audit-writing session
  // names dozens of ids in prose, and access_count > 3 promotes a row a tier through
  // boostAccessed — so discussing a memory made it likelier to be injected, and inflated
  // the cite-rate instrumentation product decisions are read off at the same time.

  it('credits a cited id that was injected this session', () => {
    const id = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    expect(bumpCitationAccess(db, [id], 'projects--test', new Set([id]))).toBe(1);
  });

  it('does NOT credit a cited id that was neither injected nor typed by the user', () => {
    // The audit-writing session: the agent mentions an id nothing put in front of it.
    const discussed = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    const injected = newObs({ title: 'Y', type: 'decision', project: 'projects--test' });
    const n = bumpCitationAccess(db, [discussed, injected], 'projects--test', new Set([injected]));
    expect(n).toBe(1);
    const acc = (id) => db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id).access_count;
    expect(acc(discussed)).toBe(0);
    expect(acc(injected)).toBe(1);
  });

  it('refuses to credit anything when no gate is passed', () => {
    // Omission must be a closed gate, not an open one — that is how the ungated channel
    // survived. Loud in telemetry (debugLog WARN), zero rows touched.
    const id = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    expect(bumpCitationAccess(db, [id], 'projects--test')).toBe(0);
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id).access_count).toBe(0);
  });

  it('CLAUDE_MEM_CITATION_RELEVANCE_GATE=off restores the pre-v3.84.0 behaviour', () => {
    // The documented revert path. It restores ALL of the old behaviour including the
    // missing-argument hole — a half-reverted gate would be a third behaviour nobody has
    // measured.
    const discussed = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    const env = { CLAUDE_MEM_CITATION_RELEVANCE_GATE: 'off' };
    expect(bumpCitationAccess(db, [discussed], 'projects--test', new Set(), env)).toBe(1);
    expect(bumpCitationAccess(db, [discussed], 'projects--test', undefined, env)).toBe(1);
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(discussed).access_count).toBe(
      2,
    );
  });

  it('an unset or unrelated flag value leaves the gate ON', () => {
    // Off-by-default reverts are how a guard quietly stops guarding. Only the documented
    // token disarms it.
    const discussed = newObs({ title: 'X', type: 'bugfix', project: 'projects--test' });
    for (const env of [
      {},
      { CLAUDE_MEM_CITATION_RELEVANCE_GATE: '' },
      { CLAUDE_MEM_CITATION_RELEVANCE_GATE: '0' },
      { CLAUDE_MEM_CITATION_RELEVANCE_GATE: 'false' },
    ]) {
      expect(bumpCitationAccess(db, [discussed], 'projects--test', new Set(), env)).toBe(0);
    }
    expect(db.prepare('SELECT access_count FROM observations WHERE id = ?').get(discussed).access_count).toBe(
      0,
    );
  });

  it('the flag does NOT restore crediting a tombstone (FLOW-6 is not part of the revert)', () => {
    // FLOW-6 was a separate defect with no upside to restore, so it stays fixed on both
    // sides of the flag.
    const keeper = newObs({ title: 'K', type: 'bugfix', project: 'projects--test' });
    const dead = newObs({ title: 'D', type: 'bugfix', project: 'projects--test' });
    db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?').run(
      Date.now(),
      keeper,
      dead,
    );
    bumpCitationAccess(db, [dead], 'projects--test', undefined, {
      CLAUDE_MEM_CITATION_RELEVANCE_GATE: 'off',
    });
    const acc = (id) => db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id).access_count;
    expect(acc(keeper)).toBe(1);
    expect(acc(dead)).toBe(0);
  });

  it('redirects a superseded citation to its keeper (FLOW-6)', () => {
    // Parity with applyCitationDecay / recordCitationSurfaces. This was the last
    // access-side surface still crediting the tombstone instead of the row that
    // absorbed it.
    const keeper = newObs({ title: 'K', type: 'bugfix', project: 'projects--test' });
    const dead = newObs({ title: 'D', type: 'bugfix', project: 'projects--test' });
    db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?').run(
      Date.now(),
      keeper,
      dead,
    );

    // Cited AND gated by the OLD id — both sides must redirect, or the keeper id in one
    // would never meet its superseded twin in the other.
    const n = bumpCitationAccess(db, [dead], 'projects--test', new Set([dead]));
    expect(n).toBe(1);
    const acc = (id) => db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id).access_count;
    expect(acc(keeper)).toBe(1);
    expect(acc(dead)).toBe(0);
  });
});

describe('extractUserTypedIds', () => {
  const write = (entries) => {
    const f = join(mkdtempSync(join(tmpdir(), 'mem-usertyped-')), 't.jsonl');
    writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return f;
  };

  it('picks up an id the user typed in their own message', () => {
    const f = write([{ type: 'user', message: { content: 'please re-read #10716 before editing' } }]);
    expect([...extractUserTypedIds(f)]).toEqual([10716]);
  });

  it('reads array content blocks, and ignores tool_result blocks', () => {
    // A tool_result rides inside a user turn but is program output, not something the
    // user wrote — crediting ids echoed back by a tool would reopen the gate sideways.
    const f = write([
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'compare with #4242' },
            { type: 'tool_result', content: 'grep output mentioning #9999' },
          ],
        },
      },
    ]);
    const ids = extractUserTypedIds(f);
    expect(ids.has(4242)).toBe(true);
    expect(ids.has(9999)).toBe(false);
  });

  it('does not pick up ids from assistant text', () => {
    // The whole point of the gate: the assistant's own prose is the polluted channel.
    const f = write([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'as noted in #777' }] } },
    ]);
    expect(extractUserTypedIds(f).size).toBe(0);
  });

  it('honours mainOnly for sidechain user turns', () => {
    const f = write([{ type: 'user', isSidechain: true, message: { content: 'see #555' } }]);
    expect(extractUserTypedIds(f).has(555)).toBe(true);
    expect(extractUserTypedIds(f, { mainOnly: true }).has(555)).toBe(false);
  });
});

describe('computeCiteRecall', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cite-recall-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
    return path;
  }

  it('returns zeros for missing transcript', () => {
    expect(computeCiteRecall(join(tmp, 'nope.jsonl'))).toEqual({
      injected: 0,
      cited: 0,
      recalled: 0,
      ratio: 0,
    });
  });

  it('computes 1.0 ratio when assistant cites every injected #NN', () => {
    const path = writeTranscript([
      { type: 'system', content: '[mem] PreToolUse recall: #10 lesson...' },
      { type: 'system', content: '[mem] #20 another lesson' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Applying #10 and #20 here.' }] } },
    ]);
    const stats = computeCiteRecall(path);
    expect(stats.injected).toBe(2);
    expect(stats.recalled).toBe(2);
    expect(stats.ratio).toBe(1);
  });

  it('computes partial ratio when some IDs ignored', () => {
    const path = writeTranscript([
      { type: 'system', content: '#1 #2 #3 #4 #5' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Cited #1 and #2.' }] } },
    ]);
    const stats = computeCiteRecall(path);
    expect(stats.injected).toBe(5);
    expect(stats.recalled).toBe(2);
    expect(stats.ratio).toBeCloseTo(0.4);
  });

  it('ignores cited IDs that were not injected', () => {
    const path = writeTranscript([
      { type: 'system', content: '#10' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Cited #10 and unrelated #999.' }] } },
    ]);
    const stats = computeCiteRecall(path);
    // injected = #10, cited = #10+#999, recalled (intersection) = #10 → ratio = 1/1
    expect(stats.injected).toBe(1);
    expect(stats.cited).toBe(2);
    expect(stats.recalled).toBe(1);
    expect(stats.ratio).toBe(1);
  });

  it('reads tool_result content blocks (transcript shape variant)', () => {
    const path = writeTranscript([
      { type: 'user', message: { content: [{ type: 'tool_result', text: '#5 lesson' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Per #5, fixed.' }] } },
    ]);
    const stats = computeCiteRecall(path);
    expect(stats.injected).toBe(1);
    expect(stats.recalled).toBe(1);
  });
});

// ── The relevance population: all SEVEN faces, not extractAllInjected's five ──
//
// Caught by BOTH pre-tag reviewers independently. The first cut of the gate built the set
// from extractAllInjected alone, which covers only the faces with a hook attachment to
// walk. The two it omits are omitted for reasons that do not apply to the promotion
// channel — and extractInjectedFromKeyContext's own docblock names this caller: "Callers
// must therefore intersect with the cited set (see handleStop) so a CITED Key Context row
// is credited while an uncited one is left alone."
//
// The miss was invisible on the machine it was written on: every keyctx marker is empty on
// an ADOPTED project. It would have landed on non-adopted ones — the default for a new
// install, and the configuration where that block is the most prominent surface there is.
describe('buildCitationRelevanceSet', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mem-relset-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const transcript = (entries) => {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return f;
  };

  it('includes a keyctx id — the case the first cut dropped', () => {
    const runtimeDir = join(dir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    // The marker filename is session-scoped too — write the name the extractor reads.
    writeFileSync(
      join(runtimeDir, keyContextIdsFileName('proj', 'sess-a')),
      JSON.stringify({ ids: [777], session: 'sess-a' }),
    );
    const set = buildCitationRelevanceSet({
      transcriptPath: transcript([]),
      runtimeDir,
      project: 'proj',
      sessionId: 'sess-a',
    });
    expect(set.has(777)).toBe(true);
  });

  it('includes a subagent id the caller hands in', () => {
    const set = buildCitationRelevanceSet({
      transcriptPath: transcript([]),
      subagentInjected: new Set([888]),
    });
    expect(set.has(888)).toBe(true);
  });

  it('includes an id the user typed, and excludes one only the assistant wrote', () => {
    const set = buildCitationRelevanceSet({
      transcriptPath: transcript([
        { type: 'user', message: { content: 'look at #111' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'and #222' }] } },
      ]),
    });
    expect(set.has(111)).toBe(true);
    expect(set.has(222)).toBe(false);
  });

  it('does not credit a keyctx marker written by a DIFFERENT session', () => {
    // The marker is session-gated; another window's render is not this session's evidence.
    const runtimeDir = join(dir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    // Same filename this session would read, but stamped by another window: exercises the
    // session field guard rather than just missing the file.
    writeFileSync(
      join(runtimeDir, keyContextIdsFileName('proj', 'sess-a')),
      JSON.stringify({ ids: [777], session: 'other-window' }),
    );
    const set = buildCitationRelevanceSet({
      transcriptPath: transcript([]),
      runtimeDir,
      project: 'proj',
      sessionId: 'sess-a',
    });
    expect(set.has(777)).toBe(false);
  });

  it('every face in CITATION_SURFACES has a source', () => {
    expect(assertRelevanceCoversAllFaces()).toBe(true);
    // The guard can say NO: drop either non-attachment face and it must throw by name.
    expect(() => assertRelevanceCoversAllFaces(CITATION_SURFACES.filter((f) => f !== 'keyctx'))).toThrow(
      /keyctx/,
    );
    expect(() => assertRelevanceCoversAllFaces(CITATION_SURFACES.filter((f) => f !== 'subagent'))).toThrow(
      /subagent/,
    );
  });
});

// D#179 prerequisite: split each cited id into "named while acting" and "named in
// prose only". The unit is one model RESPONSE (requestId), because a whole user-to-user
// exchange nearly always contains some tool call — bounding on user messages would
// classify everything as applied and measure nothing.
describe('classifyCitationContext (D#179)', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cite-ctx-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  function writeTranscript(entries) {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
    return path;
  }
  const say = (requestId, text) => ({
    type: 'assistant',
    requestId,
    message: { content: [{ type: 'text', text }] },
  });
  const act = (requestId) => ({
    type: 'assistant',
    requestId,
    message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
  });

  it('counts an id named in a response that also calls a tool as applied', () => {
    const ctx = classifyCitationContext(writeTranscript([say('r1', 'Applying #42 now.'), act('r1')]));
    expect(ctx.get(42)).toEqual({ withTool: 1, textOnly: 0 });
  });

  it('counts an id named in a prose-only response as text-only', () => {
    const ctx = classifyCitationContext(writeTranscript([say('r1', 'The release note discusses #42.')]));
    expect(ctx.get(42)).toEqual({ withTool: 0, textOnly: 1 });
  });

  it('does NOT let a tool call in a DIFFERENT response mark the mention as applied', () => {
    // The whole reason the unit is a requestId. Grouping by user turn (or by file)
    // would make one Edit anywhere mark every id in the session as acted on, and the
    // measurement would report ~0% contamination on any coding session.
    const ctx = classifyCitationContext(
      writeTranscript([
        say('r1', 'Release note: #42 was the lesson that closed it.'),
        say('r2', 'Now the unrelated change.'),
        act('r2'),
      ]),
    );
    expect(ctx.get(42)).toEqual({ withTool: 0, textOnly: 1 });
  });

  it('groups the blocks of one response even when split across entries', () => {
    const ctx = classifyCitationContext(writeTranscript([say('r1', 'Per #42.'), act('r1'), act('r1')]));
    expect(ctx.get(42)).toEqual({ withTool: 1, textOnly: 0 });
  });

  it('keys on message.id when requestId is absent — the shape production actually emits', () => {
    // The fallback chain is `requestId || message.id || uuid`. Real Claude Code entries
    // that lack a requestId still carry message.id, so THIS is the arm that runs in
    // production; the uuid arm below is the keyless last resort. The pre-tag review
    // caught the original of this case testing only the uuid arm and describing it as
    // "the fallback", i.e. validating a shape production never emits.
    const ctx = classifyCitationContext(
      writeTranscript([
        { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Discussing #42.' }] } },
        {
          type: 'assistant',
          message: { id: 'm2', content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
        },
      ]),
    );
    expect(ctx.get(42)).toEqual({ withTool: 0, textOnly: 1 });
  });

  it('falls back to uuid when there is no requestId and no message.id — never one giant bucket', () => {
    // Merging keyless entries would let a single tool call anywhere in the file mark
    // every id as applied.
    const ctx = classifyCitationContext(
      writeTranscript([
        { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'Discussing #42.' }] } },
        {
          type: 'assistant',
          uuid: 'u2',
          message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
        },
      ]),
    );
    expect(ctx.get(42)).toEqual({ withTool: 0, textOnly: 1 });
  });

  it('groups by message.id across split entries, not by position', () => {
    // The positive arm of the case above: two entries sharing one message.id ARE one
    // response, so the tool call marks the text's id applied.
    const ctx = classifyCitationContext(
      writeTranscript([
        { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Applying #42.' }] } },
        {
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
        },
      ]),
    );
    expect(ctx.get(42)).toEqual({ withTool: 1, textOnly: 0 });
  });

  it('ignores thinking blocks — it must classify the same numerator decay acts on', () => {
    const ctx = classifyCitationContext(
      writeTranscript([
        {
          type: 'assistant',
          requestId: 'r1',
          message: { content: [{ type: 'thinking', thinking: 'recall #42' }] },
        },
      ]),
    );
    expect(ctx.has(42)).toBe(false);
  });

  it('skips sidechain records by default and includes them when asked', () => {
    const entries = [
      {
        type: 'assistant',
        requestId: 'r1',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'Subagent used #42.' }] },
      },
    ];
    expect(classifyCitationContext(writeTranscript(entries)).has(42)).toBe(false);
    expect(classifyCitationContext(writeTranscript(entries), { mainOnly: false }).get(42)).toEqual({
      withTool: 0,
      textOnly: 1,
    });
  });
});
