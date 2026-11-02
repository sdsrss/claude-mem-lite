// D#683: a credential label with an empty value (`POSTGRES_PASSWORD:`, `password =`, `token:`) took the
// next line's first token as its value, because the whitespace after the separator ran over the line
// break. When that token was a label (`JWT_SECRET:`, `api_key =`, `"api_key":`), the label was erased
// and its value, which no pattern recognised any more, was stored. One row per changed pattern, plus
// the compose / INI / YAML files a `cat` prints. A value written on the line after its own label (YAML
// continuation, prettier's break after `=`, base64 padding, CRLF) is still erased: the guards below.
// Each condition of the next-line label test has a row that fails without it (v6.30.13 r1).
import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrub.mjs';

// Assembled at run time so the file holds no secret-shaped literal.
const V = 'Rk' + '8vQ2' + 'mZx7Lp4N';

// [name, text, a label of the next line that must survive]
const LEAKS = [
  ['password= then a `NAME: v` line', `DB_PASSWORD=\nJWT_SECRET: ${V}\n`, 'JWT_SECRET'],
  [
    'password: (config position) then a `NAME: v` line',
    `  password:\n  client_secret: ${V}\n`,
    'client_secret',
  ],
  [
    'password: (prose position) then a `NAME: v` line',
    `the db password:\nclient_secret: ${V}\n`,
    'client_secret',
  ],
  ['token: then a `NAME: v` line', `  token:\n  client_secret: ${V}\n`, 'client_secret'],
  ['api_key: then a `NAME: "v"` line', `  api_key:\n  client_secret: "${V}"\n`, 'client_secret'],
  ['password= then a quoted key', `DB_PASSWORD=\n"api_key": "${V}"\n`, '"api_key"'],
  ['password: then a quoted key', `password:\n"api_key": "${V}"\n`, '"api_key"'],
  ['token: then a quoted key', `token:\n"api_key": "${V}"\n`, '"api_key"'],
  ['api_key: then a quoted key', `api_key:\n"password": "${V}"\n`, '"password"'],
  ['"authorization": then a quoted key', `"authorization":\n"api_key": "${V}"\n`, '"api_key"'],
  ['DATABASE_URL: then a `NAME: v` line', `DATABASE_URL:\nSUPABASE_KEY: ${V}\n`, 'SUPABASE_KEY'],
  ['"password": then a quoted key', `"password":\n"api_key": "${V}"\n`, '"api_key"'],
  ['"db_password": then a quoted key', `"db_password":\n"github_token": "${V}"\n`, '"github_token"'],
  ["'password': then a quoted key", `'password':\n'github_token': '${V}'\n`, "'github_token'"],
  [
    'docker compose environment',
    `    environment:\n      POSTGRES_PASSWORD:\n      JWT_SECRET: ${V}\n      POSTGRES_DB: app\n`,
    'JWT_SECRET',
  ],
  ['INI section', `[db]\n  password =\n  api_key = ${V}\n  host = x\n`, 'api_key'],
  ['YAML mapping', `auth:\n  token:\n  client_secret: ${V}\n`, 'client_secret'],
  ['CRLF line breaks', `password:\r\nJWT_SECRET: ${V}\r\n`, 'JWT_SECRET'],
  ['Markdown label on the next line', `password:\n**API_KEY**: ${V}\n`, '**API_KEY**'],
];

describe('D#683: an empty credential label does not take the next line', () => {
  it.each(LEAKS)('%s', (_name, text, label) => {
    const out = scrubSecrets(text);
    expect(out).not.toContain(V);
    expect(out).toContain(label);
  });

  it.each([
    ['a `NAME: v` line', '  POSTGRES_PASSWORD:\n  POSTGRES_DB: app\n'],
    ['a quoted `"name" = v` line', 'password =\n"region" = "eu-west-1"\n'],
  ])('keeps the next line when it is not a credential: %s', (_name, text) => {
    expect(scrubSecrets(text)).toBe(text);
  });

  it.each([
    ['a YAML value on the line after its label', `password:\n  ${V}\n`],
    ['a string prettier moved below `=`', `const DB_PASSWORD =\n  "${V}";\n`],
    ['a string prettier moved below a property name', `  api_key:\n    "${V}",\n`],
    ['a base64 value ending in `==` on the line after its label', `password:\n  ${V}==\n`],
    ['a base64 value ending in `=` on the line after its label', `password:\n  ${V}=\n`],
    ['a value holding a colon on the line after its label', `token:\n  user:${V}\n`],
    ['a value on the line after its label, CRLF', `password:\r\n  ${V}\r\n`],
    ['a quoted value on the line after its label, CRLF', `password:\r\n  "${V}"\r\n`],
  ])('still erases %s', (_name, text) => {
    expect(scrubSecrets(text)).not.toContain(V);
  });
});
