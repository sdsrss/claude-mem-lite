// Regression test: the lint gates must keep covering scripts/.
//
// Historical bug (v3.75.1): a stray `export` keyword in
// scripts/user-prompt-search.js landed before a comment block instead of its
// declaration, silently detaching one constant's export and attaching another's.
// No gate in the repo could see it, and the reason was structural rather than
// accidental:
//
//   - eslint listed `scripts/**` in its `ignores`, so 4470 lines across 17 files
//     were never linted at all — five of them (post-tool-use, pre-agent-inject,
//     pre-tool-recall, user-prompt-search) fire on every hook
//     event in production.
//   - knip DOES scan the directory, but knip.json lists `scripts/*.{mjs,js}` as
//     ENTRY points, and an entry point's exports are exempt from the
//     unused-export report by definition. So the v3.75.0 "byte-identical export
//     name set" measurement was true and still could not see this file.
//
// Un-ignoring the directory turned up five real errors immediately, one of them
// a lone-surrogate corruption reaching SQLite (index-managed.mjs). This file
// pins the gate open, and it takes TWO assertions to do that honestly: whether a
// file is ignored (`isPathIgnored`) is a necessary condition, not a sufficient
// one. Post-release review built a config that un-ignores scripts/ while scoping
// the strict rules to `**/*.mjs`, under which `eslint .` exits 0, the ignore case
// is green, and the v3.75.1 stray-`export` bug sails through. So the second case
// resolves the config per file (`calculateConfigForFile`) and asserts the rules
// are actually in force.
//
// The second half guards the sibling gate with the same failure mode: ci.yml
// enumerates the shellcheck targets by hand ("adding a shipped .sh means adding
// it HERE"), and pre-agent-inject.sh already spent a whole release outside that
// list. A hand-maintained list with no test is the defect, not the enumeration.

import { test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { ESLint } from 'eslint';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SCRIPTS_DIR = join(ROOT, 'scripts');

function scriptsMatching(re) {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => re.test(f))
    .sort();
}

test('eslint lints every JS file under scripts/ — the directory is not ignored', async () => {
  const jsFiles = scriptsMatching(/\.(mjs|js)$/);
  // Guard the guard: if the directory is ever emptied or renamed, an empty loop
  // would pass silently.
  expect(jsFiles.length).toBeGreaterThan(10);

  const eslint = new ESLint({ cwd: ROOT });
  const ignored = [];
  for (const f of jsFiles) {
    if (await eslint.isPathIgnored(join(SCRIPTS_DIR, f))) ignored.push(f);
  }
  expect(ignored).toEqual([]);
});

// Not-ignored is only half the resolver, and the half that proves nothing on its own.
// Post-release review demonstrated a config in which scripts/ is un-ignored, `eslint .`
// exits 0, the case above is green — and the five production hook scripts have lost
// eqeqeq / no-var / prefer-const / no-unreachable, so the very stray-`export` bug in this
// file's motivating story passes the gate this file exists to hold open.
// `calculateConfigForFile` is the other half: it answers whether a rule actually applies.
test('the project rules actually resolve to error for every JS file under scripts/', async () => {
  const RULES = ['eqeqeq', 'no-var', 'prefer-const', 'no-unreachable', 'no-unused-vars', 'no-undef'];
  const eslint = new ESLint({ cwd: ROOT });
  const severityOf = (entry) => (Array.isArray(entry) ? entry[0] : entry);

  const gaps = [];
  for (const f of scriptsMatching(/\.(mjs|js)$/)) {
    const cfg = await eslint.calculateConfigForFile(join(SCRIPTS_DIR, f));
    for (const rule of RULES) {
      const sev = severityOf(cfg?.rules?.[rule]);
      if (sev !== 2 && sev !== 'error') gaps.push(`${f}: ${rule}=${JSON.stringify(sev)}`);
    }
  }
  expect(gaps).toEqual([]);
});

test('every shipped shell script under scripts/ is in the ci.yml shellcheck command', () => {
  const shFiles = scriptsMatching(/\.sh$/);
  expect(shFiles.length).toBeGreaterThan(0);

  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  // Anchored to a line that ACTUALLY RUNS: a bare `.includes('run: shellcheck')` also
  // matches the same text commented out, so replacing the step with `run: echo skipping`
  // and leaving the original as a `#` comment kept this green (post-release review).
  const runLine = ci
    .split('\n')
    .map((l) => l.trim())
    .find((l) => !l.startsWith('#') && l.startsWith('run: shellcheck'));
  expect(runLine, 'ci.yml has no active `run: shellcheck` step').toBeTruthy();

  const missing = shFiles.filter((f) => !runLine.includes(`scripts/${f}`));
  expect(missing).toEqual([]);
});
