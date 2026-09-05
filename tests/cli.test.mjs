// Tests for mem-cli.mjs — CLI command layer
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { seedVectors } from '../benchmark/benchmark.mjs';
// _resetVocabCache is imported below via the post-mock dynamic import (line ~101).

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Import mem-cli.mjs command functions indirectly via run().
 * Since internal functions (cmdSearch, cmdRecent, etc.) are not exported,
 * we test through the public run() interface by capturing stdout.
 *
 * To inject a :memory: DB, we mock schema.mjs's ensureDb.
 */

let testDb;

// Capture stdout + stderr combined (fail() writes to stderr, out() to stdout)
function captureStdout(fn) {
  let output = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (str) => { output += str; return true; };
  process.stderr.write = (str) => { output += str; return true; };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        return output;
      }).catch((err) => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        throw err;
      });
    }
  } catch (err) {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    throw err;
  }
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  return output;
}

// Capture stdout only (for JSON output tests that must not mix stderr)
function captureStdoutOnly(fn) {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = (str) => { output += str; return true; };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        process.stdout.write = original;
        return output;
      }).catch((err) => {
        process.stdout.write = original;
        throw err;
      });
    }
  } catch (err) {
    process.stdout.write = original;
    throw err;
  }
  process.stdout.write = original;
  return output;
}

// Mock ensureDb to return our test DB
vi.mock('../schema.mjs', async (importOriginal) => {
  const original = await importOriginal();
  // Proxy intercepts close() so the CLI can't close our test DB. Stub BOTH
  // openers — mem-cli routes through ensureDbWithWalRecovery since the
  // WAL-recovery hoist; an unstubbed opener escapes to the real user DB.
  const stub = () => new Proxy(testDb, {
    get(target, prop) {
      if (prop === 'close') return () => {};
      return target[prop];
    },
  });
  return { ...original, ensureDb: stub, ensureDbWithWalRecovery: stub };
});

// Mock inferProject to return a consistent value
vi.mock('../utils.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    inferProject: () => 'test--project',
  };
});

// Import run after mocks are set up
const { run } = await import('../mem-cli.mjs');
const { buildVocabulary, computeVector, _resetVocabCache } = await import('../tfidf.mjs');

// ─── Argument Parsing ────────────────────────────────────────────────────────
// parseArgs is not exported, but we can test its behavior through commands

describe('CLI argument parsing (via commands)', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('search parses query and --type flag', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed auth crash', text: 'authentication error in login',
    });
    const output = await captureStdout(() => run(['search', 'authentication', '--type', 'bugfix']));
    expect(output).toContain('Fixed auth crash');
    expect(output).toContain('result');
  });

  it('search parses --limit flag', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Discovery ${i}`, text: `search term alpha ${i}`,
      });
    }
    const output = await captureStdout(() => run(['search', 'alpha', '--limit', '2']));
    // Should have header + 2 result lines
    const lines = output.trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(3); // header + 2 results max
  });

  it('recent parses count from positional arg', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Recent obs ${i}`, text: `content ${i}`, epochOffset: i * 1000,
      });
    }
    const output = await captureStdout(() => run(['recent', '2']));
    const lines = output.trim().split('\n');
    // header + 2 entries
    expect(lines.length).toBe(3);
  });

  it('get parses comma-separated IDs', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'First obs', text: 'first content',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Second obs', text: 'second content',
    });
    const output = await captureStdout(() => run(['get', '1,2']));
    expect(output).toContain('First obs');
    expect(output).toContain('Second obs');
  });
});

// ─── search command ──────────────────────────────────────────────────────────

