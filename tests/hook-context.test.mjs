// Tests for hook-context.mjs — adaptive time windows, token budgeting, CLAUDE.md updates
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { estimateTokens } from '../utils.mjs';
import { computeAdaptiveWindows, selectWithTokenBudget, cleanupClaudeMdLegacyBlock, buildSummaryLines, buildSessionContextLines } from '../hook-context.mjs';
import { insertDeferred } from '../lib/deferred-work.mjs';

// ─── computeAdaptiveWindows ──────────────────────────────────────────────────

describe('computeAdaptiveWindows', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });

  it('returns low velocity windows when project has few observations', () => {
    // 0 observations in 7 days → velocity = 0 → low
    const windows = computeAdaptiveWindows(db, 'test');
    expect(windows.tier1).toBe(48 * 3600000);  // 48 hours
    expect(windows.tier2).toBe(14 * 86400000);  // 14 days
    expect(windows.tier3).toBe(60 * 86400000);  // 60 days
    expect(windows.sessWindow).toBe(14 * 86400000);
  });

  it('returns medium velocity windows for 3-10 obs/day', () => {
    // Insert 35 observations (5/day avg over 7 days)
    for (let i = 0; i < 35; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        title: `obs ${i}`,
        epochOffset: -(i * 3600000), // spread over time
      });
    }
    const windows = computeAdaptiveWindows(db, 'test');
    expect(windows.tier1).toBe(24 * 3600000);  // 24 hours
    expect(windows.tier2).toBe(7 * 86400000);   // 7 days
  });

  it('returns high velocity windows for >10 obs/day', () => {
    // Insert 80 observations (>11/day avg over 7 days)
    for (let i = 0; i < 80; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        title: `obs ${i}`,
        epochOffset: -(i * 1800000),
      });
    }
    const windows = computeAdaptiveWindows(db, 'test');
    expect(windows.tier1).toBe(12 * 3600000);  // 12 hours
    expect(windows.tier2).toBe(3 * 86400000);   // 3 days
  });

  it('ignores compressed observations', () => {
    // Compressed observations should not count toward velocity
    for (let i = 0; i < 80; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        title: `compressed obs ${i}`,
        epochOffset: -(i * 1800000),
        compressedInto: 999,
      });
    }
    const windows = computeAdaptiveWindows(db, 'test');
    // Should be low velocity since all are compressed
    expect(windows.tier1).toBe(48 * 3600000);
  });

  it('scopes velocity to specific project', () => {
    // Add observations to a different project
    insertSession(db, { id: 'sess-other', project: 'other' });
    for (let i = 0; i < 80; i++) {
      insertObs(db, {
        sessionId: 'sess-other',
        project: 'other',
        title: `other obs ${i}`,
        epochOffset: -(i * 1800000),
      });
    }
    // 'test' project still has zero observations
    const windows = computeAdaptiveWindows(db, 'test');
    expect(windows.tier1).toBe(48 * 3600000); // low velocity
  });
});

// ─── selectWithTokenBudget ──────────────────────────────────────────────────

