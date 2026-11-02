import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { scrubRecord } from '../lib/scrub-record.mjs';
import { scrubSecrets, SECRET_PATTERNS } from '../secret-scrub.mjs';
import { stripPrivate } from '../lib/private-strip.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { saveEvent } from '../lib/activity.mjs';
import { insertDeferred } from '../lib/deferred-work.mjs';
import { recallByFile } from '../lib/recall-core.mjs';
import { scrubFilePath } from '../lib/scrub-record.mjs';
import { basenameAnySep, fileMatchClause, fileMatchParams } from '../lib/file-edge-match.mjs';

const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POISONED = `error from upstream: token=${SECRET} not found`;

// D#44 fixtures. The two SHAPES are not interchangeable and the pair is the point:
//   DIR_PATH  — credential in a directory segment; scrubbing leaves the basename
//               alone, so the LIKE arms of fileMatchParams still match either way.
//               A test using only this shape passes with the reader left unscrubbed.
//   BASE_PATH — credential in the BASENAME; scrubbing rewrites the very token
//               arms 2-4 bind. This is the only shape that can see a writer/reader
//               asymmetry, which is why the recall case below uses it.
const DIR_PATH = `/tmp/${SECRET}/alpha.mjs`;
const BASE_PATH = `/repo/ghp_${'a'.repeat(36)}.mjs`;

