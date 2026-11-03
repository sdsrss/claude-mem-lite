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
    // A decoded literal is scrubbed as a text of its own. With no bound, 50,000 of them read 24x the same
    // text without the escape (Node 26, 2026-11-03); with it, 0.4x.
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
    // The regex that found literals pushed a backtrack frame per character and threw RangeError from
    // 8.5M characters (v6.30.14 review r1); import-jsonl then aborted the whole transcript file.
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
