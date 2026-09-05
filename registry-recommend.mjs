// Intent-based skill recommendation — Phase 1 (shadow).
// See docs/superpowers/specs/2026-06-23-skill-recommendation-loop-design.md
//
// Phase-1 invariant: the engine only LOGS. It never emits to stdout and never writes
// invocations/recommend_count. Live injection is Phase 2 and does not exist yet, so
// `live` resolves to shadow with a one-time warning (see UNIMPLEMENTED_MODES).
// `off` skips all work.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir, resolveRuntimeDir } from './lib/resolve-data-dir.mjs';
import { searchResources, cjkIntentTokens } from './registry-retriever.mjs';

import { DAY_MS } from './lib/time-constants.mjs';
import { gcDailyShards } from './lib/shard-gc.mjs';
const VALID_MODES = new Set(['shadow', 'live', 'off']);
// Phase 2 (live injection) was never built. `live` stayed in VALID_MODES and
// getRecommendMode returned it verbatim, so setting it bought a user exactly
// nothing and said nothing — the run behaved as shadow while the mode field in
// every logged row claimed 'live'. Audit 2026-08-22 P2-5: an accepted value that
// silently means something else is worse than an unsupported one. It still parses
// (nobody's config breaks), it now resolves to what actually happens, and it says
// so once per process.
export const RECOMMEND_MODE_UNIMPLEMENTED = new Set(['live']);
let warnedUnimplemented = false;

/** The mode the environment ASKED for — 'live' included. For diagnostics (doctor). */
export function getRequestedRecommendMode() {
  const raw = (process.env.CLAUDE_MEM_RECOMMEND_MODE || 'shadow').toLowerCase().trim();
  return VALID_MODES.has(raw) ? raw : 'shadow';
}

/** Recommendation mode actually in effect; default 'shadow', unknown → 'shadow'. */
export function getRecommendMode() {
  const requested = getRequestedRecommendMode();
  if (!RECOMMEND_MODE_UNIMPLEMENTED.has(requested)) return requested;
  if (!warnedUnimplemented && !process.env.MEM_QUIET_HOOKS) {
    warnedUnimplemented = true;
    // stderr, once: hook stdout is a parsed envelope and must not carry this.
    process.stderr.write(
      `[claude-mem-lite] CLAUDE_MEM_RECOMMEND_MODE=${requested} is not implemented ` +
        '(live injection is Phase 2); running in shadow mode — nothing is injected. ' +
        'Set shadow or off to silence this.\n',
    );
  }
  return 'shadow';
}

// Provisional gate thresholds — calibrated from shadow data before Phase 2 (spec §8).
// relevance is raw bm25 (negative; more negative = better). Candidate must clear |floor|.
export const RECO_BM25_FLOOR = -1.5; // floor stays on raw bm25 (absolute topical relevance)
// Margin is measured in COMPOSITE space (the metric that orders + selects the winner), NOT raw
// bm25 — see applyGate. composite = bm25*0.4 - priors, so the scale is ~0.4x raw; 0.5 raw ≈ 0.2
// composite is the principled starting point. Final value comes from `recommend-stats --sweep`
// after dogfood (D#47); DEFAULT_SWEEP_MARGINS is likewise on the composite scale.
export const RECO_MARGIN = 0.2; // require candidates[1].composite_score - candidates[0].composite_score >= this
const RECO_COOLDOWN_MS = 300_000; // 5 min, mirrors T4 SKILL_COOLDOWN_MS (internal)

// Lazy runtime-path resolution: read CLAUDE_MEM_DIR at call time (mirrors schema.mjs:13
// DB_DIR formula) so tests sandbox via env without ESM-cache gymnastics, and prod reads
// the same dir as the rest of the app.
function recoRuntimeDir() {
  return resolveRuntimeDir(resolveDataDir(process.env.CLAUDE_MEM_DIR));
}

const TOKEN_SPLIT = /[^a-z0-9一-鿿]+/;

