// lib/injected-ids.mjs — the cross-hook injected-ids dedup marker: file name, freshness +
// same-session gate, and payload shape. Single source of truth for user-prompt-search.js
// (writer), pre-tool-recall.js (read/merge), and hook.mjs (path-A reader): all three must
// derive the same name AND agree on when a payload counts, or cross-hook dedup silently
// goes blind — it does not error, it reads a marker nobody wrote.
//
// Scope widened 2026-09-03 (audit P1-2): this module used to own only the FILE NAME while
// the gate and the write were hand-typed in five places across three files.
//
// D#120: M-6 session-keyed the marker's PAYLOAD but kept ONE file per project,
// so two concurrent CC windows full-replaced each other's marker — no dedup
// between them and `count` reset on every alternation (MAX_SESSION_INJECTIONS
// unreachable). One file per SESSION instead, mirroring
// pre-recall-cooldown-<session>.json in the same runtime dir. GC: session-start
// sweep in hook.mjs (24h mtime, same policy as the cooldown files).
//
// Lives under lib/ (not scripts/) so hook.mjs can statically import it without
// colliding with the scripts/ directory rename in installExtractedRelease —
// same constraint as lib/mem-override.mjs.

import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.mjs';

/**
 * Runtime-dir FILE NAME for the injected-ids marker (no directory component).
 * No sessionId → legacy project-keyed name (env-less harnesses, old callers).
 * @param {string} project - inferProject() value (already filename-safe)
 * @param {string} [sessionId] - CC session id
 * @returns {string}
 */
export function injectedIdsFileName(project, sessionId) {
  const base = `.claude-mem-injected-${project}`;
  if (!sessionId) return base;
  const safe = String(sessionId)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 64);
  return `${base}-${safe}`;
}

/**
 * Read a marker file, applying the freshness + same-session gate.
 *
 * That gate had THREE byte-identical hand-typed copies (audit 2026-09-02 P1-2):
 * `hook.mjs handleUserPrompt`, `readCrossHookInjected` and `mergeCrossHookInjected` in
 * scripts/pre-tool-recall.js, and both legs of scripts/user-prompt-search.js — five sites
 * spelling out the same `ts && Date.now() - ts < W && !(session && mine && session !== mine)`.
 * The lib had collapsed only the FILE NAME. Every new writer added a sixth copy, and a
 * writer/reader disagreement here does not error: it reads a marker nobody wrote.
 *
 * THE WINDOW STAYS A PARAMETER, because the callers genuinely disagree and that
 * disagreement is a live open question, not an accident to be tidied away: the two writers
 * use DEDUP_STALE_MS (5 min) and the hook.mjs reader uses 10 s. Hard-coding either one here
 * would silently decide it. Legacy payloads with no `session` keep the old
 * window-only behaviour, as before.
 *
 * IDS COME BACK EXACTLY AS WRITTEN — no Number(), no String(). The marker holds a mix of
 * raw numbers and strings and the consumers test `Set.has()` against numbers from SQLite,
 * so coercing here would turn an inert exclude live. That is D#213/D#216's decision to
 * make, on its ruler (lib/patha-exclude-meter.mjs), not a drive-by of this consolidation.
 *
 * @param {string} file Absolute path to the marker.
 * @param {object} opts
 * @param {string} [opts.sessionId] CC session id; a payload from another session is rejected.
 * @param {number} opts.maxAgeMs Freshness window.
 * @returns {{ids: Array<number|string>, count: number, fresh: boolean}} `fresh:false` ⇒ ids [] and count 0.
 *
 * ONE deliberate non-identity in the consolidation, stated rather than glossed: the copies
 * disagreed at the boundary by 1 ms. pre-tool-recall used `age > W` (stale only when
 * strictly greater), hook.mjs used `age < W` (fresh only when strictly less), so a payload
 * exactly W old was fresh to one and stale to the other. This adopts the former for all
 * callers. Nothing selects on a 1 ms boundary, but "identical behaviour" would have been
 * false and the next person to diff the two would have had to rediscover why.
 */
export function readInjectedMarker(file, { sessionId, maxAgeMs } = {}) {
  const empty = { ids: [], count: 0, upsCount: 0, upsTs: 0, fresh: false };
  try {
    const { ids, ts, count, upsCount, upsTs, session } = JSON.parse(readFileSync(file, 'utf8'));
    if (session && sessionId && session !== sessionId) return empty;
    if (!ts || Date.now() - ts > maxAgeMs) return empty;
    if (!Array.isArray(ids)) return empty;
    return { ids, count: count || 0, upsCount: upsCount || 0, upsTs: upsTs || 0, fresh: true };
  } catch {
    return empty;
  }
}

