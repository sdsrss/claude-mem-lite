// A recall-intent prompt that names a topic must still be answered by relevance.
//
// detectIntent() sets `useRecent: true` on any prompt carrying a recall keyword
// ("之前" / "previously" / "记得" / …). main() then did:
//
//     if (intent?.useRecent) rows = searchRecent(db, project, intent.limit);
//
// discarding the prompt text entirely. So the MOST explicit memory request a user can
// make was the one answered without looking at what they asked about.
//
// Measured on v3.68.1, 600-row corpus, target = the oldest row, two prompts differing by
// exactly one word:
//
//   "分页接口又报 500 了，边界问题怎么处理"                 → target injected at rank 1  ✓
//   "分页接口又报 500 了，之前那个边界问题是怎么处理的"      → target ABSENT; 5 unrelated
//                                                            recency rows injected     ✗
//
// Adding "之前" made the injection strictly worse: it removed the answer AND spent the
// budget on noise. Recency is the right fallback for a CONTENTLESS recall prompt
// ("之前我们在做什么"), so that behavior is pinned below too — the fix is ordering, not
// removal.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { detectIntent } from '../scripts/prompt-search-utils.mjs';

// Same reason as tests/ups-cold-start-injection.test.mjs: these spawn
// scripts/user-prompt-search.js against a seeded corpus, and the 20s global timeout is
// a unit-test budget. Both files began timing out on the 2-core CI runner as the suite
// grew (v3.70.0 Release run 32070192835) — contention, not a regression.
//
// D#203 — blown again at 60s (run 33605998984). Not raised a third time: in that one run
// this file measured 5690ms on Node 20, 57058ms on Node 24 and 119949ms on Node 22, so
// the multiplier is the runner and no fixed budget survives it. The seed below is now
// ~7x cheaper instead; 60s stays. Sibling reasoning: ups-cold-start-injection.test.mjs.
vi.setConfig({ testTimeout: 60_000 });

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/user-prompt-search.js');
const PROJECT = 'x--recallintent';
const TOPICAL = '分页接口又报 500 了，边界问题怎么处理';
const TOPICAL_RECALL = '分页接口又报 500 了，之前那个边界问题是怎么处理的';
const CONTENTLESS_RECALL = '之前我们在这个项目里都做了些什么来着';
const TARGET = '分页接口在 offset 超过总数时返回 500，根因是 SQL LIMIT 传了负数';
const FILLER = ['登录表单校验微调', '会话标记审计', '环境变量加载顺序修复', '错误页文案调整',
  '令牌刷新窗口调整', '密钥轮换手册草稿', '中间件顺序问题', '配置默认值不一致'];

const dirs = [];

/** 600 rows with the target as the OLDEST — the realistic shape (the lesson is old). */
function seedCorpus(n = 600) {
  const dir = mkdtempSync(join(tmpdir(), 'ups-recall-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  initSchema(db);
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
              VALUES ('cc', 'mem', ?, datetime('now'), ?)`).run(PROJECT, Date.now());
  const base = Date.now();
  // One transaction, not n — `saveObservation` commits per call, so this seed paid 600
  // fsyncs (2019ms unwrapped vs 270ms wrapped, measured 2026-09-02). Identical rows
  // through the identical production write path; only the commit boundary moves. D#203.
  let target;
  db.transaction(() => {
    target = saveObservation(db, {
      content: TARGET, type: 'bugfix', importance: 3, project: PROJECT,
      lesson_learned: '分页边界要 clamp offset，不要把负数传进 LIMIT',
      now: new Date(base - 600 * 60 * 60 * 1000),
    });
    for (let i = 1; i < n; i++) {
      saveObservation(db, {
        content: `第 ${i} 次会话处理了${FILLER[i % FILLER.length]}，顺带调整了一些配置`,
        type: 'change', importance: 1, project: PROJECT, now: new Date(base - i * 60_000),
      });
    }
  })();
  db.close();
  return { dir, targetId: target.id };
}

function runHook(dir, prompt, sessionId) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env, CLAUDE_MEM_DIR: dir, CLAUDE_PROJECT_DIR: '/x/recallintent',
        PWD: '/x/recallintent', CLAUDE_MEM_SKIP_UPDATE: '1', MEM_QUIET_HOOKS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => {});
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 20_000);
    proc.on('close', () => { clearTimeout(killer); done(stdout); });
    proc.stdin.write(JSON.stringify({ session_id: sessionId, prompt, cwd: '/x/recallintent' }));
    proc.stdin.end();
  });
}

describe('UPS recall-intent — relevance before recency', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  });

  it('both probe prompts really do differ only in recall intent', () => {
    // Premise guard: if detectIntent stopped classifying the "之前" prompt as useRecent,
    // the comparison below would pass for the wrong reason.
    expect(detectIntent(TOPICAL_RECALL)?.useRecent).toBe(true);
    expect(detectIntent(TOPICAL)?.useRecent).toBeFalsy();
  });

  it('a recall prompt naming a topic surfaces that topic, not just recent rows', async () => {
    const { dir, targetId } = seedCorpus();
    const out = await runHook(dir, TOPICAL_RECALL, 'ri-1');
    expect(out, 'nothing injected for an explicit recall prompt').not.toBe('');
    expect(new RegExp(`#${targetId}\\b`).test(out), `target #${targetId} missing:\n${out}`).toBe(true);
  });

  it('adding a recall keyword never costs the answer the topical prompt got', async () => {
    const { dir, targetId } = seedCorpus();
    const plain = await runHook(dir, TOPICAL, 'ri-plain');
    const recall = await runHook(dir, TOPICAL_RECALL, 'ri-recall');
    const re = new RegExp(`#${targetId}\\b`);
    expect(re.test(plain), 'baseline broke: topical prompt no longer finds the target').toBe(true);
    expect(re.test(recall), 'the recall keyword removed the answer').toBe(true);
  });

  it('a CONTENTLESS recall prompt still falls back to recent rows', async () => {
    // The intent path's legitimate purpose: "what were we doing?" has no topic to match,
    // so recency is the only sensible answer. Removing the path would break this.
    const { dir, targetId } = seedCorpus(40);
    const out = await runHook(dir, CONTENTLESS_RECALL, 'ri-meta');
    expect(out).not.toBe('');
    // The newest filler rows, not the 600-hours-old target.
    expect(new RegExp(`#${targetId}\\b`).test(out)).toBe(false);
  });
});
