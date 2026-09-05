// task_imperative as a METERED face (v3.76).
//
// The imperative line — `Memory — a past lesson applies to THIS task. You must: … (#NN)`
// — has been a live injection since v3.23 and was never counted. It rides the SAME
// attachment as the `<memory-context>` block (both are stdout writes from one
// `hook.mjs user-prompt` invocation), which is why it could hide: the `ups` matcher
// gates on `<memory-context` and collects only `- [` rows, so the imperative row was
// walked past on every Stop. With no row in citation_surface_log, D#137-shaped questions
// ("is the imperative framing earning its budget?") could only be answered by offline
// replay, and D#150/D#151 are blocked on the same missing denominator.
//
// The two faces overlap by construction — one attachment, two rows — which is the
// documented per-face VIEW semantics, not a partition. What must NOT happen is
// cross-contamination: neither face may collect the other's ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import {
  extractInjectedBySurface,
  extractAllInjected,
  recordCitationSurfaces,
  computeSurfaceFunnel,
  CITATION_SURFACES,
  DECAY_DENOMINATOR_SURFACES,
} from '../lib/citation-tracker.mjs';
import { formatTaskImperative } from '../lib/task-imperative.mjs';

// The real emitter's shape: handleUserPrompt writes the block and then the imperative
// line to the same stdout, so ONE attachment carries both. Built through the real
// formatter so a change to the framing breaks this test instead of silently unmetering
// the face — the drift that let this surface go uncounted for a whole major line.
const bothInOne = (blockId, imperativeId, lesson = 'stamp the guard on both dedup channels') => ({
  type: 'attachment',
  attachment: {
    type: 'hook_success',
    command: 'node "/home/sds/.claude-mem-lite/hook.mjs" user-prompt',
    stdout:
      `<memory-context relevance="high">\n- [decision] picked X | Lesson: Y (#${blockId})\n</memory-context>\n` +
      `${formatTaskImperative(lesson, imperativeId)}\n`,
  },
});

describe('task_imperative surface', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cite-imp-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  });

  const writeTranscript = (entries) => {
    const path = join(tmp, 'transcript.jsonl');
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
    return path;
  };

  it('is a member of the recordable enum', () => {
    // recordCitationSurfaces DROPS unknown labels silently, so a matcher without an
    // enum entry extracts ids that never reach a row — unmetered in a way that reads
    // as "this face injects nothing".
    expect(CITATION_SURFACES).toContain('task_imperative');
  });

  it('splits one attachment into both faces without either taking the other id', () => {
    const path = writeTranscript([bothInOne(202, 909)]);
    const s = extractInjectedBySurface(path);
    expect([...s.ups]).toEqual([202]);
    expect([...s.task_imperative]).toEqual([909]);
  });

  it('takes the trailing id, not one quoted inside the lesson body', () => {
    // Lessons routinely cross-reference other observations; the emitter puts THIS
    // lesson's id in trailing parens. Collecting every (#NN) on the line would credit
    // the face with injections it never made.
    const path = writeTranscript([
      bothInOne(202, 909, 'follow the chain from (#7) rather than re-deriving it'),
    ]);
    expect([...extractInjectedBySurface(path).task_imperative]).toEqual([909]);
  });

  it('ignores an imperative-shaped line under a different hook command', () => {
    // Same prose, wrong origin: a transcript can quote the framing (this very test file
    // does). Only the UserPromptSubmit hook's own attachment counts as an injection.
    const path = writeTranscript([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          command: 'node "/home/sds/.claude-mem-lite/scripts/user-prompt-search.js"',
          stdout: `${formatTaskImperative('quoted, not injected', 909)}\n`,
        },
      },
    ]);
    expect(extractInjectedBySurface(path).task_imperative.size).toBe(0);
  });

  it('honors mainOnly', () => {
    const path = writeTranscript([{ ...bothInOne(202, 909), isSidechain: true }]);
    expect([...extractInjectedBySurface(path).task_imperative]).toEqual([909]);
    expect(extractInjectedBySurface(path, { mainOnly: true }).task_imperative.size).toBe(0);
  });

  // v3.76 metered this face and deliberately kept it OUT of the decay denominator until
  // someone read its rate. The rate was read on 2026-08-25 over the live 1113-transcript
  // corpus — 44.1% (15/34), against pretool 38.3%, fyi 10.9%, ups 8.4%, error_recall 6.2%
  // — so the stated exclusion condition ("if the imperative framing under-performs") is
  // not met, and the face was admitted. This case is the behavioural half of that flip:
  // the id reached only by the imperative row must now appear in the union the decay loop
  // consumes, not merely in its own funnel row.
  it('enters the decay denominator alongside the block it rides with', () => {
    const path = writeTranscript([bothInOne(202, 909)]);
    expect([...extractInjectedBySurface(path).task_imperative]).toEqual([909]);
    // 202 comes from the <memory-context> block, 909 from the imperative row: one
    // attachment, two faces, and after the flip BOTH reach applyCitationDecay.
    expect([...extractAllInjected(path)].sort((a, b) => a - b)).toEqual([202, 909]);
  });

  // The v45 union widens automatically so a new face cannot be forgotten;
  // DECAY_EXCLUDED_SURFACES is the escape hatch out of it. With the hatch now empty, a
  // guard phrased as "every face is in the denominator OR in the exclusion list" would be
  // true by construction — DENOMINATOR is literally ATTACHMENT minus EXCLUDED — i.e. a
  // test that cannot fail. So this pins the DECISION instead of the derivation: every
  // attachment face feeds decay, and re-excluding one has to be an edit to this line.
  // DO NOT WEAKEN OR DELETE the toEqual below. With the exclusion set empty, the
  // denominator and the attachment list are element-identical, so NO behavioural test can
  // tell them apart any more — this line is the only guard in the suite against a WRONG
  // widening. Verified by mutation in the v3.81.0 pre-tag review: unioning `keyctx` into
  // the denominator (the exact v3.66.0 incident, where "the block ate its own contents")
  // turns this case red and nothing else in 163 tests. It pins ORDER as well as membership,
  // and that is deliberate: a denominator hardcoded to the correct faces in a different
  // order is caught by nothing else. A legitimate reorder of SURFACE_MATCHERS moves both
  // sides together — `faces` derives from the same Object.keys — so the pin is not brittle.
  it('feeds every attachment face into the decay denominator (the exclusion set is empty)', () => {
    const path = writeTranscript([bothInOne(202, 909)]);
    const faces = Object.keys(extractInjectedBySurface(path));
    expect(DECAY_DENOMINATOR_SURFACES).toEqual(faces);
    expect(DECAY_DENOMINATOR_SURFACES).toContain('task_imperative');
  });

  it('records and reads back as its own row in the funnel', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-imp', project: 'p1' });
    const mk = (title) =>
      Number(
        insertObs(db, {
          sessionId: 'sess-imp',
          project: 'p1',
          type: 'bugfix',
          title,
          importance: 2,
        }).lastInsertRowid,
      );
    const imperativeId = mk('imperative pick');
    const blockId = mk('block pick');

    recordCitationSurfaces(
      db,
      'p1',
      'cc-sess-1',
      {
        ups: new Set([blockId]),
        task_imperative: new Set([imperativeId]),
      },
      new Set([imperativeId]),
    );

    const faces = Object.fromEntries(
      computeSurfaceFunnel(db, { days: 7, project: 'p1' }).surfaces.map((s) => [s.surface, s]),
    );
    expect(faces.task_imperative).toMatchObject({ injected: 1, cited: 1 });
    expect(faces.ups).toMatchObject({ injected: 1, cited: 0 });
    db.close();
  });
});
