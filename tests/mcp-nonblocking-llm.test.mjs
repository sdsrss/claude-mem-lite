// D#138 MEDIUM-3: every LLM leg reachable from an MCP request handler must run on
// the non-blocking spawn path, never execFileSync.
//
// server.mjs is a long-lived process with one event loop. execFileSync freezes it
// for the whole child lifetime, so a keyed-provider outage (which degrades to the
// CLI) stalls EVERY concurrent MCP request behind one 45s BG_LLM_TIMEOUT_MS call.
// deep-search already moved to callModelJSONAsync (D#40); these three legs did not:
//
//   mem_optimize            → hook-optimize.mjs      (re-enrich / normalize / merge / compress)
//   mem_registry enrich     → registry-enricher.mjs  (also reached via import_url)
//   mem_search deep+rerank  → rerank.mjs
//
// The assertion is behavioural, not a source grep: each entry point is really
// invoked and child_process is watched. `execFileSync` being untouched IS the
// non-blocking proof — mirrors tests/haiku-client.test.mjs's D#40 F4 case.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

// The real semaphore writes lock files under RUNTIME_DIR; identifySynonymGroups
// bails out with [] when it cannot get a slot, which would pass this test for the
// wrong reason (no LLM call at all).
vi.mock('../hook-semaphore.mjs', () => ({
  acquireLLMSlot: vi.fn(async () => true),
  releaseLLMSlot: vi.fn(),
}));

import { execFileSync, spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { _resetMode, _resetHeadlessFlag } from '../haiku-client.mjs';

/** A spawn() stub that answers with `stdout` one microtask after the caller attaches listeners. */
function autoAnswer(stdout) {
  return () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    child.kill = vi.fn();
    Promise.resolve().then(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    });
    return child;
  };
}

describe('MCP-reachable LLM legs must not block the event loop (D#138 MEDIUM-3)', () => {
  beforeEach(() => {
    // cli mode: no keyed provider, so the call goes straight to the CLI leg —
    // the exact shape a provider outage degrades into.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENROUTER_MODEL', '');
    for (const v of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) vi.stubEnv(v, '');
    _resetMode();
    _resetHeadlessFlag();
    vi.mocked(execFileSync).mockReset();
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mem_optimize (hook-optimize identifySynonymGroups) spawns, never execFileSync', async () => {
    vi.mocked(spawn).mockImplementation(
      autoAnswer('{"groups":[{"canonical":"race condition","aliases":["竞态"]}]}'),
    );
    const { identifySynonymGroups } = await import('../hook-optimize.mjs');

    const groups = await identifySynonymGroups(['race condition', '竞态']);

    expect(execFileSync, 'blocking leg reached from an MCP handler').not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(groups).toEqual([{ canonical: 'race condition', aliases: ['竞态'] }]); // leg really ran
  });

  it('mem_search deep+rerank (defaultRerankLLM) spawns, never execFileSync', async () => {
    vi.mocked(spawn).mockImplementation(autoAnswer('[2,1,3]'));
    const { defaultRerankLLM } = await import('../rerank.mjs');

    const res = await defaultRerankLLM('rank these candidates');

    // Bare-array answers must survive: rerank deliberately takes the {text}
    // envelope instead of a JSON-parsing dispatcher (rerank.mjs:72).
    expect(execFileSync, 'blocking leg reached from an MCP handler').not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ text: '[2,1,3]' });
  });
});

// The three legs above are a hand-maintained list, and a hand-maintained list is
// exactly what failed here: D#138 named two of them and pointed at the wrong file
// for one, and rerank.mjs was found only because a human re-enumerated (#10654).
// This walks server.mjs's real transitive imports instead, so a FOURTH leg fails
// the build rather than waiting to be noticed.
describe('no blocking LLM dispatcher is reachable from server.mjs (static guard)', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  // The blocking dispatchers. Their async twins are the supported way in.
  const BLOCKING = ['callModelJSON', 'callHaikuJSON', 'callLLMWithModel'];
  // Modules whose sync LLM call runs in a DETACHED CHILD, never in the server's
  // event loop. Each entry names the spawn site that makes that true — if one
  // stops spawning, delete the entry and the guard starts covering it.
  const DETACHED_BOUNDARY = {
    'lib/save-enrich.mjs': 'queueSaveEnrich spawns `node hook.mjs enrich-save <id>` detached',
  };

  /** Local (non-package) import specifiers in `src`, resolved to repo-relative paths. */
  function localImports(src, fromFile) {
    const out = [];
    const re = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const resolved = join(dirname(fromFile), m[1]);
      out.push(relative(REPO, resolved));
    }
    return out;
  }

  it("no module in server.mjs's import graph imports a blocking dispatcher", () => {
    const seen = new Set();
    const offenders = [];
    const queue = ['server.mjs'];

    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel) || DETACHED_BOUNDARY[rel]) continue;
      seen.add(rel);
      const abs = join(REPO, rel);
      if (!existsSync(abs)) continue; // package import or generated path
      const src = readFileSync(abs, 'utf8');

      // Only count a REAL import binding, not a mention in prose: the twins'
      // JSDoc names the sync functions repeatedly, and a substring check would
      // make this guard fire on its own documentation.
      for (const fn of BLOCKING) {
        const bindsIt = new RegExp(
          `import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from|\\bconst\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*=\\s*await\\s+import`,
        ).test(src);
        if (bindsIt) offenders.push(`${rel} imports ${fn}`);
      }
      queue.push(...localImports(src, abs));
    }

    expect(seen.size, 'import walk found nothing — the regex or entry point drifted').toBeGreaterThan(20);
    expect(offenders, 'a blocking LLM dispatcher is reachable from an MCP request handler').toEqual([]);
  });

  // Guards the guard: if save-enrich stops spawning detached, its sync call
  // becomes a real leg and the exemption above silently keeps hiding it.
  it('the detached-boundary exemptions still actually spawn detached', () => {
    for (const rel of Object.keys(DETACHED_BOUNDARY)) {
      const src = readFileSync(join(REPO, rel), 'utf8');
      expect(src, `${rel} is exempt because: ${DETACHED_BOUNDARY[rel]}`).toMatch(/detached:\s*true/);
    }
  });
});