/** Installed skills (quality_tier='installed') matching the prompt, best-first. */
export function fetchInstalledSkillCandidates(rdb, promptText, limit = 10) {
  if (!rdb || !promptText) return [];
  let rows;
  // Over-fetch, THEN filter to installed. quality_tier='installed' is a post-SQL JS filter, so a
  // plain LIMIT starves installed skills that rank below other-tier matches: a weak installed
  // match sitting past the top-N is sliced off → the gate sees no candidate → spurious
  // no_candidate BLOCK (the −0.15 installed composite bonus is negligible vs the bm25 spread).
  // A wide headroom lets the composite-best installed skill actually survive to the gate.
  try {
    rows = searchResources(rdb, promptText, { type: 'skill', limit: Math.max(limit * 5, 50) });
  } catch {
    return [];
  }
  return rows.filter((r) => r.quality_tier === 'installed').slice(0, limit);
}

/**
 * True when an intent tag matches a prompt token. Tags of length >= 3 match as a token
 * PREFIX (plural/inflection tolerant: "test" → "tests"/"testing"; rejects mid-word hits
 * like "latest"); shorter tags ("qa","go","db") require an exact token to avoid noise.
 */
export function intentMatch(promptText, candidate) {
  const tags = String(candidate.intent_tags || '')
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  if (tags.length === 0) return false;
  const tokens = String(promptText).toLowerCase().split(TOKEN_SPLIT).filter(Boolean);
  // CJK bridge: intent_tags are English, but Chinese has no word boundaries, so a pure-中文
  // prompt ("写测试") tokenizes to one CJK run that never prefix-matches "test". Inject the
  // English equivalents of any CJK_INTENT_MAP phrase present so 中文 prompts can clear gate 3.
  for (const en of cjkIntentTokens(promptText)) tokens.push(en);
  return tags.some((tag) => tokens.some((tok) => (tag.length >= 3 ? tok.startsWith(tag) : tok === tag)));
}

/**
 * 4-gate precision filter. relevance is raw bm25 (negative; more negative = better).
 * Gates in order: absolute floor → top1/top2 margin → intent token match → session cooldown.
 */
export function applyGate(candidates, promptText, cooldownSet) {
  if (!candidates || candidates.length === 0)
    return { verdict: 'BLOCK', reason: 'no_candidate', candidate: null };
  const top = candidates[0];
  if (!(top.relevance <= RECO_BM25_FLOOR)) return { verdict: 'BLOCK', reason: 'below_floor', candidate: top };
  if (candidates.length >= 2) {
    // Separation measured in the SAME metric that ordered the candidates (composite_score),
    // NOT relevance. candidates arrive composite ASC so `top` IS the composite winner; a raw
    // relevance margin let a composite-promoted top sit BELOW candidates[1] in relevance →
    // negative margin → spurious low_margin BLOCK (and a permanent dead-zone in the ROC sweep).
    // composite2 - composite1 is >= 0 by sort order. The floor above stays on raw bm25 — the
    // absolute-relevance gate that stops a popular-but-irrelevant composite promotion.
    const margin = candidates[1].composite_score - top.composite_score;
    if (!(margin >= RECO_MARGIN)) return { verdict: 'BLOCK', reason: 'low_margin', candidate: top };
  }
  if (!intentMatch(promptText, top)) return { verdict: 'BLOCK', reason: 'intent_mismatch', candidate: top };
  if (cooldownSet && cooldownSet.has(String(top.name).toLowerCase()))
    return { verdict: 'BLOCK', reason: 'cooldown', candidate: top };
  return { verdict: 'PASS', reason: 'pass', candidate: top };
}

function recoCooldownFile(project) {
  return join(recoRuntimeDir(), `.skill-reco-cooldown-${project}`);
}

/** Read live (non-expired) cooldown entries for a project: {nameLower: epochMs}. */
export function getRecoCooldown(project) {
  try {
    const data = JSON.parse(readFileSync(recoCooldownFile(project), 'utf8'));
    const now = Date.now();
    const cleaned = {};
    for (const [k, v] of Object.entries(data)) if (now - v < RECO_COOLDOWN_MS) cleaned[k] = v;
    return cleaned;
  } catch {
    return {};
  }
}