describe('scrubSecrets — category gaps closed (audit MED-6)', () => {
  it('scrubs non-AKIA AWS access-key prefixes (ASIA/AROA/AIDA)', () => {
    expect(scrubSecrets('ASIAY34FZKBOKMUTVV7A')).toBe('***');
    expect(scrubSecrets('AROAEXAMPLE123456789')).toBe('***');
    expect(scrubSecrets('AIDAEXAMPLE123456789')).toBe('***');
    // AKIA still works (no regression)
    expect(scrubSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('***');
  });

  it('scrubs PGP and ENCRYPTED private key blocks', () => {
    const pgp =
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF...secret...\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(scrubSecrets(pgp)).not.toContain('lQOYBF');
    const enc =
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFDjBA...secret...\n-----END ENCRYPTED PRIVATE KEY-----';
    expect(scrubSecrets(enc)).not.toContain('MIIFDjBA');
    // RSA still works (no regression)
    const rsa = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB...\n-----END RSA PRIVATE KEY-----';
    expect(scrubSecrets(rsa)).not.toContain('MIIEpAIB');
  });

  it('scrubs prefixed/suffixed JSON secret keys (x_api_key, aws_secret_access_key)', () => {
    expect(scrubSecrets('{"x_api_key": "abcdef123456ghijkl"}')).not.toContain('abcdef123456');
    expect(scrubSecrets('{"aws_secret_access_key": "wJalrXUtnFEMI1234567890"}')).not.toContain(
      'wJalrXUtnFEMI',
    );
    expect(scrubSecrets('{"my_password": "hunter2hunter2"}')).not.toContain('hunter2hunter2');
  });

  it('scrubs ftp basic-auth credentials in URLs', () => {
    expect(scrubSecrets('ftp://deploy:s3cr3tpass@files.internal/app')).not.toContain('s3cr3tpass');
    // https still works (no regression)
    expect(scrubSecrets('https://u:p4ssw0rd@host/x')).not.toContain('p4ssw0rd');
  });
});

describe('scrubRecord — events table fields (HIGH-2)', () => {
  it('scrubs title and body', () => {
    const out = scrubRecord('events', { title: `bug: ${SECRET}`, body: POISONED });
    expect(out.title).not.toContain(SECRET);
    expect(out.body).not.toContain(SECRET);
  });
  it('leaves event_type/project identifiers untouched', () => {
    const out = scrubRecord('events', { event_type: 'bugfix', project: 'mem', title: 'x', body: null });
    expect(out.event_type).toBe('bugfix');
    expect(out.project).toBe('mem');
  });
});

describe('scrubRecord — observation table fields', () => {
  it('scrubs every text field listed in OBSERVATION_TEXT_FIELDS', () => {
    const row = {
      title: `failed: ${SECRET}`,
      narrative: POISONED,
      text: POISONED,
      subtitle: SECRET,
      concepts: POISONED,
      facts: POISONED,
      lesson_learned: POISONED,
      search_aliases: SECRET,
    };
    const out = scrubRecord('observations', row);
    for (const field of Object.keys(row)) {
      expect(out[field], `${field} not scrubbed`).not.toContain(SECRET);
    }
  });

  it('leaves non-text fields (numeric/json) untouched', () => {
    const row = { importance: 2, files_modified: '["src/a.mjs"]' };
    const out = scrubRecord('observations', row);
    expect(out.importance).toBe(2);
    expect(out.files_modified).toBe('["src/a.mjs"]');
  });

  it('scrubs all string fields when table is unknown (failsafe)', () => {
    const row = {
      foo: `leaked: ${SECRET}`,
      bar: POISONED,
      baz: 42,
      qux: null,
    };
    const out = scrubRecord('some_future_table', row);
    expect(out.foo).not.toContain(SECRET);
    expect(out.bar).not.toContain(SECRET);
    expect(out.baz).toBe(42);
    expect(out.qux).toBeNull();
  });
});

describe('scrubRecord — session_summaries fields', () => {
  it('scrubs request/investigated/learned/completed/next_steps/remaining_items/notes', () => {
    const row = {
      request: POISONED,
      investigated: POISONED,
      learned: POISONED,
      completed: POISONED,
      next_steps: POISONED,
      remaining_items: POISONED,
      notes: POISONED,
    };
    const out = scrubRecord('session_summaries', row);
    for (const field of Object.keys(row)) {
      expect(out[field]).not.toContain(SECRET);
    }
  });
});

describe('scrubRecord — session_handoffs fields', () => {
  it('scrubs working_on/completed/unfinished/key_decisions', () => {
    const row = {
      working_on: POISONED,
      completed: POISONED,
      unfinished: POISONED,
      key_decisions: POISONED,
    };
    const out = scrubRecord('session_handoffs', row);
    for (const field of Object.keys(row)) {
      expect(out[field]).not.toContain(SECRET);
    }
  });

  it('does NOT scrub JSON-stringified array fields (key_files, match_keywords)', () => {
    // String-level scrub of a JSON.stringify(array) can rewrite quoted values
    // and break downstream JSON.parse. Element-level scrub belongs upstream
    // of the JSON.stringify call. This test guards the contract.
    const keyFilesJson = JSON.stringify([`src/foo-${SECRET}.mjs`, 'src/normal.mjs']);
    const matchKeywordsJson = JSON.stringify([SECRET, 'normal']);
    const out = scrubRecord('session_handoffs', {
      key_files: keyFilesJson,
      match_keywords: matchKeywordsJson,
    });
    // scrubRecord must leave these untouched so JSON.parse still works.
    expect(out.key_files).toBe(keyFilesJson);
    expect(out.match_keywords).toBe(matchKeywordsJson);
    expect(() => JSON.parse(out.key_files)).not.toThrow();
    expect(() => JSON.parse(out.match_keywords)).not.toThrow();
  });
});

describe('scrubRecord — contract & edge cases', () => {
  it('returns null unchanged', () => {
    expect(scrubRecord('observations', null)).toBeNull();
  });

  it('returns non-object input unchanged', () => {
    expect(scrubRecord('observations', 'a string')).toBe('a string');
    expect(scrubRecord('observations', 42)).toBe(42);
    expect(scrubRecord('observations', undefined)).toBeUndefined();
  });

  it('does not mutate the input row (returns a copy)', () => {
    const row = { title: `failed: ${SECRET}` };
    const out = scrubRecord('observations', row);
    expect(out).not.toBe(row); // different object
    expect(row.title).toContain(SECRET); // input untouched
    expect(out.title).not.toContain(SECRET); // output scrubbed
  });

  it('failsafe path skips inherited (prototype-chain) properties', () => {
    const proto = { inherited: `proto leak: ${SECRET}` };
    const row = Object.create(proto);
    row.own = `own leak: ${SECRET}`;
    const out = scrubRecord('some_unknown_table', row);
    // Own property scrubbed:
    expect(out.own).not.toContain(SECRET);
    // Prototype property NOT in own enumerable keys, so the failsafe loop
    // skipped it — but it's still readable via prototype lookup. The
    // contract is "scrubs own string fields"; prototype keys are out of
    // scope (and copying them into the output would actually leak more).
    expect(Object.prototype.hasOwnProperty.call(out, 'inherited')).toBe(false);
  });
});

describe('end-to-end UPDATE leak check via in-memory DB', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('UPDATE on observations does not persist secrets via direct prepare', () => {
    db.prepare(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
                VALUES (?, ?, ?, ?, ?, 'active')`,
    ).run('s1', 's1', 'p1', new Date().toISOString(), Date.now());
    const ins = db
      .prepare(
        `INSERT INTO observations (memory_session_id, project, text, type, title, narrative, importance, created_at, created_at_epoch)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('s1', 'p1', 'clean', 'change', 'Clean title', '', 1, new Date().toISOString(), Date.now());
    const id = ins.lastInsertRowid;

    const safe = scrubRecord('observations', {
      title: `failed: ${SECRET}`,
      narrative: POISONED,
      concepts: POISONED,
      facts: POISONED,
    });
    db.prepare(`UPDATE observations SET title=?, narrative=?, concepts=?, facts=? WHERE id=?`).run(
      safe.title,
      safe.narrative,
      safe.concepts,
      safe.facts,
      id,
    );

    const row = db.prepare('SELECT * FROM observations WHERE id=?').get(id);
    for (const k of ['title', 'narrative', 'concepts', 'facts']) {
      expect(row[k], `${k} leaked via UPDATE`).not.toContain(SECRET);
    }
  });
});

describe('end-to-end leak check via in-memory DB', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('hook-llm INSERT path does not persist secrets', async () => {
    const hookLlm = await import('../hook-llm.mjs');
    // sdk_sessions row is required for FK on observations.memory_session_id
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `,
    ).run('s1', 's1', 'p1', new Date().toISOString(), Date.now());

    hookLlm.__insertObservationForTest(db, {
      session_id: 's1',
      project: 'p1',
      title: `failed: ${SECRET}`,
      narrative: POISONED,
      text: POISONED,
      subtitle: '',
      concepts: POISONED,
      facts: POISONED,
      files_read: '[]',
      files_modified: '[]',
      importance: 1,
      minhash_sig: '',
      lesson_learned: POISONED,
      search_aliases: '',
      branch: '',
    });
    const row = db.prepare('SELECT * FROM observations LIMIT 1').get();
    for (const k of ['title', 'narrative', 'text', 'concepts', 'facts', 'lesson_learned']) {
      expect(row[k], `${k} leaked`).not.toContain(SECRET);
    }
  });
});

// D#44: lib/scrub-record.mjs excludes JSON-array / path columns from
// TEXT_FIELDS_BY_TABLE on purpose (scrubbing a stringified array can rewrite
// quoted values and break JSON.parse) and prescribes the remedy in its header:
// "Pre-scrub each element upstream of the JSON.stringify call instead."
// buildAndSaveHandoff (session_handoffs.key_files) is the one call site that did.
// These four columns are the ones that did not, asserted through the
// SHIPPING writers rather than a test replica — __insertObservationForTest
// exists because an earlier leak test asserted on a hand-spelled copy of the
// write point and drifted from it.
//
// CORRECTION, and it reverses what the sentence above was taken to mean: key_files
// pre-scrubbed each ELEMENT, which is the letter of the prescription, using
// `scrubSecrets` — the whole-string function, on a column of filesystem paths. So the
// one call site held up as the compliant model was itself carrying the very defect the
// paragraph below describes, through v6.10.0. It is fixed at its own call site and
// pinned behaviourally in tests/handoff-key-files.test.mjs, which asserts the RENDERED
// `## Key Files` line rather than only the stored column. Do not read "followed the
// prescription" as "called the helper"; only the second is checkable, which is why
// the header now names `scrubFilePaths`.
// Pre-ship defect review of v6.8.2. Many SECRET_PATTERNS use a value class that does
// NOT exclude `/`. That round said "eight" and enumerated
// secret-scrub.mjs:33/74/78/83/98/109/259/260; v6.10.1's claims lens measured the figure an
// UNDER-count on every population it tried. The measured count and its population now live
// in lib/scrub-record.mjs and nowhere else, because five copies of a grid-dependent number
// is how it stayed wrong. Correct on prose; on a PATH the match eats the separator and everything
// after it, so `/repo/token=…/notes.mjs` was stored as `/repo/token=***` — the filename
// destroyed at write time, irreversibly, and two different files under one such directory
// collapsing to a single recall key.
describe('scrubFilePath — a credential in one segment cannot eat the rest of the path', () => {
  // The KV family, which is the one that truncates. The prefix-anchored family
  // (`key-<32hex>`, `npm_…`, `ghp_…`) never did, because its value class has no `/`.
  const KV_SHAPES = [
    '/repo/api_key=sk_live_AbCdEf0123456789AbCd/notes.mjs',
    '/repo/token=AbCdEf0123456789/notes.mjs',
    '/home/u/build/password=hunter2correct/out.js',
    'C:\\proj\\secret=AbCdEf0123456789\\out.js',
  ];

  it('keeps the basename when the credential is in a DIRECTORY segment', () => {
    for (const p of KV_SHAPES) {
      const out = scrubFilePath(p);
      expect(out, `${p} still carries its credential`).not.toMatch(/=(?:sk_live_|AbCdEf|hunter2)/);
      expect(basenameAnySep(out), `${p} lost its basename`).toBe(basenameAnySep(p));
    }
  });

  it('keeps the segment COUNT, so two files in one directory stay distinct', () => {
    const a = scrubFilePath('/repo/api_key=sk_live_AbCdEf0123456789AbCd/alpha.mjs');
    const b = scrubFilePath('/repo/api_key=sk_live_AbCdEf0123456789AbCd/beta.mjs');
    expect(a).not.toBe(b);
    expect(a.split('/').length).toBe(4);
  });

  it('still redacts a credential that IS the basename', () => {
    const out = scrubFilePath(`/repo/ghp_${'a'.repeat(36)}.mjs`);
    expect(out).toBe('/repo/***.mjs');
  });

  it('leaves an ordinary path byte-identical, on either separator', () => {
    expect(scrubFilePath('/repo/lib/file-edge-match.mjs')).toBe('/repo/lib/file-edge-match.mjs');
    expect(scrubFilePath('C:\\proj\\src\\hook-memory.mjs')).toBe('C:\\proj\\src\\hook-memory.mjs');
    expect(scrubFilePath('relative/path/x.mjs')).toBe('relative/path/x.mjs');
    expect(scrubFilePath('bare.mjs')).toBe('bare.mjs');
  });

  // The gap segment-wise scrubbing opened, and the reason the docblock gave for accepting it
  // ("these columns hold filesystem paths") is measured FALSE: save-observation filters
  // `params.files` on `typeof f === 'string'` alone, and bash-utils' extractFilePaths returns a
  // URL verbatim from a `{path}` / `{filePath}` tool input under a `PostToolUse: *` matcher. So a
  // URL reaches these columns, and its credential syntax is exactly the kind that spans `/`.
  // v6.10.0's whole-string scrub caught all four of these; v6.10.1 without this guard caught none.
  it('redacts a credential whose syntax SPANS the separator (URL shapes)', () => {
    // The webhook is ASSEMBLED, never written as one literal — the convention
    // tests/secret-scrub-r4.test.mjs:88-93 already established for this exact fixture.
    // A whole literal is well-formed enough that GitHub's push protection classifies it as a
    // live Slack webhook and rejects the push, which is what it did to the first draft of
    // this case. The scrubber sees the assembled runtime string either way.
    const webhookTail = 'X'.repeat(24);
    const URL_SHAPES = [
      'https://deploy:hunter2secret@internal.example.com/api/keys.json',
      'ftp://svc:S3cretValue1@files.example.com/drop/report.csv',
      'postgres://admin:pw123456@db.example.com/dump.sql',
      'https://hooks.slack.com/services/' + 'T00000000/B00000000/' + webhookTail + '/payload.json',
    ];
    for (const u of URL_SHAPES) {
      const out = scrubFilePath(u);
      expect(out, `${u} was stored verbatim`).not.toBe(u);
      expect(out).toContain('***');
    }
  });

  it('leaves a credential-free URL byte-identical', () => {
    // The guard must not fire on the scheme alone — scrubSecrets is what decides, and it is
    // identity here. Without this, "redact URLs" would corrupt every http(s)/s3/file path.
    for (const u of [
      'file:///home/ai/dev/app/server.mjs',
      'https://example.com/docs/readme.md',
      's3://bucket/key/data.json',
    ])
      expect(scrubFilePath(u), `${u} was rewritten`).toBe(u);
  });

  it('the URL guard does not weaken the segment-wise path case', () => {
    // The two rules must not fight: a plain filesystem path with a credential in a directory
    // segment keeps its basename, exactly as the first case in this describe pins.
    expect(scrubFilePath('/home/u/build/password=hunter2correct/out.js')).toBe(
      '/home/u/build/password=***/out.js',
    );
  });

  // NAMED COST of the guard, pinned so it is a decision and not a surprise: a URL-shaped value
  // whose credential sits in a path segment now goes whole-string, so the greedy value class eats
  // the filename — the very thing segment-wise scrubbing exists to prevent, traded back on this
  // one shape. Redacting the credential wins over preserving a filename that is not a recall key.
  it('named cost: a URL with a segment credential loses its filename', () => {
    expect(scrubFilePath('https://example.com/password=hunter2correct/file.mjs')).toBe(
      'https://example.com/password=***',
    );
  });

  // The other half of the pre-ship review's finding: the READER moved and the stored rows
  // did not, so a pre-6.8.2 raw row and a raw on-disk query could stop deriving the same
  // key. Segment-wise scrubbing is what keeps that to one shape instead of all of them.
  it('a pre-6.8.2 raw row is still reachable unless its BASENAME is the credential', () => {
    const db = createTestDb();
    const shapes = [
      ['dir-segment KV', '/repo/api_key=sk_live_AbCdEf0123456789AbCd/notes.mjs', true],
      ['dir-segment prefix', `/repo/ghp_${'a'.repeat(36)}/notes.mjs`, true],
      ['password= in a dir', '/home/u/build/password=hunter2correct/out.js', true],
      ['ordinary path', '/repo/lib/file-edge-match.mjs', true],
      ['basename credential', `/repo/ghp_${'a'.repeat(36)}.mjs`, false],
    ];
    // Stored RAW, exactly as every row written before this release is. FKs off: this case
    // is about the match predicate, so the junction rows need no parent observations.
    db.pragma('foreign_keys = OFF');
    const ins = db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)');
    shapes.forEach(([, raw], i) => ins.run(i + 1, raw));
    const q = db.prepare(`SELECT obs_id FROM observation_files WHERE ${fileMatchClause('')}`);
    shapes.forEach(([label, raw, expected], i) => {
      const hit = q.all(...fileMatchParams(raw)).some((r) => r.obs_id === i + 1);
      expect(hit, `${label} (${raw}) reachability changed`).toBe(expected);
    });
    db.close();
  });

  it('is total: a non-string becomes the empty string rather than throwing', () => {
    expect(scrubFilePath(undefined)).toBe('');
    expect(scrubFilePath(null)).toBe('');
    expect(scrubFilePath(42)).toBe('42');
  });
});

// The SIXTH path column, found by the claims lens: `deferred_work.files` is agent-writable
// on two live faces (MCP `mem_defer(files=…)`, CLI `defer add --files a.mjs,b.mjs`) and
// insertDeferred stringified it raw beside a title scrubRecord had already cleaned — the
// exact asymmetry this round is named after. lib/scrub-record.mjs's own header prescribes
// the remedy for this column by name, which is the round's own thesis: a prescription in a
// comment is not a mechanism.
describe('deferred_work.files — the sixth path column', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('scrubs each element and leaves the column parseable', () => {
    const { id } = insertDeferred(db, {
      project: 'p1',
      title: 'rotate token before release',
      priority: 2,
      detail: 'the detail',
      files: [DIR_PATH, '/repo/clean.mjs'],
    });
    const row = db.prepare('SELECT files FROM deferred_work WHERE id = ?').get(id);
    expect(row.files, 'deferred_work.files leaked the raw path').not.toContain(SECRET);
    expect(JSON.parse(row.files), 'the column stopped being a parseable array').toEqual([
      scrubFilePath(DIR_PATH),
      '/repo/clean.mjs',
    ]);
  });

  it('leaves a null files column null rather than turning it into []', () => {
    const { id } = insertDeferred(db, { project: 'p1', title: 'no files here', priority: 2 });
    expect(db.prepare('SELECT files FROM deferred_work WHERE id = ?').get(id).files).toBeNull();
  });
});

describe('path columns — element-level pre-scrub (D#44)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('mem_save: observations.files_modified and the observation_files edge are both scrubbed', () => {
    const res = saveObservation(db, {
      content: 'a change worth keeping, with enough body to clear the noise gate',
      project: 'p1',
      type: 'bugfix',
      importance: 2,
      files: [DIR_PATH],
      lesson_learned: 'the junction row is the recall key',
    });
    expect(res.kind, 'fixture did not save at all').toBe('saved');

    const row = db.prepare('SELECT files_modified FROM observations WHERE id = ?').get(res.id);
    expect(row.files_modified, 'files_modified leaked the raw path').not.toContain(SECRET);
    expect(JSON.parse(row.files_modified), 'the column stopped being a parseable array').toEqual([
      scrubSecrets(DIR_PATH),
    ]);

    const edge = db.prepare('SELECT filename FROM observation_files WHERE obs_id = ?').get(res.id);
    expect(edge.filename, 'observation_files.filename leaked the raw path').not.toContain(SECRET);
    expect(edge.filename).toBe(scrubSecrets(DIR_PATH));
  });

  it('saveEvent: events.file_paths is scrubbed per element and stays parseable', () => {
    const id = saveEvent(db, {
      project: 'p1',
      event_type: 'bugfix',
      title: 'an event',
      body: 'a body',
      file_paths: [DIR_PATH, '/repo/clean.mjs'],
    });
    const row = db.prepare('SELECT file_paths FROM events WHERE id = ?').get(id);
    expect(row.file_paths, 'events.file_paths leaked the raw path').not.toContain(SECRET);
    expect(JSON.parse(row.file_paths), 'the column stopped being a parseable array').toEqual([
      scrubSecrets(DIR_PATH),
      '/repo/clean.mjs',
    ]);
  });

  it('hook-llm auto-capture: files_modified, files_read and the edge are all scrubbed', async () => {
    const hookLlm = await import('../hook-llm.mjs');
    const id = hookLlm.saveObservation(
      {
        type: 'bugfix',
        title: 'a substantive title that clears the noise gates',
        narrative: 'a narrative with enough body to survive the low-yield gate',
        importance: 2,
        lessonLearned: 'auto-capture writes the same two path sinks',
        files: [DIR_PATH],
        filesRead: [BASE_PATH],
      },
      'p1',
      's-llm',
      db,
    );
    expect(id, 'fixture was dropped by a noise gate before it could be asserted on').toBeTruthy();

    const row = db.prepare('SELECT files_modified, files_read FROM observations WHERE id = ?').get(id);
    expect(row.files_modified, 'files_modified leaked').not.toContain(SECRET);
    expect(row.files_read, 'files_read leaked').toContain('***');
    expect(JSON.parse(row.files_modified)).toEqual([scrubSecrets(DIR_PATH)]);
    expect(JSON.parse(row.files_read)).toEqual([scrubSecrets(BASE_PATH)]);

    const edge = db.prepare('SELECT filename FROM observation_files WHERE obs_id = ?').get(id);
    expect(edge.filename, 'the auto-capture edge leaked').toBe(scrubSecrets(DIR_PATH));
  });

  // The reader half. Writers alone leave the stored key and the query key derived
  // by two different rules; this is the shape that can tell them apart, because
  // scrubbing BASE_PATH rewrites its basename and therefore every arm of
  // fileMatchParams. On the maintainer's corpus 0 of 2340 stored path values have
  // a credential anywhere, so nothing here is observable from the live DB — that
  // is a snapshot of one corpus, not a property of the code.
  it('recallByFile still finds a row whose stored path was scrubbed in the BASENAME', () => {
    const res = saveObservation(db, {
      content: 'a lesson about a file whose name is credential-shaped',
      project: 'p1',
      type: 'bugfix',
      importance: 2,
      files: [BASE_PATH],
      lesson_learned: 'the edge filename is also the recall key',
    });
    expect(res.kind).toBe('saved');
    expect(
      db.prepare('SELECT filename FROM observation_files WHERE obs_id = ?').get(res.id).filename,
      'premise: the stored key must actually have been rewritten, or this case proves nothing',
    ).toBe(scrubSecrets(BASE_PATH));

    const { rows } = recallByFile(db, BASE_PATH, { limit: 10, includeNoise: true });
    expect(
      rows.map((r) => r.id),
      'a raw query path no longer reaches its own scrubbed edge',
    ).toContain(res.id);
  });
});

