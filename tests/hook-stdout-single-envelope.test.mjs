// One hook process ⇒ at most ONE JSON document on stdout.
//
// Claude Code 2.1.233 parses a command hook's stdout with (verbatim from the bundle):
//
//   function Hxi(e){ let t=e.trim();
//     if(!t.startsWith("{")) return {plainText:e};
//     try{ let r=XZf(t); ... } catch(r){ return {plainText:e} } }
//
// XZf JSON.parses the WHOLE trimmed string. There is no line splitting, so the
// long-standing assumption in hook.mjs ("Claude Code's line-based JSON parser",
// "two separate JSON lines each parse independently") was wrong, and two
// envelopes on one stdout degrade to plainText. For SessionStart that means the
// raw `{"suppressOutput":true,…}` is injected as literal text; for PostToolUse
// the renderer drops plainText entirely, so BOTH receipts are lost in silence.
//
// The reachable PostToolUse case: a hard-error Bash call runs triggerErrorRecall
// (envelope 1) and then flushes a full episode buffer (envelope 2) in one
// handlePostToolUse.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { queueHookContext, flushHookStdout, resetHookStdout, peekHookStdout } from '../lib/hook-stdout.mjs';

const HOOK_PATH = resolve(import.meta.dirname, '../hook.mjs');

describe('lib/hook-stdout — the emitter', () => {
  beforeEach(() => resetHookStdout());

  it('merges several contributions into one envelope', () => {
    const written = [];
    queueHookContext('PostToolUse', '[mem] episode flushed: 3 entries');
    queueHookContext('PostToolUse', '[mem] Related memories found for this error');
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(true);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('episode flushed');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Related memories');
    expect(parsed.suppressOutput).toBe(true);
  });

  it('writes nothing when nothing was queued', () => {
    const written = [];
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(false);
    expect(written).toEqual([]);
  });

  it('ignores blank contributions rather than emitting an empty envelope', () => {
    const written = [];
    queueHookContext('Stop', '');
    queueHookContext('Stop', '   \n  ');
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(false);
    expect(written).toEqual([]);
  });

  it('is idempotent, so a dispatcher flush plus an exit backstop cannot double-write', () => {
    const written = [];
    queueHookContext('SessionStart', 'dashboard');
    flushHookStdout({ write: (s) => written.push(s) });
    flushHookStdout({ write: (s) => written.push(s) });
    expect(written).toHaveLength(1);
  });

  it('drops a mismatched event rather than emit an envelope the host rejects', () => {
    queueHookContext('PostToolUse', 'first');
    // warn injected: the real one writes to stderr, and a suite that prints
    // "This is a wiring bug" on every run teaches people to ignore it.
    queueHookContext('SessionStart', 'second', { warn: () => {} });
    expect(peekHookStdout().hookEventName).toBe('PostToolUse');
    expect(peekHookStdout().parts).toEqual(['first']);
  });

  // Pre-tag review NOTE 3: the drop above was silent. Unreachable today — all three
  // call sites are event-consistent — but flushEpisode's hookEventName DEFAULTS to
  // 'PostToolUse', so a future caller that omits the argument would both mis-tag its
  // receipt and have it swallowed with no trace. "Work silently disappears" is this
  // repo's most-repeated defect class; a drop has to leave a mark.
  it('says so on stderr when it drops a mismatched contribution', () => {
    const warned = [];
    queueHookContext('PostToolUse', 'first');
    queueHookContext('SessionStart', 'second', { warn: (m) => warned.push(m) });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/SessionStart/);
    expect(warned[0]).toMatch(/PostToolUse/);
  });

  it('does not warn on the normal same-event path', () => {
    const warned = [];
    queueHookContext('PostToolUse', 'a', { warn: (m) => warned.push(m) });
    queueHookContext('PostToolUse', 'b', { warn: (m) => warned.push(m) });
    expect(warned).toEqual([]);
  });
});

