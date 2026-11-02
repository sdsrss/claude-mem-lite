// import-jsonl stores up to 4000 characters of each tool part (a tool_use input, a tool_result
// content) whole. It used to scrub the JSON TEXT of a parsed object: every string in it was one
// escape level deep, where the scrubber's raw-text rules do not hold (a label at an escaped line
// start, a JSON object inside a string, a key printed one string per line), and a key the scrubber
// could not read (the diff of a key that gained a passphrase, a body line in a hunk header) was
// stored like any other text. The live capture path never stored these: its description window is
// cut at the first private-key marker (utils.mjs scrubTruncate). Measured 2026-11-02 over 12 shape
// groups: the live path stored 0, import-jsonl 7.
//
// Now each string is scrubbed where it is text, before the JSON wrap, and a part keeps only what
// comes before its first private-key marker — nothing at all when that marker is an END.
// Keys are generated per run (node:crypto) and tokens are assembled, never written whole.

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

async function importPair(name, input, content) {
  const file = join(dir, 't.jsonl');
  const lines = [
    {
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-11-02T00:00:00Z',
      message: { content: [{ type: 'tool_use', id: 'tu1', name, input }] },
    },
    {
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-11-02T00:00:01Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content }] },
    },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  await importJsonl(db, file, { project: 'p' });
  const rows = db.prepare('SELECT title, narrative, text FROM observations').all();
  expect(rows, 'premise: one observation imported').toHaveLength(1);
  return rows[0];
}

const V1 = 'Zr7Kq2Lm' + '9Xv4Tp8W';
const V2 = 'hunter2' + 'hunter2xx';
const V3 = 'a8f3e9d2' + '7c41b5e6';

describe('import-jsonl — strings are scrubbed as text, before the JSON wrap', () => {
  // The whole-text scrub still runs after the per-string one (it reads object keys as labels), and
  // its value at an escaped break runs on to the closing quote as before (D#668), so only the
  // lines ahead of the first label are pinned here.
  it('a Write of a .env: labels at line starts lose their values (D#663, D#668)', async () => {
    const env = `# ci\nPORT=3000\ntoken: ${V3}\npassword=${V2}\ngithub_token: ${V1}\nLOG_LEVEL=info\n`;
    expect(scrubSecrets(JSON.stringify({ content: env })), 'premise: the JSON text keeps a value').toMatch(
      new RegExp(`${V1}|${V2}|${V3}`),
    );
    const row = await importPair(
      'Write',
      { file_path: '/w/ci.env', content: env },
      'File created successfully at: /w/ci.env',
    );
    for (const v of [V1, V2, V3]) expect(row.narrative).not.toContain(v);
    expect(row.narrative).toContain('PORT=3000');
  });

  it('an object key that names a credential: the whole-text scrub still reads it as a label', async () => {
    const out = [{ type: 'text', text: 'ok' }];
    const row = await importPair('mcp__k8s__env', { env: { api_key: V1 } }, out);
    expect(row.narrative).not.toContain(V1);
  });

  it('an MCP result holding a JSON object: its credential values are not stored (D#664)', async () => {
    const cfg = JSON.stringify({ api_key: V1, password: V2, region: 'eu-west-1' }, null, 2);
    expect(
      scrubSecrets(JSON.stringify([{ type: 'text', text: cfg }])),
      'premise: the JSON text keeps a value',
    ).toMatch(new RegExp(`${V1}|${V2}`));
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

  it('a <private> pair split across two strings is still erased between its tags', async () => {
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
    expect(row.narrative.split('\n---\n')[1]).toBe(`${diff.slice(0, diff.indexOf('-----BEGIN'))}`);
    expect(keptWindows(row.narrative, bodyEnc)).toBe(0);
    expect(keptWindows(row.narrative, bodyPlain)).toBe(0);
  });

  it('git show with a body line as the hunk header context: the part is stored empty (D#671)', async () => {
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
    expect(row.narrative.split('\n---\n')[1]).toBe('');
  });

  it('a complete key in command output: the text before it is kept, nothing from its BEGIN on', async () => {
    const out = `config loaded from /etc/app\n${pemPlain}trailing-note-after-key\n`;
    const row = await importPair('Bash', { command: 'cat app.conf' }, out);
    expect(row.narrative.split('\n---\n')[1]).toBe('config loaded from /etc/app\n');
    expect(keptWindows(row.narrative, bodyPlain)).toBe(0);
  });

  it('a key in a tool input string empties every string after it', async () => {
    const input = {
      file_path: '/w/key.pem',
      content: `note before\n${pemPlain.slice(0, 120)}`,
      extra: `after ${V1}`,
    };
    const row = await importPair('Write', input, 'File created successfully at: /w/key.pem');
    expect(row.narrative).toContain('note before');
    expect(row.narrative).not.toContain('BEGIN');
    expect(row.narrative).not.toContain('after');
  });
});
