// A20260905-R5-P1-2: scripts/pre-commit.sh's version-sync check was broken at HEAD, and had
// been for as long as CLAUDE.md carried its release-guard sentence.
//
// The extractor was `grep -oP '(?<=\*\*Version\*\*: )\S+' CLAUDE.md` — unanchored, no -m1.
// CLAUDE.md contains that literal twice: once as the real value (`- **Version**: 3.96.1`) and
// once inside the sentence that DESCRIBES the guard (``**Version**: <v>` matching``). So the
// variable held two lines, the string comparison against package.json failed, and the script
// exited 1 printing `package.json=3.96.1 vs CLAUDE.md=3.96.1` — values that look identical
// because the second line falls off the end of the message.
//
// Everything below that check — eslint, format:check, the full vitest run — therefore never
// executed in any invocation. It went unnoticed because the script is not installed as a git
// hook and ci.yml only SHELLCHECKS it, never runs it.
//
// The pattern is read out of the script rather than re-typed: a copy here would keep this
// green through the exact kind of edit that broke it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// join(dirname(fileURLToPath(...))) rather than new URL(): the URL form drops the named file
// out of knip's report (CLAUDE.md invariant, guarded by tests/no-url-module-paths.test.mjs).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'pre-commit.sh');

/** The grep invocation the script actually uses, lifted from its own text. */
function extractorPattern() {
  const src = readFileSync(SCRIPT, 'utf8');
  const m = /^CLAUDE_VER=\$\(grep -oP '(.+)' CLAUDE\.md\)$/m.exec(src);
  if (!m) throw new Error('could not find the CLAUDE_VER grep line in scripts/pre-commit.sh');
  return m[1];
}

function runExtractor(pattern, file) {
  try {
    return execFileSync('grep', ['-oP', pattern, file], { encoding: 'utf8' });
  } catch (e) {
    // grep exits 1 on no match; return what it printed so the assertions can see "".
    return e.stdout?.toString() ?? '';
  }
}

describe('pre-commit version-sync extractor', () => {
  it('yields exactly one version from CLAUDE.md, not one per literal occurrence', () => {
    const out = runExtractor(extractorPattern(), join(REPO, 'CLAUDE.md'));
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(lines[0]).toBe(pkg.version);
  });

  it('CONTROL: the string it must not match is genuinely present in CLAUDE.md', () => {
    // Without this, the case above passes just as well against a CLAUDE.md that never had
    // the second occurrence — i.e. it would stop witnessing the defect the day someone
    // reworded the guard sentence, while the unanchored pattern stayed just as wrong.
    const md = readFileSync(join(REPO, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('**Version**: <v>');
    expect(md).toMatch(/^- \*\*Version\*\*: \d+\.\d+\.\d+/m);
  });

  it('the old unanchored pattern would have matched both — the defect is real, not hypothetical', () => {
    const out = runExtractor(String.raw`(?<=\*\*Version\*\*: )\S+`, join(REPO, 'CLAUDE.md'));
    expect(out.split('\n').filter(Boolean).length).toBeGreaterThan(1);
  });

  it('refuses to compare when CLAUDE.md yields no version at all', () => {
    // The NO arm of the guard the fix added. Drive the count check itself: a file with no
    // matching line must produce 0, which the script turns into a distinct error rather than
    // a bogus "version mismatch" that sends the reader to edit five in-sync files.
    const out = runExtractor(extractorPattern(), join(REPO, 'package.json'));
    expect(out.split('\n').filter(Boolean)).toHaveLength(0);
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/Could not read a single version from CLAUDE\.md/);
  });
});
