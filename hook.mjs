#!/usr/bin/env node
// claude-mem-lite Hook v2 — Cognitive memory architecture
// Selective encoding, episodic batching, error-triggered recall
// Hooks (fast <100ms): post-tool-use, session-start, stop
// Background workers (slow): llm-episode, llm-summary

import { randomUUID } from 'crypto';
import { join, basename } from 'path';
import { readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import {
  truncate, typeIcon, inferProject, detectBashSignificance,
  extractErrorKeywords, extractFilePaths, isRelatedToEpisode,
  makeEntryDesc, scrubSecrets, EDIT_TOOLS, debugCatch, debugLog, fmtTime,
  COMPRESSED_AUTO, COMPRESSED_PENDING_PURGE, isoWeekKey, OBS_BM25,
} from './utils.mjs';
import {
  readEpisodeRaw, episodeFile,
  acquireLock, releaseLock, readEpisode, writeEpisode,
  createEpisode, addFileToEpisode,
  writePendingEntry, mergePendingEntries, episodeHasSignificantContent,
} from './hook-episode.mjs';
import { selectWithTokenBudget, updateClaudeMd, buildSummaryLines } from './hook-context.mjs';
import {
  RUNTIME_DIR, EPISODE_BUFFER_SIZE, EPISODE_TIME_GAP_MS,
  SESSION_EXPIRY_MS, STALE_SESSION_MS, STALE_LOCK_MS, FALLBACK_OBS_WINDOW_MS,
  sessionFile, getSessionId, createSessionId, openDb,
  spawnBackground,
} from './hook-shared.mjs';
import { handleLLMEpisode, handleLLMSummary, saveObservation, buildImmediateObservation } from './hook-llm.mjs';
import { searchRelevantMemories, recallForFile } from './hook-memory.mjs';
import { buildAndSaveHandoff, detectContinuationIntent, renderHandoffInjection, extractUnfinishedSummary } from './hook-handoff.mjs';
import { checkForUpdate } from './hook-update.mjs';
import { SKIP_TOOLS, SKIP_PREFIXES } from './skip-tools.mjs';

// Prevent recursive hooks from background claude -p calls
// Background workers (llm-episode, llm-summary) are exempt — they're ours
const event = process.argv[2];
const BG_EVENTS = new Set(['llm-episode', 'llm-summary']);

// Respect Claude Code plugin disable state even when legacy settings.json hooks remain.
// install.mjs writes direct hooks into ~/.claude/settings.json, so disabling the plugin
// in Claude UI does not automatically remove them. Exit early to make disable actually work.
const PLUGIN_KEY = 'claude-mem-lite@sdsrss';
function isPluginExplicitlyDisabled() {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return settings.enabledPlugins?.[PLUGIN_KEY] === false;
  } catch {
    return false;
  }
}

if (event && isPluginExplicitlyDisabled()) process.exit(0);
if (process.env.CLAUDE_MEM_HOOK_RUNNING && !BG_EVENTS.has(event)) process.exit(0);

// Crash-safe: flush episode buffer on unexpected termination to prevent data loss
// Uses flag-based approach to avoid calling file I/O inside signal handlers,
// which can deadlock if the signal fires during a main-thread file operation.
let _shutdownRequested = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (_shutdownRequested) process.exit(0); // Double-signal = force exit
    _shutdownRequested = true;
    // Schedule flush on next tick to avoid re-entering file I/O
    setTimeout(() => {
      try {
        const ep = readEpisodeRaw();
        if (ep && ep.entries && ep.entries.length > 0) {
          const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          writeFileSync(flushFile, JSON.stringify(ep));
          try { unlinkSync(join(RUNTIME_DIR, `ep-${inferProject()}.json`)); } catch {}
        }
      } catch {}
      process.exit(0);
    });
  });
}

if (!event) process.exit(0);

// ─── Episode Flush ──────────────────────────────────────────────────────────

function flushEpisode(episode) {
  if (!episode || episode.entries.length === 0) return;

  // Collect Read file paths tracked by post-tool-use.sh
  // Use rename to atomically collect — prevents losing concurrent appends
  const readsFile = join(RUNTIME_DIR, `reads-${episode.project || inferProject()}.txt`);
  const readsCollect = readsFile + `.collect-${Date.now()}`;
  try {
    renameSync(readsFile, readsCollect);
    const raw = readFileSync(readsCollect, 'utf8');
    const paths = [...new Set(raw.split('\n').filter(Boolean))];
    episode.filesRead = paths;
    try { unlinkSync(readsCollect); } catch {}
  } catch {
    episode.filesRead = episode.filesRead || [];
  }

  const isSignificant = episodeHasSignificantContent(episode);

  // Immediate save: create rule-based observation for instant visibility.
  // LLM background worker will upgrade title/narrative/importance later.
  if (isSignificant) {
    try {
      const obs = buildImmediateObservation(episode);
      const id = saveObservation(obs, episode.project, episode.sessionId);
      if (id) episode.savedId = id;
    } catch (e) { debugCatch(e, 'flushEpisode-immediateSave'); }
  }

  // Write episode to flush file, then remove buffer AFTER spawn to prevent race
  const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  try {
    writeFileSync(flushFile, JSON.stringify(episode));
  } catch {
    return;
  }

  if (isSignificant) {
    spawnBackground('llm-episode', flushFile);
  } else {
    try { unlinkSync(flushFile); } catch {}
  }

  // Remove episode buffer AFTER spawning background worker to prevent concurrent overwrites
  try { unlinkSync(episodeFile()); } catch {}
}

