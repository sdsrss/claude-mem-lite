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
import { coreRunSearchPipeline, buildSearchFtsQuery } from '../lib/search-core.mjs';
import { saveEvent } from '../lib/activity.mjs';

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

// Pre-tag review 6.33.0 (defects F2): the tier sat inside the observation leg, so it fired
// whenever observations alone found nothing, even when another leg found the query's words as
// written; its stem-prefix rows then joined that result and ranked above the exact match.
describe('the word-form tier in a cross-source search', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'test' });
    insertObs(db, { title: 'Parser crash on startup', narrative: 'crash in the parser', importance: 2 });
    insertObs(db, { title: 'Crash report notes', narrative: 'a crash we saw', importance: 2 });
  });
  afterEach(() => db.close());
  const run = async (query) => {
    const res = await coreRunSearchPipeline(
      {
        db,
        currentProject: 'test',
        env: {},
        searchObservationsHybrid,
        deepSearch: async () => ({ rows: [] }),
        shouldEscalateToDeep: () => false,
        autoDeepLlmReady: () => false,
        reRankWithContext: async (rows) => rows,
        llm: null,
      },
      {
        query,
        ftsQuery: buildSearchFtsQuery(query),
        effectiveSource: null,
        deepMode: 'normal',
        limit: 10,
        offset: 0,
        rerankPolicy: 'cli',
        rerankProject: 'test',
        tolerateMissingFts: true,
        tierPosition: 'early',
      },
    );
    return res.page.map((r) => `${r.source}:${r.title}`);
  };

  it('fills a search no leg answered', async () => {
    expect((await run('crashes')).sort()).toEqual(['obs:Crash report notes', 'obs:Parser crash on startup']);
  });

  it('keeps the rows of a deep escalation beside another leg', async () => {
    saveEvent(db, {
      project: 'test',
      event_type: 'bugfix',
      title: 'Worker crashes on reload',
      body: 'crashes',
    });
    const res = await coreRunSearchPipeline(
      {
        db,
        currentProject: 'test',
        env: {},
        searchObservationsHybrid,
        deepSearch: async () => ({
          results: [{ id: 99, source: 'obs', title: 'Deep row', score: 1 }],
          variants: [],
          reranked: false,
        }),
        shouldEscalateToDeep: () => true,
        autoDeepLlmReady: () => true,
        reRankWithContext: async (rows) => rows,
        llm: null,
      },
      {
        query: 'crashes',
        ftsQuery: buildSearchFtsQuery('crashes'),
        effectiveSource: null,
        deepMode: 'auto',
        limit: 10,
        offset: 0,
        rerankPolicy: 'cli',
        rerankProject: 'test',
        tolerateMissingFts: true,
        tierPosition: 'early',
      },
    );
    const got = res.page.map((r) => `${r.source}:${r.title}`);
    expect(got).toContain('obs:Deep row');
    expect(got).toContain('event:Worker crashes on reload');
  });

  it('adds nothing when another leg found the words as written', async () => {
    saveEvent(db, {
      project: 'test',
      event_type: 'bugfix',
      title: 'Worker crashes on reload',
      body: 'crashes',
    });
    expect(await run('crashes')).toEqual(['event:Worker crashes on reload']);
  });
});
