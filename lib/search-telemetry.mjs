import { parseIdToken } from './id-routing.mjs';
import { notLowSignalTitleClause } from '../scoring-sql.mjs';
import { TIER_CASE_SQL, tierSqlParams } from '../tier.mjs';
import { DAY_MS } from './time-constants.mjs';
import { liveObsFilterSql } from './inject-search-core.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';

const SOURCE_PREFIX = { obs: '#', session: 'S#', prompt: 'P#', event: 'E#' };
const DISPLAY_ID_RE = /^(?:#|[SPE]#)\d+$/i;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function ensureSearchTelemetrySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_runs (
      search_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      query TEXT NOT NULL,
      surface TEXT NOT NULL CHECK(surface = 'mcp_search'),
      search_mode TEXT NOT NULL,
      corpus_counts_json TEXT NOT NULL DEFAULT '{}',
      matched_count INTEGER NOT NULL DEFAULT 0,
      returned_count INTEGER NOT NULL DEFAULT 0,
      client TEXT NOT NULL,
      producer_version TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_results (
      search_id INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('obs', 'session', 'prompt', 'event')),
      result_id INTEGER NOT NULL,
      returned_rank INTEGER NOT NULL,
      page_offset INTEGER NOT NULL DEFAULT 0,
      snapshot_label TEXT,
      relevance TEXT CHECK(relevance IN ('relevant', 'partial', 'irrelevant')),
      rated_by TEXT,
      rated_at TEXT,
      rated_at_epoch INTEGER,
      PRIMARY KEY (search_id, source, result_id),
      FOREIGN KEY(search_id) REFERENCES search_runs(search_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_search_runs_time ON search_runs(created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_search_runs_project_time ON search_runs(project, created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_search_results_identity ON search_results(source, result_id);
  `);
}

function snapshotLabel(row) {
  const label =
    row.title || row.subtitle || row.request || row.completed || row.text || row.prompt_text || '(untitled)';
  return scrubSecrets(String(label)).slice(0, 500);
}

function withNonblockingWrite(db, fn) {
  const prior = db.pragma('busy_timeout', { simple: true });
  const parsedPrior = Number(prior);
  const restoreTimeout = Number.isFinite(parsedPrior) ? parsedPrior : DEFAULT_BUSY_TIMEOUT_MS;
  db.pragma('busy_timeout = 0');
  try {
    return fn();
  } finally {
    db.pragma(`busy_timeout = ${restoreTimeout}`);
  }
}

export function recordSearch(
  db,
  {
    project = null,
    query = '',
    surface,
    searchMode = 'normal',
    corpusCounts = {},
    matchedCount = 0,
    results = [],
    pageOffset = 0,
    client,
    producerVersion = null,
    now = Date.now(),
  },
) {
  return withNonblockingWrite(db, () => {
    ensureSearchTelemetrySchema(db);
    return db.transaction(() => {
      const createdAt = new Date(now).toISOString();
      const run = db
        .prepare(
          `
      INSERT INTO search_runs
        (project, query, surface, search_mode, corpus_counts_json, matched_count,
         returned_count, client, producer_version, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(
          project,
          scrubSecrets(String(query)).trim().slice(0, 500),
          surface,
          searchMode,
          JSON.stringify(corpusCounts),
          matchedCount,
          results.length,
          scrubSecrets(String(client)).trim().slice(0, 500),
          producerVersion === null ? null : scrubSecrets(String(producerVersion)).trim().slice(0, 100),
          createdAt,
          now,
        );
      const searchId = Number(run.lastInsertRowid);
      const insertResult = db.prepare(`
      INSERT INTO search_results
        (search_id, source, result_id, returned_rank, page_offset, snapshot_label)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
      results.forEach((row, index) =>
        insertResult.run(
          searchId,
          row.source,
          row.id,
          pageOffset + index + 1,
          pageOffset,
          snapshotLabel(row),
        ),
      );
      return searchId;
    })();
  });
}

export function rateSearchResults(
  db,
  { searchId, relevant = [], partiallyRelevant = [], irrelevant = [], ratedBy, now = Date.now() },
) {
  ensureSearchTelemetrySchema(db);
  const groups = [
    ['relevant', relevant],
    ['partial', partiallyRelevant],
    ['irrelevant', irrelevant],
  ];
  const ratings = [];
  const seen = new Set();
  for (const [value, tokens] of groups) {
    for (const raw of tokens) {
      const token = String(raw).trim();
      if (!DISPLAY_ID_RE.test(token)) throw new Error(`Invalid result ID: ${token}`);
      const parsed = parseIdToken(token);
      const source = parsed?.source || 'obs';
      const key = `${source}:${parsed?.id}`;
      if (seen.has(key)) throw new Error(`Result rated more than once: ${token}`);
      seen.add(key);
      ratings.push({ source, id: parsed.id, value, token });
    }
  }
  if (ratings.length === 0) throw new Error('Rate at least one returned result');

  return withNonblockingWrite(db, () =>
    db.transaction(() => {
      const run = db.prepare('SELECT search_id FROM search_runs WHERE search_id = ?').get(searchId);
      if (!run) throw new Error(`Search ${searchId} not found`);
      const exists = db.prepare(`
      SELECT 1 FROM search_results WHERE search_id = ? AND source = ? AND result_id = ?
    `);
      for (const rating of ratings) {
        if (!exists.get(searchId, rating.source, rating.id)) {
          throw new Error(`${rating.token} was not returned by search ${searchId}`);
        }
      }
      const ratedAt = new Date(now).toISOString();
      const update = db.prepare(`
      UPDATE search_results
      SET relevance = ?, rated_by = ?, rated_at = ?, rated_at_epoch = ?
      WHERE search_id = ? AND source = ? AND result_id = ?
    `);
      for (const rating of ratings) {
        update.run(rating.value, ratedBy, ratedAt, now, searchId, rating.source, rating.id);
      }
      return ratings.length;
    })(),
  );
}

function count(db, sql, params = []) {
  return db.prepare(sql).get(...params)?.c ?? 0;
}

export function countMcpEligibleCorpus(
  db,
  {
    effectiveSource = null,
    obsTypeScoped = false,
    project = null,
    obsType = null,
    importance = null,
    branch = null,
    includeNoise = false,
    epochFrom = null,
    epochTo = null,
    tier = null,
    currentProject = null,
  },
) {
  const counts = {};
  if (!effectiveSource || effectiveSource === 'observations') {
    const where = [liveObsFilterSql('')];
    const params = [];
    if (project) {
      where.push('project = ?');
      params.push(project);
    }
    if (obsType) {
      where.push('type = ?');
      params.push(obsType);
    }
    if (epochFrom !== null) {
      where.push('created_at_epoch >= ?');
      params.push(epochFrom);
    }
    if (epochTo !== null) {
      where.push('created_at_epoch <= ?');
      params.push(epochTo);
    }
    if (importance) {
      where.push('COALESCE(importance, 1) >= ?');
      params.push(importance);
    }
    if (branch) {
      where.push('branch = ?');
      params.push(branch);
    }
    if (!includeNoise) where.push(notLowSignalTitleClause(''));
    if (tier) {
      where.push(`${TIER_CASE_SQL} = ?`);
      params.push(...tierSqlParams({ now: Date.now(), currentProject, currentSessionId: '' }), tier);
    }
    counts.obs = count(db, `SELECT COUNT(*) AS c FROM observations WHERE ${where.join(' AND ')}`, params);
  }
  if (!obsTypeScoped && (!effectiveSource || effectiveSource === 'sessions')) {
    const where = ['1=1'];
    const params = [];
    if (project) {
      where.push('project = ?');
      params.push(project);
    }
    if (epochFrom !== null) {
      where.push('created_at_epoch >= ?');
      params.push(epochFrom);
    }
    if (epochTo !== null) {
      where.push('created_at_epoch <= ?');
      params.push(epochTo);
    }
    counts.session = count(
      db,
      `SELECT COUNT(*) AS c FROM session_summaries WHERE ${where.join(' AND ')}`,
      params,
    );
  }
  if (!obsTypeScoped && (!effectiveSource || effectiveSource === 'prompts')) {
    const where = ["p.prompt_text NOT LIKE '<task-notification>%'"];
    const params = [];
    if (project) {
      where.push('s.project = ?');
      params.push(project);
    }
    if (epochFrom !== null) {
      where.push('p.created_at_epoch >= ?');
      params.push(epochFrom);
    }
    if (epochTo !== null) {
      where.push('p.created_at_epoch <= ?');
      params.push(epochTo);
    }
    counts.prompt = count(
      db,
      `SELECT COUNT(*) AS c FROM user_prompts p JOIN sdk_sessions s ON p.content_session_id = s.content_session_id WHERE ${where.join(' AND ')}`,
      params,
    );
  }
  if (!effectiveSource || effectiveSource === 'events') {
    const where = ['superseded_at_epoch IS NULL'];
    const params = [];
    if (project) {
      where.push('project = ?');
      params.push(project);
    }
    if (obsType) {
      where.push('event_type = ?');
      params.push(obsType);
    }
    if (importance) {
      where.push('COALESCE(importance, 1) >= ?');
      params.push(importance);
    }
    if (epochFrom !== null) {
      where.push('created_at_epoch >= ?');
      params.push(epochFrom);
    }
    if (epochTo !== null) {
      where.push('created_at_epoch <= ?');
      params.push(epochTo);
    }
    counts.event = count(db, `SELECT COUNT(*) AS c FROM events WHERE ${where.join(' AND ')}`, params);
  }
  return counts;
}

function displayResultId(source, id) {
  return `${SOURCE_PREFIX[source]}${id}`;
}

export function computeSearchTelemetry(
  db,
  {
    project = null,
    days = 30,
    now = Date.now(),
    recordingFailures = 0,
    recordingFailureDays = Math.min(days, 14),
  } = {},
) {
  ensureSearchTelemetrySchema(db);
  const cutoff = now - days * DAY_MS;
  const storedSearchCount = count(db, 'SELECT COUNT(*) AS c FROM search_runs');
  const storedResultCount = count(db, 'SELECT COUNT(*) AS c FROM search_results');
  const runs = db
    .prepare(
      `
    SELECT * FROM search_runs
    WHERE created_at_epoch >= ? AND (? IS NULL OR project = ?)
    ORDER BY created_at_epoch DESC, rowid DESC
  `,
    )
    .all(cutoff, project, project);
  const results = db
    .prepare(
      `
    SELECT sr.*, r.surface, r.client, r.created_at AS search_created_at
    FROM search_results sr JOIN search_runs r ON r.search_id = sr.search_id
    WHERE r.created_at_epoch >= ? AND (? IS NULL OR r.project = ?)
    ORDER BY sr.search_id, sr.returned_rank
  `,
    )
    .all(cutoff, project, project);

  const distribution = { relevant: 0, partial: 0, irrelevant: 0, unrated: 0 };
  const bySurface = new Map();
  const byClient = new Map();
  const byRank = new Map();
  const byEntry = new Map();
  const resultsBySearch = new Map();
  const addRating = (map, key, value) => {
    if (!map.has(key)) map.set(key, { returned: 0, relevant: 0, partial: 0, irrelevant: 0, unrated: 0 });
    const row = map.get(key);
    row.returned++;
    row[value || 'unrated']++;
  };
  for (const row of results) {
    const value = row.relevance || 'unrated';
    distribution[value]++;
    addRating(bySurface, row.surface, value);
    addRating(byClient, row.client, value);
    addRating(byRank, `${row.surface}:${row.returned_rank}`, value);
    const entryKey = `${row.source}:${row.result_id}`;
    if (!byEntry.has(entryKey)) {
      byEntry.set(entryKey, {
        id: displayResultId(row.source, row.result_id),
        source: row.source,
        result_id: row.result_id,
        title: row.snapshot_label,
        returned: 0,
        relevant: 0,
        partial: 0,
        irrelevant: 0,
        unrated: 0,
        rank_total: 0,
        last_returned_at: null,
      });
    }
    const entry = byEntry.get(entryKey);
    entry.returned++;
    entry[value]++;
    entry.rank_total += row.returned_rank;
    if (!entry.last_returned_at || row.search_created_at > entry.last_returned_at) {
      entry.last_returned_at = row.search_created_at;
    }
    if (!resultsBySearch.has(row.search_id)) resultsBySearch.set(row.search_id, []);
    resultsBySearch.get(row.search_id).push(row);
  }

  const outcomes = { hit: 0, partial: 0, miss: 0, unrated: 0 };
  const corpusRanges = {};
  for (const run of runs) {
    const rows = resultsBySearch.get(run.search_id) || [];
    if (run.returned_count === 0) outcomes.miss++;
    else if (rows.some((r) => r.relevance === 'relevant')) outcomes.hit++;
    else if (rows.some((r) => r.relevance === 'partial')) outcomes.partial++;
    else if (rows.length === run.returned_count && rows.every((r) => r.relevance === 'irrelevant'))
      outcomes.miss++;
    else outcomes.unrated++;

    let counts = {};
    try {
      counts = JSON.parse(run.corpus_counts_json || '{}');
    } catch {
      /* old/malformed row */
    }
    corpusRanges[run.surface] ||= {};
    for (const [source, n] of Object.entries(counts)) {
      const range = (corpusRanges[run.surface][source] ||= { min: n, max: n });
      range.min = Math.min(range.min, n);
      range.max = Math.max(range.max, n);
    }
  }

  const returned = results.length;
  const rated = returned - distribution.unrated;
  const normalizeGroups = (map) =>
    Object.fromEntries(
      [...map].map(([key, row]) => [
        key,
        {
          ...row,
          coverage: row.returned ? (row.returned - row.unrated) / row.returned : 0,
        },
      ]),
    );
  const entries = [...byEntry.values()]
    .map(({ rank_total, ...row }) => ({ ...row, mean_rank: row.returned ? rank_total / row.returned : 0 }))
    .sort((a, b) => b.returned - a.returned || a.mean_rank - b.mean_rank);

  return {
    project,
    days,
    search_count: runs.length,
    stored_search_count: storedSearchCount,
    stored_result_count: storedResultCount,
    zero_result_count: runs.filter((r) => r.returned_count === 0).length,
    zero_result_rate: runs.length ? runs.filter((r) => r.returned_count === 0).length / runs.length : 0,
    recording_failures: recordingFailures,
    recording_failure_days: recordingFailureDays,
    returned_count: returned,
    rated_count: rated,
    relevance_coverage: returned ? rated / returned : 0,
    relevance_distribution: distribution,
    corpus_ranges: corpusRanges,
    by_rank: normalizeGroups(byRank),
    by_surface: normalizeGroups(bySurface),
    by_client: normalizeGroups(byClient),
    search_outcomes: outcomes,
    entries,
  };
}

export function formatSearchTelemetryReport(report) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const d = report.relevance_distribution;
  const lines = [
    `[mem] Search telemetry${report.project ? ` (${report.project})` : ''} — last ${report.days}d`,
    `Stored rows: searches ${report.stored_search_count} | results ${report.stored_result_count}`,
    `Zero-result searches: ${report.zero_result_count} (${pct(report.zero_result_rate)}) | recording failures (last ${report.recording_failure_days}d): ${report.recording_failures}`,
    `Relevance coverage: ${report.rated_count}/${report.returned_count} (${pct(report.relevance_coverage)})`,
    `Ratings: relevant ${d.relevant} | partial ${d.partial} | irrelevant ${d.irrelevant} | unrated ${d.unrated}`,
    `Search outcomes: hit ${report.search_outcomes.hit} | partial ${report.search_outcomes.partial} | miss ${report.search_outcomes.miss} | unrated ${report.search_outcomes.unrated}`,
  ];
  if (report.relevance_coverage < 0.4 && report.returned_count > 0) {
    lines.push('Coverage below 40%; this sample is not representative.');
  }
  lines.push('', 'By surface:');
  for (const [surface, row] of Object.entries(report.by_surface)) {
    lines.push(`  ${surface}: ${row.returned} returned, ${pct(row.coverage)} rated`);
  }
  lines.push('', 'By client:');
  for (const [client, row] of Object.entries(report.by_client)) {
    lines.push(`  ${client}: ${row.returned} returned, ${pct(row.coverage)} rated`);
  }
  lines.push('', 'Eligible corpus ranges (surface-local):');
  for (const [surface, sources] of Object.entries(report.corpus_ranges)) {
    lines.push(
      `  ${surface}: ${
        Object.entries(sources)
          .map(([source, range]) => `${source} ${range.min}-${range.max}`)
          .join(' | ') || 'none'
      }`,
    );
  }
  lines.push('', 'Precision by rank:');
  for (const [surfaceRank, row] of Object.entries(report.by_rank)) {
    const separator = surfaceRank.lastIndexOf(':');
    const surface = surfaceRank.slice(0, separator);
    const rank = surfaceRank.slice(separator + 1);
    const surfaceRow = report.by_surface[surface];
    const surfaceRated = surfaceRow.returned - surfaceRow.unrated;
    const rated = row.returned - row.unrated;
    lines.push(
      surfaceRated < 30 || surfaceRow.coverage < 0.2
        ? `  ${surface} #${rank}: suppressed (surface: ${surfaceRated} ratings, ${pct(surfaceRow.coverage)} coverage)`
        : rated === 0
          ? `  ${surface} #${rank}: no ratings at this rank`
          : `  ${surface} #${rank}: ${row.relevant}/${rated} relevant (${pct(row.relevant / rated)}), ${row.partial} partial`,
    );
  }
  lines.push('', 'Most returned entries:');
  for (const row of report.entries.slice(0, 50)) {
    lines.push(
      `  ${row.id} ${row.title || '(untitled)'} — ${row.returned} returns; ${row.relevant}/${row.partial}/${row.irrelevant}/${row.unrated} rel/partial/irr/unrated; mean rank ${row.mean_rank.toFixed(1)}`,
    );
  }
  return lines.join('\n');
}
