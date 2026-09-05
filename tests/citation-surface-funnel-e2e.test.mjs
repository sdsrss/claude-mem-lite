// End-to-end proof that a real Stop event lands citation_surface_log rows.
//
// tests/citation-surface-funnel.test.mjs covers the recorder in isolation (14
// cases) and asserts the hook.mjs wiring by MATCHING hook.mjs SOURCE TEXT. Source
// matching cannot see a chain that breaks between the call site and the table:
// a schema pass that never creates the table (#10650), a debugCatch that renders
// "no such table" as "no rows", a stdin field renamed upstream, or an env guard
// that short-circuits the whole block. Each of those keeps every source assertion
// green while the funnel silently reports nothing.
//
// So: spawn `node hook.mjs stop` against a sandboxed HOME with a real DB and a
// real transcript, and read the table back. This is the only assertion in the
// repo that the four faces survive an actual Stop.
//
// ISOLATION: HOME *and* CLAUDE_MEM_DIR are pointed at a mkdtemp sandbox, and
// CLAUDE_CODE_PATH at a nonexistent binary so no LLM spend or network can occur.
// CLAUDE_MEM_DIR is set explicitly rather than left to HOME: the env strip below
// removes the developer's own value, after which resolution falls back to
// os.homedir(), which honours HOME only on POSIX — on Windows it reads
// USERPROFILE and this suite would write to the real ~/.claude-mem-lite.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO, 'hook.mjs');
const PROJECT = 'stopE2e--proj';

/** hook_success attachment shaped like the real hook stdout for each face. */
const att = (command, stdout) => ({
  type: 'attachment',
  isSidechain: false,
  attachment: { type: 'hook_success', command, stdout },
});

