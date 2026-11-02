// D#145: cut-off private keys and key tails, across the line shapes a key reaches the scrubber in.
// Three review rounds of v6.19.1 each found a shape the regex versions misread, and each fix to one
// shape erased prose in another, so this file judges both directions on one matrix:
//   - the leak arm: 4 key kinds x 4 cuts x 13 line shapes x 3 followers, no key line may survive;
//   - the prose arm: the review rounds' prose, code and path fixtures keep their text.
// Measured 2026-09-28 with v6.19.1's scrubber: 378 of the 624 matrix cases leaked (12 of the 16
// kind/cut groups fail), and 13 of the 21 prose fixtures lost text.
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrub.mjs';

// Deterministic base64 lines, so a leaked window cannot collide with the surrounding prose.
let seed = 20260928;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64 = (n) => Array.from({ length: n }, () => B64[Math.floor(rnd() * 64)]).join('');
// A fixed 65-character key line for the single cases below.
const KL = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV';

const KEYS = {
  rsa: {
    begin: '-----BEGIN RSA PRIVATE KEY-----',
    headers: [],
    body: [b64(64), b64(64), b64(64), b64(64), b64(20)],
    end: '-----END RSA PRIVATE KEY-----',
  },
  encrypted: {
    begin: '-----BEGIN RSA PRIVATE KEY-----',
    headers: ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,3F2A9C1E', ''],
    body: [b64(64), b64(64), b64(64), b64(64), b64(40)],
    end: '-----END RSA PRIVATE KEY-----',
  },
  openssh: {
    begin: '-----BEGIN OPENSSH PRIVATE KEY-----',
    headers: [],
    body: [b64(70), b64(70), b64(70), b64(70), b64(12)],
    end: '-----END OPENSSH PRIVATE KEY-----',
  },
  // A Windows path whose segments start with n (round-3 P3-E), an RFC 4880 header the old
  // pattern did not list (P3-F), a short last data line and a checksum (delta review P2).
  pgp: {
    begin: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    headers: ['Comment: C:\\Users\\nick\\key.asc', 'MessageID: 3f2a9c1e', ''],
    body: [b64(64), b64(64), b64(64), b64(64), b64(6), `=${b64(4)}`],
    end: '-----END PGP PRIVATE KEY BLOCK-----',
  },
};

const CUTS = {
  head: (k) => [k.begin, ...k.headers, ...k.body.slice(0, 3)],
  cutMidLine: (k) => [k.begin, ...k.headers, ...k.body.slice(0, 2), `${k.body[2].slice(0, 40)}…`],
  tail: (k) => [...k.body.slice(-4), k.end],
  whole: (k) => [k.begin, ...k.headers, ...k.body, k.end],
};

const J = (s) => JSON.stringify(s);
const numbered = (ls) => ls.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n');
const SHAPES = {
  lf: (ls) => ls.join('\n'),
  crlf: (ls) => ls.join('\r\n'),
  loneCr: (ls) => ls.join('\r'),
  json: (ls) => `{"type":"tool_result","content":${J(ls.join('\n'))}}`,
  jsonTwice: (ls) => J(`{"content":${J(ls.join('\n'))}}`),
  readTool: numbered,
  readToolArrow: (ls) => ls.map((l, i) => `${i + 1}→${l}`).join('\n'),
  grep: (ls) => ls.map((l) => `id_rsa:${l}`).join('\n'),
  grepContext: (ls) => ls.map((l, i) => `keys/id_rsa-${i + 1}-${l}`).join('\n'),
  quote: (ls) => ls.map((l) => `> ${l}`).join('\n'),
  diff: (ls) => ls.map((l) => `-${l}`).join('\n'),
  jsConcat: (ls) => `const k =\n${ls.map((l) => `  "${l.replace(/\\/g, '\\\\')}\\n" +`).join('\n')}\n  "";`,
  jsonReadTool: (ls) => `{"content":${J(numbered(ls))}}`,
  // An escaped CRLF is one break (v6.19.4 pre-tag defect review F4: nothing pinned it).
  jsonCrlf: (ls) => `{"content":${J(ls.join('\r\n'))}}`,
};

const PROSE = 'Thanks, that was the key.';
const FOLLOWERS = {
  none: '',
  prose: PROSE,
  laterKey: `$ cat other\n-----BEGIN EC PRIVATE KEY-----\n${b64(64)}\n-----END EC PRIVATE KEY-----`,
};