/** Stamp a skill name into the project's cooldown (atomic tmp+rename, mirrors T4). */
export function setRecoCooldown(project, name) {
  try {
    const dir = recoRuntimeDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data = getRecoCooldown(project);
    data[String(name).toLowerCase()] = Date.now();
    const tmp = recoCooldownFile(project) + `.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, recoCooldownFile(project));
  } catch {
    /* silent — cooldown best-effort */
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function shadowDir() {
  return join(recoRuntimeDir(), 'recommendations');
}

function appendShadow(row) {
  try {
    const dir = shadowDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `${today()}.jsonl`), JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch {
    /* shadow sink must never crash the hook */
  }
}

/**
 * Prune shadow-log daily shards older than `retainDays`. appendShadow writes one
 * YYYY-MM-DD.jsonl per day with no GC, so a long-lived install grows the dir
 * unbounded (audit: shadow log non-bounded). 90d keeps a full quarter for
 * recommend-stats --days while bounding the dir to ~90 sub-MB files. Best-effort,
 * never throws — called from the SessionStart GC sweep. The sweep itself is
 * `lib/shard-gc.mjs`, shared with the metrics sink; `shadowDir()` may not exist
 * yet (nothing logged), which gcDailyShards treats as a no-op.
 * @returns {number} shards removed
 */
export function gcOldShadowShards(retainDays = 90) {
  return gcDailyShards(shadowDir(), retainDays);
}

export function logShadowReco(project, rec) {
  appendShadow({ ts: new Date().toISOString(), kind: 'reco', project, ...rec });
}
export function logShadowAdoption(project, rec) {
  appendShadow({ ts: new Date().toISOString(), kind: 'adopt', project, ...rec });
}

/** Yield parsed shadow rows from the last `days` daily shards. */
export function* readShadowLog(days = 7) {
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    let raw;
    try {
      raw = readFileSync(join(shadowDir(), `${d}.jsonl`), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* skip malformed */
      }
    }
  }
}

const lc = (s) => String(s ?? '').toLowerCase();

/**
 * Aggregate the would-be funnel for the flip decision (spec §8).
 *
 * Coarse global counts (reco/pass/blockByReason/adopt/passSkills/adoptSkills) are kept for
 * back-compat. The flip-decision metrics live under `matched`/`lift`/`sessions`:
 *  - matched: in-session PASS→adopt pairing (true matched precision, not a global name join).
 *  - lift[skill]: P(adopt | gate PASSed it this session) / base-rate(adopt). >1 means the gate
 *    beats the skill's organic base rate — the only popularity-robust evidence the gate has
 *    targeting signal. Null-session rows can't be paired, so they feed only the coarse counts.
 */
export function computeFunnel(days = 7) {
  const stats = { reco: 0, pass: 0, blockByReason: {}, adopt: 0, passSkills: {}, adoptSkills: {} };
  const bump = (obj, k) => {
    if (k) obj[k] = (obj[k] || 0) + 1;
  };
  const bySession = new Map();
  const sess = (id) => {
    let e = bySession.get(id);
    if (!e) {
      e = { pass: new Set(), adopt: new Set() };
      bySession.set(id, e);
    }
    return e;
  };
  for (const row of readShadowLog(days)) {
    if (row.kind === 'reco') {
      stats.reco++;
      if (row.verdict === 'PASS') {
        stats.pass++;
        bump(stats.passSkills, row.skill);
        if (row.session) sess(row.session).pass.add(lc(row.skill));
      } else bump(stats.blockByReason, row.reason);
    } else if (row.kind === 'adopt') {
      stats.adopt++;
      bump(stats.adoptSkills, row.skill);
      if (row.session) sess(row.session).adopt.add(lc(row.skill));
    }
  }
  stats.sessions = bySession.size;
  let mPass = 0,
    mAdopt = 0;
  const passSessions = {},
    hitSessions = {},
    baseSessions = {};
  for (const { pass, adopt } of bySession.values()) {
    for (const sk of pass) {
      mPass++;
      passSessions[sk] = (passSessions[sk] || 0) + 1;
      if (adopt.has(sk)) {
        mAdopt++;
        hitSessions[sk] = (hitSessions[sk] || 0) + 1;
      }
    }
    for (const sk of adopt) baseSessions[sk] = (baseSessions[sk] || 0) + 1;
  }
  stats.matched = { pass: mPass, adopt: mAdopt, precision: mPass ? mAdopt / mPass : null };
  stats.lift = {};
  for (const sk of Object.keys(passSessions)) {
    const ps = passSessions[sk],
      hs = hitSessions[sk] || 0;
    const baseRate = stats.sessions ? (baseSessions[sk] || 0) / stats.sessions : 0;
    const adoptGivenPass = ps ? hs / ps : 0;
    stats.lift[sk] = {
      passSessions: ps,
      hitSessions: hs,
      adoptGivenPass,
      baseRate,
      lift: baseRate > 0 ? adoptGivenPass / baseRate : null,
    };
  }
  return stats;
}

// Default sweep grid (B3). FLOORS are raw bm25 (real matches run ≈ -10..-15, so the shipped
// -1.5 floor is far more permissive than it looks; the grid spans that real range). MARGINS are
// on the COMPOSITE scale (composite = bm25*0.4 - priors), matching replayGate's margin metric —
// the old raw-bm25 grid [0,0.5,1,2,4] was ~2.5x too wide for composite separations.
// Override via `recommend-stats --sweep --floors a,b --margins x,y`.
export const DEFAULT_SWEEP_FLOORS = [-1.5, -5, -8, -10, -12];
export const DEFAULT_SWEEP_MARGINS = [0, 0.05, 0.1, 0.2, 0.4];

/**
 * Recompute the gate verdict for a logged reco row at a hypothetical (floor, margin),
 * from its eager replay vector (relevance/rel2/intentTop/cooldownTop). Pure — no retrieval.
 * intent/cooldown are fixed pass/block bits; only floor and margin are swept.
 */
export function replayGate(row, floor, margin) {
  const r1 = row.relevance;
  // null/undefined relevance coerces to 0/NaN, so `r1 <= floor` is false → BLOCK (no null check).
  if (!(r1 <= floor)) return 'BLOCK';
  // Margin on composite when the row logged it (post-switch rows), matching the live applyGate
  // metric; fall back to the legacy relevance margin for rows written before composite1/composite2
  // existed (they age out of the 7d sweep window). Single-candidate rows (no rel2/composite2) skip
  // the margin gate either way. NOTE: sweep `margin` is on the COMPOSITE scale for new rows.
  if (Number.isFinite(row.composite1) && Number.isFinite(row.composite2)) {
    if (!(row.composite2 - row.composite1 >= margin)) return 'BLOCK';
  } else if (Number.isFinite(row.rel2)) {
    if (!(row.rel2 - r1 >= margin)) return 'BLOCK';
  }
  if (!row.intentTop) return 'BLOCK';
  if (row.cooldownTop) return 'BLOCK';
  return 'PASS';
}

/**
 * Offline ROC sweep (B3): replay every reco row at each (floor × margin) and join the would-be
 * PASSes with in-session adoptions for matched precision. Turns the flip decision from one
 * underpowered point estimate into a precision/recall curve over collected shadow data (spec §8).
 */
export function computeSweep(days = 7, floors = DEFAULT_SWEEP_FLOORS, margins = DEFAULT_SWEEP_MARGINS) {
  const recos = [];
  const adoptBySession = new Map();
  for (const row of readShadowLog(days)) {
    if (row.kind === 'reco') recos.push(row);
    else if (row.kind === 'adopt' && row.session) {
      if (!adoptBySession.has(row.session)) adoptBySession.set(row.session, new Set());
      adoptBySession.get(row.session).add(lc(row.skill));
    }
  }
  const grid = [];
  for (const floor of floors)
    for (const margin of margins) {
      let pass = 0;
      // Matched precision MUST dedup (session, skill) exactly like computeFunnel (mPass/mAdopt
      // via per-session Sets). Counting raw reco rows here inflated matchPass by every repeat
      // recommendation of the same skill in one session, so the sweep's precision silently
      // disagreed with the funnel headline and was biased toward frequently-recommended skills —
      // corrupting the exact (floor,margin) signal the sweep exists to inform. `pass` stays a raw
      // volume count (it is not a precision denominator).
      const passBySession = new Map(); // session -> Set<skillLower> that PASSED at this cell
      for (const r of recos) {
        if (replayGate(r, floor, margin) !== 'PASS') continue;
        pass++;
        if (!r.session) continue;
        if (!passBySession.has(r.session)) passBySession.set(r.session, new Set());
        passBySession.get(r.session).add(lc(r.skill));
      }
      let matchPass = 0,
        matchAdopt = 0;
      for (const [session, skills] of passBySession) {
        const adopted = adoptBySession.get(session);
        for (const sk of skills) {
          matchPass++;
          if (adopted?.has(sk)) matchAdopt++;
        }
      }
      grid.push({
        floor,
        margin,
        pass,
        matchPass,
        matchAdopt,
        precision: matchPass ? matchAdopt / matchPass : null,
      });
    }
  return grid;
}

/**
 * Phase-1 shadow orchestrator: retrieve → gate → log → cooldown on PASS.
 * Emits NOTHING and writes NO live telemetry. `off` → no-op. Returns the verdict.
 */
export function recommendSkill(rdb, promptText, project, opts = {}) {
  const mode = getRecommendMode();
  if (mode === 'off') return { verdict: 'OFF', reason: 'off', candidate: null };
  let candidates = [];
  try {
    candidates = fetchInstalledSkillCandidates(rdb, promptText);
  } catch {
    /* ignore */
  }
  const cooldownSet = new Set(Object.keys(getRecoCooldown(project)));
  const result = applyGate(candidates, promptText, cooldownSet);
  // Eager replay vector (B3): applyGate short-circuits, so a row that BLOCKed at below_floor
  // never evaluated intent/cooldown. Compute the gate's raw inputs unconditionally here so an
  // offline sweep can recompute the verdict at any (floor, margin) without re-running retrieval.
  const top = candidates[0] || null;
  logShadowReco(project, {
    // session id (B1): the cross-hook key that lets PostToolUse adoptions be paired with
    // this reco in the SAME session — without it, precision is only a global name-set join.
    session: opts.sessionId ?? null,
    mode,
    verdict: result.verdict,
    reason: result.reason,
    // join key MUST be the Skill-tool invocation slug (e.g. 'superpowers:test-driven-development'),
    // NOT the registry short name ('superpowers-tdd') — adoption rows log toolInput.skill (the slug),
    // so logging top.name made in-session matched precision a guaranteed 0 for every namespaced skill.
    skill: top ? top.invocation_name || top.name : null,
    relevance: top ? top.relevance : null, // floor replay (absolute bm25)
    rel2: candidates[1] ? candidates[1].relevance : null, // legacy margin replay (pre-composite rows)
    composite1: top ? top.composite_score : null, // margin replay (composite — the live gate metric)
    composite2: candidates[1] ? candidates[1].composite_score : null,
    intentTop: top ? intentMatch(promptText, top) : false,
    cooldownTop: top ? cooldownSet.has(String(top.name).toLowerCase()) : false,
    ncand: candidates.length,
    // #8259: UserPromptSubmit injection cite-recall was 25.8% until gated on explicit
    // signal. Record signal-presence so the Phase-2 flip can test whether live injection
    // should gate on it (the decisive lever per that lesson). Shadow does not gate on it.
    hasSignal: opts.hasSignal ?? null,
  });
  // Simulate live cooldown timing so the shadow funnel reflects real injection cadence.
  if (result.verdict === 'PASS') setRecoCooldown(project, result.candidate.name);
  return result;
}

/** PostToolUse adoption probe — Skill is the only visible adoption signal (mem_use is pre-filtered). */
export function recordSkillAdoption(toolName, toolInput, project, sessionId = null) {
  if (getRecommendMode() === 'off') return;
  if (toolName !== 'Skill') return;
  const skill = toolInput && typeof toolInput === 'object' ? toolInput.skill : null;
  if (!skill) return;
  // session id (B1): same cross-hook key as the reco row, so adoptions pair to the
  // would-be recommendation that fired earlier in this session (matched precision).
  logShadowAdoption(project, { session: sessionId ?? null, skill: String(skill).toLowerCase() });
}

/** Human-readable funnel for `registry recommend-stats`. */
export function formatFunnel(s) {
  const blocks =
    Object.entries(s.blockByReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n') || '    (none)';
  const overlap =
    Object.keys(s.passSkills)
      .filter((k) => s.adoptSkills[k])
      .map((k) => `${k}(pass ${s.passSkills[k]}/adopt ${s.adoptSkills[k]})`)
      .join(', ') || '(none)';
  const passRate = s.reco ? ((100 * s.pass) / s.reco).toFixed(1) : '0.0';
  const lines = [
    'shadow recommendation funnel:',
    `  reco=${s.reco}  pass=${s.pass} (${passRate}% of reco)  adopt=${s.adopt}`,
    `  block reasons:\n${blocks}`,
    `  PASS∩adopt (coarse precision proxy): ${overlap}`,
  ];
  // B2: session-paired matched precision + targeting lift (the flip-decision metrics).
  if (typeof s.sessions === 'number') {
    const mp =
      s.matched && s.matched.pass
        ? `${s.matched.adopt}/${s.matched.pass} (${(100 * s.matched.precision).toFixed(0)}%)`
        : 'n/a';
    // v3.42 F5: lift = adoptGivenPass / baseRate is a ratio over `passSessions` observations.
    // Below LIFT_MIN_PASS_SESSIONS the numerator is 1-2 sessions of noise (a single
    // pass→adopt yields lift 7.0 at passSessions=1) — displaying it top-ranked next to a
    // 30-session skill misleads the shadow→live flip decision. Gate the DISPLAY on a minimum
    // observation count and report how many were suppressed (never a silent cap).
    const finite = Object.entries(s.lift || {}).filter(([, v]) => Number.isFinite(v.lift));
    const shown = finite.filter(([, v]) => (v.passSessions || 0) >= LIFT_MIN_PASS_SESSIONS);
    const suppressed = finite.length - shown.length;
    const liftRows =
      shown
        .sort((a, b) => b[1].lift - a[1].lift)
        .slice(0, 5)
        .map(
          ([k, v]) =>
            `${k}(lift ${v.lift.toFixed(2)}; ${v.hitSessions}/${v.passSessions} pass→adopt vs base ${(100 * v.baseRate).toFixed(0)}%)`,
        )
        .join(', ') || '(none)';
    const suppressNote =
      suppressed > 0 ? ` [${suppressed} hidden: passSessions<${LIFT_MIN_PASS_SESSIONS}]` : '';
    lines.push(`  sessions=${s.sessions}  matched precision (in-session PASS→adopt): ${mp}`);
    lines.push(
      `  targeting lift (>1 = gate beats organic base rate, min n=${LIFT_MIN_PASS_SESSIONS}): ${liftRows}${suppressNote}`,
    );
  }
  return lines.join('\n');
}

// Minimum passSessions before a per-skill lift is trustworthy enough to display. Below this,
// adoptGivenPass is computed over 1-2 sessions and the lift is noise (F5).
export const LIFT_MIN_PASS_SESSIONS = 3;

/** Human-readable threshold sweep for `registry recommend-stats --sweep`. */
export function formatSweep(grid) {
  const lines = ['gate threshold sweep (floor × margin → pass / matched precision):'];
  for (const g of grid) {
    const prec = Number.isFinite(g.precision) ? `${(100 * g.precision).toFixed(0)}%` : 'n/a';
    lines.push(
      `  floor=${g.floor} margin=${g.margin}: pass=${g.pass}  matched=${g.matchAdopt}/${g.matchPass}  prec=${prec}`,
    );
  }
  return lines.join('\n');
}
