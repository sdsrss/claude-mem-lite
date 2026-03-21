#!/usr/bin/env node
// claude-mem-lite CLI — lightweight command layer for direct memory access
// No MCP SDK or heavy deps — only imports schema.mjs and utils.mjs

import { ensureDb, DB_PATH } from './schema.mjs';
import { sanitizeFtsQuery, relaxFtsQueryToOr, truncate, typeIcon, inferProject, jaccardSimilarity, computeMinHash, scrubSecrets, cjkBigrams, OBS_BM25, TYPE_DECAY_CASE } from './utils.mjs';
import { basename, join } from 'path';
import { readFileSync } from 'fs';

// OBS_BM25, TYPE_DECAY_CASE imported from utils.mjs

// ─── Argument Parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

function out(text) {
  process.stdout.write(text + '\n');
}

function relativeTime(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fmtDateShort(iso) {
  if (!iso) return '';
  return iso.slice(0, 10); // YYYY-MM-DD
}

// ─── Project Resolution ──────────────────────────────────────────────────────

function resolveProject(db, name) {
  if (!name) return name;
  if (name.includes('--')) return name;
  const suffixed = db.prepare(
    'SELECT project FROM observations WHERE project LIKE ? GROUP BY project ORDER BY COUNT(*) DESC LIMIT 1'
  ).get(`%--${name}`);
  if (suffixed) return suffixed.project;
  const inferred = inferProject();
  if (inferred.endsWith(`--${name}`)) return inferred;
  return name;
}

// ─── Commands ────────────────────────────────────────────────────────────────

function cmdSearch(db, args) {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ');
  if (!query) {
    out('[mem] Usage: mem search <query> [--type TYPE] [--limit N] [--project P] [--from DATE] [--to DATE] [--importance N]');
    return;
  }

  const limit = parseInt(flags.limit, 10) || 5;
  const type = flags.type || null;
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const dateFrom = flags.from ? new Date(flags.from).getTime() : null;
  let dateTo = flags.to ? new Date(flags.to).getTime() : null;
  if (dateTo && flags.to && /^\d{4}-\d{2}-\d{2}$/.test(flags.to)) dateTo += 86400000 - 1;
  const minImportance = flags.importance ? parseInt(flags.importance, 10) : null;

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) {
    out(`[mem] No valid search terms in "${query}"`);
    return;
  }

  let rows = searchFts(db, ftsQuery, { type, project, limit, dateFrom, dateTo, minImportance });

  // OR fallback when AND returns 0 results
  if (rows.length === 0) {
    const orQuery = relaxFtsQueryToOr(ftsQuery);
    if (orQuery) {
      try { rows = searchFts(db, orQuery, { type, project, limit, dateFrom, dateTo, minImportance }); } catch {}
    }
  }

  if (rows.length === 0) {
    out(`[mem] No results for "${query}"`);
    return;
  }

  out(`[mem] ${rows.length} result${rows.length !== 1 ? 's' : ''} for "${query}":`);
  for (const r of rows) {
    const date = fmtDateShort(r.created_at);
    const title = truncate(r.title || r.subtitle || '(untitled)', 70);
    out(`#${r.id} ${typeIcon(r.type)} ${date} ${title}`);
    if (r.lesson_learned) {
      out(`  -> ${truncate(r.lesson_learned, 80)}`);
    }
  }
}

