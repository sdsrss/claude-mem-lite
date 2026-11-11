// converge R29 (BACKLOG P1, open since 2026-09-14): the FTS index is unicode61 with no
// stemming, so `crash` found nothing where a memory said `crashes`, nor `input` where it said
// `inputs`. A Porter tokenizer on the index was measured net-negative (findings.md § Levers
// measured and rejected). This is the query-side fallback instead: when the strict AND and its
// OR relaxation both return nothing, search once more by the Porter stem of each word as an FTS5
// prefix. It can only add rows to a search that had none.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { sanitizeFtsQuery, wordFormPrefixQuery } from '../nlp.mjs';
import { searchObservationsHybrid } from '../search-engine.mjs';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';

// Exact production tokenizer config (schema.mjs observations_fts).
const TOKENIZE = "unicode61 remove_diacritics 2 tokenchars '_-'";

describe('wordFormPrefixQuery', () => {
  it('turns each word into the prefix of its stem', () => {
    expect(wordFormPrefixQuery(sanitizeFtsQuery('crashes'))).toBe('crash*');
    expect(wordFormPrefixQuery(sanitizeFtsQuery('inputs'))).toBe('input*');
  });
  it('adds the y spelling where Porter turns a final y into i (deploy -> deploi)', () => {
    expect(wordFormPrefixQuery(sanitizeFtsQuery('deployed'))).toBe('deploi* OR deploy*');
  });
  it('reads the words out of AND / OR groups and quoted terms, and joins them with OR', () => {
    const q = wordFormPrefixQuery('(crash OR failure) AND "tokens"');
    expect(q.split(' OR ').sort()).toEqual(['crash*', 'failur*', 'token*']);
  });
  it('skips stems shorter than four letters, digits, and non-Latin words', () => {
    expect(wordFormPrefixQuery(sanitizeFtsQuery('running'))).toBeNull(); // stem "run"
    expect(wordFormPrefixQuery('v8 http2')).toBeNull();
    expect(wordFormPrefixQuery('数据库 迁移')).toBeNull(); // (sanitized, CJK gains English synonyms, which do count)
    expect(wordFormPrefixQuery(null)).toBeNull();
  });
});

describe('the prefix query against the production tokenizer', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(content, tokenize="${TOKENIZE}")`);
    db.prepare('INSERT INTO t(content) VALUES (?)').run('The parser crashes on empty inputs after we deploy');
  });
  afterEach(() => db.close());
  const hits = (q) => db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(q).c;

  it('finds the inflected forms the plain query misses', () => {
    for (const word of ['crash', 'input', 'deployed']) {
      expect(hits(sanitizeFtsQuery(word)), `premise: "${word}" alone misses`).toBe(0);
      expect(hits(wordFormPrefixQuery(sanitizeFtsQuery(word))), word).toBe(1);
    }
  });
});

describe('searchObservationsHybrid — the word-form tier', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, {
      title: 'Parser crashes on empty inputs',
      narrative: 'The parser crashes when the config file is missing.',
      importance: 2,
    });
    insertObs(db, {
      title: 'Parsing pipeline notes',
      narrative: 'How the parsing stage is wired.',
      importance: 2,
    });
  });
  afterEach(() => db.close());
  const search = (query) =>
    searchObservationsHybrid(db, {
      ftsQuery: sanitizeFtsQuery(query),
      args: {},
      epochFrom: null,
      epochTo: null,
      perSourceLimit: 20,
      perSourceOffset: 0,
      currentProject: 'test',
      limit: 10,
    }).map((r) => r.title);

  it('a word whose only forms in the store are inflected finds them', () => {
    expect(search('crash')).toEqual(['Parser crashes on empty inputs']);
    expect(search('input')).toEqual(['Parser crashes on empty inputs']);
  });
  it('does not run when the query already matched: no stem-mates are added', () => {
    // "parser" matches row 1 exactly; "parsing" (stem pars) must not ride in on a prefix.
    expect(search('parser')).toEqual(['Parser crashes on empty inputs']);
  });
  it('a word with no form in the store still finds nothing', () => {
    expect(search('kubernetes')).toEqual([]);
  });
});
