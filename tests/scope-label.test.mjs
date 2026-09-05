// P3 (D#78): enrich-time scope label — spec tasks/specs/scope-label.md.
//
// scope ∈ {file, module, project, environment} classifies where a lesson
// APPLIES, decoupling it from which files the episode happened to touch
// (89% of lessons never mention their attached file — the edges are
// "touched during", not "about"). environment-scoped lessons are the
// D#65 top-bypassed class; CLAUDE_MEM_SCOPE_FILTER=1 (opt-in) excludes
// them from file-triggered pre-tool injection at READ time (edges kept,
// reversible).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { createTestDb, insertSession, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import { initSchema } from '../schema.mjs';
import { insertObservationRow, normalizeScope, SCOPE_PROMPT_LEGEND } from '../lib/observation-write.mjs';
import { saveObservation } from '../hook-llm.mjs';

describe('scope schema (v43 batch)', () => {
  it('fresh initSchema creates observations.scope', () => {
    const db = createTestDb();
    const col = db.prepare(`SELECT name FROM pragma_table_info('observations') WHERE name = 'scope'`).get();
    expect(col).toEqual({ name: 'scope' });
    db.close();
  });
});

describe('normalizeScope', () => {
  it('accepts exactly the four enum values', () => {
    for (const v of ['file', 'module', 'project', 'environment']) {
      expect(normalizeScope(v)).toBe(v);
    }
  });
  it('rejects anything else to null', () => {
    for (const v of ['global', 'FILE', '', null, undefined, 42, ['file'], 'env']) {
      expect(normalizeScope(v)).toBeNull();
    }
  });
});

describe('insertObservationRow / saveObservation persist scope', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('insertObservationRow writes scope; omitted → NULL', () => {
    const id1 = insertObservationRow(db, {
      memory_session_id: 'sess-1',
      project: 'p',
      type: 'bugfix',
      title: 't',
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
      scope: 'environment',
    });
    expect(db.prepare('SELECT scope FROM observations WHERE id=?').get(id1).scope).toBe('environment');
    const id2 = insertObservationRow(db, {
      memory_session_id: 'sess-1',
      project: 'p',
      type: 'bugfix',
      title: 't2',
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    });
    expect(db.prepare('SELECT scope FROM observations WHERE id=?').get(id2).scope).toBeNull();
  });

  it('saveObservation passes a valid obs.scope through and nulls an invalid one', () => {
    const idA = saveObservation(
      {
        type: 'bugfix',
        title: 'proxy blocks fetch behind corp VPN',
        narrative: 'a sufficiently long narrative for the noise gates to pass through here',
        importance: 2,
        lessonLearned: 'node fetch ignores HTTP_PROXY without an agent',
        files: ['whatever.mjs'],
        scope: 'environment',
      },
      'p',
      'sess-1',
      db,
    );
    expect(db.prepare('SELECT scope FROM observations WHERE id=?').get(idA).scope).toBe('environment');

    const idB = saveObservation(
      {
        type: 'bugfix',
        title: 'another lesson-bearing observation title here',
        narrative: 'another sufficiently long narrative for the noise gates to pass through',
        importance: 2,
        lessonLearned: 'a second real lesson body for the test',
        files: ['other.mjs'],
        scope: 'bogus-value',
      },
      'p',
      'sess-1',
      db,
    );
    expect(db.prepare('SELECT scope FROM observations WHERE id=?').get(idB).scope).toBeNull();
  });
});

describe('in-place re-summarization preserves scope on empty (review D#78)', () => {
  // Mirrors the narrative COALESCE contract test (llm-episode-narrative-preserve-r3):
  // pins the exact SET expression the episode-continuation UPDATE uses. A second
  // Haiku pass that omits or mis-cases scope (normalizeScope → NULL) must not
  // wipe a previously-stored valid scope — the recurring empty-overwrite class.
  it('COALESCE(?, scope) keeps the stored scope when the upgrade emits null', () => {
    const db = createTestDb();
    insertSession(db, { id: 'sess-1', project: 'p' });
    const id = insertObservationRow(db, {
      memory_session_id: 'sess-1',
      project: 'p',
      type: 'bugfix',
      title: 't',
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
      scope: 'environment',
    });
    db.prepare('UPDATE observations SET scope=COALESCE(?, scope) WHERE id=?').run(
      normalizeScope('Environment'),
      id,
    );
    expect(db.prepare('SELECT scope FROM observations WHERE id=?').get(id).scope).toBe('environment');
    db.prepare('UPDATE observations SET scope=COALESCE(?, scope) WHERE id=?').run(normalizeScope('file'), id);
    expect(db.prepare('SELECT scope FROM observations WHERE id=?').get(id).scope).toBe('file');
    db.close();
  });
});