// updatedInput is a REPLACEMENT of the tool's input, and PreToolUse is the only event
// whose schema carries one. From the 2.1.241 bundle, that schema is:
//
//   ye({ hookEventName: Ht("PreToolUse"), permissionDecision: …optional(),
//        permissionDecisionReason: …optional(), updatedInput: …optional(),
//        additionalContext: …optional() })
//
// — a mutation and a context line may ride ONE envelope. That is why the channel lives
// here rather than in its own writer: scripts/pre-agent-inject.js hand-wrote its own
// envelope, so the day it also wants to say something it would have emitted two
// documents and lost both (D#154).
describe('lib/hook-stdout — the updatedInput channel', () => {
  beforeEach(() => resetHookStdout());

  it('carries a tool-input replacement alongside context in ONE envelope', async () => {
    const { queueHookUpdatedInput } = await import('../lib/hook-stdout.mjs');
    const written = [];
    queueHookUpdatedInput('PreToolUse', { prompt: 'task text\n\nlesson #42' });
    queueHookContext('PreToolUse', '[mem] heads up');
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(true);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.updatedInput.prompt).toContain('lesson #42');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('[mem] heads up');
  });

  it('emits an updatedInput-only envelope with no additionalContext key', async () => {
    const { queueHookUpdatedInput } = await import('../lib/hook-stdout.mjs');
    const written = [];
    queueHookUpdatedInput('PreToolUse', { prompt: 'only a mutation' });
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(true);
    const parsed = JSON.parse(written[0]);
    expect(parsed.hookSpecificOutput.updatedInput.prompt).toBe('only a mutation');
    // Not merely falsy: an empty additionalContext is a different document than none.
    expect('additionalContext' in parsed.hookSpecificOutput).toBe(false);
  });

  it('keeps the FIRST replacement and says so, rather than silently clobbering it', async () => {
    const { queueHookUpdatedInput } = await import('../lib/hook-stdout.mjs');
    const warned = [];
    queueHookUpdatedInput('PreToolUse', { prompt: 'first' }, { warn: (m) => warned.push(m) });
    queueHookUpdatedInput('PreToolUse', { prompt: 'second' }, { warn: (m) => warned.push(m) });
    expect(peekHookStdout().updatedInput).toEqual({ prompt: 'first' });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/second mutation is lost/);
  });

  it('refuses a replacement whose event contradicts what is already queued', async () => {
    const { queueHookUpdatedInput } = await import('../lib/hook-stdout.mjs');
    const warned = [];
    queueHookContext('PostToolUse', 'a receipt');
    queueHookUpdatedInput('PreToolUse', { prompt: 'x' }, { warn: (m) => warned.push(m) });
    expect(peekHookStdout().updatedInput).toBeNull();
    expect(peekHookStdout().hookEventName).toBe('PostToolUse');
    expect(warned[0]).toMatch(/PreToolUse updatedInput/);
  });

  it('ignores non-object replacements instead of emitting a malformed envelope', async () => {
    const { queueHookUpdatedInput } = await import('../lib/hook-stdout.mjs');
    const written = [];
    for (const bad of [null, undefined, '', 'a string', 42, ['an', 'array']]) {
      queueHookUpdatedInput('PreToolUse', bad);
    }
    expect(peekHookStdout().updatedInput).toBeNull();
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(false);
    expect(written).toEqual([]);
  });

  // The first version of this flushed twice with NOTHING queued in between and asserted
  // one write. It was not binding: deleting `queuedInput = null` from the flush left the
  // whole suite 19/19 green, because the same reset clears `queuedEvent` and
  // `hasInput = Boolean(queuedEvent) && queuedInput !== null` short-circuits on that — so
  // the probe could never reach the state it named. Both v3.80.0 pre-tag reviewers found
  // it independently. Re-queueing a CONTEXT line between the flushes is what forces the
  // assertion through `queuedInput`; verified to fail under that mutation and pass here.
  it('clears the replacement on flush, so a later envelope cannot re-apply a stale mutation', async () => {
    const { queueHookUpdatedInput } = await import('../lib/hook-stdout.mjs');
    const written = [];
    queueHookUpdatedInput('PreToolUse', { prompt: 'once' });
    flushHookStdout({ write: (s) => written.push(s) });
    queueHookContext('PreToolUse', 'a later, unrelated line');
    flushHookStdout({ write: (s) => written.push(s) });
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]).hookSpecificOutput.updatedInput.prompt).toBe('once');
    // The stale whole-tool-input replacement must NOT ride the second envelope — that is
    // a silent re-mutation of the tool call, the shape this module exists to prevent.
    expect('updatedInput' in JSON.parse(written[1]).hookSpecificOutput).toBe(false);
    expect(JSON.parse(written[1]).hookSpecificOutput.additionalContext).toBe('a later, unrelated line');
  });

  it('writes nothing on a second flush when nothing was re-queued', async () => {
    const { queueHookUpdatedInput } = await import('../lib/hook-stdout.mjs');
    const written = [];
    queueHookUpdatedInput('PreToolUse', { prompt: 'once' });
    flushHookStdout({ write: (s) => written.push(s) });
    flushHookStdout({ write: (s) => written.push(s) });
    expect(written).toHaveLength(1);
  });
});