// ─── PostToolUse Handler ────────────────────────────────────────────────────

// Tier 1 D: Skip low-value tools entirely (source of truth: skip-tools.mjs)
// Consistency enforced by tests/skip-tools.test.mjs

async function handlePostToolUse() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch {
    // Truncated JSON — try to salvage tool_name from the prefix
    if (raw.truncated) {
      debugLog('WARN', 'postToolUse', 'stdin truncated at 256KB, attempting salvage');
      const m = raw.text.match(/"tool_name"\s*:\s*"([^"]+)"/);
      if (m) hookData = { tool_name: m[1], tool_input: {}, tool_response: '(truncated)' };
    }
    if (!hookData) return;
  }

  const { tool_name, tool_input, tool_response } = hookData;
  if (!tool_name) return;

  // Skip noise (source of truth: skip-tools.mjs)
  if (SKIP_TOOLS.has(tool_name)) return;
  if (SKIP_PREFIXES.some(p => tool_name.startsWith(p))) return;

  const resp = normalizeToolResponse(tool_response);
  if (!resp || resp.length < 10) return;

  const toolInput = typeof tool_input === 'string' ? tryParseJson(tool_input) : (tool_input || {});
  const files = extractFilePaths(toolInput);

  // Tier 1 B: Detect significant Bash commands
  const bashSig = (tool_name === 'Bash') ? detectBashSignificance(toolInput, resp) : null;

  // Build episode entry
  const entry = {
    tool: tool_name,
    desc: scrubSecrets(makeEntryDesc(tool_name, toolInput, resp)),
    files,
    ts: Date.now(),
    isError: bashSig?.isError || false,
    isSignificant: EDIT_TOOLS.has(tool_name) ||
                   bashSig?.isSignificant || false,
    bashSig: bashSig || null,
  };

  // Episode buffer management (locked to prevent TOCTOU race)
  const sessionId = getSessionId();
  const project = inferProject();

  // Lazy DB: only opened when needed (error recall or file history)
  let db = null;
  const getDb = () => { if (!db) db = openDb(); return db; };

  // Tier 2 G: Error-triggered recall
  if (bashSig?.isError) {
    const d = getDb();
    if (d) triggerErrorRecall(d, toolInput, resp);
  }

  if (!acquireLock()) {
    if (db) try { db.close(); } catch {}
    writePendingEntry(entry, sessionId, project);
    return;
  }
  try {
    let episode = readEpisode();

    // Merge any pending entries from previous lock failures
    if (episode) mergePendingEntries(episode);

    if (episode) {
      const timeSinceLastEntry = Date.now() - episode.lastAt;
      const fileRelated = isRelatedToEpisode(episode, files);
      const bufferFull = episode.entries.length >= EPISODE_BUFFER_SIZE;
      const timeGap = timeSinceLastEntry > EPISODE_TIME_GAP_MS;

      // Phase transition → flush current episode, start new
      if (bufferFull || timeGap || (!fileRelated && episode.entries.length >= 2)) {
        flushEpisode(episode);
        episode = null;
      }
    }

    if (!episode) {
      episode = createEpisode(sessionId, project);
      mergePendingEntries(episode);
    }

    episode.entries.push(entry);
    episode.lastAt = Date.now();
    addFileToEpisode(episode, files);

    // Proactive file history: show past observations for files being edited
    // Uses recallForFile for importance>=2 with lesson context
    if (EDIT_TOOLS.has(tool_name) && files.length > 0) {
      const d = getDb();
      if (d) {
        for (const f of files) {
          if (episode.fileHistoryShown?.includes(f)) continue;
          try {
            const recalled = recallForFile(d, f, project);
            if (recalled.length > 0) {
              const hints = recalled.map(r => {
                const lesson = r.lesson_learned ? ` | ${r.lesson_learned}` : '';
                return `  #${r.id} [${r.type}] ${truncate(r.title, 60)}${lesson}`;
              }).join('\n');
              process.stdout.write(`[claude-mem-lite] History for ${basename(f)}:\n${hints}\n`);
            }
          } catch (e) { debugCatch(e, 'fileHistory'); }
          if (!episode.fileHistoryShown) episode.fileHistoryShown = [];
          episode.fileHistoryShown.push(f);
        }
      }
    }

    writeEpisode(episode);

  } finally {
    releaseLock();
    if (db) try { db.close(); } catch {}
  }
}

