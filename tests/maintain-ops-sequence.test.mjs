// Audit 2026-09-02 P1-5: the `maintain execute` SEQUENCE was hand-copied into mem-cli.mjs
// and server.mjs. Every operation was already shared; the order, the cap hint and the
// result strings were not, and they had drifted three ways:
//
//   * server.mjs rendered the demote_pinned line with a hardcoded `inj>=8` while the CLI
//     interpolated PINNED_INJ_THRESHOLD — change the constant and one face lies;
//   * the cap hint was a named helper on one face and the same ternary inlined four times
//     on the other;
//   * the comment explaining why demote_pinned must physically follow boost existed only
//     on the face that already had it right.
//
// What this file pins:
//   1. the ORDER, including the two positions that are load-bearing for data safety
//      (purge before decay) and for correctness (demote after boost);
//   2. that the threshold in the rendered line comes from the constant, on BOTH faces;
//   3. that neither face re-implements the sequence (static sweep, with a self-check that
//      the sweep can return false);
//   4. that the two surface DIALECTS that legitimately differ still differ — a "collapse"
//      that quietly made the MCP purge preview tell CLI users to pass `--confirm` would
//      otherwise look like a success.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb } from './test-helpers.mjs';
import { runMaintainOps, PINNED_INJ_THRESHOLD, OP_CAP, STALE_AGE_MS } from '../lib/maintain-core.mjs';

// D#207: join(), never new URL('../X.mjs', import.meta.url).
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

let db;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
});

const ctx = () => ({ projectFilter: '', baseParams: [], staleAge: Date.now() - STALE_AGE_MS, opCap: OP_CAP });
const preview = () => 'PREVIEW-RENDERED-BY-SURFACE';

describe('runMaintainOps — the sequence', () => {
  it('emits the requested ops in the pinned order, whatever order they are asked for', () => {
    // Asked for BACKWARDS on purpose. The order is a property of the sequence, not of the
    // caller's array: DEFAULT_MAINTAIN_OPS pins it, and a run that honoured the caller's
    // order would put demote_pinned before boost and have the demotion undone in-run.
    const lines = runMaintainOps(db, ctx(), ['demote_pinned', 'boost', 'decay', 'cleanup', 'purge_stale'], {
      retainCutoff: Date.now(),
      confirmed: false,
      renderPurgePreview: preview,
    });
    const order = lines.map((l) => l.split(' ')[0]);
    expect(order.slice(0, 5)).toEqual([
      'PREVIEW-RENDERED-BY-SURFACE',
      'Cleaned',
      'Decayed',
      'Boosted',
      'Demoted',
    ]);
  });

  it('purge runs BEFORE decay — the zero-grace data-loss order (audit HIGH-1)', () => {
    const lines = runMaintainOps(db, ctx(), ['decay', 'purge_stale'], {
      retainCutoff: Date.now(),
      confirmed: false,
      renderPurgePreview: preview,
    });
    const purgeAt = lines.findIndex((l) => l.startsWith('PREVIEW'));
    const decayAt = lines.findIndex((l) => l.startsWith('Decayed'));
    expect(purgeAt).toBeGreaterThanOrEqual(0);
    expect(decayAt).toBeGreaterThanOrEqual(0);
    expect(purgeAt, 'decay before purge marks a row and deletes it in one call').toBeLessThan(decayAt);
  });

  it('demote_pinned runs AFTER boost — otherwise boostAccessed undoes the demotion in-run', () => {
    const lines = runMaintainOps(db, ctx(), ['demote_pinned', 'boost'], {
      retainCutoff: Date.now(),
      renderPurgePreview: preview,
    });
    expect(lines.findIndex((l) => l.startsWith('Boosted'))).toBeLessThan(
      lines.findIndex((l) => l.startsWith('Demoted')),
    );
  });

  it('renders the demote threshold from the constant, not a literal', () => {
    const [line] = runMaintainOps(db, ctx(), ['demote_pinned'], {
      retainCutoff: Date.now(),
      renderPurgePreview: preview,
    });
    expect(line).toContain(`inj>=${PINNED_INJ_THRESHOLD}`);
    expect(PINNED_INJ_THRESHOLD).toBeGreaterThan(0);
    expect(line.match(/inj>=(\d+)/)[1]).toBe(String(PINNED_INJ_THRESHOLD));
    // NOTHING IN THIS CASE CAN CATCH A HARDCODED LITERAL, and saying so is the point: every
    // assertion here compares the rendered value against the constant, and the defect
    // shipped in the state where those are EQUAL (`server.mjs` wrote `inj>=8` while the
    // constant was 8). The guard that actually binds it is the static sweep further down
    // this file, which reads the three sources and fails on a literal. A fourth assertion
    // once sat here — `not.toMatch(/inj>=(?!\d*\b)/)` — reading as if it closed the gap;
    // `\d*` matches empty and `\b` then holds at the `=`, so it returned false for every
    // realistic input including `inj>=X`. Removed rather than repaired: a runtime assertion
    // cannot express "this number was interpolated, not typed".
  });

  it('the FTS optimize line is always emitted, ops or not', () => {
    expect(runMaintainOps(db, ctx(), [], { retainCutoff: Date.now(), renderPurgePreview: preview })).toEqual([
      'FTS5 index optimized',
    ]);
  });

  it('warns about merge ids in the caller dialect, on both branches', () => {
    const withDedup = runMaintainOps(db, ctx(), ['dedup'], {
      retainCutoff: Date.now(),
      renderPurgePreview: preview,
      mergeGroups: [],
      mergeIdsProvided: true,
      invalidMergeSegments: ['oops'],
      mergeIdsFlagName: '--merge-ids',
    });
    expect(withDedup.join('\n')).toContain('malformed --merge-ids segment(s): oops');

    const withoutDedup = runMaintainOps(db, ctx(), ['decay'], {
      retainCutoff: Date.now(),
      renderPurgePreview: preview,
      mergeGroups: [[1, 2]],
      mergeIdsProvided: true,
      mergeIdsFlagName: 'merge_ids',
    });
    expect(withoutDedup.join('\n')).toContain('merge_ids provided but "dedup" not in operations');
  });

  it('a confirmed purge does not call the preview renderer', () => {
    // The preview renderer is surface-owned and prints "re-run with --confirm". Calling it
    // on the confirmed path would tell a user who just confirmed to confirm again.
    let called = 0;
    const lines = runMaintainOps(db, ctx(), ['purge_stale'], {
      retainCutoff: Date.now(),
      confirmed: true,
      renderPurgePreview: () => {
        called++;
        return 'X';
      },
    });
    expect(called).toBe(0);
    expect(lines[0]).toMatch(/^Purged \d+ stale observations/);
  });
});

