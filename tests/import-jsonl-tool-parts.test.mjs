// import-jsonl stores up to 4000 characters of each tool part (a tool_use input, a tool_result
// content). It scrubbed the JSON TEXT of a parsed object, where every string sits one escape level
// deep and the scrubber's raw-text rules do not hold (a label at an escaped line start, a JSON
// object inside a string, a key printed one string per line), and it stored a key the scrubber
// cannot read (the diff of a key that gained a passphrase, a body line as a hunk header's context)
// like any other text. Now each string is scrubbed where it is text, before the JSON wrap, and a
// part keeps only what comes before its first private-key marker: nothing at all when that marker
// is an END.
//
// A first attempt (53659d1f) was withdrawn at the v6.30.13 pre-tag review: scrubbing strings as
// raw text exposed D#683 (an empty credential label took the next line's label), and its
// JSON.stringify replacer recursed, so a deeply nested part aborted the whole transcript. Both are
// pinned below. Keys are generated per run (node:crypto); tokens are assembled, never written whole.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-helpers.mjs';
import { importJsonl } from '../lib/import-jsonl.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';

let pemPlain, pemEnc, bodyPlain, bodyEnc;
beforeAll(() => {
  const key = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
  pemPlain = key.export({ type: 'pkcs1', format: 'pem' });
  pemEnc = key.export({
    type: 'pkcs1',
    format: 'pem',
    cipher: 'aes-128-cbc',
    passphrase: 'pw-for-test-only',
  });
  const body = (pem) => pem.split('\n').filter((l) => /^[A-Za-z0-9+/=]{16,}$/.test(l));
  bodyPlain = body(pemPlain);
  bodyEnc = body(pemEnc);
});

// Any 16-character window of a key body line in the stored text.
function keptWindows(text, lines) {
  const win = new Set();
  for (const l of lines) for (let i = 0; i + 16 <= l.length; i++) win.add(l.slice(i, i + 16));
  let n = 0;
  for (let i = 0; i + 16 <= text.length; i++) if (win.has(text.substr(i, 16))) n++;
  return n;
}

