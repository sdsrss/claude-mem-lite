// Regression test: hook-update.mjs's SOURCE_FILES must stay aligned with
// install.mjs's SOURCE_FILES so auto-update never leaves a ~/.claude-mem-lite/
// install missing a file that runtime entry points statically import.
//
// Historical bug (v2.32.x memory audit): hook-llm.mjs:18 `import './lib/activity.mjs'`
// was added in v2.31 and wired into install.mjs SOURCE_FILES, but hook-update.mjs
// kept its own independent SOURCE_FILES list that was never updated. Npx/npm users
// on v2.30- auto-updating to v2.32+ would download the new hook-llm.mjs without
// lib/activity.mjs → ERR_MODULE_NOT_FOUND on next SessionStart.
//
// Fix: extract SOURCE_FILES to a single shared module, imported by both.
// This test asserts the shared list covers every module reachable from the runtime
// entry points, catching any future file added without being shipped.

import { test, expect } from 'vitest';
import { SOURCE_FILES, HOOK_SCRIPT_FILES, RELEASE_SIGNED_FILES } from '../source-files.mjs';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve, relative } from 'path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

// Modules that run from ~/.claude-mem-lite/ — every transitive static/dynamic
// import from any of these must be copied by install.mjs / hook-update.mjs.
const ENTRY_MODULES = ['cli.mjs', 'hook.mjs', 'server.mjs', 'mem-cli.mjs', 'install.mjs'];

function stripComments(src) {
  // Strip `// ...` line comments and `/* ... */` block comments so the
  // import regex doesn't false-fire on example strings inside docblocks.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function extractLocalImports(sourcePath) {
  const src = stripComments(readFileSync(sourcePath, 'utf8'));
  const out = new Set();
  // Match both same-dir (./) and parent (../) relative specifiers. Parent imports
  // are common from scripts/ (e.g. ../lib/foo.mjs) and within lib/ (../schema.mjs);
  // a ./-only pattern silently skipped them, hiding tarball-completeness gaps.
  for (const m of src.matchAll(/(?:from|import)\s+['"](\.\.?\/[^'"]+)['"]/g)) out.add(m[1]);
  for (const m of src.matchAll(/import\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g)) out.add(m[1]);
  return out;
}

function walk(entryRel, seen = new Set()) {
  if (seen.has(entryRel)) return seen;
  seen.add(entryRel);
  const abs = resolve(ROOT, entryRel);
  if (!existsSync(abs)) return seen;
  for (const rel of extractLocalImports(abs)) {
    const resolvedAbs = resolve(dirname(abs), rel);
    const relFromRoot = relative(ROOT, resolvedAbs);
    if (/\.(mjs|js)$/.test(relFromRoot)) walk(relFromRoot, seen);
  }
  return seen;
}

test('SOURCE_FILES covers every .mjs statically or dynamically imported by runtime entry points', () => {
  const shipped = new Set(SOURCE_FILES);
  const missing = [];
  for (const entry of ENTRY_MODULES) {
    for (const mod of walk(entry)) {
      if (mod === entry) continue;
      if (!/\.mjs$/.test(mod)) continue;
      if (!shipped.has(mod)) missing.push(`${mod} (reached from ${entry})`);
    }
  }
  const unique = [...new Set(missing)].sort();
  expect(unique, `\nsource-files.mjs SOURCE_FILES is missing:\n  ${unique.join('\n  ')}\n`).toEqual([]);
});

