import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, truncateSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { createTestDb } from './test-helpers.mjs';
import { importJsonl, MAX_IMPORT_BYTES } from '../lib/import-jsonl.mjs';
import { scrubSecrets } from '../utils.mjs';
import { recallByFile } from '../lib/recall-core.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures/sample-claude-jsonl/sample.jsonl');

describe('importJsonl — fixture', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('imports 2 user prompts from fixture', async () => {
    const r = await importJsonl(db, FIXTURE, { project: 'proj' });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get();
    expect(cnt.n).toBe(2);
    expect(r.prompts).toBe(2);
  });

  it('imports 2 observations (one per tool_use+tool_result pair)', async () => {
    await importJsonl(db, FIXTURE, { project: 'proj' });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM observations').get();
    expect(cnt.n).toBe(2);
  });

  it('creates exactly one sdk_sessions row for the fixture sessionId', async () => {
    await importJsonl(db, FIXTURE, { project: 'proj' });
    const rows = db.prepare('SELECT content_session_id FROM sdk_sessions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].content_session_id).toBe('sess-fix-1');
  });

  it('is idempotent — re-running on the same file does not duplicate', async () => {
    await importJsonl(db, FIXTURE, { project: 'proj' });
    await importJsonl(db, FIXTURE, { project: 'proj' });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM observations').get();
    expect(cnt.n).toBe(2);
  });

  // E2E 2026-10-16 (cli F9): a line without `timestamp` was stored with the import's wall clock,
  // which is part of both dedup keys, so every re-run duplicated its prompts and observations.
  it('stays idempotent for lines without a timestamp, and keeps a repeated prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-nots-'));
    try {
      const file = join(dir, 'nots.jsonl');
      const lines = [
        {
          type: 'user',
          sessionId: 's-no-ts',
          message: { role: 'user', content: 'how do I rotate the signing key?' },
        },
        {
          type: 'assistant',
          sessionId: 's-no-ts',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls keys/' } }],
          },
        },
        {
          type: 'user',
          sessionId: 's-no-ts',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.pem b.pem' }],
          },
        },
        { type: 'user', sessionId: 's-no-ts', message: { role: 'user', content: 'yes' } },
        { type: 'user', sessionId: 's-no-ts', message: { role: 'user', content: 'yes' } },
      ];
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const first = await importJsonl(db, file, { project: 'proj' });
      expect(first.prompts).toBe(3);
      expect(first.observations).toBe(1);
      for (let i = 0; i < 2; i++) {
        const again = await importJsonl(db, file, { project: 'proj' });
        expect(again.prompts, `run ${i + 2}`).toBe(0);
        expect(again.observations, `run ${i + 2}`).toBe(0);
      }
      expect(db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get().n).toBe(3);
      expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // recognized > 0 on a valid transcript even when fully deduped — this is the
  // signal cmdImportJsonl uses to NOT mislabel an idempotent re-run as "wrong shape".
  it('reports recognized transcript events on both first import and re-run', async () => {
    const first = await importJsonl(db, FIXTURE, { project: 'proj' });
    expect(first.recognized).toBeGreaterThan(0);
    const second = await importJsonl(db, FIXTURE, { project: 'proj' });
    expect(second.recognized).toBeGreaterThan(0); // still recognized, just all deduped
    expect(second.prompts).toBe(0);
    expect(second.observations).toBe(0);
  });

  // A wrong-shape file (e.g. `export` output: observation-shaped JSON with no
  // user/assistant/tool_result events) yields recognized === 0 — the genuine
  // "wrong shape" signal that must still fire the warning.
  it('reports recognized === 0 for non-transcript (export-shaped) input', async () => {
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/export-shaped.jsonl');
    const fs = await import('fs');
    fs.writeFileSync(
      tmpPath,
      [
        '{"id":1,"type":"bugfix","title":"obs one","narrative":"body"}',
        '{"id":2,"type":"decision","title":"obs two","narrative":"body"}',
      ].join('\n') + '\n',
    );
    try {
      const r = await importJsonl(db, tmpPath, { project: 'proj' });
      expect(r.recognized).toBe(0);
      expect(r.prompts).toBe(0);
      expect(r.observations).toBe(0);
      expect(r.skipped).toBe(2);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('scrubs secrets from imported text fields', async () => {
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/with-secret.jsonl');
    const fs = await import('fs');
    const orig = fs.readFileSync(FIXTURE, 'utf8');
    const evil = `\n{"type":"user","sessionId":"sess-fix-1","cwd":"/home/u/proj","message":{"role":"user","content":"key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"timestamp":"2026-04-01T10:10:00Z"}\n`;
    fs.writeFileSync(tmpPath, orig + evil);
    try {
      await importJsonl(db, tmpPath, { project: 'proj' });
      const last = db.prepare('SELECT prompt_text FROM user_prompts ORDER BY id DESC LIMIT 1').get();
      expect(last.prompt_text).not.toContain('sk-ant-api03-AAAAAAAAAAA');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('imports transcripts whose sessionId is a real Claude Code UUID without tripping the v2.33.1 mix-trigger', async () => {
    // Regression: the schema's sdk_sessions_id_mix_check trigger aborts when
    // memory_session_id == content_session_id and both look like a CC UUID
    // (length 36 + hyphenated 8-4-4-4-12). Earlier importJsonl wrote the raw
    // UUID into both columns, which fired the trigger and crashed the import
    // for every real ~/.claude/projects/* transcript. Fixture sessionIds
    // ('sess-fix-1', 'trunc-1') don't match the UUID shape so they slipped
    // through the original test pass.
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/uuid-sess.jsonl');
    const fs = await import('fs');
    const uuidLines =
      [
        '{"type":"user","sessionId":"4dfa195d-8da2-48f2-818b-38a1a7436514","cwd":"/p","message":{"role":"user","content":"hi"},"timestamp":"2026-04-01T12:00:00Z"}',
      ].join('\n') + '\n';
    fs.writeFileSync(tmpPath, uuidLines);
    try {
      await expect(importJsonl(db, tmpPath, { project: 'proj' })).resolves.toBeDefined();
      const session = db
        .prepare(
          "SELECT content_session_id, memory_session_id FROM sdk_sessions WHERE content_session_id = '4dfa195d-8da2-48f2-818b-38a1a7436514'",
        )
        .get();
      expect(session).toBeDefined();
      expect(session.memory_session_id).not.toBe(session.content_session_id);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('pairs tool_use with tool_result wrapped inside a user-typed event (real Claude Code shape)', async () => {
    // Regression: real ~/.claude/projects/* transcripts emit tool_result as
    // a part inside `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}`,
    // not as a top-level `{"type":"tool_result",...}` line. Earlier importer
    // only matched the top-level shape, so every real tool_use orphaned.
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/wrapped-result.jsonl');
    const fs = await import('fs');
    const realShape =
      [
        '{"type":"user","sessionId":"wrap-1","cwd":"/p","message":{"role":"user","content":"Read foo"},"timestamp":"2026-04-01T13:00:00Z"}',
        '{"type":"assistant","sessionId":"wrap-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"u1","name":"Read","input":{"file_path":"/p/foo.mjs"}}]},"timestamp":"2026-04-01T13:00:01Z"}',
        '{"type":"user","sessionId":"wrap-1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"u1","content":"foo file body"}]},"timestamp":"2026-04-01T13:00:02Z"}',
      ].join('\n') + '\n';
    fs.writeFileSync(tmpPath, realShape);
    try {
      const r = await importJsonl(db, tmpPath, { project: 'proj' });
      expect(r.observations).toBe(1);
      expect(r.orphans).toBe(0);
      const obs = db
        .prepare("SELECT text, title FROM observations WHERE memory_session_id = 'import-wrap-1'")
        .get();
      expect(obs).toBeDefined();
      expect(obs.text).toContain('foo file body');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('writes orphan observation when tool_use has no matching tool_result (truncated)', async () => {
    const tmpPath = join(__dirname, 'fixtures/sample-claude-jsonl/truncated.jsonl');
    const fs = await import('fs');
    const truncated =
      [
        '{"type":"user","sessionId":"trunc-1","cwd":"/p","message":{"role":"user","content":"Read the file"},"timestamp":"2026-04-01T11:00:00Z"}',
        '{"type":"assistant","sessionId":"trunc-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"orphan","name":"Read","input":{"file_path":"/p/a.mjs"}}]},"timestamp":"2026-04-01T11:00:01Z"}',
        // no tool_result
      ].join('\n') + '\n';
    fs.writeFileSync(tmpPath, truncated);
    try {
      const r = await importJsonl(db, tmpPath, { project: 'proj' });
      expect(r.orphans).toBe(1);
      const obs = db
        .prepare("SELECT text FROM observations WHERE memory_session_id = 'import-trunc-1'")
        .get();
      expect(obs.text).toContain('transcript truncated');
      // The reported observation count must equal the rows actually written. `orphans` is
      // a SUBSET of `observations`, not a sibling: before this fix the import reported
      // "+0 observations, 1 orphan tool_use" while writing one observation row, so a user
      // backfilling a still-open (therefore truncated) transcript read it as a no-op.
      const written = db.prepare('SELECT count(*) AS c FROM observations').get().c;
      expect(r.observations).toBe(written);
      expect(r.observations).toBeGreaterThanOrEqual(r.orphans);
      // The body belongs in `narrative`, not only in `text`. `text` is a DERIVED search
      // blob that applyObsUpdate recomputes from narrative — an imported row that leaves
      // narrative empty loses its payload the first time anything calls `update` on it
      // (see tests/update-preserves-body.test.mjs). Pre-tag review found that reverting
      // this to `narrative: ''` left the ENTIRE suite green, so the ingest half of that
      // fix had no guard at all; the rebuild repair silently masked it.
      const stored = db
        .prepare("SELECT narrative, text FROM observations WHERE memory_session_id = 'import-trunc-1'")
        .get();
      expect(stored.narrative).toContain('transcript truncated');
      expect(stored.narrative).toBe(stored.text);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});

describe('importJsonl — oversized-file guard', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('rejects a transcript above the size cap before reading it (no OOM)', async () => {
    // Sparse file: logical size > cap, ~0 real disk blocks. statSync sees the
    // logical size, so the guard throws before readFileSync materializes it.
    const dir = mkdtempSync(join(tmpdir(), 'mem-import-big-'));
    const big = join(dir, 'huge.jsonl');
    writeFileSync(big, '');
    truncateSync(big, MAX_IMPORT_BYTES + 1024);
    try {
      await expect(importJsonl(db, big, { project: 'proj' })).rejects.toThrow(/too large/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── CLI-level summary ───────────────────────────────────────────────────────
// The lib-level counters are asserted above, but the SUMMARY LINE the user reads is
// assembled in mem-cli.mjs and had no test at any level: its wording change and the
// dropped `|| totalOrphans > 0` hint gate rode on the lib-level `observations` now
// including orphans. That coupling is exactly what should be pinned rather than assumed.

describe('import-jsonl — the CLI summary reports what was written', () => {
  const CLI = resolve(__dirname, '../cli.mjs');
  let dir, env;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'import-cli-'));
    env = {
      ...process.env,
      CLAUDE_MEM_DIR: dir,
      CLAUDE_MEM_SKIP_UPDATE: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
      CLAUDE_PROJECT_DIR: '/x/importcli',
      PWD: '/x/importcli',
    };
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  });

  it('counts an unpaired tool_use as an observation and labels it as a subset', () => {
    // A truncated transcript is the COMMON shape for a cold-start backfill: the newest
    // session is usually still open. Before this release the summary said
    // "+0 observations, 1 orphan tool_use" while writing a row, which reads as a no-op.
    const file = join(dir, 'truncated.jsonl');
    writeFileSync(
      file,
      [
        '{"type":"user","sessionId":"cli-trunc","cwd":"/p","message":{"role":"user","content":"read the cart service"},"timestamp":"2026-04-01T11:00:00Z"}',
        '{"type":"assistant","sessionId":"cli-trunc","message":{"role":"assistant","content":[{"type":"tool_use","id":"orphan","name":"Read","input":{"file_path":"/p/cart.mjs"}}]},"timestamp":"2026-04-01T11:00:01Z"}',
      ].join('\n') + '\n',
    );

    const out = execFileSync(process.execPath, [CLI, 'import-jsonl', file], { env, encoding: 'utf8' });
    expect(out).toMatch(/\+1 observations \(1 from unpaired tool_use\)/);
    expect(out).not.toMatch(/\+0 observations/);
    // The "something landed, go look" hint must fire — an orphan-only import is not a no-op.
    expect(out).toContain(`Try: ${CLI_INVOKE} recent`);
    expect(out).not.toMatch(/Nothing new/);
  });

  it('an orphan-only transcript (no prompts) still counts as something imported', () => {
    // Pins the hint gate itself. The case above carries a user prompt, so `totalPrompts > 0`
    // alone would keep the hint firing and the gate's dependence on `totalObs` would be
    // invisible. Here the only thing written is the orphan observation: if the gate stops
    // counting it, an import that DID write a row reports "Nothing new" and the user never
    // looks.
    const file = join(dir, 'orphan-only.jsonl');
    writeFileSync(
      file,
      '{"type":"assistant","sessionId":"cli-orphan","message":{"role":"assistant","content":[{"type":"tool_use","id":"o1","name":"Read","input":{"file_path":"/p/only.mjs"}}]},"timestamp":"2026-04-01T14:00:01Z"}\n',
    );
    const out = execFileSync(process.execPath, [CLI, 'import-jsonl', file], { env, encoding: 'utf8' });
    expect(out).toMatch(/0 prompts, 1 observations \(1 from unpaired tool_use\)/);
    expect(out).toContain(`Try: ${CLI_INVOKE} recent`);
    expect(out).not.toMatch(/Nothing new/);
  });

  it('says nothing landed when the file is a valid transcript already imported', () => {
    const file = join(dir, 'twice.jsonl');
    writeFileSync(
      file,
      '{"type":"user","sessionId":"cli-dup","cwd":"/p","message":{"role":"user","content":"a prompt worth importing once"},"timestamp":"2026-04-01T12:00:00Z"}\n',
    );
    execFileSync(process.execPath, [CLI, 'import-jsonl', file], { env, encoding: 'utf8' });
    const second = execFileSync(process.execPath, [CLI, 'import-jsonl', file], { env, encoding: 'utf8' });
    expect(second).toMatch(/Nothing new/);
    expect(second).not.toContain(`Try: ${CLI_INVOKE} recent`);
  });
});

describe('importJsonl — <task-notification> parity with the live writers', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  // hook.mjs handleUserPrompt and scripts/user-prompt-search.js both return on
  // `rawPrompt.startsWith('<task-notification>')` — it is Claude Code protocol, not user
  // input. Backfill is the third input boundary into user_prompts and was the only one
  // persisting them, so a cold-start import seeded rows the live path would never write.
  // Every read path then has to filter them back out, and the two that do not
  // (`get P#N`, the timeline P# anchor) hand the agent protocol chatter as context.
  it('skips protocol notifications and keeps the real prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-tn-'));
    try {
      const file = join(dir, 'tn.jsonl');
      writeFileSync(
        file,
        [
          '{"type":"user","sessionId":"tn-1","message":{"role":"user","content":"a real question about billing retries"},"timestamp":"2026-04-01T12:00:00Z"}',
          '{"type":"user","sessionId":"tn-1","message":{"role":"user","content":"<task-notification>background task finished</task-notification>"},"timestamp":"2026-04-01T12:00:01Z"}',
        ].join('\n') + '\n',
      );

      const r = await importJsonl(db, file, { project: 'proj' });
      expect(r.prompts).toBe(1);
      expect(r.skipped).toBe(1);

      const rows = db.prepare('SELECT prompt_text FROM user_prompts').all();
      expect(rows).toHaveLength(1);
      expect(rows[0].prompt_text).toMatch(/billing retries/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Same parity for the host-prepended <browser_instruction> block (lib/host-blocks.mjs).
  // In a real transcript it is its own text part ahead of the typed one.
  it('strips a host <browser_instruction> part and keeps the typed text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-bi-'));
    try {
      const file = join(dir, 'bi.jsonl');
      const event = {
        type: 'user',
        sessionId: 'bi-1',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<browser_instruction># Claude in Chrome browser automation</browser_instruction>',
            },
            { type: 'text', text: 'a real question about billing retries' },
          ],
        },
        timestamp: '2026-04-01T12:00:00Z',
      };
      writeFileSync(file, JSON.stringify(event) + '\n');

      const r = await importJsonl(db, file, { project: 'proj' });
      expect(r.prompts).toBe(1);

      const rows = db.prepare('SELECT prompt_text FROM user_prompts').all();
      expect(rows.map((row) => row.prompt_text)).toEqual(['a real question about billing retries']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A transcript imported before the strip landed left a row that still carries the block.
  // Re-importing it must stay a no-op, not add a stripped second copy.
  it('re-importing over a row stored with the block adds nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-bi-'));
    try {
      const block = '<browser_instruction># Claude in Chrome browser automation</browser_instruction>';
      const typed = 'a real question about billing retries';
      const ts = '2026-04-01T12:00:00Z';
      db.prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
         VALUES ('bi-2', 'import-bi-2', 'proj', ?, ?, 'completed')`,
      ).run(ts, Date.parse(ts));
      db.prepare(
        `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
         VALUES ('bi-2', ?, 1, ?, ?)`,
      ).run(`${block}\n${typed}`, ts, Date.parse(ts));
      const file = join(dir, 'bi2.jsonl');
      const event = {
        type: 'user',
        sessionId: 'bi-2',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: block },
            { type: 'text', text: typed },
          ],
        },
        timestamp: ts,
      };
      writeFileSync(file, JSON.stringify(event) + '\n');

      const r = await importJsonl(db, file, { project: 'proj' });
      expect(r.prompts).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get().n).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The old importer stored scrubSecrets(joined).slice(0, 10000), block included. With typed
  // text near the cap, the new key (block removed first, so more typed characters kept) is
  // longer than the stripped legacy row; re-import must still recognise the row.
  for (const withTimestamp of [true, false]) {
    it(`re-importing a legacy capped row adds nothing (${withTimestamp ? 'timestamped' : 'no timestamp'})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mem-bi-'));
      try {
        const block = '<browser_instruction># Claude in Chrome browser automation</browser_instruction>';
        const typed = 'q'.repeat(10500);
        const ts = '2026-04-01T12:00:00Z';
        db.prepare(
          `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status, prompt_counter)
           VALUES ('bi-3', 'import-bi-3', 'proj', ?, ?, 'completed', 1)`,
        ).run(ts, Date.parse(ts));
        db.prepare(
          `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
           VALUES ('bi-3', ?, 1, ?, ?)`,
        ).run(scrubSecrets(`${block}\n${typed}`).slice(0, 10000), ts, Date.parse(ts));
        const file = join(dir, 'bi3.jsonl');
        const event = {
          type: 'user',
          sessionId: 'bi-3',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: block },
              { type: 'text', text: typed },
            ],
          },
          ...(withTimestamp ? { timestamp: ts } : {}),
        };
        writeFileSync(file, JSON.stringify(event) + '\n');

        const r = await importJsonl(db, file, { project: 'proj' });
        expect(r.prompts).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get().n).toBe(1);
        expect(
          db.prepare("SELECT prompt_counter FROM sdk_sessions WHERE content_session_id = 'bi-3'").get()
            .prompt_counter,
        ).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // Timestamp-less lines are admitted by occurrence count against what the store holds. A
  // store mixing the old shape (block kept) and the new one for the same long prompt must
  // count as two stored copies, not be re-admitted under each key in turn.
  it('a store mixing old- and new-format rows of one long prompt stays stable across re-imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-bi-'));
    try {
      const block = '<browser_instruction># Claude in Chrome browser automation</browser_instruction>';
      const typed = 'q'.repeat(10500);
      const ts = '2026-04-01T12:00:00Z';
      db.prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status, prompt_counter)
         VALUES ('bi-4', 'import-bi-4', 'proj', ?, ?, 'completed', 2)`,
      ).run(ts, Date.parse(ts));
      const insertRow = db.prepare(
        `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
         VALUES ('bi-4', ?, ?, ?, ?)`,
      );
      insertRow.run(scrubSecrets(`${block}\n${typed}`).slice(0, 10000), 1, ts, Date.parse(ts));
      insertRow.run(scrubSecrets(typed).slice(0, 10000), 2, ts, Date.parse(ts));
      const file = join(dir, 'bi4.jsonl');
      const event = {
        type: 'user',
        sessionId: 'bi-4',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: block },
            { type: 'text', text: typed },
          ],
        },
      };
      writeFileSync(file, `${JSON.stringify(event)}\n`.repeat(3));

      for (let run = 1; run <= 2; run++) {
        await importJsonl(db, file, { project: 'proj' });
        expect(db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get().n, `run ${run}`).toBe(3);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A <private> region and a trailing newline: the old importer kept the newline; the new
  // one must produce the same stored text, or the old row and the new key never meet.
  it('a repeated short timestamp-less line with <private>, first copy stored in the old format, stays at 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-bi-'));
    try {
      const line = 'use <private>tok</private> to deploy\n';
      const ts = '2026-04-01T12:00:00Z';
      db.prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status, prompt_counter)
         VALUES ('bi-5', 'import-bi-5', 'proj', ?, ?, 'completed', 1)`,
      ).run(ts, Date.parse(ts));
      db.prepare(
        `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
         VALUES ('bi-5', ?, 1, ?, ?)`,
      ).run(scrubSecrets(line).slice(0, 10000), ts, Date.parse(ts));
      const file = join(dir, 'bi5.jsonl');
      const event = { type: 'user', sessionId: 'bi-5', message: { role: 'user', content: line } };
      writeFileSync(file, `${JSON.stringify(event)}\n`.repeat(2));

      for (let run = 1; run <= 2; run++) {
        await importJsonl(db, file, { project: 'proj' });
        expect(db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get().n, `run ${run}`).toBe(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Driven to failure the other way: the guard must not swallow a prompt that merely
  // MENTIONS the sentinel mid-sentence — only one that opens with it is protocol.
  it('keeps a prompt that only mentions the sentinel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-tn-'));
    try {
      const file = join(dir, 'tn2.jsonl');
      writeFileSync(
        file,
        '{"type":"user","sessionId":"tn-2","message":{"role":"user","content":"why does <task-notification> reach the transcript at all"},"timestamp":"2026-04-01T12:00:00Z"}\n',
      );
      const r = await importJsonl(db, file, { project: 'proj' });
      expect(r.prompts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── D#35 + the defect it was a symptom of ───────────────────────────────────
//
// Filed as "imported tool-uses build no file edge, because NotebookEdit carries
// `notebook_path`". The spelling was real, but measuring it first showed the
// cause was broader: import wrote `files_modified` as a JSON column and never
// touched the `observation_files` junction at all, so a plain `Edit` with
// `file_path` set was equally unreachable. Pre-fix reading on a two-row fixture:
// files_modified = ["/repo/alpha.mjs"] and [], junction rows 0. The SECOND list
// being empty is the point: the Edit column was already right and still unreachable.
//
// The assertions below are on RECALL, not on the column, because the column was
// never the thing that was broken for `Edit` — `tests/test-helpers.mjs::insertObs`
// mirrors the junction write, which is why no existing case could see the gap.
describe('importJsonl — file edges reach the recall path', () => {
  let db;
  let dir;

  function toolPair(name, input, id) {
    return [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'fe-1',
        timestamp: '2026-09-11T00:00:00Z',
        message: { content: [{ type: 'tool_use', id, name, input }] },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'fe-1',
        timestamp: '2026-09-11T00:00:01Z',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      }),
    ].join('\n');
  }

  beforeEach(() => {
    db = createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'mem-fileedge-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function importFixture() {
    const file = join(dir, 'fe.jsonl');
    writeFileSync(
      file,
      [
        toolPair('Edit', { file_path: '/repo/alpha.mjs', old_string: 'a', new_string: 'b' }, 'u1'),
        toolPair('NotebookEdit', { notebook_path: '/repo/nb.ipynb', new_source: 'x' }, 'u2'),
      ].join('\n') + '\n',
    );
    return importJsonl(db, file, { project: 'proj' });
  }

  it('premise: both tool pairs import as observations', async () => {
    const r = await importFixture();
    expect(r.observations, 'fixture did not import — the recalls below would be vacuous').toBe(2);
  });

  it('recalls an imported Edit by its file (the junction was never written)', async () => {
    await importFixture();
    const { rows } = recallByFile(db, '/repo/alpha.mjs', { limit: 10, includeNoise: true });
    expect(rows.map((r) => r.title)).toContain('Edit: /repo/alpha.mjs');
  });

  it('recalls an imported NotebookEdit by its notebook_path (D#35)', async () => {
    await importFixture();
    const { rows } = recallByFile(db, '/repo/nb.ipynb', { limit: 10, includeNoise: true });
    expect(
      rows,
      'NotebookEdit carries notebook_path and never file_path — the gate read the wrong key',
    ).toHaveLength(1);
  });

  it('does not invent an edge for a tool that names no path', async () => {
    const file = join(dir, 'bash.jsonl');
    writeFileSync(file, toolPair('Bash', { command: 'ls -la' }, 'u9') + '\n');
    await importJsonl(db, file, { project: 'proj' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM observation_files').get().n).toBe(0);
  });

  // The orphan path (tool_use with no tool_result, i.e. a truncated transcript)
  // reaches the junction write through the same importToolPair — correct today,
  // and untested until a pre-ship mutation gating the write on the truncation
  // sentinel left the whole file green.
  it('builds the edge on the orphan path too (truncated transcript)', async () => {
    const file = join(dir, 'orphan.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'fe-orphan',
        timestamp: '2026-09-11T00:00:00Z',
        message: {
          content: [{ type: 'tool_use', id: 'o1', name: 'Edit', input: { file_path: '/repo/trunc.mjs' } }],
        },
      }) + '\n',
    );
    const r = await importJsonl(db, file, { project: 'proj' });
    expect(r.orphans, 'premise: this fixture must take the orphan path').toBe(1);
    const { rows } = recallByFile(db, '/repo/trunc.mjs', { limit: 10, includeNoise: true });
    expect(rows, 'a truncated transcript still records which file was being edited').toHaveLength(1);
  });

  // D#35 delivered as an empty label is D#35 not delivered: recall renders
  // `o.title`, not the junction filename, so the path the fix stores has to
  // reach the title too. Both title sites widened together — they are one
  // dedup key.
  it('titles an imported NotebookEdit with its notebook path', async () => {
    await importFixture();
    const { rows } = recallByFile(db, '/repo/nb.ipynb', { limit: 10, includeNoise: true });
    expect(rows[0].title).toBe('NotebookEdit: /repo/nb.ipynb');
  });

  it('stays idempotent with the widened title (both key sites moved together)', async () => {
    await importFixture();
    const second = await importJsonl(db, join(dir, 'fe.jsonl'), { project: 'proj' });
    expect(second.observations, 'a widened title on only one site would re-import forever').toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n).toBe(2);
  });
});

// E2E 2026-10-16 (cli F2): `.slice(0, 4000)` bound only to the array branch of the tool-result
// ternary, so a STRING tool_result (what Bash and Read return in real transcripts) was stored
// whole, twice (narrative and text): a 200 000-char Read became a ~100 000-token row.
describe('importJsonl — tool output is capped whatever its shape', () => {
  it('a string tool_result is capped like an array one', async () => {
    const db = createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'mem-import-cap-'));
    try {
      const sid = '22222222-3333-4444-5555-666666666666';
      const big = 'x'.repeat(200000);
      const lines = [
        {
          type: 'assistant',
          sessionId: sid,
          timestamp: '2026-10-10T08:00:05.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/repo/a.ts' } },
              { type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/repo/b.ts' } },
            ],
          },
        },
        {
          type: 'user',
          sessionId: sid,
          timestamp: '2026-10-10T08:00:06.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 's1', content: big },
              { type: 'tool_result', tool_use_id: 'a1', content: [{ type: 'text', text: big }] },
            ],
          },
        },
      ];
      const f = join(dir, 'cap.jsonl');
      writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      await importJsonl(db, f, { project: 'proj' });
      const rows = db
        .prepare('SELECT title, length(narrative) AS n, length(text) AS t FROM observations')
        .all();
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.n, r.title).toBeLessThan(5000);
        expect(r.t, r.title).toBeLessThan(5000);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
    }
  });
});
