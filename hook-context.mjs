// claude-mem-lite CLAUDE.md context injection and token budgeting
// SHARED ENGINE — the `hook-` prefix is historical, not a scope. buildSessionContextLines
// is imported by hook.mjs (SessionStart), mem-cli.mjs (`context` command) and
// hook-precompact.mjs, so it runs outside the hook pipeline too. Do not assume
// hook-pipeline session lifecycle or single-writer concurrency here.
// Handles adaptive time windows, token-budgeted selection, and legacy CLAUDE.md cleanup.

import { basename, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';
import {
  estimateTokens,
  truncate,
  typeIcon,
  fmtTime,
  inferProject,
  debugLog,
  neutralizeContextDelimiters,
  DECAY_HALF_LIFE_BY_TYPE,
  DEFAULT_DECAY_HALF_LIFE_MS,
  notLowSignalTitleClause,
} from './utils.mjs';
import {
  STALE_SESSION_MS,
  RELATED_OBS_WINDOW_MS,
  RUNTIME_DIR,
  effectiveQuiet,
  isQuietHooks,
  KEY_CONTEXT_LIMIT,
} from './hook-shared.mjs';
import { extractUnfinishedSummary } from './hook-handoff.mjs';
import { recentInjectableEvents, renderInjectableEvent } from './lib/events-injection.mjs';
import { liveObsFilterSql } from './lib/inject-search-core.mjs';
// The canonical one (v3.84.0): this file carried a byte-identical private copy, which is
// the same one-home rule this release enforced for the cooldown path and the dashboard.
import { inferProjectDir } from './project-utils.mjs';
// Single source for the type-quality weights (audit 2026-08-22 P2-10) — this table used
// to be hand-copied here and in hook-memory.mjs, kept equal only by comment convention.
import { TYPE_QUALITY, TYPE_QUALITY_DEFAULT } from './scoring-sql.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
/**
 * Compute adaptive recall time windows based on project activity velocity.
 * High activity -> shorter windows (recent data more relevant).
 * Low activity -> longer windows (older data stays relevant).
 * @param {object} db better-sqlite3 database handle
 * @param {string} project Project name to check velocity for
 * @returns {{tier1: number, tier2: number, tier3: number, sessWindow: number}} Time window durations in ms
 */
// Sanitize a string for a GitHub-flavored-markdown table cell: a literal `|`
// in a title (e.g. "grep | sort | uniq") would otherwise open phantom columns
// and corrupt the <claude-mem-context> Recent table the model+user see every
// SessionStart. Escape pipes and collapse any CR/LF/tab to a space so one obs
// stays one row/cell.
function mdCell(s) {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\|/g, '\\|');
}

export function computeAdaptiveWindows(db, project) {
  const sevenDaysAgo = Date.now() - 7 * DAY_MS;
  // liveObsFilterSql, not a hand-written half of it (A20260906-R8-§11.3). This COUNT is a
  // POOL-SIZING input: the windows returned below are handed to the recall queries at :201 /
  // :468 / :502, all three of which filter live rows. Counting a strictly larger population
  // than the window is applied to inverts the documented intent — 80 superseded rows read as
  // >10 obs/day and earned the TIGHTEST window (12h) for finding the few live rows left.
  const row = db
    .prepare(
      `
    SELECT COUNT(*) as c FROM observations
    WHERE project = ? AND created_at_epoch > ? AND ${liveObsFilterSql('')}
  `,
    )
    .get(project, sevenDaysAgo);
  const velocity = (row?.c || 0) / 7; // observations per day

  if (velocity > 10) {
    // High velocity: tighter windows, focus on very recent
    return { tier1: 12 * 3600000, tier2: 3 * DAY_MS, tier3: 14 * DAY_MS, sessWindow: 3 * DAY_MS };
  } else if (velocity >= 3) {
    // Medium velocity: default windows
    return { tier1: 24 * 3600000, tier2: 7 * DAY_MS, tier3: 30 * DAY_MS, sessWindow: 7 * DAY_MS };
  } else {
    // Low velocity: wider windows, older data still relevant
    return { tier1: 48 * 3600000, tier2: 14 * DAY_MS, tier3: 60 * DAY_MS, sessWindow: 14 * DAY_MS };
  }
}

