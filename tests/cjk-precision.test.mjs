// CJK precision filter — regression tests for the read-path parity bundle.
//
// Root cause: this build's FTS5 unicode61 tokenizer indexes an entire CJK run
// as ONE token (it does NOT split each CJK character). CJK text is made
// searchable by the write path storing content + space-separated overlapping
// bigrams; sanitizeFtsQuery likewise reduces a query to bigrams (emits "我是
// 是完 完全 ..." for unknown compounds). After the AND→OR fallback, any Chinese
// prose sharing even one common bigram leaks as a hit. The `cjkPrecisionOk`
// post-filter requires a fraction of the query's bigrams/keywords to appear as
// contiguous substrings in the candidate text — see nlp.mjs.
//
// This file covers:
//   1. Unit behavior of cjkPrecisionOk (pass/fail matrix)
//   2. CLI search via cmdSearch (mem-cli.mjs prompts branch)
//   3. UserPromptSubmit subprocess via user-prompt-search.js
//   (server.mjs branch is identical logic; covered by unit + MCP protocol test)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cjkPrecisionOk } from '../nlp.mjs';
import { insertSession, insertPrompt } from './test-helpers.mjs';
import { spawn } from 'child_process';
import { resolve } from 'path';

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/user-prompt-search.js');

describe('cjkPrecisionOk unit behavior', () => {
  it('bypasses non-CJK queries unconditionally', () => {
    expect(cjkPrecisionOk('search tokens', 'completely unrelated text')).toBe(true);
    expect(cjkPrecisionOk('fix FTS5 bug', '')).toBe(true);
    expect(cjkPrecisionOk('', 'anything')).toBe(true);
  });

  it('accepts results that share a full dictionary keyword with the query', () => {
    // "修复" and "搜索" are known CJK compounds — dictionary path engaged.
    expect(cjkPrecisionOk('修复FTS搜索的CJK误报', 'CJK FTS 搜索 修复方案')).toBe(true);
  });

  it('rejects noise CJK prose that only shares common single chars', () => {
    // Query has no dict keywords → falls back to bigrams. Random prose
    // containing "我是" alone gives 1/11 ≈ 9% < 30% threshold.
    const noise = '我是完全随机的字符串啊啊';
    const prose = '我是想审核一下移动端的界面';
    expect(cjkPrecisionOk(noise, prose)).toBe(false);
  });

  it('bypasses an all-particle query (every bigram is grammatical glue)', () => {
    // Regression: a query made only of particles (的了是) produced bigrams 的了 / 了是.
    // The old filter tested each 2-char bigram against the single-char CJK_STOP_WORDS
    // set, so neither was filtered → `required` was non-empty → every candidate was
    // wrongly rejected. Now isCjkNoiseBigram drops bigrams whose BOTH chars are stop
    // words, so `required` empties and the gate bypasses (returns true).
    expect(cjkPrecisionOk('的了是', 'this document has no chinese at all')).toBe(true);
  });

  it('still keeps single-particle compounds (有效/目的) — no over-rejection', () => {
    // A bigram with only ONE stop char is a real compound, not glue. The query keeps a
    // meaningful required term so genuinely-matching prose passes and unrelated fails.
    expect(cjkPrecisionOk('有效的方法', '这是一个有效的方法说明')).toBe(true);
    expect(cjkPrecisionOk('有效的方法', 'totally unrelated english prose here')).toBe(false);
  });

  it('rejects prose when it shares zero query keywords', () => {
    // "中文查询测试不存在" → dict keywords [中文, 查询, 测试]
    // Prose shares none (weather small-talk) → 0/3 = 0% < 30% → rejected.
    const q = '中文查询测试不存在';
    const prose = '今天天气不错，我们来玩游戏吧';
    expect(cjkPrecisionOk(q, prose)).toBe(false);
  });

  it('accepts prose matching enough bigrams via substring', () => {
    const q = '中文查询测试';
    const prose = '用户提交了中文查询，测试通过';
    expect(cjkPrecisionOk(q, prose)).toBe(true);
  });

  it('threshold is tunable', () => {
    // Same inputs, stricter threshold flips the decision.
    const q = '修复FTS搜索的CJK误报';
    const prose = '修复 了一些东西';
    expect(cjkPrecisionOk(q, prose, 0.1)).toBe(true);
    expect(cjkPrecisionOk(q, prose, 0.9)).toBe(false);
  });

  it('threshold defaults read CLAUDE_MEM_CJK_PREC_MIN env var', () => {
    // Omitting threshold uses env var if set to a valid 0..1 value.
    const q = '修复FTS搜索的CJK误报';
    const prose = '修复 了一些东西'; // ~1/3 keyword coverage
    const original = process.env.CLAUDE_MEM_CJK_PREC_MIN;
    try {
      process.env.CLAUDE_MEM_CJK_PREC_MIN = '0.9';
      expect(cjkPrecisionOk(q, prose)).toBe(false);
      process.env.CLAUDE_MEM_CJK_PREC_MIN = '0.1';
      expect(cjkPrecisionOk(q, prose)).toBe(true);
      // Invalid env values fall back to the 0.2 default.
      process.env.CLAUDE_MEM_CJK_PREC_MIN = 'garbage';
      expect(cjkPrecisionOk(q, prose)).toBe(true); // default 0.2 passes (1/3 ≈ 33% ≥ 0.2)
      process.env.CLAUDE_MEM_CJK_PREC_MIN = '2.5';
      expect(cjkPrecisionOk(q, prose)).toBe(true); // out-of-range → default
    } finally {
      if (original === undefined) delete process.env.CLAUDE_MEM_CJK_PREC_MIN;
      else process.env.CLAUDE_MEM_CJK_PREC_MIN = original;
    }
  });

  it('explicit threshold arg overrides env var', () => {
    const q = '修复FTS搜索';
    const prose = '修复了一些东西';
    const original = process.env.CLAUDE_MEM_CJK_PREC_MIN;
    try {
      process.env.CLAUDE_MEM_CJK_PREC_MIN = '0.9';
      // Explicit low threshold wins over strict env setting.
      expect(cjkPrecisionOk(q, prose, 0.1)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.CLAUDE_MEM_CJK_PREC_MIN;
      else process.env.CLAUDE_MEM_CJK_PREC_MIN = original;
    }
  });
});

describe('user-prompt-search.js CJK precision filter (subprocess)', () => {
  let db;
  const DB_DIR = `/tmp/cjk-prec-test-${process.pid}`;

  beforeEach(async () => {
    const { mkdirSync, rmSync } = await import('fs');
    try {
      rmSync(DB_DIR, { recursive: true });
    } catch {}
    mkdirSync(DB_DIR, { recursive: true });
    mkdirSync(`${DB_DIR}/runtime`, { recursive: true });
    const Database = (await import('better-sqlite3')).default;
    const { initSchema } = await import('../schema.mjs');
    db = new Database(`${DB_DIR}/claude-mem-lite.db`);
    initSchema(db);
    insertSession(db, { id: 'sess-1', project: 'test--project' });
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {}
    const { rmSync } = await import('fs');
    try {
      rmSync(DB_DIR, { recursive: true });
    } catch {}
  });

  function runScript(promptText) {
    return new Promise((ok) => {
      // CLAUDE_PROJECT_DIR + PWD drive inferProject() → 'test--project',
      // matching the seed session's project field so SQL JOIN lines up.
      // CLAUDE_MEM_UPS_TOP_MIN='0' disables the top-|rel| gate (sparse test
      // corpus can't reach the production-calibrated floor).
      const env = {
        ...process.env,
        CLAUDE_MEM_DIR: DB_DIR,
        CLAUDE_PROJECT_DIR: '/test/project',
        PWD: '/test/project',
        CLAUDE_MEM_UPS_TOP_MIN: '0',
        CLAUDE_MEM_HOOK_RUNNING: '',
      };
      const proc = spawn(process.execPath, [SCRIPT_PATH], { env });
      let stdout = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.on('close', () => ok(stdout));
      proc.stdin.write(
        JSON.stringify({
          prompt: promptText,
          hook_event_name: 'UserPromptSubmit',
          cwd: '/test/project',
          session_id: 'test-sess-1',
        }),
      );
      proc.stdin.end();
    });
  }

  it('rejects noise CJK prompt even when prior prompts share common chars', async () => {
    // Seed a prior prompt with common Chinese chars — under unicode61, an
    // AND of single chars (我/是/的/完/全) would historically match. The
    // precision filter rejects because bigram substring coverage < 30%.
    insertPrompt(db, {
      contentSessionId: 'sess-1',
      text: '我是想排查一下移动端的界面，排除掉 docs 目录',
    });
    db.pragma('wal_checkpoint(FULL)');

    const stdout = await runScript('我是完全随机的字符串啊啊');
    expect(stdout).not.toContain('[mem] FYI — Past similar questions');
  });

  // Regression: the observed leak was not the FTS5 path (which returned 0
  // rows on the noise query) but the CJK LIKE fallback (`LIKE %我是% OR
  // %是完% OR ...`) that the CLI/MCP use when FTS5 returns empty. The
  // precision filter must also gate the fallback — otherwise real-world
  // queries re-admit the same noise the FTS side dropped upstream.
  it('rejects noise CJK via LIKE fallback too (FTS returns 0, fallback fills)', async () => {
    // Two prompts share common Chinese chars with the noise query but no
    // coherent multi-bigram overlap. FTS5 unicode61 won't match (each
    // bigram re-tokenizes into single chars → implicit AND against all
    // of them fails). The LIKE fallback would match on any bigram
    // substring (e.g. "我是"), so it's the real leak path.
    insertPrompt(db, { contentSessionId: 'sess-1', text: '我是想排查移动端界面' });
    insertPrompt(db, { contentSessionId: 'sess-1', text: '完全不相关的另一条历史提示' });
    db.pragma('wal_checkpoint(FULL)');

    const stdout = await runScript('我是完全随机的字符串啊啊');
    // Pre-fix behavior: 1-2 prompts leaked via LIKE fallback. Post-fix:
    // precision gate rejects both (neither reaches 30% bigram overlap).
    expect(stdout).not.toContain('我是想排查');
    expect(stdout).not.toContain('完全不相关');
  });

  it('still surfaces real CJK signal (keyword-level match)', async () => {
    insertPrompt(db, {
      contentSessionId: 'sess-1',
      text: '能否优化一下 FTS5 查询的 CJK 搜索精度？',
    });
    db.pragma('wal_checkpoint(FULL)');

    const stdout = await runScript('FTS5 CJK 搜索 的 查询精度 怎么提升');
    expect(stdout).toContain('[mem] FYI — Past similar questions');
    expect(stdout).toMatch(/FTS5|查询|搜索/);
  });
});

// v2.57.x: UPS explicit-signal gate. Per cite-recall baseline (2026-04-22 →
// 2026-05-09) UserPromptSubmit recall = 25.8% — 74% of injections silently
// ignored. Gate retreats to "only inject when prompt names something
// concrete": error signature, file ref, detected intent, or tech identifier.
// "How is it going?" / "does this work?" → no injection. PreToolUse
// file-keyed path (94% recall) is independent and unaffected.
describe('user-prompt-search.js explicit-signal gate (subprocess)', () => {
  let db;
  const DB_DIR = `/tmp/ups-signal-test-${process.pid}`;

  beforeEach(async () => {
    const { mkdirSync, rmSync } = await import('fs');
    try {
      rmSync(DB_DIR, { recursive: true });
    } catch {}
    mkdirSync(DB_DIR, { recursive: true });
    mkdirSync(`${DB_DIR}/runtime`, { recursive: true });
    const Database = (await import('better-sqlite3')).default;
    const { initSchema } = await import('../schema.mjs');
    db = new Database(`${DB_DIR}/claude-mem-lite.db`);
    initSchema(db);
    insertSession(db, { id: 'sess-1', project: 'test--project' });
    // Seed prompts that BM25 will surface — used to verify gate behavior:
    // when signal present, the matching seed gets injected; when absent,
    // even with BM25-matching seeds in the corpus, nothing comes out.
    insertPrompt(db, {
      contentSessionId: 'sess-1',
      text: 'how does the MAX_RESULTS variable work in the does_this codebase',
    });
    insertPrompt(db, {
      contentSessionId: 'sess-1',
      text: 'parseJsonFromLLM helper handles Haiku response parsing',
    });
    db.pragma('wal_checkpoint(FULL)');
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {}
    const { rmSync } = await import('fs');
    try {
      rmSync(DB_DIR, { recursive: true });
    } catch {}
  });

  function runScript(promptText, extraEnv = {}) {
    return new Promise((ok) => {
      const env = {
        ...process.env,
        CLAUDE_MEM_DIR: DB_DIR,
        CLAUDE_PROJECT_DIR: '/test/project',
        PWD: '/test/project',
        CLAUDE_MEM_UPS_TOP_MIN: '0',
        CLAUDE_MEM_HOOK_RUNNING: '',
        ...extraEnv,
      };
      const proc = spawn(process.execPath, [SCRIPT_PATH], { env });
      let stdout = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.on('close', () => ok(stdout));
      proc.stdin.write(
        JSON.stringify({
          prompt: promptText,
          hook_event_name: 'UserPromptSubmit',
          cwd: '/test/project',
          session_id: 'test-sess-1',
        }),
      );
      proc.stdin.end();
    });
  }

  it('no-signal prompt yields no injection (gate ON by default)', async () => {
    // "Does this work?" has no tech identifier (single lowercase words),
    // no error signature, no file reference, no recall intent, no actionable
    // intent keyword (test/bug/refactor/etc). Pre-fix: FTS would happily
    // surface the seeded MAX_RESULTS prompt via stem overlap on "does/work".
    // Post-fix: gate rejects upstream — no injection.
    const stdout = await runScript('Does this work fine for me');
    expect(stdout).not.toContain('[mem] FYI');
  });

  it('tech-identifier signal triggers injection (gate ON by default)', async () => {
    // "MAX_RESULTS" matches TECH_IDENTIFIER_RE ([A-Z]{2,}[A-Z0-9_]+) — a
    // concrete identifier the user is naming. Gate accepts → existing FTS
    // pipeline finds the seeded prompt and injects it.
    const stdout = await runScript('what is MAX_RESULTS configured to');
    expect(stdout).toContain('[mem] FYI — Past similar questions');
  });

  it('CLAUDE_MEM_UPS_REQUIRE_SIGNAL=0 restores always-search behavior', async () => {
    // Same no-signal prompt as the first case, but with the env override —
    // gate disabled, FTS pipeline runs as before, seeded prompt surfaces.
    // Backwards-compatibility escape hatch for projects that prefer the old
    // always-search policy (and accept the lower cite-recall).
    const stdout = await runScript('Does this work fine for me', {
      CLAUDE_MEM_UPS_REQUIRE_SIGNAL: '0',
    });
    expect(stdout).toContain('[mem] FYI — Past similar questions');
  });

  // Post-review fix Important #1: TECH_IDENTIFIER_RE was too loose. Bare
  // 3+-letter caps without underscore (IBM, NPM, BSD, THE, FROM) and
  // single-lowercase-before-cap "iOS"-shaped words slipped through. Tightened
  // to require underscore for ALL_CAPS arm and ≥2 lowercase before cap for
  // camelCase arm. These regression cases were named explicitly by reviewer.
  it('English prose acronyms (IBM, NPM, THE) do NOT trigger gate alone', async () => {
    const stdout = await runScript('IBM Watson is interesting');
    expect(stdout).not.toContain('[mem] FYI');
  });

  it('iOS / eBay -style 1-lowercase-before-cap words do NOT trigger gate alone', async () => {
    const stdout = await runScript('the iOS port is a bit different');
    expect(stdout).not.toContain('[mem] FYI');
  });

  it('snake_case identifier (MAX_RESULTS) DOES trigger', async () => {
    // CONST_CASE arm now requires underscore (`[A-Z][A-Z0-9]*_[A-Z0-9_]+`).
    // MAX_RESULTS matches; bare IBM does not.
    const stdout = await runScript('what is MAX_RESULTS configured to');
    expect(stdout).toContain('[mem] FYI');
  });

  it('camelCase identifier (parseJsonFromLLM) DOES trigger', async () => {
    // Stricter arm `[a-z]{2,}[A-Z][a-zA-Z0-9]+` requires ≥2 lowercase before
    // the first uppercase — "parseJson" qualifies; "iOS" does not.
    const stdout = await runScript('look at parseJsonFromLLM behavior');
    expect(stdout).toContain('[mem] FYI');
  });
});

// Post-review fix Important #2: CJK presence channel. Bilingual users
// (the project's user-memory `feedback_*` calls this out) ask CJK-only
// debug questions that don't match any English signal channel. CJK is
// information-dense — an 8-effective-unit prompt rarely encodes
// "how is it going"-style noise.
describe('user-prompt-search.js CJK channel (subprocess)', () => {
  let db;
  const DB_DIR = `/tmp/ups-cjk-channel-test-${process.pid}`;

  beforeEach(async () => {
    const { mkdirSync, rmSync } = await import('fs');
    try {
      rmSync(DB_DIR, { recursive: true });
    } catch {}
    mkdirSync(DB_DIR, { recursive: true });
    mkdirSync(`${DB_DIR}/runtime`, { recursive: true });
    const Database = (await import('better-sqlite3')).default;
    const { initSchema } = await import('../schema.mjs');
    db = new Database(`${DB_DIR}/claude-mem-lite.db`);
    initSchema(db);
    insertSession(db, { id: 'sess-1', project: 'test--project' });
    // Seed a Chinese prompt that BM25 will match on shared chars.
    insertPrompt(db, {
      contentSessionId: 'sess-1',
      text: '为什么这里返回 undefined 还是 null',
    });
    db.pragma('wal_checkpoint(FULL)');
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {}
    const { rmSync } = await import('fs');
    try {
      rmSync(DB_DIR, { recursive: true });
    } catch {}
  });

  function runScript(promptText, extraEnv = {}) {
    return new Promise((ok) => {
      const env = {
        ...process.env,
        CLAUDE_MEM_DIR: DB_DIR,
        CLAUDE_PROJECT_DIR: '/test/project',
        PWD: '/test/project',
        CLAUDE_MEM_UPS_TOP_MIN: '0',
        CLAUDE_MEM_HOOK_RUNNING: '',
        ...extraEnv,
      };
      const proc = spawn(process.execPath, [SCRIPT_PATH], { env });
      let stdout = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.on('close', () => ok(stdout));
      proc.stdin.write(
        JSON.stringify({
          prompt: promptText,
          hook_event_name: 'UserPromptSubmit',
          cwd: '/test/project',
          session_id: 'test-sess-1',
        }),
      );
      proc.stdin.end();
    });
  }

  // Note: a positive "long CJK prompt → injection happens" subprocess test
  // is intentionally NOT included here. FTS5's default unicode61 tokenizer
  // splits CJK into single chars + the cjkPrecisionOk filter further trims;
  // the existing CJK precision suite contains zero pure-CJK successful-
  // injection assertions because that path is FTS-tokenizer-dominated, not
  // gate-dominated. The CJK channel is unit-testable via hasExplicitSignal
  // export (covered by the "very short CJK does NOT pass" + manual code
  // inspection of CJK_CHAR_RE / CJK_MIN_EFFECTIVE_LEN).

  it('very short CJK prompt (below 8 effective units) does NOT pass on CJK channel alone', async () => {
    // 2 CJK chars × 3 = 6 effective units < 8 threshold. Also passes
    // shouldSkip's effective-length 8-unit gate (just barely doesn't),
    // but my CJK channel threshold is also 8.
    const stdout = await runScript('好的');
    expect(stdout).not.toContain('[mem] FYI');
  });
});