describe('a cut-off key or key tail leaves no key line, in every line shape', () => {
  for (const [kind, key] of Object.entries(KEYS)) {
    // Every 16+ line is checked at both ends; a short line only where the cut keeps it whole.
    const long = key.body.filter((l) => l.length >= 16).flatMap((l) => [l.slice(0, 16), l.slice(-16)]);
    const short = key.body.filter((l) => l.length < 16);
    for (const [cutName, cut] of Object.entries(CUTS)) {
      it(`${kind} / ${cutName}`, () => {
        const failures = [];
        for (const [shapeName, shape] of Object.entries(SHAPES)) {
          for (const [followName, follow] of Object.entries(FOLLOWERS)) {
            const lines = ['$ head id_rsa', ...cut(key), ...(follow ? follow.split('\n') : [])];
            const out = scrubSecrets(shape(lines));
            const kept = long.filter((w) => out.includes(w));
            if (cutName === 'tail' || cutName === 'whole') kept.push(...short.filter((w) => out.includes(w)));
            if (kept.length) failures.push(`${shapeName}/${followName}: ${kept.length} key windows kept`);
            if (!out.includes('$ head id_rsa')) failures.push(`${shapeName}/${followName}: text before lost`);
            if (follow === PROSE && !out.includes(PROSE))
              failures.push(`${shapeName}/${followName}: prose lost`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  }
});

describe('prose, code and paths next to a key marker keep their text', () => {
  const H = '-----BEGIN RSA PRIVATE KEY-----';
  const E = '-----END RSA PRIVATE KEY-----';
  const PH = '-----BEGIN PGP PRIVATE KEY BLOCK-----';
  const L = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunV';
  it.each([
    // round-3 P3-A: a quote could end a short last line, so a contraction lost its first word.
    [
      'a contraction after a key body',
      `$ head -3 id_rsa\n${H}\n${L}\n${L}\nDon't paste keys into chat.`,
      ["Don't paste keys into chat."],
    ],
    ['the same in JSON', `{"c": "${H}\\n${L}\\nIt's cut here"}`, ["It's cut here"]],
    // round-3 P3-B: a long line did not have to be whole, so a line's leading token went.
    [
      'a path under a header',
      `${H}\n/usr/local/etc/ssh/keys/host.key: permission denied`,
      ['/usr/local/etc/ssh/keys/host.key: permission denied'],
    ],
    [
      'a long word under a header',
      `${H}\nInternationalization errors follow`,
      ['Internationalization errors follow'],
    ],
    [
      'a setext rule under a body',
      `${H}\n${L}\n================ end of key ================`,
      ['================ end of key'],
    ],
    [
      'an identifier under a body',
      `${H}\n${L}\nexportedArmoredPrivateKey = armor + body;`,
      ['exportedArmoredPrivateKey = armor + body;'],
    ],
    [
      'this repo’s own test source',
      `    a: '${PH}\\nComment:' + ' '.repeat(N) + '\\\\x',\n    pemHeaderSpacesLoneCr: '${PH}\\nComment:' + ' '.repeat(N) + '\\rx',`,
      ['pemHeaderSpacesLoneCr', "' '.repeat(N)"],
    ],
    // round-3 P3-C: a header value ran across escapes into the next JSON fields.
    [
      'JSON fields after a header value',
      `{"preview": "${PH}\\nComment: x", "table": "a\\tb\\tc", "keep": "yes"}`,
      ['"table": "a\\tb\\tc"', '"keep": "yes"'],
    ],
    [
      'code after a header value',
      `const armor = "${PH}\\nComment: \\"" + comment + "\\"";\nexportedArmoredPrivateKey = armor + body;`,
      ['+ comment +', 'exportedArmoredPrivateKey = armor + body;'],
    ],
    // round-3 P3-D: two short lines were allowed before any END.
    ['two short words above an END', `intro\n${L}\nOK\nyes\n${E}\nafter`, ['OK\nyes']],
    ['the same after a quote', `She wrote 'SomethingVeryLongHere\nok\nyes\n${E}`, ['She wrote', 'ok\nyes']],
    // delta review P3-5: a 16-39 character token alone under a header is not a key.
    [
      'a short path alone under a header',
      `${H}\n/usr/local/bin/somethinglong`,
      ['/usr/local/bin/somethinglong'],
    ],
    ['an identifier alone in JSON', `"${H}\\nsomeIdentifierNameHere22"`, ['someIdentifierNameHere22']],
    [
      'a Version line and prose',
      `${PH}\nVersion: 2 released today\nMore notes follow here.`,
      ['More notes follow here.'],
    ],
    ['a word below blank lines', `${H}\n${L}\n\n\nThanks`, ['Thanks']],
    [
      'prose after a header line',
      `A PEM file starts with ${H}\nand then base64 lines follow.`,
      ['and then base64 lines follow.'],
    ],
    // A comma is not a string continuation: the next element's first word is not the key's last line.
    [
      'a list element after an escaped key string',
      `['${H}\\n${L}\\n',\n  'before\\nthe next one']`,
      ["'before"],
    ],
    ['a table row above an END', `| a | b |\n${E}\n| c | d |`, ['| a | b |', '| c | d |']],
    [
      'a hash above an END',
      `sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n${E}`,
      ['sha256: e3b0c442'],
    ],
    // Only RFC 1421 / 4880 armor header names count: `Note:` is prose, and with it taken for a
    // header a lone 16+ line counted as a key (v6.19.2 pre-tag claims review M7).
    [
      'a Note line and a short path under a header',
      `${PH}\nNote: see below\n/usr/local/bin/somethinglong`,
      ['Note: see below', '/usr/local/bin/somethinglong'],
    ],
    // After the one short last line, a second short line stays unless it is a PGP checksum.
    ['a short word after the short last line', `${H}\n${L}\n${L}\nAbc\nok\nmore`, ['\nok\nmore']],
  ])('%s', (_name, input, keep) => {
    const out = scrubSecrets(input);
    expect(keep.filter((k) => !out.includes(k))).toEqual([]);
  });
});

describe('single-shape rules the matrix does not isolate', () => {
  it.each([
    // Armor headers are key evidence: one base64 line of 16-39 characters after them is a key.
    [
      'an encrypted key cut after one short line',
      `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,3F2A9C1E\n\nxCzbaDuwW6fHijaPmD0Ema1E8pjlz/\nok`,
      'xCzbaDuwW6fHijaPmD0Ema1E8pjlz/',
    ],
    // grep prints `file:` on a matching line and `file-` on a context line.
    [
      'grep context lines under a matching header line',
      `f.pem:-----BEGIN RSA PRIVATE KEY-----\nf.pem-${b64(64)}\nf.pem-${'MIIj' + b64(60)}`,
      'MIIj',
    ],
    // v6.19.2 pre-tag defect review F3: the string's opening quote is found before the line the
    // BEGIN is on, so a single-quoted string (a Python repr, `echo -e '…'`) ends at its quote.
    [
      'a key in a single-quoted Python repr',
      // The last line is 16+: a quote after a base64 run ends a cut line. A last line of 15 or
      // fewer followed by more fields is a documented limit.
      `{'stdout': '$ head id_rsa\\n-----BEGIN RSA PRIVATE KEY-----\\n${KL}\\n${KL}\\nZq9Xw2LkPm4Rt7Yb1Nc6', 'rc': 0}`,
      'Zq9Xw2LkPm4Rt7Yb1Nc6',
    ],
    // F4: text after the key's last line — a closing backtick or tag, a truncation note, words.
    [
      'an Ed25519 key in inline code',
      '`-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIHh6d3Jjb3ZqZ2xpbmtlcnM0NTY3ODkwYWJjZGVm`',
      'MC4CAQAwBQYDK2Vw',
    ],
    // A 40+ last line goes as a cut line whatever follows it; a short one needs the delimiter gone.
    [
      'a key in an XML element',
      `<key>-----BEGIN RSA PRIVATE KEY-----\n${KL}\n${KL}\nZq9Xw2Lk</key>`,
      'Zq9Xw2Lk',
    ],
    ['a key in a code span', `\`-----BEGIN RSA PRIVATE KEY-----\n${KL}\n${KL}\nZq9Xw2Lk\``, 'Zq9Xw2Lk'],
    [
      'a key line followed by words',
      `-----BEGIN RSA PRIVATE KEY-----\n${'MIIk' + KL.slice(4)} see above`,
      'MIIk',
    ],
    [
      'a cut line followed by a truncation note',
      `-----BEGIN RSA PRIVATE KEY-----\n${KL}\n${'MIIk' + KL.slice(4, 30)}[truncated]`,
      'MIIk',
    ],
    // F10: current gpg writes no Version header, so a PGP key cut in its first line has only the
    // packet start (`lQ…`, `xc…`) to go on.
    // F7's other side: key lines over an END named in a sentence still go (the sentence stays).
    [
      'key lines over an END in a sentence',
      `$ tail -3 key.pem\\n${KL}\\n${'MIIk' + KL.slice(4)}\\nA PEM file ends with ${'-----END RSA PRIVATE KEY-----'}.`,
      'MIIk',
    ],
    [
      'a PGP key cut inside its first line',
      '$ head -c 70 key.asc\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQVYBGW3kXcBDADC5y1cG8fQ9oRk2m',
      'lQVYBGW3',
    ],
  ])('%s', (_name, input, keyPart) => {
    expect(scrubSecrets(input)).not.toContain(keyPart);
  });
});

describe('v6.19.2 pre-tag defect review: prose and robustness', () => {
  const H = '-----BEGIN RSA PRIVATE KEY-----';
  const E = '-----END RSA PRIVATE KEY-----';
  it.each([
    // F5: the block pattern ran again on a later pass and paired an early BEGIN with a later END
    // across the mark it had written for a key in between.
    [
      'prose between a BEGIN, a scrubbed key and a later END',
      `Keys start with ${H} on their own line.\nIMPORTANT PROSE ONE.\n$ cat k\n${H}\n${KL}\n${E}\nIMPORTANT PROSE TWO.\nintro\n${KL}\nOK\nyes\n${E}\nafter`,
      ['IMPORTANT PROSE ONE.', 'IMPORTANT PROSE TWO.'],
    ],
    // F7: an END in the middle of a sentence is not the end of a key tail.
    [
      'an END in a sentence under an identifier',
      `Run the migration:\nnpmRunBuildAndTestEverything\nA PEM file ends with ${E} and nothing else.`,
      ['npmRunBuildAndTestEverything', 'A PEM file ends with'],
    ],
    [
      'an END in inline code under an identifier',
      `readPrivateKeyFromFile\n\`${E}\` marks the end.`,
      ['readPrivateKeyFromFile'],
    ],
    // Key lines over such an END go, and the sentence stays.
    [
      'the sentence naming an END under key lines',
      `${KL}\n${KL}\nA PEM file ends with ${E}.`,
      [`A PEM file ends with ${E}.`],
    ],
    // F9: words on the BEGIN line are prose, even one of 16+ letters.
    [
      'prose on the BEGIN line',
      `${H} usually indicates misconfiguration\nAuthenticationFailedException\nnext`,
      ['usually indicates misconfiguration', 'AuthenticationFailedException'],
    ],
  ])('%s', (_name, input, keep) => {
    const out = scrubSecrets(input);
    expect(keep.filter((k) => !out.includes(k))).toEqual([]);
  });

  // F2: a spread of ~125k chunks overflowed the stack, and scrubSecrets threw instead of returning.
  it('a BEGIN line with 150k chunks returns', () => {
    expect(() => scrubSecrets(`${H} ${'A '.repeat(150_000)}\n`)).not.toThrow();
  });
});

describe('v6.19.2 pre-tag delta review', () => {
  const H = '-----BEGIN RSA PRIVATE KEY-----';
  const E = '-----END RSA PRIVATE KEY-----';
  const B = 'MIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
  const X = 'Xq9ZbT2kLp8WvR4nYc7MfH1sJd6GaU3eQo5iKx0wBzNtVy';
  it.each([
    // F1: an apostrophe in prose earlier in a JSON string ("Here's") is not the string's opening
    // quote; taking it let the closing `"` through and made `'` end the string.
    [
      'a cut-off key in a JSON string after an apostrophe',
      JSON.stringify({
        stdout: `Here's the head:\n${H}\n${B}\n${X.slice(0, 30)}`,
        stderr: '',
        interrupted: false,
      }),
      [X.slice(0, 30)],
    ],
    [
      'a PGP key with an apostrophe in its Comment, after an apostrophe',
      JSON.stringify({
        stdout: `Here's it:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment: Alice's key\n\nlQdGBF${X}\n${X}${X}`,
        stderr: '',
      }),
      [`lQdGBF${X}`, X.slice(0, 20)],
    ],
    // F2: a log prefix with spaces on every line, the END line included, is a line prefix.
    [
      'a key tail in docker compose logs',
      `web-1  | ${X}\nweb-1  | ${X}\nweb-1  | abc=\nweb-1  | ${E}\nweb-1  | listening`,
      [X],
    ],
    [
      'a key tail in syslog lines',
      `Sep 28 12:00:01 host app[1]: ${X}\nSep 28 12:00:01 host app[1]: ${X}\nSep 28 12:00:02 host app[1]: ${E}`,
      [X],
    ],
    ['a key tail in a nested mail quote', `> > ${X}\n> > ${X}\n> > ${E}`, [X]],
    // F3: `tail -n 2` of a key whose last line is 16-39 characters, over an END on its own line.
    ['a one-line key tail of 30 characters', `${X.slice(0, 30)}\n${E}\n`, [X.slice(0, 30)]],
    ['a one-line key tail of 16 characters', `$ tail -n 2 k.pem\n${X.slice(0, 16)}\n${E}`, [X.slice(0, 16)]],
    // F4: RFC 1421 headers beyond the common ones, and tool-written `X-` headers.
    [
      'a Content-Domain header before the body',
      `${H}\nProc-Type: 4,ENCRYPTED\nContent-Domain: RFC822\nDEK-Info: AES-128-CBC,ABCDEF0123456789\n\n${B}\n${B}`,
      [B],
    ],
    ['an X- header before the body', `${H}\nX-Custom: foo\n\n${B}\n${B}`, [B]],
  ])('%s', (_name, input, keyParts) => {
    const out = scrubSecrets(input);
    expect(keyParts.filter((k) => out.includes(k))).toEqual([]);
  });

  it.each([
    // The F2 repair must not make a sentence naming an END a prefix: the line above has no such prefix.
    [
      'a sentence END under an identifier',
      `Run the migration:\nnpmRunBuildAndTestEverything\nA PEM file ends with ${E} and nothing else.`,
      ['npmRunBuildAndTestEverything', 'A PEM file ends with'],
    ],
    // The F3 repair needs a clean END line: an END in inline code followed by words is not one.
    [
      'an END in inline code under an identifier',
      `readPrivateKeyFromFile\n\`${E}\` marks the end.`,
      ['readPrivateKeyFromFile'],
    ],
    // Both halves of a clean END line are needed: nothing before it, and nothing after it.
    [
      'an END at a line start followed by words',
      `readPrivateKeyFromFile\n${E} marks the end.`,
      ['readPrivateKeyFromFile'],
    ],
    ['an END in a code span on its own line', `readPrivateKeyFromFile\n\`${E}\``, ['readPrivateKeyFromFile']],
    // The F1 repair: a Python repr still ends at its single quote.
    ['a Python repr after the key', `{'stdout': '${H}\\n${B}\\n${B}\\nZq9Xw2Lk', 'rc': 0}`, ["'rc': 0"]],
  ])('%s keeps its text', (_name, input, keep) => {
    const out = scrubSecrets(input);
    expect(keep.filter((k) => !out.includes(k))).toEqual([]);
  });
});

describe('v6.19.2 pre-tag round-3 review', () => {
  const H = '-----BEGIN RSA PRIVATE KEY-----';
  const PH = '-----BEGIN PGP PRIVATE KEY BLOCK-----';
  const E = '-----END RSA PRIVATE KEY-----';
  const B = 'MIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
  const X = 'Xq9ZbT2kLp8WvR4nYc7MfH1sJd6GaU3eQo5iKx0wBzNtVy';
  const X30 = X.slice(0, 30);
  it.each([
    // F1: a string opened after a letter (`b'`, `r'`, `$'`). No quote is tracked now: a quote
    // after a base64 run ends a cut line, and a quote in an armor value ends nothing.
    ['a communicate() tuple', `(b'${H}\\n${B}\\n${X30}', b'')`, [X30]],
    [
      'a communicate() tuple with a quoted Comment',
      `(b'${PH}\\nComment: "work key"\\n\\nlQdGBF${X}\\n${X}${X}', b'')`,
      [`lQdGBF${X}`, X.slice(0, 20)],
    ],
    ['a raw string', `r'${H}\\n${B}\\n${X30}', 'x'`, [X30]],
    ['an ANSI-C shell string', `echo $'${H}\\n${B}\\n${X30}' > k`, [X30]],
    // F2: a quoted word earlier in the string (`'head id_rsa'`, `cat('k')`).
    [
      'a JSON string after a quoted word',
      JSON.stringify({ stdout: `Run 'head id_rsa':\n${H}\n${B}\n${X30}`, stderr: '', interrupted: false }),
      [X30],
    ],
    [
      'a PGP key with an apostrophe, after a quoted word',
      JSON.stringify({
        stdout: `File 'k.asc':\n${PH}\nComment: Alice's key\n\nlQdGBF${X}\n${X}${X}`,
        stderr: '',
      }),
      [`lQdGBF${X}`, X.slice(0, 20)],
    ],
    // F6: a tail whose END a closing tag follows.
    ['a key tail in an XML element', `<key>\n${X30}\n${E}</key>`, [X30]],
  ])('%s', (_name, input, keyParts) => {
    const out = scrubSecrets(input);
    expect(keyParts.filter((k) => out.includes(k))).toEqual([]);
  });

  it.each([
    // F3: over an END alone on its line, one line counts as a key's last line only when it has a
    // digit, a `+` or `=` padding; a camelCase identifier or a path has none.
    [
      'an identifier over a lone END',
      `const name = 'x';\nreadPrivateKeyFromFileSync\n${E}\n`,
      ['readPrivateKeyFromFileSync'],
    ],
    ['a path over a lone END', `src/components/SignInButton\n${E}\n`, ['src/components/SignInButton']],
    [
      'an identifier in Read-tool lines',
      `     1\treadPrivateKeyFromFile\n     2\t${E}\n`,
      ['readPrivateKeyFromFile'],
    ],
    [
      'an identifier in grep -n lines',
      `a.js:10:loadPemFileFromDiskNow\na.js:11:${E}`,
      ['loadPemFileFromDiskNow'],
    ],
    [
      'an identifier in docker logs',
      `web-1  | loadPemFileFromDiskNow\nweb-1  | ${E}\n`,
      ['loadPemFileFromDiskNow'],
    ],
    [
      'an identifier in a JSON string',
      JSON.stringify({ s: `loadPemFileFromDiskNow\n${E}\n` }),
      ['loadPemFileFromDiskNow'],
    ],
  ])('%s keeps its text', (_name, input, keep) => {
    const out = scrubSecrets(input);
    expect(keep.filter((k) => !out.includes(k))).toEqual([]);
  });
});

describe('v6.19.2 pre-tag round-4 review', () => {
  const H = '-----BEGIN RSA PRIVATE KEY-----';
  const PH = '-----BEGIN PGP PRIVATE KEY BLOCK-----';
  const E = '-----END RSA PRIVATE KEY-----';
  const B = 'MIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
  const B2 = 'Kq8xLmN3vB7cZ2dF9gH1jK4lP6oI8uY0tR5eW3qA2sD7fG9hJ1kL3zX5cV8bN0mQ';
  const P1 = 'lQdGBFXq9ZbT2kLp8WvR4nYc7MfH1sJd6GaU3eQo5iKx0wBzNtVy';
  const L30 = 'Xq9ZbT2kLp8WvR4nYc7MfH1sJd6GaU';
  it.each([
    // F1: a cut line after a blank line (PGP and encrypted PEM put one before the body) ended the
    // scan before it was read, so the whole key was stored.
    ['a PGP head in a JSON string', JSON.stringify({ stdout: `${PH}\n\n${P1}`, stderr: '' }), [P1]],
    [
      'an encrypted PEM head in a JSON string',
      JSON.stringify({
        stdout: `${H}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\n${B}`,
        stderr: '',
      }),
      [B],
    ],
    ['a PGP head in a Python repr', `{'stdout': '${PH}\\n\\n${P1}', 'rc': 0}`, [P1]],
    [
      'a double-spaced body in a JSON string',
      JSON.stringify({ stdout: `${H}\n\n${B}\n\n${B2}`, rc: 0 }),
      [B, B2],
    ],
    ['a PGP head cut with a truncation note', `${PH}\n\n${P1} [truncated]\n`, [P1]],
    // F2: a string two escapes deep ends at `\"`.
    [
      'a key in JSON inside JSON',
      JSON.stringify({ content: JSON.stringify({ stdout: `${H}\n${B}\n${B2}\n${L30}`, rc: 0 }) }),
      [L30],
    ],
    // F3: a closing tag after the END, then a quote, a comma or another tag.
    ['a key tail in XML inside a JSON string', JSON.stringify({ x: `<key>\n${L30}\n${E}</key>` }), [L30]],
    ['a key tail in nested tags', `<pre><code>\n${L30}\n${E}</code></pre>\n`, [L30]],
  ])('%s', (_name, input, keyParts) => {
    const out = scrubSecrets(input);
    expect(keyParts.filter((k) => out.includes(k))).toEqual([]);
  });

  // Round-5 F1: the round-4 F4 stop (a closing quote then a field in a header line) also fired
  // inside header values (`Comment: ['work', 'home']`) and stored the whole key; it is gone.
  it.each([
    [
      'a JSON string',
      (body) => JSON.stringify({ stdout: `${PH}\nComment: ['work', 'home']\n\n${body}`, rc: 0 }),
    ],
    [
      'a Python repr',
      (body) => `{'stdout': '${PH}\\nComment: say "hi", "bye"\\n\\n${body.replace(/\n/g, '\\n')}', 'rc': 0}`,
    ],
  ])('a quoted, comma-separated Comment in %s', (_name, wrap) => {
    const out = scrubSecrets(wrap(`${P1}\n${B2}\n${B}`));
    expect([P1, B2, B].filter((k) => out.includes(k))).toEqual([]);
  });
});

describe('v6.19.2 pre-tag round-5 review', () => {
  const PH = '-----BEGIN PGP PRIVATE KEY BLOCK-----';
  const E = '-----END RSA PRIVATE KEY-----';
  const P1 = 'lQdGBFXq9ZbT2kLp8WvR4nYc7MfH1sJd6GaU3eQo5iKx0wBzNtVy';
  const B2 = 'Kq8xLmN3vB7cZ2dF9gH1jK4lP6oI8uY0tR5eW3qA2sD7fG9hJ1kL3zX5cV8bN0mQ';
  const L30 = 'Xq9ZbT2kLp8WvR4nYc7MfH1sJd6GaU';
  // F2: the same key cut the same way and glued 40 times. Each BEGIN took the previous key's cut
  // line for its line prefix and stripped its own body line with it, so one key went per pass.
  // A cut run glued to the next key's BEGIN (`for i in …; do head -c 80 k; done`): five dashes
  // after a base64 run are a key marker, never prose.
  it('a short cut run glued to the next BEGIN goes', () => {
    const input = `${PH}\n\n${P1}`.slice(0, 70).repeat(3);
    expect(scrubSecrets(input)).not.toContain(P1.slice(0, 20));
  });
  it('40 glued copies of one cut key all go in one call', () => {
    const input = `${PH}\n\n${P1}${B2}`.slice(0, 90).repeat(40);
    const out = scrubSecrets(input);
    expect(out).not.toContain(P1.slice(0, 20));
    expect(scrubSecrets(out)).toBe(out);
  });
  // F3: `tail -n 2` in a tool result whose next field follows the string: the END is alone on
  // its line in the decoded text, and a string's closing quote after it says so.
  it.each([
    [
      'a Bash tool result',
      JSON.stringify({ stdout: `$ tail -n 2 k.pem\n${L30}\n${E}`, stderr: '', interrupted: false }),
    ],
    ['a repr with more fields', `{'stdout': '$ tail -n 2 k.pem\\n${L30}\\n${E}', 'rc': 0}`],
  ])('a key tail in %s', (_name, input) => {
    expect(scrubSecrets(input)).not.toContain(L30);
  });
});

describe('v6.19.4 pre-tag reviews', () => {
  // Read as a break and then an empty line, an escaped CRLF put a blank line before the key's short
  // last line, which a blank line ends the key before (defect review F4, mutant M34).
  it('an escaped CRLF before the short last line of a cut key', () => {
    const [l1, l2, last] = [`MIIE${b64(60)}`, b64(64), b64(14)];
    const lines = ['-----BEGIN RSA PRIVATE KEY-----', l1, l2, last];
    const out = scrubSecrets(JSON.stringify({ content: `${lines.join('\r\n')}\r\n` }));
    expect(out).not.toContain(last);
  });
});

// D#167: a cut key whose one full line is 16-39 characters, under an opener whose prefix does
// not match the `+` diff lines below it (`'+`, `rb'+`, `+KEY = '''`). The line keeps its `+`,
// so the key-magic test saw `+MHcC…` and the line was stored. A plain `+` prefix was erased.
describe('a short first key line under a quote-plus opener', () => {
  const line = `+MHcCAQEEIB${b64(17)}`;
  it.each([
    ['a plain diff prefix', '+-----BEGIN EC PRIVATE KEY-----'],
    ['a quote-plus opener', "x = '+-----BEGIN EC PRIVATE KEY-----"],
    ['a bytes-literal opener', "rb'+-----BEGIN EC PRIVATE KEY-----"],
    ['a triple-quote opener', "+KEY = '''-----BEGIN EC PRIVATE KEY-----"],
  ])('%s', (_name, begin) => {
    expect(line.length - 1, 'premise: 16-39 characters after the diff mark').toBeLessThan(40);
    expect(scrubSecrets(`${begin}\n${line}…`)).not.toContain(line.slice(1, 20));
  });
  // The other direction: a `+` line that does not start with a key magic stays.
  it('keeps a short base64 line with no key magic', () => {
    const plain = `+QUJD${b64(23)}`;
    expect(scrubSecrets(`x = '+-----BEGIN EC PRIVATE KEY-----\n${plain}…`)).toContain(plain);
  });
});

// D#504 F1: one cut key line of 16-39 characters counts as key material only when it starts the
// way a key encoding starts, and that test was a list of five prefixes. The DER headers below are
// from keys OpenSSL 3.5.5 generated on 2026-10-20 (`openssl ecparam -genkey`, `openssl genpkey`,
// `openssl pkcs8 -topk8`); none of them is on the list, so a first line cut to 16-39 characters
// was stored.
describe('a short first key line of a key type the prefix list missed', () => {
  it.each([
    ['secp256k1 SEC1', 'MHQCAQEEI'],
    ['P-521 SEC1', 'MIHcAgEBBEI'],
    ['P-521 PKCS#8', 'MIHuAgEAMBA'],
    ['brainpoolP512r1 SEC1', 'MIHaAgEBBEA'],
    ['brainpoolP256r1 SEC1', 'MHgCAQEEI'],
    ['secp224r1 SEC1', 'MGgCAQEEH'],
    ['secp224r1 PKCS#8', 'MHgCAQAwEAY'],
    ['prime192v1 SEC1', 'MF8CAQEEG'],
    ['Ed448 PKCS#8', 'MEcCAQAwBQY'],
    ['X448 PKCS#8', 'MEYCAQAwBQY'],
  ])('%s', (_name, header) => {
    for (const len of [16, 28, 39]) {
      const line = header + b64(len - header.length);
      for (const begin of ['-----BEGIN EC PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----']) {
        expect(scrubSecrets(`$ head -c 60 k.pem\n${begin}\n${line}`), `${len} chars`).not.toContain(line);
        expect(scrubSecrets(`${begin}\n${line}…`), `${len} chars, cut mark`).not.toContain(line);
        expect(scrubSecrets(`+${begin}\n+${line}`), `${len} chars, diff`).not.toContain(line.slice(0, 16));
      }
      // The key-tail reading asks the same question of the top line over an END that words follow.
      const tail = `${line}\n-----END EC PRIVATE KEY----- (see above)`;
      expect(scrubSecrets(tail), `${len} chars over an END`).not.toContain(line);
    }
  });
  // The other direction: words in the base64 alphabet that start with M and are no DER header stay.
  it.each(['MaintenanceWindowConfig', 'MHQCAndOtherNotes', 'MEYCHANGELOGENTRY2026', 'MAXRETRIESEXCEEDED'])(
    'keeps %s',
    (word) => {
      const text = `-----BEGIN EC PRIVATE KEY-----\n${word}\nmore notes`;
      expect(scrubSecrets(text)).toContain(word);
    },
  );
});

// D#169 (a crafted run of blank lines after armor-header BEGINs read slowly) was attempted twice for
// v6.30.0 and withdrawn: each attempt stopped reading after 16 blank lines in some case, and a cut key
// below 17 or more blank lines was stored where v6.29.3 erased it (pre-tag reviews r1 and r2). These
// shapes pin the erasing side for whatever fixes D#169 next.
describe('blank lines between a BEGIN and a cut key body', () => {
  const body = [b64(64), b64(64), `${b64(40)}…`];
  const windows = body.flatMap((l) => [l.slice(0, 16), l.slice(-17, -1)]);
  for (const blanks of [16, 17, 20, 40]) {
    for (const [eol, sep] of [
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ]) {
      it(`${blanks} blank lines, ${eol}`, () => {
        const text = ['-----BEGIN RSA PRIVATE KEY-----', ...Array(blanks).fill(''), ...body].join(sep);
        const out = scrubSecrets(`$ head id_rsa${sep}${text}`);
        expect(windows.filter((w) => out.includes(w))).toEqual([]);
        expect(out).toContain('$ head id_rsa');
      });
    }
  }
  it('a PGP header, then 17 blank lines', () => {
    const text = ['-----BEGIN PGP PRIVATE KEY BLOCK-----', 'Version: 1', ...Array(17).fill(''), ...body];
    const out = scrubSecrets(text.join('\n'));
    expect(windows.filter((w) => out.includes(w))).toEqual([]);
  });
  // r2: a header line that holds a BEGIN no reading starts from (another label, words after it, a
  // quote, no closing dashes) and then 17 or more blank lines.
  it.each([
    'X-Ref: -----BEGIN CERTIFICATE-----',
    'Comment: -----BEGIN PGP SIGNATURE-----',
    'Comment: see -----BEGIN here',
    'X-Ref: "-----BEGIN RSA PRIVATE KEY-----"',
    'X-Ref: -----BEGIN RSA PRIVATE KEY',
    'X-Ref: -----BEGIN RSA PRIVATE KEY-----',
  ])('a header holding %s, then 17 and 40 blank lines', (header) => {
    for (const n of [17, 40]) {
      const text = ['-----BEGIN RSA PRIVATE KEY-----', header, ...Array(n).fill(''), ...body];
      const out = scrubSecrets(text.join('\n'));
      expect(
        windows.filter((w) => out.includes(w)),
        `${n} blank lines`,
      ).toEqual([]);
    }
  });
  it('Read-tool numbered output with 17 blank lines under a header holding a BEGIN', () => {
    const lines = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Comment: -----BEGIN RSA PRIVATE KEY-----',
      ...Array(17).fill(''),
      ...body,
    ];
    const out = scrubSecrets(numbered(lines));
    expect(windows.filter((w) => out.includes(w))).toEqual([]);
    const escaped = scrubSecrets(J(numbered(lines)));
    expect(windows.filter((w) => escaped.includes(w))).toEqual([]);
  });
});

// D#168 (D#160 reopened): the BEGIN line's whole left context was the line prefix. With code between
// the line prefix and the BEGIN (`-KEY = '''`, `     5\tKEY = """`) or a string opener before it
// (`'+`, `"-`), the lines below carry only the prefix, the shape matched none of them and a cut key
// was stored whole. Measured 2026-11-01 on 491d6414: 212 of the 336 matrix cases stored key lines,
// every case of the seven code forms. The matrix is 5981f88's (withdrawn from 6.19.4 for regressions
// elsewhere, which the cases after it pin).
describe('D#168: code or a string opener between the line prefix and the BEGIN', () => {
  // Its own generator: drawing from the file's shared one would move every later draw.
  let s = 20261101;
  const r = () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const k64 = (n) => Array.from({ length: n }, () => B64[Math.floor(r() * 64)]).join('');
  const LEFT = {
    diffMinusCode: ["-KEY = '''", () => '-'],
    diffPlusCode: ['+const k = `', () => '+'],
    quoteCode: ['> key = "', () => '> '],
    readToolCode: ['     5\tKEY = """', (i) => `${String(6 + i).padStart(6)}\t`],
    readToolArrowCode: ['5→KEY = """', (i) => `${6 + i}→`],
    grepContextCode: ["keys/conf.py:5:KEY = '''", (i) => `keys/conf.py-${6 + i}-`],
    // `MY_KEY` and the key's `MII…` share an `M` that is not part of the line prefix.
    diffIdentifierM: ["-MY_KEY = '''", () => '-'],
    // A diff of YAML: `-key:` is the diff mark and code, not a grep path.
    diffYamlCode: ["-private_key: '''", () => '-'],
    quoteThenPlus: ["'+", () => '+'],
    bytesThenPlus: ["b'+", () => '+'],
    doubleQuoteThenMinus: ['"-', () => '-'],
    backtickThenPlus: ['`+', () => '+'],
    rawBytesThenPlus: ["rb'+", () => '+'],
    tripleQuoteThenPlus: ["'''+", () => '+'],
    indentedBytesThenPlus: ["  b'+", () => '+'],
  };
  const WRAPS = {
    raw: (t) => t,
    json: (t) => `{"type":"tool_result","content":${J(t)}}`,
    jsonTwice: (t) => J(`{"content":${J(t)}}`),
  };
  for (const [kind, key] of Object.entries(KEYS)) {
    const long = key.body.filter((l) => l.length >= 16).flatMap((l) => [l.slice(0, 16), l.slice(-16)]);
    for (const cutName of ['head', 'cutMidLine']) {
      it(`${kind} / ${cutName}: no key window kept, no text lost`, () => {
        const failures = [];
        for (const [leftName, [left, pre]] of Object.entries(LEFT)) {
          for (const [wrapName, wrap] of Object.entries(WRAPS)) {
            const [begin, ...rest] = CUTS[cutName](key);
            const text = ['$ git diff', left + begin, ...rest.map((l, i) => pre(i) + l), PROSE].join('\n');
            const out = scrubSecrets(wrap(text));
            const kept = long.filter((w) => out.includes(w));
            if (kept.length) failures.push(`${leftName}/${wrapName}: ${kept.length} key windows kept`);
            // The code before the BEGIN is escaped in the wrapped forms, so it is looked for raw only.
            const codeLost = wrapName === 'raw' && !out.includes(left.trim());
            if (!out.includes('$ git diff') || !out.includes(PROSE) || codeLost)
              failures.push(`${leftName}/${wrapName}: text lost`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  }

  it('Read output of a cut key in an import-jsonl content array', () => {
    const body = [KL, k64(64), k64(64)];
    const text = [
      "     5\tKEY = '''-----BEGIN RSA PRIVATE KEY-----",
      ...body.map((l, i) => `${String(6 + i).padStart(6)}\t${l}`),
    ].join('\n');
    const out = scrubSecrets(JSON.stringify([{ type: 'text', text }]));
    expect(body.map((l) => l.slice(20, 36)).filter((w) => out.includes(w))).toEqual([]);
  });

  // The key's first chunk on the code BEGIN line (`head -c` output): the reading ended on the BEGIN
  // line and the prefixed lines below were stored.
  it.each([
    [
      'a diff',
      (k) => [`-KEY = '''-----BEGIN RSA PRIVATE KEY-----${k[0]}`, ...k.slice(1).map((l) => `-${l}`)],
    ],
    [
      'Read output',
      (k) => [
        `     5\tKEY = """-----BEGIN RSA PRIVATE KEY----- ${k[0]}`,
        ...k.slice(1).map((l, i) => `${String(6 + i).padStart(6)}\t${l}`),
      ],
    ],
  ])('a key begun on its code BEGIN line in %s', (_name, lines) => {
    const k = [`MIIE${k64(60)}`, k64(64), k64(64), k64(20)];
    const out = scrubSecrets([...lines(k), PROSE].join('\n'));
    expect(
      k
        .slice(0, 3)
        .map((l) => l.slice(20, 36))
        .filter((w) => out.includes(w)),
    ).toEqual([]);
    expect(out).toContain(PROSE);
  });

  // v6.19.4 round-2 F1, the cross-pass leak: a whole key the block pattern did not take on pass 1
  // (a partial BEGIN inside it blocks the match until the Authorization pattern removes it) is taken
  // whole on pass 2. Reading its first lines as a cut key on pass 1 would put ***PEM_KEY*** over
  // its BEGIN, and the lines after the prose line would be stored.
  it('a whole key blocked on pass 1 is still taken whole under a code BEGIN', () => {
    const k = [`MIIE${k64(60)}`, k64(64), k64(64), k64(64)];
    for (const [left, pre] of [
      ["-KEY = '''", '-'],
      ['     5\tKEY = """', '     6\t'],
    ]) {
      const text = [
        `${left}-----BEGIN RSA PRIVATE KEY-----`,
        `${pre}${k[0]}`,
        `${pre}${k[1]}`,
        `${pre}Some prose line here.`,
        `${pre}${k[2]}`,
        `${pre}${k[3]}`,
        `${pre}Authorization: Bearer -----BEGIN RSA PRIVATE KEY`,
        `${pre}-----END RSA PRIVATE KEY-----`,
        'the end',
      ].join('\n');
      const out = scrubSecrets(text);
      expect(
        k.map((l) => l.slice(20, 36)).filter((w) => out.includes(w)),
        left,
      ).toEqual([]);
      expect(out).toContain('the end');
    }
  });

  // Two prefixed identifiers under a BEGIN with no code before it read as two key lines (as they do
  // on 491d6414). Under a code BEGIN the reading needs a 40+ line, a key magic or armor headers, so
  // a list that names a key marker in a diff keeps its words.
  it('an identifier list under a code BEGIN keeps its text', () => {
    for (const [left, pre] of [
      ["-KEY = '''", '- '],
      ["-KEY = '''", '-'],
      ['     5\tKEY = """', '     6\t'],
      ['> key = "', '> '],
    ]) {
      const lines = [
        `${left}-----BEGIN RSA PRIVATE KEY-----`,
        `${pre}SessionManagerImpl`,
        `${pre}TokenRefresherImpl`,
      ];
      const text = [...lines, 'the end of the list'].join('\n');
      expect(scrubSecrets(text), left).toBe(text);
    }
  });

  // The first design took armor headers as enough under a code BEGIN; the keyless arm of the fuzz
  // then lost the identifier under them on 858-899 of ~12,000 texts per seed.
  it('armor headers over an identifier under a code BEGIN keep their text', () => {
    for (const [left, pre] of [
      ['keys/conf.py:5:key = "', (i) => `keys/conf.py-${6 + i}-`],
      ['+MY_KEY = ', () => '+'],
      ['> MY_KEY = ', () => '> '],
    ]) {
      const lines = [
        `${left}-----BEGIN RSA PRIVATE KEY-----`,
        ...['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,3F2A9C1E', '', 'loadPrivateKeyFromDisk14'].map(
          (l, i) => pre(i) + l,
        ),
      ];
      const text = [...lines, 'the end'].join('\n');
      expect(scrubSecrets(text), left).toBe(text);
      expect(scrubSecrets(J(text)), `${left} escaped`).toBe(J(text));
    }
  });

  it('prefixed prose under a code BEGIN keeps its text', () => {
    for (const [left, pre] of Object.values(LEFT)) {
      const text = [
        `${left}-----BEGIN RSA PRIVATE KEY-----`,
        `${pre(0)}This line explains where the key is loaded from.`,
        `${pre(1)}`,
        `${pre(2)}See config/keys.md for the rotation steps.`,
      ].join('\n');
      expect(scrubSecrets(text), left).toBe(text);
    }
  });

  // The grammar reading is skipped when no key line can follow the BEGIN before the next BEGIN, and
  // a header line can carry the next BEGIN. Quoted or followed by text, that BEGIN starts no reading
  // of its own, so the code BEGIN's reading has to go through it: skipping on "no base64 run before
  // the next BEGIN" alone stored all three lines below, D#169's withdrawn read limit again.
  it.each([
    ['a quoted BEGIN', '-Proc-Type: "-----BEGIN RSA PRIVATE KEY-----", 4,ENCRYPTED'],
    ['a BEGIN followed by text', '-Comment: -----BEGIN RSA PRIVATE KEY----- was here'],
  ])('a header line holding %s under a code BEGIN', (_, header) => {
    // Fixed lines: this block's generator feeds the cases above.
    const L = 'q7Zr0XbN4kT2pWv9sYc1LmA8dE3fGh6J';
    const body = [L + L, 'Hk3PwQ9zLm2VbN8xRt5YcA1sDf6GjU0e'.repeat(2), `${L}Zx8CvB7n…`];
    const text = [
      '$ git diff',
      "-KEY = '''-----BEGIN RSA PRIVATE KEY-----",
      header,
      '-DEK-Info: AES-128-CBC,3F2A9C1E',
      '-',
      ...body.map((l) => `-${l}`),
      PROSE,
    ].join('\n');
    for (const t of [text, J(text)]) {
      const out = scrubSecrets(t);
      expect(body.map((l) => l.slice(4, 20)).filter((w) => out.includes(w))).toEqual([]);
      expect(out).toContain(PROSE);
    }
  });

  // With the key begun on its BEGIN line, a short last line below needs no base64 run to belong to
  // it, so that skip must not apply: the reading under the shape of `"-` stops at `-Qx7Zt2` (a `-`
  // is not base64) and only the grammar reading takes it.
  it.each([['"-'], ["'-"], ["b'-"], ["-KEY = '''"]])(
    'a key begun on a %s BEGIN line keeps no short last line',
    (left) => {
      const text = [`${left}-----BEGIN RSA PRIVATE KEY----- ${KL}`, '-Qx7Zt2', PROSE].join('\n');
      for (const t of [text, J(text)]) {
        const out = scrubSecrets(t);
        expect(out).not.toContain('Qx7Zt2');
        expect(out).not.toContain(KL.slice(10, 26));
        expect(out).toContain(PROSE);
      }
    },
  );

  // Line-prefix regexes are kept per call, by prefix. A BEGIN the scrubber leaves (prose below it)
  // stays in every pass, so a regex handed to a later BEGIN by any looser key than its own prefix
  // (one of the same length here) would store that key on every pass, not only the first.
  it.each([
    ['> ', '# '],
    ['// ', '-- '],
    // D#607 F9: keyed by the trimmed prefix, `>` took the regex of `> `.
    ['>', '> '],
  ])('a cut key under %j after a kept BEGIN under %j', (p2, p1) => {
    const body = [KL, 'q7Zr0XbN4kT2pWv9sYc1LmA8dE3fGh6J'.repeat(2), 'Zx8CvB7nM6aS5dF4gH3jK2lQ1wE0rTyU…'];
    const text = [
      `${p1}-----BEGIN RSA PRIVATE KEY-----`,
      `${p1}That header is where the key used to start.`,
      'and then',
      `${p2}-----BEGIN RSA PRIVATE KEY-----`,
      ...body.map((l) => p2 + l),
      PROSE,
    ].join('\n');
    const out = scrubSecrets(text);
    expect(body.map((l) => l.slice(10, 26)).filter((w) => out.includes(w))).toEqual([]);
    expect(out).toContain('That header is where the key used to start.');
    expect(out).toContain(PROSE);
  });
});

// D#607, the independent review of the D#168 reading (2026-11-01), and its repair. Each case pins a
// clause that one mutation of secret-scrub.mjs broke with every scrub test still green.
describe('D#607: the D#168 reading, its skip and its memos', () => {
  const L2 = 'q7Zr0XbN4kT2pWv9sYc1LmA8dE3fGh6Jq7Zr0XbN4kT2pWv9sYc1LmA8dE3fGh6J';
  const L3 = 'Hk3PwQ9zLm2VbN8xRt5YcA1sDf6GjU0eHk3PwQ9zLm2VbN8xRt5YcA1sDf6GjU0e';
  const P = 'The rest of this explanation is prose.';
  const kept = (out, lines) => lines.map((l) => l.slice(0, 16)).filter((w) => out.includes(w));

  // F5: the skip's gap ended at the next `-----BEGIN ` of any label. `X-----BEGIN : v` is a header
  // whose name swallows one, so the reading goes through it, and its colon fell past the gap.
  it('a header whose name holds a -----BEGIN does not end the skip gap', () => {
    const text = [
      "-KEY = '''-----BEGIN RSA PRIVATE KEY-----",
      '-X-----BEGIN : v',
      `-${KL}`,
      `-${L2}`,
      P,
    ].join('\n');
    for (const t of [text, J(text)]) {
      const out = scrubSecrets(t);
      expect(kept(out, [KL, L2])).toEqual([]);
      expect(out).toContain(P);
    }
  });

  // F9: cases for the grammar's clauses that no test held (each mutant stored all three lines).
  it.each([
    [
      'escaped text that starts with the BEGIN line',
      ["-KEY = '''-----BEGIN RSA PRIVATE KEY-----", ...[KL, L2, L3].map((l) => `-${l}`), P].join('\\n'),
    ],
    [
      'escaped breaks after a real one',
      'log entry 1\n' +
        ["-KEY = '''-----BEGIN RSA PRIVATE KEY-----", ...[KL, L2, L3].map((l) => `-${l}`), P].join('\\n'),
    ],
    [
      'a code line of 40+ characters before the opener, escaped',
      J(
        [
          '$ git diff',
          "-    PRIVATE_SIGNING_KEY_FOR_TESTS_ONLY = '''-----BEGIN RSA PRIVATE KEY-----",
          ...[KL, L2, L3].map((l) => `-${l}`),
          P,
        ].join('\n'),
      ),
    ],
    [
      'grep without line numbers',
      [
        "keys/conf.py:KEY = '''-----BEGIN RSA PRIVATE KEY-----",
        ...[KL, L2, L3].map((l) => `keys/conf.py:${l}`),
        P,
      ].join('\n'),
    ],
    [
      'a nested quote',
      ['> > key = "-----BEGIN RSA PRIVATE KEY-----', ...[KL, L2, L3].map((l) => `> > ${l}`), P].join('\n'),
    ],
  ])('%s under a code BEGIN', (_, text) => {
    const out = scrubSecrets(text);
    expect(kept(out, [KL, L2, L3])).toEqual([]);
    expect(out).toContain(P);
  });

  // The memo of what a reading found from its first base64 line holds only for a reading that had
  // counted nothing before that line: this header BEGIN carries a key start, which the reading from
  // the code BEGIN above (the memo's writer) never counted.
  it('a key begun on a header BEGIN line under a code BEGIN', () => {
    const short = ['QWERTYUIOPASDFGHJKLz', 'ZXCVBNMLKJHGFDSAqwer', 'poiuytrewqlkjhgfdsam'];
    const text = [
      "-KEY = '''-----BEGIN RSA PRIVATE KEY-----",
      '-Comment: -----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA',
      ...short.map((x) => `-${x}`),
      P,
    ].join('\n');
    for (const t of [text, J(text)]) {
      const out = scrubSecrets(t);
      expect(short.filter((x) => out.includes(x))).toEqual([]);
      expect(out).not.toContain('MIIEowIBAAKCAQEA');
      expect(out).toContain(P);
    }
  });

  // Fuzz-found and minimised: each output changed with the blank-run memo recording the line after
  // the run's end, or with one memo shared by every line shape.
  it.each([
    [
      'a blank run reaching its memo under quoted header BEGINs',
      [
        '> X-Foo: -----BEGIN PGP PRIVATE KEY BLOCK-----',
        '> Comment: -----BEGIN PGP PRIVATE KEY BLOCK-----',
        '> Comment: -----BEGIN PGP PRIVATE KEY BLOCK-----',
        ...Array(8).fill('> '),
        '> -----BEGIN OPENSSH PRIVATE KEY-----',
        `> ${KL}`,
      ].join('\n'),
      [
        '> X-Foo: -----BEGIN PGP PRIVATE KEY BLOCK-----',
        '> Comment: -----BEGIN PGP PRIVATE KEY BLOCK-----',
        '> Comment: -----BEGIN PGP PRIVATE KEY BLOCK-----',
        ...Array(8).fill('> '),
        '> ***PEM_KEY***',
      ].join('\n'),
    ],
    [
      'readings under two line shapes reaching one line',
      [
        '+X-Foo: -----BEGIN PGP PRIVATE KEY BLOCK-----',
        '+Comment: -----BEGIN PGP PRIVATE KEY BLOCK-----',
        '+ILMyki1sEfmlxDDpiQ48',
        '+CpI0iqfewyVD5hbsdxHn',
        '+',
      ].join('\r\n'),
      ['+X-Foo: -----BEGIN PGP PRIVATE KEY BLOCK-----', '+Comment: ***PEM_KEY***'].join('\r\n'),
    ],
  ])('%s', (_, text, expected) => {
    expect(scrubSecrets(text)).toBe(expected);
  });

  // D#607 r2 (delta review of 56af7270): three clauses no case held. The skip's gap must end at the
  // next private-key BEGIN after each BEGIN, not after the first one asked (P3-1); a 16-char base64
  // run in the gap keeps the reading (P3-4); and each memo key holds the escape depth, which changes
  // where lines end (P3-2, and r3 F2 for the other two sites: an empty line, read without lineCore,
  // and a first base64 line; in each the code or first BEGIN reads at depth 1, the header BEGIN at 0).
  it.each([
    [
      'a second code BEGIN with a key, after one with prose',
      [
        "-KEY = '''-----BEGIN RSA PRIVATE KEY-----",
        '-abc def',
        "-KEY = '''-----BEGIN RSA PRIVATE KEY-----",
        `-${KL}`,
        `-${L2}`,
        P,
      ].join('\n'),
      ["-KEY = '''-----BEGIN RSA PRIVATE KEY-----", '-abc def', "-KEY = '''***PEM_KEY***", P].join('\n'),
    ],
    [
      'a key under a code BEGIN with an unrelated BEGIN after the prose',
      [
        "-KEY = '''-----BEGIN RSA PRIVATE KEY-----",
        `-${KL}`,
        `-${L2}`,
        P,
        '-----BEGIN RSA PRIVATE KEY-----',
        'word',
      ].join('\n'),
      ["-KEY = '''***PEM_KEY***", P, '-----BEGIN RSA PRIVATE KEY-----', 'word'].join('\n'),
    ],
    [
      'one blank run read at two escape depths',
      "-KEY = '''-----BEGIN RSA PRIVATE KEY-----\\n-Comment: x\n-Comment: -----BEGIN RSA PRIVATE KEY-----\n" +
        '-\n'.repeat(12) +
        '-\\n-\n-MIIEabcdefghijklmnop\\"\\nx\n' +
        P,
      null,
    ],
    [
      'an empty-line run read at two escape depths',
      "-KEY = '''-----BEGIN RSA PRIVATE KEY-----\\n-Comment: x\n-Comment: -----BEGIN RSA PRIVATE KEY-----\n" +
        '\n'.repeat(12) +
        '\\n\n-MIIEabcdefghijklmnop\\"\\nx\n' +
        P,
      null,
    ],
    [
      'a first base64 line read at two escape depths',
      '-Comment: -----BEGIN RSA PRIVATE KEY-----\n-Comment: -----BEGIN RSA PRIVATE KEY-----\\n\n-QWERTYUIOPASDFGHJKLz\n-AAAAAAAAAAAAAAAAAAAA\\n-' +
        'B'.repeat(45) +
        '\n' +
        P,
      ['-Comment: -----BEGIN RSA PRIVATE KEY-----', '-Comment: ***PEM_KEY***', P].join('\n'),
    ],
  ])('%s', (_, text, expected) => {
    expect(scrubSecrets(text)).toBe(expected ?? text);
  });
});

// D#614: shapes that stored a cut key on v6.30.9 (secret-scrub.mjs sha1 cfda510c) as on v6.30.8.
// One matrix per shape: 4 key kinds x 2 cuts x the shape's left contexts x the wraps, no key window
// kept, no text lost.
const D614_WRAPS = {
  raw: (t) => t,
  crlf: (t) => t.replace(/\n/g, '\r\n'),
  json: (t) => `{"type":"tool_result","content":${J(t)}}`,
  jsonTwice: (t) => J(`{"content":${J(t)}}`),
};
// A rotated key's new lines, for a diff that removes the old ones and adds these.
const rotated = (l) => l.slice(7) + l.slice(0, 7);
function d614Matrix(lefts, wraps) {
  for (const [kind, key] of Object.entries(KEYS)) {
    const long = key.body.filter((l) => l.length >= 16).flatMap((l) => [l.slice(0, 16), l.slice(-16)]);
    for (const cutName of ['head', 'cutMidLine']) {
      it(`${kind} / ${cutName}: no key window kept, no text lost`, () => {
        const failures = [];
        for (const [leftName, [left, pre, added]] of Object.entries(lefts)) {
          // Lines added after the removed ones: under a head cut only, as nothing follows a line cut mid-way.
          const plus = added && cutName === 'head' ? key.body.slice(0, 3).map(rotated) : [];
          const windows = [...long, ...plus.flatMap((l) => [l.slice(0, 16), l.slice(-16)])];
          for (const [wrapName, wrap] of Object.entries(wraps)) {
            const [begin, ...rest] = CUTS[cutName](key);
            const text = [
              '$ git diff',
              left + begin,
              ...rest.map((l, i) => pre(i) + l),
              ...plus.map((l) => `+${l}`),
              PROSE,
            ].join('\n');
            const out = scrubSecrets(wrap(text));
            const kept = windows.filter((w) => out.includes(w));
            if (kept.length) failures.push(`${leftName}/${wrapName}: ${kept.length} key windows kept`);
            // The code before the BEGIN is escaped in the JSON forms, so it is looked for unwrapped only.
            const codeLost = !wrapName.startsWith('json') && left.trim() !== '' && !out.includes(left.trim());
            if (!out.includes('$ git diff') || !out.includes(PROSE) || codeLost)
              failures.push(`${leftName}/${wrapName}: text lost`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  }
}

// A1: a BEGIN on a unified diff's context line (its first character is the diff's space) over the
// removed key lines, and the added ones after them. The BEGIN's line prefix is a space, which no line
// below shares, and with code the line is no named prefix grammar, so nothing below it was read.
describe('D#614 A1: a BEGIN on a diff context line over removed key lines', () => {
  d614Matrix(
    {
      contextCode: [" KEY = '''", () => '-'],
      contextNoCode: [' ', () => '-'],
      contextIndentedCode: ["     KEY = '''", () => '-'],
      contextJsTemplate: [' const k = `', () => '-'],
      contextCodeThenAdded: [" KEY = '''", () => '-', true],
      contextNoCodeThenAdded: [' ', () => '-', true],
      // A key added under the context line: `+` is base64, so only a header line stopped the reading.
      contextCodeOverAdded: [" KEY = '''", () => '+'],
      contextNoCodeOverAdded: [' ', () => '+'],
    },
    D614_WRAPS,
  );

  // Under a context BEGIN the reading takes a 40+ line or a key start, as the D#168 reading does: two
  // removed identifiers, or armor headers over one, are a list, not a key.
  it.each([
    ['an identifier list', ['- SessionManagerImpl', '- TokenRefresherImpl']],
    ['the same without a space', ['-SessionManagerImpl', '-TokenRefresherImpl']],
    [
      'armor headers over an identifier',
      ['-Proc-Type: 4,ENCRYPTED', '-DEK-Info: AES-128-CBC,3F2A9C1E', '-', '-loadPrivateKeyFromDisk14'],
    ],
    [
      'prose',
      [
        '-This line explains where the key is loaded from.',
        '-',
        '+See config/keys.md for the rotation steps.',
      ],
    ],
  ])('%s under a context BEGIN keeps its text', (_, lines) => {
    for (const left of [" KEY = '''", ' ']) {
      const text = ['$ git diff', `${left}-----BEGIN RSA PRIVATE KEY-----`, ...lines, 'the end'].join('\n');
      expect(scrubSecrets(text), left).toBe(text);
      expect(scrubSecrets(J(text)), `${left} escaped`).toBe(J(text));
    }
  });

  // Only a line led by a space reads as a context line: a BEGIN named in prose over a list of hashes
  // keeps the list.
  it('a hash list under a BEGIN named in prose keeps its text', () => {
    const text = [
      'Fingerprints of the keys pasted after -----BEGIN RSA PRIVATE KEY-----',
      '- e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      '- 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'and nothing else.',
    ].join('\n');
    expect(scrubSecrets(text)).toBe(text);
  });

  // Read output starts its lines with spaces too. Only a removed or added line among the lines read makes
  // the BEGIN's line a context line (D#641; a next line that starts with a mark before it): here the
  // reading took the empty line's number for a short last line.
  it('Read output of a key begun on its BEGIN line keeps the next line number', () => {
    const text = [
      `     5\t-----BEGIN RSA PRIVATE KEY----- ${KL}`,
      '     6\t',
      '     7\tThat was the key.',
    ].join('\n');
    expect(scrubSecrets(text)).toBe(
      ['     5\t***PEM_KEY***', '     6\t', '     7\tThat was the key.'].join('\n'),
    );
  });

  // A line at one escape depth that holds a break of another is several lines, not a context line:
  // here ` a` is a line of its own, and the BEGIN under it is a header's (the key goes either way).
  it('a line of two escape depths led by a space is not a context line', () => {
    const text = `${[' a', '-Comment: -----BEGIN RSA PRIVATE KEY-----'].join('\\n')}\\\\n${[
      '-Comment: -----BEGIN RSA PRIVATE KEY-----',
      `-${KL}`,
      PROSE,
    ].join('\\\\n')}`;
    const out = scrubSecrets(text);
    expect(out).toBe(
      `${[' a', '-Comment: -----BEGIN RSA PRIVATE KEY-----'].join('\\n')}\\\\n${[
        '-Comment: ***PEM_KEY***',
        PROSE,
      ].join('\\\\n')}`,
    );
  });
});

// A2: a grep path the D#168 grammar's path class (`[^\s'"`:\\]+`) refuses, with code after its line
// number: a backslash, a space, a drive letter or another colon, a quote or a backtick, or a leading
// `-`, `+` or `>` (read as a diff mark or a quote first). The BEGIN on a match line (`path:5:`) over
// context lines (`path-6-`), and the reverse. One group per path character class.
describe('D#614 A2: a grep path outside the grammar path class, with code before the BEGIN', () => {
  const PATHS = {
    backslash: 'keys\\conf.py',
    space: 'My Keys/conf.py',
    driveLetter: 'C:/src/conf.py',
    driveAndBackslash: 'C:\\keys\\conf.py',
    otherColon: 'srv/a:b/conf.py',
    singleQuote: "it's/conf.py",
    doubleQuote: 'say"hi/conf.py',
    backtick: 'a`b/conf.py',
    leadingMinus: '-x/conf.py',
    leadingPlus: '+x/conf.py',
    leadingQuoteMark: '>x/conf.py',
    // The column is the line's last `:N:` or `-N-`: the first one here is part of the path.
    spaceAndDashedNumber: 'My Logs/2026-11-01/conf.py',
    uncPath: '\\\\srv\\keys\\conf.py',
  };
  for (const [name, path] of Object.entries(PATHS)) {
    describe(name, () => {
      d614Matrix(
        {
          matchOverContext: [`${path}:5:KEY = '''`, (i) => `${path}-${6 + i}-`],
          contextOverMatch: [`${path}-5-KEY = '''`, (i) => `${path}:${6 + i}:`],
          matchOverContextNoCode: [`${path}:5:`, (i) => `${path}-${6 + i}-`],
          matchOverContextJs: [`${path}:5:const k = \``, (i) => `${path}-${6 + i}-`],
        },
        D614_WRAPS,
      );
    });
  }

  // Both separators of a grep column are the same character: `-1:` in a slice after it is code.
  it('a slice in the code after a spaced path does not end the grep column', () => {
    const path = 'My Keys/conf.py';
    const body = [KL, 'q7Zr0XbN4kT2pWv9sYc1LmA8dE3fGh6J'.repeat(2), 'Zx8CvB7nM6aS5dF4gH3jK2lQ1wE0rTyU'];
    const text = [
      `${path}:5:KEY = s[n-1:] + '''-----BEGIN RSA PRIVATE KEY-----`,
      ...body.map((l, i) => `${path}-${6 + i}-${l}`),
      PROSE,
    ].join('\n');
    for (const t of [text, J(text)]) {
      const out = scrubSecrets(t);
      expect(body.map((l) => l.slice(0, 16)).filter((w) => out.includes(w))).toEqual([]);
      expect(out).toContain(PROSE);
    }
  });

  // The grep column's reading takes the D#168 evidence too: identifiers and prose that a grep for a
  // key marker printed under it keep their text.
  it.each([
    ['an identifier list', ['SessionManagerImpl', 'TokenRefresherImpl']],
    ['prose', ['Keys are loaded from the vault at startup.', '', 'See docs/keys.md for rotation.']],
    [
      'armor headers over an identifier',
      ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,3F2A9C1E', 'loadKey14x'],
    ],
  ])('%s under a grep BEGIN with a spaced path keeps its text', (_, lines) => {
    const path = 'My Keys/conf.py';
    const text = [
      `${path}:5:KEY = '''-----BEGIN RSA PRIVATE KEY-----`,
      ...lines.map((l, i) => `${path}-${6 + i}-${l}`),
      'the end',
    ].join('\n');
    expect(scrubSecrets(text)).toBe(text);
    expect(scrubSecrets(J(text))).toBe(J(text));
  });
});

// A3: in escaped text the first reading's prefix stops at an unescaped single quote, and the D#168
// reading looked for the line's start past such quotes at most 256 characters back: a longer code
// line before the last quote (keyword arguments, a dict) left no grammar, and the key was stored.
// Raw text has no such stop, so only the escaped wraps failed.
describe('D#614 A3: escaped code longer than 256 characters before the last quote', () => {
  const pad = 'x'.repeat(300);
  d614Matrix(
    {
      readLongArgs: [
        `     5\tDEFAULTS = dict(name='svc', ${pad}=1, ua='client', key="""`,
        (i) => `${String(6 + i).padStart(6)}\t`,
      ],
      diffLongDict: [`-    CONFIG = {'name': 'svc', '${pad}': 1, 'key': '''`, () => '-'],
      grepLongCode: [`keys/conf.py:5:x = '${pad}' + '''`, (i) => `keys/conf.py-${6 + i}-`],
      quoteLongCode: [`> key = '${pad}' + '''`, () => '> '],
      contextLongCode: [` KEY = '${pad}' + '''`, () => '-'],
      codeOf4000: [`-    K = '${'y'.repeat(4000)}' + '''`, () => '-'],
      // A `\n` in the code is a break one escape level down, not this line's start.
      escapedNewlineInCode: [`-    x = "a\\nb" + '${pad}' + '''`, () => '-'],
    },
    {
      raw: D614_WRAPS.raw,
      json: D614_WRAPS.json,
      jsonTwice: D614_WRAPS.jsonTwice,
      // Lone CRs: the line starts after an escaped `\r`.
      jsonLoneCr: (t) => `{"content":${J(t.replace(/\n/g, '\r'))}}`,
    },
  );
});

// A4 (D#633, a 6.30.9 regression): in an added diff, a header line under a BEGIN that holds a second
// private-key BEGIN (`+Comment: -----BEGIN …`). The first BEGIN's D#168 reading takes that header as
// an armor header, ends at a line the second BEGIN's own reading goes past (a 15-character line, a
// line that is only the second BEGIN's prefix, another header) and its span swallowed the second
// BEGIN, which then started no reading. 6.30.8 read the second BEGIN (the first found nothing) and
// erased every key line; 6.30.9 stored the lines past the first one's end. Shapes from the v6.30.9
// pre-tag r1 defects review (q1_repro.mjs, fuzz seed 33).
describe('D#614 A4 (D#633): a second BEGIN in a header line under a code BEGIN', () => {
  const K1 = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
  const K2 = 'VfLLGRHmAKOLzbCZpNqdM0MGSFhnfRSbxnrDTHjHqNHnL2dsc8RIG1rN7nsUiaHP';
  const K3 = 'hgsZH+ZH+Nj3KhnWTuotrsusbcuKGV8QotwGpDNSePvXW3QS8FPBrUpgD5lxBrD2';
  const S15 = 'QWERTYUIOPasdfg';
  const B = '-----BEGIN RSA PRIVATE KEY-----';
  it.each([
    [
      'a 16-character line under the header BEGIN',
      ["+KEY = '''" + B, `+Comment: ${B}`, `+${K1}`, `+${S15}`, `+${K2}`, `+${K3}`],
      [K1, S15, K2, K3],
    ],
    [
      'a line holding only the header BEGIN’s prefix',
      ["+KEY = '''" + B, `+Comment: ${B}`, `+${K1}`, '+Comment: ', `+${K2}`, `+${K3}`],
      [K1, K2, K3],
    ],
    [
      'two header BEGINs over a key whose second line is a header value',
      [
        '+Comment: -----BEGIN EC PRIVATE KEY-----',
        '+Comment: -----BEGIN DSA PRIVATE KEY-----',
        `+${K1}`,
        `+Comment: ${K2}`,
      ],
      [K1, K2],
    ],
    // The first header BEGIN's reading ends where the code BEGIN's does; only the second goes on.
    [
      'two header BEGINs under a code BEGIN, the second reading farther',
      ["+KEY = '''" + B, `+Comment: ${B}`, `+Comment: ${B}`, `+${K1}`, `+${S15}`, `+${K2}`, `+${K3}`],
      [K1, S15, K2, K3],
    ],
  ])('%s', (_, lines, keys) => {
    const text = ['$ git diff', ...lines, PROSE].join('\n');
    const failures = [];
    for (const [wrapName, wrap] of Object.entries(D614_WRAPS)) {
      const out = scrubSecrets(wrap(text));
      const kept = keys.filter((k) => out.includes(k.slice(0, 15)) || out.includes(k.slice(-15)));
      if (kept.length) failures.push(`${wrapName}: ${kept.length} key lines kept`);
      if (!out.includes('$ git diff') || !out.includes(PROSE)) failures.push(`${wrapName}: text lost`);
    }
    expect(failures).toEqual([]);
  });

  // Only BEGINs inside the span are read with it: a later key, past prose, is a key of its own.
  it('a key after prose below the span keeps the prose between', () => {
    const text = [
      '$ git diff',
      "+KEY = '''" + B,
      `+Comment: ${B}`,
      `+${K1}`,
      `+${S15}`,
      `+${K2}`,
      PROSE,
      B,
      K3,
    ].join('\n');
    for (const t of [text, J(text)]) {
      const out = scrubSecrets(t);
      expect([K1, S15, K2, K3].filter((k) => out.includes(k.slice(0, 15)))).toEqual([]);
      expect(out).toContain(PROSE);
    }
  });
});

// D#641: `git diff` of a rotated key cut by `head` or a truncation, in the shape git writes it. The
// lines under the BEGIN depend on the key type: an OpenSSH key's first body line is the same for
// every key of its type (a context line), as is an encrypted PEM key's Proc-Type header, and a PGP
// block's blank line after the BEGIN is a context line of one space. The A1 matrix above writes them
// as removed lines, which git never does, and v6.30.9 and the D#614 A1 fix both stored the removed
// and added lines. A removed key that ends with a short line or a PGP checksum is followed by the
// added key, whose lines were stored once the reading stopped at that short line.
describe('D#641: a cut `git diff` of a rotated key, in the shape git writes it', () => {
  const hex = (n) => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(rnd() * 16)]).join('');
  // Key lines of these lengths (-1: a PGP checksum), the first one starting with `start`: a DER key's
  // `MII…` or an RSA PGP key's `lQ…`, as a lone line of 16-39 characters is a key only with that start.
  const lines = (lens, start = '') =>
    lens.map((n, i) => (n < 0 ? `=${b64(4)}` : i === 0 ? start + b64(n - start.length) : b64(n)));
  const OPENSSH_FIRST = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW';
  const hunk = (begin, end, ctx, mid, oldLines, newLines) => [
    ` ${begin}`,
    ...ctx.map((l) => ` ${l}`),
    ...mid,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
    ` ${end}`,
  ];
  const BO = '-----BEGIN OPENSSH PRIVATE KEY-----';
  const EO = '-----END OPENSSH PRIVATE KEY-----';
  const BR = '-----BEGIN RSA PRIVATE KEY-----';
  const ER = '-----END RSA PRIVATE KEY-----';
  const BP = '-----BEGIN PGP PRIVATE KEY BLOCK-----';
  const EP = '-----END PGP PRIVATE KEY BLOCK-----';
  const HUNKS = {
    openssh: hunk(BO, EO, [OPENSSH_FIRST], [], lines([70, 70, 70, 32]), lines([70, 70, 70, 32])),
    opensshShortLast: hunk(BO, EO, [OPENSSH_FIRST], [], lines([70, 70, 70, 12]), lines([70, 70, 70, 12])),
    encryptedPem: hunk(
      BR,
      ER,
      ['Proc-Type: 4,ENCRYPTED'],
      [`-DEK-Info: AES-128-CBC,${hex(32)}`, `+DEK-Info: AES-128-CBC,${hex(32)}`, ' '],
      lines([64, 64, 64, 40]),
      lines([64, 64, 64, 40]),
    ),
    pgp: hunk(BP, EP, [''], [], lines([64, 64, 64, 28, -1], 'lQOYBF'), lines([64, 64, 64, 28, -1], 'lQOYBG')),
    pemShortLast: hunk(
      BR,
      ER,
      [],
      [],
      lines([64, 64, 64, 12], 'MIIEowIBAAKCAQEA'),
      lines([64, 64, 64, 12], 'MIIEpAIBAAKCAQEA'),
    ),
  };
  const FRAMES = {
    keyFile: (h) => [
      'diff --git a/id_key b/id_key',
      'index 3b18e51..a4f0c2d 100600',
      '--- a/id_key',
      '+++ b/id_key',
      `@@ -1,${h.length - 1} +1,${h.length - 1} @@`,
    ],
    embedded: () => ['@@ -4,14 +4,14 @@ deploy:', ' user: deploy', ' key: |'],
  };
  const windowsOf = (l) => {
    const body = l.slice(1);
    return /^[A-Za-z0-9+/=]{16,}$/.test(body) ? [body.slice(0, 16), body.slice(-16)] : [];
  };
  // The BEGIN line alone, or under code that opens a string (a key in a Python file): in a JSON string the
  // BEGIN's line starts past the code's quotes.
  const CODES = { noCode: '', code: "KEY = '''" };
  for (const [kind, h0] of Object.entries(HUNKS)) {
    for (const [frameName, frame] of Object.entries(FRAMES)) {
      for (const [codeName, code] of Object.entries(CODES)) {
        const h = [` ${code}${h0[0].slice(1)}`, ...h0.slice(1)];
        it(`${kind} / ${frameName} / ${codeName}: no key window kept at any cut, no text lost`, () => {
          const failures = [];
          // Every cut from the line under the BEGIN to the line before the END, whole or cut mid-line.
          for (let n = 2; n < h.length; n++) {
            for (const midLine of [false, true]) {
              const cut = h.slice(0, n);
              const last = cut[n - 1];
              if (midLine && !(last.length > 33 && /^[-+ ][A-Za-z0-9+/=]+$/.test(last))) continue;
              // Not covered: an encrypted key's random first line cut inside its first 40 characters. Under
              // the diff reading, as under the D#168 one, armor headers over one line of 16-39 characters
              // are no key (headers over an identifier, below).
              if (midLine && kind === 'encryptedPem' && n - 1 === h.findIndex((l) => windowsOf(l).length))
                continue;
              if (midLine) cut[n - 1] = `${last.slice(0, Math.ceil(last.length / 2))}…`;
              const windows = cut.slice(0, midLine ? n - 1 : n).flatMap(windowsOf);
              if (midLine) windows.push(last.slice(1, 17));
              const text = ['$ git diff', ...frame(h), ...cut, PROSE].join('\n');
              for (const [wrapName, wrap] of Object.entries(D614_WRAPS)) {
                const out = scrubSecrets(wrap(text));
                const kept = windows.filter((w) => out.includes(w));
                const tag = `${n}${midLine ? '…' : ''}/${wrapName}`;
                if (kept.length)
                  failures.push(`${tag}: ${kept.length} of ${windows.length} key windows kept`);
                if (!out.includes('$ git diff') || !out.includes('@@ -') || !out.includes(PROSE))
                  failures.push(`${tag}: text lost`);
              }
            }
          }
          expect(failures).toEqual([]);
        });
      }
    }
  }

  // The reading under a context BEGIN takes a key only on a removed or added line, and only on a
  // 40+ line or a key start, as the A1 reading does.
  it.each([
    [
      'prose',
      [
        ` ${BR}`,
        ' The key above was rotated.',
        '-It is loaded from config/keys.',
        '+It is loaded from the vault.',
      ],
    ],
    [
      'removed identifiers under a blank context line',
      [` ${BR}`, ' ', '-SessionManagerImpl', '-TokenRefresherImpl'],
    ],
    [
      'armor headers over a removed identifier',
      [
        ` ${BR}`,
        ' Proc-Type: 4,ENCRYPTED',
        '-DEK-Info: AES-128-CBC,3F2A9C1E',
        ' ',
        '-loadPrivateKeyFromDisk14',
      ],
    ],
  ])('%s under a context BEGIN in a real diff keeps its text', (_, hunkLines) => {
    const text = ['$ git diff', '@@ -1,6 +1,6 @@', ...hunkLines, 'the end'].join('\n');
    expect(scrubSecrets(text)).toBe(text);
    expect(scrubSecrets(J(text))).toBe(J(text));
  });

  // The added lines are read on only after the removed key's short last line or checksum: a reading that
  // stopped at a line cut mid-way ended where the output did, and an identifier added after it stays.
  it('an identifier added after a removed key line cut mid-way keeps its text', () => {
    const k1 = b64(64);
    const text = [
      '$ git diff',
      '@@ -1,4 +1,4 @@',
      ` ${BR}`,
      `-MIIEowIBAAKCAQEA${b64(48)}`,
      `-${k1.slice(0, 30)}…`,
      '+SessionManagerImplementation',
      PROSE,
    ].join('\n');
    for (const t of [text, J(text)]) {
      const out = scrubSecrets(t);
      expect(out).toContain('+SessionManagerImplementation');
      expect(out).not.toContain(k1.slice(0, 16));
    }
  });

  // Only a removed or added line is read on: a hash printed after the diff (`git rev-parse HEAD`) stays.
  it('a hash printed after a removed key that ends with a short line keeps its text', () => {
    const sha = '1eb2ce12e8b6ab30424f3aa0ea13ba5bbb9b3840';
    const k1 = b64(64);
    const text = [
      '$ git diff',
      '@@ -1,3 +1,3 @@',
      ` ${BR}`,
      `-MIIEowIBAAKCAQEA${k1.slice(16)}`,
      `-${b64(12)}`,
      sha,
      PROSE,
    ].join('\n');
    for (const t of [text, J(text)]) {
      const out = scrubSecrets(t);
      expect(out).toContain(sha);
      expect(out).not.toContain(k1.slice(-16));
    }
  });

  // An added line that is no key line ends the reading where the removed key ended: the key goes, the
  // added prose stays.
  it('a removed key that ends with a short line, then an added line of prose', () => {
    const k1 = b64(64);
    const text = [
      '$ git diff',
      '@@ -1,3 +1,3 @@',
      ` ${BR}`,
      `-MIIEowIBAAKCAQEA${k1.slice(16)}`,
      `-${b64(12)}`,
      '+The key moved to the vault.',
      PROSE,
    ].join('\n');
    for (const [wrapName, wrap] of Object.entries(D614_WRAPS)) {
      const out = scrubSecrets(wrap(text));
      expect(out, wrapName).not.toContain(k1.slice(-16));
      expect(out, wrapName).toContain('+The key moved to the vault.');
    }
  });

  // What D#641 added never spans another private-key BEGIN. Here a header line holding one sat under a
  // context BEGIN: the span took it, and the cut line after the key, which the header BEGIN's reading
  // erases on the next pass over the first pass's ***PEM_KEY*** line, was kept (W2, r3mix generator).
  it.each([
    ['', []],
    // A context line first: under a marked one the reading was A1's before D#641 (and keeps the line).
    [' after a removed line', [' ', '+\t']],
  ])('a span of the added reading leaves a header BEGIN under it to its own reading%s', (_, marked) => {
    const cut2 = `${b64(20)}…`;
    const text = [
      '$ git diff',
      ` ${BP}`,
      ...marked,
      ` X-a: ${BO}`,
      ` Version: ${BR}`,
      `-MIIEowIBAAKCAQEA${b64(48)}`,
      ` ${b64(20)}<`,
      ` ${cut2}`,
      PROSE,
    ].join('\n');
    for (const [wrapName, wrap] of Object.entries(D614_WRAPS)) {
      const out = scrubSecrets(wrap(text));
      expect(out, wrapName).not.toContain(cut2.slice(0, 16));
      expect(out, wrapName).toContain(PROSE);
    }
  });

  // A reading kept in the per-call memo carries where it ended: here the D#168 reading of the code BEGIN
  // reads the removed key first and stops at its short line, and the context header BEGIN inside that
  // span finds its reading in the memo and reads the added lines on from there.
  it('a reading found in the memo still reads the added key on', () => {
    const add = [b64(64), b64(64)];
    const text = [
      '$ git diff',
      `-KEY = '''${BR}`,
      ` Comment: ${BR}`,
      `-MIIEowIBAAKCAQEA${b64(48)}`,
      `-${b64(12)}`,
      ...add.map((l) => `+${l}`),
      PROSE,
    ].join('\n');
    for (const [wrapName, wrap] of Object.entries(D614_WRAPS)) {
      const out = scrubSecrets(wrap(text));
      expect(
        add.filter((l) => out.includes(l.slice(0, 16)) || out.includes(l.slice(-16))),
        wrapName,
      ).toEqual([]);
      expect(out, wrapName).toContain(PROSE);
    }
  });

  // A context key line read by the first reading, then a removed line of prose: the prose stays.
  it('a context key line over a removed line of prose keeps the prose', () => {
    const text = [
      '$ git diff',
      '@@ -1,3 +1,3 @@',
      ` ${BO}`,
      ` ${OPENSSH_FIRST}`,
      '-This line is prose.',
    ].join('\n');
    expect(scrubSecrets(text)).toBe(
      ['$ git diff', '@@ -1,3 +1,3 @@', ' ***PEM_KEY***', '-This line is prose.'].join('\n'),
    );
  });
});

// D#642: a reading that meets a header holding a BEGIN takes that BEGIN's walk over the headers below
// (shared, memoised), counting the headers before it: the MAX_ARMOR_HEADERS bound falls where the
// line-by-line reading put it. The expected outputs are v6.30.9 and 1eef3c18's: which BEGIN the
// marker starts at is where the 16-header bound fell.
describe('D#642: header BEGINs share one walk over their headers', () => {
  const B = '-----BEGIN RSA PRIVATE KEY-----';
  const K1 = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
  const K2 = 'VfLLGRHmAKOLzbCZpNqdM0MGSFhnfRSbxnrDTHjHqNHnL2dsc8RIG1rN7nsUiaHP';
  // A code BEGIN, `n` headers (those at `begins` holding a BEGIN), each followed by `blanks` lines
  // that hold only the prefix, then a key.
  const lines = (pre, n, blanks, begins) => {
    const L = ['$ git diff', `${pre}KEY = '''${B}`];
    for (let i = 0; i < n; i++) {
      L.push(begins.includes(i) ? `${pre}Comment: ${B}` : `${pre}Comment: x`);
      for (let b = 0; b < blanks; b++) L.push(pre);
    }
    return [...L, pre + K1, pre + K2, 'the end'];
  };
  it.each([
    ['16 headers under the code BEGIN: its reading takes the key', '-', 16, 0, [0, 15], 1],
    ['17 headers: the first header BEGIN reads the key, 16 below it', '-', 17, 0, [0, 16], 2],
    ['16 headers over runs of 7 context lines', ' ', 16, 7, [3, 15], 1],
    ['17 headers over runs of 9: the headers above a header BEGIN count', ' ', 17, 9, [8, 16], 162],
  ])('%s', (_, pre, n, blanks, begins, markerLine) => {
    const L = lines(pre, n, blanks, begins);
    const expected = [...L.slice(0, markerLine), L[markerLine].replace(B, '***PEM_KEY***'), 'the end'].join(
      '\n',
    );
    expect(scrubSecrets(L.join('\n'))).toBe(expected);
    expect(scrubSecrets(J(L.join('\n')))).toBe(J(expected));
  });

  // The walk back to an escaped line's start passes a backslash run in one step: a line that starts
  // with one (a UNC path in grep output, first in a JSON string) starts at the quote before it.
  it('a grep line with a UNC path, first in a JSON string', () => {
    const path = '\\\\srv\\keys\\conf.py';
    const t = [`${path}:5:KEY = '''${B}`, `${path}-6-${K1}`, `${path}-7-${K2}`, 'the end'].join('\n');
    for (const wrapped of [`{"type":"tool_result","content":${J(t)}}`, J(`{"content":${J(t)}}`)]) {
      const out = scrubSecrets(wrapped);
      expect([K1, K2].filter((k) => out.includes(k.slice(0, 16)) || out.includes(k.slice(-16)))).toEqual([]);
      expect(out).toContain('the end');
    }
  });
});
