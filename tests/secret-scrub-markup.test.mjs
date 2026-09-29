// D#128 / D#131 — a label wrapped in inline markdown hid its value from every label pattern:
// `- **Password**: \`<v>\`` put `**` between the noun and its separator, so nothing matched and
// the value was stored — in a report Done (v6.18.0 security review P2-2), and equally in a
// prompt or observation. Models write that shape constantly. The fix lets the label patterns
// step over up to three markup characters (`*`, `_`, `~`, backtick) after the noun and after
// the separator, and moves the prose check to before any opening markup, so
// `the **password**: instructions` is still prose.
//
// Fixtures are assembled so no line is a complete credential literal (push protection).
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';
import { writeStopSummary, FAST_SUMMARY_LIMITS } from '../lib/fast-summary.mjs';
import { insertSession } from './test-helpers.mjs';

const V = 'S3cr' + '3t-Value_77';

describe('markup-wrapped labels are still labels (D#128)', () => {
  it.each([
    ['bold label, code value', `- **Password**: \`${V}\``],
    ['bold label', `**password**=${V}`],
    ['bold env var', `**DB_PASSWORD**=${V}`],
    ['colon inside bold', `**Password:** ${V}`],
    ['underscore bold', `__password__=${V}`],
    ['italic', `_token_: ${V}`],
    ['strikethrough', `~~secret~~: ${V}`],
    ['code label', `\`api_key\`: ${V}`],
    ['code env var', `\`GH_TOKEN\`: ${V}`],
    ['code label, structured', `set \`client_secret\` = ${V} there`],
    ['bold Authorization', `**Authorization**: Bearer ${V}`],
    ['bold label in prose, credential-shaped value', `the **password**: ${V}`],
  ])('%s', (_name, input) => {
    const out = scrubSecrets(input);
    expect(out).not.toContain(V);
    expect(out).toContain('***');
  });

  it.each([
    ['prose, letters-only value', 'Reset the **password**: instructions are in the doc'],
    ['prose, code label', 'see the `token`: rotation happens nightly'],
    ['bold heading word', '**Token** budget: 2000 per session'],
    ['compound name is not a label', '**password_hint**: remember the dog'],
    // The letters-only prose exemption stopped at a closing backtick: quoted in a code span,
    // this sentence lost its last word (found by the FP sweep, 2026-09-27).
    ['quoted in a code span', 'so `the **password**: instructions` is still left alone'],
    ['quoted in a code span, plain label', 'so `the password: instructions` is still left alone'],
    // Emphasis does not turn a prose `token:` into config.
    ['prose, bold token', 'the **token**: abc123xyz is a placeholder'],
    ['prose, bold token, quoted value', 'the **token**: "abc123xyz" is a placeholder'],
  ])('leaves prose alone: %s', (_name, input) => {
    expect(scrubSecrets(input)).toBe(input);
  });

  // One row per label pattern, so a change to any single pattern's markup handling fails here.
  // Labels are chosen so no neighbouring pattern catches the row for free (`client_secret`
  // would also match the token group through `_secret`; a mixed value would also match the
  // prose arm).
  const Q = (v) => `"${v}"`;
  const LETTERS = 'hunterpassx';
  const FAMILIES = [
    ['1a =', (l, v) => `${l}=${v}`, 'password', V],
    ['1a = token', (l, v) => `${l}=${v}`, 'token', V],
    ['1b : config arm (letters-only value)', (l, v) => `${l}: ${v}`, 'password', LETTERS],
    ['1b : prose arm', (l, v) => `the ${l}: ${v}`, 'password', V],
    ['1c :', (l, v) => `${l}: ${v}`, 'secret', V],
    ['structured', (l, v) => `${l}: ${v}`, 'api_key', V],
    ['quoted =', (l, v) => `${l}=${Q(v)}`, 'password', V],
    ['quoted : password', (l, v) => `${l}: ${Q(v)}`, 'password', V],
    ['quoted : token', (l, v) => `${l}: ${Q(v)}`, 'token', V],
    ['quoted structured', (l, v) => `${l}: ${Q(v)}`, 'api_key', V],
    ['Authorization', (l, v) => `${l}: Bearer ${v}`, 'Authorization', V],
  ];
  it.each(FAMILIES)('%s: bold label, colon inside bold, fullwidth colon', (_name, shape, label, v) => {
    const bold = shape(`**${label}**`, v);
    const inside = shape(`**${label}`, v).replace(/(=|: )/, (m) => `${m.trim()}** `);
    const wide = shape(label, v).replace(/[:=]/, '：');
    for (const input of [bold, inside, wide]) expect(scrubSecrets(input), input).not.toContain(v);
  });

  // A label named in a code span and then followed by prose: the closing backtick is not
  // markup between the separator and a value (FP sweep, 2026-09-27).
  it.each([
    ['CJK', '所以行首的 `password:` 从散文位翻成配置位'],
    ['English', 'set `token:` followed by the value'],
    ['assignment', 'the literal `password=` prefix with the value'],
  ])('a code-span label followed by prose is left alone: %s', (_name, input) => {
    expect(scrubSecrets(input)).toBe(input);
  });
  it.each(FAMILIES)('%s: a code-span label followed by prose is left alone', (_name, shape, label) => {
    // The label and its separator in a code span, then ordinary words where the value was.
    const input = shape(label, 'VALUE')
      .replace(/(=|: )/, (m) => `${m.trim()}\` `)
      .replace(label, `\`${label}`)
      .replace(/"?VALUE"?/, (m) => (m.startsWith('"') ? '"followed by prose"' : 'followed by prose'));
    expect(scrubSecrets(input), input).toBe(input);
  });

  it('a report Done carrying the shape stores no value (security review P2-2)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    insertSession(db, { id: 's', project: 'p' });
    writeStopSummary(db, {
      sessionId: 's',
      project: 'p',
      report: { done: `- **Password**: \`${V}\` set on staging`, notDone: '', lines: '' },
      source: { request: 'r', completed: '' },
      now: new Date('2026-09-27T00:00:00Z'),
      limits: FAST_SUMMARY_LIMITS.stop,
    });
    const { completed } = db.prepare('SELECT completed FROM session_summaries').get();
    expect(completed).toContain('set on staging');
    expect(completed).not.toContain(V);
    db.close();
  });
});

describe('natural-writing gaps from the v6.18.0 fuzz (D#131)', () => {
  it.each([
    ['fullwidth colon', `password：${V}`],
    ['fullwidth colon, structured key', `api_key：${V}`],
    ['JSON *_TOKEN key', `{"GH_TOKEN": "${V}"}`],
    ['JSON *_token key, single quotes', `{'csrf_token': '${V}'}`],
  ])('%s', (_name, input) => {
    expect(scrubSecrets(input)).not.toContain(V);
  });

  // A provider key followed by `_` or a letter had no \b after it, so the whole key survived.
  it.each([
    ['AWS', 'AKIA' + 'IOSFODNN7' + 'EXAMPLE', '_old'],
    ['Stripe', 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2', '_rotated'],
    ['Stripe webhook', 'whsec_' + 'a1B2c3D4e5F6g7H8i9J0k1L2', '_v2'],
    ['npm', 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', '_ci'],
  ])('%s key followed by a suffix', (_name, key, tail) => {
    expect(scrubSecrets(`${key}${tail}`)).not.toContain(key);
  });

  it('keeps benign JSON keys that only end in "tokens" or carry counts', () => {
    const benign = '{"max_tokens": 1024, "token_count": "123456789", "tokenizer": "cl100k_base"}';
    expect(scrubSecrets(benign)).toBe(benign);
  });
});
