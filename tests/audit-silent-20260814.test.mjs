// Regression pins for the "silent loss" half of the 2026-08-14 audit batch — the
// defects whose whole signature is that NOTHING reports them: exit 0, empty stdout,
// a green doctor, and the data gone or the wrong data served.
//
// One describe per finding, named B1..B6 after the audit report:
//   B1  a DB that will not open destroys the session's episode buffer, silently (HIGH)
//   B2  recall served superseded lessons AND re-promoted them (HIGH)
//   B3  npm/settings.json installs never registered PreCompact (MED)
//   B6  scripts/post-tool-recall.js was shipped + signed but wired into no registry (MED)
//
// B2's closing clause ("check whether any OTHER retrieval path regressed too") was swept
// wrongly the first time; the re-sweep found two more, pinned here under the checker's
// labels:
//   F1  PostToolUse error-recall injected the RETRACTED lesson, inlined, as the top hit (HIGH)
//   F4  the next session's handoff replayed a retracted decision as a standing one (LOW-MED)
//
// Every case states, in a comment, the input that makes it fail — an assertion whose
// failing input nobody can name is not a test.
//
// ISOLATION: every spawned process gets CLAUDE_MEM_DIR + HOME pointed at a mkdtemp
// sandbox, and a cwd inside it, so nothing can reach the live ~/.claude-mem-lite DB or
// write into this repo. The sandbox is removed in an afterAll `finally`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  rmSync,
} from 'fs';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createTestDb, insertSession, insertObs } from './test-helpers.mjs';
import { recallByFile } from '../lib/recall-core.mjs';
import { buildAndSaveHandoff, renderHandoffInjection } from '../hook-handoff.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO, 'cli.mjs');
const INSTALL_PATH = join(REPO, 'install.mjs');
const HOOK_PATH = join(REPO, 'hook.mjs');

// ─── Sandbox shared by the subprocess-driven cases ─────────────────────────────────

let ROOT, HOME_DIR, BASE_ENV;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-silent0814-'));
  HOME_DIR = join(ROOT, 'home');
  mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });

  BASE_ENV = { ...process.env };
  // The developer's own plugin flags would otherwise flip default-OFF surfaces on in the
  // child (the #8608 leak class). Everything needed is set explicitly below.
  for (const k of Object.keys(BASE_ENV)) {
    if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  }
  Object.assign(BASE_ENV, {
    HOME: HOME_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'), // no LLM spend, no network
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
  });
  delete BASE_ENV.CLAUDE_PROJECT_DIR; // cwd is the only project source
  delete BASE_ENV.PWD;
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300)); // let any detached worker settle
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** A sandbox dir under ROOT (cwd / data dir), created on demand. */
function sandboxDir(...parts) {
  const d = join(ROOT, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

function fire(cmd, args, { cwd, stdin = '', env = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...BASE_ENV, ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} did not exit within ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // a hook that returns before reading stdin: EPIPE is fine
    child.stdin.end(stdin);
  });
}

// ─── B2 — recall served retracted lessons and pushed them back up the decay system ──
// lib/recall-core.mjs filtered `compressed_into` but not `superseded_at`, so a lesson a
// later save explicitly overturned (`--supersedes N`) was still returned by `recall
// <file>` / `mem_recall` — one of the tools the project CLAUDE.md points agents at
// before an Edit — AND the same rows then took an access_count bump, re-promoting the
// retracted row in the tier/decay system. Every sibling read path (search-engine,
// recent-core, search-core, timeline-core, hook-memory, pre-tool-recall) already
// filtered it; recall was the sole outlier.