describe('CLI search command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('returns results with correct output format', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed database connection timeout', text: 'database connection pool was exhausted',
    });
    const output = await captureStdout(() => run(['search', 'database connection']));
    expect(output).toContain('[mem]');
    expect(output).toContain('result');
    expect(output).toContain('Fixed database connection timeout');
    // Output line format: #ID ICON DATE TITLE
    expect(output).toMatch(/#\d+/);
  });

  it('shows "No results" for unmatched query', async () => {
    const output = await captureStdout(() => run(['search', 'zzzyyyxxx']));
    expect(output).toContain('No results');
  });

  it('filters by --type', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug in parser', text: 'parser logic error',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Discovered parser pattern', text: 'parser pattern discovery',
    });
    const bugOnly = await captureStdout(() => run(['search', 'parser', '--type', 'bugfix']));
    expect(bugOnly).toContain('Bug in parser');
    expect(bugOnly).not.toContain('Discovered parser pattern');
  });

  it('--type filter must hold across the vector/RRF hybrid path (regression)', async () => {
    _resetVocabCache();
    // Mixed-type corpus with shared vocabulary so vector path engages.
    // The non-bugfix rows must NOT leak through vector RRF merge.
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Race in worker queue', narrative: 'fixed worker queue race condition crash',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'Worker queue architecture choice', narrative: 'chose redis queue over rabbitmq for worker pool',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Worker pool throughput pattern', narrative: 'worker pool throughput scales with queue depth',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'feature',
      title: 'Worker pool autoscale feature', narrative: 'added autoscale to worker pool queue',
    });
    // Build vocab + write vectors to engage hybrid path.
    const vocab = buildVocabulary(testDb);
    if (vocab) {
      const rows = testDb.prepare('SELECT id, title, narrative FROM observations').all();
      for (const r of rows) {
        const vec = computeVector(`${r.title} ${r.narrative}`, vocab);
        if (vec) {
          testDb.prepare(
            'INSERT INTO observation_vectors (observation_id, vector, vocab_version, created_at_epoch) VALUES (?, ?, ?, ?)'
          ).run(r.id, Buffer.from(vec.buffer), vocab.version, Date.now());
        }
      }
      testDb.prepare(
        'INSERT INTO vocab_state (term, term_index, idf, version, created_at_epoch) VALUES (?, ?, ?, ?, ?)'
      );
      testDb.transaction(() => {
        testDb.prepare('DELETE FROM vocab_state').run();
        const ins = testDb.prepare(
          'INSERT INTO vocab_state (term, term_index, idf, version, created_at_epoch) VALUES (?, ?, ?, ?, ?)'
        );
        for (const [term, entry] of vocab.terms) {
          ins.run(term, entry.index, entry.idf, vocab.version, Date.now());
        }
      })();
    }
    const out = await captureStdout(() => run(['search', 'worker queue', '--type', 'bugfix']));
    expect(out).toContain('Race in worker queue');
    expect(out).not.toContain('architecture choice');
    expect(out).not.toContain('throughput pattern');
    expect(out).not.toContain('autoscale feature');
  });

  it('respects --limit', async () => {
    for (let i = 0; i < 10; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Widget feature ${i}`, text: `widget implementation details ${i}`,
      });
    }
    const output = await captureStdout(() => run(['search', 'widget', '--limit', '3']));
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBeLessThanOrEqual(3);
  });

  it('shows lesson_learned when present', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Race condition in queue', text: 'queue race condition',
      lessonLearned: 'Always use mutex for shared state',
    });
    const output = await captureStdout(() => run(['search', 'queue race']));
    expect(output).toContain('Always use mutex');
  });

  it('falls back to OR query when AND returns nothing', async () => {
    // Insert observation that matches "alpha" but not "alpha AND zzzzz"
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Alpha discovery', text: 'alpha protocol implementation details',
    });
    // "alpha zzzzz" as AND query won't match, but OR fallback should find "alpha"
    const output = await captureStdout(() => run(['search', 'alpha zzzzz']));
    expect(output).toContain('Alpha discovery');
  });

  // R-1: LOW_SIGNAL title filtering — default search hides hook-llm degraded titles
  // ("Modified X", "Worked on X", etc.) that compete for BM25 rank but have
  // ~3% access rate. They remain searchable via --include-noise.
  it('excludes LOW_SIGNAL titles from default search', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Modified auth.mjs',
      text: 'uniquealphatoken handling tweaked',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Auth flow uniquealphatoken validation fix',
      text: 'uniquealphatoken validation root cause',
    });
    const output = await captureStdout(() => run(['search', 'uniquealphatoken']));
    expect(output).toContain('Auth flow uniquealphatoken validation fix');
    expect(output).not.toContain('Modified auth.mjs');
  });

  it('--include-noise restores LOW_SIGNAL titles in search results', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Modified auth.mjs',
      text: 'uniquealphatoken handling tweaked',
    });
    const output = await captureStdout(() => run(['search', 'uniquealphatoken', '--include-noise']));
    expect(output).toContain('Modified auth.mjs');
  });

  it('obs results carry created_at in --json (parity with recent/recall, sessions/prompts)', async () => {
    // Regression: ftsRowToResult keyed the date as `date`, but cmdSearch read `r.created_at`
    // — so obs rows in search --json had a null created_at and the human date column was
    // blank, while interleaved session/prompt rows (raw SQL) carried it. The key was aligned.
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Cache uniquegammatoken invalidation fix', text: 'uniquegammatoken root cause',
    });
    const output = await captureStdoutOnly(() => run(['search', 'uniquegammatoken', '--json']));
    const parsed = JSON.parse(output);
    expect(parsed.results.length).toBeGreaterThan(0);
    const obs = parsed.results.find(r => r.source === 'obs');
    expect(obs).toBeDefined();
    expect(obs.created_at).toBeTruthy();
    expect(() => new Date(obs.created_at).toISOString()).not.toThrow();
  });

  it('emits a valid empty JSON envelope when the query sanitizes to no terms (--json contract)', async () => {
    // Regression: `search 'AND OR NOT' --json` (or any query that strips to an empty
    // FTS expression) hit the early `fail()` for empty ftsQuery, which writes to stderr
    // and emits NOTHING on stdout — breaking JSON.parse for programmatic consumers. The
    // no-match path already returns {total:0,results:[]}; no-valid-terms must match it,
    // since "search whose terms all dropped" is just another zero-result search.
    const output = await captureStdoutOnly(() => run(['search', 'AND OR NOT', '--json']));
    expect(output.trim()).not.toBe('');
    const parsed = JSON.parse(output);
    expect(parsed.total).toBe(0);
    expect(parsed.returned).toBe(0);
    expect(parsed.results).toEqual([]);
    process.exitCode = undefined;
  });

  // R-3: lesson_learned presence lifts rank vs identical obs without lesson.
  // Empirical basis: bugfix with lesson has +6.3pp hit rate over bugfix without.
  // The multiplier is intentionally small (×1.3) — this is a gentle rerank, not a bucket.
  it('ranks observations with lesson_learned above identical ones without', async () => {
    // Insert the WITHOUT-lesson row first (newer) to prove the lesson boost
    // overcomes any tie-break favoring recency.
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Queue fix uniquebetatoken variant A',
      text: 'uniquebetatoken race condition in worker queue',
      epochOffset: 0,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Queue fix uniquebetatoken variant B',
      text: 'uniquebetatoken race condition in worker queue',
      lessonLearned: 'Always acquire the mutex before peeking the queue head',
      epochOffset: -5000,
    });
    const output = await captureStdout(() => run(['search', 'uniquebetatoken']));
    const withIdx = output.indexOf('Queue fix uniquebetatoken variant B');
    const withoutIdx = output.indexOf('Queue fix uniquebetatoken variant A');
    expect(withIdx).toBeGreaterThan(-1);
    expect(withoutIdx).toBeGreaterThan(-1);
    // Lower index = appears first in ranked output
    expect(withIdx).toBeLessThan(withoutIdx);
  });

  it('shows usage when no query provided', async () => {
    const output = await captureStdout(() => run(['search']));
    expect(output).toContain('Usage');
  });
});

// ─── recent command ──────────────────────────────────────────────────────────

describe('CLI recent command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows recent observations with default count (10)', async () => {
    for (let i = 0; i < 12; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Observation ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const output = await captureStdout(() => run(['recent']));
    expect(output).toContain('[mem] Recent');
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(10);
  });

  it('respects explicit count', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Obs ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const output = await captureStdout(() => run(['recent', '3']));
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(3);
  });

  it('shows "No recent observations" when DB is empty', async () => {
    const output = await captureStdout(() => run(['recent']));
    expect(output).toContain('No recent observations');
  });

  it('formats relative time correctly', async () => {
    // Insert obs with epoch 2 hours ago
    const twoHoursAgo = Date.now() - 2 * 3600000;
    testDb.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', 'content', 'discovery', 'Two hours ago obs', '', '', '', '', '[]', '[]', 1, ?, ?)
    `).run(new Date(twoHoursAgo).toISOString(), twoHoursAgo);

    const output = await captureStdout(() => run(['recent']));
    expect(output).toContain('2h ago');
  });

  it('--since filters to a relative window; invalid duration errors', async () => {
    const mk = (title, ageMs) => testDb.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', ?, 'discovery', ?, '', '', '', '', '[]', '[]', 1, ?, ?)
    `).run(title, title, new Date(Date.now() - ageMs).toISOString(), Date.now() - ageMs);
    mk('fresh-2h', 2 * 3600000);
    mk('old-10d', 10 * 86400000);

    const within = await captureStdout(() => run(['recent', '100', '--since', '24h']));
    expect(within).toContain('fresh-2h');
    expect(within).not.toContain('old-10d');

    const wide = await captureStdout(() => run(['recent', '100', '--since', '30d']));
    expect(wide).toContain('fresh-2h');
    expect(wide).toContain('old-10d');

    const errOut = await captureStdout(() => run(['recent', '--since', '7days']));
    expect(errOut).toContain('Invalid --since');
  });

  it('excludes compressed observations', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed obs', text: 'content', compressedInto: 999,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active obs', text: 'content',
    });
    const output = await captureStdout(() => run(['recent']));
    expect(output).not.toContain('Compressed obs');
    expect(output).toContain('Active obs');
  });

  // Regression anchor: --limit flag parity with sibling commands (search/recall/browse/stats).
  // Pre-fix `recent --limit N` was silently ignored — only positional [N] worked, surprising
  // users who reasonably extrapolated from sibling CLI conventions. Positional still wins
  // when both are given, preserving backward-compat with documented `recent N` form.
  it('respects --limit flag as alias for positional count', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Obs ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const output = await captureStdout(() => run(['recent', '--limit', '3']));
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(3);
  });

  it('--limit invalid value warns and falls back to default 10', async () => {
    for (let i = 0; i < 12; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Obs ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const output = await captureStdout(() => run(['recent', '--limit', '-5']));
    expect(output).toContain('Invalid --limit');
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(10);
  });

  // Regression: positional [N] must honor the same max:1000 cap as --limit. Pre-fix
  // the positional path skipped parseIntFlag's upper bound, so `recent 999999` issued
  // an uncapped `LIMIT 999999` full-table dump while `recent --limit 999999` correctly
  // rejected → default 10. The help calls [N] and --limit equivalent ("max 1000"), and
  // parseIntFlag was extracted precisely to stop "none capped --limit" result dumps.
  it('positional count over max (1000) warns and falls back to default 10', async () => {
    for (let i = 0; i < 12; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Obs ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const output = await captureStdout(() => run(['recent', '999999']));
    expect(output).toContain('between 1 and 1000');
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(10);
  });

  // Boundary: exactly 1000 is the documented max and must remain valid (≤1000).
  it('positional count at the 1000 boundary is accepted (no warning)', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Boundary obs', text: 'content', epochOffset: 1000,
    });
    const output = await captureStdout(() => run(['recent', '1000']));
    expect(output).not.toContain('Invalid count');
    expect(output).toContain('Boundary obs');
  });

  // `recent --type bugfix` previously parsed as a silent no-op — the flag was unrecognized
  // and returned every obs type. Mirrors the validation cmdSearch already had.
  it('--type filter narrows to a single observation type', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix', title: 'Bug A', text: 'a' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery', title: 'Disc B', text: 'b' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix', title: 'Bug C', text: 'c' });
    const output = await captureStdout(() => run(['recent', '--type', 'bugfix']));
    expect(output).toContain('Bug A');
    expect(output).toContain('Bug C');
    expect(output).not.toContain('Disc B');
  });

  it('--type rejects unknown obs types', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix', title: 'Bug', text: 'x' });
    const output = await captureStdout(() => run(['recent', '--type', 'WRONG']));
    expect(output).toContain('Invalid --type');
    expect(output).toContain('WRONG');
  });
});

// ─── recall command ──────────────────────────────────────────────────────────

describe('CLI recall command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('finds observations by filename in files_modified', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Updated server config', text: 'config update',
      filesModified: '["src/server.mjs"]',
    });
    const output = await captureStdout(() => run(['recall', 'src/server.mjs']));
    expect(output).toContain('History for server.mjs');
    expect(output).toContain('Updated server config');
  });

  it('shows "No history" for unknown file', async () => {
    const output = await captureStdout(() => run(['recall', 'nonexistent.ts']));
    expect(output).toContain('No history');
  });

  it('shows lesson_learned inline when present', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed import order', text: 'import bug',
      filesModified: '["app/main.ts"]',
      lessonLearned: 'Check import order carefully',
    });
    const output = await captureStdout(() => run(['recall', 'main.ts']));
    expect(output).toContain('Check import order');
  });

  it('shows usage when no file provided', async () => {
    const output = await captureStdout(() => run(['recall']));
    expect(output).toContain('Usage');
  });
});

// ─── get command ─────────────────────────────────────────────────────────────

describe('CLI get command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows full detail for single ID', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'Chose PostgreSQL over MySQL',
      text: 'database selection',
      narrative: 'We evaluated both databases and chose Postgres for JSON support',
    });
    const output = await captureStdout(() => run(['get', '1']));
    expect(output).toContain('#1 [decision]');
    expect(output).toContain('title: Chose PostgreSQL over MySQL');
    expect(output).toContain('narrative: We evaluated both databases');
  });

  it('shows multiple IDs', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'First observation', text: 'first',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'feature',
      title: 'Second observation', text: 'second',
    });
    const output = await captureStdout(() => run(['get', '1,2']));
    expect(output).toContain('First observation');
    expect(output).toContain('Second observation');
  });

  it('shows "No records found" for non-existent ID', async () => {
    const output = await captureStdout(() => run(['get', '9999']));
    expect(output).toMatch(/No records found.*\[obs\]/);
  });

  it('shows files from files_modified under the `files` label', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Updated configs', text: 'config changes',
      filesModified: '["src/config.ts", "src/db.ts"]',
    });
    const output = await captureStdout(() => run(['get', '1']));
    // Label is `files`, not the raw column name: the column also holds paths a caller only
    // read (audit 2026-08-14 F3). The column itself is unchanged — this row was seeded via
    // filesModified above and still renders.
    expect(output).toContain('files: ["src/config.ts", "src/db.ts"]');
    expect(output).not.toMatch(/^files_modified:/m);
  });

  it('shows lesson when present', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Memory leak fix', text: 'memory leak',
      lessonLearned: 'Always clear intervals on unmount',
    });
    const output = await captureStdout(() => run(['get', '1']));
    expect(output).toContain('lesson_learned: Always clear intervals on unmount');
  });

  it('shows usage when no IDs provided', async () => {
    const output = await captureStdout(() => run(['get']));
    expect(output).toContain('Usage');
  });
});

// ─── pagination stability WITH vectors (D#30 reopened) ───────────────────────
// The #8642 guard test (cli-e2e) seeds NO observation_vectors, so it only proved
// FTS-only pagination is stable. This block populates vectors so the FTS+vector
// RRF fusion is live — the exact path that overlapped/gapped on the real DB before
// computePerSourceWindow was made offset-independent.
describe('CLI search pagination stability (hybrid FTS+vector RRF)', () => {
  beforeEach(() => {
    _resetVocabCache();
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    // 25 obs all matching "widget" with VARIED FTS weight (widget repeated 0–4×)
    // and varied vector content (distinct term mixes) so fusion is non-trivial and
    // candidate-pool-sensitive — a smaller pool would re-rank the prefix.
    for (let i = 0; i < 25; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `widget pipeline stage ${i} ${i % 3 === 0 ? 'cache' : 'queue'} handler`,
        text: `widget pipeline payload ${i} ${'widget '.repeat(i % 5)}`,
        epochOffset: -i * 1000,
      });
    }
    seedVectors(testDb);   // build vocab + observation_vectors over the corpus
    _resetVocabCache();    // force the search to reload the seeded vocab
  });
  afterEach(() => { testDb.close(); });

  const idsOf = async (...args) => {
    const out = await captureStdoutOnly(() => run(['search', 'widget', '--source', 'observations', '--json', ...args]));
    return JSON.parse(out).results.map(r => r.id);
  };

  it('paging limit=5 across offsets is disjoint and reconstructs the single query', async () => {
    const vecCount = testDb.prepare('SELECT COUNT(*) AS c FROM observation_vectors').get().c;
    expect(vecCount).toBeGreaterThan(0); // guard: vector arm is actually live
    const p0 = await idsOf('--limit', '5', '--offset', '0');
    const p1 = await idsOf('--limit', '5', '--offset', '5');
    const p2 = await idsOf('--limit', '5', '--offset', '10');
    const combined = await idsOf('--limit', '15', '--offset', '0');
    const paged = [...p0, ...p1, ...p2];
    expect(new Set(paged).size).toBe(paged.length);   // no id on two pages
    expect(paged).toEqual(combined);                  // identical order ⇒ stable
  });

  it('top-N is limit-stable for limits ≤ 20 (top-5 ⊂ top-10 ⊂ top-20)', async () => {
    const t5 = await idsOf('--limit', '5');
    const t10 = await idsOf('--limit', '10');
    const t20 = await idsOf('--limit', '20');
    expect(t10.slice(0, 5)).toEqual(t5);
    expect(t20.slice(0, 10)).toEqual(t10);
  });
});

// ─── timeline command ────────────────────────────────────────────────────────

describe('CLI timeline command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows timeline around anchor with <-- marker', async () => {
    const baseEpoch = Date.now() - 100000;
    for (let i = 0; i < 7; i++) {
      const epoch = baseEpoch + i * 10000;
      testDb.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES ('mem-s1', 'test--project', 'content ${i}', 'discovery', 'Timeline obs ${i}', '', '', '', '', '[]', '[]', 1, ?, ?)
      `).run(new Date(epoch).toISOString(), epoch);
    }
    // Anchor on the 4th observation (id=4)
    const output = await captureStdout(() => run(['timeline', '--anchor', '4']));
    expect(output).toContain('Timeline around #4');
    expect(output).toContain('<--');
    // Should show observations around the anchor
    expect(output).toContain('Timeline obs');
  });

  it('respects --before and --after counts', async () => {
    const baseEpoch = Date.now() - 100000;
    for (let i = 0; i < 10; i++) {
      const epoch = baseEpoch + i * 10000;
      testDb.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES ('mem-s1', 'test--project', 'content ${i}', 'discovery', 'TL ${i}', '', '', '', '', '[]', '[]', 1, ?, ?)
      `).run(new Date(epoch).toISOString(), epoch);
    }
    const output = await captureStdout(() => run(['timeline', '--anchor', '5', '--before', '1', '--after', '1']));
    // Should have header + anchor + 1 before + 1 after = 4 lines
    const resultLines = output.trim().split('\n').filter(l => l.startsWith('#'));
    expect(resultLines.length).toBe(3); // 1 before + anchor + 1 after
  });

  it('shows "not found" for invalid anchor', async () => {
    const output = await captureStdout(() => run(['timeline', '--anchor', '999']));
    expect(output).toContain('not found');
  });

  it('emits a valid JSON envelope when the anchor is not found (--json contract)', async () => {
    // Regression: `timeline --anchor 999 --json` hit `fail(formatAnchorError(...))`,
    // emitting nothing on stdout and breaking JSON.parse. --json must always yield a
    // parseable envelope; anchor:null + an error code signals the miss to consumers.
    const output = await captureStdoutOnly(() => run(['timeline', '--anchor', '999', '--json']));
    expect(output.trim()).not.toBe('');
    const parsed = JSON.parse(output);
    expect(parsed.anchor).toBeNull();
    expect(parsed.error).toBeTruthy();
    expect(parsed.before).toEqual([]);
    expect(parsed.after).toEqual([]);
    process.exitCode = undefined;
  });

  it('shows recent observations when no --anchor provided', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Recent obs', text: 'content', epochOffset: 0,
    });
    const output = await captureStdout(() => run(['timeline']));
    expect(output).toContain('Timeline (most recent');
    expect(output).toContain('Recent obs');
  });

  it('shows "No observations" when no --anchor and DB empty', async () => {
    const output = await captureStdout(() => run(['timeline']));
    expect(output).toContain('No observations');
  });
});

// ─── save command ────────────────────────────────────────────────────────────

describe('CLI save command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('saves with default options (type=discovery)', async () => {
    const output = await captureStdout(() => run(['save', 'Authentication uses JWT tokens']));
    expect(output).toContain('[mem] Saved');
    expect(output).toContain('[discovery]');
    expect(output).toContain('Authentication uses JWT tokens');

    // Verify in DB
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.type).toBe('discovery');
    expect(row.text).toBe('Authentication uses JWT tokens');
    expect(row.importance).toBe(2); // default
  });

  it('saves with explicit --type and --title', async () => {
    const output = await captureStdout(() => run(['save', 'Use Redis for caching', '--type', 'decision', '--title', 'Cache architecture']));
    expect(output).toContain('[decision]');
    expect(output).toContain('Cache architecture');

    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.type).toBe('decision');
    expect(row.title).toBe('Cache architecture');
  });

  // Audit 2026-07-17 P4: bugfix/decision saved WITHOUT --lesson get a save-time nudge
  // naming the exact follow-up command — live data shows lessonless concentrates on
  // exactly these types (14d: bugfix 18.8% / decision 28.7%), and the save response is
  // the one moment the caller still has the context to write the lesson.
  it('nudges when a bugfix is saved without --lesson', async () => {
    const output = await captureStdout(() => run(['save', 'Fixed the race in the flush path', '--type', 'bugfix', '--title', 'Flush race fix']));
    expect(output).toContain('[mem] Saved');
    expect(output).toContain('without a lesson');
    expect(output).toContain('--lesson');
  });

  it('does NOT nudge when the lesson is provided, or for low-obligation types', async () => {
    const withLesson = await captureStdout(() => run(['save', 'Fixed the race', '--type', 'bugfix', '--title', 'Race fix 2', '--lesson', 'Hold the lock until the side-effect commits']));
    expect(withLesson).toContain('💡lesson captured');
    expect(withLesson).not.toContain('without a lesson');

    const discovery = await captureStdout(() => run(['save', 'Interesting corner of the codebase', '--type', 'discovery']));
    expect(discovery).not.toContain('without a lesson');
  });

  it('rejects out-of-range importance (must be 1-3)', async () => {
    const out5 = await captureStdout(() => run(['save', 'Test importance high', '--importance', '5']));
    expect(out5).toContain('Invalid importance');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const out0 = await captureStdout(() => run(['save', 'Test importance zero', '--importance', '0']));
    expect(out0).toContain('Invalid importance');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const outNeg = await captureStdout(() => run(['save', 'Test importance neg', '--importance', '-1']));
    expect(outNeg).toContain('Invalid importance');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    // Valid importance 1 saves successfully
    await captureStdout(() => run(['save', 'Test importance one', '--importance', '1']));
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.importance).toBe(1);
  });

  // Round2-P2: bare parseInt coerced garbage tokens ("2abc"→2, "1e2"→1) past the
  // range guard and PERSISTED a wrong importance (skews ranking/decay). Strict-token
  // gate now rejects them like "5"/"0". Float literals still truncate (#8277).
  it('rejects garbage-token --importance (no silent parseInt coercion/persist)', async () => {
    for (const bad of ['2abc', '3xyz', '1e2']) {
      const out = await captureStdout(() => run(['save', `imp ${bad}`, '--importance', bad]));
      expect(out, `--importance "${bad}" should be rejected`).toContain('Invalid importance');
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    }
    expect(testDb.prepare('SELECT COUNT(*) c FROM observations').get().c).toBe(0); // nothing persisted
    // Float literal still truncates + saves (deliberate #8277 parity with parseIntFlag).
    await captureStdout(() => run(['save', 'imp float two-point-nine', '--importance', '2.9']));
    expect(testDb.prepare('SELECT importance FROM observations ORDER BY id DESC LIMIT 1').get().importance).toBe(2);
  });

  it('rejects invalid type', async () => {
    const output = await captureStdout(() => run(['save', 'test content', '--type', 'invalid']));
    expect(output).toContain('Invalid type');
    expect(output).toContain('Valid:');
  });

  it('shows usage when no text provided', async () => {
    const output = await captureStdout(() => run(['save']));
    expect(output).toContain('Usage');
  });

  // 2026-07-24: flags-only save. Callers coming from the MCP mem_save schema map every
  // field to a named flag (--title/--lesson/--type) and omit the positional; the usage
  // error lands on stderr and the whole shape reads as "CLI doesn't support save".
  // --text is the positional-content alias so the flags-only invocation just works.
  it('saves with --text as flags-only alias for positional content', async () => {
    const output = await captureStdout(() => run(['save', '--text', 'Keepalive audit: three residual gaps', '--type', 'decision', '--title', 'Keepalive audit', '--lesson', 'Half-open detection has two blind spots']));
    expect(output).toContain('[mem] Saved');
    const row = testDb.prepare('SELECT * FROM observations ORDER BY id DESC LIMIT 1').get();
    expect(row.text).toBe('Keepalive audit: three residual gaps');
    expect(row.type).toBe('decision');
    expect(row.title).toBe('Keepalive audit');
  });

  it('rejects when content is given both positionally and via --text', async () => {
    const output = await captureStdout(() => run(['save', 'positional content', '--text', 'flag content']));
    expect(output).toContain('both');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(testDb.prepare('SELECT COUNT(*) c FROM observations').get().c).toBe(0); // nothing persisted
  });

  it('rejects bare --text with a clean error (no stacktrace)', async () => {
    const output = await captureStdout(() => run(['save', '--text']));
    expect(output).toContain('--text requires a value');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('advertises --text in the no-content usage line', async () => {
    const output = await captureStdout(() => run(['save']));
    expect(output).toContain('--text');
    process.exitCode = undefined;
  });

  it('creates a session for FK constraint', async () => {
    await captureStdout(() => run(['save', 'New observation via CLI']));
    const sessions = testDb.prepare("SELECT * FROM sdk_sessions WHERE content_session_id LIKE 'manual-%'").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].status).toBe('active');
  });
});

// ─── MCP-field flag aliases (#233 family) ────────────────────────────────────
// LLM callers map MCP tool schemas onto flags: mem_save.content → --content,
// mem_search.query → --query, mem_recall.file → --file, mem_get/mem_delete.ids
// → --ids, mem_update.id → --id. Each previously fell to a stderr-only usage
// line that a `2>/dev/null` caller reads as "CLI doesn't support this".

describe('CLI MCP-field flag aliases', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('search accepts --query as alias for the positional query', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', title: 'Alias probe hit', text: 'uniquealiastoken payload' });
    const output = await captureStdout(() => run(['search', '--query', 'uniquealiastoken']));
    expect(output).not.toContain('Usage');
    expect(output).toContain('Alias probe hit');
  });

  it('recall accepts --file as alias for the positional file', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Touched hook entry', text: 'x', filesModified: '["hook.mjs"]',
    });
    const output = await captureStdout(() => run(['recall', '--file', 'hook.mjs']));
    expect(output).toContain('History for hook.mjs');
    expect(output).toContain('Touched hook entry');
  });

  it('get accepts --ids as alias for the positional id list', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', title: 'Get alias target', text: 'full detail body' });
    const output = await captureStdout(() => run(['get', '--ids', '1']));
    expect(output).toContain('Get alias target');
  });

  it('delete accepts --ids as alias for the positional id list', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', title: 'Delete alias target', text: 'x' });
    await captureStdout(() => run(['delete', '--ids', '1', '--confirm']));
    expect(testDb.prepare('SELECT COUNT(*) c FROM observations').get().c).toBe(0);
  });

  it('update accepts --id as alias for the positional id', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', title: 'Old title', text: 'x' });
    await captureStdout(() => run(['update', '--id', '1', '--title', 'New title']));
    expect(testDb.prepare('SELECT title FROM observations WHERE id = 1').get().title).toBe('New title');
  });

  it('save accepts --content (MCP mem_save field name) as content alias', async () => {
    const output = await captureStdout(() => run(['save', '--content', 'MCP-field-shaped content', '--type', 'decision']));
    expect(output).toContain('[mem] Saved');
    expect(testDb.prepare('SELECT text FROM observations ORDER BY id DESC LIMIT 1').get().text).toBe('MCP-field-shaped content');
  });

  it('rejects two content aliases at once (--text + --content)', async () => {
    const output = await captureStdout(() => run(['save', '--text', 'one', '--content', 'two']));
    expect(output).toContain('once');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(testDb.prepare('SELECT COUNT(*) c FROM observations').get().c).toBe(0);
  });

  it('rejects the alias flag when the positional is also given', async () => {
    const output = await captureStdout(() => run(['search', 'positional terms', '--query', 'flag terms']));
    expect(output).toContain('once');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('usage lines advertise the alias flags', async () => {
    const s = await captureStdout(() => run(['search'])); expect(s).toContain('--query'); process.exitCode = undefined;
    const r = await captureStdout(() => run(['recall'])); expect(r).toContain('--file'); process.exitCode = undefined;
    const g = await captureStdout(() => run(['get'])); expect(g).toContain('--ids'); process.exitCode = undefined;
    const d = await captureStdout(() => run(['delete'])); expect(d).toContain('--ids'); process.exitCode = undefined;
    const u = await captureStdout(() => run(['update'])); expect(u).toContain('--id'); process.exitCode = undefined;
  });
});

// ─── stats command ───────────────────────────────────────────────────────────

describe('CLI stats command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows stats with observations in DB', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug 1', text: 'bugfix',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug 2', text: 'bugfix 2',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Discovery 1', text: 'discovery',
    });

    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('[mem] Stats');
    expect(output).toContain('Total:');
    expect(output).toContain('observations');
    expect(output).toContain('sessions');
    expect(output).toContain('Type distribution');
    expect(output).toContain('bugfix: 2');
    expect(output).toContain('discovery: 1');
  });

  it('shows stats for empty DB', async () => {
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('[mem] Stats');
    expect(output).toContain('Total: 0 observations');
  });

  // Round1-P2: the low-value ("noise") count pre-fix omitted `compressed_into IS NULL`,
  // so rows that `compress` had already folded away kept inflating the "% noise" metric
  // and the "consider running mem compress" advice — a futile no-op loop (re-running
  // compress finds nothing). An already-compressed low-value row must NOT count as noise.
  it('excludes already-compressed rows from the low-value noise count', async () => {
    const old = 40 * 86400000; // >30d so both rows clear the staleness threshold
    insertObs(testDb, { // live low-value row → counts as noise
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Live low value', text: 'live', importance: 1, accessCount: 0,
      epochOffset: -old, compressedInto: null,
    });
    insertObs(testDb, { // already-compressed low-value row → must be excluded
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed low value', text: 'compressed', importance: 1, accessCount: 0,
      epochOffset: -old, compressedInto: 999,
    });
    const output = await captureStdoutOnly(() => run(['stats', '--json']));
    const stats = JSON.parse(output);
    expect(stats.data_health.low_value_count).toBe(1); // only the live row, not the compressed one
    expect(stats.data_health.compressed).toBe(1);
  });

  // Memory-quality audit (2026-06): the imp=1 "Low-value" gauge structurally can't
  // see template / tool-log titles (Modified/Error/Worked on…) — they often carry
  // inflated importance and recent access, so the gauge reported 0% noise on a store
  // that was ~24% low-signal-titled. low_signal_titles surfaces that population using
  // the same LOW_SIGNAL pattern source (lib/low-signal-patterns.mjs) as the read filter.
  it('counts low-signal titles the imp=1 gauge cannot see', async () => {
    insertObs(testDb, { // LOW_SIGNAL title + high importance + accessed → invisible to low_value_count
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Error while working on auth.js', text: 'cmd → ERROR', importance: 3, accessCount: 5,
    });
    insertObs(testDb, { // substantive title → must NOT count as low-signal
      sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'Chose RRF over linear fusion for hybrid recall', text: 'rationale', importance: 2, accessCount: 1,
    });
    const output = await captureStdoutOnly(() => run(['stats', '--json']));
    const stats = JSON.parse(output);
    expect(stats.data_health.low_signal_titles).toBe(1); // the "Error while working" row, not the decision
    expect(stats.data_health.low_value_count).toBe(0);    // neither is imp=1+unaccessed+stale → old gauge blind
    const text = await captureStdout(() => run(['stats']));
    expect(text).toContain('Low-signal titles');
  });

  // v3.23: the imp=0 dormant population (decay floor + LLM low-signal filter push
  // rows to 0) was invisible to the old `importance = 1` gauge — the structural
  // blindness that let it report "0.0% noise" on a store that was ~half imp=0.
  // `<= 1` + never-injected makes the gauge honest without miscounting pinned noise.
  it('counts imp=0 dormant rows the old imp=1 gauge was blind to', async () => {
    const old = 40 * 86400000; // >30d so both clear the staleness threshold
    insertObs(testDb, { // imp=0, never accessed/injected, stale → now counts (was invisible)
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Decayed dormant row', text: 'dormant', importance: 0, accessCount: 0,
      injectionCount: 0, epochOffset: -old, compressedInto: null,
    });
    insertObs(testDb, { // imp=0 BUT injected → "pinned noise" (tracked separately), not "never used" → excluded
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Injected but decayed', text: 'pinned', importance: 0, accessCount: 0,
      injectionCount: 4, epochOffset: -old, compressedInto: null,
    });
    const output = await captureStdoutOnly(() => run(['stats', '--json']));
    const stats = JSON.parse(output);
    expect(stats.data_health.low_value_count).toBe(1); // the dormant imp=0 row, not the injected one
  });
});

// ─── help and unknown commands ───────────────────────────────────────────────

describe('CLI help and error handling', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => { testDb.close(); });

  it('shows help for no args', async () => {
    const output = await captureStdout(() => run([]));
    expect(output).toContain('claude-mem-lite CLI');
    expect(output).toContain('Commands:');
  });

  it('shows help for --help flag', async () => {
    const output = await captureStdout(() => run(['--help']));
    expect(output).toContain('Commands:');
  });

  it('shows help for help command', async () => {
    const output = await captureStdout(() => run(['help']));
    expect(output).toContain('Commands:');
  });

  it('shows help for -h flag', async () => {
    const output = await captureStdout(() => run(['-h']));
    expect(output).toContain('Commands:');
  });

  it('shows error for unknown command', async () => {
    const output = await captureStdout(() => run(['nonexistent']));
    expect(output).toContain('Unknown command');
  });
});

// ─── delete command ─────────────────────────────────────────────────────────

describe('CLI delete command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows usage when no IDs provided', async () => {
    const output = await captureStdout(() => run(['delete']));
    expect(output).toContain('Usage');
  });

  it('shows preview without --confirm', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Delete preview test', text: 'content to delete',
    });
    const output = await captureStdout(() => run(['delete', '1']));
    expect(output).toContain('Preview');
    expect(output).toContain('Delete preview test');
    expect(output).toContain('--confirm');
    // Observation still exists
    const row = testDb.prepare('SELECT id FROM observations WHERE id = 1').get();
    expect(row).toBeTruthy();
  });

  it('deletes with --confirm', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'To be deleted', text: 'deletion target',
    });
    const output = await captureStdout(() => run(['delete', '1', '--confirm']));
    expect(output).toContain('Deleted 1');
    const row = testDb.prepare('SELECT id FROM observations WHERE id = 1').get();
    expect(row).toBeUndefined();
  });

  it('handles non-existent IDs gracefully', async () => {
    const output = await captureStdout(() => run(['delete', '9999']));
    expect(output).toContain('No observations found');
  });

  it('handles invalid ID strings', async () => {
    const output = await captureStdout(() => run(['delete', 'abc']));
    expect(output).toContain('No valid IDs');
  });

  it('cleans related_ids references on delete', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'First', text: 'first content',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Second', text: 'second content', relatedIds: '[1]',
    });
    await captureStdout(() => run(['delete', '1', '--confirm']));
    const row = testDb.prepare('SELECT related_ids FROM observations WHERE id = 2').get();
    expect(JSON.parse(row.related_ids)).toEqual([]);
  });

  it('recovers merged/compressed children when their keeper is deleted (data-loss guard)', async () => {
    // #1 is a keeper; #2 was merged/compressed INTO it (compressed_into = 1). Deleting
    // the keeper without recovery would leave #2 dangling behind a missing parent —
    // hidden from every COALESCE(compressed_into,0)=0 view and unrecoverable. The delete
    // path must reset #2.compressed_into to NULL first (same guard as maintain).
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Keeper', text: 'keeper content', importance: 3,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Merged child', text: 'child content', compressedInto: 1,
    });
    const output = await captureStdout(() => run(['delete', '1', '--confirm']));
    expect(output).toContain('Recovered 1');
    const child = testDb.prepare('SELECT compressed_into FROM observations WHERE id = 2').get();
    expect(child).toBeDefined();              // child row survived
    expect(child.compressed_into).toBeNull(); // and was resurfaced as live
  });
});

// ─── update command ─────────────────────────────────────────────────────────

describe('CLI update command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows usage when no ID provided', async () => {
    const output = await captureStdout(() => run(['update']));
    expect(output).toContain('Usage');
  });

  it('shows error for non-existent observation', async () => {
    const output = await captureStdout(() => run(['update', '9999', '--title', 'New']));
    expect(output).toContain('not found');
  });

  it('shows error when no fields specified', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'No update', text: 'content',
    });
    const output = await captureStdout(() => run(['update', '1']));
    expect(output).toContain('No fields to update');
  });

  // Audit P3 #1: a float-shaped positional id like "3.9" fell through parseIdToken
  // (regex-anchored, no match) to a bare parseInt fallback that truncated 3.9 → 3
  // and silently UPDATE'd the WRONG row #3 (update has no preview/--confirm).
  // cmdDelete rejected such input; cmdUpdate now matches — strict parseIdToken gate.
  it('rejects float-shaped id "3.9" instead of truncating to row #3', async () => {
    for (let i = 0; i < 3; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `row ${i + 1}`, text: 'content',
      });
    }
    const output = await captureStdout(() => run(['update', '3.9', '--title', 'HACKED']));
    expect(output).toContain('Usage');
    // Row #3 must be untouched — the truncation bug would have set it to "HACKED".
    const row = testDb.prepare('SELECT title FROM observations WHERE id = 3').get();
    expect(row.title).toBe('row 3');
  });

  it('updates title', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Original title', text: 'content',
    });
    const output = await captureStdout(() => run(['update', '1', '--title', 'Updated title']));
    expect(output).toContain('Updated #1');
    expect(output).toContain('title');
    const row = testDb.prepare('SELECT title FROM observations WHERE id = 1').get();
    expect(row.title).toBe('Updated title');
  });

  it('rejects empty --title to prevent silent data corruption', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Original title', text: 'content',
    });
    const output = await captureStdout(() => run(['update', '1', '--title', '']));
    expect(output).toContain('--title cannot be empty');
    const row = testDb.prepare('SELECT title FROM observations WHERE id = 1').get();
    expect(row.title).toBe('Original title'); // unchanged
  });

  it('rejects whitespace-only --title', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Original title', text: 'content',
    });
    const output = await captureStdout(() => run(['update', '1', '--title', '   ']));
    expect(output).toContain('--title cannot be empty');
    const row = testDb.prepare('SELECT title FROM observations WHERE id = 1').get();
    expect(row.title).toBe('Original title');
  });

  // Round1-P1: a value-less `--flag` (e.g. `update 1 --title` with NO following arg)
  // parses to boolean `true` (parseArgs). Pre-fix this slipped past the string-only
  // empty guards and bound the boolean to SQLite, surfacing a raw
  // "TypeError: SQLite3 can only bind ..." stacktrace. Must reject cleanly for every
  // string-valued update flag (--title/--narrative/--lesson/--concepts) and leave the
  // row unchanged — same accidental shell-strip class as the #8470 empty-title guard.
  it('rejects value-less string flags (bare --flag) instead of crashing on SQLite bind', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Original title', narrative: 'orig narrative', text: 'content',
    });
    for (const flag of ['--title', '--narrative', '--lesson', '--concepts']) {
      const output = await captureStdout(() => run(['update', '1', flag]));
      expect(output, `${flag} should be rejected`).toContain('requires a value');
      expect(output, `${flag} must not surface a raw stacktrace`).not.toContain('TypeError');
    }
    const row = testDb.prepare('SELECT title, narrative FROM observations WHERE id = 1').get();
    expect(row.title).toBe('Original title');
    expect(row.narrative).toBe('orig narrative');
  });

  // Round2-P2: update --importance shared the bare-parseInt defect — "2abc"→2 was
  // silently UPDATE'd onto the row. Strict-token gate now rejects garbage; float
  // literals still truncate (#8277).
  it('rejects garbage-token --importance (does not coerce/persist via UPDATE)', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'orig', text: 'content', importance: 1,
    });
    for (const bad of ['2abc', '3xyz', '1e2']) {
      const out = await captureStdout(() => run(['update', '1', '--importance', bad]));
      expect(out, `--importance "${bad}" should be rejected`).toContain('Invalid importance');
    }
    expect(testDb.prepare('SELECT importance FROM observations WHERE id=1').get().importance).toBe(1); // unchanged
    await captureStdout(() => run(['update', '1', '--importance', '2.9'])); // float truncates (#8277)
    expect(testDb.prepare('SELECT importance FROM observations WHERE id=1').get().importance).toBe(2);
  });

  // Dogfood-8: --lesson cap is enforced on cmdSave but pre-fix not on cmdUpdate, so a
  // user-typed 501-char lesson got past the gate when supplied via update. Parity now
  // matches save's 500-char cap (and the MCP memSaveSchema upper bound).
  it('rejects --lesson longer than 500 chars (parity with cmdSave + MCP schema)', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Lesson cap test', text: 'content', lessonLearned: 'before',
    });
    const longLesson = 'L'.repeat(501);
    const output = await captureStdout(() => run(['update', '1', '--lesson', longLesson]));
    expect(output).toContain('--lesson too long');
    expect(output).toContain('501 chars');
    const row = testDb.prepare('SELECT lesson_learned FROM observations WHERE id = 1').get();
    expect(row.lesson_learned).toBe('before'); // unchanged
  });

  it('--lesson-learned alias on update also enforces the 500-char cap', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Lesson alias cap', text: 'content',
    });
    const longLesson = 'X'.repeat(501);
    const output = await captureStdout(() => run(['update', '1', '--lesson-learned', longLesson]));
    expect(output).toContain('--lesson too long');
  });

  it('updates type', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Type change', text: 'content',
    });
    await captureStdout(() => run(['update', '1', '--type', 'bugfix']));
    const row = testDb.prepare('SELECT type FROM observations WHERE id = 1').get();
    expect(row.type).toBe('bugfix');
  });

  it('rejects invalid importance values', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Importance test', text: 'content',
    });
    const output = await captureStdout(() => run(['update', '1', '--importance', '5']));
    expect(output).toContain('Invalid importance');
    const row = testDb.prepare('SELECT importance FROM observations WHERE id = 1').get();
    expect(row.importance).toBe(1); // unchanged (default)
  });

  it('updates lesson_learned via --lesson', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Lesson update', text: 'content',
    });
    await captureStdout(() => run(['update', '1', '--lesson', 'Always validate input']));
    const row = testDb.prepare('SELECT lesson_learned FROM observations WHERE id = 1').get();
    expect(row.lesson_learned).toBe('Always validate input');
  });

  it('updates narrative', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Narrative update', text: 'content',
    });
    await captureStdout(() => run(['update', '1', '--narrative', 'Detailed narrative text']));
    const row = testDb.prepare('SELECT narrative FROM observations WHERE id = 1').get();
    expect(row.narrative).toBe('Detailed narrative text');
  });

  it('updates concepts', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Concepts update', text: 'content',
    });
    await captureStdout(() => run(['update', '1', '--concepts', 'auth security jwt']));
    const row = testDb.prepare('SELECT concepts FROM observations WHERE id = 1').get();
    expect(row.concepts).toBe('auth security jwt');
  });
});

// ─── export command ─────────────────────────────────────────────────────────

describe('CLI export command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('exports observations as JSON by default', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Export test bug', text: 'export content',
    });
    const output = await captureStdoutOnly(() => run(['export']));
    const data = JSON.parse(output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].title).toBe('Export test bug');
  });

  it('exports as JSONL format', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'JSONL export 1', text: 'line 1',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'JSONL export 2', text: 'line 2',
    });
    const output = await captureStdoutOnly(() => run(['export', '--format', 'jsonl']));
    const lines = output.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).title).toBeTruthy();
  });

  it('filters by --type', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug export', text: 'bug content',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Discovery export', text: 'discovery content',
    });
    const output = await captureStdoutOnly(() => run(['export', '--type', 'bugfix']));
    const data = JSON.parse(output);
    expect(data.length).toBe(1);
    expect(data[0].type).toBe('bugfix');
  });

  it('filters by --from and --to', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Old export', text: 'old content', epochOffset: -10 * 86400000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Recent export', text: 'recent content',
    });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const output = await captureStdoutOnly(() => run(['export', '--from', yesterday]));
    const data = JSON.parse(output);
    expect(data.length).toBe(1);
    expect(data[0].title).toBe('Recent export');
  });

  it('respects --limit', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Export item ${i}`, text: `content ${i}`,
      });
    }
    const output = await captureStdoutOnly(() => run(['export', '--limit', '2']));
    const data = JSON.parse(output);
    expect(data.length).toBe(2);
  });

  // An INVALID --limit used to land on parseIntFlag's `defaultValue: 200`, which is the
  // right convention for `search`/`recent` (default = display width) and the wrong one
  // here (default = COMPLETENESS). `export --limit "$N" > backup.json` with `$N` unset
  // writes 200 rows, warns on the stderr the redirect discards, and exits 0 — the same
  // truncated-backup shape the no-limit default was changed to -1 to close, reached
  // through the invalid door instead of the absent one. 205 rows because a 200-row store
  // cannot tell the two behaviours apart.
  it('recovers an invalid --limit to the COMPLETE set, not to 200', async () => {
    for (let i = 0; i < 205; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Bulk export item ${i}`, text: `bulk content ${i}`,
      });
    }
    for (const bad of ['abc', '0', '-5']) {
      const output = await captureStdoutOnly(() => run(['export', '--limit', bad]));
      expect(JSON.parse(output).length).toBe(205);
    }
  });

  // The other half: recovering to -1 makes `rows.length >= limit` trivially true, so the
  // cap notice announced "Results capped at -1" on the one path guaranteed not to be
  // capped. A real cap must still say so.
  it('announces a real cap and stays quiet on the recovered one', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Cap notice item ${i}`, text: `content ${i}`,
      });
    }
    const capped = await captureStdout(() => run(['export', '--limit', '2']));
    expect(capped).toContain('Results capped at 2');

    const recovered = await captureStdout(() => run(['export', '--limit', 'abc']));
    expect(recovered).toContain('COMPLETE matching set');
    expect(recovered).not.toContain('capped at -1');
    expect(recovered).not.toMatch(/Results capped at/);
  });

  it('excludes compressed observations by default', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed obs', text: 'compressed', compressedInto: 999,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active obs', text: 'active',
    });
    const output = await captureStdoutOnly(() => run(['export']));
    const data = JSON.parse(output);
    expect(data.length).toBe(1);
    expect(data[0].title).toBe('Active obs');
  });

  it('includes compressed with --include-compressed', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed obs', text: 'compressed', compressedInto: 999,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active obs', text: 'active',
    });
    const output = await captureStdoutOnly(() => run(['export', '--include-compressed']));
    const data = JSON.parse(output);
    expect(data.length).toBe(2);
  });

  it('shows message for empty export', async () => {
    const output = await captureStdout(() => run(['export', '--type', 'bugfix']));
    expect(output).toContain('No observations found');
  });

  it('emits valid empty JSON array on empty result for --format json', async () => {
    // Round-5 dogfood regression: empty export sent friendly text to stdout,
    // breaking `... | jq`. Stdout must stay parseable; the friendly note moved
    // to stderr.
    const stdout = await captureStdoutOnly(() => run(['export', '--type', 'bugfix', '--format', 'json']));
    expect(stdout.trim()).toBe('[]');
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('emits zero stdout bytes on empty result for --format jsonl', async () => {
    const stdout = await captureStdoutOnly(() => run(['export', '--type', 'bugfix', '--format', 'jsonl']));
    expect(stdout).toBe('');
  });

  // `--type bogus` previously hit the DB with the unknown type and returned `[]`,
  // hiding the typo. Mirrors the validation in cmdSearch / cmdRecent / cmdSave.
  it('rejects unknown --type with the valid list', async () => {
    const output = await captureStdout(() => run(['export', '--type', 'WRONG']));
    expect(output).toContain('Invalid --type');
    expect(output).toContain('WRONG');
  });
});

