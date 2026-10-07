// D#170: the published npm-shrinkwrap.json is package-lock.json without its dev-only entries.
//
// `npm shrinkwrap` copied the lockfile whole and npm installs a dependency's shrinkwrap whole,
// so every registry install of claude-mem-lite carried vitest, eslint, knip and prettier.
// Measured 2026-10-07 through a local registry serving the packed tarball with _hasShrinkwrap
// (the registry's own flag; a local-tgz install ignores the file): full lock 298 packages /
// 541 MB on npm 11.19.0; this lock 96 / 57 MB on npm 11.19.0 and 10.9.2, with all 95
// production packages at their locked versions (express-rate-limit stayed 8.5.2 while 8.6.0 to
// 8.7.1 are in range, so the lock was honoured, not matched by chance).

import { describe, it, expect } from 'vitest';
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildShrinkwrap, verifyShrinkwrap, productionClosure } from '../scripts/write-shrinkwrap.mjs';
import { deployLockfile } from '../install.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const realLock = () => JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));

describe('buildShrinkwrap on the real lockfile', () => {
  it('drops exactly the dev-only entries and keeps every other entry unchanged', () => {
    const lock = realLock();
    const { shrinkwrap, dropped } = buildShrinkwrap(lock);
    const all = Object.keys(lock.packages);
    const dev = all.filter((k) => k && lock.packages[k].dev === true);
    expect(dev.length, 'premise: the lockfile has dev entries to drop').toBeGreaterThan(0);
    expect(dropped.sort()).toEqual(dev.sort());
    for (const k of Object.keys(shrinkwrap.packages))
      expect(shrinkwrap.packages[k]).toEqual(lock.packages[k]);
    expect(Object.keys(shrinkwrap.packages)).toHaveLength(all.length - dev.length);
    expect(shrinkwrap.lockfileVersion).toBe(lock.lockfileVersion);
    expect(shrinkwrap.name).toBe('claude-mem-lite');
  });

  it('keeps none of the dev tools and passes its own check', () => {
    const { shrinkwrap } = buildShrinkwrap(realLock());
    const keys = Object.keys(shrinkwrap.packages);
    expect(keys.filter((k) => /node_modules\/(vitest|eslint|knip|prettier)$/.test(k))).toEqual([]);
    expect(() => verifyShrinkwrap(shrinkwrap)).not.toThrow();
  });

  it('verifyShrinkwrap refuses the full lockfile, which is what `npm shrinkwrap` published', () => {
    expect(() => verifyShrinkwrap(realLock())).toThrow(/dev-only entries/);
  });
});

describe('the closure check', () => {
  const lock = (packages) => ({ name: 'x', lockfileVersion: 3, packages });
  const root = (deps = {}, extra = {}) => ({ name: 'x', version: '1.0.0', dependencies: deps, ...extra });

  it('refuses a lock that dropped an entry production needs (a prod dep flagged dev)', () => {
    const l = lock({ '': root({ a: '^1' }), 'node_modules/a': { version: '1.0.0', dev: true } });
    expect(() => buildShrinkwrap(l)).toThrow(/missing \["\(root\) -> a"\]/);
  });

  it('refuses a kept entry nothing reaches', () => {
    const l = lock({
      '': root({ a: '^1' }),
      'node_modules/a': { version: '1.0.0' },
      'node_modules/orphan': { version: '1.0.0' },
    });
    expect(() => buildShrinkwrap(l)).toThrow(/kept but unreached \["node_modules\/orphan"\]/);
  });

  it('resolves a name from the nearest node_modules first, as node does', () => {
    const packages = {
      '': root({ a: '^1', b: '^2' }),
      'node_modules/a': { version: '1.0.0', dependencies: { b: '^1' } },
      'node_modules/a/node_modules/b': { version: '1.0.0' },
      'node_modules/b': { version: '2.0.0' },
    };
    expect([...productionClosure(packages).reached].sort()).toEqual([
      'node_modules/a',
      'node_modules/a/node_modules/b',
      'node_modules/b',
    ]);
  });

  it('allows a missing optional dependency and a missing optional peer', () => {
    const l = lock({
      '': root({ a: '^1' }, { optionalDependencies: { 'binding-x': '1' } }),
      'node_modules/a': {
        version: '1.0.0',
        peerDependencies: { p: '*' },
        peerDependenciesMeta: { p: { optional: true } },
      },
    });
    expect(() => buildShrinkwrap(l)).not.toThrow();
  });
});

