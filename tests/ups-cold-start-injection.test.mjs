// Cold-start UPS injection: a first-week corpus must not be structurally silent.
//
// v3.61.0 scaled the two set-level score floors by ln(N+1)/ln(N_REF+1) to fix
// "new install injects nothing". That ramp has the right asymptotics but the wrong
// small-N shape: FTS5's IDF term is `log((N - df + 0.5) / (df + 0.5))`, which is
// EXACTLY 0 at N=2/df=1 and stays well under ln(N+1) across the whole first-week
// window. Re-measured end-to-end through the PRODUCTION write path
// (lib/save-observation.mjs — a raw INSERT skips CJK bigram expansion, which is how
// the first cut's ramp table got misread), 1 planted target + topically clustered
// filler, CJK prose prompt:
//
//   N              2     3     4     5     6    10    25    80
//   top|bm25|     0.0   5.1   7.0   9.5  11.4  15.5  22.2  30.3
//   ln ramp floor 5.2   6.5   7.6   8.4   9.2  11.3  15.3  20.7   ← DROP at N≤4
//
// Why the prompt is Chinese prose and not English: the upstream hasExplicitSignal
// gate only lets a prompt reach these floors if it names a file, an error signature,
// a tech identifier, or is CJK past the length gate. When the signal is a tech
// identifier, the identifier bypass restores rows the floors dropped — so an English
// probe naming JWT_SECRET passes with OR without the floor fix and proves nothing.
// CJK prose is the shape that reaches the floors with nothing to rescue it, which is
// also the shape this project's own users write.
//
// These are END-TO-END assertions (spawn the hook, read stdout) at production floor
// defaults, NOT assertions about the scale formula: a test mirroring the formula
// cannot tell a right formula from a wrong one.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { extractTechIdentifiers } from '../scripts/user-prompt-search.js';

// Every case here spawns scripts/user-prompt-search.js and seeds a corpus through it,
// so these are subprocess integration tests living under a 20s global timeout chosen
// for unit tests. They fit comfortably on a dev box and began timing out on the 2-core
// CI runner once the suite grew (v3.70.0 Release run 32070192835) — a scheduling
// deadline, not a behaviour change: nothing here got slower, there is just more
// competing for two cores. Raising the budget keeps every assertion intact; capping it
// at 20s would only convert contention into a red release.
//
// D#203 — the budget was blown again at 60s (run 33605998984), and the number is NOT
// being raised a third time. The discriminator was the matrix: one commit, three legs,
// this file at 3792ms on Node 20, 30173ms on Node 24 and 67527ms on Node 22. Identical
// code cannot get 18x slower on one leg, so the stall is the runner and no fixed budget
// is safe against a multiplier — the base cost is the only term under our control. It is
// now ~2.4x smaller (see `seedCorpus`), which is what buys the headroom; 60s stays.
vi.setConfig({ testTimeout: 60_000 });

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/user-prompt-search.js');
const PROJECT = 'x--coldstart';
const PROMPT = '登录页面的中文错误提示又乱码了，之前是怎么修的';
const OFF_TOPIC = '请帮我生成本季度的集群入口拓扑示意图并导出为矢量文件';

const TARGET_TEXT = '登录页面的中文错误提示乱码，根因是手写 res.end 时响应头缺少 charset，浏览器按 latin1 解码';
const TARGET_LESSON = '手写 res.end 时必须显式设置 Content-Type charset';
// Topically clustered filler: a real first-week corpus shares vocabulary with the
// target (same project, same feature area), which RAISES df and so LOWERS the IDF the
// floors are compared against. Distinct filler would understate the problem.
const FILLER = ['登录表单校验微调', '会话标记审计', '环境变量加载顺序修复', '错误页文案调整',
  '令牌刷新窗口调整', '密钥轮换手册草稿', '中间件顺序问题', '配置默认值不一致'];

const dirs = [];

