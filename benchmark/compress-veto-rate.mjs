// How often does smart-compress's `should_compress` veto actually fire? (D#10)
//
// WHY THIS EXISTS. D#10 shipped option (b): executeSmartCompressCluster now lets the model
// refuse a cluster, and fails CLOSED on a missing verdict. That closes a real hole — on the
// default config (CLAUDE_MEM_VECTORS unset) clusterForCompression has NO similarity check
// at all and groups by a 14-day window alone, so the veto is the only thing between the
// heuristic and an unattended write that HIDES real rows. But "the veto exists" is not
// "the veto works". Option (a) — make the vocabulary-less branch skip outright — was
// deliberately not taken, and the stated condition for revisiting it was to measure this
// first. Wired up is not calibrated; the same sentence is already in CLAUDE.md about the
// eight scoring multipliers.
//
// WHAT IT ANSWERS. Two rates, and BOTH are required — one alone is not a verdict:
//   • veto rate on UNRELATED clusters   — how often it catches the D#10 shape (want high)
//   • false-refusal rate on RELATED ones — what that costs in lost compression (want low)
// A veto that refuses everything scores 100% on the first and is useless.
//
// CALIBER. It sends the SHIPPED prompt, via hook-optimize.mjs's exported
// buildCompressPrompt — not a retyped copy. That is deliberate and it is the reason the
// prompt was extracted: tests/handoff-simulation.test.mjs spent releases asserting on its
// own re-implementation of a block no user had ever seen. It does NOT call
// executeSmartCompressCluster, for the reason in the next paragraph.
//
// THE HAZARD THIS RULER IS BUILT AROUND. executeSmartCompressCluster returns
// `{ compressed: false }` for a refusal AND for a model error, a bad key, a timeout, or
// unparseable JSON. A ruler that read `compressed` would score a dead API key as a PERFECT
// veto — a flattering number from a blind instrument, which is the failure mode CLAUDE.md's
// doctrine rule 9 names. So this classifies THREE ways (compress / refuse / error), an
// error is never counted as a veto, and any error at all is reported on its own line.
//
// POPULATION. A hand-built fixture, not a corpus sample, and that bound is the point:
// the real corpus on this machine has ZERO smart-compress-eligible rows, so there is
// nothing to sample. The unrelated arm reproduces the shape D#10 measured (members sharing
// only project and era); the related arm is what a genuine multi-note work session looks
// like. Every arm's premise is asserted by a self-check rather than assumed.
//
// THE THIRD ARM (D#13), and why it reports something different. The two arms above answer
// an EASY question: they are separated by design (cohesion 0.1124 vs 0.0051), so "veto
// 100% / false-refusal 0%" says the veto handles the CLEAR case — which is the D#10 shape
// and nothing more. AMBIGUOUS is the population the 14-day fallback actually produces on a
// busy repo: partly one story. It has NO ground truth, so it CANNOT produce a rate, and
// asking for one would invite a reading the fixture cannot support. What repeated runs can
// answer is whether the veto is DECISIVE or a coin flip. Hence: N runs per cluster,
// per-cluster verdict sequences, modal-fraction stability, and no rate.
//
// AND THE REPS VARY MEMBER ORDER, NOT NOTHING. `DEFAULT_LLM_TEMPERATURE` is pinned to 0
// (haiku-client.mjs:57) and the shipped path takes that default, so asking the identical
// prompt three times is close to asking it once — the first version of this arm did that
// and its stability of 1.000 was near-tautological, a blind instrument returning a
// flattering number. Each rep now rotates the cluster instead, which is a variation
// PRODUCTION exhibits: the pools order by `created_at_epoch DESC` with no tiebreaker
// (D#9), so which member sorts first is arbitrary on the same-era rows a 14-day window
// groups. The arm therefore answers something sharp and reachable at temperature 0 — is
// the verdict invariant to presentation order, or an artefact of an arbitrary tie?
//
// Usage:
//   node benchmark/compress-veto-rate.mjs                # all three arms, needs a model
//   node benchmark/compress-veto-rate.mjs --reps 5       # ambiguous arm repetitions (default 3)
//   node benchmark/compress-veto-rate.mjs --no-ambiguous # the two original arms only
//   node benchmark/compress-veto-rate.mjs --json
//   node benchmark/compress-veto-rate.mjs --self-check   # no network; exits 1 on failure
//
// COST is printed before the first call, because the ambiguous arm multiplies: a default
// run is 6 + 6 + 6x3 = 30 model calls, not 12.
//
// Exit code: 0 for a plain run (it is a meter, not a gate). `--self-check` exits 1.

