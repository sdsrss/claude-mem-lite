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
import { reachabilityNote } from '../lib/search-core.mjs';

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
