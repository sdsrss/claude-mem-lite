// Tests for checkDevDrift — catches dev installs where some SOURCE_FILES
// entries are plain files instead of symlinks (edits won't propagate from
// repo). v2.34.x QA surfaced install.mjs itself as a real drift case.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkDevDrift } from '../lib/doctor-drift.mjs';

describe('checkDevDrift', () => {
  let root;
  let installDir;
  let repoDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'drift-'));
    installDir = join(root, 'install');
    repoDir = join(root, 'repo');
    mkdirSync(installDir);
    mkdirSync(repoDir);
    writeFileSync(join(repoDir, 'a.mjs'), '// a');
    writeFileSync(join(repoDir, 'b.mjs'), '// b');
    writeFileSync(join(repoDir, 'c.mjs'), '// c');
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it('reports drift=false when all files are symlinks (clean dev install)', () => {
    symlinkSync(join(repoDir, 'a.mjs'), join(installDir, 'a.mjs'));
    symlinkSync(join(repoDir, 'b.mjs'), join(installDir, 'b.mjs'));
    symlinkSync(join(repoDir, 'c.mjs'), join(installDir, 'c.mjs'));
    const r = checkDevDrift(installDir, ['a.mjs', 'b.mjs', 'c.mjs']);
    expect(r.devMode).toBe(true);
    expect(r.drift).toBe(false);
    expect(r.symlinkCount).toBe(3);
    expect(r.plainCount).toBe(0);
  });

  it('reports drift=true when some files are symlinks and others are plain copies', () => {
    symlinkSync(join(repoDir, 'a.mjs'), join(installDir, 'a.mjs'));
    symlinkSync(join(repoDir, 'b.mjs'), join(installDir, 'b.mjs'));
    writeFileSync(join(installDir, 'c.mjs'), '// c copy'); // plain file = drift
    const r = checkDevDrift(installDir, ['a.mjs', 'b.mjs', 'c.mjs']);
    expect(r.devMode).toBe(true);
    expect(r.drift).toBe(true);
    expect(r.plainCount).toBe(1);
    expect(r.plainFiles).toEqual(['c.mjs']);
  });

  it('reports drift=false when all files are plain (prod copy install, nothing to drift from)', () => {
    writeFileSync(join(installDir, 'a.mjs'), '// a');
    writeFileSync(join(installDir, 'b.mjs'), '// b');
    writeFileSync(join(installDir, 'c.mjs'), '// c');
    const r = checkDevDrift(installDir, ['a.mjs', 'b.mjs', 'c.mjs']);
    expect(r.devMode).toBe(false);
    expect(r.drift).toBe(false);
  });

  it('reports drift=false when install dir does not exist', () => {
    const r = checkDevDrift(join(root, 'missing'), ['a.mjs']);
    expect(r.devMode).toBe(false);
    expect(r.drift).toBe(false);
    expect(r.symlinkCount).toBe(0);
  });

  it('counts missing entries separately from drift', () => {
    symlinkSync(join(repoDir, 'a.mjs'), join(installDir, 'a.mjs'));
    // b.mjs and c.mjs absent from install
    const r = checkDevDrift(installDir, ['a.mjs', 'b.mjs', 'c.mjs']);
    expect(r.missingCount).toBe(2);
    expect(r.drift).toBe(false);
    expect(r.devMode).toBe(true);
  });

  it('truncates details to first 5 plain files', () => {
    symlinkSync(join(repoDir, 'a.mjs'), join(installDir, 'a.mjs'));
    for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) {
      writeFileSync(join(installDir, `${n}.mjs`), '');
    }
    const files = ['a.mjs', 'p1.mjs', 'p2.mjs', 'p3.mjs', 'p4.mjs', 'p5.mjs', 'p6.mjs', 'p7.mjs'];
    const r = checkDevDrift(installDir, files);
    expect(r.plainCount).toBe(7);
    expect(r.details.length).toBe(5);
    expect(r.details[0]).toBe('p1.mjs');
  });
});
