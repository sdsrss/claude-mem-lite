// D#98: no shipped text asks the agent to report lessons that did NOT apply.
//
// `'#NN n/a — <reason>'` was the adoption contract's second half. Citation decay drops
// dismissal-only ids (lib/citation-tracker.mjs isDismissalAt), so a dismissal earns the
// lesson nothing, and the ask put lesson-id lists into the user's reply. The default
// PreToolUse directive, the CLAUDE.md managed row and the detail doc now ask for `#NN` only
// where a lesson changed what the agent did.
//
// Population: every shipped .mjs/.js (walkShipped, whole-line comments stripped, so prose
// that QUOTES the old form does not trip it) plus every shipped Markdown file named in
// package.json#files. The two opt-in directives in scripts/pre-tool-recall.js keep the old
// shape on purpose (CLAUDE_MEM_SALIENCE=verdict / =bind): a user who selected them asked
// for per-lesson verdicts.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO, walkShipped, relShipped, sourceWithoutComments } from './shipped-tree.mjs';
import { buildClaudeMdBlock, getDetailDoc } from '../adopt-content.mjs';

// The per-lesson verdict ask, in any spelling found so far: the `n/a — <reason>` template
// (either language), and an `applied` / `n/a` pairing (`#NN applied` or `#NN n/a`, 或).
const DISMISSAL_ASK = /n\/a — <|#NN:? applied\W{0,3}\s*(?:or|或)\s*\W{0,3}#NN:? n\/a/i;

// Allowed only INSIDE the bodies of the two opt-in constants — keyed on which declaration a
// line belongs to, not on what the line looks like, so reverting ACK_DIRECTIVE's body to the
// old verdict string is caught here too (pre-ship review P3-2).
const OPT_IN_CONSTANTS = ['VERDICT_DIRECTIVE', 'BIND_DIRECTIVE'];
function optInBodyLines(text) {
  const lines = text.split('\n');
  const inBody = new Set();
  lines.forEach((line, i) => {
    const m = line.match(/^\s*const ([A-Z_]+) =/);
    if (!m || !OPT_IN_CONSTANTS.includes(m[1])) return;
    for (let j = i; j < lines.length; j++) {
      inBody.add(j);
      if (/;\s*$/.test(lines[j])) break;
    }
  });
  return inBody;
}

function offending(rel, text) {
  const allowed = rel === 'scripts/pre-tool-recall.js' ? optInBodyLines(text) : new Set();
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (!DISMISSAL_ASK.test(line) || allowed.has(i)) return;
    hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

describe('D#98 — no shipped text asks for #NN dismissals', () => {
  it('shipped modules (comments stripped)', () => {
    const files = walkShipped();
    expect(files.length).toBeGreaterThan(50); // premise: the walk reached the tree
    const hits = files.flatMap((f) => offending(relShipped(f), sourceWithoutComments(f)));
    expect(hits).toEqual([]);
  });

  it('shipped Markdown', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const mds = pkg.files.filter((f) => f.endsWith('.md') && existsSync(join(REPO, f)));
    expect(mds.length).toBeGreaterThan(3);
    const hits = mds.flatMap((f) => offending(f, readFileSync(join(REPO, f), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the rendered adoption block and detail doc ask for applied lessons only', () => {
    const block = buildClaudeMdBlock();
    const doc = getDetailDoc();
    // §9-C (2026-09-29) reworded the ask to a bare `(#NN)` tag; still applied lessons only.
    expect(block).toMatch(/lesson changed what you did, add the bare tag `\(#NN\)` once/);
    expect(doc).toContain('没用上的 lesson 不必提');
    for (const t of [block, doc]) expect(t).not.toMatch(DISMISSAL_ASK);
  });

  it('the allowlist still matches the opt-in directives (a stale allowlist is a blind guard)', () => {
    const src = sourceWithoutComments(join(REPO, 'scripts/pre-tool-recall.js'));
    const allowedLines = src.split('\n').filter((l) => DISMISSAL_ASK.test(l));
    expect(allowedLines.length).toBeGreaterThanOrEqual(2); // VERDICT + BIND bodies
    expect(optInBodyLines(src).size).toBeGreaterThanOrEqual(4); // both declarations found
    expect(offending('scripts/pre-tool-recall.js', src)).toEqual([]);
  });

  it('the pattern catches both spellings of the ask (pre-ship review P3-3)', () => {
    for (const t of [
      "state '#NN applied' or '#NN n/a — <reason>'",
      'answer each with `#NN applied` or `#NN n/a`',
      '（`#NN applied` 或 `#NN n/a`）',
    ])
      expect(DISMISSAL_ASK.test(t), t).toBe(true);
    // Saying a dismissal need not be written is not asking for one.
    expect(DISMISSAL_ASK.test('写成 `#NN n/a` 的驳回不算采纳')).toBe(false);
  });
});