describe('selectWithTokenBudget', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
  });

  it('returns empty when no observations exist', () => {
    const result = selectWithTokenBudget(db, 'test', 2000);
    expect(result.observations).toEqual([]);
    expect(result.summaries).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  // superseded invisibility on the most-visible surface: auto-dedup (hook.mjs) sets
  // superseded_at but leaves compressed_into=0, so the compressed filter alone let the
  // hidden near-duplicate resurface in the SessionStart "Recent" table. obsPool now filters
  // superseded_at IS NULL (parity with the sibling keyObs query).
  it('excludes superseded rows even when compressed_into is still 0 (auto-dedup shape)', () => {
    insertObs(db, { sessionId: 'sess-1', project: 'test', type: 'decision', title: 'live decision', importance: 2 });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test', type: 'decision', title: 'superseded dup', importance: 2,
      supersededAt: Date.now(), supersededBy: 'auto-dedup', compressedInto: 0,
    });
    const titles = selectWithTokenBudget(db, 'test', 2000).observations.map(o => o.title);
    expect(titles).toContain('live decision');
    expect(titles).not.toContain('superseded dup');
  });

  it('selects recent observations within budget', () => {
    for (let i = 0; i < 5; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        title: `observation ${i}`,
        narrative: `did something ${i}`,
        importance: 1,
        epochOffset: -(i * 60000),
      });
    }
    const result = selectWithTokenBudget(db, 'test', 2000);
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.length).toBeLessThanOrEqual(5);
    expect(result.totalTokens).toBeLessThanOrEqual(2000);
  });

  it('respects token budget', () => {
    // Create observations with long narratives
    for (let i = 0; i < 20; i++) {
      insertObs(db, {
        sessionId: 'sess-1',
        project: 'test',
        title: `observation ${i} with a longer title to consume tokens`,
        narrative: `A narrative about what happened in observation ${i}. ${'x'.repeat(200)}`,
        importance: 1,
        epochOffset: -(i * 60000),
      });
    }
    const result = selectWithTokenBudget(db, 'test', 500);
    expect(result.totalTokens).toBeLessThanOrEqual(500);
  });

  it('prioritizes high importance observations', () => {
    // Insert low importance old obs
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'low importance old', importance: 1,
      epochOffset: -86400000, // 1 day ago
    });
    // Insert high importance old obs
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'high importance old', importance: 3,
      epochOffset: -86400000 * 10, // 10 days ago
    });
    // Insert recent low importance
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'recent low importance', importance: 1,
      epochOffset: -60000, // 1 min ago
    });

    const result = selectWithTokenBudget(db, 'test', 2000);
    expect(result.observations.length).toBeGreaterThan(0);
    // High importance should rank first — exponential decay preserves recency for
    // items within the half-life window (10d < 14d default), so importance=3 dominates
    const titles = result.observations.map(o => o.title);
    expect(titles[0]).toBe('high importance old');
  });

  it('filters by project', () => {
    insertSession(db, { id: 'sess-2', project: 'other' });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test', title: 'test obs', importance: 1,
    });
    insertObs(db, {
      sessionId: 'sess-2', project: 'other', title: 'other obs', importance: 1,
    });

    const result = selectWithTokenBudget(db, 'test', 2000);
    const titles = result.observations.map(o => o.title);
    expect(titles).toContain('test obs');
    expect(titles).not.toContain('other obs');
  });

  it('includes session summaries', () => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, completed, next_steps, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('sess-1', 'test', 'fix bugs', 'fixed 3 bugs', 'run tests', new Date(now).toISOString(), now);

    const result = selectWithTokenBudget(db, 'test', 2000);
    expect(result.summaries.length).toBe(1);
    expect(result.summaries[0].request).toBe('fix bugs');
  });

  it('skips compressed observations', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'compressed one', importance: 1, compressedInto: 42,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'active one', importance: 1,
    });

    const result = selectWithTokenBudget(db, 'test', 2000);
    const titles = result.observations.map(o => o.title);
    expect(titles).not.toContain('compressed one');
    expect(titles).toContain('active one');
  });

  // R1/R3: LOW_SIGNAL title filtering in Key Context selection.
  // Hook-llm fallback titles (Modified X, Worked on X, Reviewed N files:)
  // should not appear in the session-start Key Context table.

  it('R3: excludes "Modified X" titles from Key Context', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'Modified dispatch.mjs', importance: 2,
      epochOffset: -1000,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'Fixed dispatch race condition', importance: 2,
      epochOffset: -2000,
    });
    const result = selectWithTokenBudget(db, 'test', 2000);
    const titles = result.observations.map(o => o.title);
    expect(titles).toContain('Fixed dispatch race condition');
    expect(titles).not.toContain('Modified dispatch.mjs');
  });

  it('R3: excludes "Worked on X" and "Reviewed N files:" from Key Context', () => {
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'Worked on auth cache module', importance: 2,
      epochOffset: -1000,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'Reviewed 6 files: auth.mjs, cache.mjs, utils.mjs', importance: 2,
      epochOffset: -2000,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'Implemented auth middleware', importance: 2,
      epochOffset: -3000,
    });
    const result = selectWithTokenBudget(db, 'test', 2000);
    const titles = result.observations.map(o => o.title);
    expect(titles).toContain('Implemented auth middleware');
    expect(titles).not.toContain('Worked on auth cache module');
    expect(titles.every(t => !t.startsWith('Reviewed '))).toBe(true);
  });

  // D#197. This case was named 'applies diversity penalty for file overlap' and
  // asserted only `observations.length === 3`, with the comment "diversity
  // affects ordering". Neither was true, and the assertion passed either way,
  // which is a large part of why the dead branch survived: the file-overlap
  // block computed a `penalizedValue` that nothing read except an unreachable
  // `continue`, while the order was fixed by the raw valueDensity sort upstream.
  //
  // Rewritten to state the contract that actually holds AND to be able to fail
  // if a real penalty is ever introduced — which per D#197 must be a deliberate,
  // A/B'd ranking change, not a silent one.
  //
  // The fixture is built so the two are distinguishable. All three rows are the
  // same type/importance and seconds apart, so value is ~equal (recency ~2.0 x
  // typeQuality 1.1 x impBoost 1.0 x lessonBoost 1.0 = 2.2) and density is driven
  // by title cost alone:
  //   A  4 tokens -> 1.100   (selected first; puts server.mjs in the overlap set)
  //   B 11 tokens -> 0.663   (FULL overlap with A)
  //   C 13 tokens -> 0.610   (no overlap)
  // B outranks C on raw density, but 0.7 x 0.663 = 0.464 < 0.610 — so under a
  // penalty that actually reached the ordering, C would come before B.
  it('file overlap does NOT reorder selection (D#197: the penalty never applied)', () => {
    const A = 'fix auth guard';
    const B = 'fix the same auth guard again in server file';
    const C = 'fix an unrelated helper in the utils module today ok';
    // Premise check: the discriminator above depends on these exact costs, so a
    // change to estimateTokens must fail loudly here rather than quietly leave
    // the case unable to tell the two behaviours apart.
    expect([estimateTokens(A), estimateTokens(B), estimateTokens(C)]).toEqual([4, 11, 13]);
    // …and the discriminator itself, asserted rather than only described: with
    // equal value, B outranks C on raw density, and a 0.3 overlap penalty on B
    // would put C ahead. If these two ever stop holding, the order assertion
    // below can no longer tell the two behaviours apart and is just decoration.
    const dB = 1 / Math.sqrt(estimateTokens(B));
    const dC = 1 / Math.sqrt(estimateTokens(C));
    expect(dB).toBeGreaterThan(dC);          // raw order is B before C
    expect(0.7 * dB).toBeLessThan(dC);       // penalized order would be C before B

    insertObs(db, {
      sessionId: 'sess-1', project: 'test', type: 'bugfix',
      title: A, importance: 1, filesModified: '["server.mjs"]', epochOffset: -1000,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test', type: 'bugfix',
      title: B, importance: 1, filesModified: '["server.mjs"]', epochOffset: -2000,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test', type: 'bugfix',
      title: C, importance: 1, filesModified: '["utils.mjs"]', epochOffset: -3000,
    });

    const result = selectWithTokenBudget(db, 'test', 2000);
    expect(result.observations.length).toBe(3);
    // Raw-density order. If this ever reads [A, C, B], a file-overlap penalty
    // has reached the ranking — which is a behaviour change owing an A/B.
    expect(result.observations.map(o => o.title)).toEqual([A, B, C]);
  });

  // D#192 — KEYCTX_POOL_OBS is a REACHABILITY backstop, not a relevance gate.
  //
  // The obsPool SELECT orders by `created_at_epoch DESC` and the selector below it
  // re-sorts by valueDensity, into which recency enters compressed to (1,2] against
  // impBoost 1.0-2.0 x typeQuality x lessonBoost. So the key the SQL sorts on barely
  // participates in the final order, and a LIMIT on that SELECT decides what can be
  // considered at all — the D#172 shape, fifth surface.
  //
  // This test pins the PROPERTY, not the number: a high-value row placed past position 50
  // by created_at must still be selected. At KEYCTX_POOL_OBS = 50 it FAILS (verified:
  // "expected [...] to contain 'reachability target'"); it passes at 57 and above, 57
  // being the fixture's row count — so it guards reachability and the ruler prices the
  // value.
  //
  // It is deliberately NOT a ranking test, and an earlier draft of this comment (and of
  // the test name, and of the fixture's own lesson string) wrongly called the target the
  // "densest" row. The pre-tag review computed the shipped formula by hand and refuted it:
  // the control is denser (3.4883 against 3.3590) because it is newer and otherwise
  // identical, so the target can never rank first by construction. Any rule that fills the
  // pool in any order would turn this green. That is the correct scope for a reachability
  // backstop; do not add ranking claims to it without changing the fixture.
  it('D#192: selects a high-value row even when it sits past position 50 by recency', () => {
    const DAY = 86400000;
    // A control with the same shape at position 1, so a red run distinguishes "this row
    // shape cannot be selected" from "this row's POSITION made it unreachable" — the
    // discriminator this fixture exists to provide.
    insertObs(db, {
      sessionId: 'sess-1', project: 'test', type: 'decision',
      title: 'reachability control', importance: 3,
      lessonLearned: 'high value density, newest row',
      epochOffset: -1000,
    });
    // 55 newer, denser-to-read but lower-scoring rows: type `change` (quality 0.5),
    // importance 1, long titles (cost is the denominator of valueDensity). They occupy
    // every pool slot up to 50 under the shipped bound.
    for (let i = 0; i < 55; i++) {
      insertObs(db, {
        sessionId: 'sess-1', project: 'test', type: 'change',
        title: `routine change ${i} with a deliberately long title so its cost is high`,
        importance: 1,
        epochOffset: -(i * 60000 + 60000),
      });
    }
    // The target: oldest row in the corpus, so it sorts LAST by created_at_epoch and
    // lands past the 50-row LIMIT. Ten days keeps it inside tier3 (30d at this
    // velocity) and importance 3 keeps it inside the tier3 arm of the WHERE.
    insertObs(db, {
      sessionId: 'sess-1', project: 'test', type: 'decision',
      title: 'reachability target', importance: 3,
      lessonLearned: 'high value density, oldest row in the corpus',
      epochOffset: -(10 * DAY),
    });

    // Pin the tier the fixture lands in. The target sits at -10d and only qualifies via the
    // tier3 arm; at this row count velocity is 8/day (medium, tier3 = 30d), but ~15 more
    // filler rows would cross 10/day into the high band, where tier3 collapses to 14d and
    // the margin drops to 4 days. Without this assertion a later edit that adds fillers
    // would turn the test red for a reason that has nothing to do with the pool bound.
    const w = computeAdaptiveWindows(db, 'test');
    expect(w.tier3).toBe(30 * DAY);

    const titles = selectWithTokenBudget(db, 'test', 2000).observations.map((o) => o.title);
    expect(titles).toContain('reachability control');
    expect(titles).toContain('reachability target');
  });
});

