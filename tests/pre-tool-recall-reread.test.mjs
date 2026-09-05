// Integration tests for feature ② — repeated-read guard in
// scripts/pre-tool-recall.js. Two sequential Read subprocesses share the
// session cooldown (same CLAUDE_MEM_DIR + session_id), so the second sees what
// the first recorded. Pins the WIRING: when the warning fires vs. stays silent.
// The decision logic itself is unit-tested in tests/reread-guard.test.mjs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';
import { insertSession, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
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

const BIG_CONTENT = '// helper module\n' + 'export const v = 1;\n'.repeat(500);

describe('pre-tool-recall repeated-read guard (feature ②)', () => {
  let tmpRoot;
  let projectDir;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-reread-${process.pid}-`));
    projectDir = join(tmpRoot, 'parent', 'rereadtest');
    mkdirSync(projectDir, { recursive: true });

    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'sess-reread', project: 'parent--rereadtest', memoryId: 'mem-reread' });
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  const env = (extra = {}) => ({ CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir, ...extra });
  const read = (fp, sid, extra = {}) => ({
    tool_name: 'Read',
    session_id: sid,
    tool_input: { file_path: fp, ...extra },
  });

  it('warns on a second full read of an unchanged file in the same session', async () => {
    const fp = join(projectDir, 'big.mjs');
    writeFileSync(fp, BIG_CONTENT);

    await runScript(read(fp, 's1'), env());
    const { stdout } = await runScript(read(fp, 's1'), env());

    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('🔁');
    expect(ctx).toContain('big.mjs');
    expect(ctx).toMatch(/system-injected/);
  });

  it('stays silent on a small file re-read (below the token floor)', async () => {
    const fp = join(projectDir, 'tiny.mjs');
    writeFileSync(fp, 'export const x = 1;\n');

    await runScript(read(fp, 's2'), env());
    const { stdout } = await runScript(read(fp, 's2'), env());
    expect(stdout).toBe('');
  });

  it('stays silent when the second read is partial (offset/limit paging)', async () => {
    const fp = join(projectDir, 'paged.mjs');
    writeFileSync(fp, BIG_CONTENT);

    await runScript(read(fp, 's3'), env());
    const { stdout } = await runScript(read(fp, 's3', { offset: 100, limit: 20 }), env());
    expect(stdout).toBe('');
  });

  it('stays silent when the file changed since the first read', async () => {
    const fp = join(projectDir, 'changed.mjs');
    writeFileSync(fp, BIG_CONTENT);

    await runScript(read(fp, 's4'), env());
    // Bump mtime well into the future → "modified since".
    const future = new Date(Date.now() + 10_000);
    utimesSync(fp, future, future);

    const { stdout } = await runScript(read(fp, 's4'), env());
    expect(stdout).toBe('');
  });

  it('is disabled by CLAUDE_MEM_REREAD_GUARD=0 on the second read', async () => {
    const fp = join(projectDir, 'optout.mjs');
    writeFileSync(fp, BIG_CONTENT);

    await runScript(read(fp, 's5'), env()); // guard on → records
    const { stdout } = await runScript(read(fp, 's5'), env({ CLAUDE_MEM_REREAD_GUARD: '0' }));
    expect(stdout).toBe('');
  });
});