// D#192 (filed as D#189, re-scoped after measurement). These two are REACHABILITY bounds, not ranking bounds — the D#172 shape, and
// the fifth surface it has been found on. Both SELECTs order by pure `created_at_epoch
// DESC`; the JS below then re-sorts every candidate by `valueDensity`, a composite of
// typeQuality x impBoost(1.0/1.5/2.0) x lessonBoost(1.0/1.3) / sqrt(cost) whose dynamic
// range is far wider than the (1,2] that recency contributes. So the key the SQL sorts
// on barely participates in the final order, and anything past the LIMIT is unreachable
// however well it scores.
//
// Named rather than inline so benchmark/keyctx-pool-replay.mjs can patch a twin and
// price a change to them. Keep the `const NAME = <int>;` shape — that ruler patches the
// DECLARATION by regex and throws when the anchor moves. (Said `export const` until
// D#207: the names went module-private once knip could finally see this file and
// reported them as permanently unused, and the ruler's regex was widened to match a bare
// `const`, which is what its rerank-pool sibling always matched.)
//
// OBS was 50 through v3.86.0 and is now an OOM backstop, not a relevance gate. What the
// ruler measured before the change (2026-09-02T06:11Z, 11 projects with >=20 live rows,
// budget 2000, AGAINST THE 50/10 TREE — reproduce with `--population --ref-obs 50
// --ref-sess 10` and with `--wide-obs 50 --wide-sess 10`, which runs the comparison
// backwards; the bare command now reports 0/11 because shipped is the wider bound):
// the 50-row bound truncated the pool in 3 of 11 projects, and lifting it
// alone moved the injected block in 2 of 11 — 8 rows newly reachable against 2 displaced,
// for +81 and +16 tokens. Selection here is NOT monotone, so a displaced row is a real
// cost and the ruler prints it as a first-class number (`--why-displaced` names the rows
// and the gate that dropped each).
//
// Both displaced rows lost their slot to the 3-per-type diversity cap. That is not a
// three-way discrimination: the token budget does not bind on this corpus (651 of 2000 in
// the widest arm's largest project) and the file-overlap `continue` that used to sit in
// the selector was UNREACHABLE and has since been deleted (D#197) — so the cap is
// currently the only gate that can fire. ("below" until v3.88.0; there is nothing below
// any more, and a reader who went looking found the sentence outliving its referent.)
//
// 200 is ~2x the largest pool observed (107). The ruler CANNOT distinguish 200 from 500
// on this corpus — every bound >= the largest pool is one arm, identical in both
// selection and cost — so this value is a headroom choice, not a measured optimum.
// computeAdaptiveWindows NARROWS the windows as velocity rises (tier3 60d -> 30d -> 14d),
// so activity counteracts pool growth instead of driving it: the largest pool here is the
// lowest-velocity high-volume project (1.14 obs/day, 107 rows) while the only project a
// band up has 2.9x the velocity and 29% of the pool. A draft of this comment had that
// backwards.
//
// Cost is PER PROJECT: ~2.7x where the pool is 107, ~2.0x at 59, ~1.5x at 62, and
// unchanged (inferred, not measured) for the eight projects whose pool never reached 50.
// Once per SessionStart, both arms in the low single-digit milliseconds. It is NOT a clean
// function of pool growth — the 59-row project grows less than the 62-row one and costs
// more, on two independent harnesses, because fixed per-call work (SQL fetch,
// estimateTokens, JSON.parse, the unchanged summary half) sets the denominator. Three
// drafts were wrong here in three ways: a point estimate (2.65x), a global range
// (2.1x-3.8x) no measurement produced, and a causal claim n=3 refutes. Absolute
// milliseconds are not quotable. Re-derive with `--cost --wide-obs 50 --wide-sess 10
// --project <p>`, which prices the widening in the correct direction.
//
// SESS stays 10 DELIBERATELY, and the discriminator is `sessDisplaced = 0` in 11 of 11
// projects, not the observation column. Widening it to 40 displaces no summary at all —
// it is PURELY ADDITIVE, so that LIMIT is a volume cap and not the D#172 shape, which is
// the actual reason it does not need lifting. (It also changed zero observations, but
// that only says the obs side is unaffected.) What widening does buy is 130 newly injected
// summaries, roughly tripling the emitted block on the largest projects. It truncates MORE
// projects than the obs bound, 5 of 11 against 3 of 11, which is what made the original
// review propose it first; truncation count is not harm.
// Module-private, like their siblings RERANK_POOL_SAME_PROJECT / RERANK_POOL_CROSS_PROJECT
// in hook-memory.mjs. Nothing imports them: `benchmark/keyctx-pool-replay.mjs` rewrites
// these DECLARATIONS with a regex over this file's text, which needs no export, and being
// exported by habit put two permanently-unused names into knip's report the moment D#207
// made this module visible to it. Raising a baseline is the wrong way to hold a name
// (v3.70.0 precedent, #9675). The replay's `patchConst` matches `const <NAME> = <n>;`.
const KEYCTX_POOL_OBS = 200;
const KEYCTX_POOL_SESS = 10;

