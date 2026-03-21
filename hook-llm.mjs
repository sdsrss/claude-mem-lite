// claude-mem-lite: Background LLM workers for episode extraction and session summaries
// Extracted from hook.mjs for testability and reduced complexity

import { basename } from 'path';
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import {
  jaccardSimilarity, truncate, clampImportance, computeRuleImportance,
  inferProject, parseJsonFromLLM,
  computeMinHash, estimateJaccardFromMinHash, cjkBigrams, EDIT_TOOLS, debugCatch, debugLog, OBS_BM25,
} from './utils.mjs';
import { acquireLLMSlot, releaseLLMSlot } from './hook-semaphore.mjs';
import {
  RUNTIME_DIR, DEDUP_WINDOW_MS, RELATED_OBS_WINDOW_MS,
  sessionFile, getSessionId, openDb, callLLM, sleep,
} from './hook-shared.mjs';

// ─── Save Observation to DB ─────────────────────────────────────────────────

/** Build the FTS5 text field from observation data (concepts + facts + searchAliases + CJK bigrams). */
function buildFtsTextField(obs) {
  const conceptsText = Array.isArray(obs.concepts) ? obs.concepts.join(' ') : '';
  const factsText = Array.isArray(obs.facts) ? obs.facts.join(' ') : '';
  const aliasesText = obs.searchAliases || '';
  const bigramText = cjkBigrams((obs.title || '') + ' ' + (obs.narrative || ''));
  return { conceptsText, factsText, textField: [conceptsText, factsText, aliasesText, bigramText].filter(Boolean).join(' ') };
}

export function saveObservation(obs, projectOverride, sessionIdOverride, externalDb) {
  const db = externalDb || openDb();
  if (!db) return null;

  try {
    const now = new Date();
    const project = projectOverride || inferProject();
    const sessionId = sessionIdOverride || getSessionId();

    db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(sessionId, sessionId, project, now.toISOString(), now.getTime());

    // Three-tier dedup
    // Tier 1 (fast): 5-min Jaccard on titles
    const fiveMinAgo = now.getTime() - DEDUP_WINDOW_MS;
    const recent = db.prepare(`
      SELECT title FROM observations
      WHERE project = ? AND created_at_epoch > ?
      ORDER BY created_at_epoch DESC LIMIT 10
    `).all(project, fiveMinAgo);

    if (obs.title && recent.some(r => jaccardSimilarity(r.title, obs.title) > 0.7)) {
      return null;
    }

    // Tier 1.5: Extended title dedup for low-signal degraded titles
    // "Error in X", "Modified X" titles are low-specificity → use longer dedup window
    // 7-day exact match prevents cross-day accumulation of "Modified package.json" noise;
    // 3-day Jaccard catches near-duplicates without blocking legitimately new observations
    const LOW_SIGNAL = /^(Error (while working|in)|Modified |Worked on |Reviewed \d+ files:)/;
    if (obs.title && LOW_SIGNAL.test(obs.title)) {
      const sevenDaysAgo = now.getTime() - 7 * 86400000;
      const threeDaysAgo = now.getTime() - 3 * 86400000;
      // Phase 1: exact title match within 7 days
      const exactDup = db.prepare(`
        SELECT 1 FROM observations
        WHERE project = ? AND title = ? AND created_at_epoch > ? AND created_at_epoch <= ?
        LIMIT 1
      `).get(project, obs.title, sevenDaysAgo, fiveMinAgo);
      if (exactDup) return null;
      // Phase 2: Jaccard similarity for near-duplicates (3-day window)
      const extRecent = db.prepare(`
        SELECT title FROM observations
        WHERE project = ? AND created_at_epoch > ? AND created_at_epoch <= ?
        ORDER BY created_at_epoch DESC LIMIT 60
      `).all(project, threeDaysAgo, fiveMinAgo);
      if (extRecent.some(r => jaccardSimilarity(r.title, obs.title) > 0.85)) {
        return null;
      }
    }

    // Tier 2 (slow): MinHash cross-session dedup (7-day window)
    const minhashSig = computeMinHash((obs.title || '') + ' ' + (obs.narrative || ''));
    if (minhashSig) {
      const sevenDaysAgo = now.getTime() - RELATED_OBS_WINDOW_MS;
      const recentSigs = db.prepare(`
        SELECT minhash_sig FROM observations
        WHERE project = ? AND created_at_epoch > ? AND minhash_sig IS NOT NULL
        ORDER BY created_at_epoch DESC LIMIT 200
      `).all(project, sevenDaysAgo);

      if (recentSigs.some(r => estimateJaccardFromMinHash(minhashSig, r.minhash_sig) > 0.8)) {
        return null;
      }
    }

    const { conceptsText, factsText, textField } = buildFtsTextField(obs);

    const result = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative, concepts, facts, files_read, files_modified, importance, minhash_sig, lesson_learned, search_aliases, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, project,
      textField, obs.type, obs.title, obs.subtitle || '',
      obs.narrative || '',
      conceptsText,
      factsText,
      JSON.stringify(obs.filesRead || []),
      JSON.stringify(obs.files || []),
      obs.importance ?? 1,
      minhashSig,
      obs.lessonLearned || null,
      obs.searchAliases || null,
      now.toISOString(), now.getTime()
    );
    return Number(result.lastInsertRowid);
  } finally {
    if (!externalDb) db.close();
  }
}

