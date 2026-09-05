#!/usr/bin/env node
const CLI_COMMANDS = new Set(['search', 'recent', 'recall', 'get', 'timeline', 'save', 'stats', 'context', 'browse', 'citation-stats', 'delete', 'update', 'export', 'restore', 'compress', 'maintain', 'optimize', 'fts-check', 'registry', 'import', 'import-jsonl', 'enrich', 'activity', 'adopt', 'unadopt', 'memdir-audit', 'defer', 'help']);
const INSTALL_COMMANDS = new Set(['install', 'uninstall', 'status', 'doctor', 'cleanup', 'cleanup-hooks', 'self-update', 'repair', 'rebuild-binding', 'release']);

const cmd = process.argv[2];

if (cmd === '--version' || cmd === '-v') {
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
  process.stdout.write(`claude-mem-lite v${pkg.version}\n`);
} else if (cmd === '--help' || cmd === '-h') {
  const { run } = await import('./mem-cli.mjs');
  await run(['help']);
} else if (cmd === 'doctor' && process.argv.slice(3).some(a => a === '--benchmark' || a === '--metrics' || a === '--session-audit')) {
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
    const { main } = await import('./install.mjs');
    await main([]);
  }
} else if (INSTALL_COMMANDS.has(cmd)) {
  const { main } = await import('./install.mjs');
  await main(process.argv.slice(2));
} else {
  process.stderr.write(`[mem] Unknown command: "${cmd}"\n`);
  // Suggest closest command by edit distance
  const allCmds = [...CLI_COMMANDS, ...INSTALL_COMMANDS];
  let best = null, bestDist = Infinity;
  for (const c of allCmds) {
    const a = cmd.toLowerCase(), b = c;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) continue;
    const d = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] !== b[j-1] ? 1 : 0));
    if (d[m][n] < bestDist) { bestDist = d[m][n]; best = c; }
  }
  if (best && bestDist <= 2) {
    process.stderr.write(`[mem] Did you mean: ${best}?\n`);
  } else {
    process.stderr.write('[mem] Run "claude-mem-lite help" for CLI commands or "claude-mem-lite install" for setup\n');
  }
  process.exitCode = 1;
}
