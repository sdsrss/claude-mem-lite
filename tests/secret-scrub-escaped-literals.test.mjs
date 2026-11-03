// D#687 / D#693 / D#685: a JSON string literal holds its text one escape level deep (a key's quotes are
// `\"`, a line break is `\n`), where the scrubber's patterns for text do not hold. Each double-quoted literal
// whose body holds an escape is decoded and scrubbed as text, and rewritten only when that changed it.
// One row per recorded shape (a tool printing escaped JSON, escaped JSON in a file, a `.env` inside a JSON
// string), then one row per condition of the literal reading.
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrub.mjs';

// Assembled at run time so the file holds no secret-shaped literal.
const V = 'Zr7Kq2Lm' + '9Xv4Tp8W';
const W = 'Tq3nW9xY' + 'b5Hc2Kd8';
const J = JSON.stringify;

describe('D#687: a credential inside an escaped JSON string literal is erased', () => {
  it.each([
    ['aws secretsmanager --query SecretString', J(J({ password: V, api_key: W, user: 'app' })) + '\n'],
    [
      'aws secretsmanager, the whole JSON',
      J({ Name: 'x', SecretString: J({ password: V, api_key: W }) }, null, 4),
    ],
    ['an MCP result holding JSON in a string', J({ config: J({ client_secret: V, token: W }) })],
    [
      'a .env value holding escaped JSON',
      `APP_CONFIG="{\\"api_key\\":\\"${V}\\",\\"password\\":\\"${W}\\"}"\n`,
    ],
    [
      'an escaped JSON literal in source code',
      `  String body = "{\\"api_key\\": \\"${V}\\", \\"client_secret\\": \\"${W}\\"}";\n`,
    ],
    [
      'a notebook cell',
      J(
        { cells: [{ source: ['import os\n', `API_KEY = "${V}"\n`, `client = Client(token="${W}")\n`] }] },
        null,
        1,
      ),
    ],
    ['kubectl … | jq -c .data with a .env', J({ '.env': `PORT=1\nAPI_KEY=${V}\npassword=${W}\n` })],
    [
      'consecutive label lines in a JSON string',
      J({ content: `API_KEY=x1y2z3a4\nGH_TOKEN: ${V}\nclient_secret: ${W}\n` }),
    ],
    [
      'CRLF label lines in a JSON string',
      J({ content: `API_KEY=x1y2z3a4\r\npassword: ${V}\r\ntoken: ${W}\r\n` }),
    ],
    ['two levels deep', J({ line: J({ content: `API_KEY=x1y2z3a4\npassword=${V}\ntoken: ${W}\n` }) })],
  ])('%s', (_name, text) => {
    const out = scrubSecrets(text);
    expect(out).not.toContain(V);
    expect(out).not.toContain(W);
  });
});