// ─── compress command ───────────────────────────────────────────────────────

describe('CLI compress command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows preview by default', async () => {
    // Insert old, low-importance observations
    const oldEpoch = -60 * 86400000; // 60 days ago
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Old obs ${i}`, text: `old content ${i}`, importance: 1,
        epochOffset: oldEpoch + i * 1000,
      });
    }
    const output = await captureStdout(() => run(['compress']));
    expect(output).toContain('Compression preview');
    expect(output).toContain('--execute');
  });

  it('shows no candidates when all are recent', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Recent obs', text: 'recent content', importance: 1,
    });
    const output = await captureStdout(() => run(['compress']));
    expect(output).toContain('No candidates');
  });

  // `--age-days abc` / `-5` / `0` previously fell back to the 30-day default with no warning,
  // hiding typos and accepting non-sensical inputs. cmdCompress now rejects them up-front.
  it('rejects invalid --age-days values (negative, zero, non-numeric)', async () => {
    for (const bad of ['-5', '0', 'abc']) {
      const output = await captureStdout(() => run(['compress', '--age-days', bad]));
      expect(output).toContain('Invalid --age-days');
      expect(output).toContain(bad);
    }
  });

  it('executes compression with --execute', async () => {
    const oldEpoch = -60 * 86400000;
    for (let i = 0; i < 4; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Compress target ${i}`, text: `compress content ${i}`, importance: 1,
        epochOffset: oldEpoch + i * 1000,
      });
    }
    const output = await captureStdout(() => run(['compress', '--execute']));
    expect(output).toContain('Compressed');
    expect(output).toContain('weekly summaries');
    // Verify compressed_into is set on originals
    const compressed = testDb.prepare('SELECT COUNT(*) as c FROM observations WHERE compressed_into IS NOT NULL AND compressed_into > 0').get();
    expect(compressed.c).toBeGreaterThan(0);
  });

  it('shows no candidates when importance is high', async () => {
    const oldEpoch = -60 * 86400000;
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Important obs', text: 'important content', importance: 3,
      epochOffset: oldEpoch,
    });
    const output = await captureStdout(() => run(['compress']));
    expect(output).toContain('No candidates');
  });
});

