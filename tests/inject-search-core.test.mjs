// P2-11 (audit 2026-08-14): lib/inject-search-core.mjs — the injection-side shared
// core. Three SQL atoms kept drifting across hand-copied twins (M-1: the MAX(0,…)
// decay clamp reached search-engine but not UPS/error-recall; M-3: cite/noise
// reached every auto surface but not FULL_SCORE; the live-row filter pair missed
// its 7th surface in H-1): this suite pins BOTH the atoms' semantics AND that the
// five consumer files actually compose them instead of re-inlining copies.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import {
  liveObsFilterSql, recencyDecaySql, injectionRelevanceSql,
} from '../lib/inject-search-core.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('shared atoms — semantics', () => {
  it('liveObsFilterSql pairs compressed + superseded for both alias forms', () => {
    expect(liveObsFilterSql('o')).toContain('COALESCE(o.compressed_into, 0) = 0');
    expect(liveObsFilterSql('o')).toContain('o.superseded_at IS NULL');
    expect(liveObsFilterSql('')).toContain('COALESCE(compressed_into, 0) = 0');
    expect(liveObsFilterSql('')).toContain('superseded_at IS NULL');
  });

  // FAILS IF: the MAX(0,…) clamp is dropped — the M-1 overflow (future epoch →
  // EXP(+huge) → ±Infinity → row pins #1 for every query) comes back at the
  // single home and silently reaches every derived surface at once.
  it('recencyDecaySql carries the M-1 age clamp', () => {
    const sql = recencyDecaySql({ tsExpr: 'o.created_at_epoch' });
    expect(sql).toContain('MAX(0, ? - o.created_at_epoch)');
    expect(sql).toContain('EXP(-0.693');
  });

  // FAILS IF: the v46 nowParam option changes what EXISTING callers generate. Six
  // call sites bind this expression BY POSITION, so a different default would
  // renumber their parameters silently — the exact failure that broke error-recall
  // while it was being written (MATCH received a project name; FTS5 reported
  // `no such column`). Named placeholders must reach only the caller that asks.
  it('nowParam defaults to positional ? and changes nothing unless requested', () => {
    const base = recencyDecaySql({ tsExpr: 'o.created_at_epoch' });
    expect(base, 'default must stay byte-identical to the pre-option output')
      .toBe(recencyDecaySql({ tsExpr: 'o.created_at_epoch', nowParam: '?' }));
    const named = recencyDecaySql({ tsExpr: 'o.created_at_epoch', nowParam: '@now' });
    expect(named).toContain('MAX(0, @now - o.created_at_epoch)');
    expect(named, 'opting in must remove the positional placeholder, not add to it')
      .not.toContain('MAX(0, ? -');
    expect(named).toBe(base.replace('MAX(0, ? -', 'MAX(0, @now -'));
  });

  // FAILS IF: cite or noise is dropped from the injection relevance chain — the
  // M-3 class (behavior signal wired on some surfaces, missing on others) reopens.
  it('injectionRelevanceSql composes decay + type-quality + importance + noise + cite', () => {
    const sql = injectionRelevanceSql('o');
    expect(sql).toContain('MAX(0, ? - o.created_at_epoch)');   // clamped decay
    expect(sql).toContain("CASE o.type");                       // type quality/decay cases
    expect(sql).toContain('0.5 + 0.5 * COALESCE(o.importance, 1)');
    expect(sql).toContain('injection_count');                   // noise penalty
    expect(sql).toContain('cited_count');                       // cite factor
  });

  // Functional M-1 pin at the core level: a far-future created_at row must score
  // FINITE (clamp reads it as age 0), not ±Infinity.
  it('a future-epoch row scores finite through injectionRelevanceSql (real SQL)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
                VALUES ('s1', 'm1', 'p', datetime('now'), ?, 'active')`).run(Date.now());
    db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, text, created_at, created_at_epoch)
                VALUES ('m1', 'p', 'bugfix', 'quasar flux regression', 'quasar body', datetime('now'), ?)`)
      .run(Date.now() + 10 * 365 * 86400000);
    const row = db.prepare(`
      SELECT ${injectionRelevanceSql('o')} AS relevance
      FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH 'quasar'
    `).get(Date.now());
    expect(row, 'seed row must be FTS-reachable').toBeTruthy();
    expect(Number.isFinite(row.relevance), `relevance=${row.relevance}`).toBe(true);
    db.close();
  });
});

