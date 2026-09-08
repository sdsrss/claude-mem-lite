// D#5 — `total` reports a population the pagination cannot hand back.
//
// `computePerSourceWindow` is offset-INDEPENDENT by design (D#30: an offset-scaled
// pool re-ranks its own prefix under RRF, so pages overlapped and gapped on a
// vector-populated DB). That bound is correct and stays. What was never adjusted is
// the REPORTED NUMBER: countSearchTotal re-derives the full MATCH+filter population.
//
// Measured 2026-09-07 against a 128-row sandbox corpus (CLAUDE_MEM_DIR sandbox; the
// real DB was verified untouched at 14 rows before and after): the last non-empty
// offset is 59 / 59 / 89 for limits 10 / 20 / 30 — exactly max(limit*3, 60) — while
// the CLI printed "Found 10 of 128" at offset 50 and "No results at offset 60". At
// the default mem_search limit of 20 that is 60 of 128 rows (46.9%) unreachable at
// ANY offset, with nothing saying so.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreRunSearchPipeline, reachabilityNote, searchPromptsFts } from '../lib/search-core.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';
import { createTestDb, insertSession, insertObs, insertPrompt } from './test-helpers.mjs';

const shown = { total: 128, reachable: 60, offset: 0, isDeep: false };

describe('reachabilityNote — D#5, the ceiling the reported total hides', () => {
  it('names both numbers when a reachable page still hides part of the population', () => {
    const note = reachabilityNote(shown);
    expect(note).toContain('128 rows match');
    expect(note).toContain('only the first 60 are pageable');
    // The caller needs the remedy, not just the diagnosis.
    expect(note).toContain('Raise the limit');
  });

  it('explains an EMPTY page differently — the offset is the fact that needs naming', () => {
    const note = reachabilityNote({ ...shown, offset: 60 });
    expect(note).toContain('offset 60 is past this query');
    expect(note).toContain('128 rows match');
    // Not the other wording: an empty page told "offsets past 60 return empty" reads
    // as advice about a page the caller is already on.
    expect(note).not.toContain('offsets at or past');
  });

  it('is silent when the whole population is reachable', () => {
    expect(reachabilityNote({ ...shown, reachable: 128 })).toBe('');
    expect(reachabilityNote({ ...shown, reachable: 200 })).toBe('');
  });

  it('is silent for deep — there `total` IS the fused set, so the bound is a different one', () => {
    expect(reachabilityNote({ ...shown, isDeep: true })).toBe('');
  });

  it('is silent when NOTHING came back — that is the zero-result branch, not a paging bound', () => {
    // A tier filter that dropped every candidate leaves total > 0 with reachable 0.
    // Answering that with a pagination note would misattribute it.
    expect(reachabilityNote({ ...shown, reachable: 0 })).toBe('');
  });

  it('is silent on missing or non-numeric inputs rather than rendering NaN', () => {
    expect(reachabilityNote()).toBe('');
    expect(reachabilityNote({ total: 128 })).toBe('');
    expect(reachabilityNote({ ...shown, total: undefined })).toBe('');
    expect(reachabilityNote({ ...shown, reachable: null })).toBe('');
  });

  it('honours the off switch, and ONLY the documented value', () => {
    expect(reachabilityNote({ ...shown, env: { CLAUDE_MEM_REACH_DISCLOSURE: 'off' } })).toBe('');
    expect(reachabilityNote({ ...shown, env: { CLAUDE_MEM_REACH_DISCLOSURE: 'OFF' } })).toBe('');
    // '0' is not the documented value — treating it as off would silence installs that
    // meant to set it and mistyped, which is the failure this repo keeps paying for.
    expect(reachabilityNote({ ...shown, env: { CLAUDE_MEM_REACH_DISCLOSURE: '0' } })).not.toBe('');
    expect(reachabilityNote({ ...shown, env: {} })).not.toBe('');
  });

  it('is wired into BOTH faces, from one shared home', () => {
    // Structural, mirroring the deepDisclosureNote guard: the end-to-end positive path
    // needs a corpus larger than the fusion pool, which no unit fixture builds, and this
    // repo's most expensive recurring defect is twin surfaces drifting apart.
    // Assert the CALL, not the name — a substring check on the symbol is satisfied by a
    // rename to reachabilityNoteXX while the wiring is gone.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const face of ['server.mjs', 'mem-cli.mjs']) {
      const src = readFileSync(join(root, face), 'utf8');
      expect(src, `${face} must CALL the shared helper`).toMatch(/\breachabilityNote\(\{/);
      // Every silence rule lives in the helper, but the helper can only apply the
      // reachable rule if the face hands it the count. A face that forgets `reachable`
      // gets the default 0, trips the `reachable > 0` guard and goes PERMANENTLY silent
      // — a failure that looks exactly like "working as intended".
      expect(src, `${face} must pass reachable`).toMatch(/reachable:/);
      expect(src, `${face} must not restate the note text`).not.toContain('are pageable');
    }
  });

  // ── D#20 (R11-A-P2-2): the two numbers are not the same caliber ──────────────
  //
  // `total` is countSearchTotal's SQL MATCH+filter population; `reachable` is
  // preFinalizeCount, measured AFTER the JS-side post-filters (applyTierFilter at either
  // tierPosition, and the prompts leg's cjkPrecisionOk gate). Rows those filters removed
  // therefore land entirely in `total - reachable` and get reported as a pool bound.
  //
  // Reproduced by R11 with 80 matching rows of which tier keeps 5: the surface read
  // "80 rows match but only the first 5 are pageable ... Raise the limit to widen the
  // pool". Both halves are false for those 75 — they are not behind the pool, and raising
  // the limit cannot reach them, because they fail the caller's OWN filter.
  //
  // Chosen exit is SILENCE, not a re-wording. The note makes exactly one claim and offers
  // exactly one remedy, and a JS-side filter invalidates both; on a freshly-landed honesty
  // surface a note that is sometimes absent beats one that is sometimes wrong. The cost is
  // named rather than hidden: with a tier filter active the D#5 disclosure goes quiet even
  // where a real pool bound coexists. Recovering that case needs a population the pool
  // bound actually governs, and `total - postFilterDropped` is not it — post-filter drops
  // are only counted for rows that reached the pool, so it is a floor, not the number.
  it('is silent when a JS-side filter, not the pool, produced the gap (D#20)', () => {
    expect(reachabilityNote({ total: 80, reachable: 5, offset: 0, postFilterDropped: 75 })).toBe('');
  });

  it('still fires on the same numbers when no post-filter ran (D#20 control)', () => {
    // The premise for the case above: without this, "silent" could equally mean the note
    // had stopped firing for some unrelated reason.
    const note = reachabilityNote({ total: 80, reachable: 5, offset: 0, postFilterDropped: 0 });
    expect(note).toContain('80 rows match');
    expect(note).toContain('only the first 5 are pageable');
    // And an absent field must behave like 0, or every caller that predates D#20 goes
    // permanently silent — the same failure mode the `reachable` guard above describes.
    expect(reachabilityNote({ total: 80, reachable: 5, offset: 0 })).toBe(note);
  });

  it('is silent even when a post-filter explains only PART of the gap', () => {
    // Not a threshold: once any row was removed downstream of the count, the note can no
    // longer say which of the two mechanisms the remaining gap belongs to.
    expect(reachabilityNote({ total: 80, reachable: 5, offset: 0, postFilterDropped: 10 })).toBe('');
    expect(reachabilityNote({ total: 80, reachable: 5, offset: 0, postFilterDropped: 1 })).toBe('');
  });

  it('ignores a non-numeric postFilterDropped rather than going silent on it', () => {
    // Fail OPEN here, unlike the total/reachable guards: a bad value in the new field must
    // not be able to suppress a disclosure that D#5 already earned.
    const note = reachabilityNote({ total: 80, reachable: 5, offset: 0, postFilterDropped: 0 });
    expect(reachabilityNote({ total: 80, reachable: 5, offset: 0, postFilterDropped: null })).toBe(note);
    expect(reachabilityNote({ total: 80, reachable: 5, offset: 0, postFilterDropped: NaN })).toBe(note);
  });

  it('BOTH faces hand the helper the post-filter count', () => {
    // Same twin-drift reasoning as the `reachable` guard above, and the same failure shape:
    // a face that forgets the field keeps the misattributing note forever, silently.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const face of ['server.mjs', 'mem-cli.mjs']) {
      const src = readFileSync(join(root, face), 'utf8');
      expect(src, `${face} must pass postFilterDropped from the pipeline result`).toMatch(
        /postFilterDropped:\s*(?:r|res)\.postFilterDropped/,
      );
    }
  });

  it('the pipeline actually REPORTS the drop — the unit cases above are not vacuous', async () => {
    // Without this, every D#20 case here passes while the pipeline hardcodes 0: the note
    // would go on misattributing in production and the suite would stay green. Drives the
    // shared orchestrator both faces run on, so it covers the real accumulation sites.
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    // 2 rows inside the 2h window -> 'working' (computeTier rule 4); 3 rows far outside
    // any ACTIVE_WINDOWS entry -> 'archive' (rule 6). A mixed set on purpose: if the tier
    // dropped EVERY row, reachable would be 0 and D#5's pre-existing guard would silence
    // the note for a different reason, which would not test this change at all.
    for (let i = 0; i < 2; i++) insertObs(db, { title: `zanzibar fresh ${i}`, text: 'zanzibar' });
    for (let i = 0; i < 3; i++)
      insertObs(db, {
        title: `zanzibar old ${i}`,
        text: 'zanzibar',
        epochOffset: -400 * 24 * 60 * 60 * 1000,
      });

    const run = (extra) =>
      coreRunSearchPipeline(
        { db, currentProject: 'test', env: {}, searchObservationsHybrid, reRankWithContext: () => {} },
        {
          query: 'zanzibar',
          ftsQuery: 'zanzibar',
          deepMode: 'off',
          limit: 20,
          offset: 0,
          project: null,
          obsType: null,
          rerankPolicy: 'mcp',
          ...extra,
        },
      );

    // Premise first: all five are findable when nothing filters them.
    const unfiltered = await run({});
    expect(unfiltered.preFinalizeCount).toBe(5);
    expect(unfiltered.postFilterDropped).toBe(0);

    // BOTH tier positions, because they are two separate call sites: 'early' is the CLI's
    // (obs-only, before re-rank) and 'late' is the MCP's (after re-rank, merged set).
    // Instrumenting one and testing one is how a parallel path ships half-done here.
    for (const tierPosition of ['early', 'late']) {
      const filtered = await run({ tier: 'working', tierPosition, tierProject: 'test' });
      expect(filtered.preFinalizeCount, `${tierPosition}: keeps the two working rows`).toBe(2);
      expect(filtered.postFilterDropped, `${tierPosition}: reports the three archive rows`).toBe(3);

      // And the surface that consumes it goes quiet on exactly this input, where before
      // D#20 it would have claimed the three archive rows were behind the pool.
      expect(
        reachabilityNote({
          total: 5,
          reachable: filtered.preFinalizeCount,
          offset: 0,
          postFilterDropped: filtered.postFilterDropped,
        }),
      ).toBe('');
    }
    db.close();
  });

  it('the prompts leg reports its CJK precision drops too (D#20, third site)', async () => {
    // The other half of the same misattribution, and the half a tier-only test cannot
    // reach: countSearchTotal does not model cjkPrecisionOk either. `query` and `ftsQuery`
    // are separate parameters, which is what makes this shape constructible — FTS matches
    // on the ASCII token both rows share, and the CJK gate then rejects the row that
    // carries none of the query's keywords.
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertPrompt(db, { text: 'deploy 数据库迁移 finished' });
    insertPrompt(db, { text: 'deploy something unrelated' });

    const stats = { postFilterDropped: 0 };
    const rows = searchPromptsFts(db, {
      query: '数据库迁移',
      ftsQuery: 'deploy',
      perSourceLimit: 60,
      perSourceOffset: 0,
      stats,
    });
    // Premise: the gate really did fire, rather than both rows surviving and the count
    // happening to read 0 for want of anything to drop.
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_text).toContain('数据库迁移');
    expect(stats.postFilterDropped).toBe(1);

    // Control: an ASCII query never reaches the gate (cjkPrecisionOk returns true for a
    // query without 2+ CJK chars), so nothing is dropped and nothing is reported.
    const asciiStats = { postFilterDropped: 0 };
    const all = searchPromptsFts(db, {
      query: 'deploy',
      ftsQuery: 'deploy',
      perSourceLimit: 60,
      perSourceOffset: 0,
      stats: asciiStats,
    });
    expect(all).toHaveLength(2);
    expect(asciiStats.postFilterDropped).toBe(0);
    db.close();
  });

  it('the two faces read `reachable` from the SAME source', () => {
    // E#474's shape: a shared helper invoked from two entry points with subtly different
    // argument shapes. `preFinalizeCount` is the pre-slice candidate count and the only
    // correct value here — perSourceLimit is PER SOURCE, so a face that re-derived
    // max(limit*3, 60) would understate the reach of every cross-source query.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const face of ['server.mjs', 'mem-cli.mjs']) {
      const src = readFileSync(join(root, face), 'utf8');
      expect(src, `${face} must pass preFinalizeCount as reachable`).toMatch(
        /reachable:\s*(?:r|res)\.preFinalizeCount/,
      );
    }
  });
});
