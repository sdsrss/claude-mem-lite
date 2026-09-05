import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sweepStaleTestFixtures } from '../lib/tmp-fixture-sweep.mjs';

describe('sweepStaleTestFixtures', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sweep-orphan-'));
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  // Backdate a dir's mtime to `ageMs` ago so the age gate treats it as stale.
  function makeDir(name, ageMs) {
    const p = join(root, name);
    mkdirSync(p);
    writeFileSync(join(p, 'test.db'), 'x'); // simulate a leaked sandbox DB
    if (ageMs > 0) {
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(p, t, t);
    }
    return p;
  }

  it('removes stale mem-namespaced fixture dirs older than ageMs', () => {
    const stale = makeDir('mem-e2e-abc123', 2 * 60 * 60 * 1000); // 2h old
    const { removed, names } = sweepStaleTestFixtures({ dirs: [root], ageMs: 60 * 60 * 1000 });
    expect(removed).toBe(1);
    expect(names).toContain(stale);
    expect(existsSync(stale)).toBe(false);
  });

  it('keeps fresh fixture dirs (younger than ageMs) — never disturbs an in-flight run', () => {
    const fresh = makeDir('mem-audit-fresh', 0); // just created
    const { removed } = sweepStaleTestFixtures({ dirs: [root], ageMs: 60 * 60 * 1000 });
    expect(removed).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never touches non-mem dirs (other tools, e.g. code-graph-mcp .tmp/index.db)', () => {
    const other = makeDir('.tmpXYZ', 5 * 60 * 60 * 1000); // code-graph-mcp style
    const generic = makeDir('plans-abc', 5 * 60 * 60 * 1000); // generic prefix, intentionally excluded
    const { removed } = sweepStaleTestFixtures({ dirs: [root], ageMs: 60 * 60 * 1000 });
    expect(removed).toBe(0);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(generic)).toBe(true);
  });

  it('dryRun lists without deleting', () => {
    const stale = makeDir('cite-ups-xyz', 5 * 60 * 60 * 1000);
    const { removed, names } = sweepStaleTestFixtures({ dirs: [root], ageMs: 60 * 60 * 1000, dryRun: true });
    expect(removed).toBe(1);
    expect(names).toContain(stale);
    expect(existsSync(stale)).toBe(true); // not deleted
  });

  it('handles a missing root dir gracefully', () => {
    const { removed } = sweepStaleTestFixtures({ dirs: [join(root, 'does-not-exist')], ageMs: 1000 });
    expect(removed).toBe(0);
  });
});