function searchFts(db, ftsQuery, { type, project, limit, dateFrom, dateTo, minImportance }) {
  const now = Date.now();
  // Current project for boost (2× when no explicit project filter)
  const currentProject = !project ? inferProject() : null;

  // WHERE clause params (positional ? in SQL order)
  const whereParams = [ftsQuery];
  const wheres = [
    'observations_fts MATCH ?',
    'COALESCE(o.compressed_into, 0) = 0',
  ];
  if (project) { wheres.push('o.project = ?'); whereParams.push(project); }
  if (type) { wheres.push('o.type = ?'); whereParams.push(type); }
  if (dateFrom) { wheres.push('o.created_at_epoch >= ?'); whereParams.push(dateFrom); }
  if (dateTo) { wheres.push('o.created_at_epoch <= ?'); whereParams.push(dateTo); }
  if (minImportance) { wheres.push('COALESCE(o.importance, 1) >= ?'); whereParams.push(minImportance); }

  // ORDER BY params come after WHERE params, then LIMIT
  const orderParams = [now, currentProject, currentProject];
  const params = [...whereParams, ...orderParams, limit];

  // Scoring aligned with server.mjs: BM25 × type-decay × project_boost × importance × access_bonus
  return db.prepare(`
    SELECT o.id, o.type, o.title, o.subtitle, o.created_at, o.lesson_learned
    FROM observations_fts
    JOIN observations o ON observations_fts.rowid = o.id
    WHERE ${wheres.join(' AND ')}
    ORDER BY ${OBS_BM25}
      * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / ${TYPE_DECAY_CASE}))
      * (CASE WHEN ? IS NOT NULL AND o.project = ? THEN 2.0 ELSE 1.0 END)
      * (0.5 + 0.5 * COALESCE(o.importance, 1))
      * (1.0 + 0.1 * LN(1 + COALESCE(o.access_count, 0)))
    LIMIT ?
  `).all(...params);
}

function cmdRecent(db, args) {
  const { positional, flags } = parseArgs(args);
  const limit = parseInt(positional[0], 10) || 5;
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();

  const params = [];
  const wheres = ['COALESCE(compressed_into, 0) = 0'];
  if (project) { wheres.push('project = ?'); params.push(project); }
  params.push(limit);

  const rows = db.prepare(`
    SELECT id, type, title, subtitle, created_at_epoch, created_at
    FROM observations
    WHERE ${wheres.join(' AND ')}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...params);

  if (rows.length === 0) {
    out(`[mem] No recent observations${project ? ` (${project})` : ''}`);
    return;
  }

  out(`[mem] Recent (${project || 'all'}):`);
  for (const r of rows) {
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 60);
    out(`#${r.id} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}`);
  }
}

function cmdRecall(db, args) {
  const { positional, flags } = parseArgs(args);
  const file = positional.join(' ');
  if (!file) {
    out('[mem] Usage: mem recall <file>');
    return;
  }

  const filename = basename(file);
  const limit = parseInt(flags.limit, 10) || 10;

  // Search both files_modified and files_read for the filename
  const rows = db.prepare(`
    SELECT id, type, title, lesson_learned, created_at
    FROM observations
    WHERE COALESCE(compressed_into, 0) = 0
      AND (files_modified LIKE ? OR files_read LIKE ?)
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(`%${filename}%`, `%${filename}%`, limit);

  if (rows.length === 0) {
    out(`[mem] No history for "${filename}"`);
    return;
  }

  out(`[mem] History for ${filename}:`);
  for (const r of rows) {
    const title = truncate(r.title || '(untitled)', 60);
    const lesson = r.lesson_learned ? ` -- ${truncate(r.lesson_learned, 50)}` : '';
    out(`#${r.id} ${typeIcon(r.type)} ${title}${lesson}`);
  }
}