// The update banner is a notice for the HUMAN, not context for the model. v3.70.0
// folded it into additionalContext with suppressOutput:true, which made it
// model-only — content preserved, audience lost. Claude Code 2.1.234's command-hook
// path renders a top-level `systemMessage` as its own `hook_system_message`
// conversation message, independently of additionalContext:
//
//   if (G.systemMessage) { … yield { message: yc({ type: "hook_system_message", … }) } }
//
// and its embedded docs say "systemMessage — Display a message to the user (all
// hooks)". Both fields may ride the same envelope, so one document can carry context
// for the model and a notice for the user.
describe('lib/hook-stdout — the human channel', () => {
  beforeEach(() => resetHookStdout());

  it('carries a system message alongside additionalContext in ONE envelope', async () => {
    const { queueHookSystemMessage } = await import('../lib/hook-stdout.mjs');
    const written = [];
    queueHookContext('SessionStart', 'dashboard for the model');
    queueHookSystemMessage('📦 claude-mem-lite: v9.9.9 available');
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(true);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]);
    expect(parsed.systemMessage).toContain('v9.9.9 available');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('dashboard for the model');
  });

  it('emits a systemMessage-only envelope when there is no model context', async () => {
    const { queueHookSystemMessage } = await import('../lib/hook-stdout.mjs');
    const written = [];
    queueHookSystemMessage('just a notice');
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(true);
    const parsed = JSON.parse(written[0]);
    expect(parsed.systemMessage).toBe('just a notice');
    // No hookSpecificOutput at all: Stop's schema rejects that block, and an
    // event-less envelope must not invent one.
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it('still writes nothing when neither channel has anything', async () => {
    const written = [];
    expect(flushHookStdout({ write: (s) => written.push(s) })).toBe(false);
    expect(written).toEqual([]);
  });
});

