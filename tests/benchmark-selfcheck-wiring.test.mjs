// Every self-check in benchmark/*.mjs must be REACHED by that file's main().
//
// The gap this closes, recorded in CLAUDE.md since v3.82.0 and re-found by the v3.91.0
// pre-tag review: a ruler's self-checks are imported by a test and driven directly with
// synthetic inputs, so the FUNCTIONS are pinned — but the CALL in `main()` is not. Deleting
// `assertRulerCanSayNo(db, prompts, wide)` from main() leaves every suite green while the
// real run stops checking anything. v3.82.0 found two of citation-live-replay.mjs's checks
// removable exactly that way, and the v3.91.0 review re-confirmed it on two more files
// (rerank-pool-replay's M8, patha-exclude-report's P4 — both mutations SURVIVED).
//
// WHY THIS IS A SOURCE GUARD AND NOT A BEHAVIOURAL ONE. The better instrument exists and is
// already used: tests/citation-live-replay.test.mjs drives the real `main()` in a subprocess
// against a saturated fixture and asserts the process refuses. That works there because that
// check fires on CORPUS SHAPE — an external input a test can supply. Every other self-check
// in this tree fires only on a CODE DEFECT (a writable handle, a lost `counterfactual` flag,
// a non-deterministic arm, a wrong aggregator), which no fixture can induce from outside.
// So the behavioural route was tried and is structurally unavailable for these, and what is
// left is to bind the wiring at the source level. Said plainly: this pins that the call
// EXISTS and is reachable, not that it does anything — the checks' own tests do that half.
//
// The rule is derived, not listed: any top-level `assert*` or `runSelfChecks` in
// benchmark/*.mjs is a self-check and must be reachable from `main()`. A new one is covered
// the moment it is written, which is the difference between a rule and a hand-kept manifest
// that rots (see the `SURFACE_MATCHERS` twin this project keeps paying for).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// D#207: join(), never `new URL('../x.mjs', import.meta.url)` — the URL form drops the
// named module out of knip's unused-export report entirely.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(REPO, 'benchmark');

const DECL = /^(?:export )?(?:async )?function (\w+)\s*\(/;
const isSelfCheck = (n) => n.startsWith('assert') || n === 'runSelfChecks';

/**
 * Top-level function bodies, by line anchoring rather than by parsing.
 *
 * A declaration starts at column 0 and its body ends at the first following line that
 * starts at column 0 with `}`. That is a model of this codebase's formatting, not of
 * JavaScript — and the direction it can be wrong in is the safe one: if it truncated a
 * body early it would LOSE calls, which can only turn a reachable check unreachable (a
 * false failure), never the reverse. A false pass would need it to invent a call.
 */
function topLevelFunctions(src) {
  const lines = src.split('\n');
  const fns = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('}')) j++;
    fns.set(m[1], lines.slice(i + 1, j).join('\n'));
    i = j;
  }
  return fns;
}

/** Names called from `entry`, transitively, restricted to this module's own functions. */
function reachableFrom(fns, entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n) || !fns.has(n)) continue;
    seen.add(n);
    for (const [, called] of fns.get(n).matchAll(/\b(\w+)\s*\(/g)) stack.push(called);
  }
  return seen;
}

const files = readdirSync(BENCH)
  .filter((f) => f.endsWith('.mjs'))
  .sort();
const analysed = files.map((f) => {
  const src = readFileSync(join(BENCH, f), 'utf8');
  const fns = topLevelFunctions(src);
  return { f, src, fns, checks: [...fns.keys()].filter(isSelfCheck) };
});
const withChecks = analysed.filter((a) => a.checks.length);

describe('every benchmark self-check is reached by its own main()', () => {
  it.each(withChecks.map((a) => [a.f, a]))('%s', (_name, a) => {
    expect(a.fns.has('main'), `${a.f} declares self-checks but no top-level main()`).toBe(true);
    const reachable = reachableFrom(a.fns, 'main');
    const orphans = a.checks.filter((c) => !reachable.has(c));
    expect(
      orphans,
      `${a.f}: self-check(s) not reached from main() — the function may still ` +
        'be unit-tested, but the real run no longer performs it',
    ).toEqual([]);
  });
});

describe('the wiring guard itself can fail, and is not scanning an empty tree', () => {
  it('finds self-checks at all, across more than one file', () => {
    // Without this, an extractor that silently returned nothing would report a clean sweep.
    // A floor, not an equality: a new ruler must not have to edit this number.
    const total = withChecks.reduce((n, a) => n + a.checks.length, 0);
    expect(total).toBeGreaterThanOrEqual(10);
    expect(withChecks.length).toBeGreaterThanOrEqual(5);
  });

  it('extracts a non-empty main() from every file it judges', () => {
    for (const a of withChecks) {
      expect(
        a.fns.get('main')?.split('\n').length,
        `${a.f}: main() body looks empty, so ` + 'reachability from it means nothing',
      ).toBeGreaterThan(3);
    }
  });

  it('agrees with an independent scan about WHICH functions are self-checks', () => {
    // Cross-check between two derivations. Body extraction skips ahead past each function
    // it consumes; if that skip ever swallowed a later declaration, the guard would judge
    // a smaller set than exists and report a clean sweep over the survivors.
    for (const a of analysed) {
      const plain = [...a.src.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(/gm)]
        .map((m) => m[1])
        .filter(isSelfCheck)
        .sort();
      expect(
        a.checks.slice().sort(),
        `${a.f}: body extraction and a plain declaration scan ` + 'disagree about the self-check set',
      ).toEqual(plain);
    }
  });

  it('REPORTS an unreachable self-check — the mutation it exists for', () => {
    const src = [
      'export function assertSomething(x) {',
      '  if (!x) throw new Error("no");',
      '}',
      '',
      'function main() {',
      '  console.log("work");',
      '}',
      '',
    ].join('\n');
    const fns = topLevelFunctions(src);
    expect(fns.has('assertSomething')).toBe(true);
    expect(reachableFrom(fns, 'main').has('assertSomething')).toBe(false);
  });

  it('accepts a direct call, and a call one function deeper', () => {
    // keyctx-pool-replay reaches five of its checks through runSelfChecks(), so a guard
    // that only looked inside main() itself would demand the wrong shape.
    const src = [
      'export function assertDirect() {',
      '  return 1;',
      '}',
      '',
      'export function assertNested() {',
      '  return 2;',
      '}',
      '',
      'export function runSelfChecks() {',
      '  assertNested();',
      '}',
      '',
      'function main() {',
      '  assertDirect();',
      '  runSelfChecks();',
      '}',
      '',
    ].join('\n');
    const reachable = reachableFrom(topLevelFunctions(src), 'main');
    for (const n of ['assertDirect', 'assertNested', 'runSelfChecks']) {
      expect(reachable.has(n), n).toBe(true);
    }
  });

  it('does not count a self-check merely because its NAME appears in the file', () => {
    // The failure mode of a grep-based version: a docblock, an import, or an export list
    // mentioning the name would satisfy it while nothing calls it.
    const src = [
      'export function assertThing() {',
      '  return 1;',
      '}',
      '',
      'function main() {',
      '  // assertThing is documented here but never called',
      '  const names = ["assertThing"];',
      '  return names;',
      '}',
      '',
    ].join('\n');
    expect(reachableFrom(topLevelFunctions(src), 'main').has('assertThing')).toBe(false);
  });
});