// ─── cleanupClaudeMdLegacyBlock ─────────────────────────────────────────────
// Context is now delivered via SessionStart hook stdout only. This cleanup
// removes the stale <claude-mem-context> block left by pre-v2.30 installs.

describe('cleanupClaudeMdLegacyBlock', () => {
  // Use a temp file to avoid modifying the real CLAUDE.md
  const testDir = join(process.env.TMPDIR || '/tmp', `hook-ctx-test-${process.pid}`);
  const testClaudeMd = join(testDir, 'CLAUDE.md');

  beforeEach(async () => {
    try { mkdirSync(testDir, { recursive: true }); } catch {}
    vi.stubEnv('CLAUDE_PROJECT_DIR', testDir);
    try { unlinkSync(testClaudeMd); } catch {}
    // v2.48 P2-4: clear marker so each test exercises the full cleanup path.
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');
    const { inferProject } = await import('../utils.mjs');
    try { unlinkSync(join(RUNTIME_DIR, `.legacy-claude-md-cleaned-${inferProject()}`)); } catch {}
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try { unlinkSync(testClaudeMd); } catch {}
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');
    const { inferProject } = await import('../utils.mjs');
    try { unlinkSync(join(RUNTIME_DIR, `.legacy-claude-md-cleaned-${inferProject()}`)); } catch {}
  });

  it('is a no-op when CLAUDE.md does not exist', () => {
    cleanupClaudeMdLegacyBlock();
    expect(existsSync(testClaudeMd)).toBe(false);
  });

  it('is a no-op when CLAUDE.md has no context block', () => {
    const original = '# Existing Project\n\nNotes here.\n';
    writeFileSync(testClaudeMd, original);
    cleanupClaudeMdLegacyBlock();
    const content = readFileSync(testClaudeMd, 'utf8');
    expect(content).toBe(original);
  });

  it('removes existing context block, preserving surrounding content', () => {
    writeFileSync(
      testClaudeMd,
      `# My Project\n\nSome notes.\n\n<claude-mem-context>\nold content\n</claude-mem-context>\n\n# Footer\n`,
    );
    cleanupClaudeMdLegacyBlock();
    const content = readFileSync(testClaudeMd, 'utf8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Some notes.');
    expect(content).toContain('# Footer');
    expect(content).not.toContain('<claude-mem-context>');
    expect(content).not.toContain('</claude-mem-context>');
    expect(content).not.toContain('old content');
  });

  it('removes the legacy hint comment alongside the block', () => {
    const hint = '<!-- claude-mem-lite: auto-updated context. To avoid git noise, add CLAUDE.md to .gitignore -->';
    writeFileSync(
      testClaudeMd,
      `# Project\n\n${hint}\n<claude-mem-context>\nstale\n</claude-mem-context>\n`,
    );
    cleanupClaudeMdLegacyBlock();
    const content = readFileSync(testClaudeMd, 'utf8');
    expect(content).toContain('# Project');
    expect(content).not.toContain('claude-mem-lite: auto-updated');
    expect(content).not.toContain('<claude-mem-context>');
    expect(content).not.toContain('stale');
  });

  it('is idempotent on repeated calls', () => {
    writeFileSync(
      testClaudeMd,
      `# Header\n\n<claude-mem-context>\ncontent\n</claude-mem-context>\n\n# Footer\n`,
    );
    cleanupClaudeMdLegacyBlock();
    const after1 = readFileSync(testClaudeMd, 'utf8');
    cleanupClaudeMdLegacyBlock();
    const after2 = readFileSync(testClaudeMd, 'utf8');
    expect(after2).toBe(after1);
    expect(after1).not.toContain('<claude-mem-context>');
  });

  it('does not collapse the file into pure whitespace when block spans most of it', () => {
    writeFileSync(
      testClaudeMd,
      `# Only Header\n\n<claude-mem-context>\na\nb\nc\n</claude-mem-context>\n`,
    );
    cleanupClaudeMdLegacyBlock();
    const content = readFileSync(testClaudeMd, 'utf8');
    expect(content).toContain('# Only Header');
    expect(content).not.toContain('<claude-mem-context>');
    // No excessive trailing blank lines
    expect(/\n{3,}$/.test(content)).toBe(false);
  });

  // v2.48 P2-4: idempotent marker — skip second invocation entirely so every
  // SessionStart after the first stops reading CLAUDE.md + regex-scanning for
  // a block that's already been cleaned (or was never there).
  it('writes a marker file after first run so subsequent calls short-circuit', async () => {
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');
    const { inferProject } = await import('../utils.mjs');
    const markerPath = join(RUNTIME_DIR, `.legacy-claude-md-cleaned-${inferProject()}`);
    try { unlinkSync(markerPath); } catch {}

    writeFileSync(
      testClaudeMd,
      `# Project\n\n<claude-mem-context>\ncontent\n</claude-mem-context>\n`,
    );
    cleanupClaudeMdLegacyBlock();

    // Marker dropped after first call regardless of whether block existed
    expect(existsSync(markerPath)).toBe(true);
    const afterFirst = readFileSync(testClaudeMd, 'utf8');
    expect(afterFirst).not.toContain('<claude-mem-context>');

    // Simulate a second invocation where user re-introduced the block by
    // hand — marker must short-circuit so we do NOT re-write the file.
    const reintroduced = `# Project\n\n<claude-mem-context>\nre-added\n</claude-mem-context>\n`;
    writeFileSync(testClaudeMd, reintroduced);
    cleanupClaudeMdLegacyBlock();

    const afterSecond = readFileSync(testClaudeMd, 'utf8');
    expect(afterSecond).toBe(reintroduced); // untouched — proves short-circuit fired

    try { unlinkSync(markerPath); } catch {}
  });

  it('writes marker even when CLAUDE.md does not exist (avoid repeated stat)', async () => {
    const { RUNTIME_DIR } = await import('../hook-shared.mjs');
    const { inferProject } = await import('../utils.mjs');
    const markerPath = join(RUNTIME_DIR, `.legacy-claude-md-cleaned-${inferProject()}`);
    try { unlinkSync(markerPath); } catch {}

    expect(existsSync(testClaudeMd)).toBe(false);
    cleanupClaudeMdLegacyBlock();

    // Even with no CLAUDE.md, we drop the marker — future SessionStarts skip
    // the fs call entirely. If the user later writes CLAUDE.md + re-adds the
    // legacy block manually, `claude-mem-lite doctor --reset` (or manual
    // marker delete) is the recovery path.
    expect(existsSync(markerPath)).toBe(true);

    try { unlinkSync(markerPath); } catch {}
  });
});

