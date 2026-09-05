// R4 E2E audit — secret-scrub coverage + safety gaps (all empirically reproduced
// before fixing; see round-4 audit). Six independent defects in secret-scrub.mjs:
//   HIGH — ReDoS in the URL basic-auth pattern (catastrophic backtracking)
//   HIGH — Authorization: Basic (and token) header credentials survive
//   MED  — labeled git-SHA / checksum over-scrub (`hash: <40hex>` → ***)
//   MED  — TLS/alias DB connection schemes (rediss/amqps/mariadb/mssql) leak
//   MED  — provider-prefix gaps (ghu_ / xapp- / xoxe- / whsec_ / slack webhook)
//   MED  — space-separated `--password <value>` credential flag leaks
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrub.mjs';

describe('secret-scrub R4 — ReDoS in URL basic-auth pattern (HIGH)', () => {
  it('handles a pathological colon-heavy https input in linear time (no catastrophic backtracking)', () => {
    // The buggy pattern `[^@/\s]+:[^@/\s]+@` lets the two runs overlap on `:`, so
    // `https://` + many `a:` with no closing `@` triggers O(n²) backtracking
    // (measured 80k chars → ~1.1s, 100k → ~1.8s). The synchronous UserPromptSubmit
    // path scrubs the uncapped prompt, so this is an availability DoS.
    const evil = 'https://' + 'a:'.repeat(50000); // 100k chars
    const start = process.hrtime.bigint();
    scrubSecrets(evil);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(ms).toBeLessThan(300); // fixed pattern is ~1ms; broken is >1500ms
  });

  it('still scrubs genuine URL basic-auth credentials (no regression)', () => {
    expect(scrubSecrets('https://user:realpassword@host.com/path')).toBe('https://***:***@host.com/path');
    // password containing a colon still scrubs (second run keeps `:`)
    expect(scrubSecrets('ftp://user:pa:ss:word@host.com')).toContain('***:***@');
    // a bare URL with no credentials is untouched by the basic-auth pattern
    expect(scrubSecrets('https://example.com/no-creds')).toBe('https://example.com/no-creds');
  });
});

describe('secret-scrub R4 — Authorization header schemes (HIGH)', () => {
  it('scrubs Authorization: Basic <base64> (was leaking — only Bearer covered)', () => {
    // base64('user:supersecretpassword')
    const out = scrubSecrets('Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk');
    expect(out).toBe('Authorization: Basic ***');
  });
  it('scrubs Authorization: token <opaque> (GitHub scheme)', () => {
    expect(scrubSecrets('Authorization: token abcdefOPAQUEnotaknownprefix1234')).toBe(
      'Authorization: token ***',
    );
  });
  it('still scrubs Authorization: Bearer (no regression)', () => {
    expect(scrubSecrets('Authorization: Bearer abcdef123456ghijkl')).toBe('Authorization: Bearer ***');
  });
});

describe('secret-scrub R4 — labeled git-SHA over-scrub (MED)', () => {
  const sha40 = '0123456789abcdef0123456789abcdef01234567';
  it('preserves a labeled git SHA / checksum (was corrupted to ***)', () => {
    expect(scrubSecrets(`The fix landed in commit hash: ${sha40}`)).toBe(
      `The fix landed in commit hash: ${sha40}`,
    );
    expect(scrubSecrets(`blob hash=${sha40}`)).toBe(`blob hash=${sha40}`);
  });
  it('still scrubs credential-noun hex assignments (no regression)', () => {
    expect(scrubSecrets(`SECRET_KEY=${sha40}`)).toBe('SECRET_KEY=***');
    expect(scrubSecrets(`token: ${sha40}`)).toBe('token: ***');
  });
});

describe('secret-scrub R4 — TLS/alias DB connection schemes (MED)', () => {
  it('scrubs TLS + alias schemes that were leaking', () => {
    expect(scrubSecrets('rediss://default:s3cr3tpass@redis.cloud:6379')).toBe('rediss://***');
    expect(scrubSecrets('amqps://guest:s3cr3tpass@rabbit.host:5672/vhost')).toBe('amqps://***');
    expect(scrubSecrets('mariadb://root:s3cr3tpass@localhost/app')).toBe('mariadb://***');
    expect(scrubSecrets('mssql://sa:s3cr3tpass@host:1433')).toBe('mssql://***');
  });
  it('still scrubs the base schemes (no regression)', () => {
    expect(scrubSecrets('redis://default:s3cr3tpass@redis.cloud:6379')).toBe('redis://***');
    expect(scrubSecrets('postgres://user:pw@host/db')).toBe('postgres://***');
  });
});

describe('secret-scrub R4 — provider-prefix gaps (MED)', () => {
  // Fixtures are assembled at runtime (prefix + body) so no contiguous provider-token
  // literal sits in the source — otherwise GitHub push-protection blocks the commit on
  // these fake-but-structurally-valid tokens. The concatenated runtime value is identical,
  // so the scrubber still sees the whole token.
  it('scrubs sibling provider prefixes that were leaking', () => {
    expect(scrubSecrets('ghu_' + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('***');
    expect(scrubSecrets('xapp-' + '1-A012345-6789-abcdefghijklmnop')).toBe('***');
    expect(scrubSecrets('xoxe-' + '1-abcdefghijklmnopqrstuvwx')).toBe('***');
    expect(scrubSecrets('whsec_' + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('***');
  });
  it('scrubs the Slack incoming-webhook URL secret', () => {
    const tail = 'X'.repeat(24);
    const out = scrubSecrets(
      'post to https://hooks.slack.com/services/' + 'T00000000/B00000000/' + tail + ' now',
    );
    expect(out).not.toContain(tail);
  });
  it('still scrubs the already-covered GitHub/Slack prefixes (no regression)', () => {
    expect(scrubSecrets('ghp_' + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('***');
    expect(scrubSecrets('xoxb-' + 'aaaaaaaaaaaaaaaaaaaa')).toBe('***');
  });
});

describe('secret-scrub R4 — space-separated --password flag (MED)', () => {
  it('scrubs a long-form --password with a space separator (was leaking)', () => {
    expect(scrubSecrets('mysql --password hunter2supersecret -h db')).toBe('mysql --password *** -h db');
  });
  it('still scrubs --password= assignment (no regression)', () => {
    expect(scrubSecrets('mysql --password=hunter2supersecret')).toContain('***');
  });
  it('does not over-scrub a normal --flag value', () => {
    // a non-credential long flag stays intact
    expect(scrubSecrets('run --output results.json --verbose')).toBe('run --output results.json --verbose');
  });
});

describe('secret-scrub R4 — no over-scrub of ordinary prose/data', () => {
  it('leaves normal sentences, hex colors, and bare SHAs intact', () => {
    expect(scrubSecrets('the color is #ff0000 and the build passed')).toBe(
      'the color is #ff0000 and the build passed',
    );
    expect(scrubSecrets('commit 0123456789abcdef0123456789abcdef01234567 landed')).toBe(
      'commit 0123456789abcdef0123456789abcdef01234567 landed',
    );
  });
});