import { fileURLToPath } from 'node:url';
import { callModelJSONAsync, detectMode } from '../haiku-client.mjs';
import { buildCompressPrompt } from '../hook-optimize.mjs';

// ─── Fixture ─────────────────────────────────────────────────────────────────
// Each cluster is 3 observations, the minimum smart-compress will act on.

/** Clusters that ARE one story. A veto here is a false refusal. */
export const RELATED = [
  [
    {
      type: 'bugfix',
      title: 'FTS query crashed on a bare hyphen',
      narrative:
        'sanitizeFtsQuery passed a leading "-" straight to FTS5, which reads it as a NOT operator and throws on a malformed query.',
    },
    {
      type: 'bugfix',
      title: 'Added the FTS sanitizer test for operator characters',
      narrative:
        'Covered the hyphen, quote and asterisk cases that reached FTS5 unescaped from the search CLI.',
    },
    {
      type: 'refactor',
      title: 'Moved FTS query sanitizing into utils',
      narrative:
        'Both the CLI and the MCP search face were escaping query text separately and had already drifted once.',
    },
  ],
  [
    {
      type: 'feature',
      title: 'Added the retry budget to the upload worker',
      narrative:
        'Uploads that failed on a 503 were retried forever; the worker now gives each object five attempts with backoff.',
    },
    {
      type: 'bugfix',
      title: 'Upload retries no longer double-count bytes',
      narrative:
        'The progress meter added the object size on every attempt, so a retried upload reported more bytes than it sent.',
    },
    {
      type: 'change',
      title: 'Logged the retry count per upload',
      narrative:
        'Operators could not tell a slow upload from one that was silently retrying, so the count is now in the completion line.',
    },
  ],
  [
    {
      type: 'decision',
      title: 'Session ids come from the host, not from us',
      narrative:
        'We minted our own session id and it diverged from the host on /clear, so every cross-session join was wrong.',
    },
    {
      type: 'bugfix',
      title: 'Stopped deleting the session file on Stop',
      narrative:
        'Stop fires once per assistant turn, not once per session, so deleting the file minted a fresh session on the next event.',
    },
    {
      type: 'discovery',
      title: '/clear rotates the host session id',
      narrative:
        'The command is issued in the old session and replayed into a new file under a new id, about 0.1s earlier.',
    },
  ],
  [
    {
      type: 'bugfix',
      title: 'Migration 14 dropped the index it meant to rename',
      narrative:
        'The rename path ran DROP then CREATE without a transaction, so an interrupted migration left the table unindexed.',
    },
    {
      type: 'bugfix',
      title: 'Wrapped migration 14 in a transaction',
      narrative:
        'The DROP/CREATE pair is now atomic, so an interrupted run rolls back to the old index rather than none.',
    },
    {
      type: 'change',
      title: 'Added a migration smoke test that kills the process mid-run',
      narrative:
        'Nothing exercised the interrupted-migration path, which is how the unindexed table shipped.',
    },
  ],
  [
    {
      type: 'refactor',
      title: 'Extracted the auth header builder',
      narrative:
        'Three call sites built the Authorization header inline and two of them had stopped adding the tenant id.',
    },
    {
      type: 'bugfix',
      title: 'Tenant id was missing from the export request',
      narrative:
        'The export path built its own Authorization header and never picked up the tenant, so exports returned another tenant’s rows.',
    },
    {
      type: 'change',
      title: 'Pinned the auth header shape with a test',
      narrative: 'The header is now built in one place and asserted field by field.',
    },
  ],
  [
    {
      type: 'bugfix',
      title: 'Cache keys collided across locales',
      narrative:
        'The page cache keyed on path alone, so a request for /fr/pricing served the /en/pricing body.',
    },
    {
      type: 'bugfix',
      title: 'Added locale to the cache key',
      narrative: 'The key is now path plus locale; existing entries fall out on their own TTL.',
    },
    {
      type: 'discovery',
      title: 'The locale bug only showed under CDN warm-up',
      narrative:
        'A cold cache always populated from the first request, so the collision needed two locales inside one TTL window.',
    },
  ],
];