// ─── The ledger: consumers must COMPOSE the core, not re-inline copies ─────────────
// The whole point of P2-11 — a new retrieval query hand-rolling the live-filter
// pair inside these files is the exact drift this module exists to end. Write-side
// guards (H-1 dedup joins use a./b. aliases; UPDATE guards use the bare column
// without the compressed pair) do not match this shape and stay untouched.

describe('consumer ledger — no inlined live-filter pairs in the converted files', () => {
  const FILES = [
    // P2-11 first cut — the injection-side surfaces:
    'scripts/user-prompt-search.js',
    'scripts/pre-tool-recall.js',
    'hook-memory.mjs',
    'hook.mjs',
    'search-engine.mjs',
    // D#123 second cut — the remaining read surfaces. Deliberate NON-members of
    // this ledger keep their compressed-only singles (verified legitimately
    // different, deferral 2026-08-16): maintain-core UPDATE/compression guards,
    // stats-core noise-gauge counts (its "live" = non-compressed by definition,
    // F7), hook-optimize enrich-candidate singles, hook-handoff session-own
    // history (comment at its `completed` query), hook-context velocity count,
    // schema index predicate.
    //
    // server.mjs joined on 2026-08-16: mem_export's runExport was the last read
    // surface still hand-writing the pair while its CLI twin already composed
    // the core. Its include_compressed branch keeps a superseded-only single,
    // which this shape does not match.
    'server.mjs',
    'hook-context.mjs',
    'hook-handoff.mjs',
    'hook-optimize.mjs',
    'mem-cli.mjs',
    'search-scoring.mjs',
    'tfidf.mjs',
    'deep-search.mjs',
    'lib/recall-core.mjs',
    'lib/recent-core.mjs',
    'lib/timeline-core.mjs',
    'lib/stats-core.mjs',
    'lib/search-core.mjs',
    'lib/maintain-core.mjs',
    'benchmark/benchmark.mjs',
  ];
  // Retrieval-shape pair: COALESCE(<alias.|bare>compressed_into, 0) = 0 within a
  // few lines of <alias.|bare>superseded_at IS NULL — EITHER order (review
  // 2026-08-16: the original o.-only, one-direction regex let an aliased or
  // reversed hand-rolled pair slip; the H-1 a./b. dedup join was converted to
  // liveObsFilterSql so any-alias scanning has no legitimate hits left).
  const PAIR_RES = [
    /COALESCE\((?:\w+\.)?compressed_into,\s*0\)\s*=\s*0[\s\S]{0,200}?(?:\w+\.)?superseded_at IS NULL/g,
    /(?:\w+\.)?superseded_at IS NULL[\s\S]{0,200}?COALESCE\((?:\w+\.)?compressed_into,\s*0\)\s*=\s*0/g,
  ];

  // Strip `//` line comments before scanning (keep line count: blank the text,
  // not the newline). Review 2026-08-16: a comment naming both literals near a
  // legitimate compressed-only single (e.g. hook-handoff's exemption note) would
  // otherwise false-positive the pair regex if an edit drifted them within the
  // 200-char window. SQL `--` comments inside templates are NOT stripped — they
  // sit inside the query text the regex is meant to police.
  const stripLineComments = (src) => src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  for (const f of FILES) {
    it(`${f} contains no hand-rolled live-filter pair`, () => {
      const src = stripLineComments(readFileSync(join(REPO, f), 'utf8'));
      const hits = PAIR_RES.flatMap((re) => [...src.matchAll(re)]).map((m) => {
        const line = src.slice(0, m.index).split('\n').length;
        return `${f}:${line}`;
      });
      expect(hits, `inline the shared core instead: ${hits.join(', ')}`).toEqual([]);
    });
  }

  // A file may reach the core THROUGH a named shared module instead of importing it
  // directly. Each entry names the intermediary, and the intermediary is then checked to
  // actually import the core — so the exemption cannot rot into "this file no longer uses
  // the live filter at all", which the per-file pair scan above would happily pass.
  //
  // server.mjs joined this list in v3.92.0: audit P2-5 moved `runExport`'s WHERE assembly
  // into `lib/export-columns.mjs::buildExportWhere`, which is where its live-row predicate
  // now comes from. Its direct import became unused and eslint removed it. Without this
  // indirection the ledger goes red on a change that made the sharing STRONGER — the
  // source-anchor guard failing because its anchor legitimately moved.
  const VIA = { 'server.mjs': 'lib/export-columns.mjs' };

  it('every consumer reaches the shared core, directly or through a declared module', () => {
    for (const f of FILES) {
      const src = readFileSync(join(REPO, f), 'utf8');
      if (src.includes('inject-search-core.mjs')) continue;
      const via = VIA[f];
      expect(via, `${f} neither imports the core nor declares an intermediary`).toBeTruthy();
      // Anchored on the import SPECIFIER, not a bare substring: `src.includes('export-columns.mjs')`
      // is satisfied by a COMMENT naming the module, so the ledger could clear a file whose
      // real edge had moved away. Today an adjacent behavioural case happens to catch that;
      // the ledger should stand on its own.
      const viaSpecifier = new RegExp(`from\\s+'[^']*${via.replace(/^lib\//, '').replace(/\./g, '\\.')}'`);
      expect(viaSpecifier.test(src), `${f} does not import its declared intermediary ${via}`).toBe(true);
      expect(readFileSync(join(REPO, via), 'utf8').includes('inject-search-core.mjs'),
        `${via} is declared as ${f}'s route to the core but does not import it`).toBe(true);
    }
  });

  it('the indirection list has no dead entries', () => {
    // An intermediary that stopped being needed — because the file went back to importing
    // the core directly — must be removed rather than left as a standing exemption.
    for (const [f, via] of Object.entries(VIA)) {
      const src = readFileSync(join(REPO, f), 'utf8');
      expect(src.includes('inject-search-core.mjs'),
        `${f} imports the core directly now; drop its ${via} entry from VIA`).toBe(false);
    }
  });

  // FAILS IF: any consumer re-inlines the decay shape instead of composing
  // recencyDecaySql (benchmark's `hybrid` mode claims FULL_SCORE fidelity —
  // D#123 found it carrying an unclamped created-only constant-half-life copy).
  // The clamp fix (M-1) must have exactly one home.
  it('no hand-rolled EXP decay outside the core', () => {
    for (const f of FILES) {
      const src = readFileSync(join(REPO, f), 'utf8');
      expect(src.includes('EXP(-0.693'), `${f} re-inlines the decay shape — compose recencyDecaySql`).toBe(false);
    }
  });
});

