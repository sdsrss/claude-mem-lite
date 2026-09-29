// D#130 — scrubSecrets must stay linear on crafted input. Every stored field goes through it
// on a synchronous hook path, and Stop's timeout is 5 s. Four patterns were super-linear
// (growth per doubling of the input, 40k -> 80k chars on the pre-fix code, 2026-09-27: 3.9-4.0x
// each; every other pattern ~2x):
//   - `"\w*(?:password|…)\w*"` and `['"]\w*(?:…)\w*['"]`: from ONE quote, `\w*` runs to the end
//     of a word run, then backtracks through every keyword position, each rescanning the run;
//   - the JWT pattern: every `-eyJ` inside one dotless run is a new start that scans to the
//     run's end;
//   - the PEM pattern: every BEGIN with no END scanned to the end of the text.
// The v6.18.0 security re-check drove the first two through a report Done to 27,970 ms.
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
import { writeStopSummary, FAST_SUMMARY_LIMITS } from '../lib/fast-summary.mjs';
import { insertSession } from './test-helpers.mjs';

const N = 200_000;
const ms = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

// 40 alternating labelled values drive scrubSecrets to its 32-pass cap, so every pass rescans
// whatever follows them.
const CHAIN = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'secret: abcdefgh' : 'token: abcdefgh')).join(
  ' ',
);