// ─── Error-Triggered Recall (Tier 2 G) ─────────────────────────────────────

function triggerErrorRecall(db, toolInput, response) {
  try {
    const project = inferProject();

    // Extract error keywords
    const cmd = toolInput.command || '';
    const keywords = extractErrorKeywords(cmd, response);
    if (!keywords || keywords.length === 0) return;

    // FTS5 OR query for broader recall
    const ftsQuery = keywords.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    if (!ftsQuery) return;

    const nowR = Date.now();
    const rows = db.prepare(`
      SELECT o.id, o.type, o.title
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.project = ?
      ORDER BY ${OBS_BM25}
        * (1.0 + EXP(-0.693 * (? - o.created_at_epoch) / 1209600000.0))
      LIMIT 3
    `).all(ftsQuery, project, nowR);

    if (rows.length > 0) {
      const hints = rows.map(r => `  #${r.id} [${r.type}] ${truncate(r.title, 60)}`).join('\n');
      process.stdout.write(`[claude-mem-lite] Related memories found for this error:\n${hints}\n  → Use mem_get(ids=[${rows.map(r => r.id).join(',')}]) for details.\n`);
    }
  } catch (e) { debugCatch(e, 'triggerErrorRecall'); }
}

// ─── Stop Handler ───────────────────────────────────────────────────────────

async function handleStop() {
  // Capture session info BEFORE cleanup
  const sessionId = getSessionId();
  const project = inferProject();

  // Snapshot episode BEFORE flush for handoff extraction
  const episodeSnapshot = readEpisodeRaw();

  // Flush remaining episode buffer (locked to prevent race with handlePostToolUse)
  if (acquireLock(1000)) {
    try {
      const episode = readEpisode();
      if (episode) {
        flushEpisode(episode);
      }
    } finally {
      releaseLock();
    }
  } else {
    // Fallback: lock contended — atomically rename episode file to claim ownership.
    // Prevents data loss from concurrent PostToolUse writes between read and delete.
    const epFile = episodeFile();
    const claimFile = epFile + `.claim-${process.pid}-${Date.now()}`;
    try {
      renameSync(epFile, claimFile);
      try {
        const episode = JSON.parse(readFileSync(claimFile, 'utf8'));
        if (episode && episode.entries && episode.entries.length > 0 && episodeHasSignificantContent(episode)) {
          if (!episode.sessionId) episode.sessionId = sessionId;
          if (!episode.project) episode.project = project;
          // Immediate save: persist rule-based observation to DB before spawning background worker.
          // Without this, data is lost if the background worker fails.
          try {
            const obs = buildImmediateObservation(episode);
            const id = saveObservation(obs, episode.project, episode.sessionId);
            if (id) episode.savedId = id;
          } catch (e) { debugCatch(e, 'handleStop-fallback-immediateSave'); }
          const flushFile = join(RUNTIME_DIR, `ep-flush-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
          writeFileSync(flushFile, JSON.stringify(episode));
          spawnBackground('llm-episode', flushFile);
        }
      } finally {
        try { unlinkSync(claimFile); } catch {}
      }
    } catch (e) { debugCatch(e, 'handleStop-fallback'); }
  }

  // Mark session completed + save handoff (sync, instant)
  const db = openDb();
  if (db) {
    try {
      db.prepare(`
        UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
        WHERE content_session_id = ? AND status = 'active'
      `).run(new Date().toISOString(), Date.now(), sessionId);
      // Save handoff snapshot for cross-session continuity
      try { buildAndSaveHandoff(db, sessionId, project, 'exit', episodeSnapshot); }
      catch (e) { debugCatch(e, 'handleStop-handoff'); }

      // Fast summary baseline — ensures summary exists even if background LLM fails
      try {
        const firstPrompt = db.prepare(`
          SELECT prompt_text FROM user_prompts
          WHERE content_session_id = ?
          ORDER BY prompt_number ASC LIMIT 1
        `).get(sessionId);
        const recentObs = db.prepare(`
          SELECT title FROM observations
          WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
          ORDER BY created_at_epoch DESC LIMIT 5
        `).all(sessionId);
        const fastRequest = truncate(firstPrompt?.prompt_text || '', 200);
        const fastCompleted = recentObs.map(o => o.title).filter(Boolean).join('; ');
        if (fastRequest || fastCompleted) {
          const now = new Date();
          db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
            VALUES (?, ?, ?, '', '', ?, '', '', '[]', '[]', 'fast', ?, ?)
          `).run(sessionId, project, fastRequest, truncate(fastCompleted, 300), now.toISOString(), now.getTime());
        }
      } catch (e) { debugCatch(e, 'handleStop-fast-summary'); }
    } finally {
      db.close();
    }
  }

  // Spawn background for session summary (pass sessionId and project)
  spawnBackground('llm-summary', sessionId, project);

  // Clean session file AFTER spawning background
  try { unlinkSync(sessionFile()); } catch {}
}

