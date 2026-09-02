// D#207 — a repo-source path must be built with join(), never with
// `new URL('../X.mjs', import.meta.url)`.
//
// WHY THIS IS A GUARD AND NOT A STYLE PREFERENCE. Naming a module that way anywhere in
// the analysed tree makes knip drop that module out of its unused-export report
// ENTIRELY — not the one export, the whole file. So a single test that reads a source
// file as text silently costs knip coverage of a module it has nothing to do with, and
// the loss is invisible: the count goes DOWN, which reads like an improvement.
//
// Established by probe, both directions, 2026-09-02. Appending
// `export const __KNIP_PROBE__ = 1;` to eight modules and running knip once: only
// `tier.mjs` — the one module not named in this form anywhere — appeared. The other
// seven (hook-context, hook-memory, hook.mjs, search-engine, hook-semaphore, hook-llm,
// cli-path) were invisible. Converting every site to join() and re-running took the
// report from 46 unused exports to 57: eleven dead exports that had been hidden, in
// search-engine.mjs (7), hook-llm.mjs (2) and hook-context.mjs (2).
//
// It also happened live rather than in theory: adding
// `tests/pretool-event-id-namespace.test.mjs`, which read three source files this way,
// dropped `lib/citation-tracker.mjs:extractInjectedFromSubagentPrompt` out of the name
// set (46 -> 45) — a test file blinding knip to an unrelated module.
//
// This guard REPLACES tests/knip-blindspot-guard.test.mjs, which compensated for the
// blind spot on two modules by re-implementing part of what knip does. Removing the
// cause beats maintaining a stand-in with an allowlist: knip now sees those modules, so
// the real tool covers them and there is one fewer hand-maintained list to rot.
//
// SCOPE, stated because it is narrower than "no new URL": only a first argument that
// NAMES A MODULE (a relative specifier ending in .mjs or .js). The directory form,
// `new URL('..', import.meta.url)`, was NOT shown to blind anything and is not flagged —
// banning it would be a rule this file cannot support with evidence.
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors the tree knip analyses. `tmp/` and `coverage/` are not in it; `node_modules`
// and `.git` are far too large to walk and cannot contain our own sources.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', 'tmp', '.claude', 'dist', 'build', '.tmp',
]);

/**
 * `new URL(<relative module specifier>, …)`.
 *
 * Matches both the plain-string and template-literal forms, since the template form is
 * what `tests/deferred-work.test.mjs` and two siblings used. Requires the specifier to
 * START relative and END in a module extension — a bare `'..'` or a `'./fixtures/'`
 * directory is out of scope per the note above.
 */
const URL_MODULE_PATH = /new\s+URL\(\s*(['"`])\.{1,2}\/[^'"`]*\.(?:mjs|js)\1/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    // A concurrent process can remove a file between readdir and stat; a file that is
    // gone cannot carry a bad path, so skipping it is the right answer.
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

/** Offending `file:line` for every source line matching the banned form. */
function findOffenders(files) {
  const hits = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes('new URL')) continue;
    src.split('\n').forEach((line, i) => {
      // Comments describing the rule (this file, and the note left at each conversion
      // site) are not uses. Checked on the raw line so an inline trailing comment after
      // real code is still scanned.
      const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
      if (URL_MODULE_PATH.test(code)) hits.push(`${relative(REPO, f)}:${i + 1}`);
    });
  }
  return hits;
}

describe('D#207 — repo-source paths use join(), not new URL(module)', () => {
  const files = walk(REPO);

  it('walks a plausible number of source files', () => {
    // A broken walk returning [] would make the guard below pass vacuously. This is the
    // failure mode that makes a scan-the-tree test worthless, so it is asserted first.
    expect(files.length).toBeGreaterThan(200);
  });

  it('the detector can actually fire, and does not fire on the directory form', () => {
    // Without this, a regex that matched nothing would report a clean tree. Both arms
    // matter: the second pins the stated scope, so a later tightening that starts
    // flagging `new URL('..', …)` fails here instead of silently widening the rule.
    // Assembled rather than written out, so these fixtures do not trip the tree scan
    // above. The alternative — exempting this file — would reintroduce exactly the kind
    // of hand-maintained exception D#207 removed, on the one file that must not have one.
    const U = 'new URL';
    const bad = [
      `const p = ${U}('../hook.mjs', import.meta.url);`,
      `const p = ${U}(\`../\${f}.mjs\`, import.meta.url);`,
      `readFileSync(${U}('./sibling.js', import.meta.url), 'utf8');`,
    ];
    const ok = [
      `const root = ${U}('..', import.meta.url);`,
      "const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs');",
      `const u = ${U}('https://example.invalid/x.mjs');`,
    ];
    for (const s of bad) expect(URL_MODULE_PATH.test(s), `should flag: ${s}`).toBe(true);
    for (const s of ok) expect(URL_MODULE_PATH.test(s), `should NOT flag: ${s}`).toBe(false);
  });

  it('no source file names a module through new URL()', () => {
    // No allowlist, deliberately. Every site in the tree was converted in D#207, and an
    // exception here would be indistinguishable from the blind spot coming back.
    expect(findOffenders(files)).toEqual([]);
  });
});
