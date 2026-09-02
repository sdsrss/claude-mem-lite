// tests/sandbox-base-guard.test.mjs — guards tests/sandbox/sbx-base.mjs, which decides
// where the install harness is allowed to build a sandbox root.
//
// The harness itself is NOT part of `vitest run` (real `npm i -g`, real network, minutes),
// so without this file its only guard would run on a machine nobody watches. What is
// asserted here is the refusal, in both directions: a base under HOME must throw, and a
// base outside it must be returned unchanged. A guard with only the positive half is one
// `if (false)` away from green — this repo has shipped that shape before.
//
// The case that motivated it is real and was found by RUNNING the harness: `os.tmpdir()`
// reads `$TMPDIR`, a Claude Code session sets `$TMPDIR` to `~/.claude/tmp/claude-<uid>`,
// and `/home/<user>/node_modules` on this machine holds both `better-sqlite3` and
// `claude-mem-lite`. So the harness's documented default put its sandbox under HOME —
// exactly what its README forbids, forty lines further down in a section the quickstart
// reader never reaches — and every check still passed, against the wrong install tree.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInside, resolveSandboxBase, ancestorWithNodeModules } from './sandbox/sbx-base.mjs';

describe('isInside — path segments, not string prefixes', () => {
  it('accepts a real descendant and the directory itself', () => {
    expect(isInside('/home/sds', '/home/sds/.claude/tmp/x')).toBe(true);
    expect(isInside('/home/sds', '/home/sds')).toBe(true);
  });

  it('does NOT treat a sibling sharing a name prefix as inside', () => {
    // The decoy a `startsWith(parent)` implementation fails on.
    expect(isInside('/home/sds', '/home/sds-other/tmp')).toBe(false);
  });

  it('normalises BOTH sides before comparing, not just the child', () => {
    // The parent side is the half a review found unenforced: mutating `resolve(parent)`
    // away left all eight cases green, because every case passed a clean parent.
    expect(isInside('/home/sds/../sds', '/home/sds/tmp')).toBe(true);
    expect(isInside('/home/sds', '/home/sds/../sds/tmp')).toBe(true);
    expect(isInside('/home/sds/', '/home/sds/tmp')).toBe(true);
    expect(isInside('/home/sds', '/tmp/claude/sbx')).toBe(false);
  });
});

describe('resolveSandboxBase — the refusal is the point', () => {
  const HOME = '/home/tester';

  it('THROWS on the exact shape the documented default produces', () => {
    // $TMPDIR as a Claude Code session sets it.
    expect(() => resolveSandboxBase({ tmp: `${HOME}/.claude/tmp/claude-1000`, home: HOME }))
      .toThrow(/under HOME/);
  });

  it('THROWS even when the offending path came from an explicit SBX_BASE', () => {
    // An override is not an authorisation: the hazard is the location, not the source.
    expect(() => resolveSandboxBase({ sbxBase: `${HOME}/scratch`, tmp: '/tmp', home: HOME }))
      .toThrow(/under HOME/);
  });

  it('names the resolved PATH, not the variable — the variable is not what is wrong', () => {
    let msg = '';
    try { resolveSandboxBase({ tmp: `${HOME}/.claude/tmp`, home: HOME }); } catch (e) { msg = e.message; }
    expect(msg).toContain(`${HOME}/.claude/tmp`);
    expect(msg).toContain(HOME);
    expect(msg, 'the message must carry a usable way out').toContain('SBX_BASE');
  });

  it('returns a base outside HOME unchanged — the guard can say yes', () => {
    expect(resolveSandboxBase({ sbxBase: '/tmp/claude/sbx', tmp: `${HOME}/.claude/tmp`, home: HOME }))
      .toBe('/tmp/claude/sbx');
    expect(resolveSandboxBase({ tmp: '/var/tmp', home: HOME })).toBe('/var/tmp');
  });

  it('prefers SBX_BASE over the fallback, so the documented escape hatch still works', () => {
    expect(resolveSandboxBase({ sbxBase: '/tmp/a', tmp: '/tmp/b', home: HOME })).toBe('/tmp/a');
  });

  it('names the HOME rule, not the node_modules rule, when both would fire', () => {
    // Ordering of the two refusals is deliberate: the commoner case keeps its specific
    // message. `/home/tester` is a fake HOME with nothing on disk, so only the first
    // check can be the one that fires here.
    expect(() => resolveSandboxBase({ sbxBase: `${HOME}/x`, home: HOME })).toThrow(/under HOME/);
  });
});

describe('the HAZARD itself, not the HOME proxy', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sbxguard-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns the NEAREST owning ancestor, not merely some ancestor', () => {
    // Environment-independent by construction. An earlier version of this case asserted
    // `null` for a "clean" temp dir and went red on the machine it was written on —
    // correctly: $TMPDIR is under $HOME there and `~/node_modules` exists, so the walk
    // found it. The guard was right and the test's premise was wrong. Nearest-ancestor is
    // the property that does not depend on what sits above the temp root.
    const outer = join(root, 'outer');
    mkdirSync(join(outer, 'node_modules'), { recursive: true });
    const inner = join(outer, 'pkg');
    mkdirSync(join(inner, 'node_modules'), { recursive: true });
    const base = join(inner, 'tmp', 'sbx');
    mkdirSync(base, { recursive: true });
    expect(ancestorWithNodeModules(base)).toBe(realpathSync.native(inner));
  });

  it('can return null — the walk terminates instead of always finding something', () => {
    // Premise stated rather than assumed: a machine with a root-level /node_modules
    // would make this unanswerable, and should fail loudly rather than pass.
    expect(existsSync('/node_modules'), 'premise: no /node_modules on this machine').toBe(false);
    expect(ancestorWithNodeModules('/')).toBeNull();
  });

  it('REFUSES a base whose ancestor owns node_modules even though it is nowhere near HOME', () => {
    // The gap a review drove a real path through: `<repo>/tmp/sbx` passes the HOME rule
    // and still resolves better-sqlite3 out of the package under test.
    const pkg = join(root, 'repo');
    mkdirSync(join(pkg, 'node_modules'), { recursive: true });
    const base = join(pkg, 'tmp', 'sbx');
    mkdirSync(base, { recursive: true });
    expect(isInside('/home/tester', base), 'premise: it is NOT under HOME').toBe(false);
    expect(() => resolveSandboxBase({ sbxBase: base, home: '/home/tester' }))
      .toThrow(/owns a node_modules/);
  });

  it('is not fooled by a symlink pointing into HOME', () => {
    // `resolve()` normalises `..` but does not follow symlinks, and Node's module
    // resolution walks the REAL path — so this passed the guard before realpath.
    const home = join(root, 'realhome');
    mkdirSync(join(home, 'sbx'), { recursive: true });
    const link = join(root, 'link-to-home');
    symlinkSync(home, link);
    expect(() => resolveSandboxBase({ sbxBase: join(link, 'sbx'), home }))
      .toThrow(/under HOME/);
  });
});