describe('neither face re-implements the sequence', () => {
  // The op bodies must be reached through runMaintainOps. A face that imports one of these
  // directly is either re-implementing the order or about to.
  const OP_NAMES = [
    'cleanupBroken',
    'decayAndMarkIdle',
    'boostAccessed',
    'demotePinned',
    'purgeStale',
    'hardDeleteCandidateCount',
  ];

  function maintainCoreImports(src) {
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/lib\/maintain-core\.mjs'/);
    return m
      ? m[1]
          .split(',')
          .map((x) => x.trim().split(/\s+as\s+/)[0])
          .filter(Boolean)
      : null;
  }

  it('the import scanner can say NO', () => {
    // Without this, a regex that stopped matching would report both faces clean.
    expect(maintainCoreImports("import { purgeStale } from './lib/maintain-core.mjs';")).toEqual([
      'purgeStale',
    ]);
    expect(maintainCoreImports("import { a, b as c } from './lib/maintain-core.mjs';")).toEqual(['a', 'b']);
    expect(maintainCoreImports("import { x } from './lib/other.mjs';")).toBeNull();
  });

  for (const face of ['mem-cli.mjs', 'server.mjs']) {
    it(`${face} calls runMaintainOps and imports no op body directly`, () => {
      const src = read(face);
      const names = maintainCoreImports(src);
      expect(names, `${face} must import from maintain-core`).not.toBeNull();
      expect(names).toContain('runMaintainOps');
      expect(
        names.filter((n) => OP_NAMES.includes(n)),
        `${face} imports op bodies directly`,
      ).toEqual([]);
      expect(src, `${face} must not re-typed the transaction boundary for maintain`).not.toMatch(
        /results\.push\(`Demoted \$\{/,
      );
    });
  }

  it('no shipped file renders a hardcoded threshold — including the module it moved into', () => {
    // The exact defect: `inj>=8` as a literal inside a rendered string.
    //
    // `lib/maintain-core.mjs` is in this list because the FIRST version of this case was not,
    // and a mutation proved the gap: hardcoding `inj>=8` inside runMaintainOps passed all
    // thirteen cases. The runtime assertion above cannot catch it either —
    // `line.match(/inj>=(\d+)/)[1] === String(PINNED_INJ_THRESHOLD)` is satisfied by a
    // literal whenever the constant happens to hold the same value, which is precisely the
    // state the defect shipped in. Collapsing a defect into a shared module does not remove
    // it; a guard scoped to the OLD homes just stops seeing it.
    for (const face of ['mem-cli.mjs', 'server.mjs', 'lib/maintain-core.mjs']) {
      const src = read(face)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
      expect(src, `${face} renders a literal threshold`).not.toMatch(/inj>=\d/);
    }
    // …and the sweep can fire: this is the string that shipped.
    expect('results.push(`Demoted ${n} pinned-but-uncited observations (inj>=8, cited=0)`)').toMatch(
      /inj>=\d/,
    );
  });
});

describe('the surface dialects still differ', () => {
  // Collapsing the sequence must not collapse the two things that are legitimately
  // per-surface. A "fix" that made both previews say `--confirm` would be green above.
  it('each face renders its own purge-preview instruction', () => {
    expect(read('mem-cli.mjs')).toContain('To delete, re-run with --confirm.');
    expect(read('server.mjs')).toContain('re-run with confirm=true');
    expect(read('server.mjs')).not.toContain('re-run with --confirm.');
  });

  it('each face names its own merge-ids flag', () => {
    expect(read('mem-cli.mjs')).toContain("mergeIdsFlagName: '--merge-ids'");
    expect(read('server.mjs')).toContain("mergeIdsFlagName: 'merge_ids'");
  });
});
