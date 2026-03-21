// Tests for hook-context.mjs — adaptive time windows, token budgeting, CLAUDE.md updates
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { computeAdaptiveWindows, selectWithTokenBudget, updateClaudeMd, buildSummaryLines } from '../hook-context.mjs';

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

  it('applies diversity penalty for file overlap', () => {
    // Two observations touching same files should have overlap penalty
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'edit server.mjs', importance: 1,
      filesModified: '["server.mjs"]',
      epochOffset: -1000,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'also edit server.mjs', importance: 1,
      filesModified: '["server.mjs"]',
      epochOffset: -2000,
    });
    insertObs(db, {
      sessionId: 'sess-1', project: 'test',
      title: 'edit different utils.mjs', importance: 1,
      filesModified: '["utils.mjs"]',
      epochOffset: -3000,
    });

    const result = selectWithTokenBudget(db, 'test', 2000);
    // All should be included but diversity affects ordering
    expect(result.observations.length).toBe(3);
  });
});

// ─── updateClaudeMd ─────────────────────────────────────────────────────────

describe('updateClaudeMd', () => {
  // Use a temp file to avoid modifying the real CLAUDE.md
  const testDir = join(process.env.TMPDIR || '/tmp', `hook-ctx-test-${process.pid}`);
  const testClaudeMd = join(testDir, 'CLAUDE.md');

  beforeEach(() => {
    try { mkdirSync(testDir, { recursive: true }); } catch {}
    // Mock inferProjectDir by setting env var
    vi.stubEnv('CLAUDE_PROJECT_DIR', testDir);
    try { unlinkSync(testClaudeMd); } catch {}
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try { unlinkSync(testClaudeMd); } catch {}
  });

  it('creates CLAUDE.md with context block when none exists', () => {
    updateClaudeMd('### Last Session\nCompleted: fixed bugs');
    expect(existsSync(testClaudeMd)).toBe(true);
    const content = readFileSync(testClaudeMd, 'utf8');
    expect(content).toContain('<claude-mem-context>');
    expect(content).toContain('### Last Session');
    expect(content).toContain('</claude-mem-context>');
  });

  it('replaces existing context block in-place', () => {
    writeFileSync(testClaudeMd, `# My Project\n\nSome notes.\n\n<claude-mem-context>\nold content\n</claude-mem-context>\n\n# Footer\n`);
    updateClaudeMd('new content');
    const content = readFileSync(testClaudeMd, 'utf8');
    expect(content).toContain('# My Project');
    expect(content).toContain('new content');
    expect(content).not.toContain('old content');
    expect(content).toContain('# Footer');
  });

  it('appends to existing CLAUDE.md without context section', () => {
    writeFileSync(testClaudeMd, '# Existing Project\n\nNotes here.\n');
    updateClaudeMd('session data');
    const content = readFileSync(testClaudeMd, 'utf8');
    expect(content).toContain('# Existing Project');
    expect(content).toContain('<claude-mem-context>');
    expect(content).toContain('session data');
  });

  it('skips write when content is unchanged', () => {
    const existing = `# Project\n\n<claude-mem-context>\ntest content\n</claude-mem-context>\n`;
    writeFileSync(testClaudeMd, existing);
    updateClaudeMd('test content');
    const content = readFileSync(testClaudeMd, 'utf8');
    // Content should be identical — updateClaudeMd skips write when section unchanged
    expect(content).toBe(existing);
  });

  it('preserves surrounding content when replacing', () => {
    const before = '# Header\n\nSome important config.\n\n';
    const after = '\n\n# Other Section\n\nMore stuff.\n';
    writeFileSync(testClaudeMd, `${before}<claude-mem-context>\nold\n</claude-mem-context>${after}`);
    updateClaudeMd('updated');
    const content = readFileSync(testClaudeMd, 'utf8');
    expect(content).toContain('# Header');
    expect(content).toContain('Some important config.');
    expect(content).toContain('# Other Section');
    expect(content).toContain('updated');
    expect(content).not.toContain('old');
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
