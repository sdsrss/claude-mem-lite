import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node.js globals
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        performance: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `no-shadow`: MEASURED AND DECLINED (audit 2026-09-02 P2-17 recommended it).
      // 70 violations tree-wide, 16 in shipped source + 1 in tests/sandbox, 54 under
      // tests/. Enumerated rather than counted, because the shape matters:
      //
      //   install.mjs:1530-1533  ok/warn/fail/log — THE AUDIT'S HEADLINE EXAMPLE, and it
      //     is the design, not a defect. `doctor()` shadows the file-level helpers on
      //     purpose so every existing call site captures into `checks` instead of
      //     printing; that IS how `--json` works, and the code says so two lines above.
      //     The rule would force a disable comment on a documented mechanism or ~40
      //     renames to undo it.
      //   server.mjs ×6         a handler parameter named `db` over the module-level
      //     `db`. Idiomatic, scoped, and the rename makes every call site read worse.
      //   install.mjs ×3        `cmd`, same shape.
      //
      // That leaves two or three marginal renames. A rule whose first-listed hit is a
      // deliberate mechanism is a rule that gets disabled by the next person rather than
      // obeyed — which is the reasoning this config already applies to `no-param-reassign`
      // and `require-await`. The one genuinely confusing case (`raw` reused inside
      // hook.mjs handleUserPrompt for a file's contents) was renamed by hand instead.
      'no-unreachable': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // Intentional empty catch blocks are a common pattern in this codebase
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Relax rules for test files
  {
    files: ['**/*.test.mjs', '**/test-helpers.mjs'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  // Ignore non-source files.
  //
  // `scripts/**` is deliberately NOT here. It was, for the whole life of this
  // config, and that hid 4470 lines across 17 files — five of them (post-tool-use,
  // pre-agent-inject, pre-tool-recall, pre-skill-bridge, user-prompt-search) fire
  // on every hook event in production. The v3.75.1 stray-`export` bug lived there
  // and no gate in the repo could see it: eslint skipped the directory outright,
  // and knip lists `scripts/*.{mjs,js}` as ENTRY points, whose exports are exempt
  // from the unused-export report by definition. Un-ignoring cost five fixes.
  // Adding a directory here means deciding its code may rot unchecked.
  {
    // `tasks/**` is gitignored scratch (specs, plans, paused-task notes) and it holds
    // `tasks/bak-3810/*.mjs` — whole-file BACKUP COPIES of shipped modules. Linting those
    // reports findings against code that is not in the build, and "fixing" one edits a
    // backup. The warning above still applies to every OTHER entry in this list: adding a
    // directory here decides its code may rot unchecked. This one has no code to rot —
    // nothing imports it and nothing ships it (audit 2026-09-02 P2-1; D#168 closed the
    // same hole for `tmp/`).
    ignores: ['node_modules/**', 'coverage/**', 'benchmark/**', '.tmp/**', 'tmp/**', 'docs/**', 'tasks/**'],
  },
];
