// R4 E2E audit (MED) — mem_update / cmdUpdate irreversibly blanked
// narrative / lesson_learned / concepts on an explicit empty string. `title` was
// guarded (schema .refine + CLI check) but the sibling content fields were not, and
// mem_update takes no pre-image snapshot, so the wipe was unrecoverable — sharpest
// for lesson_learned (precious, no recovery path once blanked). Fix: reject empty
// on both paths, mirroring the existing title guard (CLI/MCP parity).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { memUpdateSchema } from '../tool-schemas.mjs';

const CLI_PATH = resolve('cli.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-updempty-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function initDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'claude-mem-lite.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return db;
}
function runCli(args, dataDir) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_PROJECT_DIR: dataDir,
        CLAUDE_MEM_HOOK_RUNNING: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    return { stdout: (e.stdout?.toString() || '') + (e.stderr?.toString() || ''), exitCode: e.status ?? 1 };
  }
}

describe('R4 CLI update — explicit empty string does not blank content fields', () => {
  let dir;
  beforeEach(() => {
    dir = makeTmpDir();
    const db = initDb(dir);
    insertSession(db, { id: 'u-sess', project: 'p', memoryId: 'u-sess' });
    insertObs(db, {
      sessionId: 'u-sess',
      project: 'p',
      type: 'bugfix',
      title: 'keeper',
      narrative: 'ORIGINAL narrative body',
      text: 'ORIGINAL narrative body',
      lessonLearned: 'ORIGINAL lesson learned',
      searchAliases: null,
    });
    db.exec("UPDATE observations SET concepts = 'origconcept alpha' WHERE id = 1");
    db.close();
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  function field(name) {
    const db = new Database(join(dir, 'claude-mem-lite.db'));
    const row = db.prepare('SELECT narrative, lesson_learned, concepts FROM observations WHERE id = 1').get();
    db.close();
    return row[name];
  }

  it('--narrative "" is rejected and leaves the narrative unchanged', () => {
    const r = runCli(['update', '1', '--narrative', ''], dir);
    expect(r.stdout.toLowerCase()).toContain('empty');
    expect(field('narrative')).toBe('ORIGINAL narrative body');
  });
  it('--lesson "" is rejected and leaves the lesson unchanged', () => {
    const r = runCli(['update', '1', '--lesson', ''], dir);
    expect(r.stdout.toLowerCase()).toContain('empty');
    expect(field('lesson_learned')).toBe('ORIGINAL lesson learned');
  });
  it('--concepts "" is rejected and leaves the concepts unchanged', () => {
    const r = runCli(['update', '1', '--concepts', ''], dir);
    expect(r.stdout.toLowerCase()).toContain('empty');
    expect(field('concepts')).toBe('origconcept alpha');
  });
  it('a real non-empty update still works (no regression)', () => {
    runCli(['update', '1', '--narrative', 'a new narrative'], dir);
    expect(field('narrative')).toBe('a new narrative');
  });
});

describe('R4 MCP memUpdateSchema — empty content fields rejected (parity with CLI + title)', () => {
  const schema = z.object(memUpdateSchema);
  it('rejects an empty narrative', () => {
    expect(schema.safeParse({ id: 1, narrative: '' }).success).toBe(false);
    expect(schema.safeParse({ id: 1, narrative: '   ' }).success).toBe(false);
  });
  it('rejects an empty lesson_learned', () => {
    expect(schema.safeParse({ id: 1, lesson_learned: '' }).success).toBe(false);
  });
  it('rejects empty concepts', () => {
    expect(schema.safeParse({ id: 1, concepts: '' }).success).toBe(false);
  });
  it('accepts non-empty content fields (no regression)', () => {
    expect(schema.safeParse({ id: 1, narrative: 'real', lesson_learned: 'l', concepts: 'a b' }).success).toBe(
      true,
    );
  });
  it('still accepts an update that omits the content fields', () => {
    expect(schema.safeParse({ id: 1, importance: 2 }).success).toBe(true);
  });
});
