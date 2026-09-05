// Shared quality-dashboard computation — used by both mem-cli.mjs (CLI
// `stats --quality`) and server.mjs (MCP `mem_stats({quality: true})`).
// Splits pure data aggregation from text rendering so MCP handlers don't
// collide with CLI's `out()` stdout-write pattern.

import { buildNotLowSignalSql } from './low-signal-patterns.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';
import { truncate } from '../format-utils.mjs';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';

import { DAY_MS } from './time-constants.mjs';
// v3.42 F7: noise/low-signal ratios must divide by the LIVE (non-compressed) observation
// count, NOT the all-rows total. Both numerators (lowVal, lowSignalTitle) already exclude
// compressed rows (`compressed_into = 0`); dividing by an all-inclusive denominator
// systematically UNDER-reports noise on a compress-heavy mature store (the store looks
// cleaner than it is right before a maintain/compress decision). Shared by the CLI `stats`
// and MCP `mem_stats` main gauges so the two can't drift. Returns 0 when there is no live
// corpus (all-compressed / empty).
export function computeNoiseGauge({ liveTotal, lowValCount, lowSignalCount }) {
  const denom = liveTotal > 0 ? liveTotal : 0;
  return {
    noiseRatio: denom ? lowValCount / denom : 0,
    lowSignalRatio: denom ? lowSignalCount / denom : 0,
  };
}

// D#191: the rule above is a rule about POPULATIONS, and until v3.86.0 it had only
// been applied to computeNoiseGauge — a pure function that takes `liveTotal` from its
// caller. Every query below ran on a bare `FROM observations`, so `stats --quality`
// rendered ratios over all rows (compressed + superseded included) under labels that
// name no population. Numerator and denominator were paired, so each ratio was
// internally consistent; what was wrong was the population it described. Measured on
// the live store 2026-09-01 (3742 rows total, 2284 live): all-time Lesson rate read
// 59.6% where the live store is 92.9%, and all-time LOW_SIGNAL read 22.9% where the
// live store is 1.1% — compression retires exactly the low-signal, lesson-less rows,
// so an all-rows denominator reports a store roughly three decades of quality worse
// than the one retrieval actually searches.
//
// `days` is user-settable (`stats --quality --days N`), so this is NOT confined to the
// all-time bracket: the wider the window, the more compressed rows it sweeps in. The
// filter is therefore applied to the window and per-type queries too, not only to the
// two the review named, and all three now describe one population — the live corpus.
//
// Deliberately NOT filtered: `purgeRow`, whose entire subject is compressed rows.
const LIVE = liveObsFilterSql('');

