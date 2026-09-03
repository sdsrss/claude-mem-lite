// tests/post-tool-recall.test.mjs
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import { cooldownPathFor } from '../lib/cooldown-path.mjs';

// Session ids that actually EXERCISE the sanitizer. The first version of this file seeded
// 's1'/'s2'/'s3' — pure alphanumerics, which EVERY plausible sanitizer maps to itself — so
// giving the reader a deliberately divergent private copy of the path rule left all four
// cases green. A derived seed helper is necessary but not sufficient: the INPUT has to be
// able to tell two rules apart. These do, three ways: `_` and `.` are KEPT by the canonical
// class `[^a-zA-Z0-9_.-]` and rewritten by any looser one, `/` and `:` must become `-`, and
// the string runs past the 64-char cap so a different cap truncates elsewhere.
const SID = (n) => `sess_${n}.run/id:${'x'.repeat(70)}`;
const SID1 = SID(1), SID2 = SID(2), SID3 = SID(3);

const SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-recall.js');
function run(input, env = {}) {
  return new Promise((res, rej) => {
    const c = spawn('node', [SCRIPT], { env: { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => res(out)); c.on('error', rej);
    c.stdin.write(JSON.stringify(input)); c.stdin.end();
    setTimeout(() => { c.kill(); rej(new Error('timeout')); }, SUBPROCESS_TIMEOUT_MS);
  });
}

describe('post-tool-recall (bind component 2)', () => {
  let root, runtime, fp;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'post-recall-'));
    runtime = join(root, 'runtime'); mkdirSync(runtime, { recursive: true });
    fp = join(root, 'target.mjs');
  });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  // Derive the filename from lib/cooldown-path.mjs, never re-type the rule (audit
  // 2026-09-02 P1-1). A hand-copied literal here is a FOURTH copy that pins the test to
  // itself: change the sanitizer in the lib and every case still passes while the real
  // writer and reader have silently diverged onto two different filenames.
  const seed = (sessionId, idents) => {
    writeFileSync(cooldownPathFor(runtime, sessionId),
      JSON.stringify({ [fp]: { ts: Date.now(), lessonIds: [42], lessonIdents: idents } }));
  };
  const env = (extra = {}) => ({ CLAUDE_MEM_DIR: root, CLAUDE_MEM_SALIENCE: 'bind', ...extra });

  it('warns when the edit dropped a flagged identifier', async () => {
    seed(SID1, { 42: ['recoverChildrenOf'] });
    writeFileSync(fp, 'function purgeStale() { db.delete(); }');
    const out = await run({ tool_name: 'Edit', session_id: SID1, tool_input: { file_path: fp } }, env());
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('dropped `recoverChildrenOf`');
    expect(ctx).toContain('#42');
  });
  it('silent when the identifier is still present', async () => {
    seed(SID2, { 42: ['recoverChildrenOf'] });
    writeFileSync(fp, 'function purgeStale() { recoverChildrenOf(); db.delete(); }');
    const out = await run({ tool_name: 'Edit', session_id: SID2, tool_input: { file_path: fp } }, env());
    expect(out).toBe('');
  });
  it('silent when NOT in bind mode (current)', async () => {
    seed(SID3, { 42: ['recoverChildrenOf'] });
    writeFileSync(fp, 'function purgeStale() { db.delete(); }');
    const out = await run({ tool_name: 'Edit', session_id: SID3, tool_input: { file_path: fp } }, env({ CLAUDE_MEM_SALIENCE: 'current' }));
    expect(out).toBe('');
  });
  it('silent when no cooldown entry exists', async () => {
    writeFileSync(fp, 'function purgeStale() { db.delete(); }');
    const out = await run({ tool_name: 'Edit', session_id: 'nope', tool_input: { file_path: fp } }, env());
    expect(out).toBe('');
  });
});
