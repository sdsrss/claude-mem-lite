// QA round 1 — a damaged FTS5 index dead-ends the two surfaces a user actually hits first.
//
// R10 P3-9 built the classifier (isFtsCorruptionError) and wired it into
// `ensureDbWithWalRecovery`, which rebuilds the index and retries. That covers OPEN time.
// A structure record damaged INSIDE the index opens fine — nothing reads it until the
// first MATCH — so the fault surfaces at QUERY time, where neither face consulted the
// classifier:
//
//   $ claude-mem-lite search "sanitizeFtsQuery"
//   [mem] search failed: fts5: corruption found reading blob … from table "observations_fts"
//   (exit 1; the rejected randomblob fixture says "corrupt structure record" instead — same
//   code, different sentence, which is why the assertions below match on neither in full)
//
//   mem_search -> isError: true, "Error: fts5: corruption found reading blob …"
//
// Both are SQLite's own sentence with no next step, on a fault this project repairs
// LOSSLESSLY (`fts-check rebuild` re-derives every index from its content table; `doctor`
// does it unprompted). And `recent` / `recall` / `browse` / `context` never touch FTS, so
// they keep answering — which makes the dead end easy to misread as "search found nothing".
//
// Measured 2026-09-13 on a sandbox data dir, 1 observation, index damaged in place:
//   search  exit 1, bare message  |  mem_search isError, bare message
//   recent / recall / browse / context / stats  exit 0, correct output
//   fts-check check -> CORRUPT     |  doctor -> detects and rebuilds
//
// THE FIXTURE IS DELETE, NOT randomblob, AND THAT IS NOT A STYLE CHOICE. The first cut
// used `UPDATE observations_fts_data SET block = randomblob(32) WHERE id > 1`, which is a
// NON-DETERMINISTIC fixture: what SQLite raises depends on which garbage bytes land in the
// varints it reads, and on WHICH ROW takes the damage. `observations_fts_data` holds three
// rows here — id=1 (averages), id=10 (the STRUCTURE record), and one leaf page — so
// `WHERE id > 1` is not "the leaf pages", it is the structure record as well. Tabulated:
//
//   randomblob(32) WHERE id > 1   (structure + leaf)   98/100 CORRUPT_VTAB, 2/100 NOMEM
//   randomblob(32) WHERE id > 10  (leaf only)         100/100 CORRUPT_VTAB
//   zeroblob(32)                                       30/30 no throw at all
//   x'00' into the structure record                    30/30 no throw at all
//   DELETE … WHERE id > 10        (leaf only)         100/100 CORRUPT_VTAB (30/30 at N=30)
//
// The NOMEM arm is a flaky test that reads as a product failure ("expected 'Error: out of
// memory' to match /corrupt structure record/") and it cost one pre-commit run to catch.
// The two no-throw modes would have been vacuous fixtures — green for the wrong reason.
//
// It also fixes the SCOPE of what this file may claim. The two shapes carry DIFFERENT
// message text ("corrupt structure record" vs "corruption found reading blob"), so the
// assertions below match on the classifier-relevant part, not one shape's sentence. And a
// damaged index CAN surface as SQLITE_NOMEM, where the remedy deliberately does not fire —
// see the last test for why widening the classifier there would be the wrong repair.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { isFtsCorruptionError, FTS_CORRUPTION_REMEDY } from '../lib/db-unusable.mjs';
import { shellWord } from '../cli-path.mjs';

const REPO = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI = join(REPO, 'cli.mjs');

const ftsErr = () =>
  Object.assign(new Error('fts5: corrupt structure record for table "observations_fts"'), {
    code: 'SQLITE_CORRUPT_VTAB',
  });

/** Data dir holding one observation whose FTS index has been damaged in place. */
function makeCorruptFtsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cml-ftsq-'));
  const env = {
    ...process.env,
    CLAUDE_MEM_DIR: dir,
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_TEST_GUARD: '0',
  };
  execFileSync(
    process.execPath,
    [
      CLI,
      'save',
      'Observation about the sanitizeFtsQuery helper in search-engine.mjs',
      '--title',
      'obs sanitizeFtsQuery',
      '--type',
      'bugfix',
      '--project',
      'ftsq',
    ],
    { env, stdio: 'ignore' },
  );
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  db.unsafeMode(true);
  // 30/30 SQLITE_CORRUPT_VTAB — see the fixture note in the header for the three modes
  // measured and rejected. Ids <= 10 are FTS5's reserved averages/structure records; the
  // leaf pages above them are what a MATCH walks.
  const n = db.prepare('DELETE FROM observations_fts_data WHERE id > 10').run().changes;
  if (n === 0) throw new Error('fixture did not damage anything — observations_fts_data had no leaf pages');
  db.close();
  return { dir, env };
}

/** Both damage shapes say "fts5: … corrupt…"; neither one's full sentence is the contract. */
const FTS_FAULT = /fts5:.*corrupt/i;