/** Clusters sharing only a project and an era — the D#10 shape. A veto here is a catch. */
export const UNRELATED = [
  [
    {
      type: 'change',
      title: 'Bumped the sidebar hover colour',
      narrative:
        'Changed the hover token from #eee to #e4e4e4 so the contrast ratio clears AA on the light theme.',
    },
    {
      type: 'change',
      title: 'Renamed the Kafka consumer group for billing',
      narrative:
        'The group id still carried the old team prefix, so the dashboards grouped it under the wrong owner.',
    },
    {
      type: 'change',
      title: 'Pinned the Terraform AWS provider to 5.42',
      narrative: 'Provider 5.43 changed a default and the plan started showing spurious diffs on every run.',
    },
  ],
  [
    {
      type: 'bugfix',
      title: 'Fixed the off-by-one in the pagination footer',
      narrative:
        'The last page number was one too high when the total was an exact multiple of the page size.',
    },
    {
      type: 'feature',
      title: 'Added a dark theme to the status page',
      narrative: 'The status page ignored the OS preference and rendered white at night.',
    },
    {
      type: 'refactor',
      title: 'Split the deploy script into build and release',
      narrative: 'One script did both, so a failed release re-ran the whole build on retry.',
    },
  ],
  [
    {
      type: 'change',
      title: 'Upgraded the linter to v9 and migrated the config',
      narrative: 'Flat config replaced .eslintrc; the ignore patterns moved into the config file.',
    },
    {
      type: 'bugfix',
      title: 'Timezone was wrong on the weekly digest email',
      narrative: 'The scheduler formatted in UTC while the copy said "local time".',
    },
    {
      type: 'decision',
      title: 'Chose Postgres over SQLite for the reporting store',
      narrative:
        'Reporting needs concurrent writers from three services, which the embedded option cannot serve.',
    },
  ],
  [
    {
      type: 'feature',
      title: 'Added CSV export to the audit log view',
      narrative: 'Auditors were copying rows out of the HTML table by hand.',
    },
    {
      type: 'bugfix',
      title: 'Fixed the memory leak in the websocket ping loop',
      narrative: 'Each reconnect registered a new interval without clearing the old one.',
    },
    {
      type: 'change',
      title: 'Moved the marketing site to a separate bucket',
      narrative: 'It shared a bucket with user uploads, which made the lifecycle rules mutually exclusive.',
    },
  ],
  [
    {
      type: 'refactor',
      title: 'Replaced moment with date-fns in the invoice module',
      narrative: 'moment is in maintenance mode and the bundle carried its full locale set.',
    },
    {
      type: 'bugfix',
      title: 'The avatar uploader rejected valid PNGs',
      narrative: 'The MIME sniff only accepted image/jpeg despite the accept attribute allowing PNG.',
    },
    {
      type: 'discovery',
      title: 'The staging queue was consuming production events',
      narrative:
        'Both environments pointed at the same subscription name, so staging stole roughly half the events.',
    },
  ],
  [
    {
      type: 'change',
      title: 'Raised the nginx client_max_body_size to 25M',
      narrative: 'Large PDF uploads were rejected at the proxy before reaching the app.',
    },
    {
      type: 'feature',
      title: 'Added keyboard shortcuts to the editor',
      narrative: 'Power users asked for save and preview bindings.',
    },
    {
      type: 'bugfix',
      title: 'Fixed the flaky DNS lookup in the health check',
      narrative: 'The check resolved the hostname on every probe and tripped on a transient SERVFAIL.',
    },
  ],
];

/**
 * Clusters that are PARTLY one story — the population D#13 added, and the one the 14-day
 * fallback actually produces on a busy repo.
 *
 * Two shapes, three of each: (1) two notes about the same subsystem plus one that merely
 * landed the same week, (2) three notes that share a file or a surface but not a problem.
 * There is NO ground truth here and that is the point — a reasonable reviewer could rule
 * either way on any of them, so this arm reports verdict STABILITY across repeated runs
 * rather than a rate. Its premise (cohesion strictly between the other two arms') is
 * asserted by a self-check, so the fixture cannot quietly drift into being a second copy
 * of one of the easy arms.
 */