function cmdGet(db, args) {
  const { positional } = parseArgs(args);
  const idStr = positional.join(',');
  if (!idStr) {
    out('[mem] Usage: mem get <id1,id2,...>');
    return;
  }

  const ids = idStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (ids.length === 0) {
    out('[mem] No valid IDs provided');
    return;
  }

  const placeholders = ids.map(() => '?').join(',');

  // Update access_count (aligned with MCP mem_get)
  db.prepare(`UPDATE observations SET access_count = COALESCE(access_count, 0) + 1 WHERE id IN (${placeholders})`).run(...ids);

  const rows = db.prepare(`
    SELECT id, type, title, subtitle, narrative, text, concepts, facts,
           files_read, files_modified, lesson_learned, importance, created_at, project
    FROM observations
    WHERE id IN (${placeholders})
    ORDER BY created_at_epoch ASC
  `).all(...ids);

  if (rows.length === 0) {
    out('[mem] No observations found for given IDs');
    return;
  }

  const parts = [];
  for (const r of rows) {
    const lines = [`#${r.id} [${r.type}] ${fmtDateShort(r.created_at)}`];
    if (r.title) lines.push(`Title: ${r.title}`);
    if (r.subtitle) lines.push(`Subtitle: ${r.subtitle}`);

    // Collect files from JSON arrays
    const files = [];
    try {
      const modified = JSON.parse(r.files_modified || '[]');
      const read = JSON.parse(r.files_read || '[]');
      if (modified.length) files.push(...modified.map(f => basename(f)));
      if (read.length && !modified.length) files.push(...read.map(f => basename(f)));
    } catch {}
    if (files.length) lines.push(`Files: ${files.join(', ')}`);

    if (r.lesson_learned) lines.push(`Lesson: ${r.lesson_learned}`);
    if (r.narrative) lines.push(`Narrative: ${truncate(r.narrative, 200)}`);
    if (r.concepts) lines.push(`Concepts: ${r.concepts}`);
    if (r.importance) lines.push(`Importance: ${r.importance}`);
    parts.push(lines.join('\n'));
  }

  out(parts.join('\n\n'));
}

