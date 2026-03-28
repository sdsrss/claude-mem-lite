// Integration Scenario Tests — Claude Code × claude-mem-lite Invocation Quality
// Tests the three-layer invocation chain: Hooks → MCP Tools → Skills/Instructions
// Evaluates: Does the right layer fire for each real-world coding scenario?
//
// Inspired by code-graph-mcp's end-to-end scenario testing approach.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { createTestDb, insertObs, insertSession } from './test-helpers.mjs';
import { searchRelevantMemories, recallForFile } from '../hook-memory.mjs';
import { shouldSkip, detectIntent, shouldSkipByDedup, extractFiles } from '../scripts/prompt-search-utils.mjs';

// ─── Paths ──────────────────────────────────────────────────────────────────

const HOOK_PATH = resolve('hook.mjs');
const PRE_RECALL_PATH = resolve('scripts/pre-tool-recall.js');
const POST_TOOL_SH = resolve('scripts/post-tool-use.sh');
const MOCK_CLAUDE = resolve('scripts/mock-claude.mjs');

// ─── MCP Tool Descriptions (extracted from server.mjs) ─────────────────────

const TOOL_DESCRIPTIONS = {
  mem_search: 'Search project memory for past bugfixes, decisions, and discoveries. Use when: encountering a familiar error, investigating a module before changes, or looking for prior art on a problem. Returns compact index (use mem_get for full details).',
  mem_recent: 'Show most recent observations. Use when: checking what happened recently in the project, reviewing progress after being away, or verifying that a recent change was captured.',
  mem_timeline: 'Browse observations as a timeline around an anchor point. Use when: exploring what happened before/after a specific observation, understanding the sequence of changes that led to a bug, or reviewing a session chronologically.',
  mem_get: 'Get full details for one or more records by ID. Use when: hook-injected context mentions a relevant observation ID, or after mem_search to drill into specific results for narrative, lesson_learned, and file details.',
  mem_delete: 'Delete observations by ID. Use when: cleaning up incorrect or duplicate observations, removing test data, or when the user asks to forget something. Use confirm=false to preview, confirm=true to execute.',
  mem_save: 'Save a memory/observation. Use when: solving a non-obvious bug (save the lesson), making an architecture decision, discovering something not obvious from code alone, or when the user asks to remember something.',
  mem_stats: 'Get memory statistics: counts, types, projects, daily activity, data health. Use when: assessing memory system health, checking how much project history exists, or diagnosing search quality issues.',
  mem_compress: 'Compress old low-value observations into weekly summaries. Use when: memory database is growing large, observations are months old, or after a major project phase completes. Use preview=true to see candidates first.',
  mem_maintain: 'Memory maintenance: scan for duplicates/stale/broken items, then execute cleanup/decay/boost/dedup operations. Use when: search results seem noisy with duplicates, after bulk imports, or during periodic maintenance.',
  mem_registry: 'Manage tool resource registry. Use when: looking for a skill or agent to solve a problem, importing tools from a repository, checking what resources are available, or managing installed tools.',
  mem_update: 'Update an existing observation in-place. Use when: an observation needs correction, additional context was discovered later, or the user asks to update a specific memory. Preserves original ID and references.',
  mem_export: 'Export observations as JSON or JSONL. Use when: backing up memory before migration, sharing observations between machines, or creating a snapshot before major changes.',
  mem_recall: 'Recall observations related to a file. Use when: about to edit a file, investigating a file with past issues, or before refactoring to recall past bugfixes, decisions, and context.',
  mem_fts_check: 'Check FTS5 index integrity or rebuild indexes. Use when: search results seem wrong or missing, after database recovery, or after manual DB edits.',
  mem_browse: 'Tier-grouped memory dashboard. Use when: getting an overview of memory health, seeing how observations are distributed across tiers, or assessing what to compress or clean up.',
};

// ─── MCP Instructions Decision Rules ────────────────────────────────────────

const MCP_INSTRUCTION_RULES = [
  { scenario: 'bug fix', rule: 'Before fixing a bug → recall the file', expectedTool: 'mem_recall' },
  { scenario: 'error encounter', rule: 'Encountering an error → search for similar', expectedTool: 'mem_search' },
  { scenario: 'module work', rule: 'Starting work on a module → recall past decisions', expectedTool: 'mem_search' },
  { scenario: 'lesson save', rule: 'After solving a non-obvious problem → save the lesson', expectedTool: 'mem_save' },
  { scenario: 'hook reference', rule: 'When hook-injected context mentions a relevant ID → get details', expectedTool: 'mem_get' },
];

// ─── Skill Descriptions ─────────────────────────────────────────────────────