export const AMBIGUOUS = [
  // (1) same subsystem + a same-week stray
  [
    {
      type: 'bugfix',
      title: 'Search returned the same row twice after an update',
      narrative:
        'The derived text was rebuilt without clearing the old FTS row, so an edited observation matched twice.',
    },
    {
      type: 'refactor',
      title: 'Moved the search result renderer into one module',
      narrative: 'The CLI and the MCP face each formatted results and had already drifted apart once.',
    },
    {
      type: 'change',
      title: 'Bumped the CI runner image to 24.04',
      narrative: 'The old image shipped a toolchain too old for the native build step.',
    },
  ],
  [
    {
      type: 'bugfix',
      title: 'The scheduler skipped the 2am job on DST days',
      narrative: 'Local-time arithmetic meant the hour simply did not exist twice a year.',
    },
    {
      type: 'change',
      title: 'The scheduler logs which timezone it resolved at startup',
      narrative: 'Nothing recorded the resolved zone, so a wrong one was invisible until a job went missing.',
    },
    {
      type: 'feature',
      title: 'Added a CSV download to the billing page',
      narrative: 'Finance was copying the invoice table out of the browser by hand.',
    },
  ],
  [
    {
      type: 'bugfix',
      title: 'Webhook retries hammered an endpoint that was already failing',
      narrative: 'A fixed one-second retry turned a single 500 into several hundred requests a minute.',
    },
    {
      type: 'decision',
      title: 'Webhook delivery moves to exponential backoff with a cap',
      narrative:
        'Backoff was chosen over a circuit breaker because receivers recover at very different speeds.',
    },
    {
      type: 'refactor',
      title: 'Renamed the test helper directory to match the source layout',
      narrative: 'Helpers lived under a name that no longer described anything after the package split.',
    },
  ],
  // (2) same file or surface, different problems
  [
    {
      type: 'bugfix',
      title: 'The port was compared as a string and never matched',
      narrative:
        'Config read the value from the environment and left it as text, so the equality check failed.',
    },
    {
      type: 'feature',
      title: 'Config accepts a per-environment override file',
      narrative: 'Staging and production diverged in three values and both were being edited by hand.',
    },
    {
      type: 'change',
      title: 'Config logs which source each value came from',
      narrative: 'Nothing said whether a value came from the file, the environment or a default.',
    },
  ],
  [
    {
      type: 'bugfix',
      title: 'The email validator rejected plus-addressing',
      narrative:
        'A tightened pattern dropped the plus sign, so anyone using a tagged address could not sign up.',
    },
    {
      type: 'change',
      title: 'Indexed the account creation date for the admin list',
      narrative: 'The admin list sorted by creation date over a full table scan and timed out past 50k rows.',
    },
    {
      type: 'refactor',
      title: 'Split the account serializer out of the model',
      narrative: 'Presentation logic had accumulated on the model and two views needed different shapes.',
    },
  ],
  [
    {
      type: 'bugfix',
      title: 'A partial write still answered 200',
      narrative:
        'The handler returned before the stream finished, so a truncated object looked like a success.',
    },
    {
      type: 'change',
      title: 'The endpoint now requires a declared length',
      narrative: 'Without one the proxy buffered the whole body and the limit could not be enforced early.',
    },
    {
      type: 'discovery',
      title: 'That route is the only one with no timeout',
      narrative:
        'Every other handler inherits the server default; this one was mounted before the default existed.',
    },
  ],
];

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * THREE outcomes, never two. A model error and a refusal both stop a compression, but
 * only one of them is the veto working — see the header. `error` is never a veto.
 *
 * @param {any} parsed the parsed model response, or null/undefined on failure
 * @returns {'compress'|'refuse'|'error'}
 */
export function classify(parsed) {
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') return 'error';
  if (!('should_compress' in parsed)) return 'refuse'; // fail-closed, as shipped
  return parsed.should_compress ? 'compress' : 'refuse';
}