// ─── Related Observation Linking ─────────────────────────────────────────────

function linkRelatedObservations(db, savedId, obs, episode) {
  const newObs = db.prepare(`
    SELECT id, title, files_modified, related_ids FROM observations WHERE id = ?
  `).get(savedId);
  if (!newObs) return;

  const candidates = new Set();

  // Strategy 1: FTS5 title similarity (cross-session)
  if (obs.title) {
    const titleTokens = obs.title.replace(/[^a-zA-Z0-9_\s-]/g, ' ').split(/\s+/)
      .filter(t => t.length > 2).slice(0, 5);
    if (titleTokens.length > 0) {
      const ftsQuery = titleTokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      try {
        const ftsMatches = db.prepare(`
          SELECT o.id FROM observations_fts
          JOIN observations o ON observations_fts.rowid = o.id
          WHERE observations_fts MATCH ? AND o.id != ? AND o.project = ?
          ORDER BY ${OBS_BM25}
          LIMIT 5
        `).all(ftsQuery, newObs.id, episode.project);
        for (const m of ftsMatches) candidates.add(m.id);
      } catch (e) { debugCatch(e, 'linkRelated-fts'); }
    }
  }

  // Strategy 2: file overlap (any session, recent observations)
  let newFiles;
  try { newFiles = JSON.parse(newObs.files_modified || '[]'); } catch (e) { debugCatch(e, 'linkRelated-newFiles'); newFiles = []; }
  if (!Array.isArray(newFiles) || !newFiles.every(f => typeof f === 'string')) newFiles = [];
  if (newFiles.length > 0) {
    const recentObs = db.prepare(`
      SELECT id, files_modified FROM observations
      WHERE id != ? AND created_at_epoch > ? AND project = ?
      ORDER BY created_at_epoch DESC LIMIT 50
    `).all(newObs.id, Date.now() - RELATED_OBS_WINDOW_MS, episode.project);
    for (const r of recentObs) {
      let rFiles;
      try { rFiles = JSON.parse(r.files_modified || '[]'); } catch (e) { debugCatch(e, 'linkRelated-rFiles'); rFiles = []; }
      if (!Array.isArray(rFiles) || !rFiles.every(f => typeof f === 'string')) rFiles = [];
      if (rFiles.some(f => newFiles.includes(f))) candidates.add(r.id);
    }
  }

  // Apply bidirectional links (max 5 related)
  if (candidates.size > 0) {
    let newRelated;
    try { newRelated = JSON.parse(newObs.related_ids || '[]'); } catch (e) { debugCatch(e, 'linkRelated-newRelated'); newRelated = []; }
    if (!Array.isArray(newRelated) || !newRelated.every(id => Number.isInteger(id))) newRelated = [];

    for (const relId of [...candidates].slice(0, 5)) {
      if (newRelated.includes(relId)) continue;
      newRelated.push(relId);

      const rel = db.prepare('SELECT related_ids FROM observations WHERE id = ?').get(relId);
      if (rel) {
        let relRelated;
        try { relRelated = JSON.parse(rel.related_ids || '[]'); } catch (e) { debugCatch(e, 'linkRelated-relRelated'); relRelated = []; }
        if (!Array.isArray(relRelated) || !relRelated.every(id => Number.isInteger(id))) relRelated = [];
        if (!relRelated.includes(newObs.id)) {
          relRelated.push(newObs.id);
          db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(relRelated.slice(-10)), relId);
        }
      }
    }

    db.prepare('UPDATE observations SET related_ids = ? WHERE id = ?').run(JSON.stringify(newRelated.slice(-10)), newObs.id);
  }
}

