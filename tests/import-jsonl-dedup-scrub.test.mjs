// The cross-run dedup key and the stored title have to be the SAME string, and one of them
// was scrubbed (R12 pre-ship review P3-4). `importToolPair` stores `scrubRecord(...).title`;
// `tryImportToolPair` synthesized its lookup key from the RAW input. For every transcript
// whose title contains a secret — a `curl -H "Authorization: Bearer …"` is enough — the two
// strings never matched, so re-importing the same file re-added the row every time. Measured
// pre-fix: run 1 observations=1, run 2 observations=2.
//
// It predates the round that surfaced it and was harmless while imported rows carried no
// junction entries. Once file edges were written (D#35), a duplicate row became a duplicate
// EDGE, which is a duplicate in the file-recall window.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-helpers.mjs';
import { importJsonl } from '../lib/import-jsonl.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';

// Long enough to trip the bearer-token pattern; short enough to survive the 80-char title cut.
const SECRET_CMD = 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnop" https://x';
// A path whose directory segment matches a token pattern — the scrubber rewrites the
// segment, so the title of an Edit to this file differs from the raw one.
const SCRUBBED_PATH = '/tmp/sk-ant-api03-abcdefghijklmnop/alpha.mjs';

function toolPair(name, input, id, session = 'scrub-1') {
  return [
    JSON.stringify({
      type: 'assistant',
      sessionId: session,
      timestamp: '2026-09-11T00:00:00Z',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    }),
    JSON.stringify({
      type: 'user',
      sessionId: session,
      timestamp: '2026-09-11T00:00:01Z',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    }),
  ].join('\n');
}

describe('importJsonl — a scrubbed title still deduplicates across runs', () => {
  let db;
  let dir;
  beforeEach(() => {
    db = createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'mem-import-scrub-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fixture() {
    const file = join(dir, 'secret.jsonl');
    writeFileSync(file, toolPair('Bash', { command: SECRET_CMD }, 'u1') + '\n');
    return file;
  }

  it('premise: the title this fixture produces IS rewritten by the scrubber', () => {
    // Without this the test below passes for a reason that has nothing to do with the fix.
    const raw = `Bash: ${SECRET_CMD.slice(0, 80)}`;
    expect(scrubSecrets(raw), 'fixture no longer contains anything the scrubber rewrites').not.toBe(raw);
  });

  it('re-importing the same transcript does not duplicate the observation', async () => {
    const file = fixture();
    const first = await importJsonl(db, file, { project: 'proj' });
    expect(first.observations, 'fixture did not import at all').toBe(1);
    const second = await importJsonl(db, file, { project: 'proj' });
    expect(second.observations, 'the second run re-imported a row it had already stored').toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n).toBe(1);
  });

  it('the duplicate would have carried a duplicate file edge', async () => {
    // The same asymmetry on an Edit, which is where it costs something: the title is built
    // from the PATH, and a path holding a token-shaped segment is rewritten by the scrubber,
    // so the re-import adds a second (obs, file) row for one edit. A first cut of this case
    // put the secret in `old_string` and passed before the fix as well — the title never
    // reads that field, so it asserted nothing.
    const file = join(dir, 'edit.jsonl');
    writeFileSync(
      file,
      toolPair('Edit', { file_path: SCRUBBED_PATH, old_string: 'a', new_string: 'b' }, 'u2') + '\n',
    );
    await importJsonl(db, file, { project: 'proj' });
    await importJsonl(db, file, { project: 'proj' });
    const edges = db
      .prepare('SELECT COUNT(*) AS n FROM observation_files WHERE filename = ?')
      .get(SCRUBBED_PATH);
    expect(edges.n, 'one edit produced more than one file edge').toBe(1);
  });
});

describe('importJsonl — a Read records what a Read can read', () => {
  let db;
  let dir;
  beforeEach(() => {
    db = createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'mem-import-read-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a Read carrying only notebook_path records no files_read', async () => {
    // D#35 routed both columns through one `toolEditPath` helper, which answers
    // `file_path ?? notebook_path` — correct for the edit side, and it silently gave the
    // READ side a shape no Read tool emits. Undeclared behaviour change, fixed by asking
    // the question the column actually asks.
    const file = join(dir, 'read.jsonl');
    writeFileSync(file, toolPair('Read', { notebook_path: '/repo/nb.ipynb' }, 'u3') + '\n');
    await importJsonl(db, file, { project: 'proj' });
    const row = db.prepare('SELECT files_read, files_modified FROM observations').get();
    expect(row, 'fixture did not import').toBeTruthy();
    expect(JSON.parse(row.files_read)).toEqual([]);
    expect(JSON.parse(row.files_modified)).toEqual([]);
  });

  it('a Read carrying file_path still records it', async () => {
    const file = join(dir, 'read2.jsonl');
    writeFileSync(file, toolPair('Read', { file_path: '/repo/beta.mjs' }, 'u4') + '\n');
    await importJsonl(db, file, { project: 'proj' });
    const row = db.prepare('SELECT files_read FROM observations').get();
    expect(JSON.parse(row.files_read)).toEqual(['/repo/beta.mjs']);
  });
});
