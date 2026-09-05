// Tier-1 firing counters for ① file-intel + ② reread-guard. The hook records a
// `file_intel` / `reread_warn` event via lib/metrics.mjs (gated by
// CLAUDE_MEM_METRICS=1, default off → zero hot-path cost) on each firing; the
// rows aggregate into `claude-mem-lite doctor` / `stats`. This pins the WIRING:
// events recorded on fire, nothing recorded when metrics are disabled.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join } from 'path';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import Database from 'better-sqlite3';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');

function runScript(input, env = {}) {
  return new Promise((resolveP, reject) => {
    // Hermetic metrics gate: an ambient CLAUDE_MEM_METRICS from the shell (e.g.
    // exported via Claude Code settings) must NOT leak into the child — tests
    // opt in explicitly via `env`. Without this, the "default off" case inherits
    // the shell value and the disabled-path assertion fails locally while CI's
    // clean env hides it (mem #8725).
    const childEnv = { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '', ...env };
    if (!('CLAUDE_MEM_METRICS' in env)) delete childEnv.CLAUDE_MEM_METRICS;
    const child = spawn('node', [SCRIPT_PATH], {
      env: childEnv,
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

const BIG = '// metrics fixture module\n' + 'export const v = 1;\n'.repeat(500);
const today = () => new Date().toISOString().slice(0, 10);
const read = (fp, sid, extra = {}) => ({
  tool_name: 'Read',
  session_id: sid,
  tool_input: { file_path: fp, ...extra },
});

describe('pre-tool-recall firing metrics (tier-1)', () => {
  let tmpRoot;
  let projectDir;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-metrics-${process.pid}-`));
    projectDir = join(tmpRoot, 'parent', 'metricstest');
    mkdirSync(projectDir, { recursive: true });
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'sess-m', project: 'parent--metricstest', memoryId: 'mem-m' });
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  const env = (extra = {}) => ({ CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir, ...extra });
  const metricEvents = () => {
    const p = join(tmpRoot, 'metrics', `${today()}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).event);
  };

  it('records a file_intel event when ① fires (metrics enabled)', async () => {
    const fp = join(projectDir, 'm1.mjs');
    writeFileSync(fp, BIG);
    await runScript(read(fp, 's1'), env({ CLAUDE_MEM_METRICS: '1' }));
    expect(metricEvents()).toContain('file_intel');
  });

  it('records a reread_warn event when ② warns (metrics enabled)', async () => {
    const fp = join(projectDir, 'm2.mjs');
    writeFileSync(fp, BIG);
    await runScript(read(fp, 's2'), env({ CLAUDE_MEM_METRICS: '1' })); // first read → file_intel
    await runScript(read(fp, 's2'), env({ CLAUDE_MEM_METRICS: '1' })); // repeat full read of unchanged file → reread_warn
    expect(metricEvents()).toContain('reread_warn');
  });

  it('records a pretool_recall event with counts when a lesson injects (G13)', async () => {
    // Pre-fix, obs/event lesson recall — the largest injected_n contributor —
    // had NO firing counter while file_intel/reread_warn were metered.
    const fp = join(projectDir, 'm4.mjs');
    writeFileSync(fp, BIG);
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    insertObs(db, {
      sessionId: 'mem-m',
      project: 'parent--metricstest',
      type: 'bugfix',
      importance: 2,
      title: 'm4 FTS regression',
      lessonLearned: 'Rebuild the FTS index after schema edits to m4.',
      filesModified: '["m4.mjs"]',
    });
    db.close();
    await runScript(read(fp, 's4'), env({ CLAUDE_MEM_METRICS: '1' }));
    const p = join(tmpRoot, 'metrics', `${today()}.jsonl`);
    const rows = readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const recall = rows.filter((r) => r.event === 'pretool_recall');
    expect(recall.length).toBe(1);
    expect(recall[0].injected).toBe(1);
    expect(recall[0].obs).toBe(1);
    expect(recall[0].evt).toBe(0);
    expect(recall[0].mode).toBe('read');
  });

  it('records NO pretool_recall event when nothing injects (metrics enabled)', async () => {
    const fp = join(projectDir, 'm5.mjs');
    writeFileSync(fp, BIG);
    await runScript(read(fp, 's5'), env({ CLAUDE_MEM_METRICS: '1' })); // no obs seeded → file_intel only
    const p = join(tmpRoot, 'metrics', `${today()}.jsonl`);
    const events = existsSync(p)
      ? readFileSync(p, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l).event)
      : [];
    expect(events).toContain('file_intel');
    expect(events).not.toContain('pretool_recall');
  });

  it('records nothing when CLAUDE_MEM_METRICS is unset (default off)', async () => {
    const fp = join(projectDir, 'm3.mjs');
    writeFileSync(fp, BIG);
    await runScript(read(fp, 's3'), env()); // metrics disabled
    expect(existsSync(join(tmpRoot, 'metrics'))).toBe(false);
  });
});