/**
 * Hard ceiling on the marker's `ids` array, applied to BOTH arms.
 *
 * 2x the largest seen-set this repo has measured in the wild (16, histogram at
 * scripts/pre-tool-recall.js:92-93). See mergeInjectedMarker for why an unbounded set is
 * not merely a size problem.
 */
export const MAX_MARKER_IDS = 32;

/**
 * Write `newIds` into a marker, unioning with a fresh same-session payload or replacing it.
 *
 * `mode` is not a convenience — the two modes have different id-typing behaviour and BOTH
 * are load-bearing:
 *   - `union`   stringifies the whole result. Both union callers already did
 *               (`prev.ids.map(String)` plus new ids that are `D<id>` strings anyway), so
 *               this is their behaviour, not a new normalisation.
 *   - `replace` writes `newIds` verbatim and carries every OTHER id forward as a string.
 *               The UPS main leg passes `candidateIds`, a MIX of raw observation numbers
 *               and `P<id>` strings, and writing those unchanged is exactly the state
 *               D#213 measures. Stringifying them here would change it. It replaces the
 *               caller's own slice, not the file (R12 B-6 — see mergeInjectedMarker).
 * Keeping both under one function is the point: the next writer picks a mode instead of
 * copying a fifth predicate and inventing a fifth typing rule.
 *
 * TWO counters, and they answer different questions (R12 B-5). `count` is "how many times
 * has anything written this marker" and stays as it was. `upsCount` is "how many times has
 * the UPS face injected", and ONLY the caller that owns `MAX_SESSION_INJECTIONS` opts into
 * bumping it. They were one field, so pre-tool-recall — which writes once per triggered
 * Edit/Read and shares this file — spent the fyi face's entire per-session budget without
 * the fyi face emitting a line. A budget has to be charged to the spender.
 *
 * The write is atomic for the reason M-6 recorded: a plain write torn by a concurrent hook
 * left the shared marker as invalid JSON, silently disabling cross-hook dedup for the window.
 *
 * @param {string} file
 * @param {Array<number|string>} newIds
 * @param {object} opts
 * @param {string} [opts.sessionId]
 * @param {number} opts.maxAgeMs
 * @param {'union'|'replace'} opts.mode
 */
export function mergeInjectedMarker(file, newIds, { sessionId, maxAgeMs, mode, bumpUpsCount = false } = {}) {
  const prev = readInjectedMarker(file, { sessionId, maxAgeMs });
  // R12 B-6. `replace` used to write `newIds` as the WHOLE array, so the UPS main leg's
  // one write per prompt erased everything pre-tool-recall had accumulated in the window
  // and that face re-injected lessons it had already shown. It now replaces the CALLER's
  // slice and carries the rest.
  //
  // The carried ids are stringified and the caller's are not, and that asymmetry is the
  // load-bearing part rather than an oversight: D#213's exclude is inert BECAUSE
  // `new Set(excludeIds).has(<number from SQLite>)` misses a string key, and the UPS leg's
  // raw numbers are the one population that is NOT inert. Writing `newIds` verbatim keeps
  // that population byte-identical to what it was, and everything carried in arrives as a
  // string, so this cannot widen the live exclude. Repairing D#213 is a separate decision
  // with its own ruler (lib/patha-exclude-meter.mjs).
  const newKeys = new Set(newIds.map(String));
  const carried = [...new Set(prev.ids.map(String))].filter((id) => !newKeys.has(id));
  // Both arms are built NEWEST-FIRST and then capped. Until B-6, `replace` overwriting the
  // whole array was the only thing that ever shrank this file — `union` has always
  // accumulated, and `ts` is refreshed on every write, so the staleness gate never fires in
  // a session where any hook writes inside the window. Making replace carry the other
  // hook's ids therefore removed a bound nobody had written down: measured 520 ids after 40
  // rounds of 5 pre-tool-recall triggers plus one prompt, linear and unbounded.
  //
  // A large seen-set does not just cost bytes, it starves the face it exists to help.
  // scripts/pre-tool-recall.js sizes its over-fetch as `min(seenSize, 5)` and then drops
  // every fetched row that is IN the set, so past a handful of entries a Read can fetch six
  // candidates and filter all six. That failure is described at pre-tool-recall.js:100-105,
  // derived at a seen-set of 16 — which is the largest this repo has measured in the wild
  // (`pre-tool-recall.js:92-93`, histogram 1x9 2x1 3x2 16x1 over n=13).
  //
  // So the cap is 2x the largest observed set, not a round number pulled from nowhere. It
  // BOUNDS that failure; it does not remove it — six candidates can still all be seen — and
  // removing it is ALGO-4's problem, not this one.
  const ids = (
    mode === 'union'
      ? [...new Set([...newIds.map(String), ...prev.ids.map(String)])]
      : [...newIds, ...carried]
  ).slice(0, MAX_MARKER_IDS);
  atomicWriteFileSync(
    file,
    JSON.stringify({
      ids,
      ts: Date.now(),
      count: prev.count + 1,
      upsCount: prev.upsCount + (bumpUpsCount ? 1 : 0),
      // The UPS face's budget needs the UPS face's CLOCK, not the shared one. `ts` is
      // refreshed by every writer, and readInjectedMarker zeroes upsCount off `ts`, so a
      // tool-heavy session kept the fyi face's spent budget alive across gaps that should
      // have released it — B-5 moved the counter to the spender and left the clock shared.
      upsTs: bumpUpsCount ? Date.now() : prev.upsTs,
      ...(sessionId ? { session: sessionId } : {}),
    }),
  );
}