/** Ask the real model, with the real prompt. */
async function judgeCluster(cluster) {
  const parsed = await callModelJSONAsync(buildCompressPrompt(cluster), 'sonnet', {
    timeout: 60000,
    maxTokens: 1000,
  });
  return classify(parsed);
}

/**
 * @param {Array<Array<object>>} clusters
 * @param {(c: Array<object>) => Promise<'compress'|'refuse'|'error'>} judge
 */
export async function runArm(clusters, judge = judgeCluster) {
  const verdicts = [];
  for (const c of clusters) verdicts.push(await judge(c));
  const count = (v) => verdicts.filter((x) => x === v).length;
  const decided = count('compress') + count('refuse');
  return {
    n: clusters.length,
    compress: count('compress'),
    refuse: count('refuse'),
    error: count('error'),
    // Rate over DECIDED clusters, so errors cannot inflate it in either direction.
    refuseRate: decided > 0 ? count('refuse') / decided : null,
    verdicts,
  };
}

/**
 * Rotate a cluster's members by `by`. Order is the ONE thing the repetition varies — see
 * runArmRepeated. Pure; the caller's array is never touched.
 */
export function rotateCluster(cluster, by) {
  const n = cluster.length;
  if (n === 0) return [];
  const k = ((by % n) + n) % n;
  return cluster.slice(k).concat(cluster.slice(0, k));
}

/**
 * The AMBIGUOUS arm's aggregator. Deliberately returns NO rate.
 *
 * A rate needs a ground truth to be right or wrong about, and an ambiguous cluster has
 * none — a reasonable reviewer could rule either way. What repeated runs CAN answer is
 * whether the veto is DECISIVE or a coin flip.
 *
 * WHAT THE REPETITION VARIES, and why it is not the obvious thing. Asking the identical
 * prompt N times would measure almost nothing here: `DEFAULT_LLM_TEMPERATURE` is pinned to
 * 0 (haiku-client.mjs:57) and the shipped path uses that default, so a repeated call is
 * close to asking one question once, and a stability of 1.000 would be near-tautological —
 * a blind instrument reporting a flattering number, which is the failure mode this whole
 * ruler is built around. The first version of this arm did exactly that and the reading was
 * withdrawn.
 *
 * So each rep ROTATES the cluster's member order instead. That is a variation PRODUCTION
 * actually exhibits: the merge/compress pools order by `created_at_epoch DESC` with no
 * tiebreaker (D#9), so which member is presented first is arbitrary on same-era rows —
 * exactly the rows a 14-day window groups. The question the arm now answers is therefore
 * sharp and reachable at temperature 0: **is the verdict invariant to presentation order,
 * or an artefact of which row happened to sort first?** A flip means the same cluster
 * compresses or survives depending on a tie SQLite broke arbitrarily.
 *
 * Stability = the MODAL fraction over DECIDED runs (errors excluded, exactly as
 * `runArm.refuseRate` excludes them). A cluster that never decided reports `null` rather
 * than 1 — otherwise a dead key would read as perfect agreement, the same blind-instrument
 * hazard the three-way classification exists to prevent.
 *
 * @param {Array<Array<object>>} clusters
 * @param {(c: Array<object>) => Promise<'compress'|'refuse'|'error'>} judge
 * @param {number} reps how many times to ask about EACH cluster (D#13: at least 3)
 * @param {{permute?: boolean}} [opts] `permute: false` repeats the identical prompt — kept
 *   only so a caller can demonstrate the degenerate case; never the default.
 */