describe('scrubSecrets stays linear on crafted input (D#130)', () => {
  const shapes = {
    jsonVendorKey: '"' + 'secret'.repeat(N / 6),
    quotedKey: "'" + 'passwd'.repeat(N / 6),
    quotedKeyDouble: '"' + 'password'.repeat(N / 8),
    jwtDashRun: 'eyJ-'.repeat(N / 4),
    // A word-hyphen start is allowed once per word, never inside a hyphen run.
    jwtWordDashRun: ('sess-eyJ' + 'A'.repeat(20) + ' ').repeat(N / 29),
    jwtHyphenWords: ('a-'.repeat(20) + 'eyJ' + 'A'.repeat(20) + ' ').repeat(Math.ceil(N / 64)),
    // An unterminated key header's body runs past certificate headers to the next key header.
    pemHeaderThenCerts:
      CHAIN + ' -----BEGIN RSA PRIVATE KEY-----\n' + '-----BEGIN CERTIFICATE-----\nMIIB\n'.repeat(N / 33),
    pemLongLabels: CHAIN + ' ' + ('-----BEGIN ' + 'A'.repeat(200) + '\n').repeat(Math.ceil(N / 212)),
    // Every BEGIN with no END scanned to the end of the text, on each of the 32 passes.
    pemHeadersNoEnd: CHAIN + ' ' + '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(N / 32),
    // Linear but slow: D#128's code-label branch ran a 40-char lookbehind at every position
    // until a lookahead gated it (500k chars: 407 ms → 3,387 ms → 428 ms).
    chainedWordRun: CHAIN + " '" + 'secret'.repeat(N / 6),
    // 2026-09-28 cut-off key and headerless-body patterns: base64 lines with no END anywhere.
    pemBodyNoEnd: CHAIN + ' -----BEGIN RSA PRIVATE KEY-----\n' + 'MIIEabcdefghijklmnop\n'.repeat(N / 21),
    base64LinesNoEnd: CHAIN + ' ' + 'MIIEabcdefghijklmnop\n'.repeat(N / 21),
    base64ShortLinesNoEnd: CHAIN + ' ' + 'MIIEabcdef\n'.repeat(N / 11),
    // The same lines with JSON-escaped breaks (a literal backslash and n).
    pemEscapedBodyNoEnd:
      CHAIN + ' -----BEGIN RSA PRIVATE KEY-----\\n' + 'MIIEabcdefghijklmnop\\n'.repeat(N / 22),
    // v6.19.1 delta review P1: a whitespace run inside an RFC 1421 header value, ended by a
    // backslash or a lone CR, backtracked quadratically (48.9 s at 200k).
    pemHeaderSpacesBackslash: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment:' + ' '.repeat(N) + '\\x',
    pemHeaderSpacesLoneCr: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment:' + ' '.repeat(N) + '\rx',
    pemEscapedHeaderTabs: '-----BEGIN PGP PRIVATE KEY BLOCK-----\\nComment:' + '\t'.repeat(N) + '\\t',
    base64EscapedLinesNoEnd: CHAIN + ' ' + 'MIIEabcdefghijklmnop\\n'.repeat(N / 22),
    base64LinesThenCertEnd:
      CHAIN +
      ' ' +
      ('MIIEabcdefghijklmnop\n'.repeat(20) + 'Ab=\n-----END CERTIFICATE-----\n').repeat(N / 450),
    // D#145 line scanners. A line of backslashes under a key body: a draft of lineCore stripped the
    // line's closing quote with an unanchored `(?:\\+[rn])*["']…$`, which retried every start in
    // the run (40k chars: 540 ms, x3.8 per doubling; never committed).
    pemBodyThenBackslashLine: '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIEabcdefghijklmnop\n' + '\\'.repeat(N),
    // Many ENDs on one line, each walking back to the one before it.
    pemEndsOneLine: ('x'.repeat(1000) + '-----END RSA PRIVATE KEY-----').repeat(N / 1030),
    pemEndsAfterBackslashRuns: (
      '\\'.repeat(60) + 'nMIIEabcdefghijklmnop-----END RSA PRIVATE KEY-----'
    ).repeat(N / 110),
    // A long line prefix before every BEGIN, and a prefix shape built from it.
    pemBeginLongPrefix: (
      'a'.repeat(5000) + ' -----BEGIN RSA PRIVATE KEY-----\nMIIEabcdefghijklmnop\n'
    ).repeat(N / 5053),
    pemBeginDigitPrefix: (
      '1a'.repeat(120) +
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      '1a'.repeat(120) +
      'MIIEabcdefghijklmnop\n'
    ).repeat(N / 532),
    pemBeginChunksOneLine: '-----BEGIN RSA PRIVATE KEY----- ' + 'MIIEabcdefghijklmnop '.repeat(N / 21),
    // D#160 (open): code or a string opener around the line prefix on every BEGIN line, raw and
    // escaped. The fix withdrawn from 6.19.4 read these lines twice; a next attempt must fit here.
    pemCodeBeforeBegin: CHAIN + ' ' + "-KEY = '''-----BEGIN RSA PRIVATE KEY-----\n-abc def\n".repeat(N / 52),
    pemOpenerBeforeBegin: CHAIN + ' ' + "'+-----BEGIN RSA PRIVATE KEY-----\n+\n".repeat(N / 37),
    pemEscapedQuotesBeforeBegin:
      CHAIN + ' ' + JSON.stringify("a'a'a'a'a'a'-----BEGIN RSA PRIVATE KEY-----\n-abc def\n".repeat(N / 55)),
    // v6.19.2 pre-tag defect review F1: a quote then a whitespace run after an escaped break; the
    // continuation pattern split the run between two quantifiers (200k: 16-19 s).
    pemEscapedQuoteSpaces: '-----BEGIN RSA PRIVATE KEY-----\\n"' + ' '.repeat(N) + 'x',
    pemEscapedQuoteTabs: '-----BEGIN RSA PRIVATE KEY-----\\n"' + '\t'.repeat(N) + 'x',
    // BEGINs at alternating escape depths. A since-removed walk back to a string's opening quote,
    // cached by one shared entry, went back to the start of the text for each (200k: 1.6 s).
    pemAlternatingDepths:
      '-----BEGIN RSA PRIVATE KEY-----\\nAb\\n-----BEGIN RSA PRIVATE KEY-----\\\\nAb\\\\n'.repeat(N / 76),
    pemConcatLines:
      '"-----BEGIN RSA PRIVATE KEY-----\\n" +\n' + '  "MIIEabcdefghijklmnop\\n" +\n'.repeat(N / 28),
    jwtLongHyphenPrefix: 'a-'.repeat(N / 2) + 'eyJ' + 'A'.repeat(20),
    jwtDotChain: ('eyJ' + 'A'.repeat(12) + '.').repeat(N / 16),
  };
  // Timed against benign prose of the same length, not a wall-clock bound: a 500 ms bound
  // passed locally (335 ms) and failed on CI under coverage (555 ms). The benign text runs
  // scrubSecrets' 32 passes (the CHAIN prefix), as do pemHeadersNoEnd and chainedWordRun; the
  // other shapes run one, so their budget is ~32x looser than a same-pass comparison, which
  // still separates them (pre-D#130: 55-227x). Measured 2026-09-27 on two machines, crafted /
  // benign: fixed patterns 2.2-3.4x; pre-D#130 pemHeadersNoEnd 20.7-31.7x, chainedWordRun
  // 1,100-1,700x; with the code-label lookaheads removed, chainedWordRun 15.7-16.2x.
  const benign =
    CHAIN + ' ' + 'the quick brown fox jumps over a lazy dog '.repeat(Math.ceil(N / 42)).slice(0, N);
  let benignMs;
  beforeAll(() => {
    scrubSecrets(benign);
    benignMs = Math.max(5, Math.min(...[0, 1, 2].map(() => ms(() => scrubSecrets(benign)))));
  });
  for (const [name, text] of Object.entries(shapes)) {
    it(`${name}: 200k chars within 10x of benign text of the same length`, () => {
      expect(ms(() => scrubSecrets(text)) / benignMs).toBeLessThan(10);
    });
  }

  it('the re-check shape through a report Done stays inside Stop’s budget', () => {
    const db = new Database(':memory:');
    initSchema(db);
    insertSession(db, { id: 's', project: 'p' });
    const done = CHAIN + ' "' + 'password'.repeat(12_500);
    const took = ms(() =>
      writeStopSummary(db, {
        sessionId: 's',
        project: 'p',
        report: { done, notDone: '', lines: '' },
        source: { request: 'r', completed: '' },
        now: new Date('2026-09-27T00:00:00Z'),
        limits: FAST_SUMMARY_LIMITS.stop,
      }),
    );
    expect(db.prepare('SELECT completed FROM session_summaries').get().completed).toContain('token: ***');
    expect(took).toBeLessThan(1500);
    db.close();
  });
});

