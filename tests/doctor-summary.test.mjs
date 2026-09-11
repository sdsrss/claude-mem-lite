// Tests for buildDoctorSummary — locks in the 4-way contract so the
// pre-fix bug ("All checks passed!" while ⚠ warnings rendered) cannot
// regress: warnings count separately from issues, and the summary line
// always reflects both.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildDoctorSummary } from '../install.mjs';

describe('buildDoctorSummary', () => {
  it('returns "All checks passed!" only when both counters are 0', () => {
    expect(buildDoctorSummary(0, 0)).toBe('All checks passed!');
  });

  it('does NOT claim all-passed when warnings are present', () => {
    const out = buildDoctorSummary(0, 2);
    expect(out).not.toContain('All checks passed!');
    expect(out).toContain('All critical checks passed');
    expect(out).toContain('2 warnings');
  });

  it('uses singular "warning" for warnings === 1', () => {
    expect(buildDoctorSummary(0, 1)).toContain('1 warning)');
    expect(buildDoctorSummary(0, 1)).not.toContain('1 warnings');
  });

  it('reports issues without warnings cleanly', () => {
    expect(buildDoctorSummary(3, 0)).toBe('3 issue(s) found.');
  });

  it('appends warning suffix when both issues and warnings present', () => {
    const out = buildDoctorSummary(2, 4);
    expect(out).toContain('2 issue(s) found.');
    expect(out).toContain('+4 warnings');
  });

  it('singular warning suffix when warnings === 1 alongside issues', () => {
    expect(buildDoctorSummary(1, 1)).toContain('+1 warning)');
  });
});

