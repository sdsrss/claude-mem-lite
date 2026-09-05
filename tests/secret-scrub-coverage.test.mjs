import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { scrubRecord } from '../lib/scrub-record.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
import { stripPrivate } from '../lib/private-strip.mjs';
import { saveObservation } from '../lib/save-observation.mjs';

const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const POISONED = `error from upstream: token=${SECRET} not found`;

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
  // exists to protect is `:` ("the token: alice") — an `=` is config assignment, not
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