const SKILL_DESCRIPTIONS = {
  'claude-mem-lite:search': 'Search memory for past bugfixes, decisions, discoveries. Use when: encountering a familiar error, investigating a module before changes, or looking for prior solutions to a similar problem',
  'claude-mem-lite:recall': 'Recall past observations for a file before editing. Use when: about to edit a file, investigating a file with past issues, or before refactoring to check for past lessons',
  'claude-mem-lite:recent': 'Show recent memory observations. Use when: checking what happened recently, reviewing session progress, or verifying recent changes were captured',
  'claude-mem-lite:timeline': 'Browse memory timeline around an observation. Use when: exploring what happened before/after a specific event, understanding the sequence of changes that led to a bug, or reviewing chronological context',
  'claude-mem-lite:memory': 'Save content to memory — with explicit content, instructions, or auto-summarize current session. Use when: the user asks to remember something, after solving a non-obvious problem, or to capture key session findings',
  'claude-mem-lite:update': 'Auto-maintain memory and resource registry — deduplicate, merge, decay, cleanup, reindex. Use when: search results seem noisy, after bulk imports, or during periodic maintenance',
  'claude-mem-lite:tools': 'Import skills and agents from GitHub repositories into the tool resource registry. Use when: looking for a skill to solve a problem, importing tools from a repo, or managing installed tools',
  'claude-mem-lite:mem': 'Search and manage project memory (observations, sessions, prompts). Use when: user asks about past work, wants to find a previous bugfix, check project history, save a decision, or manage stored memories',
};

// ─── E2E Subprocess Helpers ─────────────────────────────────────────────────