export async function runArmRepeated(clusters, judge = judgeCluster, reps = 3, opts = {}) {
  const permute = opts.permute !== false;
  const out = [];
  for (const cluster of clusters) {
    const verdicts = [];
    const orders = [];
    for (let r = 0; r < reps; r++) {
      const presented = permute ? rotateCluster(cluster, r) : cluster;
      orders.push(presented.map((o) => o.title));
      verdicts.push(await judge(presented));
    }
    const decidedVerdicts = verdicts.filter((v) => v !== 'error');
    const tally = new Map();
    for (const v of decidedVerdicts) tally.set(v, (tally.get(v) ?? 0) + 1);
    let modal = null;
    let modalN = 0;
    for (const [v, n] of tally)
      if (n > modalN) {
        modal = v;
        modalN = n;
      }
    const decided = decidedVerdicts.length;
    out.push({
      verdicts,
      decided,
      error: verdicts.length - decided,
      modal,
      // One decision is not evidence of stability, so `null` below 2 — same reason the
      // all-error case is null rather than 1.
      stability: decided >= 2 ? modalN / decided : null,
      unanimous: decided >= 2 && modalN === decided,
      cohesion: clusterCohesion(cluster),
      // THE PREMISE, carried per cluster rather than assumed: how many genuinely different
      // member orders this cluster was actually shown in. If this is 1 while reps > 1 the
      // repetition varied nothing and the stability beside it means nothing.
      distinctOrders: new Set(orders.map((o) => o.join(' '))).size,
    });
  }
  const scored = out.filter((c) => c.stability !== null);
  return {
    n: clusters.length,
    reps,
    permuted: permute,
    // Arm-level premise: the smallest number of distinct orders any cluster was shown in.
    // 1 with reps > 1 means this arm is measuring nothing at temperature 0.
    minDistinctOrders: out.length ? Math.min(...out.map((c) => c.distinctOrders)) : 0,
    clusters: out,
    meanStability: scored.length ? scored.reduce((a, c) => a + c.stability, 0) / scored.length : null,
    unanimousDecided: out.filter((c) => c.unanimous).length,
    flipped: out.filter((c) => c.stability !== null && !c.unanimous).length,
    error: out.reduce((a, c) => a + c.error, 0),
  };
}

// ─── Self-checks ─────────────────────────────────────────────────────────────

