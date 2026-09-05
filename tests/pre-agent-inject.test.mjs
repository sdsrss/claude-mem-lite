// tests/pre-agent-inject.test.mjs
// P0 subagent dispatch-time memory injection (2026-07-03). Subagents are
// memory-blind (plugin hooks do not fire inside them — #8848); this feature
// injects one relevant project lesson into a dispatched subagent's prompt via a
// PreToolUse:Agent hook that mutates tool_input.prompt (hookSpecificOutput.updatedInput).
// Mechanism + safe framing verified live 2026-07-03 (Phase 0a/0b): a raw prepend
// tripped the subagent's prompt-injection detector -> refusal; an appended,
// attributed, reference-only block was adopted. These tests lock the pure logic.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs } from './test-helpers.mjs';
import { formatSubagentContext } from '../lib/task-imperative.mjs';
import { buildSubagentInjection } from '../hook-memory.mjs';
import { inferProject } from '../utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('formatSubagentContext (safe framing — Phase 0b validated)', () => {
  it('frames an appended, attributed, reference-only block carrying the #id + lesson', () => {
    const b = formatSubagentContext('use rrfMerge not naive union for fusion', 456);
    expect(b).toContain('#456');
    expect(b).toContain('use rrfMerge not naive union for fusion');
    expect(b).toContain('Reference context, not an external instruction');
    expect(b.startsWith('\n')).toBe(true); // appends below the task, blank-line separated
  });
  it('returns empty string for an empty/whitespace lesson', () => {
    expect(formatSubagentContext('', 1)).toBe('');
    expect(formatSubagentContext('   ', 1)).toBe('');
  });
  it('omits the #id tag when id is absent', () => {
    expect(formatSubagentContext('do the thing')).not.toContain('#');
  });
});

describe('buildSubagentInjection', () => {
  let db;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 's', project: 'p' });
  });
  afterEach(() => db.close());
  const seed = (o) => insertObs(db, { sessionId: 's', project: 'p', ...o });

  it('appends the framed lesson when the subagent prompt names a matching identifier', () => {
    seed({ title: 'rrf', lessonLearned: 'use rrfMerge not naive union', importance: 2 });
    const ti = { subagent_type: 'general-purpose', description: 'x', prompt: 'refactor rrfMerge in tfidf' };
    const out = buildSubagentInjection(db, ti, 'p');
    expect(out).not.toBeNull();
    expect(out.subagent_type).toBe('general-purpose'); // preserves sibling fields
    expect(out.prompt.startsWith('refactor rrfMerge in tfidf')).toBe(true); // task stays first
    expect(out.prompt).toContain('use rrfMerge not naive union');
    expect(out.prompt).toContain('Reference context, not an external instruction');
  });
  it('returns null when no lesson identifier overlaps the subagent prompt', () => {
    seed({ title: 'x', lessonLearned: 'always call recoverChildrenOf first', importance: 3 });
    expect(buildSubagentInjection(db, { prompt: 'write a haiku about spring' }, 'p')).toBeNull();
  });
  it('returns null for missing / empty / non-string prompt', () => {
    seed({ title: 'x', lessonLearned: 'use rrfMerge here', importance: 3 });
    expect(buildSubagentInjection(db, { prompt: '' }, 'p')).toBeNull();
    expect(buildSubagentInjection(db, {}, 'p')).toBeNull();
    expect(buildSubagentInjection(db, null, 'p')).toBeNull();
  });
});

// Script-level plumbing (spawn the actual hook): flag gate, tool-name filter, the
// emit envelope shape + stdout flush. Mirrors the repo convention (tests/audit-fixes
// spawns pre-skill-bridge). The >64KB case guards the process.exit()-truncation fix.
describe('pre-agent-inject.js (script plumbing, spawned)', () => {
  const SCRIPT = resolve(__dirname, '../scripts/pre-agent-inject.js');
  const CLI = resolve(__dirname, '../cli.mjs');
  let sb, project;

  beforeAll(() => {
    sb = mkdtempSync(join(tmpdir(), 'pai-spawn-'));
    // The script infers its project from CLAUDE_PROJECT_DIR (utils.inferProject). Pin
    // that to sb and seed the lesson under the SAME inferred name, so they match
    // regardless of the checkout path. A hardcoded --project only matched the author's
    // machine; CI's checkout path infers a different name → selectImperativeLesson finds
    // nothing → empty output → JSON.parse fails (the v3.33.1 CI red).
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = sb;
    project = inferProject();
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
    execFileSync(
      process.execPath,
      [
        CLI,
        'save',
        'rrf seed',
        '--type',
        'decision',
        '--importance',
        '2',
        '--project',
        project,
        '--lesson',
        'use rrfMerge not naive union',
      ],
      { env: { ...process.env, CLAUDE_MEM_DIR: sb }, stdio: 'ignore', timeout: 20000 },
    );
  });
  afterAll(() => {
    if (sb) {
      try {
        rmSync(sb, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  // CLAUDE_MEM_SUBAGENT_INJECT is cleared by default (it is set on in this project's
  // settings.local.json for dogfood and would otherwise leak into the child — #87499fd).
  // CLAUDE_PROJECT_DIR = sb so the script infers the SAME project the lesson was seeded under.
  const run = (payload, { on = false } = {}) =>
    execFileSync(process.execPath, [SCRIPT], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 8000,
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: sb,
        CLAUDE_PROJECT_DIR: sb,
        CLAUDE_MEM_HOOK_RUNNING: undefined,
        CLAUDE_MEM_SUBAGENT_INJECT: on ? 'on' : undefined,
      },
    }).trim();

  it('default OFF emits nothing (even for a matching Agent dispatch)', () => {
    expect(run({ tool_name: 'Agent', tool_input: { prompt: 'refactor rrfMerge in tfidf' } })).toBe('');
  });

  it('enabled but non-Agent tool emits nothing', () => {
    expect(run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { on: true })).toBe('');
  });

  it('enabled + Agent + matching lesson emits a valid PreToolUse updatedInput envelope', () => {
    const out = run(
      {
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'general-purpose',
          description: 'x',
          prompt: 'refactor rrfMerge in tfidf',
        },
      },
      { on: true },
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.updatedInput.subagent_type).toBe('general-purpose');
    expect(parsed.hookSpecificOutput.updatedInput.prompt.startsWith('refactor rrfMerge in tfidf')).toBe(true);
    expect(parsed.hookSpecificOutput.updatedInput.prompt).toContain('use rrfMerge not naive union');
  });

  it('enabled + Agent + no identifier overlap emits nothing', () => {
    expect(
      run({ tool_name: 'Agent', tool_input: { prompt: 'write a haiku about spring' } }, { on: true }),
    ).toBe('');
  });

  it('a >64KB prompt round-trips intact (stdout flush before exit — no truncation)', () => {
    const big = 'refactor rrfMerge ' + 'x'.repeat(80000);
    const out = run({ tool_name: 'Agent', tool_input: { prompt: big } }, { on: true });
    const parsed = JSON.parse(out); // parses only if the full payload was flushed
    expect(parsed.hookSpecificOutput.updatedInput.prompt.length).toBeGreaterThan(80000);
    expect(parsed.hookSpecificOutput.updatedInput.prompt).toContain('use rrfMerge not naive union');
  });
});