function cmdTimeline(db, args) {
  const { positional, flags } = parseArgs(args);
  let anchorId = parseInt(flags.anchor, 10);
  const before = parseInt(flags.before, 10) || 3;
  const after = parseInt(flags.after, 10) || 3;
  const project = flags.project ? resolveProject(db, flags.project) : null;

  // Support query-based anchor: `timeline --query "search terms"` or positional
  const queryStr = flags.query || positional.join(' ');
  if ((!anchorId || isNaN(anchorId)) && queryStr) {
    const ftsQuery = sanitizeFtsQuery(queryStr);
    if (ftsQuery) {
      const match = db.prepare(`
        SELECT o.id FROM observations_fts
        JOIN observations o ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ? AND COALESCE(o.compressed_into, 0) = 0
        ORDER BY ${OBS_BM25}
        LIMIT 1
      `).get(ftsQuery);
      if (match) anchorId = match.id;
    }
  }

  if (!anchorId || isNaN(anchorId)) {
    out('[mem] Usage: mem timeline --anchor <id> [--query "text"] [--before N] [--after N] [--project P]');
    return;
  }

  // Update access_count for anchor (aligned with MCP mem_timeline)
  db.prepare('UPDATE observations SET access_count = COALESCE(access_count, 0) + 1 WHERE id = ?').run(anchorId);

  // Get anchor epoch
  const anchorRow = db.prepare('SELECT created_at_epoch, project FROM observations WHERE id = ?').get(anchorId);
  if (!anchorRow) {
    out(`[mem] Observation #${anchorId} not found`);
    return;
  }

  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  // Before anchor
  const beforeRows = db.prepare(`
    SELECT id, type, title, subtitle, created_at, created_at_epoch
    FROM observations
    WHERE created_at_epoch < ? AND COALESCE(compressed_into, 0) = 0 ${projectFilter}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(anchorRow.created_at_epoch, ...baseParams, before);

  // After anchor
  const afterRows = db.prepare(`
    SELECT id, type, title, subtitle, created_at, created_at_epoch
    FROM observations
    WHERE created_at_epoch > ? AND COALESCE(compressed_into, 0) = 0 ${projectFilter}
    ORDER BY created_at_epoch ASC
    LIMIT ?
  `).all(anchorRow.created_at_epoch, ...baseParams, after);

  // Anchor itself
  const anchor = db.prepare(
    'SELECT id, type, title, subtitle, created_at, created_at_epoch FROM observations WHERE id = ?'
  ).get(anchorId);

  const all = [...beforeRows.reverse(), anchor, ...afterRows];

  out(`[mem] Timeline around #${anchorId}:`);
  for (const r of all) {
    const marker = r.id === anchorId ? ' <--' : '';
    const time = relativeTime(r.created_at_epoch);
    const title = truncate(r.title || r.subtitle || '(untitled)', 60);
    out(`#${r.id} ${typeIcon(r.type)} ${time.padEnd(8)} ${title}${marker}`);
  }
}

function cmdSave(db, args) {
  const { positional, flags } = parseArgs(args);
  const text = positional.join(' ');
  if (!text) {
    out('[mem] Usage: mem save "<text>" [--type T] [--title T] [--importance N] [--project P]');
    return;
  }

  const type = flags.type || 'discovery';
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);
  if (!validTypes.has(type)) {
    out(`[mem] Invalid type "${type}". Valid: ${[...validTypes].join(', ')}`);
    return;
  }

  const rawTitle = flags.title || text.slice(0, 100);
  // Explicit saves default to importance=2 (notable) — user chose to save
  const importance = Math.max(1, Math.min(3, parseInt(flags.importance, 10) || 2));
  const project = flags.project ? resolveProject(db, flags.project) : inferProject();

  // Secret scrubbing (aligned with MCP mem_save)
  const safeContent = scrubSecrets(text);
  const safeTitle = scrubSecrets(rawTitle);

  // Dedup: skip if similar title/content saved in last 5 minutes (aligned with MCP mem_save)
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const recent = db.prepare(`
    SELECT id, title, text FROM observations
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC LIMIT 50
  `).all(project, fiveMinAgo);

  const dupMatch = recent.find(r =>
    jaccardSimilarity(r.title, safeTitle) > 0.7 ||
    jaccardSimilarity(r.text || '', safeContent) > 0.7
  );
  if (dupMatch) {
    out(`[mem] Skipped: similar to existing #${dupMatch.id}. Use "claude-mem-lite get ${dupMatch.id}" to review.`);
    return;
  }

  // MinHash + CJK bigrams (aligned with MCP mem_save)
  const minhashSig = computeMinHash(safeTitle + ' ' + safeContent);
  const bigramText = cjkBigrams(safeTitle + ' ' + safeContent);
  const textField = bigramText ? safeContent + ' ' + bigramText : safeContent;

  const now = new Date();
  const sessionId = `cli-${now.getTime()}`;

  // Ensure a session exists for the FK constraint
  db.prepare(`
    INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'completed')
  `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

  const result = db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, '', '', '[]', '[]', ?, ?, ?, ?)
  `).run(sessionId, project, textField, type, safeTitle, safeContent, importance, minhashSig, now.toISOString(), now.getTime());

  out(`[mem] Saved #${result.lastInsertRowid} [${type}] "${truncate(safeTitle, 60)}" (project: ${project})`);
}

function cmdStats(db, args) {
  const { flags } = parseArgs(args);
  const project = flags.project ? resolveProject(db, flags.project) : null;
  const days = parseInt(flags.days, 10) || 30;

  const projectFilter = project ? 'AND project = ?' : '';
  const baseParams = project ? [project] : [];

  const now = Date.now();
  const thirtyDaysAgo = now - days * 86400000;
  const sevenDaysAgo = now - 7 * 86400000;

  // Total observations
  const obsTotal = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE 1=1 ${projectFilter}`
  ).get(...baseParams);

  // 30d and 7d counts
  const obs30d = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? ${projectFilter}`
  ).get(thirtyDaysAgo, ...baseParams);

  const obs7d = db.prepare(
    `SELECT COUNT(*) as c FROM observations WHERE created_at_epoch >= ? ${projectFilter}`
  ).get(sevenDaysAgo, ...baseParams);

  // Session count
  const sessTotal = db.prepare(
    `SELECT COUNT(*) as c FROM sdk_sessions WHERE 1=1 ${project ? 'AND project = ?' : ''}`
  ).get(...baseParams);

  // Project count
  const projCount = db.prepare(
    'SELECT COUNT(DISTINCT project) as c FROM observations'
  ).get();

  // Type distribution
  const types = db.prepare(`
    SELECT type, COUNT(*) as c FROM observations
    WHERE 1=1 ${projectFilter}
    GROUP BY type ORDER BY c DESC
  `).all(...baseParams);

  const typeLine = types.map(t => `${t.type}=${t.c}`).join(' ');

  out(`[mem] Stats${project ? ` (${project})` : ''}:`);
  out(`Observations: ${obsTotal.c.toLocaleString()} (30d: ${obs30d.c}, 7d: ${obs7d.c})`);
  out(`Sessions: ${sessTotal.c} | Projects: ${projCount.c}`);
  if (typeLine) out(`Types: ${typeLine}`);
}

