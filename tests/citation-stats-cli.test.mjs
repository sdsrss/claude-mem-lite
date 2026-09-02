import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

let testDb;

// Capture stdout + stderr combined
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

describe('citation-stats CLI', () => {
  beforeEach(() => {
    testDb = createTestDb();
    insertSession(testDb, { id: 's1', project: 'p1', memoryId: 'mem-s1' });
  });

  afterEach(() => {
    try { testDb.close(); } catch {}
  });

  function obs(overrides) {
    const result = insertObs(testDb, {
      sessionId: 'mem-s1',
      project: 'p1',
      type: 'bugfix',
      title: 't',
      importance: 2,
      ...overrides,
    });
    const id = result.lastInsertRowid;
    // The 3 v32 columns aren't accepted by insertObs — patch via raw UPDATE.
    testDb.prepare('UPDATE observations SET uncited_streak=?, cited_count=?, injection_count=? WHERE id=?')
      .run(overrides.uncited_streak ?? 0, overrides.cited_count ?? 0, overrides.injection_count ?? 0, id);
    return id;
  }

  it('reports active decay queue (uncited_streak >= 2)', async () => {
    obs({ title: 'queue me', importance: 2, uncited_streak: 2 });
    obs({ title: 'safe', importance: 2, uncited_streak: 1 });
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/decay queue/i);
    expect(output).toContain('queue me');
    expect(output).not.toContain('safe');
  });

  it('reports recently-promoted (cited_count > 0, importance >= 3)', async () => {
    obs({ title: 'pro', importance: 3, cited_count: 2 });
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/promoted/i);
    expect(output).toContain('pro');
  });

  it('reports per-project cite stats', async () => {
    obs({ title: 'a', importance: 2, cited_count: 1, injection_count: 3 });
    obs({ title: 'b', importance: 2, cited_count: 0, injection_count: 2 });
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/p1/);
    expect(output).toMatch(/cite rate|cited/i);
  });

  it('surfaces the GC-durable funnel rate alongside the survivorship rate (Fix B)', async () => {
    // Surviving obs looks great: cited 9 of 10 decay-resolutions = 90% (survivorship-biased).
    obs({ title: 'survivor', importance: 2, cited_count: 9 });
    testDb.prepare('UPDATE observations SET decay_seen_count = 10 WHERE project = ?').run('p1');
    // But citation_log (GC-durable) holds the honest history: 5 cited of 100 injected = 5%.
    testDb.prepare('INSERT INTO citation_log (project, memory_session_id, resolved_at, injected_n, cited_n) VALUES (?,?,?,?,?)')
      .run('p1', 'hist1', Date.now(), 100, 5);
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toContain('funnel');     // honest rate labelled
    expect(output).toContain('surviving');  // biased rate labelled
    expect(output).toContain('5.0%');       // honest funnel rate 5/100
    expect(output).toContain('90.0%');      // survivorship rate 9/10
  });

  it('--json flag emits machine-readable output', async () => {
    obs({ title: 'j', importance: 2, uncited_streak: 2 });
    const output = await captureStdoutOnly(() => run(['citation-stats', '--json']));
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.decay_queue)).toBe(true);
    expect(parsed.decay_queue[0].title).toBe('j');
  });

  it('--days flag sets window for per-project cite rate', async () => {
    // Create old obs (outside 7-day window)
    obs({ title: 'old', importance: 2, cited_count: 5, injection_count: 10, epochOffset: -10 * 86400 * 1000 });
    // Create recent obs (inside window)
    obs({ title: 'new_recent', importance: 2, cited_count: 1, injection_count: 2, epochOffset: 0 });

    const output = await captureStdoutOnly(() => run(['citation-stats', '--days', '7']));
    // The title should be in the output (in either decay queue or promoted section)
    // Since the new obs doesn't have uncited_streak>=2, it won't be in decay queue
    // Since it doesn't have importance=3, it won't be in promoted either
    // But it should be counted in the per-project cite rate
    expect(output).toContain('Cite rate by project');
  });

  it('excludes superseded rows from all sections', async () => {
    const id = obs({ title: 'superseded promoted', importance: 3, cited_count: 5 });
    testDb.prepare('UPDATE observations SET superseded_at = ? WHERE id = ?').run(Date.now(), id);
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).not.toContain('superseded promoted');
  });

  // D#179/D#198 renamed this section: demoted_at now stamps the uncited-streak
  // ROLLOVER, which no longer lowers importance, so "Recently demoted (importance ↓)"
  // had become a caption contradicting the imp= value printed on the same line.
  it('reports recently rolled-over rows (demoted_at within window)', async () => {
    const fresh = obs({ title: 'just demoted', importance: 1 });
    testDb.prepare('UPDATE observations SET demoted_at = ? WHERE id = ?').run(Date.now(), fresh);
    const stale = obs({ title: 'stale demoted', importance: 0 });
    testDb.prepare('UPDATE observations SET demoted_at = ? WHERE id = ?')
      .run(Date.now() - 60 * 86400 * 1000, stale); // 60d ago, outside default 7d window
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/Recently rolled over/);
    // The caption must not re-acquire the claim the loop stopped making.
    expect(output).not.toMatch(/importance ↓/);
    expect(output).toContain('just demoted');
    expect(output).not.toContain('stale demoted');
  });

  it('--json includes demoted array', async () => {
    const id = obs({ title: 'd-json', importance: 0 });
    testDb.prepare('UPDATE observations SET demoted_at = ? WHERE id = ?').run(Date.now(), id);
    const output = await captureStdoutOnly(() => run(['citation-stats', '--json']));
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.demoted)).toBe(true);
    expect(parsed.demoted[0].title).toBe('d-json');
  });

  it('renders the per-session invocation→cite funnel section', async () => {
    testDb.prepare(
      'INSERT INTO citation_log (project, memory_session_id, resolved_at, injected_n, cited_n) VALUES (?,?,?,?,?)'
    ).run('p1', 'fs1', Date.now(), 9, 6);
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/funnel/i);
    expect(output).toContain('9');
    expect(output).toContain('6');
  });

  it('--json includes funnel trend object', async () => {
    testDb.prepare(
      'INSERT INTO citation_log (project, memory_session_id, resolved_at, injected_n, cited_n) VALUES (?,?,?,?,?)'
    ).run('p1', 'fs1', Date.now(), 9, 6);
    const output = await captureStdoutOnly(() => run(['citation-stats', '--json']));
    const parsed = JSON.parse(output);
    expect(parsed.funnel).toBeDefined();
    expect(parsed.funnel.window.injected).toBe(9);
    expect(parsed.funnel.window.cited).toBe(6);
  });

  // v45 per-face split. The section must (a) show each face's own rate and
  // (b) say out loud that the faces overlap — a reader who sums them and
  // compares to the funnel total would otherwise conclude the numbers are broken.
  const seedSurface = (surface, inj, cited, session = 'fs1') =>
    testDb.prepare(
      `INSERT INTO citation_surface_log (project, session_id, surface, resolved_at, injected_n, cited_n)
       VALUES (?,?,?,?,?,?)`
    ).run('p1', session, surface, Date.now(), inj, cited);

  it('renders the per-injection-face section with each face rate', async () => {
    seedSurface('pretool', 20, 2);
    seedSurface('error_recall', 5, 4);
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/injection face/i);
    expect(output).toMatch(/PreToolUse recall.*inj\s+20\s+cited\s+2\s+10\.0%/);
    expect(output).toMatch(/error-recall.*inj\s+5\s+cited\s+4\s+80\.0%/);
  });

  it('states that faces overlap so the rows are not a partition', async () => {
    seedSurface('pretool', 3, 1);
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/not a partition/i);
  });

  // The label table and the enum are two lists again the moment a face is added to one
  // of them. The render falls back to the raw key, so a missed label is silent — it just
  // prints `task_imperative` in a column of prose names. This pins the readable label.
  it('renders a readable label for every metered face, task_imperative included', async () => {
    seedSurface('task_imperative', 12, 3);
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/task-imperative.*inj\s+12\s+cited\s+3\s+25\.0%/);
    expect(output).not.toMatch(/task_imperative/);   // the raw key must not reach the user
  });

  it('labels keyctx as promotion-only (it can never demote)', async () => {
    seedSurface('keyctx', 10, 1);
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/Key Context.*promotion-only/s);
  });

  // The sibling of the case above, and the reason the note is derived from
  // DECAY_DENOMINATOR_SURFACES rather than special-cased: an annotated keyctx
  // beside a BARE non-decay face reads as "that one does feed decay", which is
  // false. Until v3.77.0 that argument lived only in a code comment — collapsing
  // the note to '' left every CLI suite green.
  //
  // `task_imperative` moved sides here (it entered the denominator once its rate was
  // read) and is now the pinned NEGATIVE, which is the stronger half of this case: a
  // derivation that inverts fails on it, and so does one that hardcodes the old face
  // list. `subagent` is still metered-only, so the positive is pinned too.
  it('labels every non-decay face as metered-only, and no decay face', async () => {
    seedSurface('subagent', 5, 2);
    seedSurface('task_imperative', 12, 3);
    seedSurface('pretool', 20, 8);
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/subagent \(dispatch\).*metered only: outside the decay denominator/);
    // Positive first: a bare `not.toMatch` on this face is satisfied just as well by the
    // row not being rendered at all (v3.79.0's "my assertion was satisfied by another
    // cause"). A sibling case does pin the row, but keeping the non-vacuity in the SAME
    // case is what makes this one self-contained.
    expect(output).toMatch(/task-imperative.*inj\s+12\s+cited\s+3/);
    expect(output).not.toMatch(/task-imperative.*metered only/);
    expect(output).not.toMatch(/PreToolUse recall.*metered only/);
  });

  it('--json includes the surface_funnel breakdown', async () => {
    seedSurface('ups', 8, 3);
    const output = await captureStdoutOnly(() => run(['citation-stats', '--json']));
    const parsed = JSON.parse(output);
    expect(parsed.surface_funnel.surfaces).toHaveLength(1);
    expect(parsed.surface_funnel.surfaces[0]).toMatchObject({ surface: 'ups', injected: 8, cited: 3 });
    expect(parsed.surface_funnel.surfaces[0].rate).toBeCloseTo(0.375, 5);
  });

  // b4: the two zero-row states must READ differently. Pre-b4 both printed the
  // same line, so a table that was never created (#10650) was indistinguishable
  // from a fresh install — for as long as the surface stayed unmetered.
  it('an empty window reads as "no rows yet", never as a failure', async () => {
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/no rows in this window yet/i);
    expect(output).not.toMatch(/UNAVAILABLE/);
  });

  it('an unreadable table reads as UNAVAILABLE, not as an empty window', async () => {
    testDb.prepare('DROP TABLE citation_surface_log').run();
    const output = await captureStdout(() => run(['citation-stats']));
    expect(output).toMatch(/UNAVAILABLE/);
    expect(output).toMatch(/citation_surface_log/);       // names the actual failure
    expect(output).toMatch(/fts-check/);                  // and the repair
    expect(output).not.toMatch(/no rows in this window yet/i);
  });

  it('--json carries `unavailable` so a scripted reader is not misled either', async () => {
    testDb.prepare('DROP TABLE citation_surface_log').run();
    const output = await captureStdoutOnly(() => run(['citation-stats', '--json']));
    const parsed = JSON.parse(output);
    expect(parsed.surface_funnel.surfaces).toEqual([]);
    expect(parsed.surface_funnel.unavailable).toBeTruthy();
  });
});
