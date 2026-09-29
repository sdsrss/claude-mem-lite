// The README must not claim the FTS index stems, because it does not.
//
// `observations_fts` is created with no `tokenize=` clause, so FTS5 uses `unicode61`: a
// query term matches the word forms actually stored. README.md carried the opposite — "PRF
// terms are now stemmed with the same Porter algorithm used by FTS5, ensuring PRF expansion
// terms match the search index" — which inverts both halves. FTS5 here does not stem, and
// `extractPRFTerms` deliberately emits SURFACE forms *because* it does not; emitting a stem
// would match nothing.
//
// That claim had already been retracted once, in `tfidf.mjs`'s own docblock ("the 'porter
// tokenizer' claim the old docblock made here is NOT true"), and the README copy survived
// the retraction — the recurring failure this repo keeps paying for. So the guard is
// two-sided rather than a spelling check: it asserts the tokenizer's real behaviour against
// a live schema, and asserts the prose does not contradict it. Adding a porter tokenizer
// later is a legitimate change — it just has to take the README with it, which is the point.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb, insertSession } from './test-helpers.mjs';

// D#207: join() rather than new URL('../README.md', import.meta.url).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every file this package SHIPS, repo-relative. `package.json#files` is the manifest npm
 * actually packs, so it carries the bash hooks and the markdown that `walkShipped`'s
 * ".mjs/.js" walk cannot see. Directory entries are expanded; README* and LICENSE are added
 * because npm packs those whatever `files` says (measured on v6.1.0: README.zh-CN.md is in
 * the tarball and is not in `files`).
 */
/**
 * Word-bounded on purpose: a bare /porter/i also matches **re**porter**, and the very line
 * this guard was widened to fix carries `vitest --reporter=verbose` two clauses after the
 * claim. The unbounded version reported that line as an offender after it had been
 * corrected — a warning fired at correct usage, which is worse than the silence it replaces
 * and is the same defect two other guards in this branch shipped.
 */
const PORTER = /\bporter\b/i;

function shippedPopulation() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const out = new Set();
  const add = (rel) => {
    const full = join(ROOT, rel);
    let st;
    try {
      st = statSync(full);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const n of readdirSync(full)) add(`${rel}/${n}`);
    else out.add(rel);
  };
  for (const f of pkg.files || []) add(f);
  for (const n of readdirSync(ROOT)) if (/^(README|LICENSE|llms)/i.test(n)) add(n);
  return [...out];
}

describe('FTS tokenizer: behaviour and the README agree', () => {
  it('the observations index does not stem — a stem matches nothing, the surface form matches', () => {
    const db = createTestDb();
    insertSession(db, { id: 's', project: 'p' });
    const now = Date.now();
    db.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, text, narrative, importance, created_at, created_at_epoch)
       VALUES ('s', 'p', 'bugfix', 'caching layer crashes on empty input', 'caching layer crashes on empty input', '', 2, ?, ?)`,
    ).run(new Date(now).toISOString(), now);
    // `observations_fts` is external-content (`content='observations'`), so a row in the base
    // table is not in the index until a writer puts it there. Use the product's own populate
    // command — the one schema.mjs and `fts-check rebuild` issue — so what is indexed here is
    // what the product would index, rather than a hand-built row that could disagree.
    db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");

    const match = (q) =>
      db.prepare('SELECT COUNT(*) c FROM observations_fts WHERE observations_fts MATCH ?').get(q).c;

    // Premise: the row is indexed at all. Without this, every zero below reads as "unstemmed"
    // when it might just be "not in the index".
    expect(match('caching')).toBe(1);

    // The property itself, stated in both directions so it cannot pass vacuously.
    expect(match('cach')).toBe(0); // bare porter stem
    expect(match('crash')).toBe(0); // singular of a stored plural
    expect(match('crashes')).toBe(1);

    // And it is the DEFAULT tokenizer that produces this, not an explicit choice — the
    // sentence a future porter migration would have to change.
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'observations_fts'").get().sql;
    expect(sql).not.toMatch(/tokenize/i);
    db.close();
  });

  it('nothing SHIPPED ties Porter to FTS5', () => {
    // POPULATION, and this is the half the first version got wrong. It read `README.md` and
    // nothing else, in a commit whose own message called this "the recurring failure this
    // repo keeps paying for" — so a re-tie anywhere but that one file was invisible to the
    // guard written to prevent exactly it. The pre-ship review's own sweep then found one:
    // `hook-llm.mjs`, a shipped LLM PROMPT TEMPLATE, which is the worst surface for it
    // because the reader is a model rather than a person.
    //
    // The population is now `package.json#files` — the real shipped set, which includes the
    // four bash hooks and the markdown, and is therefore wider than `walkShipped`'s
    // ".mjs/.js" (the blind spot that hid two setup.sh defects for twelve audit rounds).
    // Plus the files npm packs regardless of `files`: README* and LICENSE.
    const files = shippedPopulation();

    // Premise before criteria. An empty population agrees with every claim.
    expect(files.length, 'the shipped population came back empty').toBeGreaterThan(100);
    expect(files, 'the prose the README half of this guard exists for').toContain('README.md');
    expect(files, 'the prompt templates').toContain('hook-llm.mjs');

    const offenders = [];
    for (const rel of files) {
      let text;
      try {
        text = readFileSync(join(ROOT, rel), 'utf8');
      } catch {
        continue; // generated at pack time (npm-shrinkwrap.json) or otherwise absent
      }
      for (const [i, line] of text.split('\n').entries()) {
        if (!PORTER.test(line) || !/fts\s?-?5?\b/i.test(line)) continue;
        // The corrected forms, which SAY the index does not stem. Those are the sentences
        // this guard wants to survive, not the ones it hunts.
        if (/not stemmed|does not stem|no stemming|NOT true|unicode61/i.test(line)) continue;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }

    expect(
      offenders,
      'shipped lines tying Porter to FTS5. The index is unicode61 and does not stem; a line ' +
        'saying otherwise is false wherever it ships, and in a prompt template a model reads ' +
        `it as fact:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('can still say NO, and does not fire on "reporter"', () => {
    // Both directions, because a sweep that cannot discriminate passes by describing nothing.
    const offend = (line) => PORTER.test(line) && /fts\s?-?5?\b/i.test(line);
    expect(offend('PRF terms are stemmed with the same Porter algorithm used by FTS5')).toBe(true);
    expect(offend('"FTS5 doesn\'t split CJK", "vitest --reporter=verbose hangs"')).toBe(false);
    expect(offend('the FTS5 index is unicode61 and porter is not enabled')).toBe(true); // the
    // exclusion list, not the match, is what lets that last one through — asserted here so a
    // change to either half is visible.
  });

  it('the README half still has its own subject', () => {
    // Guard the guard: the sweep above is only meaningful if README.md is still the file
    // carrying the search-quality prose the original claim lived in.
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toMatch(/Pseudo-relevance feedback/i);
  });
});
