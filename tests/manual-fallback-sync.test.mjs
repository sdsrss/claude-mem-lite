// The manual recovery one-liner lives on FOUR surfaces and cannot be shared by import:
// scripts/hook-launcher.mjs is under a pure-`node:` charter (it must survive a broken
// install), and the two READMEs are documentation. install.mjs owns the value; this pins
// the other three to it, and fails if a fifth surface starts carrying its own.
//
// Same mechanism as tests/audit-r8-binding-repair-hint.test.mjs, for the same reason: a
// string kept in sync by a comment is a string that drifts. It drifted here already — all
// four carried `/tarball`, which serves the DEFAULT BRANCH (unreleased WIP), while the
// prose beside two of them promised "in sync with the latest release".
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { MANUAL_TARBALL_FALLBACK } from '../install.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The declared VALUE of a top-level `const <name> = '<literal>'` in a source file.
 * Compared as a value, not as source text: the shell command contains single quotes, so
 * the JS source carries `\'` escapes and a raw `includes()` can never match.
 */
function declaredString(relFile, name) {
  const ast = acorn.parse(read(relFile), { ecmaVersion: 'latest', sourceType: 'module' });
  for (const node of ast.body) {
    const decl = node.type === 'VariableDeclaration' ? node : null;
    for (const d of decl?.declarations ?? []) {
      if (d.id?.name === name && d.init?.type === 'Literal') return d.init.value;
    }
  }
  return null;
}

describe('manual tarball fallback stays one string', () => {
  it('pins the latest RELEASE tag, never the default branch', () => {
    // The whole point of the change: `/tarball` with no ref is main HEAD. repair() exists
    // because auto-installing that was the defect; printing it on failure handed the
    // behaviour back.
    expect(MANUAL_TARBALL_FALLBACK).toContain('/releases/latest');
    expect(MANUAL_TARBALL_FALLBACK).not.toMatch(/claude-mem-lite\/tarball(?![/])/);
  });

  it('still runs the downloaded tree, not the local one', () => {
    // Control: the command's purpose is bypassing every file on the user's disk. A pin that
    // only checked the URL would let the tail of the command rot.
    expect(MANUAL_TARBALL_FALLBACK).toContain('mktemp -d');
    expect(MANUAL_TARBALL_FALLBACK).toContain('node "$T/install.mjs" install');
  });

  it('is carried verbatim by scripts/hook-launcher.mjs', () => {
    const launcher = declaredString('scripts/hook-launcher.mjs', 'TARBALL_FALLBACK');
    // Premise: a null here would make the comparison below pass against nothing.
    expect(typeof launcher).toBe('string');
    expect(launcher).toBe(MANUAL_TARBALL_FALLBACK);
  });

  it('is carried verbatim by both READMEs', () => {
    expect(read('README.md')).toContain(MANUAL_TARBALL_FALLBACK);
    expect(read('README.zh-CN.md')).toContain(MANUAL_TARBALL_FALLBACK);
  });

  it('has no fifth surface carrying a divergent copy', () => {
    // TWO markers, because one was not enough and pre-ship review proved it. Scanning only for
    // the OLD `/tarball` form catches a regression to the default branch — not "a fifth
    // surface": a fifth copy written with the release URL but a divergent tail sailed past.
    // The second marker is the distinctive fragment of the CURRENT form, and any line carrying
    // it must contain the constant verbatim.
    //
    // Entity sweep, no file-type filter: the copies are spread across .mjs and .md, and a
    // type-filtered sweep is how an earlier retraction in this repo missed one.
    // Assembled, not written out: a literal here would make this file its own offender.
    const oldForm = 'claude-mem-lite' + '/tarball';
    const newForm = 'releases/latest' + ' | grep -o'; // assembled: see oldForm
    const skipDirs = new Set(['node_modules', '.git', 'coverage', 'dist']);
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (skipDirs.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(mjs|js|md|json|sh|ya?ml|txt)$/.test(name)) continue;
        const rel = full.slice(ROOT.length + 1);
        const src = readFileSync(full, 'utf8');
        for (const line of src.split('\n')) {
          // A tagged tarball URL (`/tarball/v1.2.3`) is a different thing — hook-update.mjs
          // fixtures use it — and is not a copy of this command.
          if (/tarball\/v\d/.test(line)) continue;
          if (line.includes(oldForm) && !line.includes('/releases/latest')) {
            offenders.push(`${rel} (old form): ${line.trim().slice(0, 90)}`);
            continue;
          }
          // A line that starts the current command must carry ALL of it. The .mjs copies are
          // JS-escaped, so compare against both spellings.
          if (!line.includes(newForm)) continue;
          const escaped = MANUAL_TARBALL_FALLBACK.replace(/'/g, "\\'");
          if (!line.includes(MANUAL_TARBALL_FALLBACK) && !line.includes(escaped)) {
            offenders.push(`${rel} (divergent): ${line.trim().slice(0, 90)}`);
          }
        }
      }
    };
    walk(ROOT);
    expect(offenders).toEqual([]);
  });
});