describe('the linear rewrites still scrub what the old patterns did', () => {
  const jwt =
    'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'SflKxwRJSMeKKF2QT4fw';
  it.each([
    [
      'JSON vendor-prefixed key',
      '{"aws_secret_access_key": "wJalrXUtnFEMI-K7MDENG"}',
      '{"aws_secret_access_key": "***"}',
    ],
    ['single-quoted dict key', "{'my_password': 'hunter2Zq9x'}", "{'my_password': '***'}"],
    ['mixed quotes', `{"x_api_key": 'abcdef123456'}`, `{"x_api_key": '***'}`],
    ['JWT after a space', `auth ${jwt} ok`, 'auth *** ok'],
    ['JWT after =', `jwt=${jwt}`, 'jwt=***'],
    ['JWT after a quote', `"${jwt}"`, '"***"'],
    // v6.19.0 pre-tag review P3-2: `(?<![\w-])` alone stopped these; `\b` had caught them.
    ['JWT glued to a word by a hyphen', `cookie: sess-${jwt}`, 'cookie: sess-***'],
    ['the same at the start of the text', `auth-${jwt} ok`, 'auth-*** ok'],
    // v6.19.0 pre-tag delta review P3-1: several hyphenated words, as \b allowed.
    ['JWT after two hyphenated words', `cookie: my-sess-${jwt}`, 'cookie: my-sess-***'],
    ['JWT after a header-style name', `X-Auth-Token-${jwt}`, 'X-Auth-Token-***'],
    [
      'PEM block',
      'k: -----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY----- ok',
      'k: ***PEM_KEY*** ok',
    ],
    // A header with no body is not key material: it stays, and the complete block after it goes.
    [
      'a later complete PEM block after a stray header',
      '-----BEGIN EC PRIVATE KEY-----\n-----BEGIN EC PRIVATE KEY-----\nMIIEabc\n-----END EC PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----\n***PEM_KEY***',
    ],
    // v6.19.0 pre-tag review P2-1: a body that stopped at the next BEGIN failed to match at
    // all when its own END was missing, so the cut-off key's body was stored. The cut-off body
    // is its whole base64 lines; the text between the two keys stays.
    [
      'a cut-off key body before a later complete block',
      '$ head -c 80 id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\n$ cat id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
      '$ head -c 80 id_rsa\n***PEM_KEY***\n$ cat id_rsa\n***PEM_KEY***',
    ],
    [
      'a key body, then a certificate, then another key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----\n-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEabc\n-----END OPENSSH PRIVATE KEY-----',
      '***PEM_KEY***\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----\n***PEM_KEY***',
    ],
    // 2026-09-28: a key with no END and no later key header was stored whole, in v6.18.0 too
    // (`head id_rsa`, a tool output cut mid-key).
    [
      'a cut-off key at the end of the text',
      'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\nMOREKEYBODYxyz0123456789\n',
      'before\n***PEM_KEY***\n',
    ],
    [
      'a cut-off key followed by prose',
      '-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAAA\r\nMOREKEYBODY==\r\ndone.',
      '***PEM_KEY***\r\ndone.',
    ],
    [
      'an encrypted cut-off key keeps no header line either',
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,3F2A\n\nMIIEowIBAAKCAQEAu1SU\n',
      '***PEM_KEY***\n',
    ],
    [
      'a cut-off key followed only by a certificate',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----',
      '***PEM_KEY***\n-----BEGIN CERTIFICATE-----\nMIIBcert\n-----END CERTIFICATE-----',
    ],
    // `tail key.pem`: the body and the END with no header.
    [
      'a key body and END with no header',
      'ok\n$ tail -2 key.pem\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\nMOREKEYBODY==\n-----END RSA PRIVATE KEY-----\nnext',
      'ok\n$ tail -2 key.pem\n***PEM_KEY***\nnext',
    ],
    [
      'base64 lines that end at no private-key END stay',
      'abc\nMIIBcert\n-----END CERTIFICATE-----\nlines\nof\nwords',
      'abc\nMIIBcert\n-----END CERTIFICATE-----\nlines\nof\nwords',
    ],
    // v6.19.1 pre-tag claims review F1: in text whose line breaks are JSON-escaped (`\n` as two
    // characters: mem_save or import-jsonl of a serialised tool result) the whole-line patterns
    // saw one line, so a cut-off key before a later key, which v6.18.0 and v6.19.0 scrubbed by
    // erasing up to that key, was stored.
    [
      'a JSON-escaped cut-off key before a later complete block',
      '$ head -c 80 id_rsa\\n-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\\n$ cat id_rsa\\n-----BEGIN RSA PRIVATE KEY-----\\nMIIEabc\\n-----END RSA PRIVATE KEY-----',
      '$ head -c 80 id_rsa\\n***PEM_KEY***\\n$ cat id_rsa\\n***PEM_KEY***',
    ],
    [
      'a JSON-escaped cut-off key at the end of a string',
      '{"content": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEF\\r\\nAASCBKcwggSjAgEAAoIBAQC7\\nAbc"}',
      '{"content": "***PEM_KEY***"}',
    ],
    [
      'a JSON-escaped encrypted cut-off key keeps the text after it',
      '"-----BEGIN RSA PRIVATE KEY-----\\nProc-Type: 4,ENCRYPTED\\nDEK-Info: AES-128-CBC,3F2A\\n\\nMIIEowIBAAKCAQEAu1SU\\n", "next": "kept"',
      '"***PEM_KEY***\\n", "next": "kept"',
    ],
    [
      'a JSON-escaped key body and END with no header',
      'x\\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\\nAbc=\\n-----END RSA PRIVATE KEY-----\\nok',
      'x\\n***PEM_KEY***\\nok',
    ],
    [
      'JSON-escaped one-word lines after a key header stay',
      'is -----BEGIN RSA PRIVATE KEY-----\\nThen\\ncomes\\nthe\\nbody.',
      'is -----BEGIN RSA PRIVATE KEY-----\\nThen\\ncomes\\nthe\\nbody.',
    ],
    // v6.19.1 delta review P2: an armored PGP tail ends in a short data line and a `=XXXX`
    // checksum line, two short lines, so the body never reached its END and was stored.
    [
      'a PGP key tail with a short last line and a checksum',
      'x\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\nAbCdEf\n=XyZw\n-----END PGP PRIVATE KEY BLOCK-----\nok',
      'x\n***PEM_KEY***\nok',
    ],
    // delta review P3-1: a header value holding a backslash (a Windows path) ended the body.
    [
      'a cut-off key whose Comment holds a Windows path',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment: C:\\Users\\me\\key.asc\n\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\n',
      '***PEM_KEY***\n',
    ],
    // delta review P3-2: a key cut mid-line before a later key kept the cut line.
    [
      'a key cut mid-line keeps no part of the cut line',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\nlQdGBGW3xq0BEAC7t6uE1oF2gH3jI5kL0mN9bV8c…\n$ cat id_rsa\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
      '***PEM_KEY***…\n$ cat id_rsa\n***PEM_KEY***',
    ],
    // delta review P3-5: blank lines let the one short final line be a word far below the body.
    [
      'a word after blank lines below a cut-off key stays',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\n\n\nThanks',
      '***PEM_KEY***\n\n\nThanks',
    ],
    // delta review P3-3: a quote next to the first or last body line.
    [
      'a JSON string holding a key tail',
      '"MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\\nAbc=\\n-----END RSA PRIVATE KEY-----"',
      '"***PEM_KEY***"',
    ],
    [
      'a single-quoted cut-off key',
      "'-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV\\nAbc'",
      "'***PEM_KEY***'",
    ],
    // v6.19.1 pre-tag review F3: a line of one word matched the body class, so prose after a
    // header and words above an END were erased. A body line is 16+ characters; one shorter
    // line may end the body (a key's last line).
    [
      'one-word lines after a key header stay',
      'The header line is -----BEGIN RSA PRIVATE KEY-----\nThen\ncomes\nthe\nbody.',
      'The header line is -----BEGIN RSA PRIVATE KEY-----\nThen\ncomes\nthe\nbody.',
    ],
    [
      'short lines after a header and a blank line stay',
      'Checklist -----BEGIN OPENSSH PRIVATE KEY-----\n\nStep1\nStep2\n\nDone with it',
      'Checklist -----BEGIN OPENSSH PRIVATE KEY-----\n\nStep1\nStep2\n\nDone with it',
    ],
    [
      'words above a key body and END stay',
      'done\nOK\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\nAbc=\n-----END RSA PRIVATE KEY-----\nnext',
      'done\nOK\n***PEM_KEY***\nnext',
    ],
    [
      'numbers above a key body and END stay',
      'count\n42\n7\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgO\n-----END RSA PRIVATE KEY-----',
      'count\n42\n7\n***PEM_KEY***',
    ],
    // v6.19.0 round-3 P3-3: ending an unterminated key at the next key header erased the prose
    // between two headers named in one sentence.
    [
      'prose naming two key headers',
      'RSA keys start with -----BEGIN RSA PRIVATE KEY----- and EC keys with -----BEGIN EC PRIVATE KEY----- ok',
      'RSA keys start with -----BEGIN RSA PRIVATE KEY----- and EC keys with -----BEGIN EC PRIVATE KEY----- ok',
    ],
    // v6.19.0 round-3 P3-2: past 40 characters of hyphenated prefix the JWT was stored.
    [
      'JWT after a 44-character hyphenated prefix',
      `cookie: session-3f2a9c1e-8b4d-4e2f-9a1b-7c6d5e4f3a2b-${jwt}`,
      'cookie: session-3f2a9c1e-8b4d-4e2f-9a1b-7c6d5e4f3a2b-***',
    ],
    ['JWT after a long path segment', `/tmp/${'a'.repeat(52)}-${jwt} x`, `/tmp/${'a'.repeat(52)}-*** x`],
    ['JWT glued by an underscore', `tok_${jwt}`, 'tok_***'],
    [
      'a dotless eyJ run stays',
      `eyJ-${'a'.repeat(30)}-eyJ${'b'.repeat(30)} ok`,
      `eyJ-${'a'.repeat(30)}-eyJ${'b'.repeat(30)} ok`,
    ],
    // v6.19.0 pre-tag delta review P3-2: ending an unterminated key at ANY later BEGIN erased
    // prose up to a certificate header.
    [
      'a bare key header in prose before a certificate header',
      'Keys start with -----BEGIN RSA PRIVATE KEY----- and certs with -----BEGIN CERTIFICATE----- ok',
      'Keys start with -----BEGIN RSA PRIVATE KEY----- and certs with -----BEGIN CERTIFICATE----- ok',
    ],
  ])('%s', (_name, input, want) => {
    expect(scrubSecrets(input)).toBe(want);
  });
});