// ─── mem_export's live-row filter, behaviourally ────────────────────────────
// The ledger above pins the SHAPE (server.mjs composes the core). It did not pin
// the OUTCOME: inverting runExport's ternary — so the default export leaks
// retracted rows and hides compressed ones — passed the whole suite (independent
// review, 2026-08-16). Export feeds `restore`, and "superseded rows escaped a
// read surface" is the invariant this repo has re-opened seven times, so it is
// driven through the real handler body rather than asserted against SQL text.
describe('mem_export default excludes retracted AND compressed rows', () => {
  it('drives runExport: default = live only, include_compressed adds compressed but never retracted', async () => {
    const [{ handleExportForTest }, { createTestDb }, { saveObservation }] = await Promise.all([
      import('../server.mjs'),
      import('./test-helpers.mjs'),
      import('../lib/save-observation.mjs'),
    ]);
    const db = createTestDb();
    const P = 'export--live-filter';
    const live = saveObservation(db, { project: P, type: 'bugfix', content: 'live row about FTS triggers not firing', title: 'LIVEROW marker' }).id;
    const gone = saveObservation(db, { project: P, type: 'bugfix', content: 'retracted row about proxy CONNECT tunnels', title: 'GONEROW marker' }).id;
    const zipped = saveObservation(db, { project: P, type: 'bugfix', content: 'compressed row about vector vocabulary gaps', title: 'ZIPROW marker' }).id;
    db.prepare('UPDATE observations SET superseded_at = ?, superseded_by = ? WHERE id = ?').run(Date.now(), live, gone);
    db.prepare('UPDATE observations SET compressed_into = 999 WHERE id = ?').run(zipped);

    const idsOf = async (args) => {
      const res = await handleExportForTest(db, { project: P, format: 'jsonl', limit: 100, ...args });
      const text = res.content.map((c) => c.text).join('\n');
      return text.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l).id);
    };

    const byDefault = await idsOf({});
    expect(byDefault).toContain(live);
    expect(byDefault, 'a retracted row must never reach export').not.toContain(gone);
    expect(byDefault, 'compressed rows are opt-in').not.toContain(zipped);

    const withCompressed = await idsOf({ include_compressed: true });
    expect(withCompressed).toContain(live);
    expect(withCompressed).toContain(zipped);
    expect(withCompressed, 'include_compressed must not un-hide retractions').not.toContain(gone);
    db.close();
  });
});