// ─── SessionStart Handler + CLAUDE.md Persistence (Tier 1 A, E) ─────────────

async function handleSessionStart() {
  // Snapshot episode BEFORE flush for handoff extraction
  const episodeSnapshot = readEpisodeRaw();

  // Flush any leftover episode buffer from previous session (e.g. after /clear)
  if (acquireLock()) {
    try {
      const prevEpisode = readEpisode();
      if (prevEpisode && prevEpisode.entries && prevEpisode.entries.length > 0) {
        flushEpisode(prevEpisode);
      }
    } finally {
      releaseLock();
    }
  }

  // Detect mid-session restart (/clear or /compact): if a recent session file exists,
  // the previous session ended without Stop hook firing. Read BEFORE createSessionId()
  // overwrites the session file. Normal /exit deletes the file, so this only triggers
  // for /clear, /compact, or crash recovery.
  let prevSessionId = null;
  let prevProject = null;
  try {
    const data = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (Date.now() - data.startedAt < SESSION_EXPIRY_MS) {
      prevSessionId = data.id;
      prevProject = data.project;
    }
  } catch {} // No session file = fresh startup, nothing to recover

  // Tier 1 A: Create unique session ID
  const sessionId = createSessionId();
  const project = inferProject();

  const db = openDb();
  if (!db) return;

  try {
    const now = new Date();

    // ── DB mutations in a transaction (crash-safe consistency) ──
    const staleSessionCutoff = Date.now() - STALE_SESSION_MS;
    const autoCompressAge = Date.now() - 30 * 86400000; // 30 days (accelerated from 90)

    db.transaction(() => {
      // Ensure session exists in DB (INSERT OR IGNORE avoids race condition)
      db.prepare(`
        INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

      // Complete previous session if this is a mid-session restart (/clear, /compact, crash)
      if (prevSessionId) {
        db.prepare(`
          UPDATE sdk_sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
          WHERE content_session_id = ? AND status = 'active'
        `).run(now.toISOString(), now.getTime(), prevSessionId);
      }

      // Stale session cleanup: mark 24h+ active sessions as abandoned
      db.prepare(`
        UPDATE sdk_sessions SET status = 'abandoned'
        WHERE status = 'active' AND started_at_epoch < ?
      `).run(staleSessionCutoff);

      // Auto-compress: mark old low-importance observations as compressed (30+ days, importance=1)
      // Lightweight: only marks rows, doesn't create summaries (full compression via mem_compress)
      const compressed = db.prepare(`
        UPDATE observations SET compressed_into = ${COMPRESSED_AUTO}
        WHERE COALESCE(compressed_into, 0) = 0
          AND importance = 1
          AND created_at_epoch < ?
          AND project = ?
      `).run(autoCompressAge, project);
      if (compressed.changes > 0) {
        debugLog('DEBUG', 'session-start', `auto-compressed ${compressed.changes} old observations`);
      }
    })();

    // Auto-purge: delete stale observations daily (COMPRESSED_PENDING_PURGE, 7-day retention)
    const maintainFile = join(RUNTIME_DIR, 'last-auto-maintain.json');
    let shouldMaintain = true;
    try {
      const last = JSON.parse(readFileSync(maintainFile, 'utf8'));
      if (Date.now() - last.epoch < 24 * 3600000) shouldMaintain = false;
    } catch {}
    if (shouldMaintain) {
      try {
        const purged = db.prepare(`
          DELETE FROM observations WHERE compressed_into = ${COMPRESSED_PENDING_PURGE}
            AND created_at_epoch < ?
        `).run(Date.now() - 7 * 86400000);
        if (purged.changes > 0) {
          debugLog('DEBUG', 'session-start', `auto-purged ${purged.changes} stale observations`);
        }
        // Mark maintenance as done (24h gate) — even though compression runs in background
        writeFileSync(maintainFile, JSON.stringify({ epoch: Date.now() }));
        // Weekly summary grouping runs in background to avoid blocking SessionStart
        spawnBackground('auto-compress');
      } catch (e) { debugCatch(e, 'auto-maintain'); }
    }

    // ── Non-transactional operations (side effects, background work) ──

    // Shared clear handoff reference — queried once, used by fast summary + working state
    let prevClearHandoff = null;

    if (prevSessionId) {
      // Save handoff for cross-session continuity (/clear or /compact)
      try { buildAndSaveHandoff(db, prevSessionId, prevProject || project, 'clear', episodeSnapshot); }
      catch (e) { debugCatch(e, 'session-start-handoff'); }

      // Read the just-saved handoff for downstream consumers (fast summary remaining, working state)
      try {
        prevClearHandoff = db.prepare(
          'SELECT working_on, unfinished, key_files FROM session_handoffs WHERE project = ? AND type = ?'
        ).get(prevProject || project, 'clear');
      } catch {}

      // Generate session summary for previous session (background Haiku — richer version)
      spawnBackground('llm-summary', prevSessionId, prevProject || project);

      // Build fast synchronous summary for immediate context availability.
      // Background llm-summary will produce a richer Haiku version later;
      // context injection query (ORDER BY created_at_epoch DESC) auto-prefers latest.
      try {
        const firstPrompt = db.prepare(`
          SELECT prompt_text FROM user_prompts
          WHERE content_session_id = ?
          ORDER BY prompt_number ASC LIMIT 1
        `).get(prevSessionId);

        const prevObs = db.prepare(`
          SELECT title FROM observations
          WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
          ORDER BY created_at_epoch DESC LIMIT 5
        `).all(prevSessionId);

        const fastRequest = truncate(firstPrompt?.prompt_text || '', 200);
        const fastCompleted = prevObs.map(o => o.title).filter(Boolean).join('; ');

        // Infer remaining_items from handoff unfinished (already built above at line 476)
        let fastRemaining = '';
        if (prevClearHandoff?.unfinished) {
          fastRemaining = truncate(extractUnfinishedSummary(prevClearHandoff.unfinished, 0), 200);
        }
        // Fallback: episode errors
        if (!fastRemaining && episodeSnapshot?.entries) {
          const errors = episodeSnapshot.entries.filter(e => e.isError).map(e => e.desc).filter(Boolean);
          if (errors.length > 0) fastRemaining = truncate(errors.join('; '), 200);
        }

        if (fastRequest || fastCompleted) {
          db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
            VALUES (?, ?, ?, '', '', ?, '', ?, '[]', '[]', 'fast', ?, ?)
          `).run(prevSessionId, prevProject || project, fastRequest, truncate(fastCompleted, 300), fastRemaining, now.toISOString(), now.getTime());
        }
      } catch (e) { debugCatch(e, 'session-start-fast-summary'); }
    }

    // Clean stale lock files in runtime dir
    try {
      for (const f of readdirSync(RUNTIME_DIR)) {
        if (!f.endsWith('.lock')) continue;
        const lp = join(RUNTIME_DIR, f);
        try {
          const raw = readFileSync(lp, 'utf8');
          const info = JSON.parse(raw);
          const age = Date.now() - (info.ts || 0);
          let stale = age > STALE_LOCK_MS;
          if (!stale && info.pid) {
            try { process.kill(info.pid, 0); } catch (killErr) {
              stale = killErr.code === 'ESRCH';
            }
          }
          if (stale) unlinkSync(lp);
        } catch {
          try {
            const st = statSync(lp);
            if (Date.now() - st.mtimeMs > STALE_LOCK_MS) unlinkSync(lp);
          } catch {}
        }
      }
    } catch {}

    // Token-budgeted observation selection (replaces flat LIMIT 15)
    const selected = selectWithTokenBudget(db, project, 2000);
    const observations = selected.observations;

    // Fallback: recent across all projects with tiered windows (M7: local variable for clarity)
    let fallbackObs = [];
    if (observations.length < 3) {
      const fbOneDayAgo = Date.now() - STALE_SESSION_MS;
      const fbSevenDaysAgo = Date.now() - FALLBACK_OBS_WINDOW_MS;
      fallbackObs = db.prepare(`
        SELECT id, type, title, project, created_at
        FROM observations
        WHERE COALESCE(compressed_into, 0) = 0
          AND (
            (created_at_epoch > ? AND importance >= 1)
            OR (created_at_epoch > ? AND importance >= 2)
          )
        ORDER BY created_at_epoch DESC
        LIMIT 5
      `).all(fbOneDayAgo, fbSevenDaysAgo);
    }

    // Fallback fast summary: if a recently completed session has no summary yet
    // (e.g. /exit → fast restart before Haiku finishes), build one synchronously.
    // Skipped when prevSessionId is set (already handled above).
    if (!prevSessionId) {
      try {
        const recentSession = db.prepare(`
          SELECT content_session_id, project FROM sdk_sessions
          WHERE project = ? AND status = 'completed' AND completed_at_epoch > ?
          ORDER BY completed_at_epoch DESC LIMIT 1
        `).get(project, Date.now() - 120000); // within last 2 minutes

        if (recentSession) {
          const hasSummary = db.prepare(`
            SELECT 1 FROM session_summaries WHERE memory_session_id = ? LIMIT 1
          `).get(recentSession.content_session_id);

          if (!hasSummary) {
            const fp = db.prepare(`
              SELECT prompt_text FROM user_prompts
              WHERE content_session_id = ? ORDER BY prompt_number ASC LIMIT 1
            `).get(recentSession.content_session_id);
            const po = db.prepare(`
              SELECT title FROM observations
              WHERE memory_session_id = ? AND COALESCE(compressed_into, 0) = 0
              ORDER BY created_at_epoch DESC LIMIT 5
            `).all(recentSession.content_session_id);

            const fr = truncate(fp?.prompt_text || '', 200);
            const fc = po.map(o => o.title).filter(Boolean).join('; ');
            if (fr || fc) {
              db.prepare(`
                INSERT INTO session_summaries
                (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, created_at, created_at_epoch)
                VALUES (?, ?, ?, '', '', ?, '', '', '[]', '[]', 'fast', ?, ?)
              `).run(recentSession.content_session_id, project, fr, truncate(fc, 300), now.toISOString(), now.getTime());
            }
          }
        }
      } catch (e) { debugCatch(e, 'session-start-exit-fast-summary'); }
    }

    // Latest session summary
    const latestSummary = db.prepare(`
      SELECT request, completed, next_steps, remaining_items, lessons, key_decisions, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(project);

    // Build summary lines (shared by stdout and CLAUDE.md)
    const summaryLines = buildSummaryLines(latestSummary);

    // Key context: top high-importance observations for CLAUDE.md persistence
    const keyObs = db.prepare(`
      SELECT id, type, title, lesson_learned FROM observations
      WHERE project = ? AND COALESCE(compressed_into, 0) = 0
        AND COALESCE(importance, 1) >= 2
      ORDER BY created_at_epoch DESC LIMIT 5
    `).all(project);
    if (keyObs.length > 0) {
      summaryLines.push('### Key Context');
      for (const o of keyObs) {
        // Strip raw JSON output from degraded Bash-style titles
        const clean = (o.title || '(untitled)')
          .replace(/ → (?:ERROR: )?\{".*$/, '')
          .replace(/ → (?:ERROR: )?\{[^}]*\.{3}$/, '');
        const lesson = o.lesson_learned ? ` — ${truncate(o.lesson_learned, 60)}` : '';
        summaryLines.push(`- [${o.type || 'discovery'}] ${truncate(clean, 80)} (#${o.id})${lesson}`);
      }
      summaryLines.push('');
    } else if (!latestSummary) {
      // Fallback: no summary AND no key observations — show recent activity
      const recentObs = (observations.length >= 3 ? observations : fallbackObs).slice(0, 3);
      if (recentObs.length > 0) {
        summaryLines.push('### Recent Activity');
        for (const o of recentObs) {
          summaryLines.push(`- ${truncate(o.title || '(untitled)', 80)}`);
        }
        summaryLines.push('');
      }
    }

    // Working state from /clear handoff (persisted to both stdout and CLAUDE.md)
    const handoffLines = [];
    if (prevClearHandoff) {
      handoffLines.push('### Working State (from /clear)');
      if (prevClearHandoff.working_on) handoffLines.push(`- Working on: ${truncate(prevClearHandoff.working_on, 200)}`);
      if (prevClearHandoff.unfinished) {
        const pendingSummary = extractUnfinishedSummary(prevClearHandoff.unfinished);
        if (pendingSummary) handoffLines.push(`- Unfinished: ${truncate(pendingSummary, 200)}`);
      }
      if (prevClearHandoff.key_files) {
        try {
          const files = JSON.parse(prevClearHandoff.key_files);
          if (files.length > 0) handoffLines.push(`- Key files: ${files.map(f => basename(f)).join(', ')}`);
        } catch {}
      }
      handoffLines.push('');
    }

    // Build observations table (stdout only — not persisted to CLAUDE.md)
    const obsLines = [];
    const obsToShow = observations.length >= 3 ? observations : fallbackObs;
    if (obsToShow.length > 0) {
      const today = now.toISOString().slice(0, 10);
      obsLines.push(`### Recent (${today})`);
      obsLines.push('');
      obsLines.push('| ID | Time | T | Title |');
      obsLines.push('|----|------|---|-------|');
      for (const o of obsToShow) {
        const proj = o.project ? ` (${o.project})` : '';
        obsLines.push(`| #${o.id} | ${fmtTime(o.created_at)} | ${typeIcon(o.type)} | ${truncate(o.title || '(untitled)', 60)}${proj} |`);
      }
    }

    // Stdout: full context (summary + handoff state + observations table)
    const fullContext = [...summaryLines, ...handoffLines, ...obsLines].join('\n');
    process.stdout.write(`<claude-mem-context>\n${fullContext}\n</claude-mem-context>\n`);

    // CLAUDE.md: slim (summary + handoff state — observations already in stdout)
    updateClaudeMd([...summaryLines, ...handoffLines].join('\n'));

    // Auto-update check (24h throttle, 3s timeout, silent on failure)
    // Fire-and-forget: don't block SessionStart for up to 3s network timeout
    checkForUpdate().then(updateResult => {
      if (updateResult?.updated) {
        process.stdout.write(`\n🔄 claude-mem-lite: v${updateResult.from} → v${updateResult.to} updated\n`);
      } else if (updateResult?.updateAvailable) {
        const hint = updateResult.installDeferred
          ? ' — plugin mode only checks for updates; reinstall/update the plugin to apply it'
          : '';
        process.stdout.write(`\n📦 claude-mem-lite: v${updateResult.to} available (current: v${updateResult.from})${hint}\n`);
      }
    }).catch(e => debugCatch(e, 'session-start-update'));

  } finally {
    db.close();
  }
}