let db, dir;
beforeEach(() => {
  db = createTestDb();
  dir = mkdtempSync(join(tmpdir(), 'mem-import-parts-'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function importLines(lines) {
  const file = join(dir, 't.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  await importJsonl(db, file, { project: 'p' });
  const rows = db.prepare('SELECT title, narrative, text FROM observations').all();
  expect(rows, 'premise: one observation imported').toHaveLength(1);
  const [input_, result] = rows[0].narrative.split('\n---\n');
  return { ...rows[0], input: input_, result };
}

// The two transcript lines of one tool call, `input` and `content` given as JSON text.
const pairLines = (name, inputJson, contentJson) => [
  `{"type":"assistant","sessionId":"s1","timestamp":"2026-11-02T00:00:00Z","message":{"content":[{"type":"tool_use","id":"tu1","name":${JSON.stringify(name)},"input":${inputJson}}]}}`,
  `{"type":"user","sessionId":"s1","timestamp":"2026-11-02T00:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":${contentJson}}]}}`,
];

const importPair = (name, input, content) =>
  importLines(pairLines(name, JSON.stringify(input), JSON.stringify(content)));

const V1 = 'Zr7Kq2Lm' + '9Xv4Tp8W';
const V2 = 'hunter2' + 'hunter2xx';
const V3 = 'a8f3e9d2' + '7c41b5e6';

describe('import-jsonl — strings are scrubbed as text, before the JSON wrap', () => {
  it('a Write of a .env: labels at line starts lose their values (D#663, D#668)', async () => {
    // Since D#687 the scrubber also erases these in the JSON text (it decodes the escaped string), so
    // this row and the next pass on either reading; the import's own rule is pinned by the rows below.
    const env = `# ci\nPORT=3000\ntoken: ${V3}\npassword=${V2}\ngithub_token: ${V1}\nLOG_LEVEL=info\n`;
    const row = await importPair(
      'Write',
      { file_path: '/w/ci.env', content: env },
      'File created successfully at: /w/ci.env',
    );
    for (const v of [V1, V2, V3]) expect(row.narrative).not.toContain(v);
    expect(row.narrative).toContain('PORT=3000');
  });

  // The scrubber decodes at most 256 escaped strings per text (D#687's cost bound); one after them is read
  // only by the import's own per-string scrub.
  it('a part with more escaped strings than the scrubber decodes: each string is still scrubbed', async () => {
    const input = { lines: [...Array.from({ length: 256 }, (_, i) => `a${i}\nb`), `PORT=1\nAPI_KEY=${V1}`] };
    expect(scrubSecrets(JSON.stringify(input)), 'premise: the JSON text keeps the value').toContain(V1);
    const row = await importPair('mcp__x__put', input, [{ type: 'text', text: 'ok' }]);
    expect(row.narrative).not.toContain(V1);
    expect(row.narrative).toContain('PORT=1');
  });

  // A string scrubbed on its own never sees the object key that labels it.
  it('an object key that names a credential is read as a label', async () => {
    const row = await importPair('mcp__k8s__env', { env: { api_key: V1 } }, [{ type: 'text', text: 'ok' }]);
    expect(row.narrative).not.toContain(V1);
  });

  it('an MCP result holding a JSON object: its credential values are not stored (D#664)', async () => {
    const cfg = JSON.stringify({ api_key: V1, password: V2, region: 'eu-west-1' }, null, 2);
    const row = await importPair('mcp__cfg__get', { name: 'app' }, [{ type: 'text', text: cfg }]);
    expect(row.narrative).not.toContain(V1);
    expect(row.narrative).not.toContain(V2);
    expect(row.narrative).toContain('eu-west-1');
  });

  it('an MCP result holding a key printed one string per line, cut: no body line is stored (D#662)', async () => {
    const pl = pemPlain.trim().split('\n');
    const js =
      'const PEM =\n' +
      pl
        .slice(0, 5)
        .map((l) => `  "${l}\\n" +`)
        .join('\n');
    const row = await importPair('mcp__fs__read', { path: 'key.js' }, [{ type: 'text', text: js }]);
    expect(row.narrative).toContain('const PEM');
    expect(keptWindows(row.narrative, bodyPlain)).toBe(0);
  });

  // A <private> pair can span two strings; only the whole text pairs it.
  it('a <private> pair split across two strings is erased between its tags', async () => {
    const input = {
      file_path: '/w/a.md',
      old_string: 'keep-before <private> secret-old',
      new_string: 'secret-new </private> keep-after',
    };
    const row = await importPair('Edit', input, 'ok');
    expect(row.narrative).toContain('keep-before');
    expect(row.narrative).not.toContain('secret-old');
    expect(row.narrative).not.toContain('secret-new');
  });

  // D#683, the withdrawal reason of the first attempt: as raw text, an empty credential label took
  // the next line's label as its value, and that line's value was stored.
  const EMPTY_LABEL = {
    compose: `services:\n  db:\n    environment:\n      MYSQL_PASSWORD:\n      MYSQL_ROOT_PASSWORD: ${V1}\n`,
    ini: `[database]\n  password =\n  api_key = ${V1}\n`,
    yaml: `auth:\n  token:\n  client_secret: ${V1}\n`,
  };
  it.each(Object.keys(EMPTY_LABEL))(
    'an empty label above a credential (%s), in every part shape',
    async (k) => {
      const text = EMPTY_LABEL[k];
      for (const [name, input, content] of [
        ['Write', { file_path: '/w/x.yml', content: text }, 'ok'],
        ['Edit', { file_path: '/w/x.yml', old_string: 'a', new_string: text }, 'ok'],
        ['mcp__fs__read', { path: '/w/x.yml' }, [{ type: 'text', text }]],
      ]) {
        db.exec('DELETE FROM observations');
        const row = await importPair(name, input, content);
        expect(row.narrative, `${name}`).not.toContain(V1);
      }
    },
  );

  // Written as text: on Node 22, JSON.stringify itself throws from about 5,000 levels.
  it('a deeply nested part is imported, not thrown out with its transcript', async () => {
    const depth = 20000;
    const input = '{"a":'.repeat(depth) + '{"leaf":"x"}' + '}'.repeat(depth);
    const content = '['.repeat(depth) + ']'.repeat(depth);
    const row = await importLines(pairLines('mcp__deep__call', input, content));
    expect(row.input).toBe(input.slice(0, 4000));
    expect(row.result).toBe(content.slice(0, 4000));
  });
});

describe('import-jsonl — a tool part keeps only what comes before its first private-key marker', () => {
  it('git diff of a PEM key that gained a passphrase, cut before its END: no new body line is stored (D#670)', async () => {
    const enc = pemEnc.trim().split('\n');
    const diff = [
      'diff --git a/id_rsa b/id_rsa',
      'index 9353472..03bb1f5 100644',
      '--- a/id_rsa',
      '+++ b/id_rsa',
      `@@ -1,${bodyPlain.length + 2} +1,${enc.length} @@`,
      ` ${pemPlain.split('\n')[0]}`,
      ...bodyPlain.map((l) => `-${l}`),
      ...enc.slice(1, 4).map((l) => `+${l}`),
      ...bodyEnc.slice(0, 5).map((l) => `+${l}`),
    ].join('\n');
    expect(
      keptWindows(scrubSecrets(diff), bodyEnc),
      'premise: the scrubber keeps new body lines',
    ).toBeGreaterThan(0);
    const row = await importPair('Bash', { command: 'git diff' }, diff);
    expect(row.result).toBe(`${diff.slice(0, diff.indexOf('-----BEGIN'))}`);
    expect(keptWindows(row.narrative, bodyEnc)).toBe(0);
    expect(keptWindows(row.narrative, bodyPlain)).toBe(0);
  });

  it('git show with a body line as the hunk header context and the END in the hunk: stored empty (D#671)', async () => {
    const show = [
      'commit 1111111111111111111111111111111111111111',
      'Author: t <t@e.invalid>',
      '',
      '    c',
      '',
      'diff --git a/.env b/.env',
      'index 564a09a..c6acb83 100644',
      '--- a/.env',
      '+++ b/.env',
      `@@ -14,3 +14,4 @@ ${bodyPlain[bodyPlain.length - 2]}`,
      ` ${bodyPlain[bodyPlain.length - 1]}`,
      ` ${pemPlain.trim().split('\n').at(-1)}`,
      ' "',
      '+DEBUG=1',
    ].join('\n');
    expect(
      keptWindows(scrubSecrets(show), bodyPlain),
      'premise: the scrubber keeps the header body line',
    ).toBeGreaterThan(0);
    const row = await importPair('Bash', { command: 'git show' }, show);
    expect(keptWindows(row.narrative, bodyPlain)).toBe(0);
    expect(row.result).toBe('');
  });

  it('a complete key in command output: the text before it is kept, nothing from its BEGIN on', async () => {
    const out = `config loaded from /etc/app\n${pemPlain}trailing-note-after-key\n`;
    const row = await importPair('Bash', { command: 'cat app.conf' }, out);
    expect(row.result).toBe('config loaded from /etc/app\n');
    expect(keptWindows(row.narrative, bodyPlain)).toBe(0);
  });

  it('a key in a tool input string: nothing after it is kept', async () => {
    const input = {
      file_path: '/w/key.pem',
      content: `note before\n${pemPlain.slice(0, 120)}`,
      extra: `after ${V1}`,
    };
    const row = await importPair('Write', input, 'File created successfully at: /w/key.pem');
    expect(row.input).toBe(JSON.stringify({ file_path: '/w/key.pem', content: 'note before\n' }));
  });

  it('an END first in JSON order, in a later block of an MCP result: the part is stored empty', async () => {
    const lines = pemPlain.trim().split('\n');
    const content = [
      { type: 'text', text: `tail of key.pem:\n${lines.slice(-6, -1).join('\n')}\n` },
      { type: 'text', text: `${lines.at(-1)}\n` },
    ];
    expect(content[0].text, 'premise: no marker in the first block').not.toContain('-----');
    const row = await importPair('mcp__fs__tail', { path: 'key.pem' }, content);
    expect(row.result).toBe('');
    expect(keptWindows(row.narrative, bodyPlain)).toBe(0);
  });

  it('a marker in an object key: the key is cut at the marker and nothing after it is kept', async () => {
    const keyed = `-----BEGIN RSA PRIVATE KEY-----\n${bodyPlain[0]}`;
    const input = { before: 'kept', [`note ${keyed}`]: 'v', after: `after ${V1}` };
    const row = await importPair('mcp__kv__put', input, [{ type: 'text', text: 'ok' }]);
    expect(row.input).toBe(JSON.stringify({ before: 'kept', 'note ': '' }));
    expect(keptWindows(row.narrative, bodyPlain)).toBe(0);
  });
});
