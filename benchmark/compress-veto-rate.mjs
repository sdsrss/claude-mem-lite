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
// like. Both arms' premises are asserted by a self-check rather than assumed.
//
// Usage:
//   node benchmark/compress-veto-rate.mjs                # both arms, needs a model
//   node benchmark/compress-veto-rate.mjs --json
//   node benchmark/compress-veto-rate.mjs --self-check   # no network; exits 1 on failure
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

  const stamp = new Date().toISOString();
  console.log(`compress veto rate — ${stamp}, mode=${detectMode()}`);
  console.log(`fixture: ${RELATED.length} related + ${UNRELATED.length} unrelated clusters, 3 obs each\n`);

  const unrelated = await runArm(UNRELATED);
  const related = await runArm(RELATED);

  const pct = (r) => (r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`);
  const out = {
    stamp,
    mode: detectMode(),
    unrelated: { ...unrelated, vetoRate: unrelated.refuseRate },
    related: { ...related, falseRefusalRate: related.refuseRate },
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
  const errors = unrelated.error + related.error;
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