// ─── maintain command ───────────────────────────────────────────────────────

describe('CLI maintain command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows usage for no action', async () => {
    const output = await captureStdout(() => run(['maintain']));
    expect(output).toContain('Usage');
  });

  it('shows usage for invalid action', async () => {
    const output = await captureStdout(() => run(['maintain', 'invalid']));
    expect(output).toContain('Usage');
  });

  it('scan reports maintenance stats', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active observation', text: 'active content',
    });
    const output = await captureStdout(() => run(['maintain', 'scan']));
    expect(output).toContain('Maintenance scan');
    expect(output).toContain('Total active');
    expect(output).toContain('Near-duplicate pairs');
    expect(output).toContain('Stale');
    expect(output).toContain('Broken');
    expect(output).toContain('Boostable');
    expect(output).toContain('Pending purge');
  });

  // Regression: SUM(CASE WHEN ... ELSE 0 END) returns NULL on empty sets;
  // user-facing output then read "Stale: null", "Broken: null", "Boostable: null".
  // Fix wraps each SUM in COALESCE(..., 0). Covers maintain scan + the parallel
  // server.mjs mem_maintain query + lib/stats-quality.mjs aggregates.
  it('scan returns 0 (not null) when project has no observations', async () => {
    const output = await captureStdout(() => run(['maintain', 'scan', '--project', 'empty--project']));
    expect(output).not.toContain('null');
    expect(output).toContain('Stale (>30d, imp=1, no access, never injected): 0');
    expect(output).toContain('Broken (no title/narrative): 0');
    expect(output).toContain('Boostable (accessed>3, imp<3): 0');
  });

  it('scan detects near-duplicates', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Fix authentication bug in login page', text: 'auth bug content',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Fix authentication bug in login page', text: 'auth bug content 2',
    });
    const output = await captureStdout(() => run(['maintain', 'scan']));
    expect(output).toContain('Near-duplicate pairs: 1');
  });

  it('execute runs cleanup operation', async () => {
    // Insert broken observation (no title, no narrative)
    testDb.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', '', 'discovery', '', '', '', '', '', '[]', '[]', 1, ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'cleanup']));
    expect(output).toContain('Cleaned up');
  });

  it('execute runs boost operation', async () => {
    // Insert frequently accessed low-importance observation
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Boostable obs', text: 'boostable content', importance: 1,
      accessCount: 5,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'boost']));
    expect(output).toContain('Boosted');
    const row = testDb.prepare('SELECT importance FROM observations WHERE title = ?').get('Boostable obs');
    expect(row.importance).toBe(2);
  });

  it('execute runs decay operation', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Stale obs', text: 'stale content', importance: 2,
      epochOffset: -60 * 86400000, // 60 days ago
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'decay']));
    expect(output).toContain('Decayed');
  });

  it('execute runs demote_pinned: drops importance for heavily-injected, never-cited obs only', async () => {
    // The pinned-noise the regular `decay` op can't reach (it protects injection_count>0).
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Pinned noise', text: 'injected often, never cited',
      importance: 3, injectionCount: 41, citedCount: 0,
    });
    // Cited → protected (must NOT demote).
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'Earned its keep', text: 'cited',
      importance: 3, injectionCount: 12, citedCount: 4,
    });
    // Low injection → below threshold (must NOT demote).
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Rarely injected', text: 'few injections',
      importance: 3, injectionCount: 2, citedCount: 0,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'demote_pinned']));
    expect(output).toContain('Demoted 1 pinned-but-uncited');
    // Dropped to 1 in one pass (below the binary importance>=2 injection-priority tier).
    expect(testDb.prepare('SELECT importance FROM observations WHERE title = ?').get('Pinned noise').importance).toBe(1);
    expect(testDb.prepare('SELECT importance FROM observations WHERE title = ?').get('Earned its keep').importance).toBe(3);
    expect(testDb.prepare('SELECT importance FROM observations WHERE title = ?').get('Rarely injected').importance).toBe(3);
  });

  it('execute runs vacuum and reports freelist reclaim', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Some obs', text: 'content',
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'vacuum']));
    expect(output).toContain('VACUUM: reclaimed');
    expect(output).toContain('freelist');
  });

  it('scan reports pinned-but-uncited count', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Pinned noise', text: 'x', importance: 3, injectionCount: 10, citedCount: 0,
    });
    const output = await captureStdout(() => run(['maintain', 'scan']));
    expect(output).toContain('Pinned-but-uncited (inj>=8, cited=0, above floor): 1');
  });

  it('execute runs dedup with --merge-ids', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Keep this one', text: 'keep content', importance: 2,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Remove this dup', text: 'dup content', importance: 1,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'dedup', '--merge-ids', '1:2']));
    expect(output).toContain('Merged');
    const row = testDb.prepare('SELECT compressed_into FROM observations WHERE id = 2').get();
    expect(row.compressed_into).toBe(1);
  });

  it('execute runs purge_stale operation', async () => {
    // Insert observation marked as pending purge (old). -2 matches COMPRESSED_PENDING_PURGE in utils.mjs.
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Pending purge obs', text: 'purge content',
      compressedInto: -2,
      epochOffset: -60 * 86400000,
    });
    // T2-P0-A: --confirm is now required for the destructive path.
    const output = await captureStdout(() => run([
      'maintain', 'execute', '--ops', 'purge_stale', '--confirm',
    ]));
    expect(output).toContain('Purged 1 stale observations');
  });

  it('execute purge_stale without --confirm previews and does not delete', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Pending purge obs preview', text: 'purge content',
      compressedInto: -2,
      epochOffset: -60 * 86400000,
    });
    const output = await captureStdout(() => run(['maintain', 'execute', '--ops', 'purge_stale']));
    expect(output).toContain('purge_stale preview (no --confirm)');
    const row = testDb.prepare("SELECT id FROM observations WHERE title = 'Pending purge obs preview'").get();
    expect(row).toBeDefined();
  });
});

