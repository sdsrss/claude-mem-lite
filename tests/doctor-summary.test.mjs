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
});
