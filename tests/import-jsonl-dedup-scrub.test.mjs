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
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  // The property the fix actually rests on is STRUCTURAL: each side applies the scrubber
  // exactly once, to the same raw string. The first cut scrubbed inside `importedObsTitle`,
  // which left storage scrubbed twice (`scrubRecord` scrubs `title` again) against the
  // preview's once — equal only while `scrubSecrets` is idempotent.
  //
  // Kept alongside the behavioural case below, not instead of it. I first wrote that "no
  // input is known that makes the difference observable" — 300,000 fuzzed titles came back
  // stable — and that was a statement about my generator, not about the scrubber: its
  // alphabet had no `@`, and the grower that creates the drift needs one. Two reviewers each
  // produced a drifting string within minutes. The behavioural case is the braces now; this
  // scan is the belt, because it fails on the double-scrub shape even for the inputs where
  // `scrubSecrets` happens to be stable.
  it('the title is scrubbed exactly once on each side, by construction', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../lib/import-jsonl.mjs'), 'utf8');
    const fn = src.slice(src.indexOf('function importedObsTitle'), src.indexOf('function dedupKey'));
    expect(fn, 'premise: importedObsTitle must be findable').toContain('toolEditPath');
    expect(fn, 'importedObsTitle scrubs, so the storage path scrubs twice').not.toMatch(
      /(^|[^a-zA-Z_.])scrubSecrets\(/,
    );
    // Both consumers hand the raw title to scrubRecord, which is the single scrub.
    expect(src).toContain("scrubRecord('observations', { title: importedObsTitle(useEv) }).title");
    expect(src).toMatch(/title: importedObsTitle\(toolUse\),/);
  });

  // The case the source scan above could not be: a title on which `scrubSecrets` is NOT
  // idempotent, so a double-scrubbed storage side and a single-scrubbed preview genuinely
  // disagree. Measured against the pre-amendment code this imported 3 rows for 3 runs.
  it('a title where the scrubber is not idempotent still deduplicates across runs', async () => {
    const title = 'deploy --token ghp_1234567890abcdefghijk secret: hunter2correct';
    // Premise: this input must actually drift under a second scrub, or the case is testing
    // nothing that the plain dedup case above does not already cover.
    const once = scrubSecrets(`Bash: ${title.slice(0, 80)}`);
    expect(scrubSecrets(once), 'fixture is no longer non-idempotent').not.toBe(once);

    const file = join(dir, 'nonidem.jsonl');
    writeFileSync(file, toolPair('Bash', { command: title }, 'u7') + '\n');
    for (let i = 0; i < 3; i++) await importJsonl(db, file, { project: 'proj' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n).toBe(1);
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