// ─── UserPromptSubmit Handler ────────────────────────────────────────────────

async function handleUserPrompt() {
  let raw;
  try { raw = await readStdin(); } catch { return; }

  let hookData;
  try { hookData = JSON.parse(raw.text); } catch { return; }

  const promptText = hookData.prompt || hookData.user_prompt;
  if (!promptText || typeof promptText !== 'string') return;

  // Skip internal Claude Code protocol messages — not real user input
  if (promptText.startsWith('<task-notification>')) return;

  const sessionId = getSessionId();
  const db = openDb();
  if (!db) return;

  const project = inferProject();

  try {
    const now = new Date();

    // Ensure session exists (INSERT OR IGNORE avoids race condition)
    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

    // Increment prompt counter
    db.prepare('UPDATE sdk_sessions SET prompt_counter = COALESCE(prompt_counter, 0) + 1 WHERE content_session_id = ?').run(sessionId);
    const counter = db.prepare('SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = ?').get(sessionId);

    db.prepare(`
      INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      scrubSecrets(promptText.slice(0, 10000)),
      counter?.prompt_counter || 1,
      now.toISOString(), now.getTime()
    );

    // Cross-session handoff injection (first 3 prompts window, before semantic memory)
    if (counter?.prompt_counter <= 3) {
      try {
        if (detectContinuationIntent(db, promptText, project)) {
          const injection = renderHandoffInjection(db, project);
          if (injection) {
            process.stdout.write(injection + '\n');
            // Consume clear handoff after injection to prevent duplicate injection on prompts 2-3.
            // Exit handoffs are kept (7d TTL, content-dependent keyword/FTS matching won't re-trigger).
            try { db.prepare("DELETE FROM session_handoffs WHERE project = ? AND type = 'clear'").run(project); } catch {}
          }
        }
      } catch (e) { debugCatch(e, 'handleUserPrompt-handoff'); }
    }

    // Semantic memory injection: search past observations for the user's prompt
    try {
      const keyObs = db.prepare(`
        SELECT id FROM observations
        WHERE project = ? AND COALESCE(compressed_into, 0) = 0
          AND COALESCE(importance, 1) >= 2
        ORDER BY created_at_epoch DESC LIMIT 5
      `).all(project);
      const keyContextIds = keyObs.map(o => o.id);

      // Read IDs already injected by user-prompt-search.js to avoid duplicate injection
      try {
        const injectedFile = `/tmp/.claude-mem-injected-${project}`;
        const raw = readFileSync(injectedFile, 'utf8');
        const { ids, ts } = JSON.parse(raw);
        // Only use if written within last 10 seconds (same prompt cycle)
        if (ts && Date.now() - ts < 10000 && Array.isArray(ids)) {
          for (const id of ids) keyContextIds.push(id);
        }
      } catch { /* file may not exist — that's fine */ }

      const memories = searchRelevantMemories(db, promptText, project, keyContextIds);
      if (memories.length > 0) {
        const lines = ['<memory-context relevance="high">'];
        for (const m of memories) {
          const lessonTag = m.lesson_learned ? ` | Lesson: ${m.lesson_learned}` : '';
          lines.push(`- [${m.type}] ${truncate(m.title, 80)}${lessonTag} (#${m.id})`);
        }
        lines.push('</memory-context>');
        process.stdout.write(lines.join('\n') + '\n');
      }
    } catch (e) { debugCatch(e, 'handleUserPrompt-memory'); }
  } finally {
    db.close();
  }
}