function cmdContext(_db, _args) {
  // Read the project's CLAUDE.md and extract the context block
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd();
  const claudeMdPath = join(projectDir, 'CLAUDE.md');

  let content;
  try {
    content = readFileSync(claudeMdPath, 'utf8');
  } catch {
    out(`[mem] No CLAUDE.md found at ${claudeMdPath}`);
    return;
  }

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';
  const startIdx = content.lastIndexOf(startTag);
  const endIdx = content.lastIndexOf(endTag);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    out('[mem] No claude-mem-context block found in CLAUDE.md');
    return;
  }

  const block = content.slice(startIdx + startTag.length, endIdx).trim();
  out(`[mem] Current context:\n${block}`);
}

// ─── Help ────────────────────────────────────────────────────────────────────

function cmdHelp() {
  out(`claude-mem-lite CLI

Commands:
  search <query>        FTS5 search observations
    --type T            Filter by type (bugfix|decision|discovery|feature|refactor|change)
    --limit N           Max results (default 5)
    --project P         Filter by project
    --from DATE         Start date (YYYY-MM-DD or ISO 8601)
    --to DATE           End date (YYYY-MM-DD or ISO 8601)
    --importance N      Minimum importance (1-3)

  recent [N]            Show N most recent observations (default 5)
    --project P         Filter by project

  recall <file>         Show observations related to a file
    --limit N           Max results (default 10)

  get <id1,id2,...>     Get full details for observation IDs

  timeline              Show observations around an anchor
    --anchor ID         Center on this observation ID
    --query "text"      Find anchor by FTS5 search
    --before N          Show N before anchor (default 3)
    --after N           Show N after anchor (default 3)
    --project P         Filter by project

  save "<text>"         Save a new observation
    --type T            Observation type (default: discovery)
    --title T           Title (auto-generated if omitted)
    --importance N      1-3 (default: 2)
    --project P         Project name

  stats                 Show memory statistics
    --project P         Filter by project
    --days N            Lookback window (default 30)

  context               Show current CLAUDE.md context block

DB: ${DB_PATH}`);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function run(argv) {
  const cmd = argv[0];
  const cmdArgs = argv.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    cmdHelp();
    return;
  }

  let db;
  try {
    db = ensureDb();
  } catch (e) {
    out(`[mem] Error: Cannot open database: ${e.message}`);
    out(`[mem] DB path: ${DB_PATH}`);
    process.exitCode = 1;
    return;
  }

  try {
    switch (cmd) {
      case 'search':  cmdSearch(db, cmdArgs); break;
      case 'recent':  cmdRecent(db, cmdArgs); break;
      case 'recall':  cmdRecall(db, cmdArgs); break;
      case 'get':     cmdGet(db, cmdArgs); break;
      case 'timeline': cmdTimeline(db, cmdArgs); break;
      case 'save':    cmdSave(db, cmdArgs); break;
      case 'stats':   cmdStats(db, cmdArgs); break;
      case 'context': cmdContext(db, cmdArgs); break;
      default:
        out(`[mem] Unknown command: ${cmd}`);
        out('[mem] Run "claude-mem-lite help" for usage');
        process.exitCode = 1;
    }
  } finally {
    try { db.close(); } catch {}
  }
}
