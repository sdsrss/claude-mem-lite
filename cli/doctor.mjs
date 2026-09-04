// cli/doctor.mjs — `claude-mem-lite doctor --benchmark|--metrics`.
// Extracted from mem-cli.mjs (v2.41, god-module split).
//
// `doctor` without flags is handled upstream by cli.mjs (routed to install.mjs
// for install health checks). With --benchmark or --metrics it is routed to
// mem-cli which delegates to this handler.

import { resolveCliProject as cliProject } from '../lib/cli-project.mjs';
import { out } from './common.mjs';

export async function cmdDoctor(db, args) {
  if (args.includes('--benchmark')) {
    const { runBenchmark } = await import('../lib/doctor-benchmark.mjs');
    const project = cliProject(db);
    // Sample recent user prompts so the CLI report has non-null injection_rate
    // and hook latency. Without this, runBenchmark's prompts default of [] makes
    // every metric 0/null — a dead command from the user's perspective. Tests
    // bypass this CLI layer and call runBenchmark() directly, so the lib API
    // contract (default prompts=[]) is unchanged.
    let prompts = [];
    try {
      const limitIdx = args.indexOf('--prompts-limit');
      let limit = 50;
      if (limitIdx >= 0 && args[limitIdx + 1]) {
        const parsed = parseInt(args[limitIdx + 1], 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000) limit = parsed;
      }
      const rows = db.prepare(`
        SELECT p.prompt_text
        FROM user_prompts p
        JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
        WHERE s.project = ?
          AND p.prompt_text IS NOT NULL
          AND length(p.prompt_text) >= 15
        ORDER BY p.created_at_epoch DESC
        LIMIT ?
      `).all(project, limit);
      prompts = rows.map(r => r.prompt_text).filter(Boolean);
    } catch { /* missing/empty tables on a fresh DB → leave prompts=[] */ }
    const result = runBenchmark(db, { project, prompts });
    out(JSON.stringify(result, null, 2));
    return;
  }
  if (args.includes('--metrics')) {
    // v2.41: aggregate CLAUDE_MEM_METRICS=1 JSONL rows from last N days.
    // Read-side has no env gate — you can inspect whatever was recorded even
    // when metrics are currently off. Default window 7 days; --days N override.
    const { aggregateMetrics, formatSummary, DEFAULT_WINDOW_DAYS } = await import('../lib/metrics.mjs');
    const { DB_DIR } = await import('../schema.mjs');
    const daysIdx = args.indexOf('--days');
    let days = DEFAULT_WINDOW_DAYS;
    if (daysIdx >= 0 && args[daysIdx + 1]) {
      const parsed = parseInt(args[daysIdx + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 90) days = parsed;
    }
    const agg = aggregateMetrics(DB_DIR, days);
    if (args.includes('--json')) {
      out(JSON.stringify(agg, null, 2));
    } else {
      out(formatSummary(agg, days));
    }
    return;
  }
  if (args.includes('--session-audit')) {
    // v2.57.x B1: report sdk_sessions invariant violations. The v30 trigger
    // blocks new UUID-shape mix inserts; this surfaces historical drift.
    // id_mix_uuid_shape (alarming, drives exit code) is the v2.33.1 fingerprint;
    // id_mix_other (informational) is fixture-style equality — usually safe.
    const { auditSessionConsistency } = await import('../schema.mjs');
    const audit = auditSessionConsistency(db);
    if (args.includes('--json')) {
      out(JSON.stringify(audit, null, 2));
    } else {
      out(`[mem] session-audit: ${audit.healthy ? 'HEALTHY' : 'ISSUES FOUND'}`);
      out(`  id_mix_uuid_shape (v2.33.1 fingerprint):           ${audit.id_mix_uuid_shape}`);
      out(`  id_mix_other (fixture-style equality, info-only):  ${audit.id_mix_other}`);
      out(`  missing_mem_id (sdk_sessions w/ NULL after 5min):  ${audit.missing_mem_id}`);
      out(`  orphan_obs (observations w/o matching session):    ${audit.orphan_obs}`);
      out(`  obs_importance_null (NULL importance, P3-14):     ${audit.obs_importance_null}`);
      if (audit.id_mix_other > 0 && audit.id_mix_uuid_shape === 0) {
        out('\n  Notes:');
        out('    • id_mix_other > 0 with uuid_shape=0 is typically benign — usually means insertSession({id:\'X\'}) test scaffold or pre-v30 data with non-UUID equal values. Does NOT drive failure.');
      }
      if (!audit.healthy) {
        out('\n  Notes:');
        if (audit.id_mix_uuid_shape > 0) out('    • id_mix_uuid_shape > 0 — production v2.33.1 bug-pattern rows present. Investigate via SQL: SELECT * FROM sdk_sessions WHERE memory_session_id = content_session_id AND length(memory_session_id) = 36;');
        if (audit.missing_mem_id > 0) out('    • missing_mem_id rows are sessions whose mem-internal ID was never populated — likely SessionStart write that didn\'t reach Stop');
        if (audit.orphan_obs > 0) out('    • orphan_obs are observations referencing a sdk_sessions row that was deleted (FK CASCADE failed historically before v28)');
        if (audit.obs_importance_null > 0) out('    • obs_importance_null rows read as importance 1 by the CLI/hook maintenance pass (COALESCE) and as "skip" by the MCP idle pass (bare `importance <= 1`), so they decay on one face and not the other. New rows cannot reach this state (lib/observation-write.mjs coerces nullish to 1); these predate that or were written around it. Fix: UPDATE observations SET importance = 1 WHERE importance IS NULL;');
      }
    }
    if (!audit.healthy) process.exitCode = 1;
    return;
  }
  out('[mem] doctor: supported flags: --benchmark, --metrics [--days N] [--json], --session-audit');
  process.exitCode = 1;
}
