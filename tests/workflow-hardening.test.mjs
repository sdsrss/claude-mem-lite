// Audit 2026-09-02 P2-19. Three properties of the GitHub Actions workflows, guarded because
// each one regresses the same way — silently, by someone writing the ordinary form.
//
//   1. Every `uses:` is pinned to a 40-char commit SHA. A mutable tag (`@v5`) means the
//      code that runs in CI, with the repo checked out and npm tokens in scope, is whatever
//      the tag points at TODAY. `softprops/action-gh-release` was already pinned; the
//      first-party `actions/*` were not, which is the more common half of this shape
//      because first-party feels safe.
//   2. Every workflow declares `permissions:`. The default token is broadly scoped, and
//      `ci.yml` — the one that had no block — is the one that runs on `pull_request`.
//   3. A pinned SHA without an updater becomes an unpatched SHA, so `.github/dependabot.yml`
//      must exist and cover both ecosystems.
//
// This is a text guard, and this repo has recorded both directions in which those fail (the
// anchored thing moves; the rule is bypassed by an alias). It is used here anyway because
// the property IS textual — "the workflow file names a SHA" is not observable at runtime
// from inside the test suite, and the alternative is no guard at all. The failure mode it
// cannot see is a workflow file added outside `.github/workflows/`, which GitHub would not
// run either.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO } from './shipped-tree.mjs';

const WF_DIR = join(REPO, '.github', 'workflows');
const workflows = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

// `uses: owner/repo@ref` — the ref is what this file is about. Docker/local `uses:` forms
// (`docker://`, `./`) are deliberately out of scope; there are none today and they are not
// third-party code fetched by a moving name.
const USES_RE = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm;

describe('GitHub Actions workflows are hardened', () => {
  it('the walk found the workflows (premise)', () => {
    // Every assertion below iterates this list. An empty or mis-globbed read would make all
    // of them pass while checking nothing.
    expect(workflows.length).toBeGreaterThanOrEqual(3);
    expect(workflows).toContain('ci.yml');
    expect(workflows).toContain('publish.yml');
  });

  it('every `uses:` is pinned to a full commit SHA', () => {
    const unpinned = [];
    let total = 0;
    for (const f of workflows) {
      const src = readFileSync(join(WF_DIR, f), 'utf8');
      USES_RE.lastIndex = 0;
      for (const m of src.matchAll(USES_RE)) {
        // The header says docker/local forms are out of scope; the first cut did not
        // IMPLEMENT that, so a legitimate local composite action would have turned this
        // guard red for a correct change — the false-alarm direction. Skipped before
        // `total++` so they cannot pad the premise count either.
        // LOCAL paths only. `docker://node:20` was exempted too, but the justification —
        // "not third-party code fetched by a moving name" — is true of `./` and false of a
        // mutable docker tag, which is the same supply-chain shape as `@v5`.
        if (/^\.{1,2}\//.test(m[1])) continue;
        total++;
        const ref = m[1].split('@')[1];
        if (!/^[0-9a-f]{40}$/.test(ref || '')) unpinned.push(`${f}: ${m[1]}`);
      }
    }
    // Premise: the matcher found actions at all. A regex that matched nothing would report
    // a fully pinned tree, which is the exact "0 findings reads as clean" failure this repo
    // keeps recording.
    expect(total, 'no `uses:` found — the matcher is broken, not the tree clean').toBeGreaterThan(10);
    expect(unpinned).toEqual([]);
  });

  it('every pinned SHA carries a version comment, so a human can read the diff', () => {
    // A bare 40-char SHA is unreviewable: nothing in the diff says whether
    // `fbc6f39…` → `3d3c42e…` is a patch or a major. Dependabot writes this comment and
    // keeps it in step; requiring it means a hand-edit that drops it goes red.
    const missing = [];
    for (const f of workflows) {
      for (const line of readFileSync(join(WF_DIR, f), 'utf8').split('\n')) {
        if (/uses:\s*\S+@[0-9a-f]{40}/.test(line) && !/#\s*v?\d+\.\d+/.test(line)) {
          missing.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every workflow declares a permissions block', () => {
    const without = workflows.filter((f) => !/^\s*permissions:/m.test(readFileSync(join(WF_DIR, f), 'utf8')));
    expect(without).toEqual([]);
  });

  it('the top-level default in ci.yml is read-only', () => {
    // Not just "a block exists": a block granting write would satisfy the case above while
    // being the thing it is meant to prevent.
    const src = readFileSync(join(WF_DIR, 'ci.yml'), 'utf8');
    const block = src.match(/^permissions:\n((?:\s+\S.*\n)+)/m);
    expect(block, 'ci.yml has no top-level permissions block').toBeTruthy();
    expect(block[1]).toMatch(/contents:\s*read/);
    expect(block[1], 'ci.yml grants a write scope by default').not.toMatch(/:\s*write/);
  });

  it('dependabot covers both npm and the actions themselves', () => {
    const p = join(REPO, '.github', 'dependabot.yml');
    expect(existsSync(p), 'pinned SHAs with no updater become unpatched SHAs').toBe(true);
    const src = readFileSync(p, 'utf8');
    expect(src).toMatch(/package-ecosystem:\s*npm/);
    expect(src).toMatch(/package-ecosystem:\s*github-actions/);
  });

  it('the version-consistency check runs before the expensive steps in publish.yml', () => {
    // It gates a MISTAGGED release and depends on nothing lint/tests produce. Running it
    // after the coverage suite only delays the verdict.
    const src = readFileSync(join(WF_DIR, 'publish.yml'), 'utf8');
    const verify = src.indexOf('name: Verify version consistency');
    const lint = src.indexOf('name: Lint');
    const tests = src.indexOf('name: Run tests with coverage');
    expect(verify).toBeGreaterThan(-1);
    expect(lint).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(lint);
    expect(verify).toBeLessThan(tests);
  });
});
