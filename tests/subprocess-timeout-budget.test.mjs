// MAIN-2: the subprocess wall-clock cap was a copy-pasted literal in 13 suites.
//
// Surfaced by the audit follow-up rather than by the audit: a full-suite run reddened
// `tests/audit-fixes.test.mjs > T2-P0-A` on `timeout waiting for id=0 method=initialize`,
// while the same file passed 64/64 standalone and four other full runs were green. An MCP
// initialize round trip against a cold `node server.mjs` measures 635ms idle on this host,
// so 5000ms was a 7.9x margin — and it still lost, on 24 cores with 311 test files in
// flight. What ran out was CPU for the spawn, not patience for the server.
//
// That is the same defect class as the audit's own P1 (MAIN-1): a release gate whose green
// depends on host load. This file keeps the fix from eroding back.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  SUBPROCESS_TIMEOUT_MS,
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  resolveSubprocessTimeout,
} from './test-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TESTS_DIR = join(REPO, 'tests');

/** The value all 13 suites had copy-pasted, and the one this guard is about. */
const COPY_PASTED_MS = 5000;

/**
 * Find `setTimeout(…, 5000)` constructs whose body aborts a subprocess wait — it kills a
 * child, or rejects with a timeout.
 *
 * Scoped twice on purpose. Deliberately not "any numeric literal": a first draft flagged
 * 300ms settling sleeps, 60s process caps and 30s WAL waits across 14 files, none of which
 * are this defect. And deliberately not "any 5000": `busy_timeout = 5000` and a plain
 * `setTimeout(() => flush(), 5000)` are unrelated. What is left is the exact shape that
 * reddened a full run.
 */
function fiveSecondSubprocessAborts(source) {
  const hits = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('setTimeout(', from);
    if (start === -1) break;
    from = start + 'setTimeout('.length;
    const next = source.indexOf('setTimeout(', from);
    // Slice PAST the `setTimeout(` token before testing the body: the token itself
    // contains "Timeout", so testing the whole window matched every timer in the repo.
    const body = source.slice(from, next === -1 ? source.length : next);
    if (!/kill\(|timeout/i.test(body)) continue;
    const m = body.match(/\}?\s*,\s*(\d{3,})\s*\)/);
    if (m && Number(m[1]) === COPY_PASTED_MS) hits.push(Number(m[1]));
  }
  return hits;
}

// This file carries the shape on purpose, as the scanner's own fixtures. The
// "scanner can say NO" case below is what stops that exemption from hiding a
// scanner that matches nothing.
const SCANNER_FIXTURE_FILE = 'subprocess-timeout-budget.test.mjs';

describe('subprocess timeout budget', () => {
  it('sits under vitest testTimeout, so the specific error is what a reader sees', () => {
    // Above testTimeout, vitest's generic per-test timeout fires first and the message
    // naming WHICH round trip stalled is never printed — the inner timer's whole purpose.
    const config = readFileSync(join(REPO, 'vitest.config.mjs'), 'utf8');
    const testTimeout = Number(config.match(/testTimeout:\s*(\d+)/)?.[1]);
    expect(Number.isFinite(testTimeout), 'could not read testTimeout from vitest.config.mjs').toBe(true);
    expect(SUBPROCESS_TIMEOUT_MS).toBeLessThan(testTimeout);
    // And loose enough to be worth having: the measured idle cost of the heaviest wait
    // (cold `node server.mjs` + native binding + schema, 635ms) with real headroom on top.
    expect(SUBPROCESS_TIMEOUT_MS).toBeGreaterThanOrEqual(10000);
  });

  it('honours MEM_TEST_SUBPROCESS_TIMEOUT_MS, and refuses values that would disarm it', () => {
    expect(resolveSubprocessTimeout('45000')).toBe(45000);
    // A 0ms or NaN timer would abort every subprocess wait instantly — the override must
    // not be able to produce one by accident.
    for (const bad of [undefined, '', 'abc', '0', '-1', null]) {
      expect(resolveSubprocessTimeout(bad), `raw=${JSON.stringify(bad)}`).toBe(DEFAULT_SUBPROCESS_TIMEOUT_MS);
    }
    expect(SUBPROCESS_TIMEOUT_MS).toBe(resolveSubprocessTimeout(process.env.MEM_TEST_SUBPROCESS_TIMEOUT_MS));
  });

  it('no suite reinstates a hard-coded subprocess timeout literal', () => {
    // The class guard. Thirteen files had independently copy-pasted `5000`; nothing
    // stopped the fourteenth, and nothing would stop it coming back one file at a time.
    const offenders = [];
    let scanned = 0;
    for (const f of readdirSync(TESTS_DIR)) {
      if (!f.endsWith('.test.mjs') || f === SCANNER_FIXTURE_FILE) continue;
      scanned++;
      const literals = fiveSecondSubprocessAborts(readFileSync(join(TESTS_DIR, f), 'utf8'));
      if (literals.length > 0) offenders.push(`${f}: ${literals.join(', ')}`);
    }
    expect(scanned, 'the scan found no test files — it is measuring nothing').toBeGreaterThan(100);
    expect(
      offenders,
      'import SUBPROCESS_TIMEOUT_MS from ./test-helpers.mjs instead of a literal:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the scanner can say NO — it flags the shape it is meant to flag', () => {
    // Without this, an "offenders is empty" result is equally consistent with a scanner
    // that matches nothing at all. Both real shapes from the pre-fix tree are covered.
    const multiLine = `
      proc.stdin.write(payload);
      setTimeout(() => {
        proc.stdout.off('data', onData);
        reject(new Error(\`timeout waiting for id=\${id}\`));
      }, 5000);
    `;
    const singleLine = `setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 5000);`;
    expect(fiveSecondSubprocessAborts(multiLine)).toEqual([5000]);
    expect(fiveSecondSubprocessAborts(singleLine)).toEqual([5000]);
    // And that it leaves unrelated timers alone.
    expect(fiveSecondSubprocessAborts(`setTimeout(() => flush(), 5000);`)).toEqual([]);
    expect(fiveSecondSubprocessAborts(`db.pragma('busy_timeout = 5000');`)).toEqual([]);
  });
});