describe('the literal reading', () => {
  it('leaves a literal with no secret byte for byte, escapes included', () => {
    const text = '{"note":"line one\\nline two \\u0026 \\/path\\tend","n":"a\\"b"}';
    expect(scrubSecrets(text)).toBe(text);
  });

  it('keeps the rest of a literal it rewrites', () => {
    const out = scrubSecrets(J({ c: `PORT=3000\npassword=${V}\nLOG_LEVEL=info\n` }));
    expect(out).not.toContain(V);
    expect(JSON.parse(out).c).toBe('PORT=3000\npassword=***\nLOG_LEVEL=info\n');
  });

  it('opens a literal only at a quote no backslash escapes', () => {
    const out = scrubSecrets(`say \\"hi\\" then "{\\"api_key\\":\\"${V}\\"}"`);
    expect(out).not.toContain(V);
  });

  it('reads a literal on one line: an unclosed quote above does not swallow it', () => {
    const out = scrubSecrets(`a 5" screen\n"{\\"api_key\\":\\"${V}\\"}"\n`);
    expect(out).not.toContain(V);
  });

  it('decodes a body JSON rejects, keeping an escape it does not know as written', () => {
    // `\x1b` is no JSON escape (a terminal log, a Python repr in double quotes).
    const text = '{"log":"\\x1b[32mINFO\\x1b[0m start\\npassword: ' + V + '\\n"}';
    expect(() => JSON.parse(text), 'premise: not JSON').toThrow();
    expect(scrubSecrets(text)).not.toContain(V);
  });

  it('reads a literal the text ends inside', () => {
    const text = J({ content: `PORT=1\nGH_TOKEN: ${V}\nclient_secret: ${W}\nmore` }).slice(0, -6);
    const out = scrubSecrets(text);
    expect(out).not.toContain(V);
    expect(out).not.toContain(W);
  });

  it('reads a literal after hundreds of plain strings (only an escaped literal counts against the bound)', () => {
    const meta = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`label${i}`, `value-${i}`]));
    const out = scrubSecrets(J({ metadata: meta, data: { '.env': `PORT=1\nAPI_KEY=${V}\n` } }));
    expect(out).not.toContain(V);
  });

  it('decodes a bounded number of literals: fifty thousand cost about what plain strings do', () => {
    // A decoded literal is scrubbed as a text of its own; with the bound, 50,000 of them read under 1x the same
    // text without the escape (Node 26, 2026-11-03).
    const ms = (fn) => {
      const t0 = performance.now();
      fn();
      return performance.now() - t0;
    };
    const escaped = '"\\n"'.repeat(50_000);
    const plain = '"_n"'.repeat(50_000);
    const took = { escaped: [], plain: [] };
    for (let k = 0; k < 3; k++) {
      took.plain.push(ms(() => scrubSecrets(plain)));
      took.escaped.push(ms(() => scrubSecrets(escaped)));
    }
    expect(Math.min(...took.escaped) / Math.max(5, Math.min(...took.plain))).toBeLessThan(10);
  });

  it('reads three levels deep', () => {
    const out = scrubSecrets(J(J(J({ note: 'a\nb', api_key: V }))));
    expect(out).not.toContain(V);
  });

  it('keeps erased what the patterns erase in the escaped text', () => {
    // A label's value runs on over the escaped breaks: the line after it, which has no label, is erased.
    // Read as text, `PGPASSWORD=` takes `secret:…` as its value, so no label is left for that run-on.
    const text = J({ c: `PGPASSWORD=\n  secret:x1y2z3a4\n${V}\n  token=` });
    expect(scrubSecrets(text)).not.toContain(V);
  });

  it.each([
    [
      '`\\/` (PHP json_encode)',
      (t) => t.replace(/\//g, '\\/'),
      `https://hooks.example.com/services/${W}${V}`,
    ],
    ['`\\u002B` (.NET System.Text.Json)', (t) => t.replace(/\+/g, '\\u002B'), `${W}+${V}+${W}`],
  ])('keeps erased what the patterns erase when an escape joins words: %s', (_name, escape, value) => {
    // The short value is kept read as text, so its label is erased whole (it was erased in the escaped
    // body), and the run-on that erased the next line in the escaped body is gone: that line's value,
    // written with an escape that decodes to a word character, must stay erased (v6.30.14 review r2).
    const text = escape(J({ content: `MYSQL_ROOT_PASSWORD=root\nWEBHOOK=${value}\nMAIL_PASSWORD=${V}x\n` }));
    expect(scrubSecrets(text)).not.toContain(V);
    expect(scrubSecrets(text)).not.toContain(W);
  });

  it('keeps a word an escape joins in a literal it rewrites, when nothing erased it', () => {
    const text = J({ c: `PORT=1\nDOCS=https://docs.example.com/v2/setup\nAPI_KEY=${V}\n` }).replace(
      /\//g,
      '\\/',
    );
    expect(JSON.parse(scrubSecrets(text)).c).toBe(
      'PORT=1\nDOCS=https://docs.example.com/v2/setup\nAPI_KEY=***\n',
    );
  });

  it.each([
    // The regex that found literals pushed a backtrack frame per character and threw RangeError on both
    // (v6.30.14 review r1); import-jsonl then aborted the whole transcript file.
    ['one escape', `"${'a'.repeat(10_000_000)}\\n"`, (out, text) => expect(out).toBe(text)],
    [
      'minified JSON in a string, a credential at its end',
      J({
        c: J(Array.from({ length: 330_000 }, (_, i) => ({ id: i, name: `item${i}` }))) + `\npassword=${V}\n`,
      }),
      (out) => expect(out).not.toContain(V),
    ],
  ])('reads a literal of ten million characters on one line: %s', (_name, text, check) => {
    expect(text.length).toBeGreaterThan(10_000_000);
    check(scrubSecrets(text), text);
  });

  it('is idempotent where a rewritten literal gives the patterns a new reading', () => {
    // Three levels of escaping, from the D#687 differential (seed 1, case 94); one round left a second
    // call erasing more.
    const A = 'Rk8vQ2mZ' + 'x7Lp4Nq';
    const W2 = W + 'Pq9z';
    const text = JSON.parse(
      String.raw`"{\"content\":\"\\\"\\\\\\\"\\\\\\\\t<A>\\\\\\\\npassword: \\\\\\\\n\\\\\\\\tJWT_SECRET:\\\\\\\\\\\\\\\"<V>\\\\\\\\\\\\\\\"\\\\\\\\n\\\\\\\\tclient_secret = <W>\\\\\\\"\\\"\"}"`,
    )
      .replace('<A>', A)
      .replace('<V>', V)
      .replace('<W>', W2);
    const once = scrubSecrets(text);
    expect(once).not.toContain(V);
    expect(scrubSecrets(once)).toBe(once);
  });
});