// ─── browse command ─────────────────────────────────────────────────────────

describe('CLI browse command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows empty dashboard with no observations', async () => {
    const output = await captureStdout(() => run(['browse']));
    expect(output).toContain('Memory Dashboard');
    expect(output).toContain('No observations found');
  });

  it('shows observations grouped by tier', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Recent working memory', text: 'recent content',
    });
    const output = await captureStdout(() => run(['browse']));
    expect(output).toContain('Memory Dashboard');
    expect(output).toContain('Working Memory');
    expect(output).toContain('Active Memory');
    expect(output).toContain('Archive');
  });

  it('filters by --tier', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Browse tier filter', text: 'content',
    });
    const output = await captureStdout(() => run(['browse', '--tier', 'working']));
    expect(output).toContain('Working Memory');
  });

  it('rejects invalid tier', async () => {
    const output = await captureStdout(() => run(['browse', '--tier', 'invalid']));
    expect(output).toContain('Invalid tier');
  });

  it('shows totals when no tier filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Totals test', text: 'content',
    });
    const output = await captureStdout(() => run(['browse']));
    expect(output).toContain('Totals:');
  });
});

// ─── context command ────────────────────────────────────────────────────────

describe('CLI context command', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => { testDb.close(); });

  it('reports empty context for a project with no data', async () => {
    const output = await captureStdout(() =>
      run(['context', '--project', 'test--empty-proj']),
    );
    expect(output).toContain('No context yet');
    expect(output).toContain('test--empty-proj');
  });

  it('generates context block live from DB when session summary exists', async () => {
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    const now = Date.now();
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'test--project', 'Fix auth bug', 'Patched middleware', 'Add tests', ?, ?)
    `).run('mem-s1', new Date(now).toISOString(), now);

    const output = await captureStdout(() =>
      run(['context', '--project', 'test--project']),
    );
    expect(output).toContain('<claude-mem-context>');
    expect(output).toContain('</claude-mem-context>');
    expect(output).toContain('### Last Session');
    expect(output).toContain('Fix auth bug');
    expect(output).toContain('Patched middleware');
  });

  it('does not read from CLAUDE.md even when one exists', async () => {
    // Context now comes from DB only — CLAUDE.md is ignored on purpose.
    // Seed DB with known data and assert the output comes from the DB, not
    // from any CLAUDE.md file that might be sitting around.
    insertSession(testDb, { id: 's2', project: 'test--db-only', memoryId: 'mem-s2' });
    const now = Date.now();
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'test--db-only', 'DB-derived request', 'DB-derived completed', 'DB-derived next', ?, ?)
    `).run('mem-s2', new Date(now).toISOString(), now);

    const output = await captureStdout(() =>
      run(['context', '--project', 'test--db-only']),
    );
    expect(output).toContain('DB-derived request');
    // Ensure the error-paths from the old CLAUDE.md-reading implementation are gone.
    expect(output).not.toContain('No CLAUDE.md');
    expect(output).not.toContain('No claude-mem-context block found');
  });

  it('emits JSON with parsed sections when --json is set', async () => {
    insertSession(testDb, { id: 's3', project: 'test--json-proj', memoryId: 'mem-s3' });
    const now = Date.now();
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, 'test--json-proj', 'Ship v2.30', 'Done', 'Release notes', ?, ?)
    `).run('mem-s3', new Date(now).toISOString(), now);

    const output = await captureStdout(() =>
      run(['context', '--project', 'test--json-proj', '--json']),
    );
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('raw');
    expect(parsed).toHaveProperty('sections');
    expect(parsed.raw).toContain('Ship v2.30');
    expect(parsed.sections).toHaveProperty('last_session');
  });
});

// ─── stats command extended ─────────────────────────────────────────────────

describe('CLI stats command extended', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows data health metrics', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Health test', text: 'some content here',
    });
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('Data Health');
    expect(output).toContain('Est. tokens');
    expect(output).toContain('Avg importance');
    expect(output).toContain('Low-value');
    expect(output).toContain('Compressed');
    expect(output).toContain('Tier distribution');
  });

  it('shows Recall metering line when metrics are enabled (G13)', async () => {
    const prev = process.env.CLAUDE_MEM_METRICS;
    process.env.CLAUDE_MEM_METRICS = '1';
    try {
      const output = await captureStdout(() => run(['stats']));
      expect(output).toContain('Recall metering (7d):');
      expect(output).toContain('enrich-save');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_MEM_METRICS;
      else process.env.CLAUDE_MEM_METRICS = prev;
    }
  });

  it('shows daily activity', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Daily activity test', text: 'daily content',
    });
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('Daily activity');
  });

  it('filters by --project', async () => {
    const output = await captureStdout(() => run(['stats', '--project', 'test--project']));
    expect(output).toContain('test--project');
  });

  it('filters by --days', async () => {
    const output = await captureStdout(() => run(['stats', '--days', '7']));
    expect(output).toContain('Last 7d');
  });

  it('shows session and prompt counts', async () => {
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('sessions');
    expect(output).toContain('prompts');
  });

  it('shows top projects when no project filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Projects list test', text: 'content',
    });
    const output = await captureStdout(() => run(['stats']));
    expect(output).toContain('Top projects');
    expect(output).toContain('test--project');
  });
});

// N-1: `stats --quality` quality dashboard — baseline for the R-2 Haiku prompt A/B.
// Surfaces lesson rate, LOW_SIGNAL rate, per-type hit/lesson %, and explicit R-2 targets.
describe('CLI stats --quality command', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    // Deterministic seed: 10 obs in-window, known lesson/LOW_SIGNAL/access distribution.
    // bugfix: 4 total, 2 with lesson (50%), 1 accessed (25% hit)
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed queue race', text: 'q', lessonLearned: 'Always mutex first', accessCount: 1 });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed token expiry', text: 't', lessonLearned: 'Check TTL on refresh' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed null deref', text: 'n' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed off-by-one', text: 'o' });
    // decision: 1 total, 1 with lesson (100%), 1 accessed (100% hit)
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'Switch to RRF merge', text: 'r',
      lessonLearned: 'BM25+vector beats either alone', accessCount: 2 });
    // discovery: 1 total, 1 with lesson, 0 accessed
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'FTS5 CJK quirk', text: 'f', lessonLearned: 'Needs bigram workaround' });
    // change: 3 total, all LOW_SIGNAL titles, 0 lessons, 0 accessed
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Modified auth.mjs', text: 'a' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Modified server.mjs', text: 's' });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Worked on utils.mjs', text: 'u' });
    // refactor: 1 total, no lesson, no access
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'refactor',
      title: 'Extracted helper', text: 'h' });
    // Totals: 10 obs, 4 with lesson (40%), 3 LOW_SIGNAL (30%), 2 accessed (20% hit)
  });
  afterEach(() => { testDb.close(); });

  it('outputs quality snapshot header with --quality flag', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toContain('Quality snapshot');
  });

  it('reports overall lesson rate as "4 / 10 (40.0%)"', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    // Exact format: `Lesson rate:      4 / 10 (40.0%)` (spacing flexible)
    expect(output).toMatch(/Lesson rate:\s*4\s*\/\s*10\s*\(40\.0%\)/);
  });

  it('reports LOW_SIGNAL rate as "3 / 10 (30.0%)"', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toMatch(/LOW_SIGNAL:\s*3\s*\/\s*10\s*\(30\.0%\)/);
  });

  // D#191: every ratio here must divide LIVE rows by LIVE rows. Before v3.86.0 the
  // window / all-time / per-type queries were bare `FROM observations`, so compressed
  // and superseded rows — which are overwhelmingly lesson-less LOW_SIGNAL `change`
  // rows, that being why compression retires them — were counted into both halves and
  // the dashboard described a population retrieval never searches (live store 92.9%
  // lesson rate rendered as 59.6%).
  //
  // The decoys are chosen so the WRONG population computes DIFFERENT numbers, not
  // merely a bigger denominator: 10 lesson-less LOW_SIGNAL retired rows against the
  // 10-row live seed move lesson 40.0% -> 20.0% and LOW_SIGNAL 30.0% -> 65.0%, and
  // the `change` type row 3 -> 13. Drop any one of the three filters and this reddens.
  it('excludes compressed + superseded rows from every quality ratio', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'change',
        title: `Modified retired-${i}.mjs`, text: 'r', compressedInto: 99 });
      insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'change',
        title: `Worked on stale-${i}.mjs`, text: 's', supersededAt: '2026-01-01T00:00:00.000Z' });
    }
    const output = await captureStdout(() => run(['stats', '--quality']));
    // window ratios: unchanged by 10 retired rows
    expect(output).toMatch(/Lesson rate:\s*4\s*\/\s*10\s*\(40\.0%\)/);
    expect(output).toMatch(/LOW_SIGNAL:\s*3\s*\/\s*10\s*\(30\.0%\)/);
    // all-time bracket: same live population, not the 20-row table
    expect(output).toMatch(/\[all-time:\s*4\s*\/\s*10\s*=\s*40\.0%\]/);
    expect(output).toMatch(/LOW_SIGNAL:.*\[all-time:\s*3\s*\/\s*10\s*=\s*30\.0%\]/);
    // per-type breakdown: `change` stays at its 3 live rows
    expect(output).toMatch(/change\s+3\s+.*hit\s*0\.0%.*lesson\s*0\.0%/);
    // the population is named, so the reader is not left to assume it
    expect(output).toContain('live observations');
  });

  // Review S1: the fourth query, `topLessons`, already filtered compressed rows before
  // this round and gained the superseded arm with the rest. That arm was unpinned —
  // reverting it to the old `AND COALESCE(compressed_into,0)=0` left the whole suite
  // green, which is the superseded-invariant class this project has re-broken seven
  // times. A superseded lesson with a high access_count belongs in no "Top accessed"
  // list; both exclusions are asserted, with a live decoy that must still appear so
  // "the section is empty" cannot satisfy the test.
  it('keeps compressed AND superseded rows out of "Top accessed lessons"', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'live top lesson', text: 'l', lessonLearned: 'LIVE-LESSON-MARKER', accessCount: 5 });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'retired top lesson', text: 'c', lessonLearned: 'COMPRESSED-LESSON-MARKER',
      accessCount: 99, compressedInto: 77 });
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'decision',
      title: 'stale top lesson', text: 's', lessonLearned: 'SUPERSEDED-LESSON-MARKER',
      accessCount: 98, supersededAt: '2026-01-01T00:00:00.000Z' });
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toContain('Top accessed lessons');
    expect(output).toContain('LIVE-LESSON-MARKER');          // the section is non-empty
    expect(output).not.toContain('COMPRESSED-LESSON-MARKER');
    expect(output).not.toContain('SUPERSEDED-LESSON-MARKER');
  });

  it('shows per-type breakdown with hit% and lesson%', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    // bugfix row: count=4, hit=25% (1/4 accessed), lesson=50% (2/4)
    expect(output).toMatch(/bugfix\s+4\s+.*hit\s*25\.0%.*lesson\s*50\.0%/);
    // change row: count=3, 0% hit, 0% lesson
    expect(output).toMatch(/change\s+3\s+.*hit\s*0\.0%.*lesson\s*0\.0%/);
  });

  it('shows R-2 watchdog target lines', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toContain('Targets');
    // Should show current vs target for lesson rate
    expect(output).toMatch(/Lesson rate.*15%/);
    // And for LOW_SIGNAL
    expect(output).toMatch(/LOW_SIGNAL.*30%/);
  });

  it('omits pending-purge watchdog when no compressed records exist', async () => {
    // Default seed has zero compressed/pending-purge rows → line should not appear
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).not.toContain('Pending purge ≤');
  });

  // Regression: SUM(CASE WHEN ... ELSE 0 END) returns NULL on empty sets — used to
  // render "Lesson rate: null / 0 (0.0%)" for projects with zero observations.
  // Fix wraps each SUM in COALESCE(..., 0) in lib/stats-quality.mjs.
  it('reports 0 (not null) for an empty project', async () => {
    const output = await captureStdout(() => run(['stats', '--quality', '--project', 'empty--project']));
    expect(output).not.toContain('null');
    expect(output).toMatch(/Lesson rate:\s*0\s*\/\s*0/);
    expect(output).toMatch(/LOW_SIGNAL:\s*0\s*\/\s*0/);
  });

  it('renders pending-purge watchdog with 🔴 + repair hint when ratio > 30%', async () => {
    // Mark some seed rows as compressed to create a denominator, with one PENDING_PURGE
    // sentinel (-2) to drive the watchdog ratio above the 30% red threshold.
    testDb.prepare("UPDATE observations SET compressed_into = 99 WHERE title = 'Modified auth.mjs'").run();
    testDb.prepare("UPDATE observations SET compressed_into = -2 WHERE title = 'Modified server.mjs'").run();
    // 2 compressed, 1 pending-purge → 50%
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toMatch(/Pending purge ≤ 10%.*currently 50\.0%/);
    expect(output).toContain('🔴');
    expect(output).toContain('maintain execute --ops purge_stale --confirm');
  });

  it('renders pending-purge watchdog with ✅ at low ratio', async () => {
    testDb.prepare("UPDATE observations SET compressed_into = 99 WHERE title IN ('Modified auth.mjs', 'Modified server.mjs', 'Worked on utils.mjs')").run();
    // 3 compressed, 0 pending-purge → 0% → ✅
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toMatch(/✅ Pending purge ≤ 10%.*currently 0\.0%/);
    expect(output).not.toContain('maintain execute --ops purge_stale');
  });

  it('standard `stats` (no --quality) does NOT show quality block', async () => {
    const output = await captureStdout(() => run(['stats']));
    expect(output).not.toContain('Quality snapshot');
    expect(output).not.toContain('LOW_SIGNAL');
  });
});

// N-1 extension: unresolved_bugfix metric — proxy for "investigation, not fix" pollution.
// R-7 micro-experiment showed many type=bugfix observations are actually investigations
// where narrative explicitly ends with "root cause not yet identified" — Haiku tagged
// them bugfix because hasError, but no fix was applied. This metric tracks the pollution
// rate so we can see whether R-6 (manual save contract) reduces it over time.
describe('CLI stats --quality unresolved_bugfix metric', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    // 5 bugfix observations: 3 unresolved (investigation only), 2 resolved (real fixes).
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Investigate test failure in parser', text: 'p',
      narrative: 'Ran cargo test and saw the failure. Searched for the symbol but Root cause not yet identified from the output.',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Lint failures in gsd-lite', text: 'l',
      narrative: 'Investigation of npm lint failures. Errors persisted on retry. Still fails after re-running biome check.',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Test suite failures in executor context', text: 't',
      narrative: 'TAP output shows failures in buildExecutorContext subtests. Regression suspected but root cause not yet identified.',
    });
    // Resolved bugfix #1 — has a clear root cause + fix
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fix race in credit deduction', text: 'r',
      narrative: 'IntegrityError in concurrent deduction. Root cause: read-then-write without SELECT FOR UPDATE. Added row lock; verified with stress test.',
      lessonLearned: 'Use SELECT FOR UPDATE for any read-then-write on a contended row',
    });
    // Resolved bugfix #2
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fix CJK tokenization in FTS5', text: 'c',
      narrative: 'FTS5 porter stemmer does not split CJK. Added bigram fallback in utils.mjs and verified search recall.',
      lessonLearned: 'FTS5 needs CJK bigram workaround',
    });
    // Totals: 5 bugfix, 3 unresolved (60%), 2 resolved
  });
  afterEach(() => { testDb.close(); });

  it('reports unresolved bugfix count as "3 / 5 (60.0%)"', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    expect(output).toMatch(/Unresolved bugfix:\s*3\s*\/\s*5\s*\(60\.0%\)/);
  });

  it('flags unresolved bugfix line as a R-6 watchdog (should trend down)', async () => {
    const output = await captureStdout(() => run(['stats', '--quality']));
    // The line should explicitly mention R-6 or "trend down" so users know what to look for.
    expect(output).toMatch(/Unresolved bugfix:.*R-6|Unresolved bugfix:.*trend.*↓|Unresolved bugfix:.*should.*decrease/);
  });

  it('matches case-insensitively against narrative pollution markers', async () => {
    // Add an extra observation with mixed-case marker — should still count
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Edge case', text: 'e',
      narrative: 'NOT YET RESOLVED — needs follow-up.',
    });
    const output = await captureStdout(() => run(['stats', '--quality']));
    // Now 4 unresolved out of 6 bugfix
    expect(output).toMatch(/Unresolved bugfix:\s*4\s*\/\s*6/);
  });
});

// ─── search cross-source (sessions + prompts) ──────────────────────────────

describe('CLI search cross-source', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('shows invalid source error', async () => {
    const output = await captureStdout(() => run(['search', 'test', '--source', 'invalid']));
    expect(output).toContain('Invalid --source');
  });

  it('shows no valid terms error', async () => {
    // Sanitized FTS query becomes empty for very short/stop words
    const output = await captureStdout(() => run(['search', 'a']));
    // Should either show 'No valid search terms' or 'No results'
    expect(output).toMatch(/No valid|No results/);
  });

  it('searches sessions when --source sessions', async () => {
    // Insert a session summary
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', 'Fix authentication module', 'Fixed auth module', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['search', 'authentication', '--source', 'sessions']));
    // Session search may work or fail depending on FTS availability
    expect(output).toBeDefined();
  });

  it('searches prompts when --source prompts', async () => {
    // Insert a user prompt
    testDb.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch)
      VALUES ('s1', 'How to fix the database connection issue', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['search', 'database connection', '--source', 'prompts']));
    expect(output).toBeDefined();
  });

  it('searches with --offset for pagination', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Paginated search item ${i}`, text: `paginated search content ${i}`,
      });
    }
    const output = await captureStdout(() => run(['search', 'paginated', '--limit', '2', '--offset', '2']));
    expect(output).toBeDefined();
  });

  // Round2-P1: on the obs-type-filtered (single-source) path, --type set
  // effectiveSource='observations' so the engine applied SQL OFFSET, then
  // results.slice(offset,…) applied it a SECOND time → the page was dropped
  // ('No results ... at offset 1'). MCP offsets once; CLI must too.
  it('applies --offset exactly once on the obs-type-filtered path (no double-offset drop)', async () => {
    for (let i = 0; i < 3; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
        title: `Offset bug ${i}`, text: `offsetcase fix entry ${i}`,
      });
    }
    const all = await captureStdout(() => run(['search', 'offsetcase', '--type', 'bugfix', '--limit', '5']));
    expect(all).toMatch(/Found 3 results/);
    const paged = await captureStdout(() => run(['search', 'offsetcase', '--type', 'bugfix', '--limit', '5', '--offset', '1']));
    expect(paged).not.toContain('No results'); // pre-fix: "No results for ... at offset 1"
    expect(paged).toMatch(/Found 2 of 3 results/); // offset 1 of 3 matches → 2 returned, total 3
  });

  it('searches with --branch filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Feature branch obs', text: 'branch filter content',
      branch: 'feat/auth',
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Main branch obs', text: 'main branch filter content',
      branch: 'main',
    });
    const output = await captureStdout(() => run(['search', 'branch filter', '--branch', 'feat/auth']));
    expect(output).toBeDefined();
  });

  // Dogfood-2 regression: --branch only applies to observations (sessions/prompts have no
  // branch column). Previously the cross-source search returned session/prompt rows that
  // bypassed the branch filter — users passing `--branch X` got unrelated rows mixed in.
  // Fix: --branch implicitly restricts to observations, like --type/--tier/--importance.
  it('--branch implicitly restricts to observations only', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Obs with no branch', text: 'cross source target',
    });
    testDb.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch)
      VALUES ('s1', 'cross source target text', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    // With --branch set to a value that won't match any obs, the prompt row would
    // historically leak through (it has no branch column to filter on). Now it's excluded.
    const output = await captureStdout(() => run(['search', 'cross source target', '--branch', 'definitely-nonexistent-branch']));
    expect(output).not.toContain('cross source target text'); // prompt content excluded
  });

  it('searches with --from and --to date filters', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Old date filter obs', text: 'old date filter content',
      epochOffset: -10 * 86400000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Recent date filter obs', text: 'recent date filter content',
    });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const output = await captureStdout(() => run(['search', 'date filter', '--from', yesterday]));
    expect(output).toContain('Recent date filter obs');
    expect(output).not.toContain('Old date filter obs');
  });

  it('type-list fallback when FTS returns nothing for typed search', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fallback type list bug', text: 'some unrelated content',
    });
    // Search for terms not in FTS but with --type, should trigger type-list fallback
    const output = await captureStdout(() => run(['search', 'zzz_nonexistent_zzz', '--type', 'bugfix']));
    // Either finds via fallback or shows no results
    expect(output).toBeDefined();
  });
});

