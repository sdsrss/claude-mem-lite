#!/usr/bin/env node
const CLI_COMMANDS = new Set([
  'search',
  'recent',
  'recall',
  'get',
  'timeline',
  'save',
  'stats',
  'context',
  'browse',
  'citation-stats',
  'delete',
  'update',
  'export',
  'restore',
  'compress',
  'maintain',
  'optimize',
  'fts-check',
  'import-jsonl',
  'activity',
  'adopt',
  'unadopt',
  'memdir-audit',
  'defer',
  'help',
]);
// Removed with the skill/agent resource registry (docs/audits/20260906-145304.md).
// Kept as a named set so a stale script or muscle-memory invocation gets the reason rather
// than a bare "Unknown command" plus a misleading edit-distance suggestion.
const REMOVED_COMMANDS = new Set(['registry', 'import', 'enrich']);

// D#26 / R12 P1-1, second half. `doctor` and `repair` exist to tell a user which
// file their install is missing. Until now, on exactly that install, they did not
// run: install.mjs's ~13 static imports resolve BEFORE its first line executes, so
// one absent module killed the command with a bare ERR_MODULE_NOT_FOUND and zero
// bytes of stdout. A half-finished update, a trimmed tarball (this repo has
// shipped three) or a hand-deleted file all land there — CLAUDE.md's "a recovery
// path must not import the thing it recovers", on the startup edge.
//
// A static import cannot be caught inside the module that declares it, so the
// catch lives one entry up. THIS file is the host because it is the published
// `bin` and because its own static closure is one file — itself; every route
// below is an `await import()`. Whatever this prints must therefore rely on
// nothing but the language, the same charter scripts/hook-launcher.mjs follows:
// no local import may appear here, or the fallback shares the fate it reports on.
//
// The remedy is deliberately NOT `install.mjs repair` — that is the file that
// would not load. It has to come from outside the broken tree.
async function loadInstaller() {
  try {
    return await import('./install.mjs');
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    // `url` is the missing specifier; the message is the fallback for shapes that
    // do not carry it. Never reprint the raw error: the stack is what this exists
    // to replace.
    const missing = e.url
      ? e.url.replace(/^file:\/\//, '')
      : String(e.message || '').split("'")[1] || 'a module';
    const w = (s) => process.stderr.write(`[claude-mem-lite] ${s}\n`);
    w(`This install is incomplete — it is missing: ${missing}`);
    w('That is why this command cannot run: the file is loaded before any of its code executes.');
    w('Repair: npm install -g claude-mem-lite@latest --force');
    w('Or, in Claude Code: /plugin uninstall claude-mem-lite && /plugin install claude-mem-lite@sdsrss');
    process.exit(1);
  }
}
const INSTALL_COMMANDS = new Set([
  'install',
  'uninstall',
  'status',
  'doctor',
  'cleanup',
  'cleanup-hooks',
  'self-update',
  'repair',
  'rebuild-binding',
  'release',
]);

const cmd = process.argv[2];

// `version` and `-V` are aliases, not extra syntax: the bare subcommand is what a user
// types first (`claude-mem-lite version`), and it is far enough from every real command
// name that the edit-distance suggester below fell through to the generic
// "Run help / Run install" line — a wrong answer to a question the CLI can answer.
if (cmd === '--version' || cmd === '-v' || cmd === '-V' || cmd === 'version') {
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
  process.stdout.write(`claude-mem-lite v${pkg.version}\n`);
} else if (cmd === '--help' || cmd === '-h') {
  const { run } = await import('./mem-cli.mjs');
  await run(['help']);
} else if (
  cmd === 'doctor' &&
  process.argv.slice(3).some((a) => a === '--benchmark' || a === '--metrics' || a === '--session-audit')
) {
  // Per #8217: the DB-layer doctor modes (--benchmark / --metrics / --session-audit,
  // each implemented in cli/doctor.mjs) route to mem-cli. Everything else — plain
  // `doctor`, `doctor --` (POSIX end-of-options), and `doctor --json` — stays with
  // install.mjs's health-check, which OWNS --json (install.mjs doctor() line ~1216).
  // Pre-fix the router forwarded ANY flagged `doctor --X` to mem-cli, so the documented
  // `doctor --json` (install health JSON, advertised in install.mjs usage) was shadowed
  // and rejected by cli/doctor.mjs. Gating on the three DB-layer flags keeps --json
  // (and any future install-doctor flag) on the install path. Adding a NEW DB-layer
  // mode requires extending this list — a deliberate trade for a working --json.
  const { run } = await import('./mem-cli.mjs');
  await run(process.argv.slice(2));
} else if (CLI_COMMANDS.has(cmd)) {
  const { run } = await import('./mem-cli.mjs');
  await run(process.argv.slice(2));
} else if (!cmd) {
  // No command: show CLI help if installed, install help if not
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  // D#29: honor CLAUDE_MEM_DIR so the install-vs-CLI help routing is correct on
  // relocated installs (matches schema.mjs DB_DIR via the shared resolver, which
  // also fixes the HOME-unset relative-path fallback this branch used to have).
  const { resolveDataDir } = await import('./lib/resolve-data-dir.mjs');
  const dataDir = resolveDataDir(process.env.CLAUDE_MEM_DIR);
  const dbPath = join(dataDir, 'claude-mem-lite.db');
  if (existsSync(dbPath)) {
    const { run } = await import('./mem-cli.mjs');
    await run(['help']);
  } else {
    const { main } = await loadInstaller();
    await main([]);
  }
} else if (INSTALL_COMMANDS.has(cmd)) {
  const { main } = await loadInstaller();
  await main(process.argv.slice(2));
} else if (REMOVED_COMMANDS.has(cmd)) {
  // Released-artifact discoverability signal for the skill-registry removal. Deliberately
  // names NO version: this ships before the version is decided, and a hardcoded one is a
  // guess in a third place (package.json and the CHANGELOG heading being the other two).
  // The revert instruction is version-specific and correct, which is what a user needs.
  // Deliberately NOT routed through the edit-distance suggester below: its nearest
  // match for `import` is `import-jsonl`, a different feature that accepts a path
  // argument, so a stale `import <github-url>` would be pointed at something that
  // could plausibly run. Naming the removal is the only honest answer.
  process.stderr.write(
    `[mem] "${cmd}" was removed along with the skill/agent resource registry.\n` +
      "[mem] Claude Code's own plugins/marketplace replace it. See CHANGELOG.md for the\n" +
      '[mem] migration note; to revert, pin claude-mem-lite@4.0.4.\n',
  );
  process.exit(1);
} else {
  process.stderr.write(`[mem] Unknown command: "${cmd}"\n`);
  // Suggest closest command by edit distance
  const allCmds = [...CLI_COMMANDS, ...INSTALL_COMMANDS];
  let best = null,
    bestDist = Infinity;
  for (const c of allCmds) {
    const a = cmd.toLowerCase(),
      b = c;
    const m = a.length,
      n = b.length;
    if (Math.abs(m - n) > 2) continue;
    const d = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0),
        );
    if (d[m][n] < bestDist) {
      bestDist = d[m][n];
      best = c;
    }
  }
  if (best && bestDist <= 2) {
    process.stderr.write(`[mem] Did you mean: ${best}?\n`);
  } else {
    process.stderr.write(
      '[mem] Run "claude-mem-lite help" for CLI commands or "claude-mem-lite install" for setup\n',
    );
  }
  process.exitCode = 1;
}
