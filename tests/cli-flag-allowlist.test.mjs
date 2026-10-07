// KNOWN_CLI_FLAGS must contain only flags a `claude-mem-lite` subcommand actually reads.
//
// suggestUnknownFlags() warns on EVERY flag outside the allowlist ("--x — ignored, it
// had no effect"). So a bogus allowlist entry does not merely fail to help — it
// SUPPRESSES the one signal the user would get. `out` sat in the list until the 2026-08-17
// e2e round, having been catalogued from `benchmark/longmemeval-rerank.mjs --out`, which is not a
// CLI flag: `claude-mem-lite export --out backup.json` dumped the whole export to
// stdout, wrote no file, and printed no warning.
//
// The guard is derived, not a hand-maintained second copy of the list: it re-reads the
// CLI sources and asks whether each allowlisted name appears there at all.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { KNOWN_CLI_FLAGS, COMMAND_SCOPED_FLAGS, suggestUnknownFlags } from '../cli/common.mjs';

const ROOT = resolve(import.meta.dirname, '..');

// Every file that can consume a `claude-mem-lite <cmd>` flag. Deliberately excludes
// benchmark/ and scripts/ — a flag only those read is NOT a CLI flag, which is the
// exact confusion this suite exists to catch.
function cliSources() {
  const files = [join(ROOT, 'cli.mjs'), join(ROOT, 'mem-cli.mjs'), join(ROOT, 'adopt-cli.mjs')];
  for (const e of readdirSync(join(ROOT, 'cli'))) {
    if (e.endsWith('.mjs')) files.push(join(ROOT, 'cli', e));
  }
  return files;
}

describe('KNOWN_CLI_FLAGS', () => {
  it('every entry is referenced by CLI code outside the allowlist itself', () => {
    // Strip the allowlist literal so a name cannot vouch for itself.
    const common = readFileSync(join(ROOT, 'cli', 'common.mjs'), 'utf8');
    const listLiteral = common.match(/KNOWN_CLI_FLAGS = new Set\(\[[\s\S]*?\]\);/);
    expect(listLiteral, 'allowlist literal not found — update this test').toBeTruthy();
    const haystack = cliSources()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
      .split(listLiteral[0])
      .join('');

    // Flag names that reach a reader as STRING LITERALS inside a list, rather than as a
    // property access: `rejectBareStringFlags(flags, ['name', 'resource-type', …])` and
    // `for (const f of ['repo-url', …]) { … flags[f] … }`. Parsed from those two shapes
    // specifically, NOT accepted as a bare literal anywhere in the sources — an earlier
    // version did the latter, so any string that happened to match a flag name vouched for
    // it. Probed: bogus entries `observations`, `error` and `count` all slipped through,
    // because those words occur in ordinary code. Only names declared at a real flag-list
    // call site count now.
    const declaredInLists = new Set();
    for (const re of [
      /rejectBareStringFlags\([^,]+,\s*\[([^\]]*)\]/g,
      /for \(const \w+ of \[([^\]]*)\]\)/g,
    ]) {
      for (const m of haystack.matchAll(re)) {
        for (const lit of m[1].matchAll(/['"]([^'"]+)['"]/g)) declaredInLists.add(lit[1]);
      }
    }

    const unread = [];
    for (const flag of KNOWN_CLI_FLAGS) {
      const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const forms = [
        `flags['${flag}']`,
        `flags["${flag}"]`,
        `flags.${flag}`,
        `flags['${camel}']`,
        `flags["${camel}"]`,
        `flags.${camel}`,
        `--${flag}`, // raw-argv readers (doctor --prompts-limit) + help text
      ];
      if (declaredInLists.has(flag)) continue;
      if (!forms.some((f) => haystack.includes(f))) unread.push(flag);
    }

    expect(
      unread,
      `allowlisted but no CLI command reads them — each one silences the ` +
        `"ignored, it had no effect" warning for a flag that really is ignored`,
    ).toEqual([]);
  });

  it('warns (not silently accepts) on a flag no command reads', async () => {
    const { suggestUnknownFlags } = await import('../cli/common.mjs');
    // `out` is the concrete regression: natural to guess for `export`, read by nobody.
    const reported = suggestUnknownFlags({ out: 'backup.json' }).map((r) => r.flag);
    expect(reported).toContain('out');
  });

  it('still stays quiet on flags that ARE read', async () => {
    const { suggestUnknownFlags } = await import('../cli/common.mjs');
    expect(suggestUnknownFlags({ project: 'p', limit: 5, json: true, type: 'bugfix' })).toEqual([]);
  });

  it('the derived guard rejects ordinary-vocabulary names, not just odd ones', () => {
    // The false-negative class the bare-literal form used to allow. These three words all
    // occur in the CLI sources as ordinary strings; none is a flag. Re-runs the same
    // derivation the first case uses, against a synthetic allowlist.
    const common = readFileSync(join(ROOT, 'cli', 'common.mjs'), 'utf8');
    const listLiteral = common.match(/KNOWN_CLI_FLAGS = new Set\(\[[\s\S]*?\]\);/);
    const haystack = cliSources()
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
      .split(listLiteral[0])
      .join('');
    const declaredInLists = new Set();
    for (const re of [
      /rejectBareStringFlags\([^,]+,\s*\[([^\]]*)\]/g,
      /for \(const \w+ of \[([^\]]*)\]\)/g,
    ]) {
      for (const m of haystack.matchAll(re)) {
        for (const lit of m[1].matchAll(/['"]([^'"]+)['"]/g)) declaredInLists.add(lit[1]);
      }
    }
    const isVouchedFor = (flag) =>
      declaredInLists.has(flag) ||
      [`flags['${flag}']`, `flags["${flag}"]`, `flags.${flag}`, `--${flag}`].some((f) =>
        haystack.includes(f),
      );
    for (const bogus of ['observations', 'error', 'count', 'message', 'level']) {
      expect(isVouchedFor(bogus), `bogus flag "${bogus}" vouched for itself`).toBe(false);
    }
    // …while real flags still pass. (The three registry string-list flags this arm used
    // to name went with the skill-registry removal in 2026-09; these are live equivalents.)
    for (const real of ['files', 'ops', 'fields']) {
      expect(isVouchedFor(real), `real flag "${real}" no longer recognised`).toBe(true);
    }
  });
});