// ─── get command with --source ──────────────────────────────────────────────

describe('CLI get command with source', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('gets session details with --source session', async () => {
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, investigated, learned, next_steps, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', 'Implement auth', 'Auth implemented', 'Auth patterns', 'JWT is better', 'Add tests', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['get', '1', '--source', 'session']));
    expect(output).toContain('S#1');
    expect(output).toContain('Request: Implement auth');
    expect(output).toContain('Completed: Auth implemented');
    expect(output).toContain('Investigated: Auth patterns');
    expect(output).toContain('Learned: JWT is better');
    expect(output).toContain('Next steps: Add tests');
  });

  it('shows no records found for non-existent session ID', async () => {
    const output = await captureStdout(() => run(['get', '9999', '--source', 'session']));
    expect(output).toMatch(/No records found.*\[session\]/);
  });

  it('gets prompt details with --source prompt', async () => {
    testDb.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch)
      VALUES ('s1', 'How to fix the auth bug', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const output = await captureStdout(() => run(['get', '1', '--source', 'prompt']));
    expect(output).toContain('P#1');
    expect(output).toContain('Text: How to fix the auth bug');
    expect(output).toContain('Session: s1');
  });

  it('shows no records found for non-existent prompt ID', async () => {
    const output = await captureStdout(() => run(['get', '9999', '--source', 'prompt']));
    expect(output).toMatch(/No records found.*\[prompt\]/);
  });

  it('gets observations with --fields filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fields filter test', text: 'content', narrative: 'Full narrative here',
    });
    const output = await captureStdout(() => run(['get', '1', '--fields', 'title,narrative']));
    expect(output).toContain('Fields filter test');
    expect(output).toContain('Full narrative here');
    // Should not include fields not in the --fields list (except header fields id/type/created_at)
    expect(output).not.toContain('importance:');
  });
});

