#!/usr/bin/env node
// Deferred-work reachability probes — G5 ③ (roadmap 2026-07-18).
//
// The v3.50.0 D#92 fix made deferred items reachable from search (CLI/MCP
// trailer via searchDeferredWork), but the denoise metric suites never execute
// that leg — a regression there reads NEUTRAL forever. These probes plant
// bilingual deferred items and assert BOTH directions on the REAL
// searchDeferredWork: positives must reach their item, noise queries must stay
// silent (an always-on trailer is the injection-noise failure mode). `searchFn`
// is injectable so tests can prove the probes have teeth.
//
// Dev tooling only — not shipped in SOURCE_FILES. Run standalone:
//   node benchmark/deferred-probes.mjs   (exit 1 on any probe failure)

import { fileURLToPath } from 'url';
import { insertDeferred, searchDeferredWork } from '../lib/deferred-work.mjs';

const PROJECT = 'deferred-probe';

export const DEFERRED_FIXTURES = {
  project: PROJECT,
  items: [
    {
      title: '升级 CI runner 到 ubuntu-24',
      detail: '现 runner 镜像 EOL,需迁移 workflow 与缓存 key',
      priority: 2,
    },
    {
      title: 'Migrate signing key rotation runbook',
      detail: 'Ed25519 key rotation steps live only in chat; write docs/runbook',
      priority: 3,
    },
    {
      title: '补充 vitest 全局 env 缺口',
      detail: 'MEM_QUIET_HOOKS 与 CLAUDE_MEM_DIR 未在全局 setup 固定',
      priority: 2,
    },
    {
      title: 'Refactor episode flush batching',
      detail: 'flush groups by ccSession; consider time-window compaction',
      priority: 1,
    },
    { title: '对账任务分区键评估', detail: '按日期分区后冷分区归档策略未定', priority: 2 },
    {
      title: 'Add retry to release manifest upload',
      detail: 'transient 503 from GH API kills sign step',
      priority: 2,
    },
  ],
  // Query → the planted title it must reach (CJK, English, and mixed forms).
  positives: [
    { query: 'ci runner 迁移', expectTitle: '升级 CI runner 到 ubuntu-24' },
    { query: 'key rotation runbook', expectTitle: 'Migrate signing key rotation runbook' },
    { query: 'vitest env', expectTitle: '补充 vitest 全局 env 缺口' },
    { query: 'episode flush', expectTitle: 'Refactor episode flush batching' },
    { query: '冷分区 归档', expectTitle: '对账任务分区键评估' },
    { query: 'manifest upload 503', expectTitle: 'Add retry to release manifest upload' },
  ],
  // Vocabulary disjoint from every planted title+detail — a match here means the
  // trailer fires on noise.
  negatives: [
    'quantum blockchain sharding',
    '前端 路由 动画',
    'grpc streaming backpressure',
    'kubernetes operator webhook',
  ],
};

/**
 * Plant the fixture items (fresh DB expected) and run both probe directions
 * through the (injectable) search fn.
 * @returns {Array<{kind:'positive'|'negative', query:string, pass:boolean, got:string[]}>}
 */
export function runDeferredProbes(db, { searchFn = searchDeferredWork } = {}) {
  for (const item of DEFERRED_FIXTURES.items) {
    insertDeferred(db, { project: PROJECT, ...item });
  }
  const out = [];
  for (const { query, expectTitle } of DEFERRED_FIXTURES.positives) {
    const got = (searchFn(db, query, PROJECT) || []).map((r) => r.title);
    out.push({ kind: 'positive', query, pass: got.includes(expectTitle), got });
  }
  for (const query of DEFERRED_FIXTURES.negatives) {
    const got = (searchFn(db, query, PROJECT) || []).map((r) => r.title);
    out.push({ kind: 'negative', query, pass: got.length === 0, got });
  }
  return out;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1].replace(/\.mjs$/, ''));
if (isMain) {
  const { createTestDb } = await import('../tests/test-helpers.mjs');
  const db = createTestDb();
  const results = runDeferredProbes(db);
  for (const p of results)
    console.error(
      `  ${p.pass ? '✓' : '✗'} [${p.kind}] "${p.query}"${p.pass ? '' : ` — got: ${p.got.join(' | ') || '(none)'}`}`,
    );
  db.close();
  const failed = results.filter((p) => !p.pass);
  if (failed.length) {
    console.error(`\n${failed.length} probe(s) FAILED`);
    process.exit(1);
  }
  console.error(`\nall ${results.length} probes pass`);
}