describe('the script entry', () => {
  // Pre-tag review: run through a symlinked path, the entry check compared the symlink with the
  // resolved module URL, so the script exited 0 having written nothing, and smoke-tarball then
  // skipped its shrinkwrap check because no file existed.
  it('writes the shrinkwrap when invoked through a symlink', () => {
    const d = mkdtempSync(join(tmpdir(), 'mem-sw-link-'));
    try {
      const link = join(d, 'write-shrinkwrap.mjs');
      symlinkSync(join(REPO, 'scripts', 'write-shrinkwrap.mjs'), link);
      const out = join(d, 'npm-shrinkwrap.json');
      const r = spawnSync(process.execPath, [link, '--lock', join(REPO, 'package-lock.json'), '--out', out], {
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(out), `nothing written; stdout: ${r.stdout}`).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('deployLockfile: what install.mjs deploys as ~/.claude-mem-lite/package-lock.json', () => {
  // The npm tarball never carries package-lock.json; without this the npx / global install ran
  // `npm install --omit=dev` in the managed dir with no lock at all.
  it('tarball shape: deploys the shrinkwrap as package-lock.json', () => {
    const src = mkdtempSync(join(tmpdir(), 'mem-lockdep-src-'));
    const dst = mkdtempSync(join(tmpdir(), 'mem-lockdep-dst-'));
    try {
      writeFileSync(join(src, 'npm-shrinkwrap.json'), '{"lockfileVersion":3,"probe":"sw"}\n');
      expect(deployLockfile(src, dst)).toBe(join(src, 'npm-shrinkwrap.json'));
      expect(readFileSync(join(dst, 'package-lock.json'), 'utf8')).toBe(
        '{"lockfileVersion":3,"probe":"sw"}\n',
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  it('checkout shape: leaves the deployed package-lock.json to the SOURCE_FILES copy', () => {
    const src = mkdtempSync(join(tmpdir(), 'mem-lockdep-src-'));
    const dst = mkdtempSync(join(tmpdir(), 'mem-lockdep-dst-'));
    try {
      writeFileSync(join(src, 'package-lock.json'), '{"probe":"lock"}');
      writeFileSync(join(src, 'npm-shrinkwrap.json'), '{"probe":"sw"}');
      writeFileSync(join(dst, 'package-lock.json'), '{"probe":"copied by SOURCE_FILES"}');
      expect(deployLockfile(src, dst)).toBeNull();
      expect(readFileSync(join(dst, 'package-lock.json'), 'utf8')).toBe('{"probe":"copied by SOURCE_FILES"}');
      rmSync(join(src, 'package-lock.json'));
      rmSync(join(src, 'npm-shrinkwrap.json'));
      expect(deployLockfile(src, dst), 'neither file: nothing to do').toBeNull();
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });

  // v6.24.0 delta review P3-2: the unit cases above pin the helper, not its call in
  // deployCodeTree, and deleting that call left the suite green. This runs the real
  // deployCodeTree from a tree holding exactly what `npm pack` ships (no package-lock.json)
  // plus a shrinkwrap, under a sandboxed HOME.
  it('deployCodeTree, run from a tarball-shaped tree, deploys its shrinkwrap', () => {
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(pack.status, pack.stderr).toBe(0);
    const files = JSON.parse(pack.stdout)[0].files.map((f) => f.path);
    expect(files, 'premise: the tarball carries the installer').toContain('install.mjs');
    expect(files, 'premise: the tarball carries no package-lock.json').not.toContain('package-lock.json');

    const pkg = mkdtempSync(join(tmpdir(), 'mem-lockdep-pkg-'));
    const home = mkdtempSync(join(tmpdir(), 'mem-lockdep-home-'));
    try {
      for (const f of files) {
        mkdirSync(dirname(join(pkg, f)), { recursive: true });
        copyFileSync(join(REPO, f), join(pkg, f));
      }
      symlinkSync(join(REPO, 'node_modules'), join(pkg, 'node_modules'));
      const probe = '{"lockfileVersion":3,"probe":"tarball shrinkwrap"}\n';
      writeFileSync(join(pkg, 'npm-shrinkwrap.json'), probe);
      const env = { ...process.env, HOME: home, MEM_NO_AUTO_ADOPT: '1' };
      delete env.CLAUDE_MEM_DIR;
      delete env.CLAUDE_MEM_RUNTIME_DIR;
      const r = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(pathToFileURL(join(pkg, 'install.mjs')).href)}); m.deployCodeTree(false);`,
        ],
        { env, encoding: 'utf8' },
      );
      expect(r.status, r.stderr).toBe(0);
      const deployed = join(home, '.claude-mem-lite');
      expect(existsSync(join(deployed, 'install.mjs')), 'premise: the code tree was deployed').toBe(true);
      expect(readFileSync(join(deployed, 'package-lock.json'), 'utf8')).toBe(probe);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