// ─── get command with P#/S#/# prefix routing (regression: #8104) ─────────────
// The CLI search output labels prompts/sessions as P#/S#, but `get` defaulted
// to observations and silently failed when IDs were copy-pasted with prefix.

describe('CLI get command with prefix routing', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('routes P#N to user_prompts without --source', async () => {
    testDb.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch)
      VALUES ('s1', 'Prompt with prefix', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', 'P#1']));
    expect(output).toContain('P#1');
    expect(output).toContain('Text: Prompt with prefix');
  });

  it('routes S#N to session_summaries without --source', async () => {
    testDb.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('mem-s1', 'test--project', 'Session with prefix', ?, ?)
    `).run(new Date().toISOString(), Date.now());
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', 'S#1']));
    expect(output).toContain('S#1');
    expect(output).toContain('Request: Session with prefix');
  });

  it('routes bare #N to observations (explicit #)', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery', title: 'Obs with hash prefix', text: 'hash' });
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', '#1']));
    expect(output).toContain('#1 [discovery]');
    expect(output).toContain('Obs with hash prefix');
  });

  it('routes bare N to observations (default, no prefix)', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery', title: 'Bare id default obs', text: 'bare' });
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', '1']));
    expect(output).toContain('Bare id default obs');
  });

  it('merges mixed prefixes: P#1,S#1,#1 in a single call', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'feature', title: 'Mixed obs', text: 'o' });
    testDb.prepare(`INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch) VALUES ('s1', 'Mixed prompt', ?, ?)`).run(new Date().toISOString(), Date.now());
    testDb.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch) VALUES ('mem-s1', 'test--project', 'Mixed session', ?, ?)`).run(new Date().toISOString(), Date.now());
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', 'P#1,S#1,#1']));
    expect(output).toContain('Mixed prompt');
    expect(output).toContain('Mixed session');
    expect(output).toContain('Mixed obs');
  });

  it('hints alternative sources when obs-only lookup misses', async () => {
    testDb.prepare(`INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch) VALUES ('s1', 'Only a prompt', ?, ?)`).run(new Date().toISOString(), Date.now());
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', '1']));
    // Suggest P#1 exists as a prompt
    expect(output).toMatch(/prompt|P#1/);
  });

  it('explicit --source obs strips P# prefix and queries observations', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery', title: 'Explicit override obs', text: 'e' });
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', 'P#1', '--source', 'obs']));
    expect(output).toContain('Explicit override obs');
  });

  it('warns on unparseable tokens and processes the rest', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery', title: 'Partial valid', text: 'p' });
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', '1,garbage']));
    expect(output).toContain('Partial valid');
    expect(output).toMatch(/unparseable|ignor/i);
  });
});

// ─── CLI/MCP parity on cross-source hint ─────────────────────────────────────
// Both paths use lib/id-routing.mjs probeOtherSources; schema drift should
// surface as a test failure here, not as diverging agent behavior.

describe('CLI/MCP parity on cross-source hint', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('probe returns identical hits across CLI and MCP call paths', async () => {
    // Same ID exists only as a prompt.
    testDb.prepare(`INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch) VALUES ('s1', 'parity', ?, ?)`).run(new Date().toISOString(), Date.now());

    const { probeOtherSources } = await import('../lib/id-routing.mjs');
    // Simulate CLI lookup (queried=obs) and MCP lookup (queried=obs) — same exclude set
    // should yield the same probe result.
    const probeCli = probeOtherSources(testDb, [1], new Set(['obs']));
    const probeMcp = probeOtherSources(testDb, [1], new Set(['obs']));
    expect(probeCli).toEqual(probeMcp);
    expect(probeCli.prompt).toEqual([1]);
    expect(probeCli.session).toEqual([]);
    expect(probeCli.obs).toEqual([]);
  });
});

// ─── timeline --anchor with prefix (regression: #8104) ───────────────────────

describe('CLI timeline anchor prefix routing', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('resolves P#N anchor to nearest observation in time', async () => {
    const base = Date.now();
    // Observation 1m before the prompt
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery', title: 'Before prompt obs', text: 'b', epochOffset: -60000 });
    // Observation 2m after the prompt
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'discovery', title: 'After prompt obs', text: 'a', epochOffset: 120000 });
    // Prompt sits between
    testDb.prepare(`INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch) VALUES ('s1', 'Anchor me', ?, ?)`).run(new Date(base).toISOString(), base);
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['timeline', '--anchor', 'P#1']));
    expect(output).toContain('Timeline');
    expect(output).toMatch(/Before prompt obs|After prompt obs/);
  });

  it('errors with hint when P#N anchor does not exist', async () => {
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['timeline', '--anchor', 'P#9999']));
    expect(output).toMatch(/not found|Prompt/);
  });

  // v27: bare-int anchor (no prefix) must fall back to user_prompts/session_summaries
  // so callers who paste a prompt id without `P#` prefix get the nearest observation
  // instead of a misleading "Observation #N not found" error.
  it('bare-int anchor falls back to user_prompts when observation miss', async () => {
    const base = Date.now();
    // Observation near the prompt (so nearest-in-time resolves to it)
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Near prompt obs', text: 'near content', epochOffset: 60000,
    });
    // Insert a prompt with a specific id that has NO matching observation id
    testDb.prepare(`INSERT INTO user_prompts (id, content_session_id, prompt_text, created_at, created_at_epoch) VALUES (?, 's1', 'bare-int fallback target', ?, ?)`).run(99999, new Date(base).toISOString(), base);
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['timeline', '--anchor', '99999']));
    expect(output).toContain('Timeline');
    expect(output).toContain('Near prompt obs');
    expect(output).toContain('closest obs to P#99999');
  });

  it('bare-int anchor errors with cross-source hint when id matches nothing', async () => {
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['timeline', '--anchor', '88888']));
    // Must not just say "Observation #N not found" — either a cross-source "not found"
    // error OR a hint mentioning prompt/session sources.
    expect(output).toMatch(/No observation.*prompt.*session|not found/i);
  });

  // Regression for the compressed-anchor fast-path bug (#8127 follow-up):
  // a bare-int anchor pointing at a compressed obs used to silently straddle a
  // dead record because the before/after window filters `compressed_into != 0`.
  // Fix re-anchors to the compression parent and emits an explanatory note.
  it('bare-int anchor on compressed obs routes to its compressed_into parent', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'feature',
      title: 'Parent summary', text: 'live parent', epochOffset: 1000,
    });
    const parentId = testDb.prepare('SELECT MAX(id) AS id FROM observations').get().id;
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Child compressed into parent', text: 'dead child', epochOffset: 0,
      compressedInto: parentId,
    });
    const childId = testDb.prepare('SELECT MAX(id) AS id FROM observations').get().id;
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['timeline', '--anchor', String(childId), '--before', '0', '--after', '0']));
    expect(output).toContain(`Timeline around #${parentId}`);
    expect(output).toContain(`#${childId} was compressed into it`);
    expect(output).not.toContain(`Timeline around #${childId}`);
  });

  it('bare-int anchor on pruned obs (compressed_into < 0) surfaces explicit error', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Pruned child', text: 'pruned', compressedInto: -2,
    });
    const prunedId = testDb.prepare('SELECT MAX(id) AS id FROM observations').get().id;
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['timeline', '--anchor', String(prunedId)]));
    expect(output).toMatch(/compressed and pruned|no canonical anchor/i);
  });
});