/**
 * Namespace prefix for an id written into the shared injected-ids marker.
 *
 * D#188. The marker file is a UNION across hooks and across tables, and the
 * convention for keeping those tables apart already existed — user-prompt-search.js
 * writes `P<id>` for user_prompts rows and `D<id>` for deferred rows, with the
 * comment "so obs ids can't collide in the shared injected-ids file". Observations
 * are the incumbent namespace and stay bare. EVENTS were the one table that never
 * got a prefix, even though the line three above pre-tool-recall.js's dedup filter
 * says in as many words that "events share the numeric id space with observations"
 * — the `src` tag added to carry exactly that distinction was not consulted by the
 * dedup predicate sitting next to it.
 *
 * The consequence, measured on the live store (3747 observations, 91.6% of observation
 * ids also existing as an event id, 2026-09-01T19:56Z): a UPS-injected observation #42
 * made event #42 unreachable to the PreToolUse face for the 5-minute window, and vice
 * versa. Replaying every real session's UPS-injected id set against the injectable
 * events of the project the SESSION ran in: **14 collisions across 11 of 60 sessions
 * (18.3%)**, 2026-09-01T20:17Z.
 *
 * WHICH PROJECT, precisely, because the draft got this wrong while arguing about
 * populations. `scripts/pre-tool-recall.js` does `const project = inferProject()` once
 * and feeds that single value to BOTH `crossHookInjectedFile(project, sessionId)` and
 * the events `SELECT ... WHERE project = ?`. So the scoping that matters is the
 * SESSION's project. The draft instead scoped by the injected observation's own
 * `project` column and reported 9 in 9 (15.5%), understating it. The pre-tag claims
 * review caught the population, having reconstructed it independently at 12 in 10.
 *
 * That is not a rounding difference, and the number that proves it is worth carrying:
 * **134 of 216 injected `ups` ids (62.0%) belong to a project OTHER than the session
 * they were injected into** (2026-09-01T20:36Z; the review measured 128/210 = 61% an
 * hour earlier). The `ups` face has a cross-project leg and it dominates, so "the
 * observation's project" and "the session's project" select genuinely different
 * populations — and only the latter is one the dedup mechanism ever asks about.
 *
 * The predicate, stated here because no harness is committed for it: seen-set per
 * session = the shipped `extractInjectedBySurface(path).ups`; injectable events =
 * `importance >= 2 AND superseded_at_epoch IS NULL AND file_paths NOT IN (NULL,'[]')`;
 * session project recovered by matching each transcript directory against the DB's own
 * project list (forward map, since flattening `/` and `_` to `-` is not invertible).
 * Dropping the project condition entirely reports 72 in 41 — a population the
 * project-filtered query can never reach.
 *
 * A SECOND consequence was claimed here before v3.86.0 was tagged and is FALSE, so it
 * is recorded rather than deleted: bare event ids do flow into hook.mjs's
 * `pathAInjectedIds`, which is handed to searchRelevantMemories and
 * rankImperativeCandidates as an OBSERVATION exclude list — but they suppress
 * NOTHING there, because `mergeCrossHookInjected` writes every id as a STRING and
 * both consumers test `new Set(excludeIds).has(r.id)` against a NUMBER out of
 * SQLite. Measured: excluding `1` returns nothing, excluding `'1'` returns the row.
 * The pre-tag correctness review found this. What it exposes is a real and separate
 * defect — that exclude list is inert for every id the marker holds as a string,
 * observations included — which is D#213 (re-filed twice from D#193, because the first
 * two versions measured the marker's WRITER instead of its reader and published 18.0%
 * for the mirror population; the corrected upper bound is 9.0%), not this one. Its ruler
 * is lib/patha-exclude-meter.mjs.
 *
 * Legacy in-flight files (bare ids that were a mix of both tables) keep their old
 * meaning for at most DEDUP_STALE_MS and then rotate; there is deliberately no
 * format version, because a 5-minute window of the PRE-EXISTING behaviour is a
 * smaller cost than a schema every reader has to branch on.
 *
 * @param {number|string} id
 * @param {'obs'|'evt'} [src]
 * @returns {string}
 */
