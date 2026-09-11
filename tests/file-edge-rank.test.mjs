// rankFileCandidates — the ordering `searchByFile` applies before it caps (R12 B-4).
//
// The behavioural half of this fix lives in tests/user-prompt-search.test.mjs,
// which drives the real hook as a subprocess and proves the ranker is WIRED.
// These cases pin the contract that docblock claims, because an unasserted
// claim in a comment is just a claim: it SORTS and never DROPS, so a wrong
// score costs a candidate its position and nothing else.
import { describe, it, expect } from 'vitest';
import { rankFileCandidates } from '../lib/file-edge-match.mjs';

const sorted = (a) => [...a].sort();

describe('rankFileCandidates — sorts and de-duplicates; never drops a non-empty candidate', () => {
  it('returns a permutation of its deduped input', () => {
    const input = ['v4.0.1', 'lib/install-shape.mjs', 'JSON.stringify', 'CHANGELOG.md', '39.602Z'];
    expect(sorted(rankFileCandidates(input))).toEqual(sorted(input));
  });

  it('demotes an unusually long extension rather than discarding it', () => {
    // '.properties' is a real extension and scores badly on the length term.
    // Demoted is the contract; dropped would be a recall regression of its own.
    const out = rankFileCandidates(['app.properties']);
    expect(out).toEqual(['app.properties']);
  });

  it('tolerates empty, nullish and non-string members', () => {
    expect(rankFileCandidates([])).toEqual([]);
    expect(rankFileCandidates(undefined)).toEqual([]);
    expect(rankFileCandidates(null)).toEqual([]);
    // Empty-string members ARE dropped, which is why the heading says non-empty.
    expect(rankFileCandidates(['', 'a.mjs', null, undefined])).toEqual(['a.mjs']);
  });

  it('returns empty for a non-array rather than iterating it by character', () => {
    // `for (const c of 'a.mjs')` yields five candidates; failing closed is the
    // documented behaviour for the exported surface.
    expect(rankFileCandidates('a.mjs')).toEqual([]);
    expect(rankFileCandidates(7)).toEqual([]);
  });
});

describe('rankFileCandidates — ordering', () => {
  it('puts a path ahead of a bare filename ahead of a version token', () => {
    expect(rankFileCandidates(['v4.0.1', 'install.mjs', 'lib/install-shape.mjs'])).toEqual([
      'lib/install-shape.mjs',
      'install.mjs',
      'v4.0.1',
    ]);
  });

  it('ranks the three shapes extractFiles actually emits below real files', () => {
    // Version number, timestamp fragment and member expression — the noise
    // classes measured on the live corpus, each by a different score term.
    // The FULL order is asserted: an earlier cut checked only out[0] plus a
    // length, which the permutation case above already implies, so the per-term
    // scoring the docblock argues for was unguarded.
    expect(rankFileCandidates(['v4.0.1', '39.602Z', 'JSON.stringify', 'schema.mjs'])).toEqual([
      'schema.mjs', // 3: letter-initial ext, short
      'JSON.stringify', // 2: letter-initial ext, too long
      'v4.0.1', // 1: digit-initial ext, short — text order breaks the tie
      '39.602Z', // 1: digit-initial ext, short
    ]);
  });

  it('ranks a dotfile above a version number', () => {
    // `.env`'s only dot is the leading one. Treating that as "no extension"
    // scored every dotfile 0 — below `v4.0.1` — so six version tokens evicted
    // a file the pre-ranking text-order code reached. Found in pre-ship review.
    expect(rankFileCandidates(['v4.0.1', 'src/.env'])[0]).toBe('src/.env');
    expect(rankFileCandidates(['1.0.1', '.gitignore'])[0]).toBe('.gitignore');
  });

  it('gives no separator bonus to a token whose only separator is trailing', () => {
    // basenameAnySep strips trailing separators, so comparing token to basename
    // said "has a path" for `foo.mjs/`, which has no internal separator.
    expect(rankFileCandidates(['src/real.mjs', 'foo.mjs/'])[0]).toBe('src/real.mjs');
  });

  it('keeps text order inside one tier', () => {
    const tie = ['b.mjs', 'a.mjs', 'c.mjs'];
    expect(rankFileCandidates(tie)).toEqual(tie);
  });
});

describe('rankFileCandidates — dedup', () => {
  it('drops exact repeats and keeps the first spelling', () => {
    expect(rankFileCandidates(['a.mjs', 'a.mjs', 'b.mjs'])).toEqual(['a.mjs', 'b.mjs']);
  });

  it('dedups case-insensitively, matching the NOCASE arms of fileMatchClause', () => {
    // All four arms are ASCII-case-insensitive, so 'Utils.mjs' and 'utils.mjs'
    // probe identical rows — the second only burns a slot in the cap.
    expect(rankFileCandidates(['Utils.mjs', 'utils.mjs'])).toEqual(['Utils.mjs']);
  });

  it('folds ASCII only, because that is the alphabet SQLite folds', () => {
    // JS toLowerCase() is Unicode-wide; COLLATE NOCASE and LIKE are not. Folding
    // the wider alphabet collapsed two spellings that SQLite returns as DISTINCT
    // rows, which is a drop, not a dedup. Found in pre-ship review.
    expect(rankFileCandidates(['Ä.mjs', 'ä.mjs'])).toHaveLength(2);
    expect(rankFileCandidates(['İstanbul.mjs', 'i̇stanbul.mjs'])).toHaveLength(2);
  });

  it('does NOT dedup two paths that merely share a basename', () => {
    // Arm 1 matches the full path, so these are different probes.
    const both = ['src/a/mod.rs', 'src/b/mod.rs'];
    expect(rankFileCandidates(both)).toEqual(both);
  });
});
