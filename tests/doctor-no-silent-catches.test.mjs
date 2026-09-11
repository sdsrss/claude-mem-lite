// A doctor check that cannot RUN must still say so. Two of them did not (R12 audit P3-7):
// the Disk-footprint block ended in `catch { /* informational — never block doctor */ }`
// and the Plugin-cache block in a `catch {}` with no comment at all. When those threw, the
// line did not go red, did not go yellow — it disappeared, which on screen is
// indistinguishable from a check nobody ever wrote. Doctor already answers "I could not
// look" in four other places with its own sentence (`resolveBashHookCount`'s null, the DB
// schema fourth outcome, MCP registration, marketplace clone); these two were the exception.
//
// Two arms, because neither is sufficient alone:
//   - the source rule generalizes to catches nobody has thought about yet, including the
//     one whose import failure only reproduces on a genuinely broken install;
//   - the behavioural case proves the sentence actually reaches a screen, which a source
//     scan can never show.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETPLACE_KEY } from '../lib/plugin-key.mjs';

// dirname+join rather than new URL(): the URL form drops the target module out of knip's
// report entirely (tests/no-url-module-paths.test.mjs).
const REPO = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(REPO, '../install.mjs');
const SRC = readFileSync(INSTALLER, 'utf8');

const REPORTER = /(^|[^a-zA-Z_.])(ok|warn|dwarn|issueWarn|fail)\(/;

/**
 * Lines of `src` with the brace depth before and after each, comment-only and blank lines
 * removed. Dropping comments from the LINES (not just from the match test) is what stops
 * "delete the code, keep the comment" from walking past the scan — the repo has recorded
 * that exact failure once already.
 */
function codeLines(src) {
  let depth = 0;
  return src
    .split('\n')
    .map((text, i) => {
      const before = depth;
      const body = text.replace(/\/\/.*$/, '');
      depth += (body.match(/\{/g) || []).length - (body.match(/\}/g) || []).length;
      return { text, no: i + 1, before, after: depth };
    })
    .filter(({ text }) => text.trim() && !text.trim().startsWith('//') && !text.trim().startsWith('*'));
}

/**
 * try/catch pairs where the TRY block reports something and the CATCH block reports nothing.
 *
 * The condition is deliberately not "every catch must report". Plenty of catches here
 * legitimately swallow — `JSON.parse` of an optional manifest, a `du` that degrades to '?'
 * — and they are exactly the ones whose try block contains no reporter at all. The defect
 * shape is narrower: a block that is the ONLY place a given check speaks, wrapped in a
 * handler that says nothing, so the check silently ceases to exist.
 */
function silentCatches(src) {
  const lines = codeLines(src);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/(^|[^a-zA-Z_.])try\s*\{/.test(lines[i].text)) continue;
    const d = lines[i].before;
    // The matching `} catch` sits one level in; a nested try's catch sits deeper.
    let k = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].before < d) break;
      if (lines[j].before === d + 1 && /\}\s*catch\b/.test(lines[j].text)) {
        k = j;
        break;
      }
    }
    if (k === -1) continue;
    const tryBody = lines
      .slice(i, k)
      .map((l) => l.text)
      .join('\n');
    // An inline `catch {}` closes on its own line: nothing follows to read.
    let catchBody = lines[k].text;
    if (lines[k].after > d) {
      let m = k + 1;
      while (m < lines.length && lines[m].after > d) m++;
      catchBody = lines
        .slice(k, Math.min(m + 1, lines.length))
        .map((l) => l.text)
        .join('\n');
    }
    if (REPORTER.test(tryBody) && !REPORTER.test(catchBody)) {
      out.push(`${lines[k].no}: ${lines[i].text.trim().slice(0, 60)} … ${lines[k].text.trim().slice(0, 40)}`);
    }
  }
  return out;
}

function doctorBody() {
  const start = SRC.indexOf('const dwarn = (msg) =>');
  const end = SRC.indexOf('summary: buildDoctorSummary(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('doctor never loses a check to a silent catch', () => {
  it('every catch guarding a reporting block reports something itself', () => {
    const silent = silentCatches(doctorBody());
    expect(silent, `checks that can vanish without a trace:\n  ${silent.join('\n  ')}`).toEqual([]);
  });

  // Premise for the assertion above: the scan is looking at a body that actually contains
  // try/catch pairs of the shape under test. An empty haystack would pass it for free.
  it('the scan reaches the blocks it is scanning', () => {
    const body = doctorBody();
    expect(codeLines(body).filter((l) => /\}\s*catch\b/.test(l.text)).length).toBeGreaterThan(5);
  });

  it('the scan rejects a reporting block with an empty catch', () => {
    const src = ['  try {', "    ok('Disk footprint: fine');", '  } catch {}'].join('\n');
    expect(silentCatches(src)).toHaveLength(1);
  });

  // The counter-example shape taken from the real revert: the fix is a `dwarn` line, and
  // reverting it leaves the explanatory comment behind. A scan that filters comments only
  // when matching — not when building the block — stays green on exactly this.
  it('the scan rejects a catch holding only a comment', () => {
    const src = [
      '  try {',
      "    ok('Disk footprint: fine');",
      '  } catch {',
      '    /* informational — never block doctor */',
      '  }',
    ].join('\n');
    expect(silentCatches(src)).toHaveLength(1);
  });

  it('the scan accepts a catch that reports, and a silent catch around no reporter', () => {
    const reporting = [
      '  try {',
      "    ok('Disk footprint: fine');",
      '  } catch (e) {',
      "    dwarn('Disk footprint: check failed — ' + e.message);",
      '  }',
    ].join('\n');
    expect(silentCatches(reporting)).toHaveLength(0);
    // A helper that merely computes a value may swallow: the check around it still speaks.
    const helper = ['  try {', "    sizeStr = run('du');", '  } catch {', "    sizeStr = '?';", '  }'].join(
      '\n',
    );
    expect(silentCatches(helper)).toHaveLength(0);
  });
});

describe('doctor says so when it cannot read the plugin cache', () => {
  const homes = [];
  afterAll(() => {
    for (const h of homes.splice(0)) {
      try {
        rmSync(h, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  });

  it('an unreadable plugin cache produces a ⚠ naming the path', () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-silent-'));
    homes.push(home);
    const cacheParent = join(home, '.claude', 'plugins', 'cache', MARKETPLACE_KEY);
    mkdirSync(cacheParent, { recursive: true });
    // A FILE where doctor expects the version directory: `existsSync` says yes and
    // `readdirSync` throws ENOTDIR. Deterministic, and unlike `chmod 000` it still
    // reproduces when the suite runs as root.
    const cacheBase = join(cacheParent, 'claude-mem-lite');
    writeFileSync(cacheBase, 'not a directory');
    let out;
    try {
      out = execFileSync(process.execPath, [INSTALLER, 'doctor'], {
        env: {
          ...process.env,
          HOME: home,
          CLAUDE_MEM_DIR: join(home, 'data'),
          CLAUDE_MEM_SKIP_UPDATE: '1',
          MEM_QUIET_HOOKS: '1',
          MEM_NO_AUTO_ADOPT: '1',
        },
        encoding: 'utf8',
      });
    } catch (e) {
      out = e.stdout || '';
    }
    const line = out.split('\n').find((l) => l.includes('Plugin cache:'));
    expect(line, `doctor said nothing about an unreadable plugin cache:\n${out}`).toBeTruthy();
    expect(line).toContain('⚠');
    expect(line).toContain(cacheBase);
  });
});
