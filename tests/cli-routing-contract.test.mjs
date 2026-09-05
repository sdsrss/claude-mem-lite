// Static contract test for the CLI routing chain: cli.mjs CLI_COMMANDS Set,
// mem-cli.mjs run() dispatch (switch + early-return ifs), and cmdHelp() docs
// must stay in sync. Adding a subcommand requires THREE edits (lesson #8414);
// this test fails fast when any one of them is forgotten. Pure source parsing
// — no DB, no subprocess, no schema setup.
//
// Background: v2.71.0 shipped `import-jsonl` with mem-cli.mjs handler + help
// text but no entry in cli.mjs CLI_COMMANDS, so the command was unreachable
// from the actual CLI binary. tests/cli-import-jsonl-e2e.test.mjs locks the
// individual route. This file generalises it to ALL subcommands.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CLI_SRC = readFileSync(resolve('cli.mjs'), 'utf8');
const MEM_CLI_SRC = readFileSync(resolve('mem-cli.mjs'), 'utf8');

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseCliCommands(src) {
  const m = src.match(/CLI_COMMANDS\s*=\s*new Set\(\[([^\]]+)\]\)/);
  if (!m) throw new Error('Could not locate CLI_COMMANDS Set in cli.mjs');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function parseMemCliHandlers(src) {
  const start = src.indexOf('export async function run(');
  if (start < 0) throw new Error('Could not locate run() in mem-cli.mjs');
  const body = src.slice(start);

  const cases = [...body.matchAll(/case\s+'([a-z][a-z0-9-]*)':/g)].map((m) => m[1]);
  // Match any `cmd === 'X'` — covers both leading `if (cmd === 'adopt')` form
  // and chained `if (!cmd || cmd === 'help' || cmd === '--help')`. The
  // `[a-z][a-z0-9-]*` anchor naturally skips `--help`/`-h` flag aliases.
  const cmpEqs = [...body.matchAll(/cmd\s*===\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);

  return new Set([...cases, ...cmpEqs]);
}

function parseHelpDocumentedCommands(src) {
  const start = src.indexOf('function cmdHelp() {');
  if (start < 0) throw new Error('Could not locate cmdHelp() in mem-cli.mjs');
  const after = src.slice(start);
  const tplMatch = after.match(/out\(`([\s\S]+?)`\)/);
  if (!tplMatch) throw new Error('Could not parse cmdHelp template literal');
  const helpText = tplMatch[1];

  // Command sections are 2-space indented identifiers; flags/subcommands are
  // 4+ spaces. `[a-z][a-z0-9-]*` covers `fts-check`, `import-jsonl`, etc.
  return new Set([...helpText.matchAll(/^ {2}([a-z][a-z0-9-]*)\b/gm)].map((m) => m[1]));
}

// ─── Contract assertions ─────────────────────────────────────────────────────

describe('CLI routing contract (#8414 — three-edits invariant)', () => {
  it('every cli.mjs CLI_COMMANDS entry has a handler in mem-cli.mjs run()', () => {
    const cliCmds = parseCliCommands(CLI_SRC);
    const handlers = parseMemCliHandlers(MEM_CLI_SRC);
    const orphaned = cliCmds.filter((c) => !handlers.has(c));
    expect(
      orphaned,
      `cli.mjs CLI_COMMANDS routes these to mem-cli.mjs but run() has no handler — they hit the switch default ("Unknown command"): ${orphaned.join(', ')}`,
    ).toEqual([]);
  });

  it('every mem-cli.mjs run() handler is reachable from cli.mjs', () => {
    const cliCmds = new Set(parseCliCommands(CLI_SRC));
    const handlers = parseMemCliHandlers(MEM_CLI_SRC);

    // doctor lives in INSTALL_COMMANDS; cli.mjs:16 reroutes `doctor --<flag>`
    // to mem-cli.mjs (single-source-of-truth per #8217). Reachable, just not
    // via CLI_COMMANDS.
    const ROUTED_OUTSIDE_CLI_COMMANDS = new Set(['doctor']);

    const unreachable = [...handlers].filter((h) => !cliCmds.has(h) && !ROUTED_OUTSIDE_CLI_COMMANDS.has(h));
    expect(
      unreachable,
      `mem-cli.mjs run() handles these but cli.mjs CLI_COMMANDS doesn't gate them — silently unreachable via the CLI binary (regression class of v2.71.0 import-jsonl, #8414): ${unreachable.join(', ')}`,
    ).toEqual([]);
  });

  it('every cli.mjs CLI_COMMANDS entry is documented in cmdHelp() output', () => {
    const cliCmds = parseCliCommands(CLI_SRC);
    const documented = parseHelpDocumentedCommands(MEM_CLI_SRC);

    // `help` is the help command itself; cmdHelp doesn't need to document
    // itself (it's the output). Allow either way.
    const undocumented = cliCmds.filter((c) => c !== 'help' && !documented.has(c));
    expect(
      undocumented,
      `cli.mjs CLI_COMMANDS exposes these subcommands but cmdHelp() never lists them — users running 'claude-mem-lite help' see nothing about them: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });
});
