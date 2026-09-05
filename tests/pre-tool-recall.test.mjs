import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { writeFileSync, mkdirSync, rmSync, readFileSync, mkdtempSync } from 'fs';
import { createTestDb, insertSession, insertObs, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');

// Default sandbox for tests that don't override CLAUDE_MEM_DIR. Without it,
// negative-path tests (invalid JSON, missing file_path) write hook-error
// telemetry to the real ~/.claude-mem-lite/runtime/hook-errors/ — cite #8447:
// fast-path scripts must mirror schema.mjs env-var convention, and tests must
// honor it too.
const DEFAULT_SANDBOX = mkdtempSync(join(tmpdir(), 'pre-recall-sandbox-'));

// Helper: run script with piped stdin (spawn handles for-await stdin correctly)
function runScriptRaw(inputStr, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      // Order matters: process.env first, then DEFAULT_SANDBOX overrides any
      // dev-shell CLAUDE_MEM_DIR, then explicit `env` overrides the sandbox
      // for tests that need their own RUNTIME_DIR.
      env: { ...process.env, CLAUDE_MEM_DIR: DEFAULT_SANDBOX, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', () => resolve({ stdout, stderr }));
    child.on('error', reject);
    child.stdin.write(inputStr);
    child.stdin.end();
    setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}

// Helper: run script with JSON input and CLAUDE_MEM_HOOK_RUNNING cleared
async function runScript(input, env = {}) {
  return runScriptRaw(JSON.stringify(input), { CLAUDE_MEM_HOOK_RUNNING: '', ...env });
}

describe('pre-tool-recall', () => {
  describe('input parsing', () => {
    it('exits silently on invalid JSON', async () => {
      const { stdout } = await runScriptRaw('not json', { CLAUDE_MEM_HOOK_RUNNING: '' });
      expect(stdout).toBe('');
    });

    it('exits silently when tool_input.file_path is missing', async () => {
      const { stdout } = await runScript({ tool_name: 'Edit', tool_input: {} });
      expect(stdout).toBe('');
    });

    it('exits silently when CLAUDE_MEM_HOOK_RUNNING is set', async () => {
      const { stdout } = await runScriptRaw(
        JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/foo.mjs' } }),
        { CLAUDE_MEM_HOOK_RUNNING: '1' },
      );
      expect(stdout).toBe('');
    });
  });

  describe('cooldown', () => {
    const RUNTIME = join(tmpdir(), 'pre-recall-test-' + process.pid);
    const COOLDOWN = join(RUNTIME, 'pre-recall-cooldown.json');

    beforeEach(() => mkdirSync(RUNTIME, { recursive: true }));
    afterEach(() => rmSync(RUNTIME, { recursive: true, force: true }));

    it('cooldown JSON uses full file path as key', () => {
      const data = { '/path/to/schema.mjs': Date.now() };
      writeFileSync(COOLDOWN, JSON.stringify(data));
      const parsed = JSON.parse(readFileSync(COOLDOWN, 'utf8'));
      expect(parsed['/path/to/schema.mjs']).toBeDefined();
    });

    it('different files with same basename have separate cooldowns', () => {
      const data = { '/src/utils.mjs': Date.now(), '/lib/utils.mjs': Date.now() - 600000 };
      writeFileSync(COOLDOWN, JSON.stringify(data));
      const parsed = JSON.parse(readFileSync(COOLDOWN, 'utf8'));
      expect(Object.keys(parsed)).toHaveLength(2);
    });
  });

  // These two cases run a HAND-COPY of the injection SELECT, not the shipped
  // one — they document the intended shape and cannot detect drift in
  // scripts/pre-tool-recall.js. That is how D#162 stayed open: the copy asserted
  // superseded/compressed exclusion while the real query's filter was untested.
  // Guards that bind the shipped script live in the D#162 block at the bottom.
  describe('DB query pattern (illustrative copy — see D#162 block for the real guard)', () => {
    it('uses observation_files junction table with correct filters', () => {
      const db = createTestDb();
      insertSession(db, { id: 'sess-1' });

      // Insert obs with lesson + high importance (SHOULD match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'FTS5 broke after schema change',
        type: 'bugfix',
        importance: 2,
        lessonLearned: 'Verify FTS5 integrity after schema changes',
        filesModified: '["schema.mjs"]',
      });

      // Insert obs without lesson (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Edited schema.mjs',
        type: 'change',
        importance: 2,
        lessonLearned: null,
        filesModified: '["schema.mjs"]',
      });

      // Insert obs with low importance (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Minor tweak',
        type: 'change',
        importance: 1,
        lessonLearned: 'Some lesson',
        filesModified: '["schema.mjs"]',
      });

      // Insert compressed obs (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Old compressed',
        type: 'bugfix',
        importance: 3,
        lessonLearned: 'Important lesson',
        filesModified: '["schema.mjs"]',
        compressedInto: 999,
      });

      // Insert superseded obs (should NOT match)
      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Superseded obs',
        type: 'bugfix',
        importance: 3,
        lessonLearned: 'Old lesson',
        filesModified: '["schema.mjs"]',
        supersededAt: new Date().toISOString(),
      });

      const cutoff = Date.now() - 60 * 86400000;
      const rows = db
        .prepare(
          `
        SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
        FROM observations o
        JOIN observation_files of2 ON of2.obs_id = o.id
        WHERE o.project = ?
          AND o.importance >= 2
          AND o.lesson_learned IS NOT NULL
          AND o.lesson_learned != ''
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
          AND o.created_at_epoch > ?
          AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        ORDER BY o.created_at_epoch DESC
        LIMIT 2
      `,
        )
        .all('test', cutoff, 'schema.mjs', '%schema.mjs');

      expect(rows).toHaveLength(1);
      expect(rows[0].lesson_learned).toBe('Verify FTS5 integrity after schema changes');
      db.close();
    });

    it('matches both full path and basename via LIKE', () => {
      const db = createTestDb();
      insertSession(db, { id: 'sess-1' });

      insertObs(db, {
        sessionId: 'sess-1',
        title: 'Fix in utils',
        type: 'bugfix',
        importance: 2,
        lessonLearned: 'Check CJK boundary',
        filesModified: '["/mnt/data/projects/mem/utils.mjs"]',
      });

      const cutoff = Date.now() - 60 * 86400000;
      const rows = db
        .prepare(
          `
        SELECT DISTINCT o.id, o.type, o.title, o.lesson_learned
        FROM observations o
        JOIN observation_files of2 ON of2.obs_id = o.id
        WHERE o.project = ?
          AND o.importance >= 2
          AND o.lesson_learned IS NOT NULL
          AND o.lesson_learned != ''
          AND COALESCE(o.compressed_into, 0) = 0
          AND o.superseded_at IS NULL
          AND o.created_at_epoch > ?
          AND (of2.filename = ? OR of2.filename LIKE ? ESCAPE '\\')
        ORDER BY o.created_at_epoch DESC
        LIMIT 2
      `,
        )
        .all('test', cutoff, '/mnt/data/projects/mem/utils.mjs', '%utils.mjs');

      expect(rows).toHaveLength(1);
      expect(rows[0].lesson_learned).toBe('Check CJK boundary');
      db.close();
    });
  });

  describe('output format', () => {
    it('formats lessons correctly', () => {
      const lesson = 'Verify FTS5 integrity after schema changes';
      const output = `[mem] Lessons for schema.mjs:\n  #1 [bugfix] ${lesson}\n`;
      expect(output).toContain('[mem] Lessons for schema.mjs:');
      expect(output).toContain('#1 [bugfix]');
    });

    it('truncates long lessons at 240 chars', () => {
      const LESSON_MAX = 240;
      const longLesson = 'A'.repeat(400);
      const truncated =
        longLesson.length > LESSON_MAX ? longLesson.slice(0, LESSON_MAX - 3) + '...' : longLesson;
      expect(truncated).toHaveLength(LESSON_MAX);
      expect(truncated.endsWith('...')).toBe(true);
    });

    it('preserves lessons ≤ 240 chars untouched', () => {
      const LESSON_MAX = 240;
      const midLesson = 'B'.repeat(218); // matches observed p50 length
      const result = midLesson.length > LESSON_MAX ? midLesson.slice(0, LESSON_MAX - 3) + '...' : midLesson;
      expect(result).toBe(midLesson);
      expect(result.endsWith('...')).toBe(false);
    });
  });

  // R-4: when no lessons match, emit a short backfill reminder so Claude (a) knows the
  // system tried and (b) gets nudged to save a lesson after a non-obvious bug solve.
  // Enabled by CLAUDE_MEM_DB_PATH + CLAUDE_MEM_RUNTIME_DIR env overrides for test isolation.
  describe('backfill reminder (R-4)', () => {
    let tmpRoot;
    let dbPath;
    let runtimeDir;
    let projectDir;

    beforeEach(() => {
      tmpRoot = join(tmpdir(), `pre-recall-r4-${process.pid}-${Date.now()}`);
      mkdirSync(tmpRoot, { recursive: true });
      dbPath = join(tmpRoot, 'test.db');
      runtimeDir = join(tmpRoot, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      // CLAUDE_PROJECT_DIR must be two-segment so inferProject() returns a predictable name.
      // "parent--r4test" — matches what we insert into observations.project.
      projectDir = join(tmpRoot, 'parent', 'r4test');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-r4', project: 'parent--r4test', memoryId: 'mem-r4' });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function runWithEnv(input, extraEnv = {}) {
      return runScript(input, {
        CLAUDE_MEM_DB_PATH: dbPath,
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: projectDir,
        // The no-prior-lessons backfill reminder is opt-in (default off) since the
        // cross-project audit. These tests exercise that reminder + the cooldown
        // mechanism it doubles as a probe for, so enable it here.
        CLAUDE_MEM_PRETOOL_NUDGE: '1',
        ...extraEnv,
      });
    }

    it('does NOT emit the backfill reminder by default (opt-in only)', async () => {
      const { stdout } = await runWithEnv(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'no-nudge.py') },
        },
        { CLAUDE_MEM_PRETOOL_NUDGE: '' },
      );
      expect(stdout).toBe('');
    });

    it('emits backfill reminder when no lessons match for the file', async () => {
      // No observations for this file → no lessons to surface.
      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'credit_service.py') },
      });
      // Output is now JSON with hookSpecificOutput.additionalContext carrying the reminder.
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        '[mem] No prior lessons for credit_service.py',
      );
      // Should mention the /lesson command so Claude knows how to backfill.
      expect(parsed.hookSpecificOutput.additionalContext).toContain('/lesson');
    });

    it('still surfaces matching lessons when they exist (regression guard)', async () => {
      // Seed a lesson for the target file.
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-r4',
        project: 'parent--r4test',
        type: 'bugfix',
        importance: 2,
        title: 'FTS5 broke after schema change',
        lessonLearned: 'Verify FTS5 integrity after schema changes',
        filesModified: `["${join(projectDir, 'schema.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'schema.mjs') },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[mem] Lessons for schema.mjs:');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('Verify FTS5 integrity');
      // Reminder should NOT be emitted when a lesson was found.
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain('No prior lessons');
    });

    // Mirrors #7758 handoff-injection framing: without an explicit "system-injected,
    // continue your planned action" line, Edit+hook reminders have been observed to
    // end the assistant turn after lesson injection. The framing line is the signal
    // that the block is passive context, not a turn-closing note.
    it('prepends a "system-injected, continue" framing line when lessons are surfaced', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Parent session for the FK on observations.memory_session_id — the warm-start
      // reopen now correctly enforces ON DELETE CASCADE, so an orphan obs is rejected.
      insertSession(db, { id: 'sess-frame', project: 'parent--frametest', memoryId: 'mem-frame' });
      insertObs(db, {
        sessionId: 'mem-frame',
        project: 'parent--frametest',
        type: 'bugfix',
        importance: 2,
        title: 'Some lesson-bearing bug',
        lessonLearned: 'A lesson body used as framing probe',
        filesModified: `["${join(projectDir, 'frame.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'frame.mjs') },
      });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toMatch(/system-injected/);
      expect(ctx).toMatch(/continue/i);
    });

    it('prepends the same framing line when emitting the no-prior-lessons backfill reminder', async () => {
      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'pristine.py') },
      });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toMatch(/system-injected/);
      expect(ctx).toMatch(/continue/i);
      expect(ctx).toContain('[mem] No prior lessons');
    });

    it('honors cooldown — second call within window emits neither lesson nor reminder', async () => {
      const filePath = join(projectDir, 'cool.py');
      const { stdout: first } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
      });
      const parsedFirst = JSON.parse(first);
      expect(parsedFirst.hookSpecificOutput.additionalContext).toContain(
        '[mem] No prior lessons for cool.py',
      );

      const { stdout: second } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: filePath },
      });
      expect(second).toBe('');
    });

    // v2.33.1 Fix 4: session-scoped cooldown — same file in same session recalls
    // exactly once; different session gets fresh recall. Session id supplied via
    // event.session_id (standard Claude Code PreToolUse payload).
    it('v2.33.1: session-scoped cooldown — same session, same file: second call silent', async () => {
      const filePath = join(projectDir, 'scope.py');
      const { stdout: first } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-alpha',
        tool_input: { file_path: filePath },
      });
      expect(JSON.parse(first).hookSpecificOutput.additionalContext).toContain(
        'No prior lessons for scope.py',
      );

      const { stdout: second } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-alpha',
        tool_input: { file_path: filePath },
      });
      expect(second).toBe('');
    });

    it('v2.33.1: session-scoped cooldown — different session gets fresh recall', async () => {
      const filePath = join(projectDir, 'fresh.py');
      const { stdout: first } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-alpha',
        tool_input: { file_path: filePath },
      });
      expect(JSON.parse(first).hookSpecificOutput.additionalContext).toContain(
        'No prior lessons for fresh.py',
      );

      const { stdout: second } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-beta',
        tool_input: { file_path: filePath },
      });
      // Fresh session → recall fires again.
      expect(JSON.parse(second).hookSpecificOutput.additionalContext).toContain(
        'No prior lessons for fresh.py',
      );
    });

    // v2.34.6 Gap 3: Read-side recall. Tighter filter (lesson_learned required),
    // single-row limit, 120-char truncation, zero empty-nudge. Scope discipline:
    // planning Reads get surfaced; pure-exploration Reads cost near-zero tokens.
    it('v2.34.6 Read: surfaces top-1 lesson when file has lesson_learned', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Seed TWO lessons — Read should only inject the most recent one.
      insertObs(db, {
        sessionId: 'mem-r4',
        project: 'parent--r4test',
        type: 'bugfix',
        importance: 2,
        title: 'Older bug',
        lessonLearned: 'Older lesson A',
        filesModified: `["${join(projectDir, 'readable.mjs')}"]`,
        epochOffset: -86400000, // 1 day ago
      });
      insertObs(db, {
        sessionId: 'mem-r4',
        project: 'parent--r4test',
        type: 'bugfix',
        importance: 2,
        title: 'Newer bug',
        lessonLearned: 'Newer lesson B',
        filesModified: `["${join(projectDir, 'readable.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'readable.mjs') },
      });
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain('[mem] Lessons for readable.mjs:');
      expect(ctx).toContain('Newer lesson B');
      expect(ctx).not.toContain('Older lesson A');
    });

    it('v2.34.6 Read: suppresses type-only (bugfix/decision without lesson_learned)', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Edit-path would match this (type=bugfix). Read-path must skip it.
      insertObs(db, {
        sessionId: 'mem-r4',
        project: 'parent--r4test',
        type: 'bugfix',
        importance: 3,
        title: 'Important but no lesson',
        lessonLearned: null,
        filesModified: `["${join(projectDir, 'typed.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'typed.mjs') },
      });
      // Read-path finds zero lesson-bearing rows → silent exit (no nudge either).
      expect(stdout).toBe('');
    });

    it('v2.34.6 Read: silent on empty — no /lesson nudge (unlike Edit)', async () => {
      const { stdout } = await runWithEnv({
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'brand_new.mjs') },
      });
      expect(stdout).toBe('');
    });

    it('v2.34.6 Read: truncates long lessons at 120 chars (tighter than Edit 240)', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-r4',
        project: 'parent--r4test',
        type: 'bugfix',
        importance: 2,
        title: 'Long lesson',
        lessonLearned: 'X'.repeat(300),
        filesModified: `["${join(projectDir, 'longlesson.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Read',
        tool_input: { file_path: join(projectDir, 'longlesson.mjs') },
      });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      // Lesson line = "  #N [bugfix] " + up to 120 chars (with '...' if over).
      // Find the lesson line and verify the payload post-"[bugfix] " is ≤120 chars and ends in '...'.
      const line = ctx.split('\n').find((l) => l.includes('[bugfix]'));
      expect(line).toBeDefined();
      const payload = line.split('[bugfix] ')[1];
      expect(payload.length).toBeLessThanOrEqual(120);
      expect(payload.endsWith('...')).toBe(true);
    });

    it('Edit: LOW_SIGNAL title (bugfix/decision without lesson) is filtered out, falls back to nudge', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Real-world noise: hook-llm fallback title for an error episode. Type=bugfix, no lesson.
      // Pre-v2.34.7 this was surfaced to Edit as low-value context; now filtered out.
      insertObs(db, {
        sessionId: 'mem-r4',
        project: 'parent--r4test',
        type: 'bugfix',
        importance: 2,
        title: 'Error: foo.mjs, bar.mjs: 145|project|raw-log-noise',
        lessonLearned: null,
        filesModified: `["${join(projectDir, 'low_signal.mjs')}"]`,
      });
      // Also insert a "Modified X" fallback title — same class of noise.
      insertObs(db, {
        sessionId: 'mem-r4',
        project: 'parent--r4test',
        type: 'bugfix',
        importance: 2,
        title: 'Modified low_signal.mjs',
        lessonLearned: null,
        filesModified: `["${join(projectDir, 'low_signal.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-low-signal',
        tool_input: { file_path: join(projectDir, 'low_signal.mjs') },
      });
      // Both LOW_SIGNAL candidates filtered → no lessons block, only backfill nudge.
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).not.toContain('Error: foo.mjs');
      expect(ctx).not.toContain('Modified low_signal.mjs');
      expect(ctx).toContain('[mem] No prior lessons for low_signal.mjs');
    });

    it('Edit: non-LOW_SIGNAL bugfix title without lesson still surfaces (regression guard)', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Real human-written bugfix title, no lesson_learned — should still be surfaced
      // to Edit as contextual signal (Edit keeps the wider type-OR fallback).
      insertObs(db, {
        sessionId: 'mem-r4',
        project: 'parent--r4test',
        type: 'bugfix',
        importance: 2,
        title: 'hook-update SOURCE_FILES drift',
        lessonLearned: null,
        filesModified: `["${join(projectDir, 'real_bug.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-real-bug',
        tool_input: { file_path: join(projectDir, 'real_bug.mjs') },
      });
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain('[mem] Lessons for real_bug.mjs');
      expect(ctx).toContain('hook-update SOURCE_FILES drift');
    });

    it('v2.34.6 Read→Edit same file same session: Edit deduped by shared cooldown', async () => {
      const filePath = join(projectDir, 'shared.mjs');
      const { stdout: readOut } = await runWithEnv({
        tool_name: 'Read',
        session_id: 'session-gamma',
        tool_input: { file_path: filePath },
      });
      // Read on a lesson-less file: silent (no nudge, no lessons).
      expect(readOut).toBe('');

      const { stdout: editOut } = await runWithEnv({
        tool_name: 'Edit',
        session_id: 'session-gamma',
        tool_input: { file_path: filePath },
      });
      // Even though Edit would normally nudge for no-lesson files, the prior Read
      // already wrote the session cooldown entry → Edit is skipped.
      expect(editOut).toBe('');
    });
  });

  // T2 (v2.31): sdscc and some other CC variants drop plain-text stdout from PreToolUse;
  // only JSON with hookSpecificOutput.additionalContext reliably renders across variants.
  describe('JSON hookSpecificOutput (v2.31 T2)', () => {
    let tmpRoot;
    let dbPath;
    let runtimeDir;
    let projectDir;

    beforeEach(() => {
      tmpRoot = join(tmpdir(), `pre-recall-t2-${process.pid}-${Date.now()}`);
      mkdirSync(tmpRoot, { recursive: true });
      dbPath = join(tmpRoot, 'test.db');
      runtimeDir = join(tmpRoot, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      projectDir = join(tmpRoot, 'parent', 't2test');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-t2', project: 'parent--t2test', memoryId: 'mem-t2' });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function runWithEnv(input) {
      return runScript(input, {
        CLAUDE_MEM_DB_PATH: dbPath,
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: projectDir,
        // Backfill reminder is opt-in (default off) post-audit; these blocks test it.
        CLAUDE_MEM_PRETOOL_NUDGE: '1',
      });
    }

    it('emits JSON hookSpecificOutput on lesson hit', async () => {
      // Seed a lesson for the target file.
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-t2',
        project: 'parent--t2test',
        type: 'bugfix',
        importance: 2,
        title: 'Some bug',
        lessonLearned: 'Verify FTS5 integrity after schema changes',
        filesModified: `["${join(projectDir, 'hook-llm.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'hook-llm.mjs') },
      });
      expect(stdout.trim()).not.toBe('');
      const parsed = JSON.parse(stdout);
      expect(parsed.suppressOutput).toBe(true);
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[mem] Lessons for hook-llm.mjs:');
    });

    it('emits JSON hookSpecificOutput on backfill reminder (no hit)', async () => {
      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'brand_new.py') },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.suppressOutput).toBe(true);
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        '[mem] No prior lessons for brand_new.py',
      );
      expect(parsed.hookSpecificOutput.additionalContext).toContain('/lesson');
    });
  });

  // T9 (v2.31): pre-tool-recall must query BOTH observations and events,
  // since hook-llm now routes bugfix/lesson/decision/etc. to `events`.
  describe('events-table recall (v2.31 T9)', () => {
    let tmpRoot;
    let dbPath;
    let runtimeDir;
    let projectDir;

    beforeEach(() => {
      tmpRoot = join(tmpdir(), `pre-recall-t9-${process.pid}-${Date.now()}`);
      mkdirSync(tmpRoot, { recursive: true });
      dbPath = join(tmpRoot, 'test.db');
      runtimeDir = join(tmpRoot, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      projectDir = join(tmpRoot, 'parent', 't9test');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-t9', project: 'parent--t9test', memoryId: 'mem-t9' });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function runWithEnv(input) {
      return runScript(input, {
        CLAUDE_MEM_DB_PATH: dbPath,
        CLAUDE_MEM_RUNTIME_DIR: runtimeDir,
        CLAUDE_PROJECT_DIR: projectDir,
        // Backfill reminder is opt-in (default off) post-audit; these blocks test it.
        CLAUDE_MEM_PRETOOL_NUDGE: '1',
      });
    }

    it('surfaces events-table lessons via basename match', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(
        `
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'lesson', ?, ?, ?, 2, ?)
      `,
      ).run(
        'parent--t9test',
        'events-table lesson on foo',
        'remember to flush the cache before rotating keys',
        JSON.stringify(['foo.mjs']),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'foo.mjs') },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.suppressOutput).toBe(true);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[mem] Lessons for foo.mjs:');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[lesson]');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('flush the cache before rotating keys');
      // Regression guard: no backfill reminder when an event lesson was found.
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain('No prior lessons');
    });

    it('surfaces events-table lessons via full-path match', async () => {
      const fullPath = join(projectDir, 'bar.mjs');
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(
        `
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'bugfix', ?, ?, ?, 3, ?)
      `,
      ).run(
        'parent--t9test',
        'full-path bugfix',
        'null-check before dereferencing bar()',
        JSON.stringify([fullPath]),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: fullPath },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('[bugfix]');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('null-check before dereferencing bar()');
    });

    it('merges observations and events when both match the same file', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Legacy observations lesson
      insertObs(db, {
        sessionId: 'mem-t9',
        project: 'parent--t9test',
        type: 'bugfix',
        importance: 2,
        title: 'obs-era bugfix',
        lessonLearned: 'always await the promise before closing db',
        filesModified: `["${join(projectDir, 'mixed.mjs')}"]`,
      });
      // New event lesson
      db.prepare(
        `
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'lesson', ?, ?, ?, 2, ?)
      `,
      ).run(
        'parent--t9test',
        'event-era lesson',
        'check the feature flag in config before rollout',
        JSON.stringify(['mixed.mjs']),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'mixed.mjs') },
      });
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain('[mem] Lessons for mixed.mjs:');
      expect(ctx).toContain('always await the promise before closing db');
      expect(ctx).toContain('check the feature flag in config before rollout');
    });

    it('ignores events with importance < 2', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(
        `
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'lesson', ?, ?, ?, 1, ?)
      `,
      ).run(
        'parent--t9test',
        'low-importance lesson',
        'this should not surface',
        JSON.stringify(['lowimp.mjs']),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'lowimp.mjs') },
      });
      const parsed = JSON.parse(stdout);
      // No hit → backfill reminder should show.
      expect(parsed.hookSpecificOutput.additionalContext).toContain('No prior lessons for lowimp.mjs');
    });

    it('ignores superseded events', async () => {
      const db = new Database(dbPath);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(
        `
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch, superseded_at_epoch)
        VALUES (?, 'bugfix', ?, ?, ?, 3, ?, ?)
      `,
      ).run(
        'parent--t9test',
        'stale bugfix',
        'this was replaced — should not surface',
        JSON.stringify(['stale.mjs']),
        Date.now(),
        Date.now(),
      );
      db.close();

      const { stdout } = await runWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: join(projectDir, 'stale.mjs') },
      });
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain('No prior lessons for stale.mjs');
    });
  });

  // Regression: pre-tool-recall used to honor only CLAUDE_MEM_DB_PATH /
  // CLAUDE_MEM_RUNTIME_DIR, while schema.mjs / main CLI honor CLAUDE_MEM_DIR.
  // A user / test setting only CLAUDE_MEM_DIR for sandbox isolation got the
  // CLI redirected but cooldown writes still leaked to ~/.claude-mem-lite/runtime/.
  // The hook now derives both paths from CLAUDE_MEM_DIR by default; the
  // narrower per-component overrides remain for tests that need to mix.
  describe('CLAUDE_MEM_DIR alignment with main CLI', () => {
    let tmpRoot;
    let projectDir;

    beforeEach(() => {
      tmpRoot = join(tmpdir(), `pre-recall-memdir-${process.pid}-${Date.now()}`);
      mkdirSync(tmpRoot, { recursive: true });
      projectDir = join(tmpRoot, 'parent', 'memdirtest');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-memdir', project: 'parent--memdirtest', memoryId: 'mem-memdir' });
      insertObs(db, {
        sessionId: 'mem-memdir',
        project: 'parent--memdirtest',
        type: 'bugfix',
        importance: 2,
        title: 'memdir alignment lesson',
        lessonLearned: 'A specific lesson visible only when DB is correctly sandboxed',
        filesModified: `["${join(projectDir, 'target.mjs')}"]`,
      });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    it('CLAUDE_MEM_DIR alone redirects DB read', async () => {
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'target.mjs') },
          session_id: 'sess-memdir-1',
        },
        {
          CLAUDE_MEM_DIR: tmpRoot,
          CLAUDE_PROJECT_DIR: projectDir,
        },
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        'A specific lesson visible only when DB is correctly sandboxed',
      );
    });

    it('CLAUDE_MEM_DIR alone redirects cooldown writes (no leak to ~/.claude-mem-lite/runtime)', async () => {
      // First call seeds cooldown; second call should be silent.
      await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'target.mjs') },
          session_id: 'sess-memdir-2',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const { existsSync } = await import('fs');
      expect(existsSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-sess-memdir-2.json'))).toBe(true);

      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'target.mjs') },
          session_id: 'sess-memdir-2',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );
      expect(stdout).toBe('');
    });

    it('CLAUDE_MEM_DB_PATH still overrides when set (per-component override preserved)', async () => {
      const altDb = join(tmpRoot, 'alt.db');
      const db = new Database(altDb);
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-alt', project: 'parent--memdirtest', memoryId: 'mem-alt' });
      insertObs(db, {
        sessionId: 'mem-alt',
        project: 'parent--memdirtest',
        type: 'bugfix',
        importance: 2,
        title: 'override marker',
        lessonLearned: 'Sourced from CLAUDE_MEM_DB_PATH override, not CLAUDE_MEM_DIR default',
        filesModified: `["${join(projectDir, 'target.mjs')}"]`,
      });
      db.close();

      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'target.mjs') },
          session_id: 'sess-memdir-3',
        },
        {
          CLAUDE_MEM_DIR: tmpRoot,
          CLAUDE_MEM_DB_PATH: altDb,
          CLAUDE_PROJECT_DIR: projectDir,
        },
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        'Sourced from CLAUDE_MEM_DB_PATH override',
      );
      expect(parsed.hookSpecificOutput.additionalContext).not.toContain(
        'A specific lesson visible only when DB is correctly sandboxed',
      );
    });

    it('resolves the project from PWD (not cwd) when CLAUDE_PROJECT_DIR is unset — save-path parity', async () => {
      // Round 6: the save path (utils.mjs::inferProject) and the bash fast-path resolve the
      // project from process.env.PWD; recall MUST match or it queries a different project.
      // Here CLAUDE_PROJECT_DIR='' disables the primary and the child's cwd is the repo root
      // (≠ projectDir), so the seeded "parent--memdirtest" lesson surfaces ONLY if inferProject
      // honors the PWD fallback. Pre-fix (cwd-only) this recalled nothing.
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'target.mjs') },
          session_id: 'sess-memdir-pwd',
        },
        {
          CLAUDE_MEM_DIR: tmpRoot,
          CLAUDE_PROJECT_DIR: '',
          PWD: projectDir,
        },
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.additionalContext).toContain(
        'A specific lesson visible only when DB is correctly sandboxed',
      );
    });
  });

  // v2.81: cooldown entries record the lesson IDs that were emitted, so the
  // PostToolUse cite-back hint (lib/cite-back-hint.mjs) can name them when the
  // user actually edits the file. Reads must tolerate both the new
  // object-schema and the legacy number-schema written by older versions.
  describe('cooldown lessonIds (v2.81 cite-back support)', () => {
    let tmpRoot;
    let projectDir;
    let lessonObsId;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-citeback-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'citeback');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-cb', project: 'parent--citeback', memoryId: 'mem-cb' });
      const info = insertObs(db, {
        sessionId: 'mem-cb',
        project: 'parent--citeback',
        type: 'bugfix',
        importance: 2,
        title: 'cite-back lesson',
        lessonLearned: 'A lesson that should be cited back',
        filesModified: `["${join(projectDir, 'foo.mjs')}"]`,
      });
      lessonObsId = info?.lastInsertRowid ?? info; // helper return shape varies
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    it('writes {ts, lessonIds} object schema when lessons are emitted', async () => {
      await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'foo.mjs') },
          session_id: 'sess-cb-1',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const cooldown = JSON.parse(
        readFileSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-sess-cb-1.json'), 'utf8'),
      );
      const entry = cooldown[join(projectDir, 'foo.mjs')];
      expect(entry).toBeTypeOf('object');
      expect(typeof entry.ts).toBe('number');
      expect(Array.isArray(entry.lessonIds)).toBe(true);
      expect(entry.lessonIds.length).toBeGreaterThan(0);
      expect(entry.lessonIds).toContain(Number(lessonObsId));
    });

    it('writes {ts, lessonIds: []} when no lessons were emitted (empty Edit)', async () => {
      await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'no-lessons.mjs') },
          session_id: 'sess-cb-2',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const cooldown = JSON.parse(
        readFileSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-sess-cb-2.json'), 'utf8'),
      );
      const entry = cooldown[join(projectDir, 'no-lessons.mjs')];
      expect(entry).toBeTypeOf('object');
      expect(entry.lessonIds).toEqual([]);
    });

    // P1 (D#78): edge attribution needs to know which cooldown ids are
    // OBSERVATION ids — events share the same numeric id space, and an event id
    // fed into observation_files edge updates could hit an unrelated obs edge.
    it('writes obsIds with observation-sourced ids only (events excluded)', async () => {
      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(
        `
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'lesson', ?, ?, ?, 2, ?)
      `,
      ).run(
        'parent--citeback',
        'event lesson on foo',
        'event body lesson',
        JSON.stringify(['foo.mjs']),
        Date.now(),
      );
      db.close();

      await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'foo.mjs') },
          session_id: 'sess-cb-obsids',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const cooldown = JSON.parse(
        readFileSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-sess-cb-obsids.json'), 'utf8'),
      );
      const entry = cooldown[join(projectDir, 'foo.mjs')];
      // lessonIds keeps the mixed set (cite-back hint contract, unchanged) …
      expect(entry.lessonIds.length).toBeGreaterThanOrEqual(2);
      // … obsIds carries only the observations-sourced id.
      expect(entry.obsIds).toEqual([Number(lessonObsId)]);
    });

    it('honors legacy number-schema cooldown on read path (back-compat)', async () => {
      // Seed the cooldown file with legacy `<path>: <number>` schema.
      mkdirSync(join(tmpRoot, 'runtime'), { recursive: true });
      const cooldownPath = join(tmpRoot, 'runtime', 'pre-recall-cooldown-sess-cb-legacy.json');
      const targetFile = join(projectDir, 'foo.mjs');
      writeFileSync(cooldownPath, JSON.stringify({ [targetFile]: Date.now() }));

      // Re-running Edit on the same file should be silent (already cooled down
      // in this session) even though the entry is a bare number.
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: targetFile },
          session_id: 'sess-cb-legacy',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );
      expect(stdout).toBe('');
    });
  });

  // ─── A1.5 (v2.83.2): cite_factor in pre-tool-recall tie-break ────────────
  // When multiple lessons match the same file, prefer the one with proven
  // cite history over the merely-most-recent one. Single-match files are
  // unaffected (obsLimit=1 for Read, 2 for Edit).
  describe('cite_factor tie-break across multiple file-matching lessons (A1.5)', () => {
    let tmpRoot;
    let projectDir;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-a15-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'a15test');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(tmpRoot, 'runtime'), { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-a15', project: 'parent--a15test', memoryId: 'mem-a15' });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    it('Edit: prefers the heavily-cited older lesson over the never-cited newer one', async () => {
      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Older (60d ago) but cited 5 times — proven helpful.
      insertObs(db, {
        sessionId: 'mem-a15',
        project: 'parent--a15test',
        type: 'bugfix',
        importance: 2,
        title: 'OLD-CITED lesson',
        lessonLearned: 'this body was cited five times across sessions',
        filesModified: `["${join(projectDir, 'shared.mjs')}"]`,
        epochOffset: -50 * 86400000,
        citedCount: 5,
      });
      // Newer (today) but never cited.
      insertObs(db, {
        sessionId: 'mem-a15',
        project: 'parent--a15test',
        type: 'bugfix',
        importance: 2,
        title: 'NEW-FRESH lesson',
        lessonLearned: 'fresh body never cited',
        filesModified: `["${join(projectDir, 'shared.mjs')}"]`,
        epochOffset: 0,
        citedCount: 0,
      });
      db.close();

      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a15-1',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      // Edit caps at 2 rows total — both surface, but the cited one MUST come first.
      const oldIdx = ctx.indexOf('cited five times');
      const newIdx = ctx.indexOf('fresh body never cited');
      expect(oldIdx).toBeGreaterThanOrEqual(0);
      expect(newIdx).toBeGreaterThanOrEqual(0);
      expect(oldIdx).toBeLessThan(newIdx);
    });

    it('Read (obsLimit=1): surfaces the cited lesson, drops the never-cited fresh one', async () => {
      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-a15',
        project: 'parent--a15test',
        type: 'bugfix',
        importance: 2,
        title: 'OLD-CITED lesson',
        lessonLearned: 'this body was cited five times across sessions',
        filesModified: `["${join(projectDir, 'shared.mjs')}"]`,
        epochOffset: -50 * 86400000,
        citedCount: 5,
      });
      insertObs(db, {
        sessionId: 'mem-a15',
        project: 'parent--a15test',
        type: 'bugfix',
        importance: 2,
        title: 'NEW-FRESH lesson',
        lessonLearned: 'fresh body never cited',
        filesModified: `["${join(projectDir, 'shared.mjs')}"]`,
        epochOffset: 0,
        citedCount: 0,
      });
      db.close();

      const { stdout } = await runScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a15-2',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('cited five times');
      expect(ctx).not.toContain('fresh body never cited');
    });

    it('Edit: demotes the uncited-streak lesson below the fresh one', async () => {
      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      // Newer but accumulating uncited streak — agent has been declining it.
      insertObs(db, {
        sessionId: 'mem-a15',
        project: 'parent--a15test',
        type: 'bugfix',
        importance: 2,
        title: 'STREAKED lesson',
        lessonLearned: 'body with streak of 2 uncited sessions',
        filesModified: `["${join(projectDir, 'shared.mjs')}"]`,
        epochOffset: 0,
        uncitedStreak: 2,
      });
      // Older and neutral (cited=0, streak=0).
      insertObs(db, {
        sessionId: 'mem-a15',
        project: 'parent--a15test',
        type: 'bugfix',
        importance: 2,
        title: 'NEUTRAL lesson',
        lessonLearned: 'older body neutral state',
        filesModified: `["${join(projectDir, 'shared.mjs')}"]`,
        epochOffset: -3 * 86400000,
      });
      db.close();

      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a15-3',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      const neutralIdx = ctx.indexOf('older body neutral state');
      const streakedIdx = ctx.indexOf('body with streak of 2');
      expect(neutralIdx).toBeGreaterThanOrEqual(0);
      expect(streakedIdx).toBeGreaterThanOrEqual(0);
      expect(neutralIdx).toBeLessThan(streakedIdx);
    });
  });

  // ─── Salience forcing-function (v2.98) ─────────────────────────────────────
  // Efficacy severe test #8651: verified on-topic injection moved bug-reintroduction
  // only 100%→50% — the agent SEES the lesson and ignores it half the time. The
  // bottleneck is ACTING, not retrieval. Two changes raise salience at the action
  // point: (1) Edit/Write lesson blocks end with an explicit ack directive
  // ('#NN applied' / '#NN n/a — <reason>'); (2) Read→Edit on the same file no
  // longer goes fully silent — the Edit emits a compact ack nudge naming the IDs
  // shown at Read time (the old behavior injected only at Read, the most passive
  // point, and NOTHING at the actual edit). CLAUDE_MEM_SALIENCE=legacy opts out.
  describe('salience forcing-function (v2.98)', () => {
    let tmpRoot;
    let projectDir;
    let lessonObsId;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-salience-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'saltest');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-sal', project: 'parent--saltest', memoryId: 'mem-sal' });
      const info = insertObs(db, {
        sessionId: 'mem-sal',
        project: 'parent--saltest',
        type: 'bugfix',
        importance: 2,
        title: 'salience probe bug',
        lessonLearned: 'recover orphaned children before hard-deleting a keeper',
        filesModified: `["${join(projectDir, 'maintain.mjs')}"]`,
      });
      lessonObsId = Number(info?.lastInsertRowid ?? info);
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    const envFor = (extra = {}) => ({
      CLAUDE_MEM_DIR: tmpRoot,
      CLAUDE_PROJECT_DIR: projectDir,
      ...extra,
    });

    it('Edit: lesson block ends with the ack directive line', async () => {
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'maintain.mjs') },
          session_id: 'sess-sal-1',
        },
        envFor(),
      );
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('[mem] Lessons for maintain.mjs:');
      expect(ctx).toContain("'#NN applied'");
      expect(ctx).toContain("'#NN n/a — <reason>'");
    });

    it('Edit: CLAUDE_MEM_SALIENCE=legacy restores the passive block (no directive)', async () => {
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'maintain.mjs') },
          session_id: 'sess-sal-2',
        },
        envFor({ CLAUDE_MEM_SALIENCE: 'legacy' }),
      );
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('[mem] Lessons for maintain.mjs:');
      expect(ctx).not.toContain("'#NN applied'");
    });

    it('Read: stays passive — no ack directive on the quiet 1-lesson injection', async () => {
      const { stdout } = await runScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: join(projectDir, 'maintain.mjs') },
          session_id: 'sess-sal-3',
        },
        envFor(),
      );
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('[mem] Lessons for maintain.mjs:');
      expect(ctx).not.toContain("'#NN applied'");
    });

    it('Read→Edit same session: Edit emits a compact ack nudge naming the Read-time IDs', async () => {
      const filePath = join(projectDir, 'maintain.mjs');
      await runScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: 'sess-sal-4',
        },
        envFor(),
      );

      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: filePath },
          session_id: 'sess-sal-4',
        },
        envFor(),
      );
      const parsed = JSON.parse(stdout);
      const ctx = parsed.hookSpecificOutput.additionalContext;
      expect(ctx).toContain(`#${lessonObsId}`);
      expect(ctx).toContain("'#NN applied'");
      // Compact nudge — must NOT re-emit the lesson body (token cost stays one line).
      expect(ctx).not.toContain('recover orphaned children');
      // #7758 framing guard: still announces itself as system-injected continuation.
      expect(ctx).toMatch(/system-injected/);
    });

    it('Read→Edit→Edit: the ack nudge fires once — second Edit is silent', async () => {
      const filePath = join(projectDir, 'maintain.mjs');
      const session = 'sess-sal-5';
      await runScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: session,
        },
        envFor(),
      );
      await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: filePath },
          session_id: session,
        },
        envFor(),
      );
      const { stdout: third } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: filePath },
          session_id: session,
        },
        envFor(),
      );
      expect(third).toBe('');
    });

    it('Read→Edit on a file with NO lessons stays silent (no spurious ack nudge)', async () => {
      const filePath = join(projectDir, 'lessonless.mjs');
      const session = 'sess-sal-6';
      await runScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: session,
        },
        envFor(),
      );
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: filePath },
          session_id: session,
        },
        envFor(),
      );
      expect(stdout).toBe('');
    });

    it('Read→Edit ack nudge suppressed under CLAUDE_MEM_SALIENCE=legacy (old full-dedup)', async () => {
      const filePath = join(projectDir, 'maintain.mjs');
      const session = 'sess-sal-7';
      await runScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: session,
        },
        envFor({ CLAUDE_MEM_SALIENCE: 'legacy' }),
      );
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: filePath },
          session_id: session,
        },
        envFor({ CLAUDE_MEM_SALIENCE: 'legacy' }),
      );
      expect(stdout).toBe('');
    });

    it('cooldown entry records the injection mode (read vs edit)', async () => {
      const readFile = join(projectDir, 'maintain.mjs');
      await runScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: readFile },
          session_id: 'sess-sal-8',
        },
        envFor(),
      );
      const cooldown = JSON.parse(
        readFileSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-sess-sal-8.json'), 'utf8'),
      );
      expect(cooldown[readFile].mode).toBe('read');

      const editFile = join(projectDir, 'fresh-edit.mjs');
      await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: editFile },
          session_id: 'sess-sal-9',
        },
        envFor(),
      );
      const cooldown2 = JSON.parse(
        readFileSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-sess-sal-9.json'), 'utf8'),
      );
      expect(cooldown2[editFile].mode).toBe('edit');
    });

    it('legacy cooldown entry without mode field: Edit stays silent (back-compat)', async () => {
      // Pre-v2.98 entries have {ts, lessonIds} but no mode — we can't tell Read
      // from Edit, so the safe interpretation is "already handled" (silent).
      mkdirSync(join(tmpRoot, 'runtime'), { recursive: true });
      const filePath = join(projectDir, 'maintain.mjs');
      writeFileSync(
        join(tmpRoot, 'runtime', 'pre-recall-cooldown-sess-sal-legacy.json'),
        JSON.stringify({ [filePath]: { ts: Date.now(), lessonIds: [lessonObsId] } }),
      );
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: filePath },
          session_id: 'sess-sal-legacy',
        },
        envFor(),
      );
      expect(stdout).toBe('');
    });
  });

  // ─── A3 (v2.83): cross-hook ID dedup ──────────────────────────────────────
  // UPS writes `INJECTED_IDS_FILE` at `<DB_DIR>/runtime/.claude-mem-injected-<project>`
  // with `{ids, ts, count}`. Pre-tool-recall reads it; if a lesson row was
  // already injected by UPS within the DEDUP_STALE_MS window, drop it from
  // PreToolUse output (the agent already has the citation in context).
  describe('cross-hook ID dedup with UPS (A3)', () => {
    let tmpRoot;
    let projectDir;
    let lessonObsId;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-a3-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'a3test');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(tmpRoot, 'runtime'), { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-a3', project: 'parent--a3test', memoryId: 'mem-a3' });
      const info = insertObs(db, {
        sessionId: 'mem-a3',
        project: 'parent--a3test',
        type: 'bugfix',
        importance: 2,
        title: 'lesson that UPS already showed',
        lessonLearned: 'Body the agent already has from prompt-time inject',
        filesModified: `["${join(projectDir, 'shared.mjs')}"]`,
      });
      lessonObsId = Number(info?.lastInsertRowid ?? info);
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function seedUpsInjected(ids, sessionId, ageMs = 0) {
      // Path mirrors user-prompt-search.js injectedIdsFileFor construction —
      // D#120: session-keyed file name, so the seed must carry the same session
      // id the script receives on stdin or the read side derives another path.
      const file = join(tmpRoot, 'runtime', `.claude-mem-injected-parent--a3test-${sessionId}`);
      writeFileSync(
        file,
        JSON.stringify({ ids: ids.map(String), ts: Date.now() - ageMs, count: 1, session: sessionId }),
      );
      return file;
    }

    it('drops a lesson row whose ID was just injected by UPS', async () => {
      seedUpsInjected([lessonObsId], 'sess-a3-1');
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a3-1',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      // Lesson dropped → either empty stdout (no other rows) or the no-prior
      // backfill reminder fires. Either way, `#<lessonObsId>` must not appear.
      if (stdout) {
        const parsed = JSON.parse(stdout);
        const ctx = parsed.hookSpecificOutput?.additionalContext || '';
        expect(ctx).not.toContain(`#${lessonObsId}`);
      }
    });

    it('keeps the lesson when UPS state is older than DEDUP_STALE_MS', async () => {
      // 10 minutes old — stale, should be ignored. Lesson should surface.
      seedUpsInjected([lessonObsId], 'sess-a3-2', 10 * 60_000);
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a3-2',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain(`#${lessonObsId}`);
    });

    it('keeps the lesson when UPS state file is absent', async () => {
      // No UPS file at all — pre-tool-recall must not crash and must emit normally.
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a3-3',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain(`#${lessonObsId}`);
    });

    it('records emitted IDs back so subsequent UPS reads see them', async () => {
      // Simulates PreToolUse emitting → UPS next prompt — UPS dedup logic at
      // 80%-overlap rule should see this id in the file. We assert presence.
      await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a3-4',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const file = join(tmpRoot, 'runtime', `.claude-mem-injected-parent--a3test-sess-a3-4`);
      const state = JSON.parse(readFileSync(file, 'utf8'));
      const idStrings = (state.ids || []).map(String);
      expect(idStrings).toContain(String(lessonObsId));
    });
  });

  // ─── D#188: the seen-set is a UNION across TABLES, and `events` shares the numeric
  // id space with `observations` (90.1% of observation ids also exist as an event id
  // on the live store, 2026-09-01). The dedup predicate compared bare numbers while
  // the rows it filtered already carried a `src` tag added for exactly this reason —
  // the comment three lines above it says "events share the numeric id space with
  // observations" in as many words. So a UPS-injected observation #42 silently made
  // event #42 unreachable for the 5-minute window, and vice versa.
  //
  // The fixture forces the collision (same id in both tables) and puts the two rows on
  // DIFFERENT files, so only the event can match the path under test — the bare-number
  // predicate is then the only thing that can suppress it.
  describe('cross-hook dedup respects the id NAMESPACE (D#188)', () => {
    let tmpRoot;
    let projectDir;
    let collidingId;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-d188-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'd188');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(tmpRoot, 'runtime'), { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-d188', project: 'parent--d188', memoryId: 'mem-d188' });
      // The observation lives on obs-only.mjs and is never a candidate for the path
      // under test — its ONLY role is to be the id UPS reports as already injected.
      const info = insertObs(db, {
        sessionId: 'mem-d188',
        project: 'parent--d188',
        type: 'bugfix',
        importance: 2,
        title: 'observation on a different file',
        lessonLearned: 'OBSERVATION-BODY-MARKER',
        filesModified: `["${join(projectDir, 'obs-only.mjs')}"]`,
      });
      collidingId = Number(info?.lastInsertRowid ?? info);
      // Same numeric id, other table, on the file the run below touches.
      db.prepare(
        `
        INSERT INTO events (id, project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'parent--d188', 'lesson', 'event that shares the number', 'EVENT-BODY-MARKER', ?, 2, ?)
      `,
      ).run(collidingId, JSON.stringify([join(projectDir, 'evt-only.mjs')]), Date.now());
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function seedSeen(ids, sessionId) {
      writeFileSync(
        join(tmpRoot, 'runtime', `.claude-mem-injected-parent--d188-${sessionId}`),
        JSON.stringify({ ids: ids.map(String), ts: Date.now(), count: 1, session: sessionId }),
      );
    }

    async function runOnEventFile(sessionId) {
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'evt-only.mjs') },
          session_id: sessionId,
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );
      if (!stdout) return '';
      return JSON.parse(stdout).hookSpecificOutput?.additionalContext || '';
    }

    it('an injected OBSERVATION id no longer blocks the event that shares its number', async () => {
      seedSeen([collidingId], 'sess-d188-1');
      expect(await runOnEventFile('sess-d188-1')).toContain('EVENT-BODY-MARKER');
    });

    it('but the namespaced EVENT key still dedups the event — the fix is not "stop deduping"', async () => {
      // Anti-tautology for the case above: dropping the events arm from the dedup
      // entirely would pass it. This is the arm that pins the key, not its absence.
      seedSeen([`E${collidingId}`], 'sess-d188-2');
      expect(await runOnEventFile('sess-d188-2')).not.toContain('EVENT-BODY-MARKER');
    });

    it('the face writes the event back under its namespaced key, not as a bare number', async () => {
      // Otherwise the collision returns on the next prompt from the other direction:
      // a bare event id in this file blocks the same-numbered observation on the next
      // UPS prompt. (It also reaches hook.mjs's pathAInjectedIds, but suppresses
      // nothing there — every id in this file is a string and that consumer compares
      // against a numeric row id. That inertness is D#193, not this test's subject.)
      await runOnEventFile('sess-d188-3');
      const state = JSON.parse(
        readFileSync(join(tmpRoot, 'runtime', '.claude-mem-injected-parent--d188-sess-d188-3'), 'utf8'),
      );
      const written = (state.ids || []).map(String);
      expect(written).toContain(`E${collidingId}`);
      expect(written).not.toContain(String(collidingId));
    });
  });

  // ─── D#172 class (audit 2026-08-29 ALGO-4): the cross-hook dedup ran DOWNSTREAM
  // of the SQL LIMIT, so a deduped row left its slot EMPTY instead of yielding it to
  // the next candidate — "dedup" implemented as "shrink". Own fixture rather than the
  // A3 block above, because it needs more rows than the cap and the A3 assertions are
  // written against a single-row corpus.
  describe('cross-hook dedup is a re-rank, not a truncation (ALGO-4)', () => {
    let tmpRoot;
    let projectDir;
    let ids;
    let eventIds;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-algo4-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'algo4');
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(join(tmpRoot, 'runtime'), { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-a4', project: 'parent--algo4', memoryId: 'mem-a4' });
      const target = join(projectDir, 'shared.mjs');
      // Four lesson rows on one file. The query sorts lesson-first, then cite_factor
      // DESC — so cited_count pins a deterministic rank order without relying on
      // insertion timing (created_at is only the tertiary key and can tie at ms
      // resolution). Ranks: A(3) > B(2) > C(1) > D(0).
      ids = [3, 2, 1, 0].map((cited, i) => {
        const info = insertObs(db, {
          sessionId: 'mem-a4',
          project: 'parent--algo4',
          type: 'bugfix',
          importance: 2,
          title: `algo4 lesson rank ${i}`,
          lessonLearned: `Lesson body number ${i} for the about-to-edit agent`,
          filesModified: `["${target}"]`,
        });
        const id = Number(info?.lastInsertRowid ?? info);
        db.prepare('UPDATE observations SET cited_count = ? WHERE id = ?').run(cited, id);
        return id;
      });
      // Four EVENTS rows on a DIFFERENT file, so the events arm can be exercised in
      // isolation (the observations query returns nothing for this path and the merge
      // is events-only). All carry a body, so the events ORDER BY reduces to
      // `created_at_epoch DESC` — rank is pinned by the timestamps, not by insert order.
      const evtFile = join(projectDir, 'events-only.mjs');
      const now = Date.now();
      eventIds = [0, 1, 2, 3].map((k) => {
        const info = db
          .prepare(
            `
          INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
          VALUES (?, 'lesson', ?, ?, ?, 2, ?)
        `,
          )
          .run(
            'parent--algo4',
            `algo4 event rank ${k}`,
            `Event body number ${k} for the about-to-edit agent`,
            JSON.stringify([evtFile]),
            now - k * 60_000,
          );
        return Number(info.lastInsertRowid);
      });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    it('still fills the slot when UPS already injected every row the old LIMIT could reach', async () => {
      // Edit path: obsLimit was a flat 2, so seeding the top TWO ranks emptied the
      // whole obs source. With the dedup slack the SELECT reaches rank 3, and the
      // face keeps emitting.
      // VERIFIED RED: reverting `obsLimit` to `(isRead ? 1 : 2)` makes this assertion
      // fail — stdout carries no `#<id>` for any of the four rows (measured
      // 2026-09-01, same fixture).
      const file = join(tmpRoot, 'runtime', '.claude-mem-injected-parent--algo4-sess-a4-1');
      writeFileSync(
        file,
        JSON.stringify({
          ids: [ids[0], ids[1]].map(String),
          ts: Date.now(),
          count: 2,
          session: 'sess-a4-1',
        }),
      );

      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a4-1',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      // Assert the emptiness FIRST and by name: the pre-fix behaviour is that the
      // face emits nothing at all, and letting JSON.parse throw on '' reports that as
      // "Unexpected end of JSON input" — a parse error where the defect is a silenced
      // injection surface.
      expect(stdout, 'obs source was truncated to nothing by the dedup').not.toBe('');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      // The two deduped ids must stay out — the slack must not defeat the dedup.
      expect(ctx).not.toContain(`#${ids[0]}`);
      expect(ctx).not.toContain(`#${ids[1]}`);
      // ...and the next-ranked row must take the freed slot.
      expect(ctx).toContain(`#${ids[2]}`);
    });

    it('emits the top rank unchanged when nothing was deduped (slack is not a widening)', async () => {
      // Negative control: with no UPS state the seen-set is empty, dedupSlack is 0,
      // and the LIMITs are exactly what they were before ALGO-4. Without this case a
      // slack that ALWAYS over-fetched would pass the test above while quietly
      // inflating the PreToolUse injection budget.
      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a4-2',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain(`#${ids[0]}`);
      // mergeCap for Edit is 3, and only 2 obs rows were ever fetched pre-ALGO-4;
      // rank 4 must not appear however wide the pool got.
      expect(ctx).not.toContain(`#${ids[3]}`);
    });

    it('fills the slot on the READ path, where one dedup hit used to silence the face', async () => {
      // The pre-tag review's S-3: the release text leads with the Read case (`obsLimit`
      // 1, `mergeCap` 1, so ONE dedup hit empties the whole face) while both cases above
      // drive Edit. Testing the arm the headline is about, not the neighbouring one.
      // VERIFIED RED: reverting `obsLimit` to `(isRead ? 1 : 2)` empties stdout.
      const file = join(tmpRoot, 'runtime', '.claude-mem-injected-parent--algo4-sess-a4-4');
      writeFileSync(
        file,
        JSON.stringify({
          ids: [ids[0]].map(String),
          ts: Date.now(),
          count: 1,
          session: 'sess-a4-4',
        }),
      );

      const { stdout } = await runScript(
        {
          tool_name: 'Read',
          tool_input: { file_path: join(projectDir, 'shared.mjs') },
          session_id: 'sess-a4-4',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      expect(stdout, 'Read path silenced: obsLimit 1 minus one dedup hit left zero rows').not.toBe('');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).not.toContain(`#${ids[0]}`);
      expect(ctx).toContain(`#${ids[1]}`);
      // mergeCap is 1 on Read — the slack must not turn a one-row face into a two-row one.
      expect(ctx).not.toContain(`#${ids[2]}`);
    });

    it('applies the same slack to the EVENTS arm', async () => {
      // The pre-tag review found the case above does NOT cover `eventsLimit`: the
      // fixture seeded only observations, so reverting the events slack stayed green
      // across the whole suite. The events arm has the identical defect — its LIMIT is
      // also upstream of the same JS dedup — and on a Read (`eventsLimit` 1) one dedup
      // hit silences it outright. Driven through a file that has NO observation rows,
      // so the merge is events-only and the assertion cannot be satisfied by the obs arm.
      // VERIFIED RED: reverting `eventsLimit` to `(isRead ? 1 : 2)` empties stdout.
      // D#188: an event is recorded in the seen-set under its namespaced `E<id>` key.
      // Seeding bare numbers here would no longer suppress anything — and note this
      // fixture's obs and event ids genuinely collide (both tables auto-number from 1),
      // which is exactly the machine-wide condition D#188 measured at 90.1%.
      const file = join(tmpRoot, 'runtime', '.claude-mem-injected-parent--algo4-sess-a4-3');
      writeFileSync(
        file,
        JSON.stringify({
          ids: [eventIds[0], eventIds[1]].map((id) => `E${id}`),
          ts: Date.now(),
          count: 2,
          session: 'sess-a4-3',
        }),
      );

      const { stdout } = await runScript(
        {
          tool_name: 'Edit',
          tool_input: { file_path: join(projectDir, 'events-only.mjs') },
          session_id: 'sess-a4-3',
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );

      expect(stdout, 'events source was truncated to nothing by the dedup').not.toBe('');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).not.toContain(`#${eventIds[0]}`);
      expect(ctx).not.toContain(`#${eventIds[1]}`);
      expect(ctx).toContain(`#${eventIds[2]}`);
    });
  });

  // ─── P2 (D#78): edge-level decay enforcement ───────────────────────────────
  // A (lesson,file) edge whose miss_streak reached K consecutive uncited
  // injections stops firing — the lesson body stays alive for every other
  // surface (search / UPS / error-recall). Enforcement is OPT-IN via
  // CLAUDE_MEM_EDGE_DECAY=1 (shadow-first discipline: P1 counting is always on,
  // the filter flips only after real-DB cite-rate evidence).
  describe('edge-level decay enforcement (P2 D#78)', () => {
    let tmpRoot;
    let projectDir;
    let obsId;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-p2-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'p2test');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-p2', project: 'parent--p2test', memoryId: 'mem-p2' });
      const r = insertObs(db, {
        sessionId: 'mem-p2',
        project: 'parent--p2test',
        type: 'bugfix',
        importance: 2,
        title: 'decayable edge lesson',
        lessonLearned: 'lesson behind a decaying edge',
        filesModified: '["edgy.mjs"]',
      });
      obsId = Number(r.lastInsertRowid);
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function setStreak(streak) {
      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.prepare('UPDATE observation_files SET miss_streak = ? WHERE obs_id = ?').run(streak, obsId);
      db.close();
    }

    function editFile(session, env = {}) {
      return runScript(
        {
          tool_name: 'Edit',
          session_id: session,
          tool_input: { file_path: join(projectDir, 'edgy.mjs') },
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir, ...env },
      );
    }

    it('flag ON: an edge at the default threshold (3 misses) stops firing', async () => {
      setStreak(3);
      const { stdout } = await editFile('sess-p2-off', { CLAUDE_MEM_EDGE_DECAY: '1' });
      if (stdout) {
        const ctx = JSON.parse(stdout).hookSpecificOutput?.additionalContext || '';
        expect(ctx).not.toContain('lesson behind a decaying edge');
      }
    });

    it('flag ON: an edge below the threshold still fires', async () => {
      setStreak(2);
      const { stdout } = await editFile('sess-p2-under', { CLAUDE_MEM_EDGE_DECAY: '1' });
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('lesson behind a decaying edge');
    });

    it('flag OFF (default): a decayed edge still fires — shadow mode counts only', async () => {
      setStreak(99);
      const { stdout } = await editFile('sess-p2-shadow');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('lesson behind a decaying edge');
    });

    it('flag ON: threshold is tunable via CLAUDE_MEM_EDGE_DECAY_K', async () => {
      setStreak(1);
      const { stdout } = await editFile('sess-p2-k1', {
        CLAUDE_MEM_EDGE_DECAY: '1',
        CLAUDE_MEM_EDGE_DECAY_K: '1',
      });
      if (stdout) {
        const ctx = JSON.parse(stdout).hookSpecificOutput?.additionalContext || '';
        expect(ctx).not.toContain('lesson behind a decaying edge');
      }
    });

    it('flag ON: explicit K=0 clamps to the declared minimum 1, not the default 3 (falsy trap)', async () => {
      setStreak(1);
      const { stdout } = await editFile('sess-p2-k0', {
        CLAUDE_MEM_EDGE_DECAY: '1',
        CLAUDE_MEM_EDGE_DECAY_K: '0',
      });
      if (stdout) {
        const ctx = JSON.parse(stdout).hookSpecificOutput?.additionalContext || '';
        expect(ctx).not.toContain('lesson behind a decaying edge');
      }
    });
  });

  // ─── P0 (D#78): path-boundary file matching ────────────────────────────────
  // The old `LIKE '%<basename>'` pattern matched any stored filename SHARING A
  // SUFFIX with the edited file: editing utils.mjs pulled lessons attached to
  // bash-utils.mjs / format-utils.mjs / prompt-search-utils.mjs. The fix
  // requires a path boundary: exact full-path, exact basename, or '%/<basename>'.
  describe('path-boundary file matching (P0 D#78)', () => {
    let tmpRoot;
    let projectDir;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-p0-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'p0test');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-p0', project: 'parent--p0test', memoryId: 'mem-p0' });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function seedObs(filesModified, lesson, title = 'seed') {
      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-p0',
        project: 'parent--p0test',
        type: 'bugfix',
        importance: 2,
        title,
        lessonLearned: lesson,
        filesModified: JSON.stringify(filesModified),
      });
      db.close();
    }

    function editFile(name, session) {
      return runScript(
        {
          tool_name: 'Edit',
          session_id: session,
          tool_input: { file_path: join(projectDir, name) },
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );
    }

    it('does NOT match a different basename sharing a suffix (bash-utils.mjs vs utils.mjs)', async () => {
      seedObs(['bash-utils.mjs'], 'lesson about bash-utils only');
      seedObs([join(projectDir, 'format-utils.mjs')], 'lesson about format-utils only');
      const { stdout } = await editFile('utils.mjs', 'sess-p0-suffix');
      if (stdout) {
        const ctx = JSON.parse(stdout).hookSpecificOutput?.additionalContext || '';
        expect(ctx).not.toContain('lesson about bash-utils only');
        expect(ctx).not.toContain('lesson about format-utils only');
      }
    });

    it('still matches exact bare basename (positive control)', async () => {
      seedObs(['utils.mjs'], 'lesson stored under bare basename');
      const { stdout } = await editFile('utils.mjs', 'sess-p0-bare');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('lesson stored under bare basename');
    });

    it('still matches relative path via /basename boundary (positive control)', async () => {
      seedObs(['scripts/utils.mjs'], 'lesson stored under relative path');
      const { stdout } = await editFile('utils.mjs', 'sess-p0-rel');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('lesson stored under relative path');
    });

    it('still matches exact full path (positive control)', async () => {
      seedObs([join(projectDir, 'utils.mjs')], 'lesson stored under full path');
      const { stdout } = await editFile('utils.mjs', 'sess-p0-full');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('lesson stored under full path');
    });

    // Review D#78: the old suffix LIKE was ASCII-case-insensitive and matched
    // either path separator; the boundary fix must not regress those recalls.
    it('still matches a case-variant stored basename (old LIKE was NOCASE)', async () => {
      seedObs(['Utils.mjs'], 'lesson stored under case-variant basename');
      const { stdout } = await editFile('utils.mjs', 'sess-p0-case');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('lesson stored under case-variant basename');
    });

    it('still matches a backslash-separated stored path', async () => {
      seedObs(['lib\\utils.mjs'], 'lesson stored under backslash path');
      const { stdout } = await editFile('utils.mjs', 'sess-p0-bslash');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('lesson stored under backslash path');
    });
  });

  // ─── P0 (D#78): events Edit-path low-signal gate ───────────────────────────
  // The events query on the Edit path admitted ANY imp>=2 row ordered by pure
  // recency — no low-signal title gate (observations path has one), no
  // body-first preference. Parallel-path drift: same class as §9 T-M1.
  describe('events Edit-path low-signal gate (P0 D#78)', () => {
    let tmpRoot;
    let projectDir;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-p0ev-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'p0evtest');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-p0ev', project: 'parent--p0evtest', memoryId: 'mem-p0ev' });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function seedEvent({ title, body, files, epochOffset = 0 }) {
      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      db.prepare(
        `
        INSERT INTO events (project, event_type, title, body, file_paths, importance, created_at_epoch)
        VALUES (?, 'bugfix', ?, ?, ?, 2, ?)
      `,
      ).run('parent--p0evtest', title, body, JSON.stringify(files), Date.now() + epochOffset);
      db.close();
    }

    function editFile(name, session) {
      return runScript(
        {
          tool_name: 'Edit',
          session_id: session,
          tool_input: { file_path: join(projectDir, name) },
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );
    }

    it('filters bodyless LOW_SIGNAL-titled events on Edit', async () => {
      seedEvent({ title: 'Modified gated.mjs', body: null, files: ['gated.mjs'] });
      seedEvent({ title: 'Error: raw stderr passthrough', body: '', files: ['gated.mjs'] });
      const { stdout } = await editFile('gated.mjs', 'sess-p0ev-gate');
      if (stdout) {
        const ctx = JSON.parse(stdout).hookSpecificOutput?.additionalContext || '';
        expect(ctx).not.toContain('Modified gated.mjs');
        expect(ctx).not.toContain('raw stderr passthrough');
      }
    });

    it('keeps a LOW_SIGNAL-titled event whose body carries the lesson', async () => {
      seedEvent({
        title: 'Modified keeper.mjs',
        body: 'the body is the lesson: flush before rotate',
        files: ['keeper.mjs'],
      });
      const { stdout } = await editFile('keeper.mjs', 'sess-p0ev-keep');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('flush before rotate');
    });

    it('orders body-bearing events above bodyless-but-substantive-titled ones', async () => {
      // Newer bodyless row with a real title vs older row with a body — body wins.
      seedEvent({
        title: 'registry UPSERT preserve-on-empty drift',
        body: null,
        files: ['ordered.mjs'],
        epochOffset: 0,
      });
      seedEvent({
        title: 'older but body-bearing',
        body: 'body-bearing lesson outranks bare title',
        files: ['ordered.mjs'],
        epochOffset: -60_000,
      });
      const { stdout } = await editFile('ordered.mjs', 'sess-p0ev-order');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      const bodyIdx = ctx.indexOf('body-bearing lesson outranks bare title');
      const titleIdx = ctx.indexOf('registry UPSERT preserve-on-empty drift');
      expect(bodyIdx).toBeGreaterThanOrEqual(0);
      expect(titleIdx).toBeGreaterThanOrEqual(0);
      expect(bodyIdx).toBeLessThan(titleIdx);
    });
  });

  // ─── D#162: live-row + lookback filters on the SHIPPED query ───────────────
  // The `DB query pattern` block above hand-copies this SELECT, so it kept
  // passing while nothing tested the real one: deleting
  // `AND ${liveObsFilterSql('o')}` from scripts/pre-tool-recall.js left all
  // 4881 tests green. That let a retracted (superseded) or compacted
  // (compressed_into) lesson reach the highest-cite-rate injection face in the
  // repo — and superseded-leak is this project's most-reopened defect class.
  //
  // Assertion shape matters (feedback_necessary_not_sufficient_assertions):
  // each case seeds a live row on the SAME file as the excluded row, so the
  // test cannot pass by the query returning nothing. The excluded row is
  // always the NEWER one, so with the filter gone it sorts first and renders
  // within the Edit path's 2-row obs limit.
  describe('live-row + lookback filters, shipped query (D#162)', () => {
    let tmpRoot;
    let projectDir;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-live-${process.pid}-`));
      projectDir = join(tmpRoot, 'parent', 'livetest');
      mkdirSync(projectDir, { recursive: true });

      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertSession(db, { id: 'sess-live', project: 'parent--livetest', memoryId: 'mem-live' });
      db.close();
    });

    afterEach(() => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    });

    function seedObs(file, lesson, extra = {}) {
      const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
      db.pragma('foreign_keys = OFF');
      initSchema(db);
      insertObs(db, {
        sessionId: 'mem-live',
        project: 'parent--livetest',
        type: 'bugfix',
        importance: 2,
        title: 'seeded lesson',
        lessonLearned: lesson,
        filesModified: JSON.stringify([file]),
        ...extra,
      });
      db.close();
    }

    function editFile(name, session) {
      return runScript(
        {
          tool_name: 'Edit',
          session_id: session,
          tool_input: { file_path: join(projectDir, name) },
        },
        { CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir },
      );
    }

    it('excludes a superseded observation while still injecting the live one', async () => {
      seedObs('sup.mjs', 'live lesson that must survive', { epochOffset: -60_000 });
      seedObs('sup.mjs', 'retracted lesson must not inject', {
        supersededAt: new Date().toISOString(),
        supersededBy: 999,
      });
      const { stdout } = await editFile('sup.mjs', 'sess-live-sup');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('live lesson that must survive');
      expect(ctx).not.toContain('retracted lesson must not inject');
    });

    it('excludes a compressed observation while still injecting the live one', async () => {
      seedObs('comp.mjs', 'live lesson beside a tombstone', { epochOffset: -60_000 });
      seedObs('comp.mjs', 'compressed tombstone must not inject', { compressedInto: 999 });
      const { stdout } = await editFile('comp.mjs', 'sess-live-comp');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('live lesson beside a tombstone');
      expect(ctx).not.toContain('compressed tombstone must not inject');
    });

    // compressed_into = -2 is the pending-purge marker, not a keeper id — a
    // `> 0` test would let it through, which is why liveObsFilterSql uses
    // `COALESCE(...) = 0`.
    it('excludes a pending-purge (compressed_into = -2) observation', async () => {
      seedObs('purge.mjs', 'live lesson beside a purge marker', { epochOffset: -60_000 });
      seedObs('purge.mjs', 'pending-purge row must not inject', { compressedInto: -2 });
      const { stdout } = await editFile('purge.mjs', 'sess-live-purge');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('live lesson beside a purge marker');
      expect(ctx).not.toContain('pending-purge row must not inject');
    });

    // Pre-tag review of this very round: the clause ONE LINE ABOVE the one this
    // block was opened to guard had the same problem. `AND o.importance >= 2`
    // could be relaxed to `>= 0` with 237 related tests green — the noise gate
    // on the repo's highest-VOLUME injection face, deletable without a red
    // test. The only case that looked like it covered this
    // (`tests/memory-inject.test.mjs` "only returns importance>=2") binds
    // fileEdgeMatchOnly's own hand-copied gate, not the shipped query — the
    // exact D#163 shape, found one altitude down.
    it('excludes a below-threshold-importance observation while injecting the live one', async () => {
      seedObs('imp.mjs', 'importance-2 lesson must survive', { epochOffset: -60_000 });
      seedObs('imp.mjs', 'importance-1 lesson must not inject', { importance: 1 });
      const { stdout } = await editFile('imp.mjs', 'sess-live-imp');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('importance-2 lesson must survive');
      expect(ctx).not.toContain('importance-1 lesson must not inject');
    });

    // Same untested-clause argument as the live filter: the 60-day
    // `created_at_epoch > cutoff` lookback had no probe either.
    it('excludes an observation older than the 60-day lookback', async () => {
      seedObs('old.mjs', 'recent lesson inside the window', { epochOffset: -60_000 });
      seedObs('old.mjs', 'stale lesson outside the window', { epochOffset: -90 * 86400000 });
      const { stdout } = await editFile('old.mjs', 'sess-live-old');
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(ctx).toContain('recent lesson inside the window');
      expect(ctx).not.toContain('stale lesson outside the window');
    });
  });
});