// ─── buildSummaryLines ──────────────────────────────────────────────────────

describe('buildSummaryLines', () => {
  it('includes lessons and decisions in summary lines', () => {
    const summary = {
      request: 'Fix auth flow',
      completed: 'Fixed token refresh',
      next_steps: 'Add tests',
      remaining_items: '',
      lessons: JSON.stringify(['Always use exponential backoff for retries']),
      key_decisions: JSON.stringify(['Chose jose over jsonwebtoken for ESM']),
    };
    const lines = buildSummaryLines(summary);
    const text = lines.join('\n');
    expect(text).toMatch(/Lessons:.*exponential backoff/);
    expect(text).toMatch(/Decisions:.*jose/);
  });

  it('handles null lessons gracefully', () => {
    const summary = { request: 'Simple task', completed: 'Done', next_steps: '', remaining_items: '' };
    const lines = buildSummaryLines(summary);
    const text = lines.join('\n');
    expect(text).not.toMatch(/Lessons:/);
    expect(text).not.toMatch(/Decisions:/);
  });

  it('returns empty array for null summary', () => {
    const lines = buildSummaryLines(null);
    expect(lines).toEqual([]);
  });

  it('truncates long fields', () => {
    const summary = { request: 'x'.repeat(200), completed: '', next_steps: '', remaining_items: '' };
    const lines = buildSummaryLines(summary);
    const requestLine = lines.find(l => l.startsWith('Request:'));
    expect(requestLine.length).toBeLessThan(200);
  });
});

