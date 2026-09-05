// D#213 (re-filed from D#212, itself re-filed from D#193) — the path-A exclude set is
// currently INERT against string ids, and this file pins that so the state cannot change
// by accident.
//
// This is an unusual test: it asserts a defect. The reason is that repairing it is a
// behaviour change nobody has measured, so the dangerous outcome is not "the bug stays",
// it is "someone normalises a type in passing and up to 9% of one injection face
// disappears without anyone deciding to". (An earlier version of this line said 18%,
// carried over from the mirror-image population corrected 20 lines below — the wrong
// number outlived the paragraph that retracted it, in the same file.)
//
// THE MECHANISM, verified below rather than described:
//   - `user-prompt-search.js` writes plain numbers into the shared marker;
//   - `mergeCrossHookInjected` (pre-tool-recall.js) `.map(String)`s the whole union, so
//     once PreToolUse has emitted one row in the window every id in the file is a string;
//   - `hook.mjs` pushes them into `pathAInjectedIds` as-is;
//   - `searchRelevantMemories` and `rankImperativeCandidates` both test
//     `new Set(excludeIds).has(r.id)` against a NUMBER out of SQLite.
// A Set keyed by '42' does not contain 42, so the exclude drops nothing.
//
// THE MEASUREMENT that says why it is not simply fixed (2026-09-02T12:12Z, 99 real
// transcripts, one walk, through the shipped `extractInjectedBySurface`), stated as an
// UPPER bound because it is session-level and ignores the marker's stale window.
//
// The population is `ups ∩ (fyi ∪ pretool)`: the marker is WRITTEN by
// `user-prompt-search.js` (the `fyi` face) and `pre-tool-recall.js` (`pretool`), and READ
// in `hook.mjs handleUserPrompt`, which is the `ups` face. A first version of this header
// measured the mirror image and published 18.0% — the figure for a mechanism that is not
// this one; the pre-tag review caught it, and the wrong number reproduces exactly, which
// is what identifies it as a caliber error rather than corpus drift.
//
//   ups              23 of 256 (session, id) pairs — 9.0% — over 14 of 71 sessions
//   task_imperative   3 of  24 (12.5%) over 3 of 23
//   (by attachments rather than pairs: 29 of 332, 8.7%)
//
// Direction unknown — the freed slot is sometimes refilled and sometimes lost — and this
// path already has a WORKING suppressor in `shouldSkipByDedup`, which String-normalises
// both sides and skips the whole injection at >=0.8 overlap. Repairing this one adds a
// second suppressor to an already-suppressed face, which needs an A/B.
//
// THE RULER NOW EXISTS — `lib/patha-exclude-meter.mjs`, wired into the same read in
// `hook.mjs handleUserPrompt` and off unless `CLAUDE_MEM_METRICS=1`. It does NOT persist
// the marker for a later replay (the route the ledger leaned toward, and one this repo has
// a standing rule against: never diff two runs taken at different times). It runs both
// arms at the read, one database state, and records `suppressed` / `refilled` / `net` per
// prompt. So the missing input is now a matter of elapsed time rather than of method.
//
// WHEN THE TIME COMES: delete this file in the same commit that coerces the ids, and put
// the meter's own numbers in the commit message. A green suite after a silent coercion is
// the failure this file exists to prevent.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { searchRelevantMemories } from '../hook-memory.mjs';
import { countInjectedBySurface } from '../lib/citation-tracker.mjs';
import { mergeInjectedMarker, readInjectedMarker } from '../lib/injected-ids.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('D#193 — the path-A exclude is inert against string ids (pinned, not endorsed)', () => {
  it('a NUMBER exclude suppresses the row and a STRING exclude does not', () => {
    // The behavioural half. Run against the real function, so this cannot drift from a
    // description of it. If both arms ever agree, the exclude has been repaired — which
    // is a decision, and it needs the A/B named in the header.
    const db = createTestDb();
    insertSession(db, { id: 's1', project: 'p1' });
    const inserted = insertObs(db, {
      sessionId: 's1', project: 'p1', type: 'bugfix', importance: 3,
      title: 'sqlite fts5 rowid match trap',
      narrative: 'the rowid constraint is silently dropped by fts5 match',
      text: 'sqlite fts5 rowid match constraint dropped silently',
      lessonLearned: 'never trust a membership test that can be always-true',
    });
    const numericId = Number(inserted.lastInsertRowid);
    const q = 'sqlite fts5 rowid match trap';

    const none = searchRelevantMemories(db, q, 'p1', []);
    expect(none.some((r) => r.id === numericId), 'premise: the row is findable at all').toBe(true);

    const excludedByNumber = searchRelevantMemories(db, q, 'p1', [numericId]);
    expect(excludedByNumber.some((r) => r.id === numericId), 'a numeric exclude must work').toBe(false);

    const excludedByString = searchRelevantMemories(db, q, 'p1', [String(numericId)]);
    expect(
      excludedByString.some((r) => r.id === numericId),
      'a STRING exclude is currently a no-op — if this is now false the exclude was repaired',
    ).toBe(true);
    db.close();
  });

  it('the writer still stringifies, and the reader still does not coerce', () => {
    // The two halves that produce the string ids, asserted separately from the end-to-end
    // behaviour because either one alone changing is enough to flip it, and a
    // behaviour-only test would not say which side moved.
    //
    // This used to grep `mergeCrossHookInjected`'s BODY for `.map(String)`. When the
    // union/replace rule moved into lib/injected-ids.mjs (audit 2026-09-02 P1-2) the
    // behaviour was byte-identical and this case still went red — a source-text anchor
    // reports a refactor as a regression and, worse, would report a real coercion added in
    // the lib as no change at all. Driving the shipped functions instead survives both.
    const dir = mkdtempSync(join(tmpdir(), 'd193-marker-'));
    const file = join(dir, 'marker.json');

    // union: what pre-tool-recall.js does. Numbers in, STRINGS on disk.
    mergeInjectedMarker(file, [41, 42], { sessionId: 's1', maxAgeMs: 60000, mode: 'union' });
    const unioned = JSON.parse(readFileSync(file, 'utf8')).ids;
    expect(unioned, 'the union arm no longer stringifies').toEqual(['41', '42']);

    // replace: what user-prompt-search.js's main leg does. Numbers in, NUMBERS on disk —
    // this is the leg that lets a raw number into the marker at all.
    mergeInjectedMarker(file, [43, 'P44'], { sessionId: 's1', maxAgeMs: 60000, mode: 'replace' });
    const replaced = JSON.parse(readFileSync(file, 'utf8')).ids;
    expect(replaced, 'the replace arm must write ids verbatim').toEqual([43, 'P44']);

    // the reader hands them back untouched — no Number(), no String().
    const back = readInjectedMarker(file, { sessionId: 's1', maxAgeMs: 60000 });
    expect(back.ids, 'readInjectedMarker coerced something').toEqual([43, 'P44']);
    rmSync(dir, { recursive: true, force: true });

    // hook.mjs's own half stays a source assertion: there is no seam to drive here, the
    // ids go straight from the reader into the exclude array.
    const hook = readFileSync(join(REPO, 'hook.mjs'), 'utf8');
    // Statement sequence, not one-line layout: a formatter expands this loop body over
    // four lines and the pinned property — both pushes, in this order — is unchanged (P1-3).
    const push = /for \(const id of ids\)\s*\{\s*keyContextIds\.push\(id\);\s*pathAInjectedIds\.push\(id\);\s*\}/;
    expect(hook, 'hook.mjs no longer pushes marker ids verbatim — was the coercion added?')
      .toMatch(push);
  });

  it('countInjectedBySurface counts ATTACHMENTS, not occurrences within one', () => {
    // The primitive the header's numbers came from, and the one the re-filed D#212 ruler
    // will need. The distinction is the whole point: a single injected block listing #42
    // twice is ONE injection of #42, and a working exclude would not have suppressed it.
    // Counting occurrences instead would inflate the redundancy figure with formatting.
    const dir = mkdtempSync(join(tmpdir(), 'd193-count-'));
    const file = join(dir, 'transcript.jsonl');
    const block = (lines) => JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        command: 'pre-tool-recall.js',
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: lines } }),
      },
    });
    // Attachment 1 names #42 twice; attachment 2 names it once. Occurrences = 3,
    // attachments = 2, and 2 is the number that matters.
    writeFileSync(file, [
      block('[mem] Lessons for a.mjs:\n  #42 [bugfix] first\n  #42 [bugfix] first again\n  #43 [bugfix] other'),
      block('[mem] Lessons for b.mjs:\n  #42 [bugfix] first'),
    ].join('\n'));

    const counts = countInjectedBySurface(file).pretool;
    expect(counts.get(42), '#42 appeared in two attachments').toBe(2);
    expect(counts.get(43), '#43 appeared in one').toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the early return on empty newIds is real, so the trigger is "emitted once", not "always"', () => {
    // The ledger's reachability argument leaned on a comment that claimed the marker is
    // always rewritten. It is not, and the corrected comment now says so; this pins the
    // guard the correction describes.
    const ptr = readFileSync(join(REPO, 'scripts', 'pre-tool-recall.js'), 'utf8');
    const merge = ptr.slice(ptr.indexOf('function mergeCrossHookInjected'));
    const body = merge.slice(0, merge.indexOf('\n}\n') + 1);
    expect(body).toMatch(/if \(!newIds \|\| newIds\.length === 0\) return;/);
  });
});
