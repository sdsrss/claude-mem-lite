// converge R30 (E2E 2026-11-10, hooks F5): a project with no memory of its own gets the
// "### Recent Activity" block topped up from other projects, and those titles were printed bare —
// read by the model as this project's history. The Recent table below them already labels a row
// from another project with its name; the block now does the same.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import {
  createTestDb,
  insertSession,
  insertObs,
  mkdtempWithoutInstructionAncestors,
} from './test-helpers.mjs';
import { buildSessionContextLines } from '../hook-context.mjs';

describe('SessionStart Recent Activity names the project of a borrowed row', () => {
  let db;
  let dir;
  let saved;
  beforeEach(() => {
    // effectiveQuiet() reads the project dir; this repository is adopted, which would hide the
    // block and let the assertions pass on nothing (CLAUDE.md § Testing this repo).
    dir = mkdtempWithoutInstructionAncestors('cml-recent-activity-');
    saved = { dir: process.env.CLAUDE_PROJECT_DIR, adopt: process.env.MEM_NO_AUTO_ADOPT };
    process.env.CLAUDE_PROJECT_DIR = mkdtempSync(join(dir, 'proj-'));
    process.env.MEM_NO_AUTO_ADOPT = '1';
    db = createTestDb();
    insertSession(db, { id: 'sess-other', project: 'shop--api' });
  });
  afterEach(() => {
    db.close();
    for (const [k, v] of [
      ['CLAUDE_PROJECT_DIR', saved.dir],
      ['MEM_NO_AUTO_ADOPT', saved.adopt],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('a title from another project carries that project', () => {
    insertObs(db, {
      sessionId: 'sess-other',
      project: 'shop--api',
      type: 'decision',
      title: 'Chose idempotency keys for the payment retry path',
      importance: 2,
    });
    const out = buildSessionContextLines(db, 'blog--site');
    expect(out, 'premise: the block is rendered').toContain('### Recent Activity');
    expect(out).toContain('- Chose idempotency keys for the payment retry path (shop--api)');
  });
});