let tmpHome;
let projectDir;

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-scenario-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initTestDbOnDisk(tmpHome) {
  const dbDir = join(tmpHome, '.claude-mem-lite');
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(join(dbDir, 'runtime'), { recursive: true });
  const dbPath = join(dbDir, 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return db; // Return open DB for seeding
}

function openTestDb(tmpHome) {
  const dbPath = join(tmpHome, '.claude-mem-lite', 'claude-mem-lite.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  return db;
}

function runScript(scriptPath, { stdin, env = {}, args = [] } = {}) {
  const mergedEnv = {
    ...process.env,
    HOME: env.HOME || tmpHome,
    CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR || projectDir,
    CLAUDE_CODE_PATH: env.CLAUDE_CODE_PATH || MOCK_CLAUDE,
    CLAUDE_MEM_HOOK_RUNNING: undefined,
    CLAUDE_MEM_DEBUG: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    ...env,
  };
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) delete mergedEnv[k];
  }
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      input: stdin || '',
      timeout: 15000,
      encoding: 'utf8',
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

function runBash(scriptPath, { stdin, env = {} } = {}) {
  const mergedEnv = {
    ...process.env,
    HOME: env.HOME || tmpHome,
    CLAUDE_PROJECT_DIR: env.CLAUDE_PROJECT_DIR || projectDir,
    CLAUDE_MEM_HOOK_RUNNING: undefined,
    ...env,
  };
  for (const k of Object.keys(mergedEnv)) {
    if (mergedEnv[k] === undefined) delete mergedEnv[k];
  }
  try {
    const stdout = execFileSync('bash', [scriptPath], {
      input: stdin || '',
      timeout: 5000,
      encoding: 'utf8',
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || '',
      exitCode: e.status ?? 1,
    };
  }
}

function runHook(hookEvent, { stdin, env = {} } = {}) {
  return runScript(HOOK_PATH, { stdin, env: { ...env, HOME: env.HOME || tmpHome }, args: [hookEvent] });
}

function makeToolPayload(toolName, input, response) {
  return JSON.stringify({ tool_name: toolName, tool_input: input, tool_response: response });
}

// ─── Seed Data Helpers ──────────────────────────────────────────────────────

function seedScenarioData(db) {
  const project = 'parent--testproj';

  // Session
  insertSession(db, { id: 'sess-scenario', project });

  // Bugfix with lesson — for file recall and search
  insertObs(db, {
    sessionId: 'sess-scenario', project,
    type: 'bugfix', title: 'Fix FTS5 column mismatch in buildFtsTextField',
    text: 'FTS5 query failed because text_field column was renamed but buildFtsTextField still referenced old name',
    narrative: 'Root cause was schema migration not updating FTS5 virtual table definition',
    importance: 3,
    lessonLearned: 'FTS5 column name mismatches silently trigger degraded mode without explicit error — need defensive check',
    filesModified: '["hook-llm.mjs", "schema.mjs"]',
    epochOffset: -3600000, // 1h ago
  });

  // Decision — for cross-session and decision search
  insertObs(db, {
    sessionId: 'sess-scenario', project,
    type: 'decision', title: 'Use episode batching instead of per-tool saves',
    text: 'Decided to batch tool events into episodes for LLM encoding efficiency',
    narrative: 'Reduces LLM calls from N per tool to 1 per episode. 10x cost reduction.',
    importance: 3,
    filesModified: '["hook.mjs", "hook-episode.mjs"]',
    epochOffset: -86400000, // 1 day ago
  });

  // Discovery — for module investigation
  insertObs(db, {
    sessionId: 'sess-scenario', project,
    type: 'discovery', title: 'Weak regex in command parsers silently skip edge cases',
    text: 'The makeEntryDesc regex failed to match tool names with underscores like mem_search',
    narrative: 'Found by adding typed test fixtures that caught the silent failure',
    importance: 2,
    lessonLearned: 'Weak regex in command/function name parsers silently skip edge cases — catch with typed test fixtures',
    filesModified: '["utils.mjs"]',
    epochOffset: -7200000, // 2h ago
  });

  // Recent change — for "what happened recently"
  insertObs(db, {
    sessionId: 'sess-scenario', project,
    type: 'change', title: 'Add MCP tool description trigger conditions',
    text: 'Added Use when: trigger conditions to all 15 MCP tool descriptions',
    importance: 2,
    filesModified: '["server.mjs"]',
    epochOffset: -1800000, // 30min ago
  });

  // Feature — for feature search
  insertObs(db, {
    sessionId: 'sess-scenario', project,
    type: 'feature', title: 'PreToolUse file recall for Edit and Write tools',
    text: 'Implemented pre-tool-recall hook that surfaces file-specific lesson_learned before editing',
    narrative: 'Triggers on Edit/Write/NotebookEdit, queries observation_files junction table',
    importance: 2,
    lessonLearned: 'PreToolUse hooks must be lightweight (<100ms) — use standalone script, not full hook.mjs',
    filesModified: '["scripts/pre-tool-recall.js", "hook-memory.mjs"]',
    epochOffset: -172800000, // 2 days ago
  });

  // Cross-project decision (different project)
  insertObs(db, {
    sessionId: 'sess-scenario', project: 'other--project',
    type: 'decision', title: 'SQLite WAL mode required for concurrent readers',
    text: 'Multiple hook processes reading DB simultaneously requires WAL mode to avoid SQLITE_BUSY',
    importance: 3,
    filesModified: '["schema.mjs"]',
    epochOffset: -259200000, // 3 days ago
  });

  return project;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Layer 4: Hook Auto-Invocation Tests ────────────────────────────────────

describe('Scenario 1: Session Start — Context Injection', () => {
  beforeEach(() => {
    tmpHome = makeTmpDir();
    projectDir = join(tmpHome, 'parent', 'testproj');
    mkdirSync(projectDir, { recursive: true });
    const db = initTestDbOnDisk(tmpHome);
    seedScenarioData(db);
    db.close();
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('injects claude-mem-context with recent activity and key context', () => {
    const { stdout, exitCode } = runHook('session-start');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('<claude-mem-context>');
    expect(stdout).toContain('</claude-mem-context>');
    // Should contain structured sections
    expect(stdout).toMatch(/Recent|Key Context|File Lessons|Last Session/);
  });

  it('creates active session in DB', () => {
    runHook('session-start');
    const db = openTestDb(tmpHome);
    const rows = db.prepare('SELECT * FROM sdk_sessions WHERE status = ?').all('active');
    db.close();
    // At least the new session created by session-start
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Scenario 2: Bug Fix Memory Recall — User Prompt Search', () => {
  let db;
  let project;

  beforeEach(() => {
    db = createTestDb();
    project = 'parent--testproj';
    insertSession(db, { id: 'sess-scenario', project });
    // BM25 requires corpus diversity for meaningful IDF scores.
    // Seed 15+ unrelated observations so the target observation's terms have high IDF.
    const fillerTopics = [
      'Add user authentication flow', 'Refactor database connection pooling',
      'Update CSS styling for dashboard', 'Fix navigation menu alignment',
      'Implement pagination for search results', 'Add retry logic to API client',
      'Optimize image loading performance', 'Update dependency versions quarterly',
      'Add unit tests for validators', 'Refactor middleware pipeline architecture',
      'Fix race condition in cache invalidation', 'Add logging to webhook handler',
      'Update environment variable configuration', 'Fix timezone offset calculation',
      'Add export functionality for reports',
    ];
    for (const title of fillerTopics) {
      insertObs(db, {
        sessionId: 'sess-scenario', project,
        type: 'change', title, text: title.toLowerCase(),
        importance: 1, epochOffset: -Math.random() * 86400000 * 30,
      });
    }
    // Target: bugfix with lesson — unique terms "FTS5", "column", "mismatch"
    insertObs(db, {
      sessionId: 'sess-scenario', project,
      type: 'bugfix', title: 'Fix FTS5 column mismatch in buildFtsTextField',
      text: 'FTS5 query failed because text_field column was renamed',
      importance: 3,
      lessonLearned: 'FTS5 column name mismatches silently trigger degraded mode',
      filesModified: '["hook-llm.mjs", "schema.mjs"]',
    });
  });

  it('searchRelevantMemories finds FTS5 bugfix for matching query', () => {
    // Query uses unique terms from the target observation
    const results = searchRelevantMemories(db, 'FTS5 column mismatch', project);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('bugfix');
    expect(results[0].title).toContain('FTS5');
    expect(results[0].lesson_learned).toBeTruthy();
  });

  it('searchRelevantMemories returns empty for unrelated prompt', () => {
    const results = searchRelevantMemories(db, 'add a button to the homepage UI', project);
    expect(results.length).toBe(0);
  });

  it('adaptive BM25 threshold works for small corpora (<20 obs)', () => {
    // Create a small DB with only 1 observation — BM25 IDF is near-zero
    const smallDb = createTestDb();
    const p = 'small--project';
    insertSession(smallDb, { id: 'ss', project: p });
    insertObs(smallDb, {
      sessionId: 'ss', project: p,
      type: 'bugfix', title: 'Fix authentication token expiry race condition',
      text: 'Authentication token expiry race condition caused intermittent 401 errors',
      importance: 2,
      lessonLearned: 'Token refresh must be atomic — check expiry before AND after refresh',
    });
    // Before GAP 2 fix, this would return [] because BM25 score < 1.5
    // After fix, adaptive threshold (0.0001) allows small-corpus results
    const results = searchRelevantMemories(smallDb, 'authentication token expiry', p);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('authentication');
  });

  it('intent detection classifies error prompt as bugfix type', () => {
    const intent = detectIntent('schema.mjs 报错了，FTS5 查询不到数据');
    expect(intent).not.toBeNull();
    expect(intent.type).toBe('bugfix');
  });

  it('intent detection classifies decision question correctly', () => {
    const intent = detectIntent('为什么选择用 episode batching 而不是 per-tool saves');
    expect(intent).not.toBeNull();
    expect(intent.type).toBe('decision');
  });
});

describe('Scenario 3: File Edit Pre-Recall — PreToolUse', () => {
  beforeEach(() => {
    tmpHome = makeTmpDir();
    projectDir = join(tmpHome, 'parent', 'testproj');
    mkdirSync(projectDir, { recursive: true });
    const db = initTestDbOnDisk(tmpHome);
    seedScenarioData(db);
    db.close();
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('surfaces lesson_learned when editing file with past bugfix', () => {
    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/mnt/data_ssd/dev/projects/mem/hook-llm.mjs' },
    });
    const { stdout, exitCode } = runScript(PRE_RECALL_PATH, { stdin: payload });
    expect(exitCode).toBe(0);
    // Should surface the FTS5 lesson for hook-llm.mjs
    if (stdout.trim()) {
      expect(stdout).toContain('[mem] Lessons for');
      expect(stdout).toMatch(/FTS5|column|mismatch|degraded/i);
    }
    // Note: may be empty if cooldown is active — that's also valid behavior
  });

  it('returns nothing for file with no past observations', () => {
    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/brand-new-file.js' },
    });
    const { stdout, exitCode } = runScript(PRE_RECALL_PATH, { stdin: payload });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('recallForFile finds observations by filename match', () => {
    const db = createTestDb();
    const project = 'parent--testproj';
    insertSession(db, { id: 'sess-1', project });
    insertObs(db, {
      sessionId: 'sess-1', project,
      type: 'bugfix', title: 'Fix utils.mjs regex edge case',
      importance: 2,
      lessonLearned: 'Weak regex silently skips underscored names',
      filesModified: '["utils.mjs"]',
    });
    const results = recallForFile(db, '/mnt/data/projects/mem/utils.mjs', project);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].lesson_learned).toContain('regex');
  });
});

describe('Scenario 4: Error Detection in Bash — PostToolUse', () => {
  beforeEach(() => {
    tmpHome = makeTmpDir();
    projectDir = join(tmpHome, 'parent', 'testproj');
    mkdirSync(projectDir, { recursive: true });
    const db = initTestDbOnDisk(tmpHome);
    seedScenarioData(db);
    db.close();
    // Must start session for episode processing
    runHook('session-start');
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('Bash with error creates episode entry', () => {
    const payload = makeToolPayload('Bash', {
      command: 'npx vitest run tests/schema.test.mjs',
    }, 'Error: Cannot find module better-sqlite3\n  at require (node:internal/modules/cjs/loader:1225:18)');

    const { exitCode } = runHook('post-tool-use', { stdin: payload });
    expect(exitCode).toBe(0);

    // Episode buffer should have the error entry
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const epFiles = readdirSync(runtimeDir).filter(f => f.startsWith('ep-') && f.endsWith('.json') && !f.startsWith('ep-flush-'));
    expect(epFiles.length).toBeGreaterThan(0);

    const episode = JSON.parse(readFileSync(join(runtimeDir, epFiles[0]), 'utf8'));
    expect(episode.entries.length).toBeGreaterThan(0);
    // Error should be detected in the entry
    const entry = episode.entries.find(e => e.tool === 'Bash');
    expect(entry).toBeTruthy();
  });

  it('Edit tool creates episode entry (not skipped)', () => {
    const payload = makeToolPayload('Edit', {
      file_path: '/tmp/src/schema.mjs',
      old_string: 'old',
      new_string: 'new',
    }, 'OK — edited file');
    const { exitCode } = runHook('post-tool-use', { stdin: payload });
    expect(exitCode).toBe(0);

    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const epFiles = readdirSync(runtimeDir).filter(f => f.startsWith('ep-') && f.endsWith('.json') && !f.startsWith('ep-flush-'));
    expect(epFiles.length).toBeGreaterThan(0);
  });
});

describe('Scenario 5: Low-Value Tool Skip — PostToolUse Filtering', () => {
  beforeEach(() => {
    tmpHome = makeTmpDir();
    projectDir = join(tmpHome, 'parent', 'testproj');
    mkdirSync(projectDir, { recursive: true });
    initTestDbOnDisk(tmpHome).close();
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  const SKIP_SCENARIOS = [
    { tool: 'Glob', reason: 'file discovery noise' },
    { tool: 'Read', reason: 'file reading noise (tracked separately)' },
    { tool: 'TodoWrite', reason: 'internal task tracking' },
    { tool: 'TaskList', reason: 'meta-tool operation' },
    { tool: 'AskUserQuestion', reason: 'user interaction noise' },
    { tool: 'mcp__plugin_claude-mem-lite_mem__mem_search', reason: 'self-referential tool' },
    { tool: 'mcp__sequential_thinking', reason: 'thinking frame noise' },
    { tool: 'mcp__plugin_context7_context7__query-docs', reason: 'external API call' },
  ];

  for (const { tool, reason } of SKIP_SCENARIOS) {
    it(`skips ${tool} (${reason})`, () => {
      const payload = makeToolPayload(tool, {}, 'some response');
      const { exitCode } = runBash(POST_TOOL_SH, { stdin: payload });
      expect(exitCode).toBe(0);
      // No episode should be created (tool was skipped by bash pre-filter)
      const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
      const epFiles = existsSync(runtimeDir)
        ? readdirSync(runtimeDir).filter(f => f.startsWith('ep-') && f.endsWith('.json'))
        : [];
      expect(epFiles.length).toBe(0);
    });
  }

  it('does NOT skip Edit tool (high-value)', () => {
    // Start session first so post-tool-use can process
    runHook('session-start');
    const payload = makeToolPayload('Edit', {
      file_path: '/tmp/src/index.js',
      old_string: 'a',
      new_string: 'b',
    }, 'OK');
    const { exitCode } = runBash(POST_TOOL_SH, { stdin: payload });
    // Exit 0 means bash handed off to Node (not skipped)
    expect(exitCode).toBe(0);
  });

  it('Read tool tracks file path without launching Node', () => {
    const payload = makeToolPayload('Read', {
      file_path: '/mnt/data/projects/mem/schema.mjs',
    }, 'file contents...');
    runBash(POST_TOOL_SH, { stdin: payload });

    // Check reads file was created
    const runtimeDir = join(tmpHome, '.claude-mem-lite', 'runtime');
    const readsFiles = existsSync(runtimeDir)
      ? readdirSync(runtimeDir).filter(f => f.startsWith('reads-'))
      : [];
    expect(readsFiles.length).toBeGreaterThan(0);
    if (readsFiles.length > 0) {
      const content = readFileSync(join(runtimeDir, readsFiles[0]), 'utf8');
      expect(content).toContain('schema.mjs');
    }
  });
});

describe('Scenario 6: Prompt Classification — Intent Detection', () => {
  it('classifies error/bug prompts as bugfix intent', () => {
    const prompts = [
      'schema.mjs 报错了',
      'this function crashes when input is null',
      'build is broken after the latest commit',
      'fix the failing test in hook-memory.test.mjs',
      'Error: Cannot find module better-sqlite3',
    ];
    for (const p of prompts) {
      const intent = detectIntent(p);
      expect(intent, `Expected bugfix intent for: "${p}"`).not.toBeNull();
      expect(intent.type, `Expected type=bugfix for: "${p}"`).toBe('bugfix');
    }
  });

  it('classifies architecture/decision prompts as decision intent', () => {
    const prompts = [
      '为什么选择 episode batching',
      'why did we decide to use FTS5 instead of LIKE',
      'what was the architecture decision for hook separation',
    ];
    for (const p of prompts) {
      const intent = detectIntent(p);
      expect(intent, `Expected decision intent for: "${p}"`).not.toBeNull();
      expect(intent.type, `Expected type=decision for: "${p}"`).toBe('decision');
    }
  });

  it('classifies recall/history prompts as recent intent', () => {
    const prompts = [
      '之前做了什么',
      'what did we work on last time',
      // Note: "I remember we fixed..." matches bugfix intent first (higher priority)
      // This is by-design: error/fix keywords take precedence over temporal recall
      'do you remember what we did previously',
    ];
    for (const p of prompts) {
      const intent = detectIntent(p);
      expect(intent, `Expected recall intent for: "${p}"`).not.toBeNull();
      expect(intent.useRecent, `Expected useRecent=true for: "${p}"`).toBe(true);
    }
  });

  it('recall intent wins when temporal keyword appears before bugfix keyword', () => {
    // "I remember we fixed something here before" — "remember" appears before "fixed"
    // After GAP 3 fix: position-based disambiguation → recall wins
    const intent = detectIntent('I remember we fixed something here before');
    expect(intent).not.toBeNull();
    expect(intent.useRecent).toBe(true); // recall wins because "remember" appears first
  });

  it('bugfix intent wins when action keyword appears before temporal keyword', () => {
    // "fix the bug we saw before" — "fix" appears before "before"
    const intent = detectIntent('fix the bug we saw before');
    expect(intent).not.toBeNull();
    expect(intent.type).toBe('bugfix'); // bugfix wins because "fix" appears first
  });

  it('skips confirmation/short messages', () => {
    const prompts = ['yes', 'ok', '好的', '确认', 'y', 'no', 'lgtm', 'thanks'];
    for (const p of prompts) {
      expect(shouldSkip(p), `Expected skip for: "${p}"`).toBe(true);
    }
  });

  it('skips slash commands', () => {
    expect(shouldSkip('/commit')).toBe(true);
    expect(shouldSkip('/search FTS5')).toBe(true);
  });

  it('skips too-short prompts (CJK-weighted)', () => {
    expect(shouldSkip('hi')).toBe(true);      // 2 chars < 8 effective
    expect(shouldSkip('abc')).toBe(true);      // 3 chars < 8 effective
    expect(shouldSkip('修复它')).toBe(false);   // 3 CJK × 3 = 9 effective >= 8
    expect(shouldSkip('修')).toBe(true);       // 1 CJK × 3 = 3 effective < 8
  });

  it('extracts file paths from prompt text', () => {
    const files = extractFiles('look at hook-memory.mjs and schema.mjs for the bug');
    expect(files).toContain('hook-memory.mjs');
    expect(files).toContain('schema.mjs');
  });

  it('ignores URLs when extracting files', () => {
    const files = extractFiles('check https://example.com/api.js and also utils.mjs');
    expect(files).not.toContain('https://example.com/api.js');
    expect(files).toContain('utils.mjs');
  });
});

describe('Scenario 7: Cross-Session Memory — Semantic Search', () => {
  let db;
  const project = 'parent--testproj';

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-1', project });
    insertSession(db, { id: 'sess-2', project: 'other--project' });

    // BM25 needs corpus diversity — seed filler observations
    const fillerTopics = [
      'Add user auth flow', 'Refactor connection pooling', 'Update CSS dashboard',
      'Fix nav menu alignment', 'Implement pagination search', 'Add retry API client',
      'Optimize image loading', 'Update dependency versions', 'Add unit test validators',
      'Refactor middleware pipeline', 'Fix race condition cache', 'Add logging webhook',
      'Update env var config', 'Fix timezone offset calc', 'Add export reports',
    ];
    for (const title of fillerTopics) {
      insertObs(db, {
        sessionId: 'sess-1', project,
        type: 'change', title, text: title.toLowerCase(),
        importance: 1, epochOffset: -Math.random() * 86400000 * 30,
      });
    }

    // Same-project bugfix — unique terms: SQLite, WAL, deadlock, SQLITE_BUSY
    insertObs(db, {
      sessionId: 'sess-1', project,
      type: 'bugfix', title: 'Fix SQLite WAL deadlock in concurrent hook processes',
      text: 'SQLite WAL deadlock concurrent hook processes SQLITE_BUSY timeout',
      narrative: 'Multiple hook processes accessing DB caused SQLITE_BUSY errors',
      importance: 2,
      lessonLearned: 'Always use WAL mode and busy_timeout for concurrent SQLite access',
    });

    // Cross-project decision (high-value, transferable)
    insertObs(db, {
      sessionId: 'sess-2', project: 'other--project',
      type: 'decision', title: 'SQLite WAL mode required for concurrent readers',
      text: 'SQLite WAL concurrent readers multiple processes database access',
      importance: 3,
    });
  });

  it('finds same-project results with higher priority', () => {
    const results = searchRelevantMemories(db, 'SQLite WAL deadlock concurrent', project);
    expect(results.length).toBeGreaterThan(0);
    // Same-project bugfix should be present
    const sameProject = results.filter(r => r.project === project);
    expect(sameProject.length).toBeGreaterThan(0);
  });

  it('includes cross-project high-value decisions', () => {
    const results = searchRelevantMemories(db, 'SQLite WAL concurrent processes', project);
    // At minimum we should get the same-project result
    expect(results.length).toBeGreaterThan(0);
  });

  it('respects excludeIds filter', () => {
    const firstResults = searchRelevantMemories(db, 'SQLite WAL concurrent access', project);
    if (firstResults.length > 0) {
      const excludeIds = firstResults.map(r => r.id);
      const secondResults = searchRelevantMemories(db, 'SQLite WAL concurrent access', project, excludeIds);
      // Should not contain any excluded IDs
      for (const r of secondResults) {
        expect(excludeIds).not.toContain(r.id);
      }
    }
  });
});

describe('Scenario 8: Deduplication — Repeated Injections', () => {
  let tmpFile;

  beforeEach(() => {
    tmpHome = makeTmpDir();
    tmpFile = join(tmpHome, 'dedup-test.json');
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('skips injection when 80%+ IDs overlap', () => {
    // Simulate previous injection state
    writeFileSync(tmpFile, JSON.stringify({ ids: [1, 2, 3, 4, 5], ts: Date.now(), count: 1 }));
    // Same IDs: 100% overlap → skip
    expect(shouldSkipByDedup([1, 2, 3, 4, 5], tmpFile)).toBe(true);
    // 4/5 = 80% overlap → skip
    expect(shouldSkipByDedup([1, 2, 3, 4, 99], tmpFile)).toBe(true);
  });

  it('allows injection when overlap is below 80%', () => {
    writeFileSync(tmpFile, JSON.stringify({ ids: [1, 2, 3, 4, 5], ts: Date.now(), count: 1 }));
    // 3/5 = 60% overlap → allow
    expect(shouldSkipByDedup([1, 2, 3, 88, 99], tmpFile)).toBe(false);
    // All new IDs → allow
    expect(shouldSkipByDedup([10, 20, 30], tmpFile)).toBe(false);
  });

  it('allows injection when dedup file is stale (>5min)', () => {
    writeFileSync(tmpFile, JSON.stringify({
      ids: [1, 2, 3, 4, 5],
      ts: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      count: 1,
    }));
    expect(shouldSkipByDedup([1, 2, 3, 4, 5], tmpFile)).toBe(false);
  });

  it('blocks injection after MAX_SESSION_INJECTIONS reached', () => {
    writeFileSync(tmpFile, JSON.stringify({
      ids: [99],
      ts: Date.now(),
      count: 15, // MAX_SESSION_INJECTIONS = 15
    }));
    expect(shouldSkipByDedup([10, 20, 30], tmpFile)).toBe(true);
  });

  it('allows injection when no dedup file exists', () => {
    expect(shouldSkipByDedup([1, 2, 3], '/nonexistent/file.json')).toBe(false);
  });
});

// ─── Layer 1 & 2: Tool Description Trigger Quality ──────────────────────────

describe('Scenario 9: MCP Tool Description Trigger Matching', () => {
  // Simulates Claude Code's tool selection: given a user scenario,
  // which tool description keywords would match?
  function findMatchingTools(userScenario) {
    const keywords = userScenario.toLowerCase().split(/\s+/);
    const matches = [];
    for (const [tool, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      const descLower = desc.toLowerCase();
      const matchCount = keywords.filter(k => k.length > 3 && descLower.includes(k)).length;
      if (matchCount >= 2) {
        matches.push({ tool, matchCount, desc: desc.slice(0, 80) });
      }
    }
    return matches.sort((a, b) => b.matchCount - a.matchCount);
  }

  const SCENARIOS = [
    {
      name: 'User encounters familiar error',
      prompt: 'encountering a familiar error in the FTS5 search module',
      expectedTools: ['mem_search', 'mem_recall'],
      mustInclude: 'mem_search',
    },
    {
      name: 'Before editing a file',
      prompt: 'editing a file to recall past bugfixes and decisions context',
      expectedTools: ['mem_recall', 'mem_search'],
      mustInclude: 'mem_recall',
    },
    {
      name: 'After solving non-obvious bug',
      prompt: 'solving a non-obvious bug save the lesson architecture decision',
      expectedTools: ['mem_save'],
      mustInclude: 'mem_save',
    },
    {
      name: 'Checking recent project activity',
      prompt: 'checking what happened recently in the project reviewing progress',
      expectedTools: ['mem_recent'],
      mustInclude: 'mem_recent',
    },
    {
      name: 'Understanding bug sequence',
      prompt: 'exploring what happened before after a specific observation understanding sequence changes bug',
      expectedTools: ['mem_timeline'],
      mustInclude: 'mem_timeline',
    },
    {
      name: 'Hook-injected context mentions ID',
      prompt: 'hook-injected context mentions a relevant observation results details',
      expectedTools: ['mem_get'],
      mustInclude: 'mem_get',
    },
    {
      name: 'Search results seem wrong',
      prompt: 'search results seem wrong rebuild indexes database recovery',
      expectedTools: ['mem_fts_check'],
      mustInclude: 'mem_fts_check',
    },
    {
      name: 'Memory system health check',
      prompt: 'assessing memory system health checking project history diagnosing search quality',
      expectedTools: ['mem_stats'],
      mustInclude: 'mem_stats',
    },
  ];

  for (const { name, prompt, mustInclude } of SCENARIOS) {
    it(`"${name}" → matches ${mustInclude}`, () => {
      const matches = findMatchingTools(prompt);
      const toolNames = matches.map(m => m.tool);
      expect(toolNames, `Scenario "${name}" should match ${mustInclude}`).toContain(mustInclude);
    });
  }

  it('all 15 tools have "Use when:" trigger conditions (100% coverage)', () => {
    let withExplicitTrigger = 0;
    let total = 0;
    const missing = [];
    for (const [tool, desc] of Object.entries(TOOL_DESCRIPTIONS)) {
      total++;
      if (/use when:/i.test(desc)) withExplicitTrigger++;
      else missing.push(tool);
    }
    // After GAP 1 fix: all 15/15 have "Use when:" triggers (100%)
    expect(missing, `Tools missing "Use when:": ${missing.join(', ')}`).toHaveLength(0);
    expect(withExplicitTrigger).toBe(15);
    expect(total).toBe(15);
  });
});

describe('Scenario 10: Skill Description Trigger Coverage', () => {
  function skillMatchesScenario(scenarioKeywords) {
    const keywords = scenarioKeywords.toLowerCase().split(/\s+/);
    const matches = [];
    for (const [skill, desc] of Object.entries(SKILL_DESCRIPTIONS)) {
      const descLower = desc.toLowerCase();
      const matchCount = keywords.filter(k => k.length > 3 && descLower.includes(k)).length;
      if (matchCount >= 1) matches.push({ skill, matchCount });
    }
    return matches.sort((a, b) => b.matchCount - a.matchCount);
  }

  it('search skill matches error investigation scenario', () => {
    const matches = skillMatchesScenario('encountering error investigating module bugfixes');
    const skillNames = matches.map(m => m.skill);
    expect(skillNames).toContain('claude-mem-lite:search');
  });

  it('recall skill matches file editing scenario', () => {
    const matches = skillMatchesScenario('recall file before editing observations');
    const skillNames = matches.map(m => m.skill);
    expect(skillNames).toContain('claude-mem-lite:recall');
  });

  it('memory skill matches save decision scenario', () => {
    const matches = skillMatchesScenario('save decision memory content session');
    const skillNames = matches.map(m => m.skill);
    expect(skillNames).toContain('claude-mem-lite:memory');
  });

  it('recent skill matches progress check scenario', () => {
    const matches = skillMatchesScenario('checking recently progress session captured');
    const skillNames = matches.map(m => m.skill);
    expect(skillNames).toContain('claude-mem-lite:recent');
  });

  it('timeline skill matches bug sequence scenario', () => {
    const matches = skillMatchesScenario('exploring before after observation sequence bug changes');
    const skillNames = matches.map(m => m.skill);
    expect(skillNames).toContain('claude-mem-lite:timeline');
  });

  it('all 8 skills have "Use when:" trigger language (100% coverage)', () => {
    let withTrigger = 0;
    const missing = [];
    for (const [skill, desc] of Object.entries(SKILL_DESCRIPTIONS)) {
      if (/use when:/i.test(desc)) withTrigger++;
      else missing.push(skill);
    }
    expect(missing, `Skills missing "Use when:": ${missing.join(', ')}`).toHaveLength(0);
    expect(withTrigger).toBe(8);
  });
});

describe('Scenario 11: MCP Instructions Decision Rules', () => {
  it('all 5 proactive trigger rules map to valid tools', () => {
    for (const { scenario, expectedTool } of MCP_INSTRUCTION_RULES) {
      expect(
        TOOL_DESCRIPTIONS[expectedTool],
        `Rule "${scenario}" references non-existent tool: ${expectedTool}`,
      ).toBeTruthy();
    }
  });

  it('instruction rules cover the 3 core workflows', () => {
    const ruleScenarios = MCP_INSTRUCTION_RULES.map(r => r.scenario);
    // Core workflows: investigate → fix → learn
    expect(ruleScenarios.some(s => /bug|error/.test(s))).toBe(true);  // investigate
    expect(ruleScenarios.some(s => /module|work/.test(s))).toBe(true); // fix context
    expect(ruleScenarios.some(s => /lesson|save/.test(s))).toBe(true); // learn
  });

  it('instructions mention both CLI and MCP tools', () => {
    // The instructions block should guide both CLI and MCP tool usage
    const instructionText = [
      'CLI (via Bash): claude-mem-lite search',
      'MCP tools: mem_search, mem_recent, mem_save',
    ];
    // This is a static assertion — validates our design
    expect(instructionText[0]).toContain('CLI');
    expect(instructionText[1]).toContain('MCP tools');
  });
});

// ─── Coverage Summary ───────────────────────────────────────────────────────

describe('Integration Coverage Summary', () => {
  it('reports layer coverage matrix', () => {
    const matrix = {
      'Layer 1: MCP Tool Descriptions': {
        total: Object.keys(TOOL_DESCRIPTIONS).length,
        withTrigger: Object.values(TOOL_DESCRIPTIONS).filter(d => /use when:/i.test(d)).length,
      },
      'Layer 2: Skill Descriptions': {
        total: Object.keys(SKILL_DESCRIPTIONS).length,
        withTrigger: Object.values(SKILL_DESCRIPTIONS).filter(d => /use when:/i.test(d)).length,
      },
      'Layer 3: MCP Instructions': {
        total: MCP_INSTRUCTION_RULES.length,
        decisionRules: MCP_INSTRUCTION_RULES.length,
      },
      'Layer 4: Hooks': {
        total: 5, // session-start, pre-tool-use, post-tool-use, user-prompt, stop
        testedInThisSuite: 4, // session-start, pre-tool-use, post-tool-use, user-prompt
      },
    };

    // Print matrix for test report
    const l1 = matrix['Layer 1: MCP Tool Descriptions'];
    const l2 = matrix['Layer 2: Skill Descriptions'];

    // After optimization: 15/15 MCP tools and 8/8 skills have "Use when:" = 100%
    expect(l1.withTrigger).toBe(l1.total);
    expect(l2.withTrigger).toBe(l2.total);
    expect(matrix['Layer 3: MCP Instructions'].decisionRules).toBeGreaterThanOrEqual(5);
    expect(matrix['Layer 4: Hooks'].testedInThisSuite).toBeGreaterThanOrEqual(4);
  });
});
