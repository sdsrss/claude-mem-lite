// The background model session summary runs by default; CLAUDE_MEM_SKIP_SUMMARY turns it off.
//
// D#95 made the worker opt-in (34a65cd) and that was reverted before release: the premise
// "Last Session already comes from the Stop report" holds only when the assistant's final
// reply carries Done / Not done sections (lib/summary-extractor.mjs). Without them the Stop
// row is the first prompt + recent observation titles, and the worker's model summary is the
// only prose summary that user gets. This pins the default so a future opt-in is a decision,
// not an accident.
//
// Behavioural, two arms: the worker records one `summary_worker` metric row per exit
// (CLAUDE_MEM_METRICS=1), so the SKIP arm's NO is backed by the default arm's YES.

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until no process still names this sandbox. The worker's argv carries the project
 * name, which is derived from the sandbox dir's basename (`mem-sumworker-XXXX--proj`), while the
 * full root appears only in its ENV, which `pgrep -f` does not read (pre-ship review P3-4).
 */
async function quiesce(root) {
  const tag = basename(root);
  for (let i = 0; i < 50; i++) {
    let out;
    try {
      out = execFileSync('pgrep', ['-f', tag], { encoding: 'utf8' });
    } catch {
      return; // pgrep exits 1 when nothing matches
    }
    if (!out.trim()) return;
    await sleep(100);
  }
}

afterAll(async () => {
  for (const r of roots) {
    await quiesce(r);
    rmSync(r, { recursive: true, force: true });
  }
});

function summaryWorkerRows(data) {
  const dir = join(data, 'metrics');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter((l) => l.includes('"summary_worker"'));
}

async function stopInSandbox(extraEnv) {
  const root = mkdtempSync(join(tmpdir(), 'mem-sumworker-'));
  roots.push(root);
  const data = join(root, 'data');
  const cwd = join(root, 'proj');
  for (const d of [data, cwd, join(root, '.claude')]) mkdirSync(d, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PWD;
  Object.assign(env, {
    HOME: root,
    CLAUDE_MEM_DIR: data,
    CLAUDE_MEM_METRICS: '1',
    CLAUDE_MEM_FLUSH_TIMEOUT: '0',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_CODE_PATH: join(root, 'no-such-claude'),
    ANTHROPIC_API_KEY: '',
    MEM_NO_AUTO_ADOPT: '1',
    ...extraEnv,
  });
  const r = spawnSync(process.execPath, [join(REPO, 'hook.mjs'), 'stop'], {
    cwd,
    env,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'cc-d95', transcript_path: join(root, 'none.jsonl') }),
  });
  expect(r.status, r.stderr).toBe(0);
  // The worker is detached; give it the time the default arm needs to write its row.
  for (let i = 0; i < 60 && summaryWorkerRows(data).length === 0; i++) await sleep(100);
  await quiesce(root);
  return summaryWorkerRows(data);
}

describe('summary worker: on by default, off under CLAUDE_MEM_SKIP_SUMMARY', () => {
  it('by default, Stop starts the worker (it records its outcome)', async () => {
    const rows = await stopInSandbox({});
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain('"outcome":"no-obs"');
  });

  it('CLAUDE_MEM_SKIP_SUMMARY=1: Stop starts no summary worker', async () => {
    expect(await stopInSandbox({ CLAUDE_MEM_SKIP_SUMMARY: '1' })).toEqual([]);
  });
});
