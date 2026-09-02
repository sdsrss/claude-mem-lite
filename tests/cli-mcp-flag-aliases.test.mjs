// CLI must not silently drop a filter flag it doesn't recognize.
//
// Mirror of tests/mcp-cli-filter-aliases.test.mjs (which pins the MCP direction).
//
// v3.59.0 taught the CLI to accept MCP *field* names for the required values
// (`--content`, `--query`, `--ids`) so a model can map a tool schema onto flags.
// The FILTER fields never got the same treatment: `--obs_type` / `--date_from` /
// `--date_to` / `--date_since` parse into `flags` and are then read by nobody, so
// the command answers the UNFILTERED question. Worse, the typo guard stayed quiet:
// suggestUnknownFlags() only reported a flag when it could name a near-miss within
// edit distance 2, and `obs_type` is nowhere near any real flag — so an ignored
// filter produced no output at all.
//
// Evidence that drove this (2026-08-13 dogfood, 6-row corpus):
//   search redis --type bugfix       → 0 results   (filter honored)
//   search redis --obs_type bugfix   → 1 result: the DECISION row (filter dropped)
//   search fixed --from 2099-01-01   → 0 results   (filter honored)
//   search fixed --date_from 2099-01-01 → 2 results (filter dropped)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// D#207: repo-source paths are built with join(), never `new URL('../…', import.meta.url)`
// — the URL form makes knip drop the named module from its unused-export report.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
import { parseArgs, suggestUnknownFlags, KNOWN_CLI_FLAGS } from '../cli/common.mjs';

describe('parseArgs — MCP field names normalize onto CLI flags', () => {
  it('maps the renamed filter fields onto their CLI spelling', () => {
    const { flags } = parseArgs(['--obs_type', 'bugfix', '--date_from', '2026-01-01',
      '--date_to', '2026-02-01', '--date_since', '7d']);
    expect(flags.type).toBe('bugfix');
    expect(flags.from).toBe('2026-01-01');
    expect(flags.to).toBe('2026-02-01');
    expect(flags.since).toBe('7d');
  });

  it('treats underscores as hyphens for every flag', () => {
    const { flags } = parseArgs(['--include_noise', '--lesson_learned', 'x', '--dry_run']);
    expect(flags['include-noise']).toBe(true);
    expect(flags['lesson-learned']).toBe('x');
    expect(flags['dry-run']).toBe(true);
  });

  it('works through the --key=value form too', () => {
    const { flags } = parseArgs(['--obs_type=decision', '--date_since=24h']);
    expect(flags.type).toBe('decision');
    expect(flags.since).toBe('24h');
  });

  it('an explicit canonical flag wins over its alias', () => {
    const { flags } = parseArgs(['--type', 'bugfix', '--obs_type', 'decision']);
    expect(flags.type).toBe('bugfix');
  });

  it('leaves ordinary flags and positionals untouched', () => {
    const { flags, positional } = parseArgs(['search', 'redis', '--type', 'decision', '--limit', '5']);
    expect(positional).toEqual(['search', 'redis']);
    expect(flags.type).toBe('decision');
    expect(flags.limit).toBe('5');
  });
});

describe('suggestUnknownFlags — no unknown flag is silently dropped', () => {
  it('reports a far-from-anything unknown flag (no suggestion available)', () => {
    const hits = suggestUnknownFlags(parseArgs(['--wibblefrotz', 'x']).flags);
    expect(hits).toHaveLength(1);
    expect(hits[0].flag).toBe('wibblefrotz');
    expect(hits[0].suggestion).toBeNull();
  });

  it('still names the near-miss when there is one', () => {
    const hits = suggestUnknownFlags(parseArgs(['--tpye', 'bugfix']).flags);
    expect(hits).toEqual([{ flag: 'tpye', suggestion: 'type' }]);
  });

  // Driven from the flags the CODE reads, NOT from KNOWN_CLI_FLAGS — a pin built out
  // of the catalogue it is checking can never fail. This exact vacuity let
  // `--prompts-limit` (read off raw argv in cli/doctor.mjs) reach v3.61.0 uncatalogued,
  // where warn-on-every-unknown-flag turned it into a false warning on a working
  // command. Independent pre-tag review, 2026-08-13.
  it('stays silent for every flag the CLI actually reads', () => {
    const roots = ['mem-cli.mjs', 'cli/common.mjs', 'cli/activity.mjs', 'cli/doctor.mjs',
      'cli/fts-check.mjs', 'adopt-cli.mjs', 'cli.mjs'];
    const read = new Set();
    for (const f of roots) {
      const src = readFileSync(join(REPO, f), 'utf8');
      for (const m of src.matchAll(/flags\.([a-zA-Z][a-zA-Z0-9]*)/g)) read.add(m[1]);
      for (const m of src.matchAll(/flags\['([^']+)'\]/g)) read.add(m[1]);
      // raw-argv reads: args.includes('--x') / argv.indexOf('--x')
      for (const m of src.matchAll(/(?:includes|indexOf)\('--([a-z][a-z0-9-]*)'\)/g)) read.add(m[1]);
    }
    // Scan artifacts, not flag reads: `length`; `help` (handled by the `-h` branch and
    // short-circuited before the warning loop); `mjs` from the import path
    // `lib/cli-flags.mjs`; `x` from the placeholder in comments that say "a `flags.x`
    // grep". Kept as an explicit deny-list so a real flag can never hide behind a
    // silently-widened filter.
    const notFlags = new Set(['length', 'help', 'mjs', 'x']);
    const uncatalogued = [...read]
      .filter(f => !notFlags.has(f) && !KNOWN_CLI_FLAGS.has(f) && !KNOWN_CLI_FLAGS.has(f.replace(/_/g, '-')));
    expect(uncatalogued, `flags read by code but missing from KNOWN_CLI_FLAGS`).toEqual([]);
    expect(read.size, 'sanity: the scan found flag reads at all').toBeGreaterThan(40);
  });

  it('stays silent for the normalized MCP field names', () => {
    const { flags } = parseArgs(['--obs_type', 'bugfix', '--date_since', '7d', '--include_noise']);
    expect(suggestUnknownFlags(flags)).toEqual([]);
  });
});
