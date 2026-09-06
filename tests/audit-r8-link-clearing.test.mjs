// A20260906-R8-P2-3 — existsSync() FOLLOWS a symlink, so a dangling one reads as absent.
//
// Seven call sites in install.mjs wrote `if (existsSync(link)) unlink/rm` immediately before
// `symlinkSync(...)`. When the link dangles the removal is skipped, symlinkSync throws
// EEXIST, and — for the CLI link — the catch falls through to an unwritable /usr/local/bin
// and prints "CLI symlink failed — run manually". Re-running `install`, the documented
// repair, could not repair it. Same class as the R7 finding on removeManaged (a symlink
// deleted rather than written through); the file already knew the idiom at isDevInstall().
//
// The dangling case is the one that matters, so it is asserted first and directly. The
// target-intact case pins the OTHER half: the dev-mode sites link DIRECTORIES, and a
// "simplification" to a link-following remove would delete the developer's own scripts/.
import { describe, it, expect, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { clearLinkPath } from '../install.mjs';

// Repo source read as TEXT: dirname(fileURLToPath(...)) + join, never new URL() — the URL
// form drops the module out of knip's report (tests/no-url-module-paths.test.mjs).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const dirs = [];
const sandbox = () => {
  const d = mkdtempSync(join(tmpdir(), 'r8-link-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
const present = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

describe('clearLinkPath sees what existsSync cannot', () => {
  it('clears a DANGLING symlink, so the relink that follows it succeeds', () => {
    const d = sandbox();
    const link = join(d, 'claude-mem-lite');
    symlinkSync(join(d, 'never-existed'), link);

    // Premise: this is exactly the state existsSync mis-reports. Without it the case
    // would also pass against a path that was simply absent.
    expect(existsSync(link), 'premise: existsSync must be blind to the dangling link').toBe(false);
    expect(present(link), 'premise: the link is really there').toBe(true);

    expect(clearLinkPath(link)).toBe(true);
    expect(present(link)).toBe(false);
    // The whole point: the caller's next statement is a symlinkSync, and it used to throw
    // EEXIST here. Not wrapped in expect(...).not.toThrow() — an unhandled throw fails the
    // test just as loudly and keeps the failure's own stack.
    const real = join(d, 'cli.mjs');
    writeFileSync(real, '// cli\n');
    symlinkSync(real, link);
    expect(readFileSync(link, 'utf8')).toBe('// cli\n');
  });

  it('removes a symlink to a populated directory WITHOUT following it', () => {
    const d = sandbox();
    mkdirSync(join(d, 'scripts'), { recursive: true });
    writeFileSync(join(d, 'scripts', 'setup.sh'), '#!/bin/sh\n');
    const link = join(d, 'linked-scripts');
    symlinkSync(join(d, 'scripts'), link);

    expect(clearLinkPath(link)).toBe(true);
    expect(present(link)).toBe(false);
    expect(existsSync(join(d, 'scripts', 'setup.sh')), 'the LINK TARGET must survive').toBe(true);
  });

  it('removes a regular file, and reports false for a path that is genuinely absent', () => {
    const d = sandbox();
    const f = join(d, 'stale.mjs');
    writeFileSync(f, 'x');
    expect(clearLinkPath(f)).toBe(true);
    expect(present(f)).toBe(false);
    // false, not a throw — uninstall keys its "CLI symlink removed" line off this.
    expect(clearLinkPath(join(d, 'no-such-entry'))).toBe(false);
  });
});

describe('the reverted shape cannot come back unnoticed', () => {
  it('install.mjs guards no removal with existsSync before writing a symlink', () => {
    const src = readFileSync(join(REPO_ROOT, 'install.mjs'), 'utf8');
    // Premise: the file still creates symlinks at all, so a zero match below means the
    // guard is satisfied rather than the subject matter having moved out of this file.
    expect(src.match(/symlinkSync\(/g)?.length ?? 0).toBeGreaterThan(3);

    // Scoped to the shape actually fixed: a removal gated on existsSync that IMMEDIATELY
    // precedes a symlinkSync. A whole-file "no existsSync-gated removal" rule over-reaches
    // — installPreinstalledResources legitimately uses it before cpSync, where nothing is
    // known to create links (recorded as an unverified suspicion in the R8 report rather
    // than changed on speculation).
    const lines = src.split('\n');
    const reverted = [];
    lines.forEach((line, i) => {
      if (!line.includes('symlinkSync(')) return;
      const window = lines.slice(Math.max(0, i - 5), i).join('\n');
      if (/existsSync\(/.test(window) && /(?:unlinkSync|rmSync)\(/.test(window)) {
        reverted.push(`install.mjs:${i + 1}`);
      }
    });
    expect(
      reverted,
      `existsSync-gated removal before symlinkSync is back at: ${reverted.join(', ')}`,
    ).toEqual([]);
  });
});
