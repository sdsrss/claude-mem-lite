// Every spawnBackground site must honour its event's skip flag — at EVERY call site.
//
// hook.mjs already has an invariant for these workers: tests/audit-findings-20260814.test.mjs
// reds when a spawned event is missing from BG_EVENTS, because a missing entry makes the
// detached worker exit(0) in a way that looks exactly like "ran and found nothing". That
// guard checks the event NAME. It cannot see a call site that skips the event's SUPPRESSION
// FLAG, which is the defect this file covers.
//
// Found while measuring D#2: `llm-summary` was gated by CLAUDE_MEM_SKIP_SUMMARY at its
// handleStop call site and ungated at its SessionStart handoff call site. The flag exists
// because that worker recreates a test's sandbox tree behind the test's own cleanup — the
// comment at the gated site records a recreate timed at 432ms beating a 300ms grace period,
// i.e. "wait a bit" is a race, not a barrier. A flag honoured at one of two call sites
// cannot do that job.
//
// This is a source scan, chosen deliberately over a behavioural one: hook.mjs dispatches on
// process.argv at module scope, so it cannot be imported in-process to spy on the spawn, and
// the subprocess route cannot discriminate a suppressed spawn from a spawned worker that
// died on the missing `claude` binary the suite points it at. The counter-example is
// therefore taken from the real pre-fix line rather than invented.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// `new URL('../hook.mjs', import.meta.url)` would drop hook.mjs out of knip's report —
// tests/no-url-module-paths.test.mjs pins this idiom repo-wide.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SRC = readFileSync(join(ROOT, 'hook.mjs'), 'utf8');
const UPDATE_SRC = readFileSync(join(ROOT, 'hook-update.mjs'), 'utf8');

// event -> the env flag a user (or a test) sets to suppress it.
const SKIP_FLAG_FOR_EVENT = {
  'llm-episode': 'CLAUDE_MEM_SKIP_EPISODE_LLM',
  'llm-summary': 'CLAUDE_MEM_SKIP_SUMMARY',
  'auto-compress': 'CLAUDE_MEM_SKIP_COMPRESS',
  'llm-optimize': 'CLAUDE_MEM_SKIP_OPTIMIZE',
  'auto-maintain': 'CLAUDE_MEM_SKIP_MAINTAIN',
  'update-check': 'CLAUDE_MEM_SKIP_UPDATE',
};

// Events whose flag is honoured somewhere other than the guard around the spawn. Each entry
// states where, and the test below verifies that claim instead of taking it on trust.
const INDIRECTLY_GATED = {
  'update-check': {
    where: 'hook-update.mjs isUpdateCheckDue()',
    // hook.mjs guards the spawn with `if (updateCheckDue)`, and updateCheckDue comes from
    // isUpdateCheckDue(), which returns false under the flag.
    src: () => UPDATE_SRC,
  },
};

// How far back from the spawn line the controlling guard may sit. The llm-episode site puts
// its `if (...) {` on the line above; nothing legitimate needs more room than this.
const GUARD_WINDOW_LINES = 4;

// A comment that QUOTES a spawn call is not a spawn call. hook.mjs:1643 does exactly that
// ("Every production spawn passes it (spawnBackground('auto-maintain', project))") and the
// first draft of this scan reported it as an ungated site — the same failure mode as
// counting a commented-out import as a dependency edge.
function isComment(text) {
  const t = text.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function spawnSites(src) {
  const lines = src.split('\n');
  const sites = [];
  lines.forEach((text, i) => {
    if (isComment(text)) return;
    const m = text.match(/spawnBackground\(\s*'([a-z-]+)'/);
    if (!m) return;
    sites.push({
      event: m[1],
      line: i + 1,
      window: lines.slice(Math.max(0, i - GUARD_WINDOW_LINES), i + 1).join('\n'),
    });
  });
  return sites;
}

describe('spawnBackground skip-flag invariant', () => {
  it('finds every spawnBackground call site in hook.mjs', () => {
    // Premise assertion. If the regex stops matching, every case below passes vacuously —
    // which is how a guard quietly stops guarding.
    const sites = spawnSites(HOOK_SRC);
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(new Set(sites.map((s) => s.event)).size).toBeGreaterThanOrEqual(5);
  });

  it('knows a skip flag for every event it spawns', () => {
    for (const site of spawnSites(HOOK_SRC)) {
      expect(
        SKIP_FLAG_FOR_EVENT[site.event],
        `hook.mjs:${site.line} spawns '${site.event}', which has no entry in SKIP_FLAG_FOR_EVENT. ` +
          `Add its suppression flag (and honour it at the call site) or state why it needs none.`,
      ).toBeTruthy();
    }
  });

  it('gates every call site on that event flag', () => {
    const offenders = [];
    for (const site of spawnSites(HOOK_SRC)) {
      const flag = SKIP_FLAG_FOR_EVENT[site.event];
      if (!flag) continue; // reported by the case above
      if (site.window.includes(flag)) continue;
      if (INDIRECTLY_GATED[site.event]) continue; // verified by the case below
      offenders.push(`hook.mjs:${site.line} spawns '${site.event}' without ${flag} in its guard`);
    }
    expect(offenders).toEqual([]);
  });

  it('verifies the indirect gates actually honour the flag', () => {
    for (const [event, { where, src }] of Object.entries(INDIRECTLY_GATED)) {
      const flag = SKIP_FLAG_FOR_EVENT[event];
      expect(
        src().includes(flag),
        `'${event}' is exempted on the grounds that ${where} honours ${flag}, but that file ` +
          `does not mention the flag — the exemption has gone stale.`,
      ).toBe(true);
    }
  });

  it('has both llm-summary call sites gated, not just the handleStop one', () => {
    // The specific regression. Kept as its own case so a future reader sees the shape that
    // motivated the general rule above, and so a rewrite of the scan cannot lose it.
    const sites = spawnSites(HOOK_SRC).filter((s) => s.event === 'llm-summary');
    expect(sites.length).toBe(2);
    for (const site of sites) {
      expect(site.window, `hook.mjs:${site.line}`).toContain('CLAUDE_MEM_SKIP_SUMMARY');
    }
  });
});