// ─── Auto-Compress (Background Worker) ───────────────────────────────────────

/**
 * Background worker: group old low-value observations into weekly summaries.
 * Spawned by SessionStart daily after the fast purge DELETE.
 * Iterates 60-day-old observations, groups by project+week, creates summary per group.
 */
function handleAutoCompress() {
  const db = openDb();
  if (!db) return;

  try {
    const compressCutoff = Date.now() - 60 * 86400000; // 60 days
    const compressCandidates = db.prepare(`
      SELECT id, project, type, title, created_at_epoch
      FROM observations
      WHERE COALESCE(importance, 1) = 1 AND COALESCE(access_count, 0) = 0
        AND created_at_epoch < ?
        AND (compressed_into IS NULL OR compressed_into = ${COMPRESSED_AUTO})
      ORDER BY project, created_at_epoch
    `).all(compressCutoff);
    if (compressCandidates.length < 3) return;

    const groups = new Map();
    for (const c of compressCandidates) {
      const key = `${c.project}::${isoWeekKey(c.created_at_epoch)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    // Transact each group to prevent orphan summaries on crash
    const compressGroup = db.transaction((proj, obs) => {
      const types = {};
      for (const o of obs) types[o.type] = (types[o.type] || 0) + 1;
      const dominantType = Object.entries(types).sort((a, b) => b[1] - a[1])[0][0];
      const title = `Weekly summary: ${obs.length} ${dominantType} observations`;
      const narrative = obs.map(o => `- ${o.title || '(untitled)'}`).join('\n');
      const sortedEpochs = obs.map(o => o.created_at_epoch).sort((a, b) => a - b);
      const medianEpoch = sortedEpochs[Math.floor(sortedEpochs.length / 2)];
      const sessionId = `compress-${proj}`;
      const now = new Date();
      db.prepare(`INSERT OR IGNORE INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?,?,?,?,?,'active')`
      ).run(sessionId, sessionId, proj, now.toISOString(), now.getTime());
      const summaryResult = db.prepare(`INSERT INTO observations
        (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts,
         files_read, files_modified, importance, created_at, created_at_epoch)
        VALUES (?,?,?,?,?,'',?,'','','[]','[]',2,?,?)`
      ).run(sessionId, proj, narrative, dominantType, title, narrative, new Date(medianEpoch).toISOString(), medianEpoch);
      const summaryId = Number(summaryResult.lastInsertRowid);
      const obsIds = obs.map(o => o.id);
      db.prepare(`UPDATE observations SET compressed_into = ? WHERE id IN (${obsIds.map(() => '?').join(',')})`)
        .run(summaryId, ...obsIds);
      return obs.length;
    });
    let totalCompressed = 0;
    for (const [key, obs] of groups) {
      if (obs.length < 3) continue;
      const [proj] = key.split('::');
      totalCompressed += compressGroup(proj, obs);
    }
    if (totalCompressed > 0) {
      debugLog('DEBUG', 'auto-compress', `auto-compressed ${totalCompressed} observations into weekly summaries`);
    }
  } catch (e) {
    debugCatch(e, 'auto-compress');
  } finally {
    db.close();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function readStdin() {
  const MAX_STDIN = 256 * 1024; // 256KB — large tool responses are truncated
  return new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => { debugLog('WARN', 'readStdin', 'stdin timeout after 3s — event dropped'); process.stdin.destroy(); reject(new Error('timeout')); }, 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_STDIN) {
        process.stdin.destroy(); clearTimeout(timeout);
        resolve({ text: data.slice(0, MAX_STDIN), truncated: true });
      }
    });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve({ text: data, truncated: false }); });
    process.stdin.on('error', err => { clearTimeout(timeout); reject(err); });
    process.stdin.resume();
  });
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// Strip ANSI escape codes and extract readable text from tool responses.
// Bash responses come as {stdout, stderr} objects or JSON strings — extract the text content
// instead of producing noisy `{"stdout":"\u001b[1m..."}` in episode descriptions.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
function extractStdio(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const { stdout, stderr } = obj;
  if (typeof stdout === 'string' || typeof stderr === 'string') {
    const parts = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(stderr);
    return parts.join('\n');
  }
  return null;
}
function normalizeToolResponse(toolResponse) {
  if (typeof toolResponse === 'string') {
    // Try to parse JSON strings like '{"stdout":"...","stderr":"..."}'
    if (toolResponse.startsWith('{"stdout"') || toolResponse.startsWith('{"stderr"')) {
      try {
        const parsed = JSON.parse(toolResponse);
        const extracted = extractStdio(parsed);
        if (extracted) return extracted.replace(ANSI_RE, '');
      } catch {}
    }
    return toolResponse.replace(ANSI_RE, '');
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const extracted = extractStdio(toolResponse);
    if (extracted) return extracted.replace(ANSI_RE, '');
    return JSON.stringify(toolResponse).replace(ANSI_RE, '');
  }
  return '';
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  switch (event) {
    case 'post-tool-use':    await handlePostToolUse(); break;
    case 'session-start':    await handleSessionStart(); break;
    case 'stop':             await handleStop(); break;
    case 'user-prompt':      await handleUserPrompt(); break;
    case 'llm-episode':      await handleLLMEpisode(); break;
    case 'llm-summary':      await handleLLMSummary(); break;
    case 'auto-compress':    handleAutoCompress(); break;
  }
} catch (err) {
  // Always log fatal errors (ungated) with structured format
  const ts = new Date().toISOString();
  console.error(`[claude-mem-lite] [${ts}] [ERROR] ${event}: ${err.message}`);
}

process.exit(0);