/** Seed a data dir with exactly `n` observations (1 planted target + n-1 filler). */
function seedCorpus(n) {
  const dir = mkdtempSync(join(tmpdir(), 'ups-cold-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  initSchema(db);
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
              VALUES ('cc-seed', 'mem-seed', ?, datetime('now'), ?)`).run(PROJECT, Date.now());
  const base = Date.now();
  // Production pipeline, not a raw INSERT: CJK bigram expansion happens here, and a
  // corpus seeded without it cannot be searched the way a real one can.
  // `now` is stepped 10 min apart so the 5-minute near-duplicate window doesn't
  // collapse the filler rows into one.
  // One transaction, not n. `saveObservation` commits per call, so a 600-row seed paid
  // 600 fsyncs: measured 2026-09-02 on this corpus shape, 2019ms unwrapped vs 270ms
  // wrapped (7.5x). The rows written are byte-identical — still the production write
  // path, still CJK bigram expansion, still the stepped `now` — this changes the seed's
  // COST, not its shape, which is why the floors it feeds are unaffected. It matters
  // because the CI stall this file's timeout absorbs is multiplicative (D#203).
  let target;
  db.transaction(() => {
    target = saveObservation(db, {
      content: TARGET_TEXT, type: 'bugfix', importance: 3, project: PROJECT,
      lesson_learned: TARGET_LESSON, now: new Date(base),
    });
    for (let i = 1; i < n; i++) {
      saveObservation(db, {
        content: `第 ${i} 次会话处理了${FILLER[i % FILLER.length]}，顺带调整了一些配置`,
        type: 'change', importance: 1, project: PROJECT, now: new Date(base - i * 10 * 60_000),
      });
    }
  })();
  const count = db.prepare('SELECT count(*) AS c FROM observations').get().c;
  db.close();
  return { dir, targetId: target.id, count };
}

/**
 * Run the hook at PRODUCTION defaults. Deliberately does NOT set
 * CLAUDE_MEM_UPS_TOP_MIN / *_OR_BM25_MIN / *_IDENTIFIER_BYPASS (the sibling suite
 * neutralizes those) — the behavior under test is what a real first-day user gets.
 */
function runHook(dir, prompt, sessionId) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dir,
        CLAUDE_PROJECT_DIR: '/x/coldstart',
        PWD: '/x/coldstart',
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_QUIET_HOOKS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => {});
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 15_000);
    proc.on('close', () => { clearTimeout(killer); done(stdout); });
    proc.stdin.write(JSON.stringify({ session_id: sessionId, prompt, cwd: '/x/coldstart' }));
    proc.stdin.end();
  });
}

describe('cold-start UPS injection — the floors must not silence a first-week corpus', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  });

  it('the probe prompt carries no identifier the bypass could rescue', () => {
    // Guards the premise of every assertion below. If a future tokenizer change made
    // extractTechIdentifiers fire on CJK, the injections below would stop being
    // attributable to the floors and this suite would go vacuous without failing.
    expect(extractTechIdentifiers(PROMPT)).toEqual([]);
  });

  for (const n of [3, 4, 6]) {
    it(`injects the correct memory on a ${n}-observation corpus`, async () => {
      const { dir, targetId, count } = seedCorpus(n);
      expect(count, 'filler collapsed — fixture no longer sizes the corpus').toBe(n);
      const out = await runHook(dir, PROMPT, `cold-${n}`);
      expect(out, `no injection at all on a ${n}-row corpus`).not.toBe('');
      expect(out).toContain(`#${targetId}`);
    });
  }

  it('says nothing for an off-topic prompt on the same small corpus', async () => {
    // Counterweight against the fix degenerating into "inject something regardless":
    // near-zero floors must still not manufacture a hit for a prompt sharing no term.
    const { dir } = seedCorpus(4);
    const out = await runHook(dir, OFF_TOPIC, 'cold-noise');
    expect(out).toBe('');
  });

  it('keeps an established-size corpus on its calibrated floors', async () => {
    // At/above the calibration corpus the scale is exactly 1.0 — the safety cap. A weak
    // OR hit must stay suppressed there.
    //
    // The query matters more than it looks. An earlier version used a phrase whose top row
    // scored composite relevance EXACTLY 0; the per-row BM25_MIN_SCORE (1e-5) guard then
    // dropped it before the set-level floors were consulted, so the case was silent for a
    // reason that had nothing to do with the floors and stayed green even when the safety
    // cap was destroyed (`if (atRef) return 1` → `return 0`). This phrase produces a top
    // row at |rel| ≈ 3.1 — past the per-row guard, far below the calibrated floor of 50 —
    // so suppression here is attributable to the cap and nothing else.
    const { dir } = seedCorpus(600);
    const out = await runHook(dir, '配置默认值这块当时怎么处理的', 'warm-1');
    expect(out).toBe('');
  });
});
