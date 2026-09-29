// D#155 (accepted, not fixed): the complete-block pattern erases everything from a private-key BEGIN
// to the next END, so text naming both markers loses what is between them. Keeping such a block was
// tried for 6.19.3 and withdrawn before the tag: each of the three keep rules measured stored keys
// this pattern erases (docs/audits/20260928-v6.19.3-pretag-*.md). These cases are the leak arm those
// reviews built; a next attempt must pass them unchanged, and must change the last case on purpose.
// It must also add a kept-block shape to secret-scrub-linear.test.mjs: a kept block is re-read on
// every pass of the fixed-point loop (32 under the suite's CHAIN prefix), and two such shapes
// measured 10.6x and 12.6x benign under coverage (review F3).
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrub.mjs';

let seed = 155;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64 = (n) => Array.from({ length: n }, () => B64[Math.floor(rnd() * 64)]).join('');
const bytes = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 256));
const hex2 = (b) => b.toString(16).padStart(2, '0');

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const END = '-----END RSA PRIVATE KEY-----';

describe('D#155 complete blocks: every key goes', () => {
  const SEPARATORS = ['\n', '\r\n', '\r', '\\n', '\\\\n', '<br>', ' ', '\t', ' | '];
  const PREFIXES = ['', '> ', '     2\t', '2→', 'id_rsa:'];
  const HEADERS = [
    [],
    ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,3F2A9C1E', ''],
    ["Comment: ['work', 'home']"],
  ];

  it('leaves no 16-character window of any key line, in 135 line shapes', () => {
    const leaks = [];
    for (const sep of SEPARATORS) {
      for (const pre of PREFIXES) {
        for (const headers of HEADERS) {
          const body = [b64(64), b64(64), b64(64), b64(24)];
          const key = [BEGIN, ...headers, ...body, END].map((l) => pre + l).join(sep);
          const out = scrubSecrets(`Here's the key: ${key} Don't share it.`);
          if (body.some((l) => out.includes(l.slice(4, 20))))
            leaks.push(JSON.stringify([sep, pre, headers[0]]));
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  // No line of these is a 16-character run (round-1 claims review).
  it('takes a key re-wrapped to lines under 16 characters, under a line prefix', () => {
    const leaks = [];
    const body = 'MII' + b64(1597);
    for (const width of [8, 12, 15]) {
      const lines = body.match(new RegExp(`.{1,${width}}`, 'g'));
      for (const pre of ['', '     2\t', '> ']) {
        const out = scrubSecrets([BEGIN, ...lines, END].map((l) => pre + l).join('\n'));
        if (lines.slice(1, -1).some((l) => out.includes(l))) leaks.push(`${width} ${JSON.stringify(pre)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  // Round-1 defect review F1: none of these has a base64 run.
  it('takes a decoded key between the markers: a hex dump, a C byte array, `\\x` escapes', () => {
    const secret = bytes(32);
    const dumpLines = [secret.slice(0, 15), secret.slice(15, 30), secret.slice(30)].map(
      (row) => `    ${row.map(hex2).join(':')}:`,
    );
    const shapes = {
      // `head -1 k.pem; openssl pkey -noout -text -in k.pem; tail -1 k.pem`
      pkeyText: [
        '-----BEGIN PRIVATE KEY-----',
        'ED25519 Private-Key:',
        'priv:',
        ...dumpLines,
        '-----END PRIVATE KEY-----',
      ].join('\n'),
      pkeyTextOneLine: `-----BEGIN PRIVATE KEY----- priv: ${secret.map(hex2).join(':')} -----END PRIVATE KEY-----`,
      cArray: `/* ${BEGIN} */ static const uint8_t k[] = { ${secret.map((b) => `0x${hex2(b)}`).join(', ')} }; /* ${END} */`,
      pyBytes: `"${BEGIN}" + b"${secret.map((b) => `\\x${hex2(b)}`).join('')}" + "${END}"`,
    };
    const hexWindows = [secret.slice(4, 10), secret.slice(20, 26)].map((row) => row.map(hex2));
    for (const [name, text] of Object.entries(shapes)) {
      const out = scrubSecrets(text).toLowerCase();
      for (const w of hexWindows) {
        expect(
          out.includes(w.join(':')) || out.includes(w.join(', 0x')) || out.includes(w.join('\\x')),
          name,
        ).toBe(false);
      }
      expect(out, name).toContain('***pem_key***');
    }
  });

  // Round-1 F2 and round-2 F1: a headerless key tail, then marker text, then a stray END. A kept
  // marker block stood between the tail and the END's line, and the tail scan stopped at it.
  it('takes a key tail above marker text and a stray END', () => {
    const lines = [b64(64), b64(64), b64(64), b64(30)];
    for (const marker of [
      '-----BEGIN PRIVATE KEY----- a b\nc d -----END PRIVATE KEY----- -----END RSA PRIVATE KEY-----',
      '-----BEGIN PRIVATE KEY----- a b c d -----END PRIVATE KEY----- -----END RSA PRIVATE KEY-----',
    ]) {
      const out = scrubSecrets(`${lines.join('\n')}\n${marker}`);
      expect(lines.filter((l) => out.includes(l))).toEqual([]);
    }
  });

  it('takes a placeholder body', () => {
    for (const body of ['MIIEabc', 'MIIFDjBA...secret...', 'YOUR-ORGS-VALIDATION-KEY-HERE', '']) {
      expect(scrubSecrets(`k: ${BEGIN}\n${body}\n${END} ok`)).toBe('k: ***PEM_KEY*** ok');
    }
  });

  // The known limit D#155 is about. A change here is the next attempt, and must be made on purpose.
  it('text naming both markers still loses the text between them', () => {
    expect(scrubSecrets(`Keys start with ${BEGIN} and end with ${END} in PEM files.`)).toBe(
      'Keys start with ***PEM_KEY*** in PEM files.',
    );
  });
});