/**
 * Split the shared Key Context pool between its two sections (D#196).
 *
 * Each keeps a guaranteed half and may take whatever the other cannot use, so the two
 * together still emit at most KEY_CONTEXT_LIMIT rows. Extracted from the render block so
 * the additivity property can be asserted over every split rather than sampled through a
 * seeded database.
 *
 * @param {number} fileLessonCount rows that landed in the File Lessons section
 * @param {number} keyContextCount rows that landed in the Key Context section
 * @returns {{fileLessonQuota: number, keyContextQuota: number}}
 */
export function sectionQuotas(fileLessonCount, keyContextCount) {
  const half = Math.floor(KEY_CONTEXT_LIMIT / 2);
  const fileLessonQuota = Math.min(
    fileLessonCount,
    Math.max(half, KEY_CONTEXT_LIMIT - Math.min(keyContextCount, half)),
  );
  const keyContextQuota = Math.min(keyContextCount, KEY_CONTEXT_LIMIT - fileLessonQuota);
  return { fileLessonQuota, keyContextQuota };
}

/**
 * Select observations and sessions within a token budget using greedy knapsack.
 * Scores candidates by recency * importance, picks highest value-density first.
 * @param {object} db better-sqlite3 database handle
 * @param {string} project Project name
 * @param {number} [budget=2000] Maximum token budget
 * @returns {{observations: object[], summaries: object[], totalTokens: number}} Selected items
 */