describe('B2 — recall does not serve, or re-promote, a superseded observation', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: 'sess-b2', project: 'test' });
  });
  afterEach(() => db.close());

  /** A retracted row and its replacement, both linked to the same file. */
  function seedSupersededPair() {
    const stale = insertObs(db, {
      sessionId: 'sess-b2',
      type: 'bugfix',
      importance: 3,
      epochOffset: -60000,
      title: 'retry backoff must reset per hop',
      lessonLearned: 'Reset the backoff on every redirect hop',
      filesModified: '["/repo/src/transport.mjs"]',
      supersededAt: Date.now(),
      supersededBy: 999,
    });
    const live = insertObs(db, {
      sessionId: 'sess-b2',
      type: 'bugfix',
      importance: 3,
      title: 'retry backoff must persist across hops',
      lessonLearned: 'Carry the backoff across redirect hops, never reset it',
      filesModified: '["/repo/src/transport.mjs"]',
    });
    return { staleId: Number(stale.lastInsertRowid), liveId: Number(live.lastInsertRowid) };
  }

  // FAILS IF: the `superseded_at IS NULL` clause is dropped from recall-core's WHERE —
  // both rows come back and the retracted lesson leads the list (it is the same file, and
  // only the ORDER BY separates them).
  it('returns the replacement only, never the retracted row', () => {
    const { staleId, liveId } = seedSupersededPair();
    const { rows } = recallByFile(db, '/repo/src/transport.mjs');
    expect(rows.map((r) => r.id)).toEqual([liveId]);
    expect(rows.map((r) => r.lesson_learned).join('\n')).not.toContain(
      'Reset the backoff on every redirect hop',
    );

    // The single-row result above is only evidence of FILTERING if the file really had two
    // candidate rows to filter, one of them tombstoned. `staleId !== liveId` used to stand
    // here and could not fail — both come from sequential lastInsertRowid.
    // FAILS IF: the fixture stops posing the question — the stale row loses its
    // filesModified link (the junction query returns one row), or its supersededAt /
    // the live row's null superseded_at drifts.
    const linked = db
      .prepare(
        `
      SELECT o.id, o.superseded_at FROM observations o
      JOIN observation_files f ON f.obs_id = o.id
      WHERE f.filename = ? ORDER BY o.id
    `,
      )
      .all('/repo/src/transport.mjs');
    expect(linked.map((r) => r.id)).toEqual([staleId, liveId]);
    expect(linked.find((r) => r.id === staleId).superseded_at).toBeTruthy();
    expect(linked.find((r) => r.id === liveId).superseded_at).toBeNull();
  });

  // The second half of the defect: lines 37-38 bump access_count over exactly the rows the
  // SELECT returned, so an unfiltered SELECT also re-promoted the tombstone in the decay /
  // tier system. The live row's bump is asserted alongside, so "nothing was bumped" cannot
  // satisfy this case.
  // FAILS IF: the filter is dropped (stale.access_count becomes 1), or the bump is moved
  // ahead of the filter / applied to a wider id set.
  it('leaves the retracted row cold while the replacement is warmed', () => {
    const { staleId, liveId } = seedSupersededPair();
    recallByFile(db, 'transport.mjs');
    const read = (id) =>
      db.prepare('SELECT access_count, last_accessed_at FROM observations WHERE id = ?').get(id);
    expect(read(staleId).access_count || 0).toBe(0);
    expect(read(staleId).last_accessed_at).toBeNull();
    expect(read(liveId).access_count).toBe(1);
    expect(read(liveId).last_accessed_at).toBeGreaterThan(0);
  });

  // includeNoise is the only documented escape hatch on this query and it is about
  // LOW_SIGNAL titles, not about retraction — a caller asking for noise must still not get
  // tombstones.
  // FAILS IF: the filter is applied only on the default (noiseClause) branch.
  it('includeNoise still excludes the retracted row', () => {
    const { liveId } = seedSupersededPair();
    const { rows } = recallByFile(db, 'transport.mjs', { includeNoise: true });
    expect(rows.map((r) => r.id)).toEqual([liveId]);
  });

  // Surface proof, end to end through the real CLI (`recall` renders recall-core's rows):
  // save a lesson, retract it with a second save, and read the file back.
  // FAILS IF: recall-core stops filtering — the retracted lesson text reappears in the
  // rendered output that an agent would read before editing that file.
  it('CLI recall prints the replacement lesson and not the retracted one', async () => {
    const dataDir = sandboxDir('data-b2');
    const cwd = sandboxDir('work', 'b2');
    const target = join(cwd, 'transport.mjs');
    writeFileSync(target, 'export const transport = 1;\n');
    const run = (args) =>
      fire(process.execPath, [CLI_PATH, ...args], { cwd, env: { CLAUDE_MEM_DIR: dataDir } });

    const first = await run([
      'save',
      'Traced the redirect backoff reset to every hop of the chain',
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--files',
      target,
      '--lesson',
      'RETRACTED reset the backoff on every redirect hop',
    ]);
    expect(first.code, first.stderr).toBe(0);
    const staleId = Number(first.stdout.match(/#(\d+)/)[1]);

    const second = await run([
      'save',
      'Corrected the redirect backoff rule after re-reading the RFC',
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--files',
      target,
      '--lesson',
      'CURRENT carry the backoff across redirect hops',
      '--supersedes',
      String(staleId),
    ]);
    expect(second.code, second.stderr).toBe(0);

    // The retraction really landed — otherwise this case would pass on a store where the
    // stale row was simply never marked.
    const raw = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    try {
      expect(
        raw.prepare('SELECT superseded_at FROM observations WHERE id = ?').get(staleId).superseded_at,
      ).toBeTruthy();
    } finally {
      raw.close();
    }

    const recalled = await run(['recall', target]);
    expect(recalled.code, recalled.stderr).toBe(0);
    expect(recalled.stdout).toContain('CURRENT carry the backoff across redirect hops');
    expect(recalled.stdout, 'a retracted lesson must not be served as current').not.toContain(
      'RETRACTED reset the backoff on every redirect hop',
    );
  }, 60000);
});

// ─── B3 — the npm/settings.json install never registered PreCompact ────────────────
// hooks/hooks.json (the plugin-manifest registry) declares six events; install.mjs's
// `hookConfigs` map declared five — PreCompact was missing. A settings.json install
// therefore never fired `hook.mjs pre-compact`, so the memory block that exists to
// survive compaction was silently absent, and `doctor` still printed "All critical
// checks passed" (it tests presence-of-any-mem-hook and file existence, never
// event-set completeness). The guard below diffs the two registries by what each
// ACTUALLY produces — a real `install --dev` run's settings.json against the shipped
// hooks.json — so neither can be edited into agreement on its own.