export function injectedIdKey(id, src = 'obs') {
  return src === 'evt' ? `E${id}` : String(id);
}

/**
 * DISPLAY prefix for an event id rendered into an injected line, as opposed to
 * `injectedIdKey` above, which namespaces the same id inside the marker FILE.
 * Two forms of one convention: the marker key is `E<id>` (no `#`, it is not
 * citable text), the rendered token is `E#<id>` (the `#` is what makes an id
 * look like an id to a reader).
 *
 * It lives in this leaf module — rather than beside either renderer — because
 * D#202 was exactly the two renderers not agreeing. lib/events-injection.mjs
 * had the `E#` convention and a header explaining it; scripts/pre-tool-recall.js
 * rendered its own merged obs+event rows with a bare `#`, putting 44.9% of that
 * channel's ids into the observation citation-decay denominator. Importing from
 * here also keeps the hot PreToolUse path off events-injection.mjs's
 * search-core.mjs dependency chain.
 */
export const EVENT_ID_PREFIX = 'E#';

/**
 * Render a pre-tool-recall cooldown entry's ids as citable tokens: `#N` for an
 * observation, `E#N` for an event.
 *
 * `lessonIds` is the mixed list (obs + events, in injection order) and `obsIds` the
 * observation subset (recorded since D#78). Two re-renderers — the Read→Edit ack line
 * and the cite-back hint — printed every lessonId as a bare `#N`, so an injected
 * `E#116` came back as "cite #116", which is a DIFFERENT memory: a bare `#` is the
 * observation namespace (citationIdRe). Same shape as D#202, one layer later.
 *
 * `obsIds` is a multiset match, because one obs and one event may share a number in the
 * same entry. An entry without `obsIds` (written before D#78) cannot be split and keeps
 * the old bare rendering.
 *
 * @param {Array<number|string>} lessonIds
 * @param {Array<number|string>|undefined} obsIds
 * @returns {string[]}
 */
export function lessonIdTokens(lessonIds, obsIds) {
  if (!Array.isArray(lessonIds)) return [];
  if (!Array.isArray(obsIds)) return lessonIds.map((id) => `#${id}`);
  const obsLeft = new Map();
  for (const id of obsIds) obsLeft.set(String(id), (obsLeft.get(String(id)) || 0) + 1);
  return lessonIds.map((id) => {
    const n = obsLeft.get(String(id)) || 0;
    if (n > 0) {
      obsLeft.set(String(id), n - 1);
      return `#${id}`;
    }
    return `${EVENT_ID_PREFIX}${id}`;
  });
}

/**
 * Runtime-dir FILE NAME for the SessionStart Key Context marker: the obs ids
 * ACTUALLY rendered into the <claude-mem-context> File Lessons / Key Context
 * sections (empty under quiet/adopted). handleUserPrompt reads it as its
 * exclude-set — D#123 review C-1: excluding the injector's QUERY result instead
 * of what was really shown suppressed <memory-context> injection outright on
 * quiet/adopted projects, where Key Context never renders at all.
 * Session-lifetime validity (no time window): the SessionStart block stays in
 * context for the whole session. Swept with the same 24h GC as the marker above.
 * @param {string} project - inferProject() value (already filename-safe)
 * @param {string} [sessionId] - CC session id
 * @returns {string}
 */
export function keyContextIdsFileName(project, sessionId) {
  const base = `.claude-mem-keyctx-${project}`;
  if (!sessionId) return base;
  const safe = String(sessionId)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 64);
  return `${base}-${safe}`;
}