describe('a damaged FTS index names its own lossless remedy at query time', () => {
  it('the query-time error is the fault the existing classifier already recognises', () => {
    expect(isFtsCorruptionError(ftsErr())).toBe(true);
  });

  // The measured boundary, stated as a test so it is a claim someone can break rather than
  // a gap nobody wrote down. ~2% of random corruptions that reach the STRUCTURE record come
  // back as SQLITE_NOMEM (2/100; leaf-only damage is 100/100 CORRUPT_VTAB), and the remedy
  // does NOT fire there — deliberately. isFtsCorruptionError is also what
  // isDbCorruptionError and isDbUnusableError consult, so admitting NOMEM would route a
  // genuine allocation failure into `ensureDbWithWalRecovery`'s full FTS rebuild, i.e. answer
  // "this machine is out of memory" with "rebuild every index". And it would tell a user
  // their search index is damaged when it may not be. Same shape as
  // lib/db-unusable.mjs's file-vs-index split: when a code cannot discriminate two faults,
  // the answer is to cover the one it CAN name, not to widen until it covers both wrongly.
  it('SQLITE_NOMEM is NOT claimed as FTS corruption, even though damage can produce it', () => {
    const nomem = Object.assign(new Error('out of memory'), { code: 'SQLITE_NOMEM' });
    expect(isFtsCorruptionError(nomem)).toBe(false);
  });

  it('the remedy names the rebuild command and says the rows survive', () => {
    expect(FTS_CORRUPTION_REMEDY).toMatch(/fts-check rebuild/);
    expect(FTS_CORRUPTION_REMEDY).toMatch(/doctor/);
    // "your memories are gone" is the reading this line exists to prevent.
    expect(FTS_CORRUPTION_REMEDY).toMatch(/does not touch the stored observations/);
    // ...without promising a rebuild that refuses on damaged pages (D#593).
    expect(FTS_CORRUPTION_REMEDY).not.toMatch(/lossless|are intact/i);
    expect(FTS_CORRUPTION_REMEDY).toMatch(/checks the database's pages first/);
  });

  it('the CLI prints the remedy beside SQLite`s sentence, and still exits 1', () => {
    const { dir, env } = makeCorruptFtsDir();
    try {
      let stderr = '';
      let status = 0;
      try {
        execFileSync(process.execPath, [CLI, 'search', 'sanitizeFtsQuery'], {
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        status = e.status;
        stderr = String(e.stderr || '');
      }
      expect(status, 'a damaged index must still be a failure').toBe(1);
      expect(stderr).toMatch(FTS_FAULT);
      expect(stderr, 'the user is told nothing about how to fix it').toMatch(/fts-check rebuild/);
      // A plugin install puts no bare `claude-mem-lite` on PATH (D#462; v6.30.0 pre-tag review).
      expect(stderr).toContain(`${shellWord(CLI)} fts-check rebuild`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the remedy the CLI prints actually repairs the index', () => {
    const { dir, env } = makeCorruptFtsDir();
    try {
      execFileSync(process.execPath, [CLI, 'fts-check', 'rebuild'], { env, stdio: 'ignore' });
      const out = execFileSync(process.execPath, [CLI, 'search', 'sanitizeFtsQuery'], {
        env,
        encoding: 'utf8',
      });
      expect(out).toMatch(/obs sanitizeFtsQuery/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unrelated CLI failure does NOT gain the FTS remedy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cml-ftsq-ok-'));
    try {
      let stderr = '';
      try {
        execFileSync(process.execPath, [CLI, 'get', '424242'], {
          env: { ...process.env, CLAUDE_MEM_DIR: dir, MEM_NO_AUTO_ADOPT: '1', CLAUDE_MEM_TEST_GUARD: '0' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        stderr = String(e.stderr || '');
      }
      expect(stderr).not.toMatch(/fts-check rebuild/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the MCP face carries the remedy too — the model gets a next step, not a dead end', async () => {
    const { dir, env } = makeCorruptFtsDir();
    try {
      const req = [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'qa', version: '1' },
          },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'mem_search', arguments: { query: 'sanitizeFtsQuery', deep: false } },
        }),
      ].join('\n');
      const out = execFileSync(process.execPath, [join(REPO, 'server.mjs')], {
        env,
        input: req + '\n',
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const reply = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .find((j) => j && j.id === 2);
      expect(reply, 'no reply to the mem_search call').toBeTruthy();
      expect(reply.result.isError).toBe(true);
      const text = reply.result.content[0].text;
      expect(text).toMatch(FTS_FAULT);
      expect(text, 'the model is handed SQLite`s sentence and no next step').toMatch(/fts-check rebuild/);
      // The bare `claude-mem-lite` exists only after an optional `npm i -g` (the server's own
      // instructions say so), so the MCP face names the CLI by its absolute path (E2E 2026-10-16).
      expect(text).toContain(`node ${join(REPO, 'cli.mjs')} fts-check rebuild`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