export function selectWithTokenBudget(db, project, budget = 2000) {
  const now_ms = Date.now();
  const windows = computeAdaptiveWindows(db, project);
  const tier1Ago = now_ms - windows.tier1;
  const tier2Ago = now_ms - windows.tier2;
  const tier3Ago = now_ms - windows.tier3;

  // Candidate pool: tiered time windows by importance (adaptive).
  // R1/R3: exclude LOW_SIGNAL degraded titles ("Modified X", "Worked on X",
  // "Reviewed N files:", raw error logs) from the Key Context table at
  // session start — they pollute the visible "Recent" table with noise.
  const obsPool = db
    .prepare(
      `
    SELECT id, type, title, narrative, importance, created_at_epoch, files_modified, lesson_learned
    FROM observations
    WHERE project = ? AND ${liveObsFilterSql('')}
      AND ${notLowSignalTitleClause('')}
      AND (
        (created_at_epoch > ? AND importance >= 1)
        OR (created_at_epoch > ? AND importance >= 2)
        OR (created_at_epoch > ? AND importance >= 3)
      )
    ORDER BY created_at_epoch DESC
    LIMIT ${KEYCTX_POOL_OBS}
  `,
    )
    .all(project, tier1Ago, tier2Ago, tier3Ago);

  const sessPool = db
    .prepare(
      `
    SELECT id, request, completed, next_steps, created_at_epoch
    FROM session_summaries
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch DESC
    LIMIT ${KEYCTX_POOL_SESS}
  `,
    )
    .all(project, now_ms - windows.sessWindow);

  const selectedObs = [];
  const selectedSess = [];
  let totalTokens = 0;

  // Score each candidate: value = recency * type_quality * importance, cost = tokens
  // Recency uses exponential half-life (consistent with server.mjs BM25 scoring)
  const scoredObs = obsPool.map((o) => {
    const halfLifeMs = DECAY_HALF_LIFE_BY_TYPE[o.type] || DEFAULT_DECAY_HALF_LIFE_MS;
    const recency = 1.0 + Math.exp((-0.693 * (now_ms - o.created_at_epoch)) / halfLifeMs);
    const typeQuality = TYPE_QUALITY[o.type] || TYPE_QUALITY_DEFAULT;
    const impBoost = 0.5 + 0.5 * (o.importance || 1);
    const lessonBoost = o.lesson_learned ? 1.3 : 1.0;
    const value = recency * typeQuality * impBoost * lessonBoost;
    // Cost = ONLY what is injected. The Recent table renders title-only (narrative is neither
    // pushed nor emitted), so charging title+narrative made the budget measure ~5x the real
    // injected size — it filled to ~44% of capacity and, worse, the √cost density term penalized
    // long-narrative rows that cost nothing to inject. Title-only cost fills the budget with the
    // rows actually shown and makes valueDensity = value per injected token.
    const cost = estimateTokens(o.title || '');
    return { ...o, value, cost, valueDensity: cost > 0 ? value / Math.sqrt(cost) : 0 };
  });

  const scoredSess = sessPool.map((s) => {
    const recency = 1.0 + Math.exp((-0.693 * (now_ms - s.created_at_epoch)) / DEFAULT_DECAY_HALF_LIFE_MS);
    const value = recency * 1.5; // Session summaries slightly boosted
    const cost = estimateTokens((s.request || '') + (s.completed || '') + (s.next_steps || ''));
    return { ...s, value, cost, valueDensity: cost > 0 ? value / Math.sqrt(cost) : 0 };
  });

  // Combine and sort by value density (greedy knapsack)
  const allCandidates = [
    ...scoredObs.map((o) => ({ ...o, _kind: 'obs' })),
    ...scoredSess.map((s) => ({ ...s, _kind: 'sess' })),
  ].sort((a, b) => b.valueDensity - a.valueDensity);

  const selectedTypes = new Map(); // type → count for diversity constraint

  for (const c of allCandidates) {
    if (totalTokens + c.cost > budget) continue;

    // Type diversity: max 3 observations of same type (checked first to avoid file set pollution)
    if (c._kind === 'obs' && c.type) {
      const typeCount = selectedTypes.get(c.type) || 0;
      if (typeCount >= 3) continue;
    }

    // D#197: a "Diversity penalty: reduce value for file overlap" block used to sit
    // here. It is gone, and the deletion is behaviour-preserving, because it reduced
    // nothing. Two independent reasons, both verified rather than reasoned about:
    //
    //  (1) Its `penalizedValue` was a local read by exactly one `continue`. Order was
    //      already fixed upstream by the raw-valueDensity sort and this greedy loop
    //      never re-sorts — so the comment's promise could not happen at all.
    //  (2) That `continue` was unreachable. penalizedValue >= 0.7 * valueDensity, and
    //      valueDensity = value / sqrt(cost) with value > 0.5 (recency > 1 x
    //      TYPE_QUALITY min 0.5 x impBoost >= 1.0 x lessonBoost >= 1.0) and cost >= 1
    //      — estimateTokens('') returns 1, checked, so there is no zero-cost row that
    //      would drive valueDensity to 0 and make it fire. Triggering needed a title
    //      costing > 122500 tokens. Measured over the 2027 live rows carrying
    //      files_modified: zero zero-cost rows, minimum valueDensity 0.1147 (80x the
    //      trigger), longest title 171 chars = 43 tokens by this code's own
    //      estimateTokens (ceil(ascii/4) + ceil(cjk/1.5)). A first version of this line
    //      said 49, which is 3.5 chars/token — a rate nothing here uses.
    //
    // With both gone `selectedFiles` had no reader left, so the Set and its
    // JSON.parse went with it. Type diversity above is the only diversity constraint
    // that was ever live, which is why the counter below no longer says "both gates".
    //
    // Real overlap down-weighting, if wanted, belongs in the sort key — a ranking
    // change owing an A/B, not a revival of this block. tests/hook-context.test.mjs
    // pins the current unpenalized order and asserts its own discriminator, so a
    // penalty that reached the ordering turns red instead of landing silently.
    if (c._kind === 'obs' && c.type) {
      selectedTypes.set(c.type, (selectedTypes.get(c.type) || 0) + 1);
    }

    totalTokens += c.cost;
    if (c._kind === 'obs') {
      selectedObs.push({
        id: c.id,
        type: c.type,
        title: c.title,
        created_at: new Date(c.created_at_epoch).toISOString(),
      });
    } else {
      selectedSess.push({
        id: c.id,
        request: c.request,
        completed: c.completed,
        next_steps: c.next_steps,
        created_at: new Date(c.created_at_epoch).toISOString(),
      });
    }
  }

  return { observations: selectedObs, summaries: selectedSess, totalTokens };
}

/**
 * One-time cleanup of the legacy <claude-mem-context> block from the project's
 * CLAUDE.md file. Pre-v2.30 the hook wrote a slim context snapshot here on every
 * session start, causing constant git noise and stale, one-session-behind content.
 * Context is now delivered exclusively via SessionStart hook stdout.
 *
 * Idempotent: if no legacy block (or no CLAUDE.md) exists, it is a no-op. Also
 * removes the paired hint comment if present, and normalizes residual whitespace
 * at the seam. Uses atomic tmp+rename write.
 */