describe('hook.mjs post-tool-use: co-firing receipts stay one document', () => {
  let tmpHome, projDir, dbPath, env;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mem-1env-'));
    projDir = join(tmpHome, 'work', 'proj');
    mkdirSync(projDir, { recursive: true });
    const dbDir = join(tmpHome, '.claude-mem-lite');
    mkdirSync(join(dbDir, 'runtime'), { recursive: true });
    dbPath = join(dbDir, 'claude-mem-lite.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.close();

    env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
    }
    Object.assign(env, {
      HOME: tmpHome,
      CLAUDE_PROJECT_DIR: projDir,
      CLAUDE_CODE_PATH: join(tmpHome, 'no-such-claude-binary'),
      ANTHROPIC_API_KEY: '',
      OPENROUTER_API_KEY: '',
      CLAUDE_MEM_SKIP_UPDATE: '1',
      CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
      CLAUDE_MEM_SKIP_COMPRESS: '1',
      CLAUDE_MEM_SKIP_OPTIMIZE: '1',
      CLAUDE_MEM_SKIP_MAINTAIN: '1',
      CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
      CLAUDE_MEM_SKIP_REPOS: '1',
      CLAUDE_MEM_NO_DELAY: '1',
      MEM_NO_AUTO_ADOPT: '1',
    });
    // Seed through the CLI so the row goes through the real write path (enrichment,
    // concept extraction, type handling) rather than a hand-built INSERT.
    //
    // Correction to an earlier version of this comment, which claimed the first draft
    // failed because raw SQL leaves observations_fts empty: schema.mjs installs
    // `<table>_ai AFTER INSERT` triggers, so a direct INSERT DOES populate FTS, and
    // the pre-tag reviewer could not reproduce either of the two mechanisms this
    // comment used to name. The first draft's tautology is real and reproduced
    // (pre-fix code, 8/8 green) but its root cause is NOT established — do not trust
    // the old explanation when writing the next fixture. What IS verified is that
    // THIS fixture reaches the two-receipt state: mutating either leg alone
    // (triggerErrorRecall writing its own envelope, or flushEpisode writing its own)
    // turns 2 tests red, so both legs genuinely fire in one process.
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, '../cli.mjs'),
        'save',
        '--type',
        'bugfix',
        '--importance',
        '3',
        '--lesson',
        'Invalidate the widget cache on write, never on read',
        'Fixed the widget cache invalidation race in lib/widget-cache.mjs',
      ],
      { cwd: projDir, env, encoding: 'utf8', timeout: 25000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function postToolUse(payload) {
    try {
      return execFileSync(process.execPath, [HOOK_PATH, 'post-tool-use'], {
        input: JSON.stringify({ cwd: projDir, hook_event_name: 'PostToolUse', ...payload }),
        timeout: 25000,
        encoding: 'utf8',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return e.stdout || '';
    }
  }

  const HARD_ERROR_RESPONSE =
    'FAIL widget-cache.test.mjs\nError: widget cache invalidation race detected\n' +
    'npm ERR! Test failed. See above for more details.';

  /**
   * Fill the episode buffer to EPISODE_BUFFER_SIZE so the NEXT PostToolUse both
   * flushes a receipt and — being a hard error — triggers recall, which is the
   * only state in which two envelopes were written from one process.
   */
  function fillEpisodeBuffer(sessionId, n = 10) {
    for (let i = 0; i < n; i++) {
      postToolUse({
        session_id: sessionId,
        tool_name: 'Edit',
        tool_input: {
          file_path: join(projDir, `f${i}.js`),
          old_string: 'readPath()',
          new_string: 'writePath()',
        },
        tool_response: 'The file has been updated successfully with the new content applied.',
      });
    }
  }

  it('a hard error alone already delivers a parseable recall envelope (fixture control)', () => {
    const stdout = postToolUse({
      session_id: 'cc-1env-ctl',
      tool_name: 'Bash',
      tool_input: { command: 'node --test widget-cache.test.mjs' },
      tool_response: HARD_ERROR_RESPONSE,
    });
    // If this is empty the co-fire tests below would be vacuous.
    expect(stdout.trim(), 'error-recall produced nothing — the fixture is not exercising the path').not.toBe(
      '',
    );
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Related memories found for this error');
  });

  it('emits ONE JSON document when an error recall and an episode flush co-fire', () => {
    fillEpisodeBuffer('cc-1env-a');
    const stdout = postToolUse({
      session_id: 'cc-1env-a',
      tool_name: 'Bash',
      tool_input: { command: 'node --test widget-cache.test.mjs' },
      tool_response: HARD_ERROR_RESPONSE,
    });
    const trimmed = stdout.trim();
    expect(trimmed, 'expected at least the recall receipt').not.toBe('');
    // Pre-fix: two envelopes ⇒ JSON.parse throws ⇒ plainText ⇒ PostToolUse
    // renders nothing, so BOTH receipts are lost.
    expect(() => JSON.parse(trimmed)).not.toThrow();
    const parsed = JSON.parse(trimmed);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    // Both contributions survive the merge.
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Related memories found for this error');
    expect(ctx).toContain('episode flushed');
  });

  it('never puts more than one JSON-looking line on stdout', () => {
    fillEpisodeBuffer('cc-1env-b');
    const stdout = postToolUse({
      session_id: 'cc-1env-b',
      tool_name: 'Bash',
      tool_input: { command: 'node --test widget-cache.test.mjs' },
      tool_response: HARD_ERROR_RESPONSE,
    });
    const jsonLines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(jsonLines).toHaveLength(1);
  });
});
