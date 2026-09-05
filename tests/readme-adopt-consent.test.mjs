// SPEC-1 (2026-08-29 audit): the install docs described an auto-adopt that stopped
// existing in v3.13.
//
// Both READMEs said the plugin "writes the invited-memory sentinel into the project's
// memdir" on "the first SessionStart". It writes a managed block into the project's own
// `<cwd>/CLAUDE.md` — a file that normally goes into git — plus
// `<cwd>/.claude/plugin_claude_mem_lite.md`, and it does so on EVERY SessionStart. Of all
// the sentences in an install guide, the one saying which of the user's files get written
// is the one that has to be right.
//
// The audit named two sites. A sweep found eight (the claim is repeated in each README's
// install blockquote, its Invited Memory section, and two env-table rows), which is why
// this guard scans whole files rather than the two paragraphs that were reported.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const EN = read('../README.md');
const ZH = read('../README.zh-CN.md');
const ADOPT_CLI = read('../adopt-cli.mjs');
const CLAUDEMD = read('../claudemd.mjs');

describe('README auto-adopt description matches silentAutoAdopt', () => {
  it('the implementation still writes CLAUDE.md on every session, not a memdir sentinel once', () => {
    // Assert the premise before asserting the docs against it. If the code moved back to
    // a memdir sentinel, the docs below would be wrong in the other direction and this
    // suite would otherwise keep passing.
    expect(ADOPT_CLI).toMatch(/export function silentAutoAdopt/);
    expect(ADOPT_CLI, 'silentAutoAdopt must go through the CLAUDE.md writer').toMatch(/writeManaged\(cwd,/);
    expect(CLAUDEMD, 'writeManaged must target <cwd>/CLAUDE.md').toMatch(/claudeMdPath\(cwd\)/);
    expect(CLAUDEMD, 'and the detail doc, under the project .claude dir').toMatch(/join\(cwd, '\.claude'\)/);
    // Idempotent re-sync rather than a one-shot: the "already-adopted" / "refreshed"
    // branches are what make "every SessionStart" true.
    expect(ADOPT_CLI).toMatch(/already-adopted/);
    expect(ADOPT_CLI).toMatch(/refreshed/);
  });

  for (const [name, src, claudeMd, cadence] of [
    ['README.md', () => EN, /<cwd>\/`?\*?\*?CLAUDE\.md/, /every\s+SessionStart/i],
    ['README.zh-CN.md', () => ZH, /<cwd>\/`?\*?\*?CLAUDE\.md/, /每次\s*SessionStart/],
  ]) {
    it(`${name} names the real write target and the real cadence`, () => {
      const text = src();
      expect(text, `${name} must say auto-adopt writes <cwd>/CLAUDE.md`).toMatch(claudeMd);
      expect(text, `${name} must say the sync runs on every SessionStart`).toMatch(cadence);
    });

    it(`${name} no longer claims auto-adopt fires only on the first SessionStart`, () => {
      // Exact strings, not a fuzzy match: these are the phrasings that shipped.
      for (const stale of ['first SessionStart', 'first-SessionStart', '首次 SessionStart']) {
        expect(src(), `${name} still contains "${stale}"`).not.toContain(stale);
      }
    });
  }

  it('the stale-phrase check can say NO', () => {
    // Anti-vacuity: `not.toContain` passes trivially on text that never had the phrase.
    // Feed it the sentence that actually shipped and require a match.
    const shipped =
      '**Auto-adopt fires on the first SessionStart per project (v2.82.1+).**' +
      " The plugin automatically writes the **invited-memory sentinel** into the project's memdir";
    expect(shipped).toContain('first SessionStart');
    expect(shipped).not.toMatch(/every\s+SessionStart/i);
  });
});