/**
 * Run a real `install.mjs install --dev` into the sandbox once per file and return what
 * it produced: the generated settings.json hooks, the shipped manifest hooks, and the
 * paths the install used. `--dev` symlinks this repo instead of running npm install, so
 * the run is offline; a no-op `claude` shim on PATH keeps registerMcpServer() from
 * reaching the developer's real CLI, and HOME/CLAUDE_MEM_DIR/cwd all point into the
 * sandbox. Memoized: B3 and B6 both read the same produced artifact.
 */
let _installPromise = null;
function installedRegistries() {
  if (_installPromise) return _installPromise;
  _installPromise = (async () => {
    const { isMemHook } = await import('../install.mjs');
    const installHome = sandboxDir('inst-home');
    const dataDir = sandboxDir('inst-data');
    const cwd = sandboxDir('work', 'inst');
    mkdirSync(join(installHome, '.claude'), { recursive: true });

    const binDir = sandboxDir('inst-bin');
    const shim = join(binDir, 'claude');
    writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    chmodSync(shim, 0o755);

    const out = await fire(process.execPath, [INSTALL_PATH, 'install', '--dev'], {
      cwd,
      env: {
        HOME: installHome,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_REPOS: '1',
        PATH: `${binDir}:${process.env.PATH}`,
      },
      timeout: 120000,
    });
    expect(out.code, `install failed:\n${out.stdout}\n${out.stderr}`).toBe(0);

    return {
      isMemHook,
      installOut: out,
      installHome,
      dataDir,
      cwd,
      settingsHooks: JSON.parse(readFileSync(join(installHome, '.claude', 'settings.json'), 'utf8')).hooks,
      manifestHooks: JSON.parse(readFileSync(join(REPO, 'hooks', 'hooks.json'), 'utf8')).hooks,
    };
  })();
  return _installPromise;
}

/**
 * Reduce a hook command to the entry it invokes, dropping the interpreter and the
 * install-shape-specific absolute path / ${CLAUDE_PLUGIN_ROOT} prefix:
 *   node "<any>/scripts/hook-launcher.mjs" hook.mjs session-start → "hook.mjs session-start"
 *   bash "<any>/scripts/post-tool-use.sh"                        → "scripts/post-tool-use.sh"
 */