describe('buildSessionContextLines: Deferred Work block (deferred_work-backed)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-x', project: 'test' });
  });
  afterEach(() => { db.close(); });

  it('renders open deferred_work items as numbered list with priority + D#N', () => {
    insertDeferred(db, { project: 'test', title: 'Round 2 zero-byte', priority: 3 });
    insertDeferred(db, { project: 'test', title: 'Tier 4a CLI ergonomic', priority: 2 });
    const lines = buildSessionContextLines(db, 'test');
    // Expect new format: "<ordinal>. <icon> [P<n>] <title> (D#<id>)"
    expect(lines).toMatch(/### Deferred Work/);
    expect(lines).toMatch(/1\..*🔴.*\[P3\].*Round 2 zero-byte.*\(D#\d+\)/);
    expect(lines).toMatch(/2\..*🟡.*\[P2\].*Tier 4a CLI ergonomic.*\(D#\d+\)/);
  });

  it('caps display at 5 items', () => {
    for (let i = 0; i < 7; i++) {
      insertDeferred(db, { project: 'test', title: `item ${i}`, priority: 2 });
    }
    const lines = buildSessionContextLines(db, 'test');
    // Count specifically inside the Deferred Work section
    const section = lines.split('### Deferred Work')[1]?.split(/^###\s/m)[0] || '';
    const deferredLines = (section.match(/^\d+\.\s/gm) || []).length;
    expect(deferredLines).toBe(5);
  });

  it('omits block entirely when no open items', () => {
    const lines = buildSessionContextLines(db, 'test');
    expect(lines).not.toMatch(/### Deferred Work/);
  });

  it('does NOT leak across projects', () => {
    insertDeferred(db, { project: 'OTHER', title: 'wrong-project deferred should not leak', priority: 3 });
    insertDeferred(db, { project: 'test', title: 'real local deferred worth surfacing', priority: 2 });
    const out = buildSessionContextLines(db, 'test');
    const deferredBlock = extractSection(out, 'Deferred Work');
    expect(deferredBlock).toContain('real local deferred');
    expect(deferredBlock).not.toContain('wrong-project deferred');
  });

  it('does NOT surface importance≥3 observations (legacy behavior removed)', () => {
    // Pre-v2.70: high-importance obs appeared in this block as a workaround.
    // Now they only appear in the Recent table; this block is dedicated to
    // the deferred_work table.
    insertObs(db, {
      sessionId: 'sess-x', project: 'test',
      title: 'high-importance decision should not surface here anymore',
      type: 'decision', importance: 3,
    });
    const out = buildSessionContextLines(db, 'test');
    expect(out).not.toMatch(/### Deferred Work/);
  });
});

describe('buildSessionContextLines: Recent table cell safety', () => {
  let db;
  beforeEach(() => { db = createTestDb(); insertSession(db, { id: 'sess-r', project: 'test' }); });
  afterEach(() => { db.close(); });

  it('escapes a literal pipe in a title so the markdown table stays 4 columns', () => {
    insertObs(db, { sessionId: 'sess-r', project: 'test', type: 'decision', title: 'Use grep | sort | uniq pipeline', importance: 3 });
    const out = buildSessionContextLines(db, 'test');
    // Select the TABLE ROW, not any line mentioning the word. On a project that is not
    // adopted the context block also renders a `### Key Context` bullet containing the same
    // title, and `.find()` returned that instead — so this passed or failed on whether the
    // HOST directory happened to be adopted (green in the maintainer's tree, red from any
    // clone). That is the very defect class this release's MAIN-1 fix is about.
    const row = out.split('\n').find(l => l.startsWith('|') && l.includes('grep'));
    expect(row).toBeTruthy();
    // Every cell-separating pipe is unescaped; title pipes are escaped \| — so a
    // correct row has exactly the 5 structural pipes of a 4-column row.
    const structuralPipes = (row.match(/(^|[^\\])\|/g) || []).length;
    expect(structuralPipes).toBe(5);
    expect(row).toContain('grep \\| sort \\| uniq');
  });

  it('collapses CR/LF/tab in a title to spaces so one obs stays one row', () => {
    insertObs(db, { sessionId: 'sess-r', project: 'test', type: 'bugfix', title: 'multi\nline\ttitle', importance: 2 });
    const out = buildSessionContextLines(db, 'test');
    // Table row, not any matching line — see the note in the pipe-escaping case above.
    const row = out.split('\n').find(l => l.startsWith('|') && l.includes('multi'));
    expect(row).toContain('multi line title');
  });
});

function extractSection(text, header) {
  const lines = text.split('\n');
  const startIdx = lines.findIndex(l => l.startsWith(`### ${header}`));
  if (startIdx === -1) return '';
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('### ')) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}