// ─── Degraded Title Builder ──────────────────────────────────────────────────
// When LLM is unavailable, build a readable title from episode metadata
// instead of using raw makeEntryDesc output (which contains JSON stdout).

export function buildDegradedTitle(episode) {
  const files = (episode.files || []).filter(Boolean);
  const hasError = episode.entries.some(e => e.isError);
  const hasEdit = episode.entries.some(e => EDIT_TOOLS.has(e.tool));

  // Extract a short error hint from the first error entry's desc
  let errorHint = '';
  if (hasError) {
    const errEntry = episode.entries.find(e => e.isError);
    if (errEntry?.desc) {
      // Extract meaningful error text from "cmd → ERROR: ..." format
      const errMatch = errEntry.desc.match(/→ ERROR: (.{3,80})/);
      if (errMatch) {
        // Clean JSON/noise from the error snippet
        const cleaned = errMatch[1].replace(/[{"[\]]/g, '').replace(/\\n/g, ' ').trim();
        if (cleaned.length >= 4) errorHint = `: ${truncate(cleaned, 50)}`;
      }
    }
  }

  if (files.length > 0) {
    const names = files.map(f => basename(f)).slice(0, 3).join(', ');
    const suffix = files.length > 3 ? ` +${files.length - 3} more` : '';
    if (hasError) {
      // Include the triggering command for richer context: "Error: dispatch.mjs — npm test failed"
      const errEntry = episode.entries.find(e => e.isError);
      const cmd = errEntry?.desc?.match(/^(.{3,30}?) →/)?.[1]?.trim();
      const cmdHint = cmd ? ` — ${cmd}` : '';
      return `Error: ${names}${suffix}${errorHint || cmdHint}`;
    }
    if (hasEdit) return `Modified ${names}${suffix}`;
    return `Worked on ${names}${suffix}`;
  }
  // No files: strip raw JSON output from Bash descriptions
  const desc = episode.entries[0]?.desc || '(no description)';
  return desc.replace(/ → (?:ERROR: )?\{.*$/, hasError ? ' (error)' : '');
}

/**
 * Build a rule-based observation from episode metadata for immediate DB persistence.
 * Used as pre-save (before LLM) and as fallback when LLM is unavailable.
 * @param {object} episode Episode with entries, files, filesRead arrays
 * @returns {object} Observation object ready for saveObservation()
 */
export function buildImmediateObservation(episode) {
  const hasError = episode.entries.some(e => e.isError);
  const hasEdit = episode.entries.some(e => EDIT_TOOLS.has(e.tool));
  const readCount = episode.entries.filter(e => e.tool === 'Read' || e.tool === 'Grep').length;
  const isReviewPattern = !hasEdit && !hasError && readCount >= 5;
  const inferredType = hasError ? 'bugfix' : hasEdit ? 'change' : 'discovery';
  const fileList = (episode.files || []).map(f => basename(f)).join(', ') || '(multiple)';

  // Review/research episodes: use a descriptive title with file count
  let title;
  if (isReviewPattern) {
    const allFiles = [...new Set([
      ...(episode.files || []),
      ...(episode.filesRead || []),
    ])].map(f => basename(f));
    const names = allFiles.slice(0, 4).join(', ');
    const suffix = allFiles.length > 4 ? ` +${allFiles.length - 4} more` : '';
    title = truncate(`Reviewed ${allFiles.length} files: ${names}${suffix}`, 120);
  } else {
    title = truncate(buildDegradedTitle(episode), 120);
  }

  const ruleImportance = computeRuleImportance(episode);
  // Low-signal degraded titles ("Error in...", "Modified...") should not inflate importance.
  // Cap at 1 unless rule-based signals indicate genuine importance (error-in-test → 3, config → 2).
  const LOW_SIGNAL = /^(Error (while working|in)|Modified |Worked on |Reviewed \d+ files:)/;
  const isLowSignal = LOW_SIGNAL.test(title);
  let importance;
  if (isReviewPattern) {
    importance = Math.max(2, ruleImportance);
  } else if (isLowSignal && ruleImportance <= 2) {
    importance = 1; // Degraded titles stay low unless rule signals critical (imp=3)
  } else {
    importance = ruleImportance;
  }

  // Separate files_modified (from Edit/Write tools) from files_read (everything else)
  const modifiedFiles = new Set();
  const searchedFiles = new Set();
  for (const entry of episode.entries) {
    if (!entry.files) continue;
    if (EDIT_TOOLS.has(entry.tool)) {
      for (const f of entry.files) modifiedFiles.add(f);
    } else {
      for (const f of entry.files) searchedFiles.add(f);
    }
  }
  // Merge bash-tracked reads and search tool files into filesRead
  const allReads = new Set([...(episode.filesRead || []), ...searchedFiles]);
  // Remove files that were both searched AND modified — they're modified
  for (const f of modifiedFiles) allReads.delete(f);

  return {
    type: inferredType,
    title,
    subtitle: fileList,
    narrative: episode.entries.map(e => e.desc).join('; '),
    concepts: [],
    facts: [],
    files: [...modifiedFiles],
    filesRead: [...allReads],
    importance,
  };
}

// ─── Background: LLM Episode Extraction (Tier 2 F) ──────────────────────────

export async function handleLLMEpisode() {
  const tmpFile = process.argv[3];
  if (!tmpFile) return;

  let episode;
  try {
    episode = JSON.parse(readFileSync(tmpFile, 'utf8'));
  } catch {
    try { unlinkSync(tmpFile); } catch {}
    return;
  }

  if (!episode.entries || episode.entries.length === 0) {
    try { unlinkSync(tmpFile); } catch {}
    return;
  }

  // Rate-limit background LLM calls to avoid competing with active sessions
  if (!process.env.CLAUDE_MEM_NO_DELAY) {
    const sessionActive = existsSync(sessionFile());
    const delayMs = sessionActive
      ? 2000 + Math.random() * 3000
      : 500 + Math.random() * 1000;
    debugLog('DEBUG', 'llm-episode', `delay: ${Math.round(delayMs)}ms (session ${sessionActive ? 'active' : 'ended'})`);
    await sleep(delayMs);
  }

  const fileList = episode.files.map(f => basename(f)).join(', ') || '(multiple)';

  let prompt;
  if (episode.entries.length === 1) {
    const e = episode.entries[0];
    prompt = `Extract a structured observation from this code change. Return ONLY valid JSON, no markdown fences.

Tool: ${e.tool}
File: ${episode.files.join(', ') || 'unknown'}
Action: ${e.desc}
Error: ${e.isError ? 'yes' : 'no'}

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"concise ≤80 char description","narrative":"what changed, why, and outcome (2-3 sentences)","concepts":["kw1","kw2"],"facts":["fact1","fact2"],"importance":1,"lesson_learned":"non-obvious insight or 'none' if routine","search_aliases":["alt query 1","alt query 2"]}
Facts: each MUST be (1) atomic—one claim, (2) self-contained—no pronouns, include file/function name, (3) specific—"refreshToken() in auth.ts:45 uses 1h TTL" not "handles tokens"
importance: Be strict — default to 1. 0=pure browsing with zero learning value. 1=routine file edits, standard changes, normal workflow (MOST episodes). 2=notable ONLY if it reveals something non-obvious: error fix with discovered root cause, architectural decision with explicit tradeoff, config change with unexpected side effects. 3=critical: breaking change affecting users, security vulnerability fix, data migration. Ask yourself: "would a future session benefit from knowing this?" — if not, it's importance=1.
lesson_learned: REQUIRED field. State what was learned that isn't obvious from reading the code. Examples: "FTS5 porter stemmer doesn't tokenize CJK — need bigram workaround", "vitest --reporter=verbose hangs on large test suites, use default reporter". If purely routine with nothing learned, write "none" (not null).
search_aliases: 2-6 alternative search terms someone might use to find this memory later (include CJK if project uses Chinese)`;
  } else {
    const actionList = episode.entries.map((e, i) =>
      `${i + 1}. [${e.tool}] ${e.desc}${e.isError ? ' (ERROR)' : ''}`
    ).join('\n');

    prompt = `Summarize this coding episode as ONE coherent observation. Return ONLY valid JSON, no markdown fences.

Project: ${episode.project}
Files: ${fileList}
Actions (${episode.entries.length} total):
${actionList}

JSON: {"type":"decision|bugfix|feature|refactor|discovery|change","title":"coherent ≤80 char summary","narrative":"what was done, why, and outcome (3-5 sentences)","concepts":["keyword1","keyword2"],"facts":["specific fact 1","specific fact 2"],"importance":1,"lesson_learned":"non-obvious insight or 'none' if routine","search_aliases":["alt query 1","alt query 2"]}
Facts: each MUST be (1) atomic—one claim, (2) self-contained—no pronouns, include file/function name, (3) specific—"refreshToken() in auth.ts:45 uses 1h TTL" not "handles tokens"
importance: Be strict — default to 1. 0=pure browsing with zero learning value. 1=routine file edits, standard changes, normal workflow (MOST episodes). 2=notable ONLY if it reveals something non-obvious: error fix with discovered root cause, architectural decision with explicit tradeoff, config change with unexpected side effects. 3=critical: breaking change affecting users, security vulnerability fix, data migration. Ask yourself: "would a future session benefit from knowing this?" — if not, it's importance=1.
lesson_learned: REQUIRED field. State what was learned that isn't obvious from reading the code. Examples: "FTS5 porter stemmer doesn't tokenize CJK — need bigram workaround", "vitest --reporter=verbose hangs on large test suites, use default reporter". If purely routine with nothing learned, write "none" (not null).
search_aliases: 2-6 alternative search terms someone might use to find this memory later (include CJK if project uses Chinese)`;
  }

  const ruleImportance = computeRuleImportance(episode);

  let obs;
  const validTypes = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

  const gotSlot = await acquireLLMSlot();
  if (gotSlot) {
    let raw, parsed;
    try {
      raw = callLLM(prompt);
      parsed = parseJsonFromLLM(raw);
    } finally {
      releaseLLMSlot();
    }

    if (parsed && parsed.title) {
      // Discard if LLM judges observation has no learning value
      if (parsed.importance === 0 || parsed.importance === '0') {
        debugLog('DEBUG', 'llm-episode', `Discarded low-value observation: ${parsed.title}`);
        // If pre-saved, delete it too
        if (episode.savedId) {
          const ddb = openDb();
          if (ddb) {
            try { ddb.prepare('DELETE FROM observations WHERE id = ?').run(episode.savedId); }
            finally { ddb.close(); }
          }
        }
        try { unlinkSync(tmpFile); } catch {}
        return;
      }

      const lessonLearned = typeof parsed.lesson_learned === 'string'
        && parsed.lesson_learned.toLowerCase() !== 'none'
        && parsed.lesson_learned.trim().length > 0
        ? parsed.lesson_learned.slice(0, 500) : null;
      const searchAliases = Array.isArray(parsed.search_aliases)
        ? parsed.search_aliases.slice(0, 6).join(' ')
        : null;

      obs = {
        type: validTypes.has(parsed.type) ? parsed.type : 'change',
        title: truncate(parsed.title, 120),
        subtitle: fileList,
        narrative: truncate(parsed.narrative || '', 500),
        concepts: Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 10) : [],
        facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 10) : [],
        files: episode.files,
        filesRead: episode.filesRead || [],
        importance: Math.max(ruleImportance, clampImportance(parsed.importance)),
        lessonLearned,
        searchAliases,
      };
    }
  }

  if (!obs) {
    if (!gotSlot) debugLog('WARN', 'llm-episode', 'semaphore timeout, using degraded storage');
    // If pre-saved observation exists, LLM degraded mode doesn't need to overwrite — keep pre-saved data
    if (episode.savedId) {
      debugLog('DEBUG', 'llm-episode', `LLM failed but pre-saved obs #${episode.savedId} exists, keeping`);
      try { unlinkSync(tmpFile); } catch {}
      return;
    }
    obs = buildImmediateObservation(episode);
  }

  const db = openDb();
  if (!db) { try { unlinkSync(tmpFile); } catch {} return; }

  try {
    let savedId;

    if (episode.savedId && obs) {
      // Upgrade pre-saved observation with LLM-enriched data
      const { conceptsText, factsText, textField } = buildFtsTextField(obs);
      const minhashSig = computeMinHash((obs.title || '') + ' ' + (obs.narrative || ''));
      db.prepare(`
        UPDATE observations SET type=?, title=?, subtitle=?, narrative=?, concepts=?, facts=?,
          text=?, importance=?, files_read=?, minhash_sig=?, lesson_learned=?, search_aliases=?
        WHERE id = ?
      `).run(
        obs.type, truncate(obs.title, 120), obs.subtitle || '',
        truncate(obs.narrative || '', 500),
        conceptsText, factsText, textField,
        obs.importance,
        JSON.stringify(obs.filesRead || []),
        minhashSig,
        obs.lessonLearned || null,
        obs.searchAliases || null,
        episode.savedId
      );
      savedId = episode.savedId;
      debugLog('DEBUG', 'llm-episode', `upgraded pre-saved obs #${savedId}`);
    } else {
      savedId = saveObservation(obs, episode.project, episode.sessionId, db);
    }

    if (savedId) {
      try {
        linkRelatedObservations(db, savedId, obs, episode);
      } catch (e) { debugCatch(e, 'relatedObsLinking'); }
    }
  } finally {
    db.close();
  }

  try { unlinkSync(tmpFile); } catch {}
}

// ─── Background: LLM Session Summary ────────────────────────────────────────

export async function handleLLMSummary() {
  const parsed = parseInt(process.env.CLAUDE_MEM_FLUSH_TIMEOUT, 10);
  const flushTimeout = Number.isNaN(parsed) ? 15 : parsed;
  for (let i = 0; i < flushTimeout; i++) {
    try {
      const files = readdirSync(RUNTIME_DIR).filter(f => f.startsWith('ep-flush-'));
      if (files.length === 0) break;
    } catch { break; }
    debugLog('DEBUG', 'llm-summary', `waiting for flush files (${i + 1}/15)`);
    await sleep(1000);
  }

  const db = openDb();
  if (!db) return;

  try {
    const sessionId = process.argv[3] || getSessionId();
    const project = process.argv[4] || inferProject();

    const recentObs = db.prepare(`
      SELECT id, type, title, narrative
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 30
    `).all(sessionId);

    if (recentObs.length < 1) return;

    const obsList = recentObs.map((o, i) =>
      `${i + 1}. [${o.type}] ${o.title}${o.narrative ? ': ' + truncate(o.narrative, 200) : ''}`
    ).join('\n');

    // Include user prompts for richer context
    const userPrompts = db.prepare(`
      SELECT prompt_text FROM user_prompts
      WHERE content_session_id = ? ORDER BY prompt_number ASC LIMIT 10
    `).all(sessionId).map(p => truncate(p.prompt_text, 300));
    const promptCtx = userPrompts.length > 0
      ? `\nUser requests: ${userPrompts.join(' → ')}\n`
      : '';

    const prompt = `Summarize this coding session. Return ONLY valid JSON, no markdown fences.

Project: ${project}${promptCtx}
Observations (${recentObs.length} total):
${obsList}

JSON: {"request":"what the user was working on","completed":"specific items accomplished with file names","remaining_items":"specific unfinished items from the original request — compare investigation scope with actual changes to infer what was NOT yet done; be precise with file:issue format, or empty string if all done","next_steps":"suggested follow-up","lessons":["non-obvious insights discovered during this session"],"key_decisions":["important design choices made and WHY"]}
lessons: Only genuinely non-obvious insights (debugging discoveries, gotchas, architectural reasons). Empty array if routine.
key_decisions: Only decisions with lasting impact (library choices, architecture, data model). Include reasoning. Empty array if none.`;

    if (!(await acquireLLMSlot())) {
      debugLog('WARN', 'llm-summary', 'semaphore timeout, skipping summary');
      return;
    }

    let raw, llmParsed;
    try {
      raw = callLLM(prompt, 20000);
      llmParsed = parseJsonFromLLM(raw);
    } finally {
      releaseLLMSlot();
    }

    if (llmParsed && llmParsed.request) {
      const now = new Date();
      const lessonsJson = Array.isArray(llmParsed.lessons) && llmParsed.lessons.length > 0
        ? JSON.stringify(llmParsed.lessons) : null;
      const decisionsJson = Array.isArray(llmParsed.key_decisions) && llmParsed.key_decisions.length > 0
        ? JSON.stringify(llmParsed.key_decisions) : null;

      // Upgrade existing fast summary instead of creating a duplicate
      const existingFast = db.prepare(`
        SELECT id FROM session_summaries
        WHERE memory_session_id = ? AND notes = 'fast'
        LIMIT 1
      `).get(sessionId);

      if (existingFast) {
        db.prepare(`
          UPDATE session_summaries
          SET request=?, investigated=?, learned=?, completed=?, next_steps=?, remaining_items=?,
              lessons=?, key_decisions=?, notes='llm', created_at=?, created_at_epoch=?
          WHERE id = ?
        `).run(
          llmParsed.request || '', llmParsed.investigated || '', llmParsed.learned || '',
          llmParsed.completed || '', llmParsed.next_steps || '',
          llmParsed.remaining_items || '',
          lessonsJson, decisionsJson,
          now.toISOString(), now.getTime(),
          existingFast.id
        );
      } else {
        db.prepare(`
          INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed, next_steps, remaining_items, files_read, files_edited, notes, lessons, key_decisions, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '', ?, ?, ?, ?)
        `).run(
          sessionId, project,
          llmParsed.request || '', llmParsed.investigated || '', llmParsed.learned || '',
          llmParsed.completed || '', llmParsed.next_steps || '',
          llmParsed.remaining_items || '',
          lessonsJson, decisionsJson,
          now.toISOString(), now.getTime()
        );
      }
    }
  } finally {
    db.close();
  }
}
