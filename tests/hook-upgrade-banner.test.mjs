import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// Imported from lib/upgrade-banner.mjs (split out of hook.mjs to avoid
// module-level `process.exit(0)` aborting the vitest worker on import).
import { emitV270UpgradeBanner, hasPreV270Data, V270_RELEASE_EPOCH } from '../lib/upgrade-banner.mjs';
import Database from 'better-sqlite3';

describe('v2.70.0 first-run upgrade banner', () => {
  it('emits stderr banner once and creates marker, no-op on subsequent calls', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'mem-banner-'));
    try {
      const project = 'test-banner-proj';
      const marker = join(runtimeDir, `.deferred-block-migrated-${project}`);
      expect(existsSync(marker)).toBe(false);

      // Capture stderr writes
      const writes = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (msg) => {
        writes.push(String(msg));
        return true;
      };
      try {
        emitV270UpgradeBanner({ project, runtimeDir });
        emitV270UpgradeBanner({ project, runtimeDir }); // second call must be silent
      } finally {
        process.stderr.write = orig;
      }
      expect(writes.length).toBe(1);
      expect(writes[0]).toMatch(/Deferred Work block now backed by deferred_work table/);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('suppresses the banner for a fresh install (no prior data) but still marks it', () => {
    // A brand-new user never had the v2.69.x deferred-block semantics, so the
    // "v2.70.0 upgrade notice / pin to 2.69.x" is wrong noise. Suppress when the
    // project has no prior observations — and write the marker so it stays
    // suppressed once they start accumulating data.
    const runtimeDir = mkdtempSync(join(tmpdir(), 'mem-banner-fresh-'));
    try {
      const project = 'fresh-install-proj';
      const marker = join(runtimeDir, `.deferred-block-migrated-${project}`);
      const writes = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (msg) => {
        writes.push(String(msg));
        return true;
      };
      try {
        emitV270UpgradeBanner({ project, runtimeDir, hasPriorData: false });
      } finally {
        process.stderr.write = orig;
      }
      expect(writes.length).toBe(0); // no banner
      expect(existsSync(marker)).toBe(true); // but permanently suppressed
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

// ─── Age-based upgrader detection (R5 dogfood, 2026-08-13) ──────────────────
//
// The original guard was "project has any observations". That still fired for a
// user who installed today and saved a few memories before their first
// SessionStart — they got a migration notice for a release 40+ versions back,
// ending in "Pin to 2.69.x to revert". Only rows predating v2.70.0 (2026-05-10)
// could have been rendered under the v2.69.x deferred-block semantics.
describe('hasPreV270Data — only genuine upgraders count as prior data', () => {
  function seedDb(epochs, project = 'p') {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, created_at_epoch INTEGER)');
    const ins = db.prepare('INSERT INTO observations (project, created_at_epoch) VALUES (?, ?)');
    for (const e of epochs) ins.run(project, e);
    return db;
  }

  it('is true when the project holds an observation older than the v2.70.0 release', () => {
    const db = seedDb([V270_RELEASE_EPOCH - 86400000]);
    expect(hasPreV270Data(db, 'p')).toBe(true);
    db.close();
  });

  it('is false for a fresh install whose memories are all newer', () => {
    const db = seedDb([V270_RELEASE_EPOCH + 86400000, Date.now()]);
    expect(hasPreV270Data(db, 'p')).toBe(false);
    db.close();
  });

  it('is false for an empty project', () => {
    const db = seedDb([]);
    expect(hasPreV270Data(db, 'p')).toBe(false);
    db.close();
  });

  it("is project-scoped — another project's old rows do not trigger it", () => {
    const db = seedDb([V270_RELEASE_EPOCH - 86400000], 'other');
    expect(hasPreV270Data(db, 'p')).toBe(false);
    db.close();
  });

  it('fails quiet (false) when the query throws — a missed notice beats a wrong one', () => {
    expect(
      hasPreV270Data(
        {
          prepare() {
            throw new Error('no such table');
          },
        },
        'p',
      ),
    ).toBe(false);
  });
});