export function cleanupClaudeMdLegacyBlock() {
  // v2.48 P2-4: idempotent marker. First run (whether it finds a block or not,
  // whether CLAUDE.md exists or not) drops a project-scoped marker in RUNTIME_DIR.
  // Subsequent SessionStarts short-circuit here — no CLAUDE.md stat, no regex scan.
  // Recovery path if a user manually re-adds a legacy block: delete the marker
  // file (`~/.claude-mem-lite/runtime/.legacy-claude-md-cleaned-<project>`) and
  // the next SessionStart will sweep again.
  const markerPath = join(RUNTIME_DIR, `.legacy-claude-md-cleaned-${inferProject()}`);
  if (existsSync(markerPath)) return;

  const claudeMdPath = join(inferProjectDir(), 'CLAUDE.md');
  let content;
  try {
    content = readFileSync(claudeMdPath, 'utf8');
  } catch {
    // CLAUDE.md missing — still drop the marker so we don't re-stat every session
    try {
      writeFileSync(markerPath, String(Date.now()));
    } catch {}
    return;
  }

  // Helper: drop the marker regardless of exit path (found / not found / write failed).
  // Kept inline so the early-return sites below stay readable.
  const dropMarker = () => {
    try {
      writeFileSync(markerPath, String(Date.now()));
    } catch {}
  };

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  // Use lastIndexOf so documentation references to the tag earlier in the file
  // (e.g. inside a code block in architecture notes) are not accidentally swept.
  const startIdx = content.lastIndexOf(startTag);
  const endIdx = content.lastIndexOf(endTag);
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    dropMarker();
    return;
  }

  // Extend forward to swallow a trailing newline so we don't leave a stranded blank line.
  let removeEnd = endIdx + endTag.length;
  if (content[removeEnd] === '\n') removeEnd += 1;

  // Extend backward if the paired hint comment sits on the line immediately before
  // the start tag. The hint is the exact string the old updateClaudeMd emitted.
  let removeStart = startIdx;
  const hintPattern = '<!-- claude-mem-lite: auto-updated context';
  const leadingSlice = content.slice(0, startIdx);
  const hintIdx = leadingSlice.lastIndexOf(hintPattern);
  if (hintIdx !== -1) {
    const between = content.slice(hintIdx, startIdx);
    if (/^<!-- claude-mem-lite: [^\n]*-->\s*$/.test(between)) {
      removeStart = hintIdx;
    }
  }

  // Swallow a single preceding newline to avoid leaving a blank-line gap behind.
  if (removeStart > 0 && content[removeStart - 1] === '\n') removeStart -= 1;

  const cleaned = content.slice(0, removeStart) + content.slice(removeEnd);
  // Collapse any ≥3 consecutive newlines to two, then ensure exactly one trailing newline.
  const normalized = cleaned.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');

  if (normalized === content) {
    dropMarker();
    return;
  }

  // atomicWriteFileSync keeps the per-pid temp (two concurrent first-run SessionStarts in
  // one project must not rename each other's half-written temp onto the user's tracked
  // CLAUDE.md) AND adds the lstat the local twin lacked: renaming onto a symlink NAME
  // replaces the link with a regular file, orphaning a dotfiles-managed CLAUDE.md
  // (audit 2026-09-02 P0-5). Its temp lands beside the RESOLVED target, so the rename
  // stays same-device even when the real file lives on another mount.
  try {
    atomicWriteFileSync(claudeMdPath, normalized);
    dropMarker();
  } catch (e) {
    debugLog('ERROR', 'cleanupClaudeMdLegacyBlock', `CLAUDE.md write failed: ${e.message}`);
    // Intentionally do NOT drop the marker on write failure — retry next session.
  }
}

/**
 * Assemble the full markdown body that goes inside the <claude-mem-context>
 * block emitted at session start. Same shape as the inline builder hook.mjs
 * used to compose directly; extracted so both the SessionStart hook AND the
 * `claude-mem-lite context` CLI can read live context from the DB.
 *
 * Sections (in order):
 *   1. Last Session (from session_summaries.latest)
 *   2. File Lessons / Key Context (top importance≥2 observations)
 *   3. Recent Activity fallback (when no summary and no key obs)
 *   4. Working State (from latest clear handoff)
 *   5. Recent (N) table (observations via selectWithTokenBudget + fallback)
 *
 * @param {import('better-sqlite3').Database} db Opened main DB
 * @param {string} project Canonical project name (from inferProject())
 * @param {Date} [now=new Date()] Clock reference for time windows and table header
 * @param {string|null} [currentCcSessionId=null] Claude Code session id — when provided,
 *   the "Working State (from /clear)" block is filtered to handoffs owned by this
 *   session, preventing parallel-session bleed (see docs/bug.txt).
 * @param {object|null} [collector=null] Optional out-param: when given, its
 *   `keyContextIds` property is set to the obs ids ACTUALLY rendered into the
 *   File Lessons / Key Context sections ([] under quiet/adopted or when the
 *   sections are empty). handleUserPrompt persists this as its exclude-set
 *   (D#123: the exclude-set must mirror real injections, not the keyObs query).
 * @returns {string} Joined markdown lines (without <claude-mem-context> wrappers)
 */
