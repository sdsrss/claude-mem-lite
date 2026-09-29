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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './test-helpers.mjs';
import { importJsonl } from '../lib/import-jsonl.mjs';
import { scrubSecrets } from '../secret-scrub.mjs';

// Every scrubSecrets input, in order; the real function still runs. scrub-record.mjs
// imports the same module id, so scrubRecord's calls are counted too.
const scrubCalls = vi.hoisted(() => []);
vi.mock('../secret-scrub.mjs', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    scrubSecrets: (s, ...rest) => {
      if (typeof s === 'string') scrubCalls.push(s);
      return real.scrubSecrets(s, ...rest);
    },
  };
});

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

  // The property the dedup rests on: each side scrubs the title exactly ONCE, through the
  // same function. Counted behaviourally — every scrubSecrets call whose input is a title
  // (`Bash: …`; the body starts with the input JSON) — because the source-text scan this
  // replaced (D#47 P3-9) false-redded on a comment, a Prettier re-wrap and a variable
  // rename, and stayed green when the helper scrubbed through scrubRecord instead of
  // scrubSecrets. A second scrub on either side, or a side that stops scrubbing, moves the
  // count off two.
  it('the title is scrubbed exactly once on each side', async () => {
    const file = join(dir, 'count.jsonl');
    writeFileSync(file, toolPair('Bash', { command: 'echo count-once-marker' }, 'u10') + '\n');
    scrubCalls.length = 0;
    await importJsonl(db, file, { project: 'proj' });
    const titles = scrubCalls.filter((s) => s.startsWith('Bash: echo count-once-marker'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 'premise: imported').toBe(1);
    expect(titles, 'preview once + storage once').toHaveLength(2);
    expect(titles[0]).toBe(titles[1]); // both sides scrubbed the SAME raw string
  });

  // This case used to carry a title on which `scrubSecrets` was NOT idempotent, so a
  // double-scrubbed storage side and a single-scrubbed preview genuinely disagreed —
  // measured against the pre-amendment code it imported 3 rows for 3 runs.
  //
  // D#52 (2026-09-22) RETIRED that discriminating power on purpose. The drift came from
  // the prose lookbehind reading the tail of a previous match's value as an English word,
  // which also meant the SECOND labelled secret on a line shipped in plaintext; scrubbing
  // to a fixed point closes the leak and makes this function idempotent, so no drifting
  // input exists any more. Say the cost out loud rather than quietly keeping a green case:
  // this file used to hold TWO independent detectors for the v6.8.0 double-scrub bug and
  // now holds one, the structural scan above. The replacement is not here — it is the
  // idempotence invariant itself, guarded directly in tests/secret-scrub-coverage.test.mjs
  // ('scrubSecrets — D#52 adjacent labelled secrets on one line'), which is a stronger
  // thing to pin than any single consequence of it.
  //
  // What stays here is the behavioural half that still means something: a title the
  // scrubber REWRITES must dedup across runs.
  it('a scrubbed title still deduplicates across runs', async () => {
    const title = 'deploy --token ghp_1234567890abcdefghijk secret: hunter2correct';
    // Premise 1: the scrubber must actually rewrite this title, or the case degenerates
    // into the plain dedup case below.
    const raw = `Bash: ${title.slice(0, 80)}`;
    const once = scrubSecrets(raw);
    expect(once, 'fixture no longer contains anything the scrubber rewrites').not.toBe(raw);
    // Premise 2: and it must now be STABLE under a second scrub. This is the assertion that
    // replaces the old non-idempotence premise — if it ever fails, the v6.8.0 bug class is
    // observable again and the detector this case gave up needs rebuilding.
    expect(scrubSecrets(once), 'scrubSecrets is non-idempotent again (D#52 regressed)').toBe(once);

    const file = join(dir, 'nonidem.jsonl');
    writeFileSync(file, toolPair('Bash', { command: title }, 'u7') + '\n');
    for (let i = 0; i < 3; i++) await importJsonl(db, file, { project: 'proj' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n).toBe(1);
  });

  // D#47 P3-8: the title was cut to 80 characters and THEN scrubbed, so a token straddling
  // the cut arrived too short for its own pattern (`ghp_` needs 30+) and was stored as a
  // plaintext prefix: here `ghp_` plus 14 secret characters. Assembled, never written whole
  // — a literal this realistic trips push protection on the whole release.
  it('a token straddling the 80-character title cut is scrubbed, not stored as a prefix', async () => {
    const token = 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'Z9x8';
    const cmd = `echo ${'x'.repeat(56)} ${token} | gh auth login --with-token`;
    // Premise: the cut really does split the token, leaving a prefix the scrubber passes.
    const cutFirst = scrubSecrets(`Bash: ${cmd.slice(0, 80)}`);
    expect(cutFirst, 'premise: the old order leaks a token prefix').toMatch(/gh[p]_[A-Za-z0-9]{8,}/);

    const file = join(dir, 'straddle.jsonl');
    writeFileSync(file, toolPair('Bash', { command: cmd }, 'u8') + '\n');
    await importJsonl(db, file, { project: 'proj' });
    const { title } = db.prepare('SELECT title FROM observations').get();
    expect(title).not.toMatch(/gh[p]_[A-Za-z0-9]{8,}/);
    expect(title, 'the cut still bounds the stored detail').toHaveLength('Bash: '.length + 80);
    // And the stored title is still the cross-run key.
    await importJsonl(db, file, { project: 'proj' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n).toBe(1);
  });

  // The same cut-then-scrub order sat on the three other length caps in this file (pre-ship
  // review, v6.12.2): the tool input and an array-shaped tool result are each cut to 4000
  // characters for the body (`text` + `narrative`, both search-indexed), and a prompt to
  // 10000. Each case puts the token across its own cap.
  describe('the body and prompt caps scrub before they cut', () => {
    const token = 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'Z9x8';
    const LEAK = /gh[p]_[A-Za-z0-9]{8,}/;
    const straddle = (cap, lead = 0) => `${'x'.repeat(cap - 20 - lead)} ${token} tail`;

    it('tool input straddling 4000', async () => {
      // JSON.stringify adds `{"command":"` (12 chars) before the command text.
      const cmd = straddle(4000, 12);
      expect(JSON.stringify({ command: cmd }).slice(0, 4000), 'premise: the cut splits it').toMatch(LEAK);
      const file = join(dir, 'in.jsonl');
      writeFileSync(file, toolPair('Bash', { command: cmd }, 'b1') + '\n');
      await importJsonl(db, file, { project: 'proj' });
      const row = db.prepare('SELECT text, narrative FROM observations').get();
      expect(row.text).not.toMatch(LEAK);
      expect(row.narrative).not.toMatch(LEAK);
    });

    it('array-shaped tool result straddling 4000', async () => {
      const content = [{ type: 'text', text: straddle(4000, 22) }];
      expect(JSON.stringify(content).slice(0, 4000), 'premise: the cut splits it').toMatch(LEAK);
      const file = join(dir, 'res.jsonl');
      const [use, res] = toolPair('Bash', { command: 'cat log' }, 'b2').split('\n');
      const r = JSON.parse(res);
      r.message.content[0].content = content;
      writeFileSync(file, `${use}\n${JSON.stringify(r)}\n`);
      await importJsonl(db, file, { project: 'proj' });
      const row = db.prepare('SELECT text, narrative FROM observations').get();
      expect(row.text).not.toMatch(LEAK);
      expect(row.narrative).not.toMatch(LEAK);
    });

    it('user prompt straddling 10000', async () => {
      const text = straddle(10000);
      expect(text.slice(0, 10000), 'premise: the cut splits it').toMatch(LEAK);
      const file = join(dir, 'prompt.jsonl');
      writeFileSync(
        file,
        JSON.stringify({
          type: 'user',
          sessionId: 'scrub-1',
          timestamp: '2026-09-11T00:00:00Z',
          message: { content: text },
        }) + '\n',
      );
      await importJsonl(db, file, { project: 'proj' });
      const row = db.prepare('SELECT prompt_text FROM user_prompts').get();
      expect(row, 'premise: the prompt imported').toBeTruthy();
      expect(row.prompt_text).not.toMatch(LEAK);
      expect(row.prompt_text.length, 'the cap still bounds it').toBeLessThanOrEqual(10000);
    });
  });

  it('control: a secret past the cut leaves the kept 80 characters byte-identical', async () => {
    // The axis the reorder moves is "which text the scrubber sees"; it now sees text beyond
    // the cut, so pin that nothing inside the kept window changes because of it.
    const cmd = `${'git log --oneline -20 && echo done '.repeat(3)}\npassword: hunter2correct`;
    expect(cmd.indexOf('password'), 'premise: the secret starts past the cut').toBeGreaterThan(80);
    const file = join(dir, 'control.jsonl');
    writeFileSync(file, toolPair('Bash', { command: cmd }, 'u9') + '\n');
    await importJsonl(db, file, { project: 'proj' });
    const { title } = db.prepare('SELECT title FROM observations').get();
    expect(title).toBe(`Bash: ${cmd.slice(0, 80)}`);
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
    // D#44 moved the stored key: the junction used to hold the RAW path while the
    // title derived from it was scrubbed, and this assertion pinned that asymmetry
    // by querying the raw spelling. The case is about DUPLICATE edges, so it now
    // counts rows for the observation and states the stored spelling separately —
    // a literal in the WHERE clause made a leak look like a passing dedup test.
    const total = db.prepare('SELECT COUNT(*) AS n FROM observation_files').get().n;
    expect(total, 'one edit produced more than one file edge').toBe(1);
    const stored = db.prepare('SELECT filename FROM observation_files').get().filename;
    expect(stored, 'the junction still stores the raw path').toBe(scrubSecrets(SCRUBBED_PATH));
    expect(stored).not.toContain('sk-ant-api03-abcdefghijklmnop');
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
