// `ARGV_PARSED_COMMANDS` is a hand-kept list, and a hand-kept list of "who is exempt from a
// warning" rots into a warning fired at correct usage.
//
// The inert-filter-flag notice observes reads through the object `parseArgs` returns. A
// command that reads its own raw argv instead is invisible to that tracking, so it is listed
// as exempt. The list shipped with three names and was wrong twice in one branch:
//
//   * `unadopt --all` — documented in adopt-cli.mjs, implemented by `unadoptAll()`, and
//     reported as "ignored … the results above are UNFILTERED" (fixed in c54e0d1).
//   * `optimize --project` / `--scope` — both documented, both applied, and the notice said
//     they were dropped while stdout printed `Project filter: demo` on the line above.
//
// Both were found by sweeping invocations, and a sweep is only as wide as the population
// somebody remembered to enumerate: the 84-invocation sweep that shipped the list was built
// from the DB-command family, so it never reached a command routed before the DB opens, and
// the follow-up never reached the one DB command that parses its own argv.
//
// So this derives the answer instead of checking it. It reads the dispatcher's own switch to
// map each command name to its handler, reads that handler's body, and asks whether the body
// indexes raw argv for a flag in FILTER_FLAGS. Every command that does MUST be exempt —
// otherwise the notice fires on a flag the command really honours.
//
// POPULATION, stated because a scan's population is the part that goes wrong: handlers
// DEFINED in mem-cli.mjs. A handler imported from another module has a body this scan cannot
// read, so it has to be named in `HANDLER_NOT_IN_THIS_FILE` — which makes adding one a
// deliberate edit rather than a silent hole. Commands routed before the switch (`adopt`,
// `unadopt`, `memdir-audit`) are likewise outside it and named below.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTER_FLAGS } from '../cli/common.mjs';

// D#207: join(), never new URL('../mem-cli.mjs', import.meta.url).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(REPO, 'mem-cli.mjs'), 'utf8');

/**
 * Handlers the dispatcher routes to that are defined elsewhere, so their bodies are outside
 * this scan. Each is accounted for by hand here; the assertion below fails if the set grows.
 *
 *   cmdDoctor  — cli/doctor.mjs. Its mode selection happens in runDispatch itself
 *                (`cmdArgs.includes('--benchmark')` …), and `doctor` is already exempt.
 *   cmdActivity — cli/activity.mjs. Calls parseArgs itself; nothing is read off raw argv.
 *   cmdFtsCheck — cli/fts-check.mjs. Same.
 *   cmdVerifyApply — cli/verify-apply.mjs. Calls parseArgs itself; nothing is read off raw argv.
 */
const HANDLER_NOT_IN_THIS_FILE = new Set(['cmdDoctor', 'cmdActivity', 'cmdFtsCheck', 'cmdVerifyApply']);

/** Commands routed before the dispatcher's switch, so they never appear in it. */
const ROUTED_BEFORE_THE_SWITCH = new Set(['adopt', 'unadopt', 'memdir-audit']);

/** `case 'name':` followed by `(await )?cmdX(db, cmdArgs)` — the main dispatcher's shape. */
function routingTable() {
  const table = new Map();
  const re = /case '([a-z][a-z0-9-]*)':\s*\n\s*(?:await\s+)?(cmd[A-Za-z0-9_]*)\(db, cmdArgs\)/g;
  let m;
  while ((m = re.exec(SRC)) !== null) table.set(m[1], m[2]);
  return table;
}

/** The body of `function name(` / `async function name(` up to the next column-0 `}`. */
function functionBody(name) {
  const start = SRC.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) return null;
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end < 0 ? SRC.length : end);
}

/**
 * Selection flags this body reads off the argv ARRAY rather than the parsed object. The
 * receiver is pinned to the argv-shaped identifiers on purpose: a bare `.includes('--x')` on
 * any object would also match `KNOWN_CLI_FLAGS.includes(...)` and fire on innocent commands.
 */
function rawArgvFilterFlags(body) {
  const found = new Set();
  const re = /\b(?:args|cmdArgs|argv|rest)\.(?:indexOf|includes|lastIndexOf)\(\s*'--([a-z][a-z0-9-]*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) if (FILTER_FLAGS.has(m[1])) found.add(m[1]);
  return found;
}

/**
 * The exempt list, read out of the source rather than imported. Exporting it purely for this
 * test would add an export no product code consumes, which moves the knip reading CLAUDE.md
 * tells the next reader to trust — `tests/doctor-mode-router-sync.test.mjs` derives its half
 * of the same router the same way.
 */
function exemptCommands() {
  const m = SRC.match(/const ARGV_PARSED_COMMANDS = new Set\(\[([^\]]*)\]\)/);
  if (!m) return null;
  return new Set([...m[1].matchAll(/'([a-z][a-z0-9-]*)'/g)].map((x) => x[1]));
}

describe('every command that parses its own argv is exempt from the inert-flag notice', () => {
  const table = routingTable();

  it('premise: the dispatcher and the flag set are both non-empty', () => {
    // Two empty sets compare equal. Without these three, a regex that stopped matching — a
    // reformat, a switch rewritten as a lookup table — would make every assertion below pass
    // by describing nothing.
    expect(table.size, 'the dispatcher switch parsed to nothing').toBeGreaterThan(19);
    expect(FILTER_FLAGS.size).toBeGreaterThan(10);
    expect(table.get('optimize')).toBe('cmdOptimize');
  });

  it('premise: the scan can actually SEE a raw-argv read', () => {
    // If this goes empty the scan is blind and every command below passes for free. `optimize`
    // is the witness: it reads --scope and --project with args.indexOf().
    const body = functionBody('cmdOptimize');
    expect(body, 'cmdOptimize is no longer defined in mem-cli.mjs').not.toBeNull();
    expect([...rawArgvFilterFlags(body)].sort()).toEqual(['project', 'scope']);
  });

  it('names every handler whose body this scan cannot read', () => {
    const unreadable = [...table.values()].filter((fn) => functionBody(fn) === null);
    expect(
      unreadable.sort(),
      'a dispatcher handler moved out of mem-cli.mjs; check by hand whether it reads raw argv, ' +
        'then add it to HANDLER_NOT_IN_THIS_FILE',
    ).toEqual([...HANDLER_NOT_IN_THIS_FILE].sort());
  });

  it('every handler reading a selection flag off raw argv is in ARGV_PARSED_COMMANDS', () => {
    const ARGV_PARSED_COMMANDS = exemptCommands();
    expect(ARGV_PARSED_COMMANDS, 'ARGV_PARSED_COMMANDS is no longer a literal Set').not.toBeNull();
    const offenders = [];
    for (const [cmd, fn] of table) {
      const body = functionBody(fn);
      if (body === null) continue;
      const raw = rawArgvFilterFlags(body);
      if (raw.size > 0 && !ARGV_PARSED_COMMANDS.has(cmd)) {
        offenders.push(`${cmd} (${fn}) reads ${[...raw].sort().join(', ')} off raw argv`);
      }
    }
    expect(
      offenders,
      'these commands honour a selection flag the notice cannot see them read, so it will ' +
        'tell the user the flag was ignored:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('carries no stale entry', () => {
    const known = new Set([...table.keys(), ...ROUTED_BEFORE_THE_SWITCH]);
    const stale = [...exemptCommands()].filter((c) => !known.has(c));
    expect(stale, 'exempted names that are no longer commands').toEqual([]);
  });
});
