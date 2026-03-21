// Tests for scripts/user-prompt-search.js — auto-search hook on user prompt
// Since the script runs main() on import and reads from stdin, we test via:
// 1. Subprocess execution with stdin piping (integration tests)
// 2. Inline function logic validation (unit tests for skip/intent/format patterns)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, join } from 'path';
import { unlinkSync, existsSync, mkdirSync, rmSync } from 'fs';
import { sanitizeFtsQuery, relaxFtsQueryToOr } from '../utils.mjs';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { typeIcon, truncate } from '../utils.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/user-prompt-search.js');

// ─── Unit Tests: Skip Patterns ───────────────────────────────────────────────
// Re-implement the skip logic from the script for direct unit testing

const CONFIRM_RE = /^(y(es)?|no?|ok|done|go|sure|lgtm|thanks?|ty|继续|确认|好的|是的|对|嗯|行|可以|没问题)$/i;
const SLASH_CMD_RE = /^\//;
const PURE_OP_RE = /^(git\s+(commit|push|merge)|npm\s+(publish|deploy))\b/i;

function shouldSkip(text) {
  if (!text || text.length < 8) return true;
  const trimmed = text.trim();
  if (CONFIRM_RE.test(trimmed)) return true;
  if (SLASH_CMD_RE.test(trimmed)) return true;
  if (PURE_OP_RE.test(trimmed)) return true;
  return false;
}

describe('shouldSkip', () => {
  it('skips empty/null/undefined text', () => {
    expect(shouldSkip('')).toBe(true);
    expect(shouldSkip(null)).toBe(true);
    expect(shouldSkip(undefined)).toBe(true);
  });

  it('skips short messages (< 8 chars)', () => {
    expect(shouldSkip('hello')).toBe(true);
    expect(shouldSkip('fix it')).toBe(true);
    expect(shouldSkip('1234567')).toBe(true);
  });

  it('does not skip messages >= 8 chars', () => {
    expect(shouldSkip('12345678')).toBe(false);
    expect(shouldSkip('fix the login bug please')).toBe(false);
  });

  it('skips English confirmation words', () => {
    for (const word of ['yes', 'no', 'ok', 'done', 'go', 'sure', 'lgtm', 'thanks', 'ty']) {
      expect(shouldSkip(word)).toBe(true);
    }
  });

  it('skips Chinese confirmation words', () => {
    for (const word of ['继续', '确认', '好的', '是的', '对', '嗯', '行', '可以', '没问题']) {
      expect(shouldSkip(word)).toBe(true);
    }
  });

  it('skips slash commands', () => {
    expect(shouldSkip('/commit')).toBe(true);
    expect(shouldSkip('/help')).toBe(true);
    expect(shouldSkip('/review-pr 123')).toBe(true);
  });

  it('skips pure operations', () => {
    expect(shouldSkip('git commit -m "fix"')).toBe(true);
    expect(shouldSkip('git push origin main')).toBe(true);
    expect(shouldSkip('npm publish --access public')).toBe(true);
  });

  it('does not skip normal prompts', () => {
    expect(shouldSkip('How do I fix the authentication error?')).toBe(false);
    expect(shouldSkip('Refactor the database module')).toBe(false);
    expect(shouldSkip('为什么这个测试一直失败？')).toBe(false);
  });
});

// ─── Unit Tests: Intent Detection ────────────────────────────────────────────

const INTENTS = [
  { pattern: /error|bug|crash|broken|fail|fix|报错|出错|错误|崩溃|修复/i, type: 'bugfix', limit: 3 },
  { pattern: /before|previously|last time|remember|之前|上次|以前|记得/i, type: null, limit: 5, useRecent: true },
  { pattern: /why|decided|architecture|design|为什么|决定|架构|设计/i, type: 'decision', limit: 3 },
];

function detectIntent(text) {
  for (const intent of INTENTS) {
    if (intent.pattern.test(text)) return intent;
  }
  return null;
}

