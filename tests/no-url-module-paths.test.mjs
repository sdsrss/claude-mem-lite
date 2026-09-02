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
// `export const __KNIP_PROBE__ = 1;` to a module and running knip once shows whether knip
// can see it. SIX modules were blind for this reason — hook-context, hook-memory,
// search-engine, hook-semaphore, hook-llm, cli-path (plus lib/binding-probe, found by the
// guard itself). Converting every site to join() and re-running took the report from 46
// unused exports to 57: eleven dead exports that had been hidden, in search-engine.mjs
// (7), hook-llm.mjs (2) and hook-context.mjs (2).
//
// `hook.mjs` was named as a seventh in the first version of this header and that was
// WRONG, in a way worth keeping: it is invisible for a SECOND, independent reason this
// rule does not touch — it is listed in `knip.json`'s `entry` array, and knip's
// `includeEntryExports` defaults to false. Converting its call sites changed nothing for
// it, and it is still unreported today, as are `server.mjs` and `install.mjs`. Caught by
// the pre-tag review; do not read a green run of this file as knip coverage of an entry.
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
const URL_MODULE_PATH = /new\s+URL\(\s*(['"`])\.{1,2}\/[^'"`]*\.(?:mjs|js)\1/g;

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

/**
 * Offending `file:line` for every match of the banned form.
 *
 * Scans the WHOLE FILE, not line by line. The first version did the latter and the
 * pre-tag review broke it in one move: splitting the call across lines —
 * `new URL(\n  '../tier.mjs',\n  import.meta.url,\n)`, ordinary formatting that no lint
 * rule here prevents — passed the guard green while knip went blind to `tier.mjs`. A
 * guard whose selling point is "no allowlist, scans the tree" must not be defeated by a
 * line wrap. Comment lines are stripped first (the rule is described in comments at every
 * conversion site), then the remainder is scanned as one string and each match's offset
 * is mapped back to a line number so the report still names a place.
 */
function findOffenders(files) {
  const hits = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes('new URL')) continue;
    // Blank out comment lines while PRESERVING offsets, so line numbers stay exact.
    const scannable = src.split('\n')
      .map((line) => (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? ' '.repeat(line.length) : line))
      .join('\n');
    URL_MODULE_PATH.lastIndex = 0;
    for (const m of scannable.matchAll(URL_MODULE_PATH)) {
      const line = scannable.slice(0, m.index).split('\n').length;
      hits.push(`${relative(REPO, f)}:${line}`);
    }
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
      // The wrapped form. The pre-tag review defeated the first version of this guard with
      // exactly this — green suite, knip blinded — so it is a fixture, not a hypothetical.
      `const p = ${U}(\n  '../tier.mjs',\n  import.meta.url,\n);`,
    ];
    const ok = [
      `const root = ${U}('..', import.meta.url);`,
      "const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs');",
      `const u = ${U}('https://example.invalid/x.mjs');`,
    ];
    // `URL_MODULE_PATH` is global, so `.test` advances `lastIndex` between calls and a
    // shared regex silently starts skipping matches. Reset before each probe — this is
    // the failure that makes a detector self-check report a false clean.
    const fires = (s) => { URL_MODULE_PATH.lastIndex = 0; return URL_MODULE_PATH.test(s); };
    for (const s of bad) expect(fires(s), `should flag: ${s}`).toBe(true);
    for (const s of ok) expect(fires(s), `should NOT flag: ${s}`).toBe(false);
  });

  it('no source file names a module through new URL()', () => {
    // No allowlist, deliberately. Every site in the tree was converted in D#207, and an
    // exception here would be indistinguishable from the blind spot coming back.
    expect(findOffenders(files)).toEqual([]);
  });
});
