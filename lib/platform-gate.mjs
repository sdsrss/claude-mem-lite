// lib/platform-gate.mjs — is THIS platform inside the `os` list package.json declares?
//
// Why this is a module and not four lines inside scripts/launch.mjs, which is its only
// consumer: launch.mjs cannot be imported. Its top level installs dependencies, probes the
// native binding and then imports the MCP server, so a test that imported it would start a
// server. The alternative to a real import is a source-text scan of launch.mjs, which this
// repo has repeatedly found to be walkable — a guard that greps for a string passes for a
// change that keeps the string and deletes the behaviour. So the predicate lives here where
// tests can drive it, and launch.mjs keeps the wording and the exit.
//
// `os` is an npm INSTALL GATE, evaluated against the ROOT package being installed. npm
// rejects with EBADPLATFORM before it resolves anything, which is why a platform left off
// the list does not degrade — it fails the install outright, and in plugin mode that install
// is on the path of every first MCP launch after an update (issue #28).
//
// Node built-ins only: this runs BEFORE `npm install`, so node_modules may not exist yet.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * npm's own `checkList` from npm-install-checks, reproduced rather than approximated.
 *
 * The rule is not "is it in the list": an entry may be NEGATED with `!`, and a list of
 * nothing but negations allows every platform it does not name. `list.includes(platform)`
 * agrees with npm on the simple case and disagrees on `["!win32"]` — where it would tell a
 * linux user their platform is unsupported while npm installs happily. A diagnostic that is
 * wrong in that direction is worse than none.
 *
 * @param {string[]|string} list The `os` value as declared.
 * @param {string} platform A `process.platform` value.
 * @returns {boolean} True when npm would allow the install.
 */
export function platformAllowed(list, platform) {
  const entries = typeof list === 'string' ? [list] : list;
  if (!Array.isArray(entries)) return true;
  if (entries.length === 1 && entries[0] === 'any') return true;
  let negated = 0;
  let match = false;
  for (const entry of entries) {
    const negate = typeof entry === 'string' && entry.startsWith('!');
    const test = negate ? entry.slice(1) : entry;
    if (negate) {
      negated++;
      if (platform === test) return false;
    } else if (platform === test) {
      match = true;
    }
  }
  // An all-negation list (and, by the same arithmetic, an empty one) allows anything it
  // has not vetoed above.
  return match || negated === entries.length;
}

/**
 * The `os` list `<root>/package.json` declares, or null when there is nothing to enforce.
 *
 * Fails OPEN on every error. A missing or torn package.json is the incomplete-install case
 * that launch-preflight.mjs already diagnoses with a repair command; turning it into a
 * platform complaint here would replace a good message with a wrong one.
 *
 * @param {string} root Directory holding package.json.
 * @returns {string[]|null}
 */
export function readDeclaredPlatforms(root) {
  const p = join(root, 'package.json');
  if (!existsSync(p)) return null;
  try {
    const os = JSON.parse(readFileSync(p, 'utf8'))?.os;
    if (typeof os === 'string') return [os];
    return Array.isArray(os) ? os : null;
  } catch {
    return null;
  }
}

/**
 * Would npm refuse to install this package on this platform?
 *
 * @param {{root: string, platform?: string}} opts
 * @returns {{blocked: boolean, declared: string[]|null, platform: string}}
 */
export function platformGate({ root, platform = process.platform }) {
  const declared = readDeclaredPlatforms(root);
  if (declared === null) return { blocked: false, declared: null, platform };
  return { blocked: !platformAllowed(declared, platform), declared, platform };
}