function entryToken(command) {
  const unpathed = String(command)
    .replace(/"[^"]*\/(scripts\/[^"]+)"/g, '$1')
    .replace(/"[^"]*\/([^/"]+)"/g, '$1');
  return unpathed
    .split(/\s+/)
    .filter((t) => t && t !== 'node' && t !== 'bash' && t !== 'scripts/hook-launcher.mjs')
    .join(' ');
}

describe('B3 — install.mjs and hooks/hooks.json register the same hook events', () => {
  let settingsHooks, manifestHooks, isMemHook;
  let dataDir, cwd, installOut;

  /** event → sorted "matcher :: entry" strings, for the mem-owned configs only. */
  function registryShape(hooks) {
    const shape = {};
    for (const [event, configs] of Object.entries(hooks || {})) {
      const rows = (configs || [])
        .filter((cfg) => isMemHook(cfg))
        .flatMap((cfg) => (cfg.hooks || []).map((h) => `${cfg.matcher} :: ${entryToken(h.command)}`));
      if (rows.length > 0) shape[event] = rows.sort();
    }
    return shape;
  }

  // scripts/setup.sh bootstraps the PLUGIN CACHE (node_modules symlink, stale-MCP
  // cleanup) — a directory that only exists in a plugin install. install.mjs does that
  // work itself at install time, so this one entry is legitimately manifest-only. The
  // assertion below pins the divergence to exactly this, so any NEW divergence reds.
  const PLUGIN_ONLY = ['startup|clear|compact :: scripts/setup.sh'];

  let installHome;
  beforeAll(async () => {
    ({ isMemHook, settingsHooks, manifestHooks, installOut, installHome, dataDir, cwd } =
      await installedRegistries());
  }, 180000);

  // FAILS IF: either registry gains or loses an event the other has — e.g. deleting
  // `PreCompact` from install.mjs's hookConfigs (the original defect) reds with
  // ['PostToolUse','PreToolUse','SessionStart','Stop','UserPromptSubmit'] against the
  // manifest's six.
  it('both registries cover the same event set', () => {
    const installEvents = Object.keys(registryShape(settingsHooks)).sort();
    const manifestEvents = Object.keys(registryShape(manifestHooks)).sort();
    expect(
      installEvents.length,
      `no mem hooks in the generated settings.json:\n${installOut.stdout}`,
    ).toBeGreaterThan(5);
    expect(installEvents).toEqual(manifestEvents);
    expect(installEvents).toContain('PreCompact');
  });

  // Event keys alone would not catch "registered the event but pointed it at nothing" or
  // a script wired into one registry only (the B6 class). Both sides here are read from
  // real artifacts — a generated settings.json and the shipped manifest.
  // FAILS IF: an entry is added to one registry only, or a matcher drifts (e.g. wiring
  // post-tool-recall.js into hooks.json but not install.mjs).
  it('both registries invoke the same entries under the same matchers', () => {
    const installShape = registryShape(settingsHooks);
    const manifestShape = registryShape(manifestHooks);
    for (const event of Object.keys(manifestShape)) {
      const manifestRows = manifestShape[event].filter((r) => !PLUGIN_ONLY.includes(r));
      expect(installShape[event], `${event} missing from the settings.json install`).toEqual(manifestRows);
    }
    // …and the exclusion really is only that one bootstrap line.
    const excluded = Object.values(manifestShape)
      .flat()
      .filter((r) => PLUGIN_ONLY.includes(r));
    expect(excluded).toEqual(PLUGIN_ONLY);
  });

  // Registration is only half the claim: run the command string the installer actually
  // wrote, exactly as Claude Code would, and check the block comes out.
  // FAILS IF: the registered PreCompact command points at a wrong path/subcommand, or
  // the entry is absent (the lookup below finds nothing and reds before spawning).
  it('the registered PreCompact command emits the memory block it exists to preserve', async () => {
    const seeded = await fire(
      process.execPath,
      [
        CLI_PATH,
        'save',
        'Traced the compaction memory loss to the missing PreCompact registration',
        '--type',
        'discovery',
        '--importance',
        '3',
        '--lesson',
        'Compaction drops context unless PreCompact re-emits it',
      ],
      { cwd, env: { CLAUDE_MEM_DIR: dataDir } },
    );
    expect(seeded.code, seeded.stderr).toBe(0);

    const command = (settingsHooks.PreCompact || [])
      .flatMap((cfg) => (cfg.hooks || []).map((h) => h.command))
      .find((c) => /pre-compact/.test(c));
    expect(
      command,
      `no PreCompact command in the generated settings.json: ${JSON.stringify(settingsHooks.PreCompact)}`,
    ).toBeTruthy();

    const r = await fire('/bin/sh', ['-c', command], {
      cwd,
      stdin: JSON.stringify({ session_id: 'cc-b3-precompact', trigger: 'auto' }),
      env: { HOME: installHome, CLAUDE_MEM_DIR: dataDir },
    });
    expect(r.code, `registered PreCompact command exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(r.stdout.startsWith('<claude-mem-context>'), `stdout was:\n${r.stdout}`).toBe(true);
    // The rendered table truncates long titles, so match the head of the seeded row.
    expect(r.stdout).toContain('Traced the compaction memory loss to the missing');
  }, 60000);
});

// ─── B6 — a shipped, signed, tested hook script was wired into no registry ─────────
// scripts/post-tool-recall.js is listed in package.json's `files`, signed via
// source-files.mjs, installed by copyHookScripts, and covered by two test files — but it
// had ZERO hits in hooks/hooks.json and install.mjs. The only thing that invoked it was
// benchmark/efficacy-harness.mjs. It is component 2 of the bind-salience forcing function
// (component 1 = the pre-edit directive from scripts/pre-tool-recall.js), so a user who
// set CLAUDE_MEM_SALIENCE=bind got component 1 and, silently, nothing else: the post-edit
// "you dropped the identifier the lesson named" nudge could not fire in production at all.
// It is opt-in, so the default path must stay silent — that half is asserted here too,
// and tests/feature-sweep-hooks.test.mjs pins it independently at the script level.

describe('B6 — post-tool-recall is registered, and inert unless CLAUDE_MEM_SALIENCE=bind', () => {
  let settingsHooks, manifestHooks, isMemHook, installHome, dataDir;
  const SESSION = 'cc-b6-bind';
  let cwd, target;

  beforeAll(async () => {
    ({ isMemHook, settingsHooks, manifestHooks, installHome, dataDir } = await installedRegistries());
    cwd = sandboxDir('work', 'b6');
    target = join(cwd, 'widget-cache.mjs');
  }, 180000);

  /** The registered command string for `entry`, from a produced registry. */
  function registeredCommand(hooks, event, entry) {
    return (hooks[event] || [])
      .filter((cfg) => isMemHook(cfg))
      .flatMap((cfg) => (cfg.hooks || []).map((h) => ({ matcher: cfg.matcher, command: h.command })))
      .find((h) => entryToken(h.command) === entry);
  }

  // FAILS IF: the script is dropped from either registry (this is the pre-fix state:
  // `find` returns undefined on both sides), or wired under a matcher that never fires on
  // an edit.
  it('is registered as a PostToolUse hook in BOTH registries, on the edit tools', () => {
    for (const [label, hooks] of [
      ['hooks/hooks.json', manifestHooks],
      ['settings.json install', settingsHooks],
    ]) {
      const hit = registeredCommand(hooks, 'PostToolUse', 'scripts/post-tool-recall.js');
      expect(
        hit,
        `${label} does not register scripts/post-tool-recall.js:\n${JSON.stringify(hooks.PostToolUse)}`,
      ).toBeTruthy();
      // The pre-edit half is matched on Edit|Write|NotebookEdit|Read; the post-edit half
      // only makes sense where an edit happened, so Read is deliberately absent.
      expect(hit.matcher, `${label} matcher`).toBe('Edit|Write|NotebookEdit');
    }
  });

  // The functional claim: driven through the command strings the INSTALLER wrote (not a
  // hand-built `node scripts/…` invocation), the bind pair now works end to end in the
  // shape production runs it.
  // FAILS IF: the registered command points at a wrong path or entry — the launcher exits
  // without emitting, so the envelope assertion reds.
  it('the registered command emits the post-edit nudge under bind salience', async () => {
    writeFileSync(target, 'export function writeWidget() {\n  invalidateWidgetCache();\n}\n');
    const saved = await fire(
      process.execPath,
      [
        CLI_PATH,
        'save',
        'Fixed the widget cache invalidation race',
        '--type',
        'bugfix',
        '--importance',
        '3',
        '--files',
        target,
        '--lesson',
        'Always call invalidateWidgetCache after a write, never on read',
      ],
      { cwd, env: { CLAUDE_MEM_DIR: dataDir } },
    );
    expect(saved.code, saved.stderr).toBe(0);
    const id = Number(saved.stdout.match(/#(\d+)/)[1]);

    const stdin = JSON.stringify({
      session_id: SESSION,
      tool_name: 'Edit',
      tool_input: { file_path: target, old_string: 'invalidateWidgetCache()', new_string: 'noop()' },
    });
    const bindEnv = { HOME: installHome, CLAUDE_MEM_DIR: dataDir, CLAUDE_MEM_SALIENCE: 'bind' };

    // Component 1 records which identifiers the lesson names AND the file still has.
    const preCmd = registeredCommand(settingsHooks, 'PreToolUse', 'scripts/pre-tool-recall.js');
    const pre = await fire('/bin/sh', ['-c', preCmd.command], { cwd, stdin, env: bindEnv });
    expect(pre.code, pre.stderr).toBe(0);

    // Now make the edit the lesson warns about: the flagged identifier is gone.
    writeFileSync(target, 'export function writeWidget() {\n  noop();\n}\n');

    const postCmd = registeredCommand(settingsHooks, 'PostToolUse', 'scripts/post-tool-recall.js');
    const post = await fire('/bin/sh', ['-c', postCmd.command], { cwd, stdin, env: bindEnv });
    expect(post.code, `post-tool-recall exited ${post.code}\n${post.stderr}`).toBe(0);
    const envelope = JSON.parse(post.stdout.trim());
    expect(envelope.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(envelope.hookSpecificOutput.additionalContext).toContain('dropped `invalidateWidgetCache`');
    expect(envelope.hookSpecificOutput.additionalContext).toContain(`#${id}`);
  }, 60000);

  // Wiring an opt-in surface into the default hook chain must not make the default noisy.
  // Runs AFTER the bind case, so the cooldown state that WOULD produce a nudge is present
  // — silence here is the salience gate, not an empty fixture.
  // FAILS IF: the CLAUDE_MEM_SALIENCE gate at the top of post-tool-recall.js is removed —
  // the same stdin then emits the same envelope with no env var set.
  it('the registered command stays silent at default salience', async () => {
    const stdin = JSON.stringify({
      session_id: SESSION,
      tool_name: 'Edit',
      tool_input: { file_path: target, old_string: 'invalidateWidgetCache()', new_string: 'noop()' },
    });
    const postCmd = registeredCommand(settingsHooks, 'PostToolUse', 'scripts/post-tool-recall.js');
    const off = await fire('/bin/sh', ['-c', postCmd.command], {
      cwd,
      stdin,
      env: { HOME: installHome, CLAUDE_MEM_DIR: dataDir },
    });
    expect(off.code, off.stderr).toBe(0);
    expect(off.stdout, 'an opt-in surface must add nothing to the default hook chain').toBe('');
  }, 60000);
});

// ─── B1 — a DB that will not open destroyed the session's captured work ────────────
// hook-shared.mjs's openDb() swallowed EVERY failure and returned null with zero
// telemetry (8 call sites in hook.mjs share it). Handlers then no-op'd — but
// flushEpisode's `unlinkSync(episodeFile())` ran unconditionally at the tail, so the
// buffered episode was deleted anyway. All three self-checks stayed green: nothing was
// written to runtime/hook-errors/, so `stats` reported 0 and install.mjs's doctor printed
// "Hook self-heal: no recent silent hook breakage". The hook must still never crash the
// host session — exit 0 and silence on stdout are preserved; what changes is that the
// failure is RECORDED and the buffer SURVIVES for the next run.

describe('B1 — an unopenable DB is recorded, and does not destroy the episode buffer', () => {
  let dataDir, cwd, project, runtimeDir;

  const post = (payload) =>
    fire(process.execPath, [HOOK_PATH, 'post-tool-use'], {
      cwd,
      stdin: JSON.stringify(payload),
      env: { CLAUDE_MEM_DIR: dataDir },
    });
  const stop = () =>
    fire(process.execPath, [HOOK_PATH, 'stop'], {
      cwd,
      stdin: JSON.stringify({ session_id: 'cc-b1' }),
      env: { CLAUDE_MEM_DIR: dataDir },
    });

  const episodeFile = () => join(runtimeDir, `ep-${project}.json`);
  const hookErrorRecords = () => {
    const dir = join(runtimeDir, 'hook-errors');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) =>
        readFileSync(join(dir, f), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      );
  };

  /**
   * Two buffered entries, below the 10-entry auto-flush threshold. The `db-schema.sql`
   * Write carries rule importance 2 via the filename heuristic, so on a HEALTHY DB the
   * flush leaves a durable row instead of being dropped as auto-capture noise — that is
   * what makes the counter-case below able to distinguish "persisted" from "no-op'd".
   */
  async function bufferTwoEntries() {
    const payloads = [
      {
        session_id: 'cc-b1',
        tool_name: 'Write',
        tool_input: {
          file_path: join(cwd, 'db-schema.sql'),
          content: 'CREATE TABLE widgets (id INTEGER);\n',
        },
        tool_response: `File created successfully at: ${join(cwd, 'db-schema.sql')}`,
      },
      {
        session_id: 'cc-b1',
        tool_name: 'Edit',
        tool_input: { file_path: join(cwd, 'widget-cache.mjs'), old_string: 'a', new_string: 'b' },
        tool_response: 'The file has been updated successfully with the new content applied.',
      },
    ];
    for (const p of payloads) {
      const r = await post(p);
      expect(r.code, `post-tool-use exited ${r.code}\n${r.stderr}`).toBe(0);
    }
  }

  function makeSandbox(slug) {
    dataDir = sandboxDir('data-' + slug);
    cwd = sandboxDir('work', slug);
    project = 'work--' + slug;
    runtimeDir = join(dataDir, 'runtime');
  }

  /** Replace the DB file with a DIRECTORY: every open fails with SQLITE_CANTOPEN. */
  function breakDb() {
    const dbPath = join(dataDir, 'claude-mem-lite.db');
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
    mkdirSync(dbPath, { recursive: true });
  }

  // FAILS IF: flushEpisode goes back to unlinking the buffer regardless of whether the
  // flush could persist anything — the file is gone and the two captured entries with it.
  it('keeps the buffered episode when the DB cannot be opened', async () => {
    makeSandbox('b1broken');
    breakDb();
    await bufferTwoEntries();
    const buffered = JSON.parse(readFileSync(episodeFile(), 'utf8'));
    expect(buffered.entries, 'the buffer must exist before Stop, else this proves nothing').toHaveLength(2);

    const r = await stop();
    expect(r.code, `stop exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(r.stdout, 'a broken DB must not put anything on the host-visible channel').toBe('');
    expect(r.stderr).not.toMatch(/SQLITE_CANTOPEN|at Object\.<anonymous>/);

    expect(existsSync(episodeFile()), 'the episode buffer was destroyed by a flush that saved nothing').toBe(
      true,
    );
    expect(JSON.parse(readFileSync(episodeFile(), 'utf8')).entries).toHaveLength(2);
  }, 60000);

  // FAILS IF: openDb() reverts to `catch { return null; }` — hook-errors/ is never created,
  // countRecentHookErrors stays 0 and doctor keeps printing "no recent silent hook breakage".
  it('records the db-open failure in the unsampled hook-error log', async () => {
    makeSandbox('b1telem');
    breakDb();
    await bufferTwoEntries();
    await stop();

    const records = hookErrorRecords();
    const dbOpen = records.filter((x) => /db-open/.test(x.scope));
    expect(dbOpen.length, `no db-open record was written:\n${JSON.stringify(records)}`).toBeGreaterThan(0);
    expect(dbOpen[0].msg, 'the record must name the failure, else it is unactionable').toMatch(
      /unable to open|SQLITE_CANTOPEN|directory/i,
    );
  }, 60000);

  // The counter-case, and the reason neither assertion above can be satisfied by "never
  // delete the buffer" or "always record": on a HEALTHY DB the same sequence must still
  // consume the buffer, persist the work, and write no db-open record.
  // FAILS IF: the fix short-circuits flushEpisode (buffer never consumed / nothing saved)
  // or records unconditionally.
  it('a healthy DB still consumes the buffer, saves the work, and logs nothing', async () => {
    makeSandbox('b1healthy');
    await bufferTwoEntries();
    expect(existsSync(episodeFile())).toBe(true);

    const r = await stop();
    expect(r.code, `stop exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(existsSync(episodeFile()), 'a successful flush must still remove the buffer').toBe(false);

    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM observations').get();
      expect(row.c, 'the flush persisted nothing').toBeGreaterThan(0);
    } finally {
      db.close();
    }

    expect(hookErrorRecords().filter((x) => /db-open/.test(x.scope))).toEqual([]);
  }, 60000);
});

// ─── F1 — error-recall injected the retracted lesson, inlined, as the top hit ──────
// hook.mjs::triggerErrorRecall is a LIVE model-context surface: on a hard Bash failure it
// writes a PostToolUse `additionalContext` envelope, and formatErrorRecallHints inlines the
// lesson BODY of rows[0]. Its SELECT filtered low-signal titles but neither
// `superseded_at IS NULL` nor `compressed_into` — so a lesson a later save explicitly
// retracted could lead the block and be handed to the model verbatim, while the correction
// that replaced it trailed as a bare `#ID` pointer. Every sibling model-facing retrieval
// path (hook-context obsPool/fallbackObs/keyObs, hook-memory ×4, search-engine's FTS +
// vector legs, recent/search/timeline/recall-core, pre-tool-recall, user-prompt-search)
// already filters BOTH columns; error-recall was the outlier that the first B2 sweep missed.
//
// `compressed_into` is included in the fix, not just `superseded_at`, for two reasons:
// (a) it is half of the same live-row invariant every sibling applies, and (b) the block's
// own footer is `→ Use mem_get(ids=[…])`, so a COMPRESSED_PENDING_PURGE row (decay-marked,
// queued for deletion by `maintain purge_stale`) yields a pointer that resolves to nothing.

describe('F1 — PostToolUse error-recall serves neither retracted nor compressed rows', () => {
  const HARD_FAIL = {
    command: 'quicksilver migrate --compaction-flag',
    response:
      'Error: quicksilver migration failed\n' +
      'TypeError: compaction segment is undefined\n' +
      '    at migrateQuicksilver (/srv/app/migrate.mjs:88:11)\n',
  };

  /**
   * A fresh sandbox seeded through the real CLI, then fired at the real hook.
   * `mark` optionally rewrites the first row's tombstone columns directly (the
   * compressed-original case has no CLI verb).
   */
  async function seedAndFire(slug, { supersede = false, mark = null } = {}) {
    const dataDir = sandboxDir('data-' + slug);
    const cwd = sandboxDir('work', slug);
    const run = (args) =>
      fire(process.execPath, [CLI_PATH, ...args], { cwd, env: { CLAUDE_MEM_DIR: dataDir } });

    const first = await run([
      'save',
      'The quicksilver migration kept failing on the compaction segment',
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      'RETRACTED-ADVICE run quicksilver migrate with the compaction flag disabled',
    ]);
    expect(first.code, first.stderr).toBe(0);
    const staleId = Number(first.stdout.match(/#(\d+)/)[1]);

    const secondArgs = [
      'save',
      'Re-tested quicksilver: the compaction flag was never the migration failure cause',
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      'CURRENT-ADVICE leave the compaction flag on; the migration failure was a stale segment index',
    ];
    if (supersede) secondArgs.push('--supersedes', String(staleId));
    const second = await run(secondArgs);
    expect(second.code, second.stderr).toBe(0);
    const liveId = Number(second.stdout.match(/#(\d+)/)[1]);

    const dbPath = join(dataDir, 'claude-mem-lite.db');
    const raw = new Database(dbPath);
    try {
      if (mark) raw.prepare(`UPDATE observations SET ${mark.col} = ? WHERE id = ?`).run(mark.value, staleId);
      // The tombstone really landed — otherwise the case would pass on a store where the
      // stale row was simply never marked, proving nothing.
      const col = mark ? mark.col : 'superseded_at';
      expect(
        raw.prepare(`SELECT ${col} AS v FROM observations WHERE id = ?`).get(staleId).v,
        `${col} was not set on the stale row`,
      ).toBeTruthy();
    } finally {
      raw.close();
    }

    const r = await fire(process.execPath, [HOOK_PATH, 'post-tool-use'], {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-' + slug,
        tool_name: 'Bash',
        tool_input: { command: HARD_FAIL.command },
        tool_response: HARD_FAIL.response,
      }),
      env: { CLAUDE_MEM_DIR: dataDir },
    });
    expect(r.code, `post-tool-use exited ${r.code}\n${r.stderr}`).toBe(0);

    // stdout is one JSON envelope per line (episode receipt + error-recall each parse alone).
    const block = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .map((e) => e?.hookSpecificOutput?.additionalContext)
      .find((c) => typeof c === 'string' && c.includes('Related memories found for this error'));
    return { staleId, liveId, block, stdout: r.stdout };
  }

  // FAILS IF: `superseded_at IS NULL` is dropped from triggerErrorRecall's WHERE — the
  // retracted row outranks its own correction on BM25 (it carries the error's keywords in
  // both title and lesson), lands at rows[0], and formatErrorRecallHints inlines exactly
  // the advice that was withdrawn.
  it('a retracted lesson reaches neither the inlined slot nor the pointer list', async () => {
    const { staleId, liveId, block, stdout } = await seedAndFire('f1sup', { supersede: true });

    // The surface fired at all — "no envelope" must not be able to satisfy this case.
    expect(block, `no error-recall envelope on stdout:\n${stdout}`).toBeTruthy();
    expect(block, 'the replacement lesson must still be inlined for the model').toContain(
      'CURRENT-ADVICE leave the compaction flag on',
    );
    expect(block).toContain(`#${liveId}`);

    expect(block, 'a retracted lesson was injected into the model context verbatim').not.toContain(
      'RETRACTED-ADVICE',
    );
    expect(block, 'the retracted row must not even be offered as a mem_get pointer').not.toContain(
      `#${staleId}`,
    );
  }, 90000);

  // FAILS IF: only `superseded_at` is added and `compressed_into` is left out — the
  // decay-marked original still leads the block and the `→ Use mem_get(ids=[…])` footer
  // points at a row that `maintain execute --ops purge_stale` is about to delete.
  it('a compressed / purge-marked original is not served either', async () => {
    const { staleId, liveId, block, stdout } = await seedAndFire('f1comp', {
      mark: { col: 'compressed_into', value: -2 }, // COMPRESSED_PENDING_PURGE
    });

    expect(block, `no error-recall envelope on stdout:\n${stdout}`).toBeTruthy();
    expect(block).toContain(`#${liveId}`);
    expect(block, 'a row queued for purge must not be handed to the model').not.toContain('RETRACTED-ADVICE');
    expect(block).not.toContain(`#${staleId}`);
  }, 90000);
});

// ─── F4 — the handoff replayed a retracted decision as a standing one ──────────────
// hook-handoff.mjs's key_decisions query filtered compressed_into but not
// superseded_at, so a decision a later save explicitly overturned was written into the
// handoff row and then rendered into the NEXT session's injected block under the
// heading "## Key Decisions" — i.e. presented as standing, current policy. The
// invariant was already applied unevenly inside this one file: the carry-forward
// working_on fallback (:78) filters superseded_at; key_decisions did not.
//
// Deliberately NOT changed: `completed` (:110) and `files_modified` (:168). Those are
// "what happened in this session" — a decision that was later overturned still happened,
// and erasing it from the session's own record would misreport the session. Only
// key_decisions is re-presented to a LATER session as current standing policy. The
// third case below pins that distinction, so the fix cannot be silently widened.

describe('F4 — handoff key_decisions excludes a retracted decision', () => {
  let db;
  const PROJECT = 'test-f4';
  const SESSION = 'sess-f4';

  const RETRACTED = 'Adopt the dual-write ledger for cross-region ordering';
  const CURRENT = 'Reverted to single-writer ordering; the dual-write ledger deadlocked';

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, { id: SESSION, project: PROJECT });
    db.prepare(
      `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
                VALUES (?, ?, ?, datetime('now'), ?)`,
    ).run(SESSION, 'work out the cross-region write ordering', 1, Date.now());

    insertObs(db, {
      sessionId: SESSION,
      project: PROJECT,
      type: 'decision',
      importance: 3,
      epochOffset: -60000,
      title: RETRACTED,
      supersededAt: Date.now(),
      supersededBy: 999,
    });
    insertObs(db, {
      sessionId: SESSION,
      project: PROJECT,
      type: 'decision',
      importance: 3,
      title: CURRENT,
    });
  });
  afterEach(() => db.close());

  const handoffRow = () =>
    db.prepare('SELECT * FROM session_handoffs WHERE project = ? AND type = ?').get(PROJECT, 'exit');

  // FAILS IF: the `superseded_at IS NULL` clause is dropped from the key_decisions
  // SELECT — the retracted decision is stored in the handoff row alongside the one that
  // replaced it, with nothing marking which is which.
  it('the stored handoff row carries the current decision only', () => {
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const row = handoffRow();
    expect(row, 'no handoff row was written — the case would prove nothing').toBeTruthy();
    expect(row.key_decisions, 'the surviving decision must still be handed off').toContain(CURRENT);
    expect(row.key_decisions, 'a retracted decision was handed off as standing policy').not.toContain(
      RETRACTED,
    );
  });

  // The surface half: what the next session's UserPromptSubmit block actually renders.
  // Scoped to the "## Key Decisions" section on purpose — the retracted title legitimately
  // still appears under "## Completed" (the session's history, see the third case), so a
  // whole-block assertion would conflate the two and could only be satisfied by also
  // erasing the history.
  // FAILS IF: the filter is dropped — "## Key Decisions" lists the withdrawn decision as
  // a bullet, indistinguishable from live policy.
  it('the injected handoff block does not render the retracted decision', () => {
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const block = renderHandoffInjection(db, PROJECT, 'cc-f4-next');
    expect(block, 'nothing was injected — the case would prove nothing').toBeTruthy();
    expect(block).toContain('## Key Decisions');
    const section = block.split('## Key Decisions')[1].split(/\n##\s|<\/session-handoff>/)[0];
    expect(section, 'the surviving decision must still be rendered').toContain(CURRENT);
    expect(section, 'a retracted decision was rendered to the next session as standing policy').not.toContain(
      RETRACTED,
    );
  });

  // Scope guard: `completed` is the session's own history, not standing policy, so the
  // overturned decision must STILL appear there. Without this, "filter superseded_at
  // everywhere in this file" would also pass — and would quietly delete work from the
  // record of the session that did it.
  // FAILS IF: the superseded filter is copied onto the `completed` SELECT at :110.
  it('the session history still records the decision that was later overturned', () => {
    buildAndSaveHandoff(db, SESSION, PROJECT, 'exit', null);
    const row = handoffRow();
    expect(row.completed, 'the session did make that decision; its own history must say so').toContain(
      RETRACTED,
    );
    expect(row.completed).toContain(CURRENT);
  });
});
