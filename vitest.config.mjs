import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20000,
    // D#168. Vitest's default discovery globs the whole repo, so a scratch file named
    // `*.test.mjs` under `tmp/` — the project's own gitignored scratch dir and a §5
    // safe-path — is collected and RUN as part of the suite. Restating the defaults is
    // required: supplying `exclude` REPLACES them rather than appending. On vitest 4.1.6
    // `configDefaults.exclude` is only `['**/node_modules/**', '**/.git/**']` (verified,
    // not assumed — an earlier version of this comment quoted the vitest 2.x list); the
    // extra entries below are a deliberate superset kept for the day that shrinks again.
    // Pinned by tests/vitest-config-exclude.test.mjs.
    // The two repo-walking invariant scanners (tests/time-constants.test.mjs,
    // tests/obs-types-invariant.test.mjs) skip `tmp` for the same reason, each pinned by
    // its own probe case.
    exclude: [
      // The installed vitest's two actual defaults, verbatim. The brace form below is a
      // superset in behaviour but a DIFFERENT string, and the guard compares strings —
      // which is how it caught `**/.git/**` being silently dropped here.
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      // `tasks/**` for the same reason as `tmp/**` (audit 2026-09-02 P2-1): it is
      // gitignored scratch, and it currently holds `tasks/bak-3810/*.mjs` — whole-file
      // BACKUP COPIES of shipped modules. A `*.test.mjs` parked there would be collected
      // and run, and a backup copy of a module is exactly the thing that must never be
      // mistaken for the module. D#168 closed this hole for `tmp/` and stopped there.
      'tmp/**',
      '.tmp/**',
      'tasks/**',
    ],
    // D#40: the CLI auto-escalation path is default-ON in production but must
    // never spawn a real `claude` subprocess during the suite. This forces
    // autoDeepLlmReady's CLI branch off in every worker; tests that exercise the
    // auto path inject a stub llm or mock haiku-client instead.
    //
    // Hermetic LLM mode: a dev/CI shell that exports a real ANTHROPIC_API_KEY /
    // OPENROUTER_API_KEY flips detectMode() to 'api'/'openrouter', so any un-mocked
    // LLM path would make a REAL network call — non-deterministic (rate-limit flakes),
    // slow, and billable. haiku-client.test.mjs + e2e.test.mjs already stub these
    // per-file ("the dev/CI shell may export a real key"); force them empty GLOBALLY
    // so no test can leak a live call by forgetting to. Tests that exercise keyed
    // mode override locally via vi.stubEnv (which restores to '' after each test).
    // Same systemic-scrub rationale for the two #8608-class leak vars (audit 2026-07-17
    // MED-5): MEM_QUIET_HOOKS=1 in a dev shell leaks into every spawned hook subprocess
    // (…process.env spread) and silently flips descriptive-stdout assertions; CLAUDE_MEM_DIR
    // overrides the HOME-based data dir (resolveDataDir), so a dev who relocated their real
    // DB would have e2e subprocesses read/write it. Tests that exercise these vars set them
    // explicitly (vi.stubEnv or child env), which overrides this global ''.
    // CLAUDE_MEM_TEST_GUARD (audit 2026-08-22 P2-4): clearing CLAUDE_MEM_DIR stops a
    // relocated dev DB from being READ, but a test that never sets the var resolves the
    // default — the maintainer's real ~/.claude-mem-lite — and writes to it. That
    // happened during the v3.73.0 release. With the guard on, lib/resolve-data-dir.mjs
    // REDIRECTS the live data dir to a per-run sandbox — in this process AND in every
    // subprocess that inherits the ambient env (the same channel by which the var goes
    // missing). It blocks exactly one directory, the real one; it does NOT refuse
    // everything outside os.tmpdir(), which was an earlier design that resolve-data-dir's
    // own comment explains at length was wrong (fixtures hardcode /tmp, os.tmpdir()
    // follows a relocated $TMPDIR, several suites keep scratch DBs in tests/.tmp-*).
    env: {
      CLAUDE_MEM_AUTO_DEEP_CLI: '0',
      ANTHROPIC_API_KEY: '',
      OPENROUTER_API_KEY: '',
      MEM_QUIET_HOOKS: '',
      CLAUDE_MEM_DIR: '',
      CLAUDE_MEM_TEST_GUARD: '1',
    },
    // Reap test-fixture dirs leaked by prior interrupted/SIGKILL'd runs (afterEach
    // never reached). Runs once before the suite; 1h age guard never touches the
    // current run. See lib/tmp-fixture-sweep.mjs.
    globalSetup: ['./tests/global-setup.mjs'],
    coverage: {
      provider: 'v8',
      // Audit 2026-08-22 P2-2: this list used to be 22 hand-picked root modules, so
      // "77.47% covered" described a curated subset while lib/'s ~70 shipped modules
      // — every extracted shared core since v3.4x — had no coverage signal at all.
      // lib/** is now in scope; the thresholds below were re-baselined against the
      // real number rather than the subset's.
      //
      // The excluded entry files are exercised through E2E/subprocess tests, which v8
      // coverage of the parent process cannot see — so including them would measure the
      // harness rather than the code. Audit 2026-09-02 P1-15 challenged that rationale as
      // expired for three of four, on the grounds that 13 / 13 / 9 test files import
      // install.mjs / server.mjs / registry.mjs IN-PROCESS. Measured rather than argued
      // (2026-09-03, whole suite, each file temporarily added to `include`):
      //
      //     install.mjs    11.67% stmts / 10.22% lines    rationale HOLDS
      //     server.mjs     25.89% stmts / 27.54% lines    rationale HOLDS
      //     registry.mjs   86.78% stmts / 90.27% lines    rationale EXPIRED
      //
      // Importing a module is not exercising it: the thirteen files that import
      // install.mjs reach an eighth of it. registry.mjs was the one the finding was right
      // about, and it went IN — which RAISED the totals (84.32% → 84.38% stmts), because a
      // well-covered file had simply been invisible. Adding all three would have dropped
      // statements to 71.05% and blown every threshold, i.e. measured the harness exactly
      // as this comment always claimed.
      //
      // registry.mjs itself was DELETED with the skill registry, so its `include`
      // entry went with it. The install.mjs / server.mjs / hook.mjs rationale above is
      // unaffected and still the reason those three stay out.
      //
      // NOTE: these three were listed in BOTH `include`-absent and `exclude`. `include`
      // below is an explicit allowlist that never named them, so their `exclude` entries
      // were belt-and-braces and removing one changed nothing — which is worth knowing
      // before anyone "fixes" scope by editing `exclude` alone and measures no difference.
      include: [
        'lib/**/*.mjs',
        'utils.mjs',
        'schema.mjs',
        'search-scoring.mjs',
        'mem-cli.mjs',
        'hook-episode.mjs',
        'hook-context.mjs',
        'hook-semaphore.mjs',
        'hook-shared.mjs',
        'hook-llm.mjs',
        'haiku-client.mjs',
        'format-utils.mjs',
        'hash-utils.mjs',
        'bash-utils.mjs',
        'secret-scrub.mjs',
        'project-utils.mjs',
        'tier.mjs',
        'tfidf.mjs',
        'nlp.mjs',
        'stop-words.mjs',
        'synonyms.mjs',
      ],
      // Entry files and MCP-only modules tested via E2E/integration, not unit coverage.
      // `experiment/**` is listed because the `lib/**/*.mjs` include above is NOT anchored
      // to the repo root — it also matches `experiment/lib/*.mjs`, an unshipped scratch dir
      // that would otherwise drag the gate down with code nothing ships.
      exclude: ['install.mjs', 'server.mjs', 'hook.mjs', 'benchmark/**', 'scripts/**', 'experiment/**'],
      // Re-baselined 2026-08-22 against the measured number, which the P2-2 re-scoping
      // had left 12 points below: the gate said 75/75/65 while the suite actually ran
      // 86.58 lines / 87.42 functions / 77.22 branches, i.e. coverage could fall by a
      // ninth of the codebase without anything going red. Each threshold now sits ~3
      // points under its measurement — tight enough that a real regression trips it,
      // loose enough that ordinary refactoring does not. `statements` is pinned too;
      // it was simply absent before.
      //
      // Raise these when the measurement rises. Lowering one is a decision that belongs
      // in a commit message, not a quiet edit.
      thresholds: {
        statements: 80,
        lines: 83,
        functions: 84,
        branches: 74,
      },
    },
  },
});