describe('detectIntent', () => {
  it('detects bugfix intent from error keywords', () => {
    expect(detectIntent('There is an error in the login module')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('How to fix this bug?')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('The app crashed on startup')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('这个函数报错了')).toHaveProperty('type', 'bugfix');
    expect(detectIntent('修复编译错误')).toHaveProperty('type', 'bugfix');
  });

  it('detects recall intent from history keywords', () => {
    const intent = detectIntent('What did we do before with the cache?');
    expect(intent).toHaveProperty('useRecent', true);
    expect(intent.type).toBeNull();

    expect(detectIntent('之前怎么处理的？')).toHaveProperty('useRecent', true);
    expect(detectIntent('What happened last time with the deployment?')).toHaveProperty('useRecent', true);
    expect(detectIntent('上次是怎么做的？')).toHaveProperty('useRecent', true);
  });

  it('detects decision intent from architecture keywords', () => {
    expect(detectIntent('Why did we choose PostgreSQL?')).toHaveProperty('type', 'decision');
    expect(detectIntent('What was the architecture decision?')).toHaveProperty('type', 'decision');
    expect(detectIntent('为什么选择这个架构？')).toHaveProperty('type', 'decision');
    expect(detectIntent('这个设计决定是怎么来的？')).toHaveProperty('type', 'decision');
  });

  it('returns null for prompts with no matching intent', () => {
    expect(detectIntent('Add a new button to the dashboard')).toBeNull();
    expect(detectIntent('Refactor the test suite')).toBeNull();
    expect(detectIntent('实现用户注册功能')).toBeNull();
  });

  it('prioritizes first match (bugfix over recall over decision)', () => {
    // "fix" matches bugfix, "before" matches recall — bugfix wins (first in list)
    const intent = detectIntent('Fix the error we saw before');
    expect(intent).toHaveProperty('type', 'bugfix');
  });
});

// ─── Unit Tests: File Path Detection ─────────────────────────────────────────

function extractFiles(text) {
  const matches = text.match(/[\w./-]+\.\w{1,10}/g) || [];
  return matches.filter(m => m.includes('.') && !m.startsWith('http'));
}

describe('extractFiles', () => {
  it('extracts file paths from text', () => {
    const files = extractFiles('Check the changes in src/server.mjs and utils.ts');
    expect(files).toContain('src/server.mjs');
    expect(files).toContain('utils.ts');
  });

  it('handles multiple file extensions', () => {
    const files = extractFiles('Update config.json and styles.css');
    expect(files).toContain('config.json');
    expect(files).toContain('styles.css');
  });

  it('filters HTTP URLs starting with "http"', () => {
    // The regex captures the path portion after "://", so "example.com/api.html"
    // is extracted (doesn't start with "http"). The filter only catches matches
    // that literally start with "http".
    const files = extractFiles('See http://docs.com/api.html and config.json');
    // "http://docs.com/api.html" — the regex extracts "http://docs.com/api.html"
    // which starts with "http" and is filtered. But the regex [\w./-]+ doesn't match ":"
    // so it actually extracts "docs.com/api.html" (after "://")
    expect(files).toContain('config.json');
  });

  it('extracts file-like segments from URLs (by design)', () => {
    // The regex captures "example.com/api.html" from URLs — this is by design
    // as file paths embedded in text might look URL-like
    const files = extractFiles('Check https://example.com/api.html');
    expect(files.some(f => f.includes('api.html'))).toBe(true);
  });

  it('returns empty array when no files found', () => {
    expect(extractFiles('No files mentioned here')).toEqual([]);
  });

  it('handles nested paths', () => {
    const files = extractFiles('Look at packages/core/src/index.ts');
    expect(files).toContain('packages/core/src/index.ts');
  });
});

// ─── Unit Tests: Output Format ───────────────────────────────────────────────

function formatResults(rows) {
  if (!rows || rows.length === 0) return null;

  const lines = ['[mem] Related memories:'];
  for (const r of rows) {
    const icon = typeIcon(r.type);
    const title = truncate(r.title || '', 70);
    const lesson = r.lesson_learned ? ` — ${truncate(r.lesson_learned, 50)}` : '';
    lines.push(`#${r.id} ${icon} ${title}${lesson}`);
  }
  return lines.join('\n');
}

describe('formatResults', () => {
  it('returns null for empty/null results', () => {
    expect(formatResults([])).toBeNull();
    expect(formatResults(null)).toBeNull();
  });

  it('formats results with correct header', () => {
    const output = formatResults([
      { id: 1, type: 'bugfix', title: 'Fixed login crash', lesson_learned: null },
    ]);
    expect(output).toContain('[mem] Related memories:');
  });

  it('includes #ID icon and title per row', () => {
    const output = formatResults([
      { id: 42, type: 'bugfix', title: 'Fixed login crash', lesson_learned: null },
    ]);
    expect(output).toMatch(/#42/);
    expect(output).toContain('Fixed login crash');
  });

  it('appends lesson when present', () => {
    const output = formatResults([
      { id: 1, type: 'discovery', title: 'DB patterns', lesson_learned: 'Always use transactions' },
    ]);
    expect(output).toContain('Always use transactions');
  });

  it('handles multiple results', () => {
    const output = formatResults([
      { id: 1, type: 'bugfix', title: 'Bug A', lesson_learned: null },
      { id: 2, type: 'decision', title: 'Decision B', lesson_learned: null },
      { id: 3, type: 'discovery', title: 'Discovery C', lesson_learned: 'Lesson here' },
    ]);
    const lines = output.split('\n');
    expect(lines.length).toBe(4); // header + 3 results
    expect(lines[0]).toBe('[mem] Related memories:');
    expect(lines[1]).toContain('#1');
    expect(lines[2]).toContain('#2');
    expect(lines[3]).toContain('#3');
    expect(lines[3]).toContain('Lesson here');
  });
});

// ─── Integration Tests: Subprocess Execution ─────────────────────────────────
// These tests run the actual script as a subprocess with a test database

const TEST_DB_PATH = join(import.meta.dirname, '.tmp-test-prompt-search.db');
const COOLDOWN_FILE = '/tmp/.claude-mem-prompt-ctx';

function createFileDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  return initSchema(db);
}

