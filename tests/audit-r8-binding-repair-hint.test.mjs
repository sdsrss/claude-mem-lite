// A20260906-R8-P1-1 — no user-facing repair hint may print a command that reports success
// on a still-dead binding.
//
// `npm rebuild better-sqlite3 --dangerously-allow-all-scripts` prints "rebuilt dependencies
// successfully" and exits 0 while compiling nothing on better-sqlite3 13, which declares no
// install script (measured 2026-09-06 in a mktemp sandbox on npm 12.0.2, with prebuilds
// present and with them deleted). Every "Repair:" line in the product printed exactly that
// command — doctor's included, via lib/install-shape — while the command that DOES heal was
// added in v4.0.0 and shown to nobody.
//
// The CHANGELOG records this same defect once already (the hints used to say
// `--build-from-source`, which no-oped the same way). That fix was correct for
// better-sqlite3 12 and expired silently when the dependency was bumped — so the guard here
// is deliberately about the SHAPE of a hint, not about one command string.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  nativeBindingRepairHint,
  NATIVE_BINDING_REBUILD_CMD,
  NATIVE_BINDING_SOURCE_BUILD_CMD,
} from '../lib/binding-probe.mjs';

// dirname(fileURLToPath(...)) + join, never new URL() — tests/no-url-module-paths.test.mjs.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every surface that hands a human a binding-repair command.
const HINT_SURFACES = [
  'install.mjs',
  'lib/binding-probe.mjs',
  'lib/install-shape.mjs',
  'scripts/launch.mjs',
  'scripts/hook-launcher.mjs',
  'scripts/setup.sh',
];

describe('nativeBindingRepairHint', () => {
  it('sequences both commands, and does so with && rather than ||', () => {
    const hint = nativeBindingRepairHint('/tmp/x');
    expect(hint).toContain(NATIVE_BINDING_REBUILD_CMD);
    expect(hint).toContain(NATIVE_BINDING_SOURCE_BUILD_CMD);
    expect(hint).toContain('cd /tmp/x');

    // The trap this whole finding is about: step 1 exits 0 whether or not it compiled, so
    // `||` would never reach step 2 while LOOKING like a fallback. Assert the source build
    // is not guarded by a failure that cannot happen.
    const between = hint.slice(
      hint.indexOf(NATIVE_BINDING_REBUILD_CMD) + NATIVE_BINDING_REBUILD_CMD.length,
      hint.indexOf(NATIVE_BINDING_SOURCE_BUILD_CMD),
    );
    expect(between).toContain('&&');
    expect(between).not.toContain('||');
  });
});

describe('no shipped surface hands out the npm-rebuild command alone', () => {
  it.each(HINT_SURFACES)('%s names the source build wherever it names npm rebuild', (rel) => {
    const src = readFileSync(join(REPO, rel), 'utf8');
    if (!src.includes('npm rebuild better-sqlite3')) return; // surface does not hint here
    expect(
      src.includes('build-release'),
      `${rel} prints/uses the npm-rebuild command without ever naming the source build — ` +
        `on better-sqlite3 13 that is a repair that reports success and heals nothing`,
    ).toBe(true);
  });

  it('pins WHICH surfaces still carry the literal', () => {
    // Premise for the it.each above, which would otherwise pass vacuously once every case
    // takes the early return. Pinned as a SET, not a count: three files legitimately hold
    // the string (the constant's home, and the two that may not import lib/ — the launcher
    // under its pure-`node:` charter and the shell installer). A fourth appearing means
    // someone re-hardcoded a hint instead of calling nativeBindingRepairHint, which is the
    // drift this finding is made of; one disappearing means a guard lost its subject.
    const mentioning = HINT_SURFACES.filter((rel) =>
      readFileSync(join(REPO, rel), 'utf8').includes('npm rebuild better-sqlite3'),
    );
    expect(mentioning).toEqual(['lib/binding-probe.mjs', 'scripts/hook-launcher.mjs', 'scripts/setup.sh']);
  });
});

describe('hook-launcher keeps its literal in sync with the constants', () => {
  it('NB_MANUAL_CMD equals the two lib commands joined by &&', () => {
    // scripts/hook-launcher.mjs may not import lib/ (it must survive a broken install), so
    // the string is duplicated there. A comment saying "kept in sync" is not a mechanism;
    // this is. Compared against the constants rather than a literal, so bumping either
    // command in lib/ fails HERE rather than shipping a half-updated hint.
    const src = readFileSync(join(REPO, 'scripts/hook-launcher.mjs'), 'utf8');
    const m = /const NB_MANUAL_CMD =\s*\n?\s*'([^']*)'/.exec(src);
    expect(m, 'NB_MANUAL_CMD literal not found — the sync guard has lost its subject').toBeTruthy();
    expect(m[1]).toBe(`${NATIVE_BINDING_REBUILD_CMD} && ${NATIVE_BINDING_SOURCE_BUILD_CMD}`);
  });
});