describe('D#701: JSON one encoder wrote, inside a string another encoder wrote', () => {
  // PHP's `\/`, the `\u002B` .NET writes for `+` and the `\u003d` Gson writes for `=` decode to characters
  // that join words, and a rewritten literal holds those characters. Read one level further in, as
  // written, such a word was split, so a word the patterns erase in the outer escaped text was new there
  // and kept (v6.30.14 review r3). In each of the six rows v6.30.13 erases both values and v6.30.14
  // stores W, and V too where `+` joins it (docs/audits/20261103-v6.30.15-measurements.md).
  const hex = (c, upper) => {
    const h = c.charCodeAt(0).toString(16).padStart(4, '0');
    return '\\u' + (upper ? h.toUpperCase() : h);
  };
  const php = (v) => J(v).replace(/\//g, '\\/');
  const dotnet = (v) =>
    J(v)
      .replace(/\\"/g, '\\u0022')
      .replace(/[+<>&'`]/g, (c) => hex(c, true));
  const gson = (v) => J(v).replace(/[=<>&']/g, (c) => hex(c, false));
  const hook = `https://hooks.example.com/services/T0/B0/${W}`;
  const laravel = `DB_PASSWORD=${V}\nAPP_NAME="Laravel"\nSLACK_WEBHOOK_URL=${hook}\n`;

  it.each([
    ['PHP inside .NET, `\\/` joining a webhook URL', dotnet({ id: 7, payload: php({ env: laravel }) })],
    [
      'PHP inside .NET, `\\u002B` joining a password into a URL',
      dotnet({
        id: 7,
        payload: php({
          env: `ACCESS_TOKEN: ${V}\nAPP_NAME="Laravel"\nWEBHOOK_URL=https://hooks.example.com/${W}+${V}\n`,
        }),
      }),
    ],
    [
      'Gson inside .NET, `\\u003d` and `\\u002B`',
      dotnet({
        id: 7,
        payload: gson({
          env: `ACCESS_TOKEN: ${V}\nAPP_NAME="Laravel"\nWEBHOOK=${W}+${V}\nLOG_LEVEL: info\n`,
        }),
      }),
    ],
    [
      'PHP inside Gson, `\\u0027` hiding the quote that ends a value',
      gson({
        id: 7,
        payload: php({
          env: `ACCESS_TOKEN: ${V}\nAPP_NAME='Laravel'\nWEBHOOK=https://hooks.example.com/services/T0/${W}\n`,
        }),
      }),
    ],
    [
      'three levels: PHP inside .NET inside JSON',
      J({ log: dotnet({ id: 7, payload: php({ env: laravel }) }) }),
    ],
    // Only the outermost reading erases W here.
    ['three levels: PHP inside JSON inside .NET', dotnet({ log: J({ payload: php({ env: laravel }) }) })],
  ])('%s', (_name, text) => {
    const out = scrubSecrets(text);
    expect(out).not.toContain(V);
    expect(out).not.toContain(W);
    expect(scrubSecrets(out)).toBe(out);
  });

  it('keeps a word an escape joins two levels in, when nothing erased it', () => {
    // The URL comes before the credential, where no value runs on over it.
    const docs = 'https://docs.example.com/v2/setup';
    const out = scrubSecrets(dotnet({ id: 7, payload: php({ env: `DOCS=${docs}\n${laravel}` }) }));
    expect(out).not.toContain(W);
    expect(out).toContain(`DOCS=${docs}\\\\n`);
  });

  it('erases a word a value runs on into, in a literal it leaves as written', () => {
    // The literal holding the URL has nothing of its own to erase, so it keeps its `\/`; the patterns
    // erase the URL in the outer escaped text, where the password's value runs on into it. Each word is
    // erased with the escapes inside it, and no more.
    const text = dotnet({ cfg: `PASSWORD=${V}"https:\\/\\/hooks.example.com\\/services\\/${W}"` });
    expect(scrubSecrets(text)).toBe('{"cfg":"PASSWORD=***\\"***:***\\""}');
  });

  it('reads a backslash and `u` before letters that are no hex digits as written', () => {
    // `\uZr7K` is no escape, so the word after the backslash, erased by the run-on of `secret:` in the
    // escaped text, is erased whole.
    const out = scrubSecrets(J({ c: `PGPASSWORD=\n  secret:x1y2z3a4\nC:\\keys\\u${V}\n  token=` }));
    expect(out).not.toContain(V.slice(0, 4));
  });

  const V2 = 'Hy6Rt3Pq' + '8Ws2Kd5N';
  const GHP = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const JWT =
    'eyJ' +
    'hbGciOiJIUzI1NiJ9' +
    '.eyJ' +
    'zdWIiOiIxMjM0NTY3ODkwIn0' +
    '.' +
    'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const A = 'Kx9' + 'Lm2pQ7vR';
  const B = 'tY8' + 'wE3nH6zU';
  const repo = `ACCESS_TOKEN: ${V}\nAPP_NAME='Laravel'\nREPO=https://git.example.com/${GHP}/${W}\n`;
  it.each([
    ['a token in a URL path, PHP inside Gson', gson({ id: 7, payload: php({ env: repo }) }), W],
    ['a token in a URL path, PHP inside .NET', dotnet({ id: 7, payload: php({ env: repo }) }), W],
    [
      'a JWT before a path, PHP inside JSON',
      J([php({ content: `API_KEY: ${V}\nCLIENT_SECRET: ${V2}\nLOG_LEVEL=${JWT}/${W}\n` })]),
      W,
    ],
    [
      'a backslash before the `+` .NET escapes, .NET inside Gson',
      gson({
        id: 180,
        message: dotnet({ id: 394, body: `api_key=${V}\nAuthorization: Bearer ${V2}\nLEGACY=${A}\\+${B}\n` }),
      }),
      A,
    ],
    // From the review's fuzzing; only reading the rewritten literal as written finds the marker.
    [
      'a crafted text',
      JSON.parse(
        String.raw`"secret=\\\\\"\\napi_key=\\/Mq7q8rZxe6wzMq7q8sZx1m5is` +
          String.raw`k-Mq7q8tZxgli6Authorization: Bearer Mq7q8uZxg526++\\\\/secret=-Mq7q8vZxctb4="`,
      ),
      'Mq7q8uZxg526',
    ],
  ])('keeps erased a word 6.30.14 erased: %s', (_name, text, word) => {
    // v6.30.13 and v6.30.14 erase the word (v6.30.15 review r1).
    const out = scrubSecrets(text);
    expect(out).not.toContain(word);
    expect(scrubSecrets(out)).toBe(out);
  });
});