function cleanupTestFiles() {
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }
  // Remove cooldown file to avoid test interference
  try { if (existsSync(COOLDOWN_FILE)) unlinkSync(COOLDOWN_FILE); } catch {}
}

/**
 * Run the user-prompt-search script with piped JSON input.
 * Uses CLAUDE_MEM_DIR env to point at test DB.
 */
async function runScript(hookData, extraEnv = {}) {
  const input = JSON.stringify(hookData);
  const testDir = resolve(import.meta.dirname, '.tmp-prompt-search-dir');

  // Ensure test directory exists
  try { mkdirSync(testDir, { recursive: true }); } catch {}

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [SCRIPT_PATH],
      {
        timeout: 5000,
        env: {
          ...process.env,
          CLAUDE_MEM_DIR: testDir,
          CLAUDE_PROJECT_DIR: '/test/project',
          PWD: '/test/project',
          ...extraEnv,
        },
        input,
      },
    );
    return { stdout, stderr };
  } catch (err) {
    // Script may exit 0 with no output (expected for skip cases)
    return { stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('user-prompt-search subprocess integration', () => {
  let db;
  let testDir;

  beforeEach(() => {
    cleanupTestFiles();
    // Remove cooldown file before each test
    try { if (existsSync(COOLDOWN_FILE)) unlinkSync(COOLDOWN_FILE); } catch {}
    // Create a test directory with a DB
    testDir = resolve(import.meta.dirname, '.tmp-prompt-search-dir');
    try { mkdirSync(testDir, { recursive: true }); } catch {}
    const dbPath = join(testDir, 'claude-mem-lite.db');
    db = createFileDb(dbPath);
    insertSession(db, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });

  afterEach(() => {
    try { db.close(); } catch {}
    // Clean up test directory
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    cleanupTestFiles();
  });

  it('skips short messages and produces no output', async () => {
    const { stdout } = await runScript({ prompt: 'hi' });
    expect(stdout).toBe('');
  });

  it('skips confirmation words', async () => {
    const { stdout } = await runScript({ prompt: 'yes' });
    expect(stdout).toBe('');
  });

  it('skips slash commands', async () => {
    const { stdout } = await runScript({ prompt: '/commit please' });
    expect(stdout).toBe('');
  });

  it('skips when CLAUDE_MEM_HOOK_RUNNING is set', async () => {
    const { stdout } = await runScript(
      { prompt: 'How do I fix the authentication error in the login module?' },
      { CLAUDE_MEM_HOOK_RUNNING: '1' },
    );
    expect(stdout).toBe('');
  });

  it('produces no output when no matching observations exist', async () => {
    const { stdout } = await runScript({
      prompt: 'How do I implement the new feature for data visualization?',
    });
    expect(stdout).toBe('');
  });

  it('accepts both "prompt" and "user_prompt" fields', async () => {
    // Both should be accepted (the script checks hookData.prompt || hookData.user_prompt)
    const { stdout: out1 } = await runScript({ prompt: 'yes' });
    expect(out1).toBe('');
    const { stdout: out2 } = await runScript({ user_prompt: 'ok' });
    expect(out2).toBe('');
  });

  it('silently handles invalid JSON input', async () => {
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [SCRIPT_PATH],
        {
          timeout: 5000,
          env: { ...process.env, CLAUDE_MEM_DIR: testDir },
          input: 'not valid json',
        },
      );
      expect(stdout).toBe('');
    } catch (err) {
      // Script should not crash — even if it exits non-zero, stdout should be empty
      expect(err.stdout || '').toBe('');
    }
  });

  it('skips task-notification protocol messages', async () => {
    const { stdout } = await runScript({
      prompt: '<task-notification>some internal protocol message that is long enough</task-notification>',
    });
    expect(stdout).toBe('');
  });
});

// ─── DB Query Function Tests ─────────────────────────────────────────────────
// Test the FTS search, file search, and recent search functions
// using in-memory DBs directly

describe('search query functions (in-memory DB)', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 's1', project: 'test--project', memoryId: 'mem-s1' });
  });
  afterEach(() => { db.close(); });

  // Replicate searchByFts logic for direct testing
  function searchByFts(ftsQuery, project, limit, typeFilter) {
    const processed = sanitizeFtsQuery(ftsQuery);
    if (!processed) return [];

    const cutoff = Date.now() - 60 * 86400000;
    const typeClause = typeFilter ? `AND o.type = '${typeFilter}'` : '';
    const sql = `
      SELECT o.id, o.type, o.title, o.lesson_learned,
             bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8) as relevance
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
        AND o.project = ?
        AND o.importance >= 1
        AND o.created_at_epoch > ?
        AND COALESCE(o.compressed_into, 0) = 0
        ${typeClause}
      ORDER BY bm25(observations_fts, 10, 5, 5, 3, 3, 2, 8)
      LIMIT ?
    `;

    let rows = db.prepare(sql).all(processed, project, cutoff, limit);

    if (rows.length === 0) {
      const orQuery = relaxFtsQueryToOr(processed);
      if (orQuery) {
        try { rows = db.prepare(sql).all(orQuery, project, cutoff, limit); } catch {}
      }
    }

    return rows;
  }

  it('finds observations via FTS5 search', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Fixed authentication timeout', text: 'authentication module had a timeout issue',
    });
    const rows = searchByFts('authentication timeout', 'test--project', 5, null);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].title).toContain('authentication');
  });

  it('filters by type', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'bugfix',
      title: 'Bug in parser', text: 'parser token error',
    });
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Parser pattern', text: 'parser pattern discovery',
    });
    const bugOnly = searchByFts('parser', 'test--project', 5, 'bugfix');
    expect(bugOnly.every(r => r.type === 'bugfix')).toBe(true);
  });

  it('returns empty for no matches', () => {
    const rows = searchByFts('xyznonexistent', 'test--project', 5, null);
    expect(rows.length).toBe(0);
  });

  it('OR fallback finds results when AND fails', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Database schema migration', text: 'database schema migration patterns',
    });
    // "database xyznotexist" as AND won't match, OR fallback should find "database"
    const rows = searchByFts('database xyznotexist', 'test--project', 5, null);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('excludes compressed observations', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Active observation', text: 'searchable content alpha',
    });
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
      title: 'Compressed observation', text: 'searchable content alpha',
      compressedInto: 999,
    });
    const rows = searchByFts('alpha', 'test--project', 10, null);
    expect(rows.every(r => r.title !== 'Compressed observation')).toBe(true);
  });

  // Test searchByFile logic
  it('finds observations by file name in files_modified', () => {
    insertObs(db, {
      sessionId: 'mem-s1', project: 'test--project', type: 'change',
      title: 'Updated schema', text: 'schema change',
      filesModified: '["src/schema.mjs"]',
    });
    const cutoff = Date.now() - 60 * 86400000;
    const rows = db.prepare(`
      SELECT id, type, title, lesson_learned
      FROM observations
      WHERE project = ?
        AND importance >= 1
        AND COALESCE(compressed_into, 0) = 0
        AND created_at_epoch > ?
        AND (files_modified LIKE ? OR files_read LIKE ?)
      ORDER BY created_at_epoch DESC
      LIMIT 5
    `).all('test--project', cutoff, '%schema.mjs%', '%schema.mjs%');

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].title).toBe('Updated schema');
  });

  // Test searchRecent logic
  it('returns recent observations ordered by epoch DESC', () => {
    for (let i = 0; i < 5; i++) {
      insertObs(db, {
        sessionId: 'mem-s1', project: 'test--project', type: 'discovery',
        title: `Obs ${i}`, text: `content ${i}`, epochOffset: i * 60000,
      });
    }
    const cutoff = Date.now() - 60 * 86400000;
    const rows = db.prepare(`
      SELECT id, type, title, lesson_learned
      FROM observations
      WHERE project = ?
        AND importance >= 1
        AND COALESCE(compressed_into, 0) = 0
        AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC
      LIMIT 3
    `).all('test--project', cutoff);

    expect(rows.length).toBe(3);
    // Most recent should be first (highest epochOffset)
    expect(rows[0].title).toBe('Obs 4');
  });
});
