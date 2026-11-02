// What import-jsonl must keep erasing when a tool part's strings are scrubbed one by one before
// the JSON wrap. That change (53659d1f) was withdrawn at the v6.30.13 pre-tag review: scrubbing a
// string as raw text let an empty credential label (`POSTGRES_PASSWORD:` with nothing after it)
// take the next line's label as its value, so that line's credential was stored. A next attempt
// has to keep both cases below green; both pass on the whole-text scrub import-jsonl uses today.
// Tokens are assembled, never written whole.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-helpers.mjs';
import { importJsonl } from '../lib/import-jsonl.mjs';

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

describe('import-jsonl — what a per-string scrub must not lose', () => {
  // A string scrubbed on its own never sees the object key that labels it.
  it('an object key that names a credential is read as a label', async () => {
    const row = await importPair('mcp__k8s__env', { env: { api_key: V1 } }, [{ type: 'text', text: 'ok' }]);
    expect(row.narrative).not.toContain(V1);
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
});