export function computeQualityStats(db, { project, days }) {
  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];
  const cutoff = Date.now() - days * DAY_MS;

  // LOW_SIGNAL match = NOT notLowSignal. Pure title-only builder: this is a
  // METRIC counting pattern-titled rows ("Low-signal titles" in stats output),
  // not a retrieval filter — the lesson-escape variant would silently exclude
  // lesson-bearing rows from the count and understate title degradation.
  const lowSignalIsMatchExpr = `NOT ${buildNotLowSignalSql('')}`;

  // Narrative-text proxy for bugfix investigations that never landed a fix.
  const unresolvedNarrativeExpr = `(
    LOWER(COALESCE(narrative,'')) LIKE '%not yet identified%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%not yet resolved%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%not yet fixed%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%root cause not%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%still fail%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%errors persisted%'
    OR LOWER(COALESCE(narrative,'')) LIKE '%persisted on retry%'
  )`;

  const windowRow = db
    .prepare(
      `
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END), 0) as with_lesson,
      COALESCE(SUM(CASE WHEN ${lowSignalIsMatchExpr} THEN 1 ELSE 0 END), 0) as low_signal,
      COALESCE(SUM(CASE WHEN type = 'bugfix' THEN 1 ELSE 0 END), 0) as bugfix_total,
      COALESCE(SUM(CASE WHEN type = 'bugfix' AND ${unresolvedNarrativeExpr} THEN 1 ELSE 0 END), 0) as bugfix_unresolved
    FROM observations
    WHERE created_at_epoch >= ? AND ${LIVE} ${projectFilter}
  `,
    )
    .get(cutoff, ...baseParams);

  const allTimeRow = db
    .prepare(
      `
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END), 0) as with_lesson,
      COALESCE(SUM(CASE WHEN ${lowSignalIsMatchExpr} THEN 1 ELSE 0 END), 0) as low_signal
    FROM observations
    WHERE ${LIVE} ${projectFilter}
  `,
    )
    .get(...baseParams);

  const typeRows = db
    .prepare(
      `
    SELECT
      type,
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN COALESCE(access_count, 0) > 0 THEN 1 ELSE 0 END), 0) as accessed,
      COALESCE(SUM(CASE WHEN lesson_learned IS NOT NULL AND lesson_learned != '' THEN 1 ELSE 0 END), 0) as with_lesson
    FROM observations
    WHERE created_at_epoch >= ? AND ${LIVE} ${projectFilter}
    GROUP BY type
    ORDER BY total DESC
  `,
    )
    .all(cutoff, ...baseParams);

  const topLessons = db
    .prepare(
      `
    SELECT id, type, title, lesson_learned, COALESCE(access_count, 0) as ac
    FROM observations
    WHERE lesson_learned IS NOT NULL AND lesson_learned != ''
      AND COALESCE(access_count, 0) > 0
      AND ${LIVE}
      ${projectFilter}
    ORDER BY ac DESC
    LIMIT 5
  `,
    )
    .all(...baseParams);

  // Pending-purge backlog: compressed records waiting on the time-based purge gate.
  // High ratio signals push/pull imbalance — auto-mark fires daily but purge needs
  // age > 37d, so a sudden write surge inflates this until the cohort ages out.
  const purgeRow = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(CASE WHEN compressed_into IS NOT NULL AND compressed_into != 0 THEN 1 ELSE 0 END), 0) as compressed,
      COALESCE(SUM(CASE WHEN compressed_into = ${COMPRESSED_PENDING_PURGE} THEN 1 ELSE 0 END), 0) as pending_purge
    FROM observations
    WHERE 1=1 ${projectFilter}
  `,
    )
    .get(...baseParams);

  return { windowRow, allTimeRow, typeRows, topLessons, purgeRow, project, days };
}

export function formatQualityReport(data) {
  const { windowRow, allTimeRow, typeRows, topLessons, purgeRow, project, days } = data;
  const pct = (n, d) => (d > 0 ? ((100 * n) / d).toFixed(1) : '0.0');
  const scope = project ? ` — ${project}` : '';
  const lines = [];
  lines.push(`[mem] Quality snapshot${scope} — window: ${days}d`);
  lines.push('────────────────────────────────────────────────────');
  // Every ratio below divides live rows by live rows (D#191) — say so once, here,
  // rather than qualifying each label and still leaving the brackets ambiguous.
  lines.push(
    `  Writes (${days}d):     ${windowRow.total} live observations (compressed/superseded excluded throughout)`,
  );

  const lessonPct = pct(windowRow.with_lesson, windowRow.total);
  const allLessonPct = pct(allTimeRow.with_lesson, allTimeRow.total);
  lines.push(
    `  Lesson rate:      ${windowRow.with_lesson} / ${windowRow.total} (${lessonPct}%)    [all-time: ${allTimeRow.with_lesson} / ${allTimeRow.total} = ${allLessonPct}%]`,
  );

  const noisePct = pct(windowRow.low_signal, windowRow.total);
  const allNoisePct = pct(allTimeRow.low_signal, allTimeRow.total);
  lines.push(
    `  LOW_SIGNAL:       ${windowRow.low_signal} / ${windowRow.total} (${noisePct}%)    [all-time: ${allTimeRow.low_signal} / ${allTimeRow.total} = ${allNoisePct}%]`,
  );

  if (windowRow.bugfix_total > 0) {
    const unresolvedPct = pct(windowRow.bugfix_unresolved, windowRow.bugfix_total);
    lines.push(
      `  Unresolved bugfix: ${windowRow.bugfix_unresolved} / ${windowRow.bugfix_total} (${unresolvedPct}%)    [investigation-only narratives — should trend ↓ with R-6 manual-save contract]`,
    );
  }
  lines.push('');

  if (typeRows.length > 0) {
    lines.push(`  Type breakdown (${days}d):`);
    for (const r of typeRows) {
      const hit = pct(r.accessed, r.total);
      const lp = pct(r.with_lesson, r.total);
      const typeLabel = r.type.padEnd(10);
      lines.push(
        `    ${typeLabel}${String(r.total).padStart(5)}   hit ${hit.padStart(5)}%   lesson ${lp.padStart(5)}%`,
      );
    }
    lines.push('');
  }

  if (topLessons.length > 0) {
    lines.push('  Top accessed lessons (all-time):');
    for (const l of topLessons) {
      const t = truncate(l.lesson_learned, 80);
      lines.push(`    #${l.id} [${l.type}] (${l.ac}x) ${t}`);
    }
    lines.push('');
  }

  // R-2 watchdog — format matches historical cmdStats for test stability
  const lessonNum = parseFloat(lessonPct);
  const noiseNum = parseFloat(noisePct);
  const lessonGap = (lessonNum - 15).toFixed(1);
  const noiseGap = (noiseNum - 30).toFixed(1);
  const lessonStatus = lessonNum >= 15 ? '✅' : '🔴';
  const noiseStatus = noiseNum <= 30 ? '✅' : '🔴';
  lines.push('  Targets (R-2 watchdog):');
  lines.push(
    `    ${lessonStatus} Lesson rate ≥ 15%    → currently ${lessonPct}%  (gap ${lessonGap >= 0 ? '+' : ''}${lessonGap}pp)`,
  );
  lines.push(
    `    ${noiseStatus} LOW_SIGNAL  ≤ 30%    → currently ${noisePct}%  (gap ${noiseGap >= 0 ? '+' : ''}${noiseGap}pp)`,
  );

  // Pending-purge ratio: fraction of compressed records still waiting deletion.
  // Compressed-but-not-yet-purged is normal (37d retention floor); a high ratio
  // either means a recent write surge OR that auto-maintain isn't running.
  if (purgeRow && (purgeRow.compressed ?? 0) > 0) {
    const purgePct = pct(purgeRow.pending_purge, purgeRow.compressed);
    const purgeNum = parseFloat(purgePct);
    const purgeGap = (purgeNum - 10).toFixed(1);
    const purgeStatus = purgeNum <= 10 ? '✅' : purgeNum <= 30 ? '🟡' : '🔴';
    lines.push(
      `    ${purgeStatus} Pending purge ≤ 10%  → currently ${purgePct}% (${purgeRow.pending_purge}/${purgeRow.compressed})  (gap ${purgeGap >= 0 ? '+' : ''}${purgeGap}pp)${purgeNum > 10 ? ' — run: claude-mem-lite maintain execute --ops purge_stale --confirm' : ''}`,
    );
  }

  return lines.join('\n');
}
