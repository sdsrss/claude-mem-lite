#!/usr/bin/env node
// benchmark/cutoff-reach-probe.mjs — what PreToolUse recall's 60-day cut removes (proposal B3).
//
// scripts/pre-tool-recall.js drops every observation and event created before
// `now - PRETOOL_LOOKBACK_MS`, whatever happened to it since. The OSS landscape review
// (docs/audits/20260927-oss-landscape-optimization-proposal.md, B3) proposes timing that cut
// from a row's last USE instead. This probe answers the prior question — does the cut remove
// anything that is still in use — and it has to be ready before the cut first bites
// (2026-11-04 on the maintainer DB, whose oldest live row is 2026-09-05).
//
// POPULATION (doctrine rule 3), per source: recall's importance and liveness predicates with
// the age predicate inverted. NOT recall's full WHERE — the lesson/type fallback, the scope
// and edge-decay flags and the per-file match are left out, because the question is about
// every lesson the cut can ever hide, not one file's query:
//   • observations: file-edged (observation_files), importance >= 2, liveObsFilterSql, and
//     created_at_epoch <= cutoff. Each (obs, file) EDGE is one row, because recall fires per
//     file. Split by the edge's own record (lib/edge-attribution.mjs): `cited` (a hit stamps
//     last_cited_session_id, which is never cleared — so EVER cited; `citedThenMissed` counts
//     those passed over since, miss_streak > 0), `missed`
//     (injected and resolved, never cited), and `neverInjected` (inject_count = 0 — nothing is
//     known about its use). `cited` is the closest this data gets to "in use"; a first
//     draft also counted `miss_streak = 0`, which without a cite means never resolved at all.
//   • events: importance >= 2, not superseded, carrying file_paths, created_at_epoch <= cutoff.
//     Events keep no per-file use record, so they are counted, not split.
//
// PREMISE the proposal got wrong, stated so nobody re-derives it: "expiry is miss_streak's
// job" holds only with CLAUDE_MEM_EDGE_DECAY on, which is OFF by default. What does retire
// file lessons on a stock install, besides this cut: supersede, compress, and the daily
// `decay` maintain op, which lowers importance by one on rows older than 30 days whose
// injection_count AND access_count are both 0 (lib/maintain-core.mjs). PreToolUse recall
// updates neither counter, so an importance-2 observation that only file recall shows — never
// cited, searched or injected at prompt time — drops out of this pool at 30 days, before the
// cut. The cut is what reaches the rest: importance-3 rows and rows another face touched.
//
// Read-only: the database is opened { readonly: true } and nothing else is written.
//
//   node benchmark/cutoff-reach-probe.mjs [--project P] [--json] [--now ISO]

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { resolveDataDir } from '../lib/resolve-data-dir.mjs';
import { liveObsFilterSql } from '../lib/inject-search-core.mjs';
import { PRETOOL_LOOKBACK_MS, DAY_MS } from '../lib/time-constants.mjs';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{now?: number, project?: string|null}} [opts]
 */
export function probeCutoffReach(db, { now = Date.now(), project = null } = {}) {
  const cutoff = now - PRETOOL_LOOKBACK_MS;
  const projClause = project ? 'AND o.project = ?' : '';
  const projArgs = project ? [project] : [];
  const edges = db
    .prepare(
      `SELECT o.id, o.project, of2.filename, of2.inject_count, of2.miss_streak, of2.last_cited_session_id, o.created_at_epoch
       FROM observations o JOIN observation_files of2 ON of2.obs_id = o.id
       WHERE o.importance >= 2 AND ${liveObsFilterSql('o')} AND o.created_at_epoch <= ? ${projClause}
       ORDER BY o.created_at_epoch ASC, o.id ASC`,
    )
    .all(cutoff, ...projArgs);
  const cited = edges.filter((e) => e.last_cited_session_id);
  const neverInjected = edges.filter((e) => !e.last_cited_session_id && !(e.inject_count > 0));
  const missed = edges.length - cited.length - neverInjected.length;

  const evProj = project ? 'AND project = ?' : '';
  let events = [];
  try {
    events = db
      .prepare(
        `SELECT id, project, created_at_epoch FROM events
         WHERE importance >= 2 AND superseded_at_epoch IS NULL
           AND file_paths IS NOT NULL AND file_paths != '' AND file_paths != '[]'
           AND created_at_epoch <= ? ${evProj}
         ORDER BY created_at_epoch ASC, id ASC`,
      )
      .all(cutoff, ...projArgs);
  } catch {
    /* no events table on a very old DB */
  }

  // When the cut first bites: the oldest row that WOULD be in the population once old enough.
  const oldest = db
    .prepare(
      `SELECT MIN(o.created_at_epoch) AS e FROM observations o JOIN observation_files of2 ON of2.obs_id = o.id
       WHERE o.importance >= 2 AND ${liveObsFilterSql('o')} ${projClause}`,
    )
    .get(...projArgs)?.e;
  // Events too: an event carrying file_paths is recalled by file and cut by the same window.
  let oldestEvent = null;
  try {
    oldestEvent = db
      .prepare(
        `SELECT MIN(created_at_epoch) AS e FROM events
         WHERE importance >= 2 AND superseded_at_epoch IS NULL
           AND file_paths IS NOT NULL AND file_paths != '' AND file_paths != '[]' ${evProj}`,
      )
      .get(...projArgs)?.e;
  } catch {
    /* no events table */
  }
  const firstRow = [oldest, oldestEvent].filter(Number.isFinite);

  return {
    now: new Date(now).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    lookbackDays: PRETOOL_LOOKBACK_MS / DAY_MS,
    firstBites: firstRow.length ? new Date(Math.min(...firstRow) + PRETOOL_LOOKBACK_MS).toISOString() : null,
    obsEdges: {
      total: edges.length,
      cited: cited.length,
      citedThenMissed: cited.filter((e) => e.miss_streak > 0).length,
      missed,
      neverInjected: neverInjected.length,
      // The NAME SET is the evidence (doctrine rule 4) — the ever-cited edges the cut removes.
      inUse: cited.map((e) => ({ id: e.id, project: e.project, file: e.filename })),
    },
    events: { total: events.length, ids: events.map((e) => e.id) },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (f) => {
    const i = argv.indexOf(f);
    return i === -1 ? null : argv[i + 1];
  };
  const nowArg = arg('--now');
  const now = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(now)) {
    process.stderr.write(`cutoff-reach-probe: --now ${nowArg} is not a date\n`);
    process.exit(2);
  }
  const db = new Database(join(resolveDataDir(process.env.CLAUDE_MEM_DIR), 'claude-mem-lite.db'), {
    readonly: true,
  });
  let r;
  try {
    r = probeCutoffReach(db, { now, project: arg('--project') });
  } finally {
    db.close();
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  const o = r.obsEdges;
  console.log(`PreToolUse ${r.lookbackDays}-day cut at ${r.now} (removes rows created <= ${r.cutoff})`);
  console.log(`first bites: ${r.firstBites ?? 'never (no file-carrying live row)'}`);
  console.log(
    `observation edges removed: ${o.total}  ·  ever cited ${o.cited} (missed since ${o.citedThenMissed})  ·  missed only ${o.missed}  ·  never injected ${o.neverInjected}`,
  );
  console.log(`events removed: ${r.events.total}`);
  if (o.inUse.length) console.table(o.inUse);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