describe('episode prompts instruct Haiku to emit scope', () => {
  // The two JSON templates live inline in handleLLMEpisode (single- and
  // multi-entry). Pin the contract at source level: both templates and the
  // shared schema tail must carry the scope key + guidance. Source-text pin
  // is deliberate — no LLM mock harness exists, and this is what actually
  // ships to Haiku.
  const src = readFileSync(resolve(import.meta.dirname, '../hook-llm.mjs'), 'utf8');

  it('both JSON templates include the scope enum key', () => {
    const matches = src.match(/"scope":"file\|module\|project\|environment"/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('shared schema tail defines scope semantics including the environment class', () => {
    // The legend became a shared constant in D#135 P3 — three write faces classify
    // scope now (episode summarizer, save-enrich, re-enrich) and hand-copied
    // definitions would drift. Assert what actually ships: hook-llm interpolates
    // the constant, and the constant carries the semantics.
    expect(src).toMatch(/scope: \$\{SCOPE_PROMPT_LEGEND\}/);
    expect(SCOPE_PROMPT_LEGEND).toMatch(/where does the lesson APPLY/);
    expect(SCOPE_PROMPT_LEGEND).toMatch(/environment = a tooling\/OS\/CI/);
  });

  // Counts, not existence. `toMatch` succeeds on ANY single occurrence, so the
  // first version of this guard survived deleting the legend from the aliases
  // prompt while its `"scope":"..."` JSON key stayed — a prompt asking for a
  // classification with no definition, i.e. exactly the per-face drift the
  // shared constant exists to prevent. Demonstrated survivor, pre-tag review.
  // `keys` and `legends` are pinned SEPARATELY per file because they are not
  // 1:1 by design: hook-llm's two episode templates (single- and multi-entry)
  // both append one shared schema tail, so 2 keys share 1 legend. Asserting
  // keys <= legends would therefore fail on correct code, and asserting only
  // "at least one legend" is what let the survivor through. Two numbers per
  // file catch drift in either direction.
  const LEGEND_SITES = [
    ['../hook-llm.mjs', { keys: 2, legends: 1 }], // 2 templates, 1 shared tail
    ['../lib/save-enrich.mjs', { keys: 1, legends: 1 }], // save-time enrichment
    ['../hook-optimize.mjs', { keys: 3, legends: 3 }], // narrow/wide + aliases + scopes
  ];

  it('every scope-classifying prompt renders the shared legend — by count, per file', () => {
    for (const [file, expected] of LEGEND_SITES) {
      const text = readFileSync(resolve(import.meta.dirname, file), 'utf8');
      const legends = (text.match(/scope: \$\{SCOPE_PROMPT_LEGEND\}/g) || []).length;
      const keys = (text.match(/"scope":"file\|module\|project\|environment"/g) || []).length;
      expect(legends, `${file} should render the legend ${expected.legends}x`).toBe(expected.legends);
      expect(keys, `${file} should ask for the scope key ${expected.keys}x`).toBe(expected.keys);
      // A face that inlined its own wording instead of importing the constant.
      expect(text).not.toMatch(/where does the lesson APPLY/);
    }
  });
});

describe('pre-tool-recall CLAUDE_MEM_SCOPE_FILTER (opt-in)', () => {
  const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');
  let tmpRoot;
  let projectDir;

  function runScript(input, env = {}) {
    return new Promise((res, reject) => {
      const child = spawn('node', [SCRIPT_PATH], {
        env: {
          ...process.env,
          CLAUDE_MEM_HOOK_RUNNING: '',
          CLAUDE_MEM_DIR: tmpRoot,
          CLAUDE_PROJECT_DIR: projectDir,
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.on('close', () => res(stdout));
      child.on('error', reject);
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
      setTimeout(() => {
        child.kill();
        reject(new Error('timeout'));
      }, SUBPROCESS_TIMEOUT_MS);
    });
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), `scope-filter-${process.pid}-`));
    projectDir = join(tmpRoot, 'parent', 'scopetest');
    mkdirSync(projectDir, { recursive: true });

    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'sess-sc', project: 'parent--scopetest', memoryId: 'mem-sc' });
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  function seed(scope, lesson, fname) {
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    const id = insertObservationRow(db, {
      memory_session_id: 'mem-sc',
      project: 'parent--scopetest',
      type: 'bugfix',
      title: `seed ${fname}`,
      importance: 2,
      lesson_learned: lesson,
      created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
      files_modified: JSON.stringify([fname]),
      scope,
    });
    db.prepare('INSERT INTO observation_files (obs_id, filename) VALUES (?, ?)').run(id, fname);
    db.close();
  }

  it('flag ON: environment-scoped lesson is not injected on Edit', async () => {
    seed('environment', 'proxy gotcha unrelated to this file', 'envy.mjs');
    const stdout = await runScript(
      {
        tool_name: 'Edit',
        session_id: 's1',
        tool_input: { file_path: join(projectDir, 'envy.mjs') },
      },
      { CLAUDE_MEM_SCOPE_FILTER: '1' },
    );
    if (stdout) {
      const ctx = JSON.parse(stdout).hookSpecificOutput?.additionalContext || '';
      expect(ctx).not.toContain('proxy gotcha unrelated to this file');
    }
  });

  it('flag ON: file-scoped and NULL-scoped lessons still fire', async () => {
    seed('file', 'file-scoped lesson body', 'filey.mjs');
    seed(null, 'legacy null-scope lesson body', 'nully.mjs');
    const out1 = await runScript(
      {
        tool_name: 'Edit',
        session_id: 's2',
        tool_input: { file_path: join(projectDir, 'filey.mjs') },
      },
      { CLAUDE_MEM_SCOPE_FILTER: '1' },
    );
    expect(JSON.parse(out1).hookSpecificOutput.additionalContext).toContain('file-scoped lesson body');
    const out2 = await runScript(
      {
        tool_name: 'Edit',
        session_id: 's3',
        tool_input: { file_path: join(projectDir, 'nully.mjs') },
      },
      { CLAUDE_MEM_SCOPE_FILTER: '1' },
    );
    expect(JSON.parse(out2).hookSpecificOutput.additionalContext).toContain('legacy null-scope lesson body');
  });

  it('flag OFF (default): environment-scoped lesson still fires — no behavior change', async () => {
    seed('environment', 'environment lesson visible without the flag', 'defaulty.mjs');
    const stdout = await runScript({
      tool_name: 'Edit',
      session_id: 's4',
      tool_input: { file_path: join(projectDir, 'defaulty.mjs') },
    });
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain(
      'environment lesson visible without the flag',
    );
  });
});
