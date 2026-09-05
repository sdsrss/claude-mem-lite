// D#202 — the `[mem] Lessons for <file>:` block mixes two TABLES and rendered
// both as a bare `#NN`.
//
// Measured on the maintainer's metrics log before the fix (4227 `pretool_recall`
// firings, 2026-07-18 -> 2026-09-02): 2376 of 5291 injected rows — 44.9% — came
// from `events`, and 40.2% of firings injected events only. So this is nearly
// half the channel, not a corner.
//
// Two consequences, and only the second is closed here:
//
//  1. A reader cannot tell which table an id belongs to. That is how it was
//     found: `save --supersedes 10524` on an id read out of this block did
//     nothing, because 10524 is an `events` row. The silence there is D#201,
//     already fixed; the ambiguity that produced the wrong id is this.
//
//  2. Worse, and structural: `extractInjectedFromPreToolUse` reads ids off this
//     block into the citation-decay DENOMINATOR, and applyCitationDecay resolves
//     them against `observations` alone (`WHERE id = ? AND project = ?`). An
//     event id that happens to match a live same-project observation therefore
//     streaks or promotes a completely unrelated memory. Measured: of 5476
//     injectable events, 1406 (25.7%) share an id with a live observation, and
//     198 (3.6%) with one in the SAME project — the same-project condition is
//     the one that matters, because it is in the decay SELECT.
//
// The fix is entirely in the renderer, and it is not a new convention: the `E#`
// prefix already existed in lib/events-injection.mjs, whose header even
// enumerates the extractors it protects — FYI, memory-context, error-recall —
// and does not name pre-tool-recall.js, the one face that was breaking it. So
// this was an invariant asserted in one file about faces living in others, with
// the offending face simply never enumerated (#10379's shape).
//
// `INJECTED_ROW_RE` anchors `#` after at most six spaces, so an `E#` row cannot
// match it and the ids drop out of the injected set by construction — no second
// list to keep in sync. That is load-bearing rather than incidental, so both
// halves are pinned below: the prefix on both render paths, and that `event`
// must never join the extractor's bounded type list.
//
// NOT closed: `bumpCitationAccess` credits access_count for a cited `#NN`, and the
// `boost` maintain op turns enough of those into an importance bump (obs #10911,
// D#206), so the same same-project collision still misattributes there. Note the
// gate this does NOT lack: since v3.84.0 the credit requires the id to have been
// injected this session (or typed by the user), so "without asking whether it was
// injected at all" — how this comment first read — is wrong. What it does not ask is
// whether the lesson was ACTED on. Different mechanism from the prefix, different fix.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// D#194, hit live while writing this file: knip drops a module out of its
// unused-export report entirely once ANY analysed file names it in
// `new URL('../X.mjs', import.meta.url)`. The first draft read its three source
// files that way, and a same-tree A/B showed the cost precisely —
// `lib/citation-tracker.mjs:extractInjectedFromSubagentPrompt` disappeared from
// the knip name set, i.e. this test file alone blinded knip to that whole
// module. Building the path with join() instead keeps the source-scan asserts
// and leaves knip's coverage intact. Verified by re-running the same A/B: the
// name comes back.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
import { extractInjectedFromPreToolUse } from '../lib/citation-tracker.mjs';
import { EVENT_ID_PREFIX } from '../lib/injected-ids.mjs';

// Same attachment shape the production hook writes (mirrors the fixture in
// tests/citation-decay.test.mjs). The positive case below is what proves the
// fixture can say YES at all — without it the three negative assertions would
// be satisfied by a fixture the extractor simply cannot read.
function writeTranscript(text) {
  const dir = mkdtempSync(join(tmpdir(), 'd202-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: 'user',
        message: { content: [] },
        toolUseResult: {},
        attachments: undefined,
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          hookName: 'PreToolUse:Edit',
          command: 'node /home/u/.claude-mem-lite/scripts/pre-tool-recall.js',
          stdout: JSON.stringify({
            suppressOutput: true,
            hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
          }),
          stderr: '',
          exitCode: 0,
        },
      }),
    ].join('\n'),
  );
  return path;
}

