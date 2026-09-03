// One tree walk for every "this rule has ONE home" guard.
//
// Why this file exists: the v3.92.0 pre-tag test-effectiveness review found three guards
// (frontmatter, cite-recall path, symlink writes) that each swept a FIXED LIST of the file
// names the duplicate happened to occupy that day. Each one's header argued, correctly, that
// a unit test of the shared thing is not enough — and then implemented a sweep that is blind
// to the N+1th copy, which is the same defect from the other side. Two of them literally say
// "three copies existed because nothing stopped the third" while not stopping a fourth.
//
// Converting them meant three copies of a directory walk, so the walk lives here instead.
// The rule the guards encode is per-guard; the traversal is not.
//
// D#207: join(), never new URL('../X.mjs', import.meta.url) — the URL form makes knip blind
// to whatever module it names, and these files name shipped modules by construction.
import { readdirSync, statSync, readFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// `tests`, `benchmark`, `experiment` and `docs` are excluded because a guard's own fixture
// text would otherwise trip its own sweep; `tasks` holds working copies of shipped files
// (`tasks/bak-*/`) that are not shipped. Everything a user actually installs is in scope.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'coverage', 'tmp', '.tmp',
  'tasks', 'docs', 'tests', 'benchmark', 'experiment',
]);

/**
 * Every shipped `.mjs`/`.js` module, absolute paths.
 * @param {string} [dir] Root to walk (defaults to the repo root).
 * @returns {string[]}
 */
export function walkShipped(dir = REPO, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkShipped(full, out);
    else if (/\.(mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

/** Repo-relative path, with `/` separators, for allowlists and failure messages. */
export function relShipped(file) {
  return relative(REPO, file);
}

/**
 * A module's source with whole-line comments stripped, so a sweep does not fire on prose
 * that merely QUOTES the banned form — every one of these guards has a docblock that does.
 * Deliberately line-based: a trailing `// …` after real code keeps the code.
 */
export function sourceWithoutComments(file) {
  return readFileSync(file, 'utf8').split('\n')
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
}

/**
 * Sweep the shipped tree for `re`, skipping `allowed` (repo-relative paths).
 * @returns {string[]} repo-relative paths of offenders
 */
export function sweepShipped(re, allowed = new Set()) {
  const offenders = [];
  for (const file of walkShipped()) {
    const rel = relShipped(file);
    if (allowed.has(rel)) continue;
    // Reset a /g regex between files: `.test()` on a global regex is stateful, so without
    // this every second match would be missed and the sweep would under-report silently.
    re.lastIndex = 0;
    if (re.test(sourceWithoutComments(file))) offenders.push(rel);
  }
  return offenders;
}