test('install.mjs and hook-update.mjs both reference the shared SOURCE_FILES module', () => {
  const installSrc = readFileSync(resolve(ROOT, 'install.mjs'), 'utf8');
  const hookUpdateSrc = readFileSync(resolve(ROOT, 'hook-update.mjs'), 'utf8');
  expect(installSrc).toMatch(/from\s+['"]\.\/source-files\.mjs['"]/);
  expect(hookUpdateSrc).toMatch(/from\s+['"]\.\/source-files\.mjs['"]/);
});

// scripts/launch.mjs is the MCP server's actual entry point. It statically imports
// ./launch-preflight.mjs and DYNAMICALLY imports ../lib/binding-probe.mjs +
// ../hook-update.mjs (v2.84 self-heal: rebuild native bindings / repair a partial
// install before launch). Its reachable set therefore spans both shipping
// mechanisms — same-dir files ride the scripts/ tree copy; parent files
// (binding-probe, hook-update, and their transitive deps) ride SOURCE_FILES — so
// the invariant is the union: every reachable .mjs must exist on disk and be
// EITHER under scripts/ OR in SOURCE_FILES. (Until the walker learned `../`, those
// parent imports were invisible and this asserted the stricter, wrong "under
// scripts/ only".)
test('scripts/launch.mjs transitive .mjs imports are all shipped (under scripts/ or in SOURCE_FILES)', () => {
  const shipped = new Set(SOURCE_FILES);
  const visited = walk('scripts/launch.mjs');
  const errors = [];
  for (const mod of visited) {
    if (!/\.mjs$/.test(mod)) continue;
    const abs = resolve(ROOT, mod);
    if (!existsSync(abs)) {
      errors.push(`${mod} — referenced from scripts/launch.mjs but missing on disk`);
      continue;
    }
    if (!mod.startsWith('scripts/') && !shipped.has(mod)) {
      errors.push(
        `${mod} — reachable from scripts/launch.mjs but neither under scripts/ nor in SOURCE_FILES`,
      );
    }
  }
  expect(errors, `\nscripts/launch.mjs companion-file invariant broken:\n  ${errors.join('\n  ')}\n`).toEqual(
    [],
  );
});

test('package.json files array ships source-files.mjs and every SOURCE_FILES entry', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const files = new Set(pkg.files);
  expect(files.has('source-files.mjs')).toBe(true);
  // package.json is implicitly included by npm in every tarball. package-lock.json
  // is the OPPOSITE: npm NEVER packs it, even when listed in files[] — registry
  // installs are locked via npm-shrinkwrap.json instead, generated from the
  // lockfile by `npm shrinkwrap` in the release workflow (see the guard test
  // below) rather than committed. SOURCE_FILES still lists both because
  // install.mjs copies them to INSTALL_DIR so `npm install` can run there —
  // a DIRECTORY install does honor package-lock.json.
  const NOT_PACKED_VIA_FILES = new Set(['package.json', 'package-lock.json']);
  const missingFromPkg = SOURCE_FILES.filter((f) => !files.has(f) && !NOT_PACKED_VIA_FILES.has(f));
  expect(
    missingFromPkg,
    `\npackage.json files missing SOURCE_FILES entries:\n  ${missingFromPkg.join('\n  ')}\n`,
  ).toEqual([]);
});

// Signed-but-unshipped bricks the npm shape. verifyReleaseFiles fail-CLOSES on a
// file listed in the manifest but absent from the extracted tarball
// (lib/release-digest.mjs), so a launcher/setup script added to
// RELEASE_SIGNED_FILES without also landing in package.json files[] would make
// every auto-update refuse to verify. Nothing enforced this pairing before
// v3.60.1 — scripts/binding-probe-cli.mjs got both by hand.
test('package.json files array ships every RELEASE_SIGNED_FILES entry', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const files = new Set(pkg.files);
  // Same carve-out as the SOURCE_FILES assertion above: npm packs package.json
  // implicitly and refuses to pack package-lock.json at all.
  const NOT_PACKED_VIA_FILES = new Set(['package.json', 'package-lock.json']);
  const signedButUnshipped = RELEASE_SIGNED_FILES.filter(
    (f) => !files.has(f) && !NOT_PACKED_VIA_FILES.has(f),
  );
  expect(
    signedButUnshipped,
    `\nsigned but missing from package.json files[]:\n  ${signedButUnshipped.join('\n  ')}\n`,
  ).toEqual([]);
});

// Drift guard for the lockless-registry-install fix: npm refuses to pack
// package-lock.json, so the ONLY way `npx claude-mem-lite` gets a locked
// dependency tree is the release workflow generating npm-shrinkwrap.json
// before pack/publish. If someone drops that step, installs silently float
// their transitive tree again with no local test failing.
test('release workflow generates npm-shrinkwrap before smoke and publish', () => {
  const wf = readFileSync(resolve(ROOT, '.github/workflows/publish.yml'), 'utf8');
  const shrinkwrapSteps = wf.match(/run: npm shrinkwrap/g) || [];
  expect(shrinkwrapSteps.length, 'both validate and publish jobs must shrinkwrap').toBeGreaterThanOrEqual(2);
  expect(wf.indexOf('npm shrinkwrap')).toBeLessThan(wf.indexOf('scripts/smoke-tarball.mjs'));
  // v3.58.0 shipped WITHOUT the shrinkwrap despite the workflow step running:
  // with a files[] whitelist, npm 10's packlist drops npm-shrinkwrap.json
  // unless it is EXPLICITLY listed (verified against npm 10.9.2; npm 12
  // removed the shrinkwrap command entirely, so a CI npm bump breaks the
  // workflow step loudly rather than silently unlocking installs). The entry
  // is harmless in dev where the file never exists.
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  expect(pkg.files, 'files[] must list npm-shrinkwrap.json or npm pack drops it').toContain(
    'npm-shrinkwrap.json',
  );
});

// v3.85.1: the release's headline change — both shipped `ci-gate.mjs` invocations running
// in strict mode — had zero test binding. The pre-tag correctness review deleted `--strict`
// from BOTH workflows, deleted the replay's counterexample gate, and gutted
// `assertCannotWrite`, all at once: 315 files / 5335 tests stayed green. Dropping
// `--strict` from publish.yml restores the exact v3.85.0 defect (a release gate passing on
// a baseline it has itself judged unreliable) with nothing in the repo making a sound.
//
// Same reasoning and same shape as the shrinkwrap guard above. Anchored to ACTIVE `run:`
// lines — not a substring scan of the file — because `expect(source).toMatch(/--strict/)`
// is satisfied by a comment or a usage line, which is precisely how two of that review's
// mutations walked past ci-gate.mjs's own source-scanning assertions.
test('both shipped ci-gate invocations run in strict mode', () => {
  const activeGateLines = (p) =>
    readFileSync(resolve(ROOT, p), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('#') && l.startsWith('run: node benchmark/ci-gate.mjs'));

  // publish.yml: unconditionally strict. This is the tag path — a stale baseline here means
  // the comparison guarding the release is untrustworthy, which is the whole argument.
  expect(
    activeGateLines('.github/workflows/publish.yml'),
    'publish.yml must invoke ci-gate.mjs exactly once, with --strict',
  ).toEqual(['run: node benchmark/ci-gate.mjs --strict']);

  // ci.yml: strict on push, advisory on pull_request, so the calendar never reds an
  // outside contributor's PR for a reason they cannot clear. The conditional itself is the
  // contract; assert it rather than just the presence of the word.
  const [ciLine, ...extra] = activeGateLines('.github/workflows/ci.yml');
  expect(ciLine, 'ci.yml has no active ci-gate run line').toBeTruthy();
  expect(extra, 'ci.yml must invoke ci-gate.mjs exactly once').toEqual([]);
  expect(ciLine).toMatch(/github\.event_name == 'push' && '--strict'/);
});

// v3.85.1: ci-gate.mjs must REJECT an unrecognised flag rather than ignore it. Measured
// before the guard existed, all against the same stale baseline: `--strict` exit 1,
// `-strict` exit 0, `--Strict` exit 0. A one-character typo in either workflow above
// silently downgraded the release gate to advisory while CI stayed green — and the test
// above pins the spelling, so the two guards only compose if this one holds too.
test('ci-gate rejects unknown flags instead of silently ignoring them', () => {
  const src = readFileSync(resolve(ROOT, 'benchmark/ci-gate.mjs'), 'utf8');
  expect(src, 'ci-gate.mjs must declare its known-flag allowlist').toMatch(/KNOWN_FLAGS\s*=\s*new Set\(/);
  const known = src.match(/KNOWN_FLAGS\s*=\s*new Set\(\[([^\]]*)\]/);
  expect(known, 'KNOWN_FLAGS must be a literal array').toBeTruthy();
  // Every flag either workflow actually passes must be in the allowlist, or the gate
  // refuses to run and the release breaks for the wrong reason.
  for (const flag of ['--strict', '--tolerance', '--baseline', '--skip-matrix']) {
    expect(known[1], `KNOWN_FLAGS is missing ${flag}`).toContain(flag);
  }
});

// Audit 2026-08-22 P2-3: the sandbox install harness now runs weekly in CI. The
// workflow names its three entry scripts as plain strings, so renaming or moving a
// phase leaves the schedule pointing at a file that no longer exists — and a weekly
// job only tells you that a week later, in mail nobody expected. Fail here instead.
test('weekly sandbox workflow points at phase scripts that exist', () => {
  const wf = readFileSync(resolve(ROOT, '.github/workflows/sandbox-install.yml'), 'utf8');
  const referenced = [...wf.matchAll(/tests\/sandbox\/(phase[A-Z][A-Za-z-]*\.mjs)/g)].map((m) => m[1]);
  expect(new Set(referenced)).toEqual(new Set(['phaseA-plugin.mjs', 'phaseB-npm.mjs', 'phaseC-update.mjs']));
  for (const f of new Set(referenced)) {
    expect(existsSync(resolve(ROOT, 'tests/sandbox', f)), `${f} referenced by the workflow but missing`).toBe(
      true,
    );
  }
});

// Blind-spot closer: the SOURCE_FILES coverage test above only walks the 5 main
// ENTRY_MODULES, so a lib/ module imported ONLY by a standalone hook script (e.g.
// scripts/pre-tool-recall.js) could be left out of SOURCE_FILES + files[] and
// silently dropped from the npm tarball — exactly how lib/file-intel.mjs and
// lib/reread-guard.mjs slipped through before this guard. Hook scripts have a
// mixed import model: lib/root deps ship via SOURCE_FILES; sibling scripts ship
// via the scripts/ directory copy. So every .mjs reachable from a hook script
// must be EITHER in SOURCE_FILES OR under scripts/ — the same union as launch.mjs
// above, now that the shared walk() follows `../`.
test('hook scripts: every transitive .mjs import is shipped (SOURCE_FILES or under scripts/)', () => {
  const shipped = new Set(SOURCE_FILES);
  const missing = [];
  for (const script of HOOK_SCRIPT_FILES) {
    if (!/\.(mjs|js)$/.test(script)) continue; // skip .sh
    const entry = `scripts/${script}`;
    for (const mod of walk(entry)) {
      if (!/\.mjs$/.test(mod)) continue;
      if (mod.startsWith('scripts/')) continue; // shipped via the scripts/ tree copy
      if (!shipped.has(mod)) missing.push(`${mod} (reached from ${entry})`);
    }
  }
  const unique = [...new Set(missing)].sort();
  expect(unique, `\nhook-script imports missing from SOURCE_FILES:\n  ${unique.join('\n  ')}\n`).toEqual([]);
});