const tokens = (o) =>
  new Set(
    `${o.title} ${o.narrative}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3),
  );

/** Mean pairwise Jaccard over a cluster's members. */
export function clusterCohesion(cluster) {
  const sets = cluster.map(tokens);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const inter = [...sets[i]].filter((t) => sets[j].has(t)).length;
      const union = new Set([...sets[i], ...sets[j]]).size;
      sum += union ? inter / union : 0;
      pairs++;
    }
  }
  return pairs ? sum / pairs : 0;
}

export function runSelfChecks() {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. THE one that matters. A dead key, a timeout or unparseable JSON must never be
  //    counted as the veto working — that is how a blind instrument returns 100%.
  check('a null response is an error, not a veto', classify(null) === 'error', classify(null));
  check('a non-object response is an error', classify('nope') === 'error', classify('nope'));

  // 2. The shipped semantics, mirrored: fail closed on an omitted verdict.
  check('an omitted verdict counts as a refusal', classify({ title: 't' }) === 'refuse');
  check('an explicit false is a refusal', classify({ should_compress: false }) === 'refuse');
  check('an explicit true is a compression', classify({ should_compress: true }) === 'compress');

  // 3. The aggregator can tell the two extremes apart. If it cannot, every rate below is
  //    noise no matter how the model behaves.
  return (async () => {
    const allRefuse = await runArm(UNRELATED, async () => 'refuse');
    const allCompress = await runArm(UNRELATED, async () => 'compress');
    const allError = await runArm(UNRELATED, async () => 'error');
    check('an all-refuse arm reports rate 1', allRefuse.refuseRate === 1, allRefuse.refuseRate);
    check('an all-compress arm reports rate 0', allCompress.refuseRate === 0, allCompress.refuseRate);
    check(
      'an all-error arm reports NO rate rather than 1',
      allError.refuseRate === null && allError.error === UNRELATED.length,
      `rate=${allError.refuseRate} errors=${allError.error}`,
    );

    // 4. The ruler drives the SHIPPED prompt, and drives it with its own input. Quoted,
    //    because the bare-string form was walked past by the real revert shape (mutation
    //    M16: delete the key from the JSON template, keep the prose that explains it).
    const prompt = buildCompressPrompt(UNRELATED[0]);
    check('the shipped prompt asks for the verdict', prompt.includes('"should_compress"'));
    check(
      'the prompt is built from the cluster, not a constant',
      prompt.includes(UNRELATED[0][0].title),
      UNRELATED[0][0].title,
    );

    // 5. The fixture's own premise. If the "unrelated" arm were quietly cohesive, a low
    //    veto rate would say nothing about the model.
    const relCoh = RELATED.map(clusterCohesion);
    const unrelCoh = UNRELATED.map(clusterCohesion);
    const meanRel = relCoh.reduce((a, b) => a + b, 0) / relCoh.length;
    const meanUnrel = unrelCoh.reduce((a, b) => a + b, 0) / unrelCoh.length;
    check(
      'the related arm is lexically more cohesive than the unrelated one',
      meanRel > meanUnrel * 2,
      `related ${meanRel.toFixed(4)} vs unrelated ${meanUnrel.toFixed(4)}`,
    );
    check(
      'every unrelated cluster is near-disjoint',
      unrelCoh.every((c) => c < 0.03),
      unrelCoh.map((c) => c.toFixed(4)).join(' '),
    );

    // 6. The ambiguous arm's premise (D#13). Same shape as check 5 and for the same
    //    reason: if this fixture drifted to either extreme the arm would silently become a
    //    second copy of an easy question, and its stability reading would be quoted as if
    //    it were about hard clusters. Mutation-verified against the real drift shape
    //    (aliasing AMBIGUOUS to UNRELATED): reads FAIL, exit 1.
    const ambCoh = AMBIGUOUS.map(clusterCohesion);
    const meanAmb = ambCoh.reduce((a, b) => a + b, 0) / ambCoh.length;
    check(
      'the ambiguous arm sits strictly between the other two in cohesion',
      meanAmb > meanUnrel && meanAmb < meanRel,
      `unrelated ${meanUnrel.toFixed(4)} < ambiguous ${meanAmb.toFixed(4)} < related ${meanRel.toFixed(4)}`,
    );

    // 7. The repeated aggregator must not turn a dead key into agreement. Same hazard as
    //    check 3's all-error arm, one layer up: `stability` is over DECIDED runs, so an
    //    arm that never decided reports NO stability rather than a perfect 1.
    const allErrorReps = await runArmRepeated(AMBIGUOUS, async () => 'error', 3);
    check(
      'an all-error repeated arm reports NO stability rather than 1',
      allErrorReps.meanStability === null &&
        allErrorReps.error === AMBIGUOUS.length * 3 &&
        allErrorReps.unanimousDecided === 0,
      `mean=${allErrorReps.meanStability} errors=${allErrorReps.error}`,
    );
    let flip = 0;
    const flipping = await runArmRepeated(AMBIGUOUS, async () => (flip++ % 2 ? 'refuse' : 'compress'), 3);
    check(
      'a coin-flipping arm is not reported as unanimous',
      flipping.unanimousDecided === 0 && flipping.flipped === AMBIGUOUS.length,
      `unanimous=${flipping.unanimousDecided} flipped=${flipping.flipped}`,
    );

    // 8. THE ARM'S OWN PREMISE, and the reason it exists at all. At temperature 0 (pinned,
    //    haiku-client.mjs:57) repeating an identical prompt measures nothing, so the reps
    //    rotate member order instead. If the rotation stopped varying the input, every
    //    stability number this arm prints would be tautological — so assert it, and assert
    //    that the degenerate mode really is degenerate, which is what makes this a check
    //    rather than a restatement.
    const permuted = await runArmRepeated(AMBIGUOUS, async () => 'refuse', 3);
    check(
      'the repeated arm shows each cluster a different member order every rep',
      permuted.permuted === true && permuted.minDistinctOrders === 3,
      `minDistinctOrders=${permuted.minDistinctOrders} over reps=3`,
    );
    const unpermuted = await runArmRepeated(AMBIGUOUS, async () => 'refuse', 3, { permute: false });
    check(
      'without permutation the arm would vary nothing — the degenerate case is detectable',
      unpermuted.minDistinctOrders === 1,
      `minDistinctOrders=${unpermuted.minDistinctOrders}`,
    );
    check(
      'rotation is a permutation, not a mutation',
      (() => {
        const src = AMBIGUOUS[0];
        const rot = rotateCluster(src, 1);
        return (
          rot.length === src.length &&
          rot[0] === src[1] &&
          src[0].title === AMBIGUOUS[0][0].title &&
          new Set(rot).size === new Set(src).size
        );
      })(),
    );

    return {
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      results,
    };
  })();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const json = process.argv.includes('--json');

  if (process.argv.includes('--self-check')) {
    const { passed, failed, results } = await runSelfChecks();
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail !== undefined ? `  [${r.detail}]` : ''}`);
    }
    console.log(`\n${passed} passed, ${failed.length} failed`);
    if (failed.length) process.exitCode = 1;
    return;
  }

  const repsArg = Number(process.argv[process.argv.indexOf('--reps') + 1]);
  const reps = process.argv.includes('--reps') && Number.isInteger(repsArg) && repsArg >= 1 ? repsArg : 3;
  const skipAmbiguous = process.argv.includes('--no-ambiguous');

  const stamp = new Date().toISOString();
  const calls = RELATED.length + UNRELATED.length + (skipAmbiguous ? 0 : AMBIGUOUS.length * reps);
  console.log(`compress veto rate — ${stamp}, mode=${detectMode()}`);
  console.log(
    `fixture: ${RELATED.length} related + ${UNRELATED.length} unrelated + ${skipAmbiguous ? 0 : AMBIGUOUS.length} ambiguous x${reps} clusters, 3 obs each`,
  );
  console.log(`model calls this run: ${calls}\n`);

  const unrelated = await runArm(UNRELATED);
  const related = await runArm(RELATED);
  const ambiguous = skipAmbiguous ? null : await runArmRepeated(AMBIGUOUS, judgeCluster, reps);

  const pct = (r) => (r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`);
  const out = {
    stamp,
    mode: detectMode(),
    unrelated: { ...unrelated, vetoRate: unrelated.refuseRate },
    related: { ...related, falseRefusalRate: related.refuseRate },
    // No rate here, on purpose — see runArmRepeated's docblock.
    ambiguous,
  };
  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`UNRELATED arm (a refusal is the veto CATCHING the D#10 shape)`);
  console.log(
    `  veto rate      ${pct(unrelated.refuseRate)}  (${unrelated.refuse}/${unrelated.refuse + unrelated.compress} decided)`,
  );
  console.log(`  verdicts       ${unrelated.verdicts.join(' ')}`);
  console.log(`\nRELATED arm (a refusal is the veto COSTING a real compression)`);
  console.log(
    `  false-refusal  ${pct(related.refuseRate)}  (${related.refuse}/${related.refuse + related.compress} decided)`,
  );
  console.log(`  verdicts       ${related.verdicts.join(' ')}`);
  if (ambiguous) {
    console.log(`\nAMBIGUOUS arm (partly one story — NO ground truth, so no rate is reported)`);
    console.log(
      `  decisive       ${ambiguous.unanimousDecided}/${ambiguous.n} clusters gave the same verdict every time; ${ambiguous.flipped} flipped`,
    );
    console.log(
      `  mean stability ${ambiguous.meanStability === null ? 'n/a' : ambiguous.meanStability.toFixed(3)}  (modal fraction over decided runs, x${ambiguous.reps})`,
    );
    console.log(
      `  premise        member order varied ${ambiguous.minDistinctOrders} ways per cluster (temperature is pinned to 0, so ORDER is what the reps vary)`,
    );
    for (const [i, c] of ambiguous.clusters.entries()) {
      console.log(
        `    #${i} coh ${c.cohesion.toFixed(4)}  ${c.verdicts.join(' ')}${c.stability === null ? '  (undecided)' : ''}`,
      );
    }
    console.log(`  A flip here means the verdict depends on which member sorted first — and`);
    console.log(`  production breaks that tie arbitrarily (D#9), so it would not be stable.`);
  }
  const errors = unrelated.error + related.error + (ambiguous?.error ?? 0);
  console.log(
    `\nerrors: ${errors}${errors ? '  — these are NOT counted as vetoes; rerun before quoting a rate' : ''}`,
  );
  console.log(`\nBoth numbers or neither: a veto that refuses everything reads 100% above and is useless.`);
}

// Only when RUN, never when imported: a test that imports this file must not fire
// twelve billable model calls as a side effect of loading it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