// ─── delete/update reject P#/S# cleanly (regression: #8104) ──────────────────

describe('CLI delete/update rejects non-obs prefixes', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('delete P#N rejects with source-specific message', async () => {
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['delete', 'P#1']));
    expect(output).toMatch(/observation|obs only|--source/i);
  });

  it('update S#N rejects with source-specific message', async () => {
    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['update', 'S#1', '--title', 'x']));
    expect(output).toMatch(/observation|obs only|--source/i);
  });
});

// ─── cmdGet mixed-prefix routing via shared bucketIdTokens (#8127 / #8050) ──

describe('CLI get command — mixed-prefix routing', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('routes mixed tokens to their per-prefix source buckets in one call', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', type: 'bugfix', title: 'Obs target', text: 'obs content' });
    const obsId = testDb.prepare('SELECT MAX(id) AS id FROM observations').get().id;
    testDb.prepare(`INSERT INTO user_prompts (content_session_id, prompt_text, created_at, created_at_epoch) VALUES ('s1', 'prompt target', ?, ?)`).run(new Date().toISOString(), Date.now());
    const promptId = testDb.prepare('SELECT MAX(id) AS id FROM user_prompts').get().id;

    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', `#${obsId},P#${promptId}`]));
    expect(output).toContain(`#${obsId}`);
    expect(output).toContain('Obs target');
    expect(output).toContain(`P#${promptId}`);
    expect(output).toContain('prompt target');
  });

  it('explicit --source overrides per-token prefix (locks all to that bucket)', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', title: 'Obs 1', text: 'x' });
    const obsId = testDb.prepare('SELECT MAX(id) AS id FROM observations').get().id;

    const { run } = await import('../mem-cli.mjs');
    // P#<obsId> with --source obs should coerce to obs bucket and hit.
    const output = await captureStdout(() => run(['get', `P#${obsId}`, '--source', 'obs']));
    expect(output).toContain(`#${obsId}`);
    expect(output).toContain('Obs 1');
  });

  it('unparseable token is reported via stderr and other tokens still resolve', async () => {
    insertObs(testDb, { sessionId: 'mem-s1', project: 'test--project', title: 'Live obs', text: 'x' });
    const obsId = testDb.prepare('SELECT MAX(id) AS id FROM observations').get().id;

    const { run } = await import('../mem-cli.mjs');
    const output = await captureStdout(() => run(['get', `garbage,#${obsId}`]));
    expect(output).toMatch(/unparseable|Ignoring/i);
    expect(output).toContain('Live obs');
  });
});

// ─── timeline query-based anchor ────────────────────────────────────────────

describe('CLI timeline query-based anchor', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { testDb.close(); });

  it('finds anchor via --query flag', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Timeline query anchor target', text: 'unique anchor content for query',
      epochOffset: -60000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Before item', text: 'before content', epochOffset: -120000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'After item', text: 'after content',
    });
    const output = await captureStdout(() => run(['timeline', '--query', 'unique anchor']));
    expect(output).toContain('<--');
    expect(output).toContain('Timeline around');
  });

  it('finds anchor via positional query', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'feature',
      title: 'Positional query anchor', text: 'positional query content',
    });
    const output = await captureStdout(() => run(['timeline', 'positional query']));
    expect(output).toContain('Positional query anchor');
    expect(output).toContain('<--');
  });

  it('timeline with --project filter', async () => {
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Project timeline obs', text: 'project timeline content',
    });
    const output = await captureStdout(() => run(['timeline', '--project', 'test--project']));
    expect(output).toContain('Project timeline obs');
  });

  it('auto-scopes anchor timeline to anchor project when --project omitted', async () => {
    insertSession(testDb, { id: 's2', project: 'other--project', memoryId: 'mem-s2' });
    insertObs(testDb, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'AnchorInTest', text: 'anchor payload', epochOffset: -50000,
    });
    insertObs(testDb, {
      sessionId: 'mem-s2', project: 'other--project', type: 'change',
      title: 'LeakFromOther', text: 'other project content', epochOffset: -40000,
    });
    const anchorId = testDb.prepare("SELECT id FROM observations WHERE title = 'AnchorInTest'").get().id;
    const output = await captureStdout(() => run(['timeline', '--anchor', String(anchorId)]));
    expect(output).toContain('AnchorInTest');
    expect(output).not.toContain('LeakFromOther');
  });
});

// ─── fts-check command ──────────────────────────────────────────────────────

describe('CLI fts-check command', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => { testDb.close(); });

  it('shows usage for no action', async () => {
    const output = await captureStdout(() => run(['fts-check']));
    expect(output).toContain('Usage');
  });

  it('rejects invalid action by name (not by usage)', async () => {
    // Dogfood-5: an invalid action prints "Invalid action <name>. Use: check, rebuild"
    // — naming the offending token instead of dumping a generic usage line.
    const output = await captureStdout(() => run(['fts-check', 'invalid']));
    expect(output).toContain('Invalid action');
    expect(output).toContain('invalid');
    expect(output).toContain('check, rebuild');
  });

  it('checks FTS integrity', async () => {
    const output = await captureStdout(() => run(['fts-check', 'check']));
    expect(output).toContain('FTS5');
  });

  it('rebuilds FTS', async () => {
    const output = await captureStdout(() => run(['fts-check', 'rebuild']));
    expect(output).toContain('rebuilt');
  });
});

// ─── registry command ───────────────────────────────────────────────────────

describe('CLI registry command', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => { testDb.close(); });

  it('shows usage for no action', async () => {
    const output = await captureStdout(() => run(['registry']));
    expect(output).toContain('Usage');
  });

  it('shows usage for invalid action', async () => {
    const output = await captureStdout(() => run(['registry', 'invalid']));
    expect(output).toContain('Usage');
  });

  // Registry commands access real DB files via REGISTRY_DB_PATH.
  // These tests just verify the command routing works without crashing.
  it('list runs without crashing', async () => {
    const output = await captureStdout(() => run(['registry', 'list']));
    // May succeed or show "not available" depending on registry DB
    expect(output).toBeDefined();
  });

  it('stats runs without crashing', async () => {
    const output = await captureStdout(() => run(['registry', 'stats']));
    expect(output).toBeDefined();
  });

  it('reindex runs without crashing', async () => {
    const output = await captureStdout(() => run(['registry', 'reindex']));
    expect(output).toBeDefined();
  });

  it('search shows usage when no query', async () => {
    const output = await captureStdout(() => run(['registry', 'search']));
    expect(output).toContain('Usage');
  });

  it('import shows usage when missing params', async () => {
    const output = await captureStdout(() => run(['registry', 'import']));
    expect(output).toContain('Usage');
  });

  it('remove shows usage when missing params', async () => {
    const output = await captureStdout(() => run(['registry', 'remove']));
    expect(output).toContain('Usage');
  });
});

// ─── P2: memdir-audit CLI ────────────────────────────────────────────────────

describe('CLI memdir-audit command', () => {
  let tmp;
  // The unit-level audit logic lives in tests/memdir.test.mjs > auditMemdir.
  // These tests exercise only the print layer + flag plumbing + exit code.

  beforeEach(async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    tmp = mkdtempSync(join(tmpdir(), 'cli-audit-'));
    const memdir = join(tmp, 'memory');
    mkdirSync(memdir, { recursive: true });
    const front = '---\nname: F\ndescription: d\ntype: feedback\n---\n';
    writeFileSync(join(memdir, 'feedback_good.md'),
      front + '**Why:** reason\n**How to apply:** rule\n');
    writeFileSync(join(memdir, 'feedback_bad.md'), front + 'orphan body\n');
    writeFileSync(join(memdir, 'project_partial.md'), front + '**Why:** reason\n');
    process.exitCode = 0;
  });

  afterEach(async () => {
    const { rmSync } = await import('fs');
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('prints a 4-section report and sets exit code 1 when non-compliant files exist', async () => {
    const { join } = await import('path');
    const memdir = join(tmp, 'memory');
    const out = await captureStdout(() => run(['memdir-audit', '--memdir', memdir]));
    expect(out).toContain('memdir audit:');
    expect(out).toContain('Compliant (1):');
    expect(out).toContain('feedback_good.md');
    expect(out).toContain('Missing **How to apply:** (1):');
    expect(out).toContain('project_partial.md');
    expect(out).toContain('Missing both (1):');
    expect(out).toContain('feedback_bad.md');
    expect(out).toContain('Total: 3 file(s) (1 compliant)');
    expect(process.exitCode).toBe(1);
  });

  it('exit code 0 when every memory file is compliant', async () => {
    const { writeFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const memdir = join(tmp, 'memory');
    // Make every file compliant.
    const front = '---\nname: F\ndescription: d\ntype: feedback\n---\n';
    unlinkSync(join(memdir, 'feedback_bad.md'));
    unlinkSync(join(memdir, 'project_partial.md'));
    writeFileSync(join(memdir, 'feedback_good.md'),
      front + '**Why:** reason\n**How to apply:** rule\n');

    const out = await captureStdout(() => run(['memdir-audit', '--memdir', memdir]));
    expect(out).toContain('Compliant (1):');
    expect(out).toContain('Total: 1 file(s) (1 compliant)');
    expect(process.exitCode).toBe(0);
  });

  it('reports zero memdirs to scan when --memdir points at a non-existent path', async () => {
    const out = await captureStdout(() => run(['memdir-audit', '--memdir', '/no/such/path/here']));
    expect(out).toContain('Total: 0 file(s)');
    expect(process.exitCode).toBe(0);
  });
});

// ─── Round 3 audit: read-only numeric-flag validation + maintain --ops ────────
// Pre-fix these raw-parseInt sites silently coerced trailing-garbage/scientific
// tokens ("2abc"→2, "1e2"→1) past their range/positivity checks; --ops "" coerced
// to the destructive default. Each now rejects (REJECT-style) or warns+defaults
// (WARN-style). captureStdout captures both stdout and stderr (warnings).
describe('CLI Round3 numeric-flag + ops validation', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
    for (let i = 0; i < 3; i++) {
      insertObs(testDb, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `numflag obs ${i}`, text: `numflagcase entry ${i}`, importance: 2,
      });
    }
  });
  afterEach(() => { testDb.close(); process.exitCode = undefined; });

  it('search --importance rejects garbage tokens (REJECT-style, not parseInt-coerced)', async () => {
    for (const bad of ['2abc', '1e2', '3xyz']) {
      const out = await captureStdout(() => run(['search', 'numflagcase', '--importance', bad]));
      expect(out, `--importance "${bad}" should be rejected`).toContain('Invalid --importance');
      process.exitCode = undefined;
    }
  });

  it('search --offset warns + defaults to 0 on garbage (WARN-style)', async () => {
    const out = await captureStdout(() => run(['search', 'numflagcase', '--offset', '2abc']));
    expect(out).toContain('Invalid --offset "2abc"');
  });

  it('recent <N> positional warns + defaults on garbage', async () => {
    const out = await captureStdout(() => run(['recent', '2abc']));
    expect(out).toContain('Invalid count "2abc"');
  });

  it('timeline --before warns + defaults on garbage', async () => {
    const out = await captureStdout(() => run(['timeline', '--anchor', '1', '--before', '2abc']));
    expect(out).toContain('Invalid --before "2abc"');
  });

  it('maintain execute --ops "" (empty) is rejected, not coerced to the destructive default', async () => {
    const out = await captureStdout(() => run(['maintain', 'execute', '--ops', '']));
    expect(out).toContain('Unknown operation(s)');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
