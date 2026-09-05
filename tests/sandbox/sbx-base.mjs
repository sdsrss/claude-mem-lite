// tests/sandbox/sbx-base.mjs — where a sandbox root is allowed to live.
//
// The README has carried this rule since v3.71.0:
//
//   "Do not put the sandbox under $HOME. Node resolves better-sqlite3 up the directory
//    tree, so a sandbox nested under a home that owns node_modules silently resolves to
//    it and the isolation is fake."
//
// …in its "Conventions worth keeping" section at the END of the file, some forty lines
// BELOW the sentence at the top that says sandboxes are created under `$TMPDIR`. That
// distance is part of why the rule did not bind: a reader of the quickstart never gets
// there. (A draft of this comment said "two paragraphs above", which is both the wrong
// direction and the wrong distance — the pre-tag claims review caught it in three files.)
// The two are the same sentence in a Claude Code session, where `$TMPDIR` is set to
// `~/.claude/tmp/claude-<uid>` — so the DOCUMENTED DEFAULT violates the documented rule,
// and it does so silently: `/home/<user>/node_modules` here holds both `better-sqlite3`
// and `claude-mem-lite`, so every check still passes while measuring the wrong tree.
// Found by running the harness, not by reading it, which is the whole argument for
// running it.
//
// A README line would not have prevented this — the README already said it. So the
// refusal is in code, and it names the resolved path rather than the variable, because
// the variable is not what is wrong.

import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';

/** Resolve symlinks where the path exists; fall back to `resolve` where it does not. */
function realish(p) {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/**
 * True when `child` is `parent` or lives beneath it. Path-segment comparison, not a
 * prefix test: `/home/sds-other` must not read as inside `/home/sds`.
 *
 * Both sides go through `realpathSync` first. `resolve()` alone normalises `..` and `.`
 * but does not follow symlinks, and Node's module resolution walks the REAL path — so a
 * symlink pointing into HOME sailed past the guard while still borrowing HOME's
 * `node_modules`. Found by the v3.90.0 pre-tag review. The converse mattered too: a
 * `homedir()` with a symlinked component would have failed to catch a base under the
 * real home.
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const p = realish(parent);
  const c = realish(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * The nearest ancestor directory of `base` (inclusive) that owns a `node_modules`, or
 * null. This is THE HAZARD ITSELF, as opposed to `isInside(home, …)`, which is a proxy
 * for it.
 *
 * The two are not the same set, and the gap is a path this repo uses daily: the v3.90.0
 * review pointed a sandbox at `<repo>/tmp/sbx`, which is nowhere near HOME, passed the
 * HOME check unchanged, and resolved `better-sqlite3` AND `claude-mem-lite` straight out
 * of the package under test — precisely the fake isolation the guard exists to prevent.
 * @param {string} base
 * @returns {string|null}
 */
export function ancestorWithNodeModules(base) {
  let dir = realish(base);
  for (;;) {
    if (existsSync(join(dir, 'node_modules'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Resolve the directory sandbox roots are created in, refusing one that would make the
 * isolation fake. Injectable so the refusal can be driven in a test without a real HOME.
 *
 * @param {object} [o]
 * @param {string} [o.sbxBase] explicit override (SBX_BASE)
 * @param {string} [o.tmp]     fallback base
 * @param {string} [o.home]    the home directory to refuse
 * @returns {string}
 */
export function resolveSandboxBase({ sbxBase, tmp, home } = {}) {
  const base = sbxBase || tmp || tmpdir();
  const h = home || homedir();
  if (isInside(h, base)) {
    throw new Error(
      `[sandbox] refusing to build a sandbox at ${resolve(base)}: it is under HOME (${resolve(h)}).\n` +
        `  Node resolves node_modules up the directory tree, so a root here silently borrows\n` +
        `  the home tree's better-sqlite3 / claude-mem-lite and every check passes against the\n` +
        `  wrong install. Set SBX_BASE to a path outside HOME, e.g. SBX_BASE=/tmp/claude/sbx.\n` +
        `  (In a Claude Code session $TMPDIR is itself under HOME, which is how the default gets here.)`,
    );
  }
  // The hazard itself, checked after the HOME rule so the commoner case keeps its
  // specific message. `<repo>/tmp/sbx` is outside HOME and still fake isolation.
  const owner = ancestorWithNodeModules(base);
  if (owner) {
    throw new Error(
      `[sandbox] refusing to build a sandbox at ${resolve(base)}: ${owner} owns a node_modules.\n` +
        `  Node resolves modules up the directory tree, so the sandbox would borrow that tree's\n` +
        `  dependencies and the isolation would be fake while every check still passed.\n` +
        `  Pick a base with no node_modules above it, e.g. SBX_BASE=/tmp/claude/sbx.`,
    );
  }
  return base;
}

/**
 * Process-level convenience: the form every phase script calls.
 *
 * Creates the directory. The v3.90.0 review found that the README's own documented
 * command named `/tmp/claude/sbx`, which does not exist on a fresh machine — so the
 * default threw by design and the documented override crashed with ENOENT inside
 * `mkdtempSync`, leaving no working invocation at all.
 */
export function sandboxBase() {
  const base = resolveSandboxBase({ sbxBase: process.env.SBX_BASE, tmp: tmpdir() });
  mkdirSync(base, { recursive: true });
  return base;
}