describe('D#202 — event-sourced rows are namespaced in the lessons block', () => {
  it('an observation row still enters the injected denominator', () => {
    const path = writeTranscript(
      '[mem] Lessons for lib/x.mjs:\n  #4242 [bugfix] a real observation lesson\n',
    );
    expect([...extractInjectedFromPreToolUse(path)]).toEqual([4242]);
  });

  it('an E#-prefixed event row does NOT enter the observation injected denominator', () => {
    const path = writeTranscript(
      `[mem] Lessons for lib/x.mjs:\n  ${EVENT_ID_PREFIX}4242 [bugfix] an event body\n`,
    );
    expect([...extractInjectedFromPreToolUse(path)]).toEqual([]);
  });

  it('a mixed block keeps only the observation id', () => {
    const path = writeTranscript(
      '[mem] Lessons for lib/x.mjs:\n' +
        `  ${EVENT_ID_PREFIX}100 [decision] event-sourced\n` +
        '  #200 [discovery] observation-sourced\n' +
        `  ${EVENT_ID_PREFIX}300 [change] event-sourced\n`,
    );
    expect([...extractInjectedFromPreToolUse(path)]).toEqual([200]);
  });

  // The renderer is a hook SCRIPT, not an importable function, so this reads its
  // source. Weaker than executing it, and said so rather than dressed up: what it
  // can catch is the prefix being dropped from one of the two render paths, which
  // is the realistic regression.
  it('pre-tool-recall.js prefixes event rows on BOTH render paths', () => {
    const src = readFileSync(join(REPO, 'scripts/pre-tool-recall.js'), 'utf8');
    expect(src, 'the id tag is not derived from r.src').toMatch(
      /const idTag = `\$\{r\.src === 'evt' \? EVENT_ID_PREFIX : '#'\}\$\{r\.id\}`/,
    );
    // Two render sites — the lesson_learned branch and the title fallback. A fix
    // applied to one of them is the exact shape this repo keeps paying for.
    const tagged = [...src.matchAll(/\$\{idTag\} \[\$\{r\.type\}\]/g)].length;
    expect(tagged, 'both lesson and title render paths must use idTag').toBe(2);
    // No render site may still emit the bare form.
    expect(src, 'a bare-# render site survives').not.toMatch(/#\$\{r\.id\} \[\$\{r\.type\}\]/);
  });

  // CROSS-FACE SWEEP. The `E#` convention already existed in
  // lib/events-injection.mjs, whose header even enumerates the extractors it
  // protects — and does not name pre-tool-recall.js, the face that was breaking
  // it. One shared constant, and a check that no face re-invents the literal.
  it('SWEEP: every event renderer takes the prefix from the shared constant', () => {
    const faces = ['lib/events-injection.mjs', 'scripts/pre-tool-recall.js'];
    const problems = [];
    for (const face of faces) {
      const src = readFileSync(join(REPO, face), 'utf8');
      // Count USES, not occurrences: `src.includes(...)` matched the import statement,
      // so dropping the prefix from the renderer while leaving the import in place kept
      // this case GREEN (mutation-verified in the v3.88.0 pre-tag review, N1). The
      // sibling behavioural case caught it, but a sweep that cannot see its own subject
      // is worse than no sweep. Strip the import lines first, then require a use.
      const body = src.replace(/^\s*import\s[^;]*;$/gm, '');
      if (!body.includes('EVENT_ID_PREFIX')) {
        problems.push(`${face}: imports EVENT_ID_PREFIX but never renders with it`);
      }
      // A hard-coded 'E#' inside a template literal is the drift this prevents.
      // (Prose mentions of E# in comments are fine; a rendered one is not.)
      if (/`[^`]*E#\$\{/.test(src)) problems.push(`${face}: hard-codes 'E#' in a rendered string`);
    }
    expect(problems).toEqual([]);
  });

  it("GUARD: 'event' must never join INJECTED_ROW_RE's type list", () => {
    // A second, independent way the separation could be undone: even with the
    // E# prefix in place, widening the extractor's bounded type list is how a
    // future `[event]` row would re-enter the denominator. Nothing else is red
    // if that happens.
    const src = readFileSync(join(REPO, 'lib/citation-tracker.mjs'), 'utf8');
    // `\s*` after `new RegExp(`: a formatter moves the template literal onto its own
    // line. The captured type list — what this guard reads — is unaffected (P1-3).
    const m =
      /const INJECTED_RE = new RegExp\(\s*`#\(\$\{OBS_ID_DIGITS\}\)\\\\s\+\\\\\[\(([^)]*)\)\\\\\]`/.exec(src);
    expect(m, 'INJECTED_RE shape changed — re-derive this guard').toBeTruthy();
    const types = m[1].split('|');
    expect(types).not.toContain('event');
    expect(types).toContain('bugfix'); // the list is real, not an empty match
  });
});
