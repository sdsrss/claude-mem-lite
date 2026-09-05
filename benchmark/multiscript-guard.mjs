#!/usr/bin/env node
// Multi-script retrieval guard — a binary regression gate for the class of change
// that silently zeroes an ENTIRE non-Latin script (the 2026-07-04 R1 HIGH: an
// emoji-drop filter used an ASCII+Han allowlist `/[a-zA-Z0-9一-鿿㐀-䶿]/` that
// dropped Cyrillic / Greek / Arabic / Hangul / Kana / Devanagari query text, so
// every such search returned null — and the A/B suites read NEUTRAL because they
// contain zero non-Latin cases). "A/B NEUTRAL ≠ safe": a tradeoff harness measures
// ranking deltas; it cannot see a script that produces no candidates at all.
//
// This guard plants one observation per script and asserts that a query IN that
// script retrieves it through the REAL production query path (searchProductionHybrid
// → sanitizeFtsQuery), where the regression lives. Non-CJK scripts index as normal
// unicode61 word tokens; CJK is made searchable by seedDatabase's bigram mirror
// (see benchmark.mjs). Emoji are tokenizer separators, so the emoji case co-locates
// an emoji with Latin content and asserts the Latin stays findable.
//
// Dev tooling only — not shipped in SOURCE_FILES. Run standalone:
//   node benchmark/multiscript-guard.mjs   (exit 1 if any script returns zero)

import { fileURLToPath } from 'url';
import { searchProductionHybrid } from './benchmark.mjs';

// project/importance/epoch/session are the columns seedDatabase reads; the extra
// `script` key is ignored by seedDatabase and only used by the guard for labels.
function doc(id, script, title, narrative, text) {
  return {
    id,
    script,
    project: 'multiscript',
    type: 'bugfix',
    title,
    narrative,
    text,
    concepts: text,
    facts: '',
    files_modified: '[]',
    importance: 2,
    epoch_offset_days: -1,
    session_id: `sess-${script}`,
  };
}

export const MULTISCRIPT_FIXTURES = {
  corpus: [
    doc(90101, 'cjk', '数据库死锁修复', '修复并发写入导致的数据库死锁问题', '数据库死锁 并发 事务 回滚'),
    doc(
      90102,
      'cyrillic',
      'Исправлено состояние гонки',
      'Добавлен мьютекс вокруг очереди планировщика',
      'состояние гонки мьютекс планировщик очередь',
    ),
    doc(
      90103,
      'greek',
      'Διόρθωση διαρροής μνήμης',
      'Ο συλλέκτης απορριμμάτων δεν απελευθέρωνε αναφορές',
      'διαρροή μνήμης συλλέκτης απορριμμάτων αναφορές',
    ),
    doc(
      90104,
      'arabic',
      'إصلاح تسرب الذاكرة',
      'لم يكن جامع القمامة يحرر المراجع القديمة',
      'تسرب الذاكرة جامع القمامة مراجع',
    ),
    doc(
      90105,
      'hangul',
      '메모리 누수 수정',
      '가비지 컬렉터가 오래된 참조를 해제하지 않음',
      '메모리 누수 가비지 컬렉터 참조',
    ),
    doc(
      90106,
      'kana',
      'メモリリークの修正',
      'ガベージコレクタが古い参照を解放しなかった',
      'メモリリーク ガベージコレクタ 参照',
    ),
    doc(
      90107,
      'devanagari',
      'स्मृति रिसाव ठीक किया',
      'कचरा संग्राहक पुराने संदर्भ जारी नहीं कर रहा था',
      'स्मृति रिसाव कचरा संग्राहक संदर्भ',
    ),
    doc(
      90108,
      'emoji-latin',
      'Deploy rocket 🚀 canary pipeline',
      'Rolled out the 🚀 canary release pipeline with automatic rollback',
      'deploy 🚀 rocket canary pipeline rollback',
    ),
  ],
  queries: [
    { script: 'cjk', query: '数据库死锁', expectId: 90101 },
    { script: 'cyrillic', query: 'состояние гонки', expectId: 90102 },
    { script: 'greek', query: 'διαρροή μνήμης', expectId: 90103 },
    { script: 'arabic', query: 'تسرب الذاكرة', expectId: 90104 },
    { script: 'hangul', query: '메모리 누수', expectId: 90105 },
    { script: 'kana', query: 'メモリリーク', expectId: 90106 },
    { script: 'devanagari', query: 'स्मृति रिसाव', expectId: 90107 },
    { script: 'emoji-latin', query: '🚀 rocket pipeline', expectId: 90108 },
  ],
};

/**
 * Run each script's query through the production search path and report whether the
 * planted doc was retrieved. searchFn is injected so a test can drive a broken
 * transform and prove the guard has teeth. Pure over the DB (read-only search).
 * @returns {Array<{script,query,expectId,found:boolean,resultIds:number[]}>}
 */
export function runScriptGuard(db, { queries, searchFn, limit = 10 } = {}) {
  const qs = queries || MULTISCRIPT_FIXTURES.queries;
  const search = searchFn || ((query) => searchProductionHybrid(db, query, { limit }));
  return qs.map(({ script, query, expectId }) => {
    const resultIds = search(query, limit).map((r) => r.id);
    return { script, query, expectId, found: resultIds.includes(expectId), resultIds };
  });
}

async function main() {
  const { createTestDb } = await import('../tests/test-helpers.mjs');
  const { seedDatabase } = await import('./benchmark.mjs');
  const db = createTestDb();
  seedDatabase(db, { observations: MULTISCRIPT_FIXTURES.corpus });
  const report = runScriptGuard(db);
  db.close();

  console.error('\n─── Multi-script retrieval guard (planted doc per script) ───');
  let ok = true;
  for (const r of report) {
    const mark = r.found ? '✓' : '✗ ZERO-RESULT';
    if (!r.found) ok = false;
    console.error(`  ${r.script.padEnd(14)} ${mark}  "${r.query}" → [${r.resultIds.join(',')}]`);
  }
  console.error(
    ok
      ? '\n  PASS — every script retrievable\n'
      : '\n  FAIL — a script returned zero results (non-Latin regression)\n',
  );
  process.exit(ok ? 0 : 1);
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\.mjs$/, ''));
if (isMain) main();
