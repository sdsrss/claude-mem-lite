// tests/pre-tool-recall-bind.test.mjs
// Pins the bind-salience directive selection in scripts/pre-tool-recall.js.
// Mirrors the spawn+seed harness from pre-tool-recall-file-intel.test.mjs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import Database from 'better-sqlite3';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');
function runScript(input, env = {}) {
  return new Promise((res, rej) => {
    const child = spawn('node', [SCRIPT_PATH], {
      env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('close', () => res({ stdout }));
    child.on('error', rej);
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
    setTimeout(() => {
      child.kill();
      rej(new Error('timeout'));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}

describe('pre-tool-recall bind directive (component 1)', () => {
  let tmpRoot, projectDir, fp;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-bind-${process.pid}-`));
    projectDir = join(tmpRoot, 'parent', 'bindtest');
    mkdirSync(projectDir, { recursive: true });
    fp = join(projectDir, 'maintain-core.mjs');
    writeFileSync(fp, 'export function purgeStale() {}\n');
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'sess-bind', project: 'parent--bindtest', memoryId: 'mem-bind' });
    insertObs(db, {
      sessionId: 'mem-bind',
      project: 'parent--bindtest',
      type: 'bugfix',
      importance: 2,
      title: 'orphan recovery',
      lessonLearned: 'recover referencing rows FIRST before hard-delete',
      filesModified: `["${fp}"]`,
    });
    db.close();
  });
  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });
  const env = (extra = {}) => ({ CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir, ...extra });

  it('Edit under =bind ends with the comprehension-binding directive', async () => {
    const { stdout } = await runScript(
      { tool_name: 'Edit', session_id: 'b1', tool_input: { file_path: fp } },
      env({ CLAUDE_MEM_SALIENCE: 'bind' }),
    );
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[mem] Lessons for maintain-core.mjs:');
    expect(ctx).toMatch(/state the one concrete check it forces/);
    expect(ctx).not.toContain("'#NN applied'");
  });
  it('Edit by default (current) keeps the v2.98 ack directive', async () => {
    const { stdout } = await runScript(
      { tool_name: 'Edit', session_id: 'b2', tool_input: { file_path: fp } },
      env(),
    );
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("'#NN applied'");
    expect(ctx).not.toMatch(/state the one concrete check/);
  });
  it('Edit under legacy emits lessons but NO directive', async () => {
    const { stdout } = await runScript(
      { tool_name: 'Edit', session_id: 'b3', tool_input: { file_path: fp } },
      env({ CLAUDE_MEM_SALIENCE: 'legacy' }),
    );
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[mem] Lessons for maintain-core.mjs:');
    expect(ctx).not.toMatch(/concrete check|#NN applied/);
  });

  it('bind: records present lesson identifiers in the cooldown for the edited file', async () => {
    // lesson names recoverChildrenOf; ensure it is present in the pre-edit file
    const fp2 = join(projectDir, 'withident.mjs');
    writeFileSync(fp2, 'export function recoverChildrenOf() {}\nexport function purgeStale() {}\n');
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertObs(db, {
      sessionId: 'mem-bind',
      project: 'parent--bindtest',
      type: 'bugfix',
      importance: 2,
      title: 'keep recover',
      lessonLearned: 'must call recoverChildrenOf before delete',
      filesModified: `["${fp2}"]`,
    });
    db.close();

    await runScript(
      { tool_name: 'Edit', session_id: 'b4', tool_input: { file_path: fp2 } },
      env({ CLAUDE_MEM_SALIENCE: 'bind' }),
    );

    const cd = JSON.parse(readFileSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-b4.json'), 'utf8'));
    const entry = cd[fp2];
    const allTokens = Object.values(entry.lessonIdents || {}).flat();
    expect(allTokens).toContain('recoverChildrenOf');
  });

  it('default (current) salience does NOT write lessonIdents', async () => {
    await runScript({ tool_name: 'Edit', session_id: 'b5', tool_input: { file_path: fp } }, env());
    const cd = JSON.parse(readFileSync(join(tmpRoot, 'runtime', 'pre-recall-cooldown-b5.json'), 'utf8'));
    expect(cd[fp].lessonIdents).toBeUndefined();
  });
});
