// D#168's headline exclusion, which was the one piece of it with no test.
//
// Two repo-walking invariant scanners got purpose-built probe cases; the `test.exclude`
// entry — the thing that actually stops a scratch `*.test.mjs` under `tmp/` from being
// COLLECTED AND RUN, which is what the defect report was about — had none. Deleting
// `'tmp/**'` was silent. Review measured the delta: collection goes 304 → 305 files.
//
// A probe that plants a file and re-runs collection would mean spawning vitest from
// inside vitest. Asserting the resolved config is the same seam `tests/coverage-scope`
// uses for `coverage.exclude`, and it is enough: the pattern is either in the array the
// runner reads, or it is not.
import { describe, it, expect } from 'vitest';
import { configDefaults } from 'vitest/config';
import config from '../vitest.config.mjs';

const exclude = config.test.exclude;

describe('vitest test.exclude (D#168)', () => {
  it('excludes the repo scratch dirs from test collection', () => {
    expect(exclude, 'test.exclude must be configured at all').toBeInstanceOf(Array);
    expect(exclude).toContain('tmp/**');
    expect(exclude).toContain('.tmp/**');
    // `tasks/**` joined them in the 2026-09-02 P2-1 round. Same known weakness as the two
    // above and the same reason (a real probe means spawning vitest from inside vitest):
    // this asserts the pattern is in the array the runner reads, not that collection
    // honours it. The eslint half of that round was probe-verified instead, because eslint
    // CAN be run as a subprocess — see the round's note in the audit report.
    expect(exclude).toContain('tasks/**');
  });

  it('re-states every default it replaces — `exclude` overrides, it does not extend', () => {
    // The trap this config comment warns about: supplying `exclude` REPLACES
    // configDefaults.exclude. Dropping `node_modules` would collect thousands of
    // vendored tests. Checked against the INSTALLED vitest's own defaults rather than a
    // list copied into a comment, so a vitest upgrade that adds a default fails here
    // instead of silently widening collection.
    for (const pattern of configDefaults.exclude) {
      expect(exclude, `default exclude "${pattern}" was dropped by overriding test.exclude`).toContain(
        pattern,
      );
    }
    expect(
      configDefaults.exclude.length,
      'sanity: the installed vitest must have some defaults, else this case is vacuous',
    ).toBeGreaterThan(0);
  });
});