// Each takes a LIST of ids so a face can carry a distinct count (see FACE_SIZES).
const faceAttachment = {
  pretool: (ids) =>
    att(
      'node "/home/sds/.claude-mem-lite/scripts/pre-tool-recall.js"',
      `[mem] Lessons for utils.mjs:\n${ids.map((id) => `  #${id} [bugfix] boundary match beats suffix LIKE\n`).join('')}`,
    ),
  ups: (ids) =>
    att(
      'node "/home/sds/.claude-mem-lite/hook.mjs" user-prompt',
      `<memory-context relevance="high">\n${ids.map((id) => `- [decision] picked X | Lesson: Y (#${id})\n`).join('')}</memory-context>\n`,
    ),
  error_recall: (ids) =>
    att(
      'bash "/home/sds/.claude-mem-lite/scripts/post-tool-use.sh"',
      `[claude-mem-lite] Related memories found for this error:\n${ids.map((id) => `  #${id} [bugfix] EPIPE on forced exit\n`).join('')}`,
    ),
  fyi: (ids) =>
    att(
      'node "/home/sds/.claude-mem-lite/scripts/user-prompt-search.js"',
      `[mem] FYI — Related memories (continue your task):\n${ids.map((id) => `#${id} 🔴 superseded invariant reopened\n`).join('')}`,
    ),
};

/** Main-thread assistant text — both the text floor and the citation numerator. */
const assistantText = (text) => ({
  type: 'assistant',
  isSidechain: false,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('Stop end-to-end: citation_surface_log really receives rows (b2)', () => {
  let root, home, projDir, dbPath, baseEnv;
  let caseN = 0;

  // Per-case dirs live under ONE root removed after the whole file, with a grace
  // period. A per-case rmSync in afterEach does delete the tree — and then the
  // hook's detached background workers, which outlive execFileSync, recreate
  // `<home>/.claude-mem-lite/` behind it. The result is a leaked skeleton dir per
  // case (13 of them before this was noticed), invisible because rmSync is
  // best-effort and its failure is swallowed. Same shape as the fix in
  // tests/audit-fixes-20260816.test.mjs.
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mem-stop-e2e-'));
  });

  // A fixed grace is a RACE, not a barrier, and the post-tag review observed it
  // lose: handleStop's spawnBackground('llm-summary') is gated by no
  // CLAUDE_MEM_SKIP_* this test sets, and on a busy machine that detached child
  // recreated the tree 432ms after rmSync — past a 300ms sleep. Delete in a
  // bounded loop until it stays gone, then ASSERT it is gone: rmSync is
  // best-effort and its failure is swallowed, so without the assertion the leak
  // is invisible and comes back as the 13 stray dirs this file already once left.
  afterAll(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* retry */
      }
      if (!existsSync(root)) {
        await new Promise((r) => setTimeout(r, 200)); // give a straggler time to recreate
        if (!existsSync(root)) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(root), `sandbox root leaked: ${root}`).toBe(false);
  });

  beforeEach(() => {
    home = join(root, `case-${++caseN}`);
    mkdirSync(home, { recursive: true });
    projDir = join(home, 'stopE2e', 'proj');
    mkdirSync(projDir, { recursive: true });
    const dbDir = join(home, '.claude-mem-lite');
    mkdirSync(join(dbDir, 'runtime'), { recursive: true });
    dbPath = join(dbDir, 'claude-mem-lite.db');

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    const now = Date.now();
    db.prepare(
      `
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('cc-stop-e2e', 'mem-stop-e2e', ?, ?, ?, 'active')
    `,
    ).run(PROJECT, new Date(now).toISOString(), now);
    db.close();

    baseEnv = { ...process.env };
    // Strip the developer's own plugin flags so no default-OFF surface flips on
    // in the child (#8608 leak class).
    for (const k of Object.keys(baseEnv)) {
      if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete baseEnv[k];
    }
    Object.assign(baseEnv, {
      HOME: home,
      CLAUDE_MEM_DIR: dbDir,
      CLAUDE_PROJECT_DIR: projDir,
      CLAUDE_CODE_PATH: join(home, 'no-such-claude-binary'), // no LLM spend, no network
      ANTHROPIC_API_KEY: '',
      OPENROUTER_API_KEY: '',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      CLAUDE_MEM_SKIP_SUMMARY: '1', // the detached worker that recreated the sandbox behind cleanup
      CLAUDE_MEM_NO_DELAY: '1',
      MEM_QUIET_HOOKS: '1',
      MEM_NO_AUTO_ADOPT: '1',
    });
    delete baseEnv.CLAUDE_MEM_HOOK_RUNNING;
  });

  // Distinct COUNTS per face, deliberately: with one obs each, the uncited rows
  // are interchangeable and a swapped attribution is undetectable. Post-tag
  // review proved it — relabelling ups<->fyi at hook.mjs's recordCitationSurfaces
  // call left this file 3/3 and citation-surface-funnel.test.mjs 32/32 green.
  // A per-face funnel exists to answer "which face", so the counts must identify
  // the label.
  const FACE_SIZES = { pretool: 2, ups: 3, error_recall: 1, fyi: 4 };

  /** Seed FACE_SIZES[face] observations per face; returns { face: [ids] }. */
  function seedObservations() {
    const db = new Database(dbPath);
    const now = Date.now();
    const ids = {};
    const stmt = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
        concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
      VALUES ('mem-stop-e2e', ?, ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 2, 0, ?, ?)
    `);
    for (const [face, n] of Object.entries(FACE_SIZES)) {
      ids[face] = [];
      for (let i = 0; i < n; i++) {
        ids[face].push(
          Number(
            stmt.run(
              PROJECT,
              `${face} body text ${i}`,
              `Observation ${i} for the ${face} face`,
              new Date(now).toISOString(),
              now,
            ).lastInsertRowid,
          ),
        );
      }
    }
    db.close();
    return ids;
  }

  function runStop(transcriptPath) {
    execFileSync(process.execPath, [HOOK_PATH, 'stop'], {
      input: JSON.stringify({ session_id: 'cc-stop-e2e', transcript_path: transcriptPath }),
      timeout: 30000,
      encoding: 'utf8',
      env: baseEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  function surfaceRows() {
    const db = new Database(dbPath, { readonly: true });
    // A detached background worker may still hold a write txn. WAL makes readers
    // non-blocking today, but a busy_timeout costs nothing and removes the
    // dependency on that staying true.
    db.pragma('busy_timeout = 2000');
    try {
      return db
        .prepare(
          'SELECT surface, session_id, injected_n, cited_n FROM citation_surface_log WHERE project = ? ORDER BY surface',
        )
        .all(PROJECT);
    } finally {
      db.close();
    }
  }

  // FAILS IF: the table is never created, the recorder is never reached from
  // Stop, the row key is wrong, a swallowed error turns the write into a no-op,
  // or ANY TWO FACES ARE ATTRIBUTED TO EACH OTHER. Every one of those keeps
  // tests/citation-surface-funnel.test.mjs's source-text wiring assertions green.
  it('writes one row per injected face, attributed to the right face, with cites counted', () => {
    const ids = seedObservations();
    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        faceAttachment.pretool(ids.pretool),
        faceAttachment.ups(ids.ups),
        faceAttachment.error_recall(ids.error_recall),
        faceAttachment.fyi(ids.fyi),
        // Cite one obs from TWO different faces. With a single cited face, cited_n
        // is 1/0/0/0 and any pair of the three zeros can trade places unnoticed.
        assistantText(
          `Applying the boundary-match fix from #${ids.pretool[0]}, and #${ids.error_recall[0]} explains the EPIPE.`,
        ),
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    runStop(transcriptPath);

    const rows = surfaceRows();
    expect(rows.map((r) => r.surface)).toEqual(['error_recall', 'fyi', 'pretool', 'ups']);
    const by = Object.fromEntries(rows.map((r) => [r.surface, r]));
    // Distinct (injected_n, cited_n) per face — no two rows share a pair, so a
    // relabelled attribution cannot satisfy this set.
    expect(by.pretool).toMatchObject({ injected_n: 2, cited_n: 1 });
    expect(by.ups).toMatchObject({ injected_n: 3, cited_n: 0 });
    expect(by.error_recall).toMatchObject({ injected_n: 1, cited_n: 1 });
    expect(by.fyi).toMatchObject({ injected_n: 4, cited_n: 0 });
  });

  // The counterpart to the recorder's overwrite-idempotency unit test, at the
  // process boundary: Claude Code fires Stop again on a resumed turn.
  it('a second Stop on the same session overwrites rather than doubling', () => {
    const ids = seedObservations();
    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        faceAttachment.pretool(ids.pretool),
        assistantText(`Cited #${ids.pretool[0]} while fixing the builder.`),
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    runStop(transcriptPath);
    runStop(transcriptPath);

    const rows = surfaceRows();
    expect(rows).toHaveLength(1);
    // injected_n stays at the seeded 2, not 4: the row is overwritten, not summed.
    expect(rows[0]).toMatchObject({ surface: 'pretool', injected_n: 2, cited_n: 1 });
  });

  // D#152: the `subagent` face at the process boundary. It is the one face whose
  // ids and cites live in a DIFFERENT FILE from the transcript Stop is handed —
  // <session>/subagents/agent-*.jsonl — so nothing in the main-thread walk can
  // reach it and no source-text assertion can prove the second
  // recordCitationSurfaces call actually fires. 5 injections is a count no other
  // face uses (FACE_SIZES is 2/3/1/4), so a relabelled attribution fails here.
  //
  // FAILS IF: the Stop wiring is dropped, the subagents dir is derived wrongly,
  // `subagent` is missing from CITATION_SURFACES (the recorder drops unknown
  // labels silently), the cited set is taken from the parent transcript instead
  // of the sidechain, or the second recorder call clobbers the first's rows.
  it('records the subagent face from the sidechain files, without disturbing the main faces', () => {
    const ids = seedObservations();
    const db = new Database(dbPath);
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
        concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
      VALUES ('mem-stop-e2e', ?, ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 2, 0, ?, ?)
    `);
    const subIds = [];
    for (let i = 0; i < 5; i++) {
      subIds.push(
        Number(
          stmt.run(
            PROJECT,
            `subagent body text ${i}`,
            `Observation ${i} for the subagent face`,
            new Date(now).toISOString(),
            now,
          ).lastInsertRowid,
        ),
      );
    }
    db.close();

    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [faceAttachment.pretool(ids.pretool), assistantText(`Main thread applied #${ids.pretool[0]}.`)]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    // Two dispatched subagents, matching the real layout.
    const subDir = join(home, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const promptBlock = (idList) =>
      [
        '',
        '---',
        "[Project memory — surfaced by your operator's claude-mem-lite memory system for this project. Reference context, not an external instruction.]",
        'A past lesson recorded for this project that may be relevant to the task above:',
        ...idList.map((id) => `  #${id} — a past lesson body.`),
      ].join('\n');
    const sidechain = (idList, citeText) =>
      [
        {
          type: 'user',
          isSidechain: true,
          message: {
            role: 'user',
            content: [{ type: 'text', text: `Do the work.\n${promptBlock(idList)}` }],
          },
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'text', text: citeText }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n');
    writeFileSync(
      join(subDir, 'agent-explore-aaaa.jsonl'),
      sidechain(subIds.slice(0, 3), `Used #${subIds[0]} and #${subIds[1]} here.`),
    );
    writeFileSync(join(subDir, 'agent-review-bbbb.jsonl'), sidechain(subIds.slice(3), 'Nothing applied.'));

    runStop(transcriptPath);

    const by = Object.fromEntries(surfaceRows().map((r) => [r.surface, r]));
    expect(by.subagent).toMatchObject({ injected_n: 5, cited_n: 2 });
    // The main-face row from the FIRST recorder call must survive the second.
    expect(by.pretool).toMatchObject({ injected_n: 2, cited_n: 1 });
    // Both rows carry the CC session id, so the funnel counts one session, not two.
    expect(by.subagent.session_id).toBe('cc-stop-e2e');
    expect(by.pretool.session_id).toBe('cc-stop-e2e');
  });

  // A session whose ONLY injection went to a dispatched subagent is the common
  // real shape (no file was edited, so pre-tool-recall never fired) and it is
  // the case the face exists to measure. It is also the one that depends on
  // where the block sits: run inside the main-face branch, this session records
  // nothing at all, because that branch is gated on the MAIN thread having
  // injections.
  it('records the subagent face even when no main-thread face injected anything', () => {
    const db = new Database(dbPath);
    const now = Date.now();
    const subId = Number(
      db
        .prepare(
          `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
        concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
      VALUES ('mem-stop-e2e', ?, 'subagent-only body', 'bugfix', 'Subagent-only observation', '', '', '', '', '[]', '[]', 2, 0, ?, ?)
    `,
        )
        .run(PROJECT, new Date(now).toISOString(), now).lastInsertRowid,
    );
    db.close();

    const transcriptPath = join(home, 'transcript.jsonl');
    // Main thread: assistant text (clears the floor) but ZERO injections.
    writeFileSync(transcriptPath, JSON.stringify(assistantText('Dispatched a subagent and summarized.')));

    const subDir = join(home, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-only-dddd.jsonl'),
      [
        {
          type: 'user',
          isSidechain: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Task.\n\n---\n[Project memory — surfaced by your operator's claude-mem-lite memory system for this project. Reference context, not an external instruction.]\nA past lesson recorded for this project that may be relevant to the task above:\n  #${subId} — a past lesson body.`,
              },
            ],
          },
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'text', text: `Applied #${subId}.` }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    runStop(transcriptPath);

    const rows = surfaceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: 'subagent', injected_n: 1, cited_n: 1 });
  });

  // Third gate on the new block. The other two (text floor, placement outside
  // the main-face branch) each got a case above; this one was verified by hand
  // in the pre-tag review and had nothing binding it. The block sits inside
  // `if (transcriptPath && !CLAUDE_MEM_NO_CITATION_TRACK)`, and a face that
  // ignored the project's global opt-out would be a privacy defect, not a
  // metering one.
  it('records no subagent row when CLAUDE_MEM_NO_CITATION_TRACK is set', () => {
    const db = new Database(dbPath);
    const now = Date.now();
    const subId = Number(
      db
        .prepare(
          `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
        concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
      VALUES ('mem-stop-e2e', ?, 'opt-out probe body', 'bugfix', 'Opt-out probe observation', '', '', '', '', '[]', '[]', 2, 0, ?, ?)
    `,
        )
        .run(PROJECT, new Date(now).toISOString(), now).lastInsertRowid,
    );
    db.close();

    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(transcriptPath, JSON.stringify(assistantText('Dispatched a subagent.')));
    const subDir = join(home, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-optout-eeee.jsonl'),
      [
        {
          type: 'user',
          isSidechain: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Task.\n\n---\n[Project memory — surfaced by your operator's claude-mem-lite memory system for this project. Reference context, not an external instruction.]\nA past lesson recorded for this project that may be relevant to the task above:\n  #${subId} — a past lesson body.`,
              },
            ],
          },
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'text', text: `Applied #${subId}.` }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    // Positive control FIRST: without the opt-out this exact fixture records a
    // row, so the assertion below cannot pass because the fixture is inert.
    runStop(transcriptPath);
    expect(surfaceRows().map((r) => r.surface)).toEqual(['subagent']);

    const db2 = new Database(dbPath);
    db2.prepare('DELETE FROM citation_surface_log WHERE project = ?').run(PROJECT);
    db2.close();

    const prev = baseEnv.CLAUDE_MEM_NO_CITATION_TRACK;
    baseEnv.CLAUDE_MEM_NO_CITATION_TRACK = '1';
    try {
      runStop(transcriptPath);
    } finally {
      if (prev === undefined) delete baseEnv.CLAUDE_MEM_NO_CITATION_TRACK;
      else baseEnv.CLAUDE_MEM_NO_CITATION_TRACK = prev;
    }
    expect(surfaceRows()).toEqual([]);
  });

  // The subagent face must not become a back door around the text-floor gate:
  // it sits inside the same gate, so a tool-only Stop records nothing even when
  // sidechain files exist and carry citations.
  // The id below MUST be a real seeded observation. recordCitationSurfaces drops
  // ids that do not resolve to a live row in this project, so a hard-coded `#1`
  // makes this case pass on an empty DB no matter what the gate does — verified:
  // with the id unseeded, replacing the text-floor check with `if (true)` left
  // this green. Same shape as D#162's "asserting empty against an empty DB".
  it('records no subagent row when the main thread produced no assistant text', () => {
    const db = new Database(dbPath);
    const now = Date.now();
    const subId = Number(
      db
        .prepare(
          `
      INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
        concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
      VALUES ('mem-stop-e2e', ?, 'floor-probe body', 'bugfix', 'Text-floor probe observation', '', '', '', '', '[]', '[]', 2, 0, ?, ?)
    `,
        )
        .run(PROJECT, new Date(now).toISOString(), now).lastInsertRowid,
    );
    db.close();

    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] },
      }),
    );
    const subDir = join(home, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-x-cccc.jsonl'),
      [
        {
          type: 'user',
          isSidechain: true,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Do it.\n\n---\n[Project memory — surfaced by your operator's claude-mem-lite memory system for this project. Reference context, not an external instruction.]\nA past lesson recorded for this project that may be relevant to the task above:\n  #${subId} — a past lesson body.`,
              },
            ],
          },
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'text', text: `Applied #${subId}.` }] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    runStop(transcriptPath);

    expect(surfaceRows()).toEqual([]);
  });

  // D#177: admitting `subagent` to the citation-DECAY denominator, not just the funnel.
  //
  // The face's cite signal is receiver-attributed — the citation lands in the dispatched
  // agent's own transcript — so admission means feeding its ids into the denominator AND
  // its cites into the numerator together. The two halves have opposite failure modes and
  // one case cannot see both, so this seeds TWO observations through ONE Stop: one the
  // subagent cites, one it does not. Half a wiring (denominator only) leaves the cited one
  // streaking as uncited; the other half (numerator only) leaves the uncited one untouched.
  //
  // The parent transcript carries NO face attachment on purpose. That makes the run also
  // the guard for the entry gate: `injected.size` is 0 here, so a version that admits the
  // face at the decay call but not at the `if (injected.size > 0 || …)` above it reports a
  // face in the denominator that never once reaches it.
  describe('subagent face in the decay loop (D#177)', () => {
    /** Seed one obs, return its id. */
    function seedOne(title) {
      const db = new Database(dbPath);
      const now = Date.now();
      const id = Number(
        db
          .prepare(
            `
        INSERT INTO observations (memory_session_id, project, text, type, title, subtitle, narrative,
          concepts, facts, files_read, files_modified, importance, access_count, created_at, created_at_epoch)
        VALUES ('mem-stop-e2e', ?, ?, 'bugfix', ?, '', '', '', '', '[]', '[]', 2, 0, ?, ?)
      `,
          )
          .run(PROJECT, `${title} body`, title, new Date(now).toISOString(), now).lastInsertRowid,
      );
      db.close();
      return id;
    }

    const decayRow = (id) => {
      const db = new Database(dbPath, { readonly: true });
      db.pragma('busy_timeout = 2000');
      try {
        return db
          .prepare('SELECT cited_count, uncited_streak, decay_seen_count FROM observations WHERE id = ?')
          .get(id);
      } finally {
        db.close();
      }
    };

    /** Parent with main-thread text (the floor) but no attachment; one sidechain citing `cited`. */
    function writeFixture(cited, uncited) {
      const transcriptPath = join(home, 'transcript.jsonl');
      writeFileSync(
        transcriptPath,
        [assistantText('Done. Nothing cited here in the main thread.')]
          .map((e) => JSON.stringify(e))
          .join('\n'),
      );
      const subDir = join(home, 'transcript', 'subagents');
      mkdirSync(subDir, { recursive: true });
      const block = [cited, uncited].map((id) => `  #${id} — a past lesson body.`).join('\n');
      writeFileSync(
        join(subDir, 'agent-worker-abcd.jsonl'),
        [
          {
            type: 'user',
            isSidechain: true,
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Task.\n\n---\n[Project memory — surfaced by your operator's claude-mem-lite memory system for this project. Reference context, not an external instruction.]\nA past lesson recorded for this project that may be relevant to the task above:\n${block}`,
                },
              ],
            },
          },
          {
            type: 'assistant',
            isSidechain: true,
            message: { role: 'assistant', content: [{ type: 'text', text: `Applied #${cited}.` }] },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n'),
      );
      return transcriptPath;
    }

    it('CLAUDE_MEM_SUBAGENT_DECAY=0: the face is metered but never decays (v3.77–v3.82 behavior)', () => {
      const cited = seedOne('Subagent lesson the agent cited');
      const uncited = seedOne('Subagent lesson the agent ignored');
      const path = writeFixture(cited, uncited);

      baseEnv.CLAUDE_MEM_SUBAGENT_DECAY = '0';
      try {
        runStop(path);
      } finally {
        delete baseEnv.CLAUDE_MEM_SUBAGENT_DECAY;
      }

      // Positive control: the fixture IS live — the funnel recorded the face.
      expect(surfaceRows().map((r) => r.surface)).toEqual(['subagent']);
      expect(decayRow(cited)).toEqual({ cited_count: 0, uncited_streak: 0, decay_seen_count: 0 });
      expect(decayRow(uncited)).toEqual({ cited_count: 0, uncited_streak: 0, decay_seen_count: 0 });
    });

    it("default (v3.83.0): the receiving agent's cite promotes, its silence streaks", () => {
      const cited = seedOne('Subagent lesson the agent cited');
      const uncited = seedOne('Subagent lesson the agent ignored');
      runStop(writeFixture(cited, uncited));

      // Numerator half: a cite made ONLY in the subagent's own transcript counts.
      expect(decayRow(cited)).toMatchObject({ cited_count: 1, uncited_streak: 0 });
      // Denominator half: the ignored one is resolved as uncited rather than skipped.
      expect(decayRow(uncited)).toMatchObject({ cited_count: 0, uncited_streak: 1 });
      // Both were seen by the loop — the pair is what proves the merge is asymmetric
      // rather than "everything promoted" or "everything streaked".
      expect(decayRow(cited).decay_seen_count).toBe(1);
      expect(decayRow(uncited).decay_seen_count).toBe(1);
      // Metering is unchanged by the admission: still exactly one subagent row.
      // (Weak on this fixture — the parent carries no other face, so no other row COULD
      // appear. The discriminating version is the next case, which puts a `pretool`
      // attachment in the parent.)
      expect(surfaceRows().map((r) => r.surface)).toEqual(['subagent']);
    });

    // The leak this case exists for: `citedMain` is the numerator for FOUR consumers and
    // only `applyCitationDecay` may see the subagent cites. The first draft merged them
    // into `citedMain` in place, and the pre-tag review measured the consequence —
    // `pretool.cited_n` 0 -> 1 for a row the main thread never cited, i.e. the per-face
    // funnel silently adopting a different caliber from the one CLAUDE.md publishes for it
    // and from benchmark/citation-live-replay.mjs. The fix is a copy (`decayCited`).
    //
    // Two assertions, and both are needed: the funnel must NOT count it, and decay MUST.
    // Either one alone passes under a broken implementation — dropping the merge entirely
    // satisfies the funnel assertion, and merging in place satisfies the decay one.
    /**
     * An (obs,file) edge plus the PreToolUse cooldown row that makes handleStop resolve it.
     * Without both, readPreRecallFileEdges returns [] and resolveEdgeAttribution never runs.
     */
    function seedEdge(obsId, session, filename) {
      const db = new Database(dbPath);
      db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(obsId, filename);
      db.close();
      writeFileSync(
        join(home, '.claude-mem-lite', 'runtime', `pre-recall-cooldown-${session}.json`),
        JSON.stringify({ [filename]: { obsIds: [obsId], ts: Date.now() } }),
      );
    }

    it('a subagent-only cite promotes the row but is NOT counted as a pretool hit', () => {
      const shared = seedOne('Lesson injected by pretool and handed to the subagent');
      seedEdge(shared, 'cc-stop-e2e', 'utils.mjs');
      const transcriptPath = join(home, 'transcript.jsonl');
      writeFileSync(
        transcriptPath,
        [
          // Main thread: the row IS injected by pretool here, and never cited in main text.
          faceAttachment.pretool([shared]),
          assistantText('Main thread says nothing citable at all.'),
        ]
          .map((e) => JSON.stringify(e))
          .join('\n'),
      );
      const subDir = join(home, 'transcript', 'subagents');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(
        join(subDir, 'agent-worker-beef.jsonl'),
        [
          {
            type: 'user',
            isSidechain: true,
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Task.\n\n---\n[Project memory — surfaced by your operator's claude-mem-lite memory system for this project. Reference context, not an external instruction.]\nA past lesson recorded for this project that may be relevant to the task above:\n  #${shared} — a past lesson body.`,
                },
              ],
            },
          },
          {
            type: 'assistant',
            isSidechain: true,
            message: { role: 'assistant', content: [{ type: 'text', text: `Applied #${shared}.` }] },
          },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n'),
      );

      runStop(transcriptPath);

      const rows = surfaceRows();
      const pretool = rows.find((r) => r.surface === 'pretool');
      expect(pretool, 'no pretool row — the fixture stopped exercising the leak path').toBeTruthy();
      expect(pretool.injected_n).toBe(1);
      expect(
        pretool.cited_n,
        "the subagent's citation was counted as a MAIN-THREAD pretool hit — citedMain was widened in place instead of copied",
      ).toBe(0);
      // …while the decay loop, which is the one consumer that should see it, promoted.
      expect(decayRow(shared), 'the subagent cite did not reach applyCitationDecay').toMatchObject({
        cited_count: 1,
        uncited_streak: 0,
      });
      // The OTHER consumer that must not see it. Today both leaks come from one variable,
      // so the assertion above already covers this one — but only by coincidence of the
      // current shape: pass the widened set to `resolveEdgeAttribution` alone and nothing
      // else here goes red.
      //
      // The edge and the cooldown file are seeded in the case body ABOVE the Stop (see
      // seedEdge), because an `if (edge)` guard around this assertion would make it
      // vacuous — resolveEdgeAttribution only runs when readPreRecallFileEdges returns
      // something, and with nothing seeded it returns [] and the check asserts nothing.
      const edge = (() => {
        const db = new Database(dbPath, { readonly: true });
        db.pragma('busy_timeout = 2000');
        try {
          return db
            .prepare('SELECT miss_streak, last_cited_session_id FROM observation_files WHERE obs_id = ?')
            .get(shared);
        } finally {
          db.close();
        }
      })();
      expect(edge, 'the (obs,file) edge was not seeded — this assertion would prove nothing').toBeTruthy();
      expect(edge.miss_streak, 'a file edge was resolved as a HIT on a citation only the subagent made').toBe(
        1,
      );
      expect(edge.last_cited_session_id).toBeNull();
    });
  });

  // Text-floor gate: a tool-only Stop must record nothing, so an unfinished turn
  // cannot bank an "injected but uncited" verdict the next turn can't undo.
  it('records nothing when the turn produced no main-thread assistant text', () => {
    const ids = seedObservations();
    const transcriptPath = join(home, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [faceAttachment.pretool(ids.pretool)].map((e) => JSON.stringify(e)).join('\n'),
    );

    runStop(transcriptPath);

    expect(surfaceRows()).toEqual([]);
  });
});