// KNOWN_CLI_FLAGS is a union across commands, so a flag only verify-apply reads used to be
// accepted in silence by every other command: `recent --apply` did nothing and said nothing.
// COMMAND_SCOPED_FLAGS names the one command that reads such a flag, and the warning fires
// everywhere else. The map is only honest while no other command reads the flag — the first
// case below derives that from the sources, so a second reader turns it red.
describe('COMMAND_SCOPED_FLAGS', () => {
  // Where each owning command's flags are read. A new owner must be added here.
  const OWNER_MODULE = {
    'verify-apply': 'cli/verify-apply.mjs',
    context: 'mem-cli.mjs',
    stats: 'mem-cli.mjs',
  };
  // Comments name flags freely (common.mjs documents `flags.apply` in one); only code counts.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('each scoped flag is read by its owner module and by no other CLI source', () => {
    expect(COMMAND_SCOPED_FLAGS.size).toBeGreaterThan(0);
    for (const [flag, owner] of COMMAND_SCOPED_FLAGS) {
      expect(OWNER_MODULE[owner], `no module registered for owner ${owner}`).toBeTruthy();
      expect(KNOWN_CLI_FLAGS.has(flag), `${flag} must stay in KNOWN_CLI_FLAGS for its owner`).toBe(true);
      const forms = [`flags.${flag}`, `flags['${flag}']`, `flags["${flag}"]`, `'--${flag}'`, `"--${flag}"`];
      // Also the list-iteration reader (`for (const f of ['apply']) flags[f]`) and any
      // lib/ module: pre-ship review of v6.12.1 (P3-3) added a second reader in each shape
      // and this case stayed green.
      const listReads = (src) =>
        [...src.matchAll(/for \(const \w+ of \[([^\]]*)\]\)/g)].some((m) =>
          new RegExp(`['"]${flag}['"]`).test(m[1]),
        );
      const population = [
        ...cliSources(),
        ...readdirSync(join(ROOT, 'lib'))
          .filter((e) => e.endsWith('.mjs'))
          .map((e) => join(ROOT, 'lib', e)),
      ];
      const readers = population
        .filter((f) => {
          const src = stripComments(readFileSync(f, 'utf8'));
          return forms.some((form) => src.includes(form)) || listReads(src);
        })
        .map((f) => f.slice(ROOT.length + 1));
      expect(readers, `readers of --${flag}`).toEqual([OWNER_MODULE[owner]]);
    }
  });

  it('warns when another command is given a scoped flag, naming the command that reads it', () => {
    expect(suggestUnknownFlags({ apply: true }, 'recent')).toEqual([
      { flag: 'apply', suggestion: null, owner: 'verify-apply' },
    ]);
    expect(suggestUnknownFlags({ digest: 'abc', limit: 5 }, 'search').map((r) => r.flag)).toEqual(['digest']);
  });

  // Pre-ship review of v6.12.1, P3-2: the typo suggester still ranked the scoped flags for
  // every command, so `recent --aply` said "did you mean --apply?" and the next run called
  // that flag ignored.
  it('never suggests a scoped flag to a command that does not read it', () => {
    // Another real flag may still be the nearest (`--all`); it must just not be the scoped one.
    expect(suggestUnknownFlags({ aply: true }, 'recent')[0].suggestion).not.toBe('apply');
    expect(suggestUnknownFlags({ digets: 'x' }, 'stats')[0].suggestion).not.toBe('digest');
    expect(suggestUnknownFlags({ aply: true }, 'verify-apply')).toEqual([
      { flag: 'aply', suggestion: 'apply' },
    ]);
  });

  it('stays quiet when the owner reads it, and when no command is known', () => {
    expect(suggestUnknownFlags({ apply: true, digest: 'abc', project: 'p' }, 'verify-apply')).toEqual([]);
    expect(suggestUnknownFlags({ undo: 'x' })).toEqual([]);
  });
});
