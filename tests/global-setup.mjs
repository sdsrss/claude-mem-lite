// Vitest globalSetup: reap claude-mem-lite test-fixture dirs leaked into temp by
// prior runs that were interrupted/SIGKILL'd before afterEach could clean up.
// Per-test cleanup cannot survive a hard kill, so we self-heal at the next run's
// start. 1h age guard means an in-flight parallel run is never disturbed.
//
// Also allocates this run's containment sandbox (audit 2026-08-22 P2-4): the directory
// lib/resolve-data-dir.mjs redirects to when a test — or a subprocess it spawned with the
// ambient env — resolves the data dir without setting CLAUDE_MEM_DIR. One directory per
// run, exported through the env so parent and child agree, and removed at teardown.
import { sweepStaleTestFixtures } from '../lib/tmp-fixture-sweep.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

export default function setup() {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-mem-testrun-'));
  process.env.CLAUDE_MEM_TEST_SANDBOX = sandbox;
  // The live data dir, resolved HERE — this is the one moment in a run when the
  // ambient CLAUDE_MEM_DIR and the developer's real HOME are both still visible
  // (vitest.config.mjs blanks the former for every worker, and individual suites
  // repoint the latter at fixtures).
  process.env.CLAUDE_MEM_TEST_REALDIR = process.env.CLAUDE_MEM_DIR || join(homedir(), '.claude-mem-lite');
  // Returned teardown runs after the whole suite. A leftover dir is swept by the next
  // run's sweepStaleTestFixtures anyway, so failure here is not worth failing over.
  const teardown = () => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* swept later */
    }
  };
  try {
    const { removed } = sweepStaleTestFixtures();
    if (removed > 0 && process.env.MEM_TEST_SWEEP_VERBOSE === '1') {
      console.log(`[test-setup] reaped ${removed} stale fixture dir(s)`);
    }
  } catch {
    /* never block the suite on cleanup */
  }
  return teardown;
}
