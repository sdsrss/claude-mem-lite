// scripts/green-stamp-reporter.mjs — the ONLY writer of the pre-commit green stamp.
//
// Registered in vitest.config.mjs beside the default reporter. It records the tree key
// (scripts/green-stamp.mjs) when, and only when, a run is a full, passing, unfiltered pass
// over an unchanged tree; scripts/pre-commit.sh then skips `npm test` for a commit of
// exactly that tree. Every other outcome writes nothing, and "no stamp" means the gate
// runs the suite, so a wrong NO here costs 44 s and a wrong YES is what the conditions
// below exist to prevent. A `--reporter` flag on the command line replaces this reporter
// along with the default one: that run records nothing, which is the safe direction.

import { computeTreeKey, recordStamp } from './green-stamp.mjs';

/**
 * Why a finished run may NOT certify its tree, or null when it may.
 * Pure over its inputs so every condition can be driven to fail in a test.
 */
export function refusalReason({ reason, unhandledErrors, config, ranIds, allIds, startKey, endKey }) {
  if (reason !== 'passed') return `run ${reason}`;
  if (unhandledErrors.length > 0) return 'unhandled errors';
  if (config.testNamePattern) return 'test name filter';
  if (config.shard) return 'sharded run';
  if (config.changed) return '--changed run';
  if (Array.isArray(config.related) && config.related.length > 0) return '--related run';
  if (allIds.length === 0) return 'no test files collected';
  const ran = new Set(ranIds);
  if (ran.size !== new Set(allIds).size || allIds.some((id) => !ran.has(id)))
    return 'not every test file ran';
  if (!startKey || startKey !== endKey) return 'tree changed while the suite ran';
  return null;
}

export default class GreenStampReporter {
  onInit(ctx) {
    this.ctx = ctx;
    this.cwd = ctx.config.root;
    try {
      this.startKey = computeTreeKey(this.cwd);
    } catch {
      this.startKey = null; // not a git checkout (e.g. an unpacked tarball): never stamp
    }
  }

  async onTestRunEnd(testModules, unhandledErrors, reason) {
    if (!this.startKey) return;
    try {
      const all = await this.ctx.globTestSpecifications();
      const refusal = refusalReason({
        reason,
        unhandledErrors,
        config: this.ctx.config,
        ranIds: testModules.map((m) => m.moduleId),
        allIds: all.map((s) => s.moduleId),
        startKey: this.startKey,
        endKey: computeTreeKey(this.cwd),
      });
      if (!refusal) recordStamp(this.cwd, this.startKey);
    } catch {
      // A stamp is an optimisation; failing to write one must never fail the run.
    }
  }
}
