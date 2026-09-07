// tests/vector-arm-removed.test.mjs — the TF-IDF vector arm is GONE (Phase-2).
//
// Phase-1 (v3.17.0, 2026-06-27) gated the arm off and kept the tables + code
// "pending Phase-2 removal". Phase-2 is this. The measurements that decided it are
// stamped in tasks/specs/vector-arm-removal.md; the short version is that the arm is
// net-NEGATIVE on both fixtures, including the vocabulary-mismatch suite that is the
// only reason a vector arm would exist (R@10 0.3407 -> 0.3018, P95 +108.6%).
//
// These cases are written to fail on the pre-removal tree. Each states which mechanism
// it drives, because a removal guard that only greps source text goes vacuously green
// the moment someone re-adds the feature under a different name.
//
// WHY THERE IS NO BEHAVIOURAL "the env var changes nothing" CASE HERE. One was written
// and DELETED rather than counted: at unit scale the arm cannot be made to engage
// through the shipped save path, so any pass would be vacuous. Measured while building
// it, on this tree — 12 saves of deliberately distinct rows with CLAUDE_MEM_VECTORS=1
// land 12 observations but **N = 1** for buildVocabulary, because the three-tier dedup
// in saveObservation marks the other 11 superseded and liveObsFilterSql('') hides them;
// with one live document every term has df = 1, the `freq >= 2` filter empties the
// candidate set, and the vocabulary comes back with 0 terms (version d41d8cd98f00 =
// md5 of the empty string). 0 vectors written, both through saves and through an
// explicit rebuildVocabulary. (First reading of this was blamed on _vocabCache
// poisoning; that was wrong — the explicit rebuild is empty too. Recorded as measured,
// not as the mechanism first guessed.)
//
// The behavioural evidence lives at fixture scale instead, in the benchmark A/B stamped
// in tasks/specs/vector-arm-removal.md, and is re-checked after this removal by
// success-criterion #1: `node benchmark/benchmark.mjs --production-hybrid` must still
// read 0.8998 / 0.8497 / 0.9712 / 0.9611, to the digit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { createTestDb } from './test-helpers.mjs';

// Repo source is read as TEXT here, so this must use dirname(fileURLToPath(...)) + join
// and NOT new URL('../x.mjs', import.meta.url) — the URL form drops the named module out
// of knip's report entirely (tests/no-url-module-paths.test.mjs guards the rule).
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// The env var, the CLI op and the two tables are all PUBLISHED surfaces, so their names
// are the contract being removed.
const REMOVED_ENV = 'CLAUDE_MEM_VECTORS';
const REMOVED_OP = 'rebuild_vectors';
const REMOVED_TABLES = ['observation_vectors', 'vocab_state'];
const REMOVED_SYMBOLS = [
  'vectorsEnabled',
  'buildVocabulary',
  'rebuildVocabulary',
  'getVocabulary',
  'computeVector',
  'cosineSimilarity',
  'vectorSearch',
  'rrfMerge',
  'vecTextForRow',
  'buildVecText',
  'upsertObservationVector',
  'insertObservationVector',
  '_resetVocabCache',
  'VOCAB_DIM',
  'MIN_COSINE_SIMILARITY',
  'VECTOR_SCAN_LIMIT',
];

// Shipped code only. tests/ is excluded because a guard naming what it removed is not a
// leak; benchmark/ is excluded for the same reason its own removal is a separate concern.
function shippedSourceFiles() {
  const out = [];
  const skipDirs = new Set([
    'node_modules',
    '.git',
    'tests',
    'benchmark',
    'coverage',
    'docs',
    'tasks',
    'experiment',
    '.github',
  ]);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (skipDirs.has(name)) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.mjs') || name.endsWith('.js')) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

// Source with comments removed. A comment naming what was deleted is history; a live
// reference is code. Note this strips to build the SEARCH WINDOW, not just to skip matched
// lines — filtering only the matched line lets a deleted gate hide behind a surviving
// comment, a shape that has walked past a guard in this repo before.
function strippedCode(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('Phase-2: the TF-IDF vector arm is removed', () => {
  const prev = process.env[REMOVED_ENV];
  beforeEach(() => {
    delete process.env[REMOVED_ENV];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[REMOVED_ENV];
    else process.env[REMOVED_ENV] = prev;
  });

  it('initSchema creates neither vector table', () => {
    const db = createTestDb();
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => r.name);
    // Premise: the probe can see tables at all, so an empty result is a real answer and
    // not a broken query.
    expect(names).toContain('observations');
    for (const t of REMOVED_TABLES) expect(names).not.toContain(t);
    db.close();
  });

  it('no shipped module reads the CLAUDE_MEM_VECTORS env var', () => {
    // Stripped code, not raw text, for the same reason the symbol sweep below strips: a
    // comment that NAMES the removed env var is history. Forbidding the name outright made
    // this guard forbid documenting its own removal, which it did on the first run. The
    // check keeps all its teeth, because a live read is `process.env.CLAUDE_MEM_VECTORS`
    // in code and survives comment-stripping untouched.
    const offenders = shippedSourceFiles().filter((f) => strippedCode(f).includes(REMOVED_ENV));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('no shipped surface still advertises the rebuild_vectors op', () => {
    // Added AFTER this guard let five live homes through. The symbol sweep below matches
    // identifiers, and `rebuild_vectors` is a STRING — it survived in the mem_maintain Zod
    // enum, two tool descriptions, two CLI usage lines, the adoption doc written into every
    // adopted project, and the README. The op-registry case above did not see them either,
    // because it reads ALL_MAINTAIN_OPS and those are separate copies of the same list.
    // Markdown is in scope here precisely because the README and the adoption doc are how
    // a user and an agent learn the op exists.
    const files = [...shippedSourceFiles(), join(ROOT, 'README.md'), join(ROOT, 'adopt-content.mjs')];
    const hits = [...new Set(files.filter((f) => readFileSync(f, 'utf8').includes(REMOVED_OP)))];
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('no shipped module defines or calls the removed vector symbols', () => {
    const hits = [];
    for (const f of shippedSourceFiles()) {
      const code = strippedCode(f);
      for (const sym of REMOVED_SYMBOLS) {
        if (new RegExp(`\\b${sym}\\b`).test(code)) hits.push(`${relative(ROOT, f)}:${sym}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the rebuild_vectors maintain op is gone from the op registry', async () => {
    const { ALL_MAINTAIN_OPS } = await import('../lib/maintain-core.mjs');
    // Premise: the registry is non-empty, so "does not contain" is a real answer.
    expect(ALL_MAINTAIN_OPS.length).toBeGreaterThan(0);
    expect(ALL_MAINTAIN_OPS).not.toContain(REMOVED_OP);
  });
});
