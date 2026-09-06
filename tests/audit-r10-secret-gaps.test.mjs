// R10 P1-5 + P1-6 — two independent leak paths into the DB and into LLM prompts.
//
// P1-5: deferred_work was the one write-heavy table with no scrub at all. `mem_defer`
// takes a free-text title and detail straight from the agent ("rotate ghp_… before
// release", a connection string pasted into detail), inserts them verbatim, and every
// read surface — the SessionStart dashboard, mem_defer_list, mem_get D#N — replays them
// into model context. save-observation scrubs title/text/lesson one by one; insertDeferred
// scrubbed nothing, and the table was absent from TEXT_FIELDS_BY_TABLE so even the
// failsafe path was never consulted.
//
// P1-6: six credential shapes that appear constantly in Bash output walked through
// scrubSecrets untouched, then reached both the DB and the LLM provider via makeEntryDesc.
// Each case below leaked verbatim before the fix.

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
import { scrubRecord, TEXT_FIELDS_BY_TABLE } from '../lib/scrub-record.mjs';
import { insertDeferred, dropDeferred, getDeferredByIds } from '../lib/deferred-work.mjs';

const GH_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';

describe('R10 P1-5 — deferred_work text is scrubbed on the way in', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('lists deferred_work in the per-table field map', () => {
    expect(TEXT_FIELDS_BY_TABLE.deferred_work).toEqual(['title', 'detail', 'drop_reason']);
  });

  it('scrubRecord handles the table', () => {
    const out = scrubRecord('deferred_work', {
      title: `rotate ${GH_TOKEN} before release`,
      detail: 'db password=hunter2secret and https://u:p@host/x',
      priority: 3,
      files: JSON.stringify(['a.mjs']),
    });
    expect(out.title).not.toContain(GH_TOKEN);
    expect(out.detail).not.toContain('hunter2secret');
    expect(out.priority, 'numeric field must pass through').toBe(3);
    expect(out.files, 'JSON array field must not be rewritten').toBe(JSON.stringify(['a.mjs']));
  });

  it('insertDeferred stores a scrubbed title and detail', () => {
    const { id } = insertDeferred(db, {
      project: 'p',
      title: `rotate ${GH_TOKEN} before release`,
      detail: 'db password=hunter2secret and https://u:p@host/x',
    });
    const [row] = getDeferredByIds(db, [id]);
    expect(row.title, 'token reached the DB verbatim').not.toContain(GH_TOKEN);
    expect(row.detail, 'password reached the DB verbatim').not.toContain('hunter2secret');
    expect(row.title, 'the non-secret words must survive').toContain('rotate');
    expect(row.title).toContain('before release');
  });

  it('insertDeferred leaves clean text byte-identical', () => {
    const title = 'finish the pool bound work';
    const detail = 'see lib/rerank.mjs and benchmark/rerank-pool-replay.mjs';
    const { id } = insertDeferred(db, { project: 'p', title, detail });
    const [row] = getDeferredByIds(db, [id]);
    expect(row.title).toBe(title);
    expect(row.detail).toBe(detail);
  });

  it('dropDeferred stores a scrubbed reason', () => {
    const { id } = insertDeferred(db, { project: 'p', title: 'x' });
    dropDeferred(db, id, `superseded — old key was ${GH_TOKEN}`);
    const [row] = getDeferredByIds(db, [id]);
    expect(row.drop_reason).not.toContain(GH_TOKEN);
    expect(row.drop_reason).toContain('superseded');
  });

  it('dropDeferred still rejects an empty reason, and a reason that is ONLY a secret', () => {
    const { id } = insertDeferred(db, { project: 'p', title: 'x' });
    expect(() => dropDeferred(db, id, '   ')).toThrow(/reason required/);
    // A reason that scrubs down to nothing but the redaction marker is still non-empty,
    // so it must not start throwing — the validation runs on the caller's input.
    const r = dropDeferred(db, id, GH_TOKEN);
    expect(r.changed).toBe(1);
  });
});

describe('R10 P1-6 — credential shapes that reached the LLM provider verbatim', () => {
  const cases = [
    ['JSON Authorization header', '{"Authorization":"Bearer ghq9Xk2LmN8pQr4sT6uV"}', 'ghq9Xk2LmN8pQr4sT6uV'],
    [
      'Azure storage AccountKey',
      'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=Zm9vYmFyYmF6cXV4Y29ycmdl==;EndpointSuffix=core.windows.net',
      'Zm9vYmFyYmF6cXV4Y29ycmdl',
    ],
    [
      'Azure SAS signature',
      'https://acct.blob.core.windows.net/c?sv=2020&sig=Q1dPbGlrZVRoaXNJc0FTaWduYXR1cmU%3D&se=2027',
      'Q1dPbGlrZVRoaXNJc0FTaWduYXR1cmU',
    ],
    [
      'space-separated --token flag',
      'vault login --token hvs.CAESIJk3Qm9vYmFyMTIz',
      'hvs.CAESIJk3Qm9vYmFyMTIz',
    ],
    [
      'Cookie: session=',
      'Cookie: session=9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c; theme=dark',
      '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c',
    ],
    [
      'SQLAlchemy driver-suffixed URL',
      'engine = create_engine("postgresql+psycopg2://u:s3cr3tpw@h/db")',
      's3cr3tpw',
    ],
  ];

  for (const [name, input, secret] of cases) {
    it(`scrubs ${name}`, () => {
      expect(scrubSecrets(input)).not.toContain(secret);
    });
  }

  it('keeps the surrounding non-secret text', () => {
    expect(scrubSecrets('vault login --token hvs.CAESIJk3Qm9vYmFyMTIz')).toContain('vault login');
    expect(scrubSecrets('Cookie: session=9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c; theme=dark')).toContain(
      'theme=dark',
    );
  });

  it('the existing false-positive protection set does not regress', () => {
    // These three are the FP guards the earlier rounds installed. A --token / session=
    // widening is exactly the change that would break them.
    expect(scrubSecrets('the token: alice')).toBe('the token: alice');
    expect(scrubSecrets('token_count = 42')).toBe('token_count = 42');
    expect(scrubSecrets('Marker token: xyzpdq')).toBe('Marker token: xyzpdq');
    // Short values below the length floor stay put.
    expect(scrubSecrets('run with --token abc')).toBe('run with --token abc');
    expect(scrubSecrets('Cookie: session=short; theme=dark')).toContain('session=short');
    // An identifier-shaped word after session= is not a cookie. This is the one line the
    // 16-char floor still over-scrubbed across the whole tracked tree.
    expect(scrubSecrets('session=content_session_id)')).toBe('session=content_session_id)');
    // A prose sentence that merely contains the word sig= must not be eaten.
    expect(scrubSecrets('the sig= field was empty')).toBe('the sig= field was empty');
  });

  it('control cases that already worked still work', () => {
    expect(scrubSecrets('curl -H "Authorization: Bearer ghq9Xk2LmN8pQr4sT6uV"')).not.toContain(
      'ghq9Xk2LmN8pQr4sT6uV',
    );
    expect(scrubSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')).not.toContain(
      'wJalrXUtnFEMI',
    );
    expect(scrubSecrets('postgres://u:p4ssw0rd@h/db')).not.toContain('p4ssw0rd');
  });
});
