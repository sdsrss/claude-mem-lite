// Integration tests for feature ① — "file intelligence" injection in
// scripts/pre-tool-recall.js. On the first Read of a file this session, the hook
// surfaces the file's approximate token size + a one-line summary so the agent
// can decide to read fully, slice, or grep. Read-only; opt out with
// CLAUDE_MEM_FILE_INTEL=0. The summary/size logic itself is unit-tested in
// tests/file-intel.test.mjs — these tests pin the HOOK WIRING (when it fires,
// when it stays silent, that Edit is unaffected).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import Database from 'better-sqlite3';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');

function runScript(input, env = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('close', () => resolveP({ stdout }));
    child.on('error', reject);
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
    setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}

// A file comfortably above the default 800-token threshold, with a meaningful
// header comment for the summary.
const BIG_CONTENT = '// Widget rendering helpers and layout math\n' + 'export const v = 1;\n'.repeat(500);

describe('pre-tool-recall file intelligence (feature ①)', () => {
  let tmpRoot;
  let projectDir;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-intel-${process.pid}-`));
    projectDir = join(tmpRoot, 'parent', 'inteltest');
    mkdirSync(projectDir, { recursive: true });

    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'sess-intel', project: 'parent--inteltest', memoryId: 'mem-intel' });
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  const env = (extra = {}) => ({
    CLAUDE_MEM_DIR: tmpRoot,
    CLAUDE_PROJECT_DIR: projectDir,
    ...extra,
  });

  it('injects size + summary on first Read of a large file with no lessons', async () => {
    const fp = join(projectDir, 'widget.mjs');
    writeFileSync(fp, BIG_CONTENT);

    const { stdout } = await runScript(
      { tool_name: 'Read', session_id: 's1', tool_input: { file_path: fp } },
      env(),
    );
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('📄 widget.mjs');
    expect(ctx).toContain('tok');
    expect(ctx).toContain('Widget rendering helpers and layout math');
    expect(ctx).toMatch(/system-injected/);
  });

  it('stays silent on a small file below the token threshold', async () => {
    const fp = join(projectDir, 'tiny.mjs');
    writeFileSync(fp, 'export const x = 1;\n');

    const { stdout } = await runScript(
      { tool_name: 'Read', session_id: 's2', tool_input: { file_path: fp } },
      env(),
    );
    expect(stdout).toBe('');
  });

  it('surfaces BOTH the file-intel line and a matching lesson', async () => {
    const fp = join(projectDir, 'lessony.mjs');
    writeFileSync(fp, BIG_CONTENT);

    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertObs(db, {
      sessionId: 'mem-intel',
      project: 'parent--inteltest',
      type: 'bugfix',
      importance: 2,
      title: 'lessony bug',
      lessonLearned: 'always null-check the widget root',
      filesModified: `["${fp}"]`,
    });
    db.close();

    const { stdout } = await runScript(
      { tool_name: 'Read', session_id: 's3', tool_input: { file_path: fp } },
      env(),
    );
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('📄 lessony.mjs');
    expect(ctx).toContain('[mem] Lessons for lessony.mjs:');
    expect(ctx).toContain('always null-check the widget root');
  });

  it('does NOT inject file-intel on the Edit path (Read-only feature)', async () => {
    const fp = join(projectDir, 'edited.mjs');
    writeFileSync(fp, BIG_CONTENT);

    // Edit on a large real file with no lessons + nudge off (default) → silent.
    const { stdout } = await runScript(
      { tool_name: 'Edit', session_id: 's4', tool_input: { file_path: fp } },
      env(),
    );
    expect(stdout).toBe('');
  });

  it('is disabled by CLAUDE_MEM_FILE_INTEL=0', async () => {
    const fp = join(projectDir, 'optout.mjs');
    writeFileSync(fp, BIG_CONTENT);

    const { stdout } = await runScript(
      { tool_name: 'Read', session_id: 's5', tool_input: { file_path: fp } },
      env({ CLAUDE_MEM_FILE_INTEL: '0' }),
    );
    expect(stdout).toBe('');
  });
});