// The pure function above has been right the whole time. What was wrong was that one
// finding never reached it: the doctor body has TWO reporters, `warn` (prints ⚠, counts
// nothing) and `dwarn` (counts, then prints), and the stale-process check called the
// bare one — so a run whose only finding was an old launcher printed the ⚠ and closed
// with "All checks passed!". A unit test on buildDoctorSummary cannot see that, because
// the bug is in what the caller passes. This one reads the source.
describe('doctor reporter discipline (the caller side of the contract)', () => {
  const SRC = readFileSync(resolve('install.mjs'), 'utf8');

  function doctorBody() {
    const start = SRC.indexOf('const dwarn = (msg) =>');
    const end = SRC.indexOf('summary: buildDoctorSummary(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
  }

  it('every ⚠ the doctor emits is counted as a warning or as an issue', () => {
    const lines = doctorBody().split('\n');
    const uncounted = [];
    lines.forEach((line, i) => {
      // Bare `warn(` only — `dwarn(` is the counting wrapper, and the line that DEFINES
      // it legitimately calls `warn` after bumping `warnings`.
      if (!/(^|[^a-zA-Z_.])warn\(/.test(line)) return;
      // The counter may sit on an EARLIER line than its `warn(` — `const dwarn = (msg) =>
      // { warnings++; warn(msg); };` becomes three lines under a formatter. Look back the
      // same way the `issues++` check below looks forward (P1-3).
      if (/warnings\+\+/.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n'))) return;
      // A `warn(...)` may span lines; `issues++` follows the closing call. Six lines is
      // wider than any current call site's argument list.
      const window = lines.slice(i, i + 8).join('\n');
      if (/issues\+\+/.test(window)) return;
      uncounted.push(line.trim().slice(0, 90));
    });
    expect(uncounted).toEqual([]);
  });

  // Drive the ruler to failure: it must actually reject the shape it exists to catch.
  it('the scan rejects a bare warn() with neither counter', () => {
    const lines = ['      warn(`Old processes running`);', '    } else {'];
    const uncounted = lines.filter(
      (line, i) =>
        /(^|[^a-zA-Z_.])warn\(/.test(line) &&
        !/warnings\+\+/.test(line) &&
        !/issues\+\+/.test(lines.slice(i, i + 8).join('\n')),
    );
    expect(uncounted).toHaveLength(1);
  });

  // R12 C P3-6: the case above was ONE-DIRECTIONAL. `dwarn` -> `warn` goes red,
  // so the ruler can say NO about warnings — but a `fail()` added without
  // `issues++` passed, and `issues` is what the exit code is derived from
  // (CHANGELOG's exit-code contract). `fail` pushes `{level:'fail'}` and prints
  // ✗; it does not count anything by itself. So a check could print an error,
  // report `level: 'fail'` in --json, and still exit 0.
  // Drop comment-only and blank lines ENTIRELY when building the run, keeping
  // each surviving line's original number for the report. Blanking the text in
  // place is not enough — the line still occupies a slot, which is how the
  // 8-line explanatory block at install.mjs:2200-2207 pushed a real `issues++`
  // out of reach on the first draft. The repo already recorded this exact shape
  // once: the comment filter was applied when FINDING matches and not when
  // BUILDING the window, so "delete the code, keep the comment" walked past it.
  const codeLines = (src) => {
    // Brace depth at the START of each line. A counter SHALLOWER than its fail()
    // sits outside the fail's block — which is how `for (…) { fail(); } issues++;`
    // prints N ✗ and counts one. That exact loop is live at install.mjs:1780-1784
    // and is correct only because the bump is inside the braces; moving it out is
    // the natural tidy-up edit, and a purely textual scan stays green on it.
    let depth = 0;
    return src
      .split('\n')
      .map((text, i) => {
        const at = depth;
        depth += (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;
        return { text, no: i + 1, depth: at };
      })
      .filter(({ text }) => text.trim() && !text.trim().startsWith('//'));
  };

  // A counter belongs to the reporter it follows, so the run ends at the NEXT
  // reporter call rather than after N lines. A fixed width cannot express that
  // from either side: eight lines was too narrow for the Database catch (its
  // `issues++` sits 8 code lines out behind a remedy lookup, so a width of 9 is
  // the minimum that reaches it), while any width large enough starts claiming
  // the NEXT check's counter.
  //
  // An earlier revision of this comment cited a specific measurement for the
  // wide-window failure — an uncounted `fail()` before
  // `dwarn('Database: not found ...')` staying green. Pre-ship review isolated
  // the knobs and that reading is explained by the three-line look-back below,
  // not by the width: that insertion point has an `issues++` three code lines
  // BEHIND it and none within sixteen ahead, so every forward-only width
  // catches it. The conclusion held; the evidence cited for it did not.
  const REPORTER = /(^|[^a-zA-Z_.])(ok|warn|dwarn|fail)\(/;

  const isFail = (t) => /(^|[^a-zA-Z_.])fail\(/.test(t) && !/const\s+fail\s*=/.test(t);

  /**
   * Runs of `fail(` whose issue counter does not cover all of them.
   *
   * Counts rather than merely detects, because "is there a bump nearby" cannot
   * tell `fail(); fail(); issues++;` (under-counts by one) from the legitimate
   * `fail(); fail(); issues += 2;` — they are the same shape. Measured: a
   * detect-only version stayed green on exactly that mutation.
   *
   * FORWARD ONLY. The warn scan looks back because `dwarn` is a wrapper that
   * bumps before printing; `fail` has no such wrapper and never counts by
   * itself, so a counter BEHIND a fail() always belongs to the previous check.
   * A three-line look-back swallowed the mutation this guard exists to catch.
   */
  function uncountedFails(src) {
    const lines = codeLines(src);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!isFail(lines[i].text)) continue;
      const first = lines[i];
      let fails = 0;
      let bump = 0;
      let j = i;
      const depth = lines[i].depth;
      for (; j < lines.length; j++) {
        const t = lines[j].text;
        // A non-fail reporter closes the run: what follows is someone else's check.
        if (j > i && REPORTER.test(t) && !isFail(t)) break;
        if (isFail(t)) fails++;
        // A counter OUTSIDE the fail's block does not run once per fail. Leaving
        // the loop closes the run unread, so `for (…) { fail(); } issues++;`
        // reports `1 ✗ vs issues +0` instead of passing.
        if (lines[j].depth < depth) break;
        const plusEq = t.match(/issues\s*\+=\s*(\d+)/);
        if (plusEq) {
          bump += Number(plusEq[1]);
          break;
        }
        if (/issues\+\+/.test(t)) {
          bump += 1;
          break;
        }
      }
      if (bump < fails) {
        out.push(`${first.no}: ${first.text.trim().slice(0, 90)} (${fails} ✗ vs issues +${bump})`);
      }
      i = j;
    }
    return out;
  }

  it('every ✗ the doctor emits bumps the issue counter', () => {
    const uncounted = uncountedFails(doctorBody());
    expect(uncounted, `✗ emitted without bumping issues: ${uncounted.join(' | ')}`).toEqual([]);
  });

  it('the ✗ scan rejects a bare fail() with no counter', () => {
    expect(uncountedFails('      fail(`Database is unreadable`);\n    }')).toHaveLength(1);
  });

  // The counter-example the comment rule exists for: a real `issues++` separated
  // from its fail() by an explanatory block. Comment lines must not close the span.
  it('a comment block between fail() and its counter does not hide the counter', () => {
    const withComments = [
      "      fail('Database: ' + e.message);",
      ...Array.from({ length: 15 }, (_, k) => `      // explanatory line ${k}`),
      '      issues++;',
    ].join('\n');
    expect(uncountedFails(withComments), 'comment lines must not occupy the span').toHaveLength(0);
    // Premise: replace those comments with a REPORTER and the span closes, so the
    // case is exercising the comment rule and not passing for free.
    const withReporter = withComments.replace('// explanatory line 0', "ok('unrelated check');");
    expect(uncountedFails(withReporter), 'a following reporter must close the span').toHaveLength(1);
  });

  // `issues += 2` is how the one branch emitting two ✗ counts them. Matching only
  // `++` reported both of those as uncounted on this guard's first run.
  // install.mjs:1780-1784 is a `for (…) { fail(); log(); issues++; }` loop —
  // correct only because the bump is INSIDE the braces. Moving it out prints N ✗
  // and counts one, and a purely textual scan cannot see the difference. The
  // brace-depth rule is what closes it; pre-ship review found the gap.
  it("the ✗ scan rejects a counter that escaped the fail's block", () => {
    const inside = [
      '    for (const b of broken) {',
      '      fail(`bad ${b}`);',
      '      issues++;',
      '    }',
    ].join('\n');
    const outside = [
      '    for (const b of broken) {',
      '      fail(`bad ${b}`);',
      '    }',
      '    issues++;',
    ].join('\n');
    expect(uncountedFails(inside), 'a counter inside the loop is correct').toHaveLength(0);
    expect(uncountedFails(outside), 'a counter outside the loop runs once, not once per ✗').toHaveLength(1);
  });

  it('the ✗ scan accepts a shared `issues += N` for sibling fails', () => {
    const src = ["      fail('a: missing');", "      fail('b: missing');", '      issues += 2;'].join('\n');
    expect(uncountedFails(src)).toHaveLength(0);
  });
});