// D#32 safe subset: prefix-anchored provider credentials. Two-sided battery —
// positives MUST scrub, and this repo's own hash-shaped data MUST survive
// (the whole reason the bare-high-entropy pattern was deliberately NOT added).
describe('scrubSecrets — provider-prefixed credentials (D#32 safe subset)', () => {
  // 32-hex / 22-/43-char bodies are fixed-length sentinels, not real keys.
  const HEX32 = '0123456789abcdef0123456789abcdef'; // 32 hex
  const SENDGRID = `SG.${'aBcDeFgHiJkLmNoPqRsTuV'}.${'0123456789012345678901234567890123456789012'}`; // SG.<22>.<43>

  it('scrubs SendGrid SG.<22>.<43> keys', () => {
    expect(SENDGRID.length).toBe(3 + 22 + 1 + 43); // structural guard on the fixture
    expect(scrubSecrets(`key: ${SENDGRID} end`)).not.toContain(SENDGRID);
    expect(scrubSecrets(SENDGRID)).toBe('***');
  });

  it('scrubs Twilio Account SID (AC…) and API Key SID (SK…)', () => {
    expect(scrubSecrets(`AC${HEX32}`)).toBe('***');
    expect(scrubSecrets(`SK${HEX32}`)).toBe('***');
    expect(scrubSecrets(`twilio sid AC${HEX32} configured`)).not.toContain(HEX32);
  });

  it('scrubs Mailgun private key (key-<32hex>)', () => {
    expect(scrubSecrets(`key-${HEX32}`)).toBe('***');
  });

  // The asymmetric-loss negatives: a bare-hex pattern would have eaten all of
  // these. Each is a real shape this repo stores/emits and must pass through.
  it("does NOT scrub this repo's own hash-shaped data (no bare-token pattern)", () => {
    const gitSha40 = '0123456789abcdef0123456789abcdef01234567'; // 40-hex git SHA
    const md5 = '5d41402abc4b2a76b9719d911017c592'; // 32-hex MD5
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 64-hex
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const shortSha = '434c32d';
    const minhashSig = '12,8841,290,77123,4,99021,1532,66,40021,3'; // comma-joined ints
    for (const v of [gitSha40, md5, sha256, uuid, shortSha, minhashSig]) {
      expect(scrubSecrets(`commit ${v} landed`), `over-scrubbed ${v}`).toContain(v);
    }
  });

  // Regression guard for #8664 (already fixed): underscore-cased env vars must
  // still scrub — confirms the deferred note's "underscore env" item is closed.
  it('still scrubs underscore-cased env-var assignments (#8664)', () => {
    expect(scrubSecrets('DB_PASSWORD=hunter2supersecret')).not.toContain('hunter2supersecret');
    expect(scrubSecrets('GH_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toContain('***');
  });
});

// ─── Audit 2026-06-22 P0 #2: secret-scrub coverage holes ──────────────────────
describe('scrubSecrets — quoted credential values (audit #2a)', () => {
  it('scrubs bare-key quoted values: key="value" / key:\'value\'', () => {
    expect(scrubSecrets('api_key="secretvalue123456"')).not.toContain('secretvalue123456');
    expect(scrubSecrets("password: 'hunter2hunter2'")).not.toContain('hunter2hunter2');
    expect(scrubSecrets('token="ghs_realtokenABCDEF"')).not.toContain('ghs_realtokenABCDEF');
    expect(scrubSecrets('client_secret = "abcdef123456ZZ"')).not.toContain('abcdef123456ZZ');
  });
  it('replaces only the value, preserving key + quotes', () => {
    expect(scrubSecrets('api_key="secretvalue123456"')).toBe('api_key="***"');
    expect(scrubSecrets("password: 'hunter2hunter2'")).toBe("password: '***'");
  });
  it('still does NOT break JSON.parse of a quoted-key object (line-80 path intact)', () => {
    const out = scrubSecrets('{"api_key": "secretvalue123456", "ok": "fine"}');
    expect(out).not.toContain('secretvalue123456');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  // Review catch: the quoted pattern must carry the SAME prose split as the unquoted
  // patterns — bare credential nouns preceded by "<word> " are prose, not config, and
  // must survive even when the value is quoted (#8283; the unquoted form already keeps
  // them, so the quoted form must too). Structured keys / env vars still scrub in prose.
  it('does NOT over-scrub a bare noun in prose just because the value is quoted', () => {
    expect(scrubSecrets('the bearer: "alicewashere"')).toBe('the bearer: "alicewashere"');
    expect(scrubSecrets('the token: "somemarkervalue"')).toBe('the token: "somemarkervalue"');
    expect(scrubSecrets('Decision: keep the token: "opaque-by-design" here')).toContain('opaque-by-design');
  });
  it('STILL scrubs a structured key / env var even mid-prose (quoted)', () => {
    expect(scrubSecrets('see api_key: "realsecret123"')).not.toContain('realsecret123');
    expect(scrubSecrets('the PGPASSWORD: "hunter2hunter2" here')).not.toContain('hunter2hunter2');
  });
});

describe('scrubSecrets — well-known no-separator credential env vars (audit #2b)', () => {
  it('scrubs PGPASSWORD= / MYSQL_PWD= (standard secret env-var names)', () => {
    expect(scrubSecrets('PGPASSWORD=hunter2hunter2 psql -h db.prod')).not.toContain('hunter2hunter2');
    expect(scrubSecrets('MYSQL_PWD=secretpass123 mysql')).not.toContain('secretpass123');
    expect(scrubSecrets('export PGPASS=hunter2hunter2')).not.toContain('hunter2hunter2');
  });
  // Guard: PWD is the present-working-dir env var, NOT a secret. The fix
  // deliberately omits a bare `pwd` keyword to avoid scrubbing real paths.
  it('does NOT scrub PWD= (working-directory env var, not a credential)', () => {
    expect(scrubSecrets('PWD=/home/user/projectdir')).toContain('/home/user/projectdir');
    expect(scrubSecrets('cd "$PWD" && ls')).toContain('PWD');
  });
  // Consistency guard: arbitrary letter-prefixed identifiers stay non-credentials,
  // matching the deliberate low-FP decision at utils.test.mjs:1089-1100 (#8283).
  // We enumerate known secret env-var NAMES rather than a blanket letter-prefix.
  it('does NOT scrub arbitrary letter-prefixed words (topsecret=, mypassword=)', () => {
    expect(scrubSecrets('topsecret=foobar123')).toBe('topsecret=foobar123');
    expect(scrubSecrets('mypassword=foobar123')).toBe('mypassword=foobar123');
  });
});

describe('scrubSecrets — bare-noun `=` assignment scrubs even mid-prose (round-4 leak)', () => {
  // Round-4 finding: `<English-word> password=<value>` (assignment in a sentence)
  // leaked because the prose lookbehind `(?<![A-Za-z][ \t])` skipped ANY bare noun
  // preceded by "word ", regardless of separator. The prose shape the lookbehind
  // exists to protect is `:` ("the token: alicebob") — an `=` is config assignment, not
  // prose. Split the noun patterns: `=` always scrubs, `:` keeps the prose guard.
  it('scrubs password=/token=/secret= even when preceded by a prose word', () => {
    expect(scrubSecrets('Config has password=hunter2supersecret in env')).not.toContain('hunter2supersecret');
    expect(scrubSecrets('never commit password=mysecretvalue123')).not.toContain('mysecretvalue123');
    expect(scrubSecrets('we set token=abc123def456ghi for the call')).not.toContain('abc123def456ghi');
    expect(scrubSecrets('the secret=topsecretpayload99 leaked')).not.toContain('topsecretpayload99');
  });
  it('scrubs a quoted bare-noun `=` assignment even mid-prose', () => {
    expect(scrubSecrets('config has password="realquotedsecret" set')).not.toContain('realquotedsecret');
  });
  // The `:` prose protection MUST survive the split (these stay unscrubbed).
  it('still does NOT scrub bare nouns in `:` prose (split preserves #8283)', () => {
    expect(scrubSecrets('the token: somemarkervalue')).toBe('the token: somemarkervalue');
    expect(scrubSecrets('the bearer: "alicewashere"')).toBe('the bearer: "alicewashere"');
  });
  // Boundary cases MUST still survive (no \b/_ before the keyword).
  it('still does NOT scrub letter-glued non-keywords (topsecret=, mypassword=)', () => {
    expect(scrubSecrets('topsecret=foobar123')).toBe('topsecret=foobar123');
    expect(scrubSecrets('mypassword=foobar123')).toBe('mypassword=foobar123');
  });
});

describe('scrubSecrets / scrubRecord — <private> stripped on persistence (audit #2c)', () => {
  it('scrubSecrets strips <private>...</private> blocks', () => {
    expect(scrubSecrets('before <private>topsecret stuff</private> after')).not.toContain('topsecret stuff');
  });
  it('scrubRecord (the persistence chokepoint) strips <private> from text fields', () => {
    const out = scrubRecord('observations', {
      text: 'x <private>leaked-secret-here</private> y',
      title: 'normal title',
    });
    expect(out.text).not.toContain('leaked-secret-here');
    expect(out.title).toBe('normal title');
  });
  it('stripPrivate remains idempotent (double-strip is a no-op)', () => {
    const once = stripPrivate('a <private>x</private> b');
    expect(stripPrivate(once)).toBe(once);
  });
});

describe('saveObservation — derived title scrubs BEFORE truncation (#secret-title-leak)', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  // A secret that straddles the 100-char title-truncation boundary must not leak
  // its head into the title. Pre-fix, `content.slice(0, 100)` truncated the AWS
  // key to a short prefix that the value-length-gated scrub regex no longer
  // matched, so the title kept a partial secret while the narrative was clean.
  it('does not leak a boundary-straddling secret into the auto-derived title', () => {
    // 75-char prefix lands the secret value right at the slice(0,100) cut, so
    // pre-fix the title kept a bare `...ACCESS_KEY=AK` (head of the AWS key).
    const prefix = 'x'.repeat(75) + ' ';
    const content = `${prefix}AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE tail`;
    const r = saveObservation(db, { content, type: 'discovery', project: 'sec-test', importance: 2 });
    expect(r.kind).toBe('saved');
    const row = db.prepare('SELECT title, narrative FROM observations WHERE id = ?').get(r.id);
    // A credential key directly followed by an alphanumeric value char = an
    // unscrubbed (partial) secret. Neither field may contain it.
    expect(row.title).not.toMatch(/ACCESS_KEY=[A-Za-z0-9]/);
    expect(row.narrative).not.toMatch(/ACCESS_KEY=[A-Za-z0-9]/);
  });
});

describe('scrubSecrets — quoted-key + passphrase (round-5 #8805 sibling)', () => {
  const V = 'wJalrXUtnFEMIsupersecret';

  it('scrubs single-quoted / mixed-quoted credential keys (Python dict reprs, single-quoted JS/JSON)', () => {
    expect(scrubSecrets(`{'api_key': '${V}'}`)).not.toContain(V);
    expect(scrubSecrets(`{"api_key": '${V}'}`)).not.toContain(V); // mixed quotes
    expect(scrubSecrets(`{'access_token':'${V}'}`)).not.toContain(V);
    expect(scrubSecrets(`{'client_secret':'${V}'}`)).not.toContain(V);
    expect(scrubSecrets(`{'private_key':'${V}'}`)).not.toContain(V);
    // double-quoted JSON still scrubs (no regression)
    expect(scrubSecrets(`{"api_key":"${V}"}`)).not.toContain(V);
  });

  it('scrubs passphrase (SSH/GPG/keystore) across =, :, quoted, and env-var shapes', () => {
    expect(scrubSecrets(`passphrase=${V}`)).not.toContain(V);
    expect(scrubSecrets(`GPG_PASSPHRASE=${V}`)).not.toContain(V);
    expect(scrubSecrets(`passphrase: "${V}"`)).not.toContain(V);
    expect(scrubSecrets(`{"gpg_passphrase":"${V}"}`)).not.toContain(V);
  });

  it('does NOT over-redact prose or non-credential quoted keys', () => {
    // bare "token" is excluded from the quoted-key noun set, so a numeric count survives
    expect(scrubSecrets(`{'token_count': 123456}`)).toBe(`{'token_count': 123456}`);
    expect(scrubSecrets(`{'name': 'alice smith'}`)).toBe(`{'name': 'alice smith'}`);
    expect(scrubSecrets('the token: opaque wisdom of the ancients')).toBe(
      'the token: opaque wisdom of the ancients',
    );
    expect(scrubSecrets('I forgot my password yesterday')).toBe('I forgot my password yesterday');
  });

  it('scrubs a quoted-key secret through the scrubRecord persistence chokepoint', () => {
    const rec = scrubRecord('observations', {
      narrative: `API failed. Response: {'access_token': '${V}', 'expires': 3600}`,
    });
    expect(rec.narrative).not.toContain(V);
  });
});

// ─── Mid-prose `password:` leak (R5 dogfood, 2026-08-13) ────────────────────
//
// The `:` arm of the bare-noun patterns carries a prose lookbehind
// `(?<![A-Za-z][ \t])` so conversational English survives ("Marker token: xyz",
// "the bearer: alice" — #8283). That guard was applied to the WHOLE noun class,
// so any credential noun preceded by a word escaped: a session narrative like
// "deployed to staging, the db password: hunter2correct" persisted the password
// in plaintext and re-injected it into every later context block.
//
// `password|passwd|passphrase` are not prose-ambiguous the way `token`/`bearer`/
// `secret` are — an English sentence that writes "<word> password: <6+ chars>"
// is naming a credential, not using the word conversationally. Split them out of
// the lookbehind arm; `token|bearer|secret` keep it (the pinned #8283 cases below
// all use those nouns, and stay green).
describe('scrubSecrets — password/passwd/passphrase scrub mid-prose on the `:` separator', () => {
  const V = 'hunter2correct';

  it('scrubs a bare `password:` preceded by a prose word (unquoted)', () => {
    expect(scrubSecrets(`Deployed with password: ${V}`)).toBe('Deployed with password: ***');
    expect(scrubSecrets(`note the db password: ${V} here`)).toBe('note the db password: *** here');
    expect(scrubSecrets(`AWS_KEY=abc123456789 and password: ${V}`)).not.toContain(V);
  });

  it('scrubs mid-prose passwd/passphrase too', () => {
    expect(scrubSecrets(`the passwd: ${V}`)).not.toContain(V);
    expect(scrubSecrets(`rotate the passphrase: ${V}`)).not.toContain(V);
  });

  it('scrubs a QUOTED mid-prose password value', () => {
    expect(scrubSecrets(`config has password: "${V}" set`)).not.toContain(V);
    expect(scrubSecrets(`config has password: '${V}' set`)).not.toContain(V);
  });

  it('keeps the #8283 prose protection for token/bearer/secret', () => {
    expect(scrubSecrets('Marker token: xyzpdq-round3.')).toBe('Marker token: xyzpdq-round3.');
    expect(scrubSecrets('the bearer: "alicewashere"')).toBe('the bearer: "alicewashere"');
    expect(scrubSecrets('the token: somemarkervalue')).toBe('the token: somemarkervalue');
  });

  it('keeps letter-glued non-keywords unscrubbed (no \\b/_ before the noun)', () => {
    expect(scrubSecrets(`mypassword: ${V}`)).toBe(`mypassword: ${V}`);
    expect(scrubSecrets('I forgot my password yesterday')).toBe('I forgot my password yesterday');
  });
});

// ─── Mid-prose password: value must LOOK like a credential (v3.61.1) ────────
//
// v3.61.0 dropped the prose lookbehind for password|passwd|passphrase on `:` so
// "Deployed with password: hunter2correct" would stop persisting a plaintext
// credential. That closed the leak by trading it for a worse defect: the value
// class `[^\s,;'"}\]]{6,}` matches ordinary English, and scrubSecrets runs on the
// WRITE path, so an ordinary sentence was corrupted irreversibly at save time —
// "Reset the password: instructions are in the onboarding doc" stored as
// "password: *** are in the onboarding doc" (independent pre-tag review, 2026-08-13).
//
// Position decides which rule applies:
//   • config position (start of line / not preceded by a word) → scrub any value,
//     unchanged from before v3.61.0 and pinned by the indent cases below;
//   • prose position (preceded by an English word + space) → scrub only when the
//     value is credential-SHAPED: a digit, mixed case, a symbol, or one long
//     unbroken token. English words carry none of those.
describe('scrubSecrets — mid-prose password scrubs credentials, not English', () => {
  it('does NOT corrupt ordinary prose (the v3.61.0 regression)', () => {
    const prose = [
      'Reset the password: instructions are in the onboarding doc',
      'Changed the passphrase: rotation policy from 90 to 180 days',
      'I forgot the password: yesterday I had to reset it again',
      'the user reported password: prompts appearing twice on mobile',
      'we store the password: hashed with bcrypt and never logged',
      // Capitalized — a sentence continuing after the colon. The letter class is
      // case-insensitive precisely so this survives.
      'Reset the password: Instructions are in the onboarding doc',
    ];
    for (const p of prose) expect(scrubSecrets(p), p).toBe(p);
  });

  it('STILL scrubs a credential-shaped value mid-prose (the leak this closed)', () => {
    expect(scrubSecrets('Deployed with password: hunter2correct')).toBe('Deployed with password: ***');
    expect(scrubSecrets('the db password: S3cretValue')).not.toContain('S3cretValue');
    expect(scrubSecrets('rotate the passphrase: correct-horse-battery-staple')).not.toContain(
      'correct-horse-battery-staple',
    );
    expect(scrubSecrets('note the password: Tr0ub4dor here')).not.toContain('Tr0ub4dor');
    expect(scrubSecrets('set password: aVeryLongOpaqueSecretToken')).not.toContain(
      'aVeryLongOpaqueSecretToken',
    );
  });

  it('scrubs a QUOTED value mid-prose regardless of shape (quoting IS the signal)', () => {
    expect(scrubSecrets('config has password: "instructions"')).toBe('config has password: "***"');
    expect(scrubSecrets("config has password: 'onboarding'")).toBe("config has password: '***'");
  });

  it('config position still scrubs any value (pre-v3.61.0 behavior preserved)', () => {
    expect(scrubSecrets('  password: hunter2')).toBe('  password: ***');
    expect(scrubSecrets('\tpassword=hunter2')).toBe('\tpassword=***');
    expect(scrubSecrets('password: instructions')).toBe('password: ***');
  });

  it('keeps the #8283 prose protection for token/bearer/secret', () => {
    expect(scrubSecrets('Marker token: xyzpdq-round3.')).toBe('Marker token: xyzpdq-round3.');
    expect(scrubSecrets('the bearer: "alicewashere"')).toBe('the bearer: "alicewashere"');
  });
});

// ─── D#52: the second space-adjacent labelled secret ships in plaintext ──────
// Measured 2026-09-22 by a directed grid (2940 inputs, 80.3% reach). The real
// corpus is BLIND to this — 0 of the 287 non-empty live values across
// text/subtitle/concepts/facts/search_aliases are modified by scrubSecrets at all —
// which is why an earlier 300k-title fuzz found nothing. Reach first, then believe
// the green. (This line first said "0 of 452"; 452 was the NOT-NULL count, ~39% of
// it empty strings, and was retracted in secret-scrub.mjs and the commit first.)
//
// Mechanism: patterns #1/#3/#8 carry the prose lookbehind `(?<![A-Za-z][ \t])`
// ("preceded by letter+horizontal-space means PROSE, do not scrub"). With /g the
// first match CONSUMES its value, so the next labelled keyword on the same line
// is preceded by <that value's last char>+space — letter+space — and is read as
// prose. The lookbehind cannot tell an English word from the tail of a credential.
//
// The same mechanism is D#46's non-idempotence seen from the other side: pass 1
// rewrites the neighbour's left context to `*** `, and `*` is not [A-Za-z], so a
// SECOND pass scrubs what the first one skipped. Leak and drift are one defect.
//
// Fixtures are ASSEMBLED, never written whole: a realistic credential literal in
// THIS file once had GitHub push protection reject an entire release push.
describe('scrubSecrets — D#52 adjacent labelled secrets on one line', () => {
  const A = 'A'.repeat(20);
  const B = 'B'.repeat(20);
  const C = 'C'.repeat(20);

  it('scrubs the SECOND space-adjacent labelled secret, not just the first', () => {
    const out = scrubSecrets(`token: ${A} secret: ${B}`);
    expect(out).not.toContain(A);
    expect(out, 'the second labelled secret shipped in plaintext').not.toContain(B);
  });

  it('scrubs a run of three, not just the head', () => {
    const out = scrubSecrets(`token: ${A} secret: ${B} bearer: ${C}`);
    for (const [name, v] of [
      ['first', A],
      ['second', B],
      ['third', C],
    ]) {
      expect(out, `the ${name} labelled secret survived`).not.toContain(v);
    }
  });

  it('is idempotent: a second scrub changes nothing (D#46)', () => {
    for (const input of [
      `token: ${A} secret: ${B}`,
      `token: ${A} secret: ${B} bearer: ${C}`,
      `secret: ${A} secret: ${A}`,
    ]) {
      const once = scrubSecrets(input);
      expect(scrubSecrets(once), `double-scrub drifted for ${JSON.stringify(input)}`).toBe(once);
    }
  });

  // The prose guard is the thing this fix must NOT buy its way out of. These are
  // the exact shapes #8283 / round-4 / R5 established; they stay unscrubbed.
  it('does not buy the fix with the #8283 prose protection', () => {
    expect(scrubSecrets('the token: somemarkervalue')).toBe('the token: somemarkervalue');
    expect(scrubSecrets('the bearer: "alicewashere"')).toBe('the bearer: "alicewashere"');
    expect(scrubSecrets('Marker token: xyzpdq-round3.')).toBe('Marker token: xyzpdq-round3.');
    expect(scrubSecrets('topsecret=foobar123')).toBe('topsecret=foobar123');
    expect(scrubSecrets('mypassword=foobar123')).toBe('mypassword=foobar123');
  });
});

// Hitting MAX_SCRUB_PASSES is the one outcome nothing else reaches: the convergence
// case pins settling in under 5 sweeps, so no other test ever hits the cap. What the
// source promises there is deliberately modest — the scrub stops, labelled secrets
// past the 32nd stay as they are, and nothing ELSE in the string is touched — and
// these cases pin each half of that. (An earlier draft stripped the prose guard once
// the cap was hit, to clear the remainder; it redacted ordinary English elsewhere in
// the same string and was removed before release. The case below that feeds prose
// alongside an overrun chain is what would catch it coming back.)
describe('scrubSecrets — what the pass cap does and does not promise', () => {
  // N space-adjacent secrets need N+1 sweeps when each value ends in a LETTER (that is what
  // re-arms the prose lookbehind for the next keyword), so 40 of them overruns a cap of 32.
  // Values must be UNIQUE (so `survivors` counts what it says) and must END IN A LETTER
  // (a digit-terminated value does not re-arm the prose lookbehind, so the whole chain
  // would collapse in 2 sweeps and never reach the cap). A first cut used `i % 26`, which
  // repeats past 26 and made the survivor count ambiguous.
  const chain = (n) => {
    const values = Array.from({ length: n }, (_, i) => `v${i}`.padEnd(24, 'Z'));
    return { values, input: values.map((v) => `token: ${v}`).join(' ') };
  };

  it('the 40-deep chain genuinely overruns the cap, or every case below proves nothing', () => {
    const { input } = chain(40);
    const oneSweep = (str) => {
      let r = str;
      for (const [p, rep] of SECRET_PATTERNS) r = r.replace(p, rep);
      return r;
    };
    let cur = input;
    let prev;
    let sweeps = 0;
    do {
      prev = cur;
      cur = oneSweep(cur);
      sweeps++;
    } while (cur !== prev && sweeps < 200);
    expect(sweeps, 'this input no longer overruns MAX_SCRUB_PASSES (32)').toBeGreaterThan(32);
  });

  // THE PROMISE THE CAP DOES NOT MAKE. An earlier cut re-ran the three prose-guarded patterns
  // with the guard stripped when the cap was hit, which does clear the tail — and applies to
  // the WHOLE string, so prose elsewhere in the same input was redacted irreversibly on the
  // write path. That is verbatim the v3.61.0 regression secret-scrub.mjs:44-50 records as
  // already undone once, and pre-ship review reproduced it here. The tail is left unscrubbed
  // on purpose; this case is the reason.
  it('does not corrupt prose elsewhere in the string when the cap is overrun', () => {
    const prose = 'Reset the password: instructions are in the onboarding doc.';
    const out = scrubSecrets(`${chain(40).input} ${prose}`);
    expect(out, 'the cap path redacted ordinary English (the v3.61.0 regression)').toContain(prose);
  });

  it('a chain that FITS inside the cap is still fully scrubbed', () => {
    // The cap is a bound on work, not a hole in the ordinary guarantee: everything short of
    // it converges. 10 needs 11 sweeps, comfortably inside 32.
    const { values, input } = chain(10);
    const out = scrubSecrets(input);
    const survivors = values.filter((v) => out.includes(v));
    expect(survivors.length, `${survivors.length}/10 labelled secrets shipped in plaintext`).toBe(0);
  });

  it('the overrun case scrubs what it reached — a residual, not a no-op', () => {
    // Bound the honesty in both directions. Hitting the cap is a PARTIAL scrub: the sweeps
    // that ran did their work. A regression that made the cap abandon the whole input would
    // otherwise read the same as the deliberate residual.
    const { values, input } = chain(40);
    const out = scrubSecrets(input);
    const survivors = values.filter((v) => out.includes(v));
    expect(survivors.length, 'the cap path scrubbed nothing at all').toBeLessThan(values.length);
    expect(out.match(/\*\*\*/g).length, 'fewer replacements than sweeps run').toBeGreaterThan(20);
  });

  // A prose negative that also carries a real secret. The ordinary prose negatives
  // contain no secret at all, so they exit after one sweep and never exercise the loop
  // continuing; this one makes the first sweep change something, and asserts the later
  // sweeps still leave the prose-position keyword alone. It does NOT kill
  // `MAX_SCRUB_PASSES = 1` (an earlier version of this comment said it did): there is
  // only one secret here, so one sweep is enough. That mutant is killed by the D#52
  // adjacency cases and the cap cases instead.
  it('a real secret in the string leaves the prose-position keyword alone', () => {
    const out = scrubSecrets('password=SUPERSECRETVALUE123 and the token: alicewashere');
    expect(out, 'the secret leaked').not.toContain('SUPERSECRETVALUE123');
    expect(out, 'a prose-position keyword was redacted').toContain('the token: alicewashere');
  });
});