export function buildSessionContextLines(
  db,
  project,
  now = new Date(),
  currentCcSessionId = null,
  collector = null,
) {
  if (collector) collector.keyContextIds = [];
  // 1. Token-budgeted observation selection
  const selected = selectWithTokenBudget(db, project, 2000);
  const observations = selected.observations;

  // 2. Fallback: recent across all projects with tiered windows (when local pool is thin)
  let fallbackObs = [];
  if (observations.length < 3) {
    const fbOneDayAgo = now.getTime() - STALE_SESSION_MS;
    const fbSevenDaysAgo = now.getTime() - RELATED_OBS_WINDOW_MS;
    fallbackObs = db
      .prepare(
        `
      SELECT id, type, title, project, created_at
      FROM observations
      WHERE ${liveObsFilterSql('')}
        AND ${notLowSignalTitleClause('')}
        AND (
          (created_at_epoch > ? AND importance >= 1)
          OR (created_at_epoch > ? AND importance >= 2)
        )
      ORDER BY created_at_epoch DESC
      LIMIT 5
    `,
      )
      .all(fbOneDayAgo, fbSevenDaysAgo);
  }

  // 3. Latest session summary → base summaryLines
  const latestSummary = db
    .prepare(
      `
    SELECT request, completed, next_steps, remaining_items, lessons, key_decisions, created_at
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `,
    )
    .get(project);

  const summaryLines = buildSummaryLines(latestSummary);

  // 4. Key context: top high-importance observations split into File Lessons (actionable)
  //    and Key Context (informational). Pushed into summaryLines.
  const keyObs = db
    .prepare(
      `
    SELECT o.id, o.type, o.title, o.lesson_learned, o.files_modified FROM observations o
    WHERE o.project = ? AND ${liveObsFilterSql('o')}
      AND COALESCE(o.importance, 1) >= 2
    ORDER BY o.created_at_epoch DESC LIMIT ${KEY_CONTEXT_LIMIT}
  `,
    )
    .all(project);

  if (keyObs.length > 0) {
    const fileLessons = [];
    const keyContext = [];

    for (const o of keyObs) {
      const clean = (o.title || '(untitled)')
        .replace(/ → (?:ERROR: )?\{".*$/, '')
        .replace(/ → (?:ERROR: )?\{[^}]*\.{3}$/, '');
      const hasLesson = o.lesson_learned && o.lesson_learned.trim();
      const hasFiles = o.files_modified && o.files_modified !== '[]';

      if (hasLesson && hasFiles) {
        try {
          const files = JSON.parse(o.files_modified);
          const fname = basename(Array.isArray(files) && files.length > 0 ? files[0] : '');
          if (fname) {
            fileLessons.push({ id: o.id, line: `- ${fname}: ${truncate(o.lesson_learned, 100)} (#${o.id})` });
            continue;
          }
        } catch {
          /* fall through to keyContext */
        }
      }
      const lesson = hasLesson ? ` — ${truncate(o.lesson_learned, 60)}` : '';
      keyContext.push({
        id: o.id,
        line: `- [${o.type || 'discovery'}] ${truncate(clean, 80)} (#${o.id})${lesson}`,
      });
    }

    // Phase A (QUIET_HOOKS) + Phase D (adopted sentinel): drop descriptive
    // File Lessons / Key Context sections when the user has opted into low-noise
    // hooks OR adopted invited-memory (MEMORY.md sentinel carries the triggers
    // at higher system-prompt authority). The Recent table still fires so #IDs
    // remain reachable via mem_get. The collector sees only rows that survive
    // BOTH the quiet gate and the per-section slice — rendered rows, nothing else.
    const quiet = effectiveQuiet();

    // D#196: the two sections draw from ONE pool of KEY_CONTEXT_LIMIT rows but each used
    // to cap at half of it, so a pool that is all one shape emitted 5 lines and left the
    // other section empty — half the rows the query had already paid for. Not a ranking
    // bound (SQL order is preserved and nothing is re-scored); a plain under-fill.
    //
    // Measured 2026-09-02T10:28Z over the 11 projects with >=20 live rows: 10 of them
    // lose rows to the per-section cap right now, 28 of 110 pooled rows (25.5%) fetched
    // and discarded. code-graph-mcp is the extreme at 10 fileLessons / 0 keyContext,
    // emitting 5 of 10; projects--mem is 9/1 and emits 6; only claudemd (5/5) loses
    // nothing. The shapes are not evenly mixed because "has a lesson AND names a file" is
    // the standard shape of a bugfix or decision row, which is most of what gets saved.
    //
    // Each section keeps its guaranteed half and may take what the other cannot use, so
    // the combined ceiling is still KEY_CONTEXT_LIMIT. STRICTLY ADDITIVE: every quota is
    // >= min(section length, half), i.e. no row that used to be shown can be dropped —
    // asserted in tests/hook-context.test.mjs rather than left as a claim, because "it
    // only adds" is exactly the kind of sentence this repo keeps finding to be false.
    const { fileLessonQuota, keyContextQuota } = sectionQuotas(fileLessons.length, keyContext.length);

    if (fileLessons.length > 0 && !quiet) {
      const shown = fileLessons.slice(0, fileLessonQuota);
      summaryLines.push('### File Lessons');
      summaryLines.push(...shown.map((e) => e.line));
      summaryLines.push('');
      if (collector) collector.keyContextIds.push(...shown.map((e) => e.id));
    }
    if (keyContext.length > 0 && !quiet) {
      const shown = keyContext.slice(0, keyContextQuota);
      summaryLines.push('### Key Context');
      summaryLines.push(...shown.map((e) => e.line));
      summaryLines.push('');
      if (collector) collector.keyContextIds.push(...shown.map((e) => e.id));
    }
  } else if (!latestSummary && !effectiveQuiet()) {
    // Fallback: no summary AND no key observations — show recent activity.
    // Skipped under QUIET_HOOKS since the Recent table already carries titles.
    const recentObs = (observations.length >= 3 ? observations : fallbackObs).slice(0, 3);
    if (recentObs.length > 0) {
      summaryLines.push('### Recent Activity');
      for (const o of recentObs) {
        summaryLines.push(`- ${truncate(o.title || '(untitled)', 80)}`);
      }
      summaryLines.push('');
    }
  }

  // HIGH-1 (full audit 2026-07-16): surface recent high-importance events — the
  // canonical store for promoted bugfix/decision/lesson memories that
  // persistHaikuSummary upgrade-deletes out of observations. Without this section
  // SessionStart never shows them. E# prefix keeps citation extractors (bare-`#`
  // anchored) from reading an event id as an observation id. Gated on isQuietHooks()
  // ONLY (explicit low-noise opt-out), NOT effectiveQuiet: unlike Key Context, events
  // never appear in the obs-only Recent table and are absent from the MEMORY.md
  // sentinel, so an adopted project (the default) would otherwise have zero
  // SessionStart surface for them. Never throws (recentInjectableEvents catches).
  if (!isQuietHooks()) {
    const keyEvents = recentInjectableEvents(db, { project, limit: 5 });
    if (keyEvents.length > 0) {
      summaryLines.push('### Key Events');
      for (const e of keyEvents) summaryLines.push(`- ${renderInjectableEvent(e)}`);
      summaryLines.push('');
    }
  }

  // 5. Working state from latest /clear handoff.
  // Session scoping: when currentCcSessionId is provided, restrict to this session's
  // own clear handoff so parallel sessions don't see each other's Working State block.
  // TTL: drop handoffs older than 48h. Without it, `cmdContext` (no session id) would
  // surface a /clear from days ago as "current Working State" — confusing when the user
  // has long moved on. 48h covers overnight breaks but excludes truly stale state.
  const HANDOFF_TTL_MS = 48 * 60 * 60 * 1000;
  const handoffMinEpoch = Date.now() - HANDOFF_TTL_MS;
  const prevClearHandoff = currentCcSessionId
    ? db
        .prepare(
          `
        SELECT working_on, unfinished, key_files
        FROM session_handoffs
        WHERE project = ? AND type = 'clear' AND session_id = ? AND created_at_epoch > ?
        ORDER BY created_at_epoch DESC LIMIT 1
      `,
        )
        .get(project, currentCcSessionId, handoffMinEpoch)
    : db
        .prepare(
          `
        SELECT working_on, unfinished, key_files
        FROM session_handoffs
        WHERE project = ? AND type = 'clear' AND created_at_epoch > ?
        ORDER BY created_at_epoch DESC LIMIT 1
      `,
        )
        .get(project, handoffMinEpoch);

  const handoffLines = [];
  if (prevClearHandoff) {
    handoffLines.push('### Working State (from /clear)');
    if (prevClearHandoff.working_on) {
      handoffLines.push(`- Working on: ${truncate(prevClearHandoff.working_on, 200)}`);
    }
    if (prevClearHandoff.unfinished) {
      const pendingSummary = extractUnfinishedSummary(prevClearHandoff.unfinished);
      if (pendingSummary) handoffLines.push(`- Recent activity: ${truncate(pendingSummary, 200)}`);
    }
    if (prevClearHandoff.key_files) {
      try {
        const files = JSON.parse(prevClearHandoff.key_files);
        if (files.length > 0) handoffLines.push(`- Key files: ${files.map((f) => basename(f)).join(', ')}`);
      } catch {
        /* malformed JSON — skip */
      }
    }
    handoffLines.push('');
  }

  // 5b. Deferred Work — backed by deferred_work table (v2.70.0).
  // Replaces the prior importance≥3 obs proxy. Items shown by per-project
  // ordinal so user can refer to "处理1" / "handle item 1" naturally; D#<id>
  // is the stable handle for tool-layer references (closes_deferred=[N]).
  // Quiet-hooks does NOT suppress: cross-session continuity is the whole point.
  const deferredItems = db
    .prepare(
      `
    SELECT id, title, priority,
           ROW_NUMBER() OVER (
             ORDER BY priority DESC, created_at_epoch ASC
           ) AS ordinal
    FROM deferred_work
    WHERE project = ? AND status = 'open'
    ORDER BY priority DESC, created_at_epoch ASC
    LIMIT 5
  `,
    )
    .all(project);

  const deferredLines = [];
  if (deferredItems.length > 0) {
    deferredLines.push('### Deferred Work');
    for (const d of deferredItems) {
      const pTag = d.priority === 3 ? '🔴' : d.priority === 1 ? '⚪' : '🟡';
      deferredLines.push(`${d.ordinal}. ${pTag} [P${d.priority}] ${truncate(d.title, 120)} (D#${d.id})`);
    }
    deferredLines.push('');
  }

  // 6. Recent observations table
  const obsLines = [];
  const obsToShow = observations.length >= 3 ? observations : fallbackObs;
  if (obsToShow.length > 0) {
    const today = now.toISOString().slice(0, 10);
    obsLines.push(`### Recent (${today})`);
    obsLines.push('');
    obsLines.push('| ID | Time | T | Title |');
    obsLines.push('|----|------|---|-------|');
    for (const o of obsToShow) {
      const proj = o.project && o.project !== project ? ` (${o.project})` : '';
      obsLines.push(
        `| #${o.id} | ${fmtTime(o.created_at)} | ${typeIcon(o.type)} | ${mdCell(truncate(o.title || '(untitled)', 60) + proj)} |`,
      );
    }
  }

  // Defang any literal block-delimiter tag carried in a title/lesson/summary so a row
  // can't prematurely close the <claude-mem-context> block it's wrapped in (mdCell does
  // the same for `|`). One source of truth: both the SessionStart hook and the CLI
  // `context` command consume this return.
  return neutralizeContextDelimiters(
    [...summaryLines, ...handoffLines, ...deferredLines, ...obsLines].join('\n'),
  );
}

/**
 * Build summary lines from a latestSummary row.
 * Extracted for testability — used by handleSessionStart.
 * @param {object} latestSummary Row from session_summaries with request, completed, etc.
 * @returns {string[]} Lines to include in context output
 */
export function buildSummaryLines(latestSummary) {
  const lines = [];
  if (!latestSummary) return lines;

  lines.push('### Last Session');
  if (latestSummary.request) lines.push(`Request: ${truncate(latestSummary.request, 120)}`);
  if (latestSummary.completed) lines.push(`Completed: ${truncate(latestSummary.completed, 120)}`);
  if (latestSummary.remaining_items) lines.push(`Remaining: ${truncate(latestSummary.remaining_items, 120)}`);
  if (latestSummary.next_steps) lines.push(`Next: ${truncate(latestSummary.next_steps, 120)}`);
  if (latestSummary.lessons) {
    try {
      const lessons = JSON.parse(latestSummary.lessons);
      if (lessons.length > 0) lines.push(`Lessons: ${lessons.slice(0, 3).join('; ')}`);
    } catch {}
  }
  if (latestSummary.key_decisions) {
    try {
      const decisions = JSON.parse(latestSummary.key_decisions);
      if (decisions.length > 0) lines.push(`Decisions: ${decisions.slice(0, 3).join('; ')}`);
    } catch {}
  }
  lines.push('');
  return lines;
}
