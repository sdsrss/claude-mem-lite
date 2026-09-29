// Vitest setupFiles (runs in every test worker, before each test file): drop the GIT_*
// variables a parent git process exported.
//
// `git commit` runs .githooks/pre-commit with GIT_DIR / GIT_INDEX_FILE (and friends) in the
// environment, and the hook runs this suite. Several tests build a fixture repo with
// `git init` in a mkdtemp dir; with an inherited GIT_DIR, `git init` does not create a repo
// there — it RE-INITIALISES the one GIT_DIR names. From the main checkout GIT_DIR is the
// relative `.git`, which resolves inside the fixture and hid the defect. From a linked
// worktree it is the absolute `.git/worktrees/<name>`, so the suite rewrote the SHARED
// repository config to `core.bare = true` and every checkout of the repo stopped working
// ("fatal: this operation must be run in a work tree") — hit twice on 2026-09-26 while
// three worktree branches committed concurrently.
//
// tests/git-state.test.mjs already stripped these for its own calls; that was one file's
// discipline, and four other files did not have it. Stripping here makes it the
// environment every test starts from. The main process (globalSetup and the green-stamp
// reporter, which need the real index) is untouched: setupFiles run in workers only.
for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) {
  delete process.env[k];
}
