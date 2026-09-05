// tests/pre-tool-recall-bridge.test.mjs — bridge-mode behavior of the standalone hook.
// Drives scripts/pre-tool-recall.js as a child process with a seeded sandbox DB,
// mirroring tests/pre-tool-recall*.test.mjs harness conventions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { insertObs, insertSession } from './test-helpers.mjs';

const HOOK = join(import.meta.dirname, '..', 'scripts', 'pre-tool-recall.js');

// The hook's inferProject() derives the project name as `${parentBasename}--${base}`
// from CLAUDE_PROJECT_DIR. We create proj/myapp under the temp root so it yields
// the predictable value 'proj--myapp' that we seed into the DB.
const PROJECT = 'proj--myapp';

function seed(tmpRoot, filePath) {
  // Hook derives DB_PATH as join(CLAUDE_MEM_DIR, 'claude-mem-lite.db').
  const db = initSchema(new Database(join(tmpRoot, 'claude-mem-lite.db')));
  db.pragma('foreign_keys = OFF');
  insertSession(db, { id: 's-bridge', project: PROJECT });
  insertObs(db, {
    sessionId: 's-bridge',
    project: PROJECT,
    type: 'bugfix',
    importance: 2,
    title: 'guard recoverChildrenOf',
    lessonLearned: 'always null-check before recoverChildrenOf',
    filesModified: JSON.stringify([filePath]),
  });
  db.close();
}

function runHook(tmpRoot, projectDir, env) {
  const filePath = join(projectDir, 'target.js');
  const event = JSON.stringify({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: 'recoverChildrenOf(p)',
      new_string: 'recoverChildrenOf(p2)',
    },
    session_id: 'sess-x',
  });
  return execFileSync('node', [HOOK], {
    input: event,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      CLAUDE_MEM_HOOK_RUNNING: '',
      CLAUDE_MEM_DIR: tmpRoot,
      CLAUDE_PROJECT_DIR: projectDir,
      ...env,
    },
  });
}

describe('pre-tool-recall bridge mode', () => {
  let tmpRoot, projectDir;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bridge-'));
    // Two-level path so inferProject() → 'proj--myapp' (stable across runs).
    projectDir = join(tmpRoot, 'proj', 'myapp');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'target.js'), 'recoverChildrenOf(p)');
    seed(tmpRoot, join(projectDir, 'target.js'));
  });

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  it('off by default: emits the generic ack line, never the bridge marker', () => {
    const out = runHook(tmpRoot, projectDir, {});
    expect(out).not.toContain('→ this edit must:');
  });

  it('bridge mode emits the bound check when the bridge returns a usable line', () => {
    // CLAUDE_MEM_BRIDGE_FAKE is a test seam (Step 3) that short-circuits callLLM.
    const out = runHook(tmpRoot, projectDir, {
      CLAUDE_MEM_SALIENCE: 'bridge',
      CLAUDE_MEM_BRIDGE_FAKE: 'null-check recoverChildrenOf first',
    });
    expect(out).toContain('→ this edit must: null-check recoverChildrenOf first');
  });

  it('bridge mode falls back to the ack line when the bridge abstains (N/A)', () => {
    const out = runHook(tmpRoot, projectDir, {
      CLAUDE_MEM_SALIENCE: 'bridge',
      CLAUDE_MEM_BRIDGE_FAKE: 'N/A',
    });
    expect(out).not.toContain('→ this edit must:');
    expect(out.toLowerCase()).toContain('apply each lesson'); // ACK_DIRECTIVE text
  });
});
