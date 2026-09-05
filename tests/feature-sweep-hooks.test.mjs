// Feature sweep: every hook entry point of the plugin, fired as a REAL subprocess with a
// synthetic Claude Code stdin payload. No handler is imported and called directly — the
// wiring (argv dispatch, stdin read, stdout envelope, exit code) IS the thing under test.
//
// WHY THIS FILE EXISTS (it does not duplicate the hook tests already here):
//   tests/e2e.test.mjs            — hook.mjs lifecycle, but only the events a past bug
//                                   touched, and never the standalone scripts.
//   tests/pre-tool-recall*.test.mjs / pre-skill-bridge / pre-agent-inject /
//   post-tool-recall / user-prompt-search — one script each, deep on that script's own
//                                   feature (bind mode, file-intel, defang, re-read guard).
//   tests/lifecycle-e2e.test.mjs  — install → adopt → uninstall, not per-event I/O.
//   tests/quiet-hooks.test.mjs    — MEM_QUIET_HOOKS text shaping, in-process.
//   tests/hook-telemetry.test.mjs — the error recorder, in-process.
//   tests/install-hook-scripts.test.mjs / hooks-pretool-whitelist-sync.test.mjs — the
//                                   manifest + matcher literals, no execution.
// None of them answers "does EVERY hook surface still exit 0 and emit a well-formed
// envelope — including on a payload Claude Code should never send but sometimes does?"
// A hook that crashes or prints stray prose degrades the user's session silently: there is
// no error surface, the context just stops arriving. That is this file's only job — one
// case per surface, named after the surface, so a failure names it immediately.
//
// PER-SURFACE STDOUT CONTRACT (asserted by expectHookStdout, per Claude Code's hook I/O
// rules and the shapes tests/e2e.test.mjs + the source comments pin):
//   hook.mjs session-start      EXACTLY ONE JSON envelope (hookEventName SessionStart),
//                               carrying the dashboard, the <claude-mem-context> block and
//                               the update banner in additionalContext. Pre-v3.70 these were
//                               three separate writes; the trailing raw prose made stdout
//                               un-parseable as a JSON document and the host delivered the
//                               whole envelope to the model as literal escaped text with
//                               suppressOutput ignored (tests/session-start-stdout-envelope).
//   hook.mjs post-tool-use      JSON envelope line(s) ONLY (hookEventName PostToolUse).
//                               Plain text here is the shipped `<text>{json}` corruption bug
//                               (MED-3, audit 2026-07-16) — one stray line makes Claude Code's
//                               line-based parser drop the whole receipt.
//   hook.mjs stop               SILENCE. Stop's schema rejects hookSpecificOutput at the root
//                               (v2.33.4), so RECEIPT_EVENTS excludes it.
//   hook.mjs user-prompt        plain text only (<memory-context> blocks).
//   hook.mjs pre-compact        plain <claude-mem-context> only.
//   background workers          SILENCE (spawnBackground gives them stdio:'ignore').
//   PreToolUse scripts          one JSON envelope object (hookEventName PreToolUse).
//   post-tool-recall.js         one JSON envelope object (hookEventName PostToolUse).
//   user-prompt-search.js       plain text only (the UserPromptSubmit injection channel).
//   post-tool-use.sh            SILENCE on its own fast paths AND on a handoff Node buffers
//                               silently (an Edit); on a handoff Node ANSWERS (a hard error)
//                               the PostToolUse envelope lines it emitted, delivered verbatim.
// Every surface additionally gets the four malformed payloads (empty / invalid JSON / valid
// JSON without the required fields / unexpected types): each MUST exit 0, MUST NOT put a
// stack trace on stdout, and MUST still respect its envelope contract.
//
// ISOLATION CONTRACT (all five are load-bearing):
//   1. CLAUDE_MEM_DIR → a mkdtempSync sandbox for EVERY spawned process. vitest.config.mjs
//      sets it to '' for the runner, so a child that inherited it would resolve the LIVE
//      ~/.claude-mem-lite DB. Load-bearing check: every DB assertion opens
//      <sandbox>/claude-mem-lite.db directly — if the override ever leaked, that file would
//      have no `observations` table and the cases would fail loudly rather than pass while
//      reading the real memory store.
//   2. HOME → a sandbox home (second layer: hook-update, the plugin-disabled probe and
//      snapshotDb all resolve homedir()), and cwd → a per-surface sandbox dir. PWD and
//      CLAUDE_PROJECT_DIR are DELETED from the child env: project-utils.mjs:18 resolves
//      CLAUDE_PROJECT_DIR || PWD || process.cwd(), so with both gone the project name each
//      case asserts ("work--hs-…") is derived from the sandbox cwd ALONE. The runner's PWD
//      is this repo, so leaving it set would both hide a cwd leak and file the sweep's rows
//      under the repo's own project.
//   3. No network, no LLM spend. CLAUDE_CODE_PATH points at a path that cannot exist, so
//      haiku-client's CLI mode (its default with no API key) fails fast instead of spawning
//      a real `claude`; the four background workers that exist to CALL the LLM opt in to
//      scripts/mock-claude.mjs instead — a local deterministic stub, still no network.
//      CLAUDE_MEM_SKIP_UPDATE=1 disables the GitHub release check on both the SessionStart
//      banner and the update-check worker.
//   4. Nothing writes into this repo. SessionStart auto-adopts, which writes <cwd>/CLAUDE.md
//      — the `hook.mjs session-start` case asserts that write landed in ITS sandbox dir, and
//      afterAll asserts this repo's own CLAUDE.md is byte-identical.
//   5. afterAll removes the sandbox in a `finally` (so a failing assertion cannot leak it),
//      after a short grace period for the detached llm-summary worker Stop spawns. The dir
//      prefix is `mem-` so tests/global-setup.mjs reaps it even after a SIGKILL.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { COMPRESSED_PENDING_PURGE } from '../utils.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO, 'hook.mjs');
const CLI_PATH = join(REPO, 'cli.mjs');
const HOOKS_JSON = join(REPO, 'hooks', 'hooks.json');
const MOCK_CLAUDE = join(REPO, 'scripts', 'mock-claude.mjs');
const REPO_CLAUDE_MD = join(REPO, 'CLAUDE.md');

// ─── Coverage-guard sources (both read REAL artifacts, never a second literal) ──────

/** Every event hook.mjs's argv dispatcher can route, read out of its own `switch (event)`. */
function dispatchedEvents() {
  const src = readFileSync(HOOK_PATH, 'utf8');
  const block = src.match(/switch \(event\) \{([\s\S]*?)\n\s*\}\n\} catch/);
  if (!block) throw new Error('hook.mjs dispatch switch not found — the parser needs updating');
  const events = [...block[1].matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1]);
  if (events.length === 0) throw new Error('hook.mjs dispatch switch parsed to zero events');
  return events;
}

/** Every hook entry point hooks/hooks.json registers, as "<entry>[ <arg>]" ids. */
function registeredEntries() {
  const cfg = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const out = new Set();
  for (const matchers of Object.values(cfg.hooks || {})) {
    for (const m of matchers) {
      for (const h of m.hooks || []) {
        const cmd = h.command || '';
        // `node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" <entry> [event]`
        const viaLauncher = cmd.match(/hook-launcher\.mjs"\s+(\S+)(?:\s+(\S+))?/);
        if (viaLauncher) {
          out.add(viaLauncher[2] ? `${viaLauncher[1]} ${viaLauncher[2]}` : viaLauncher[1]);
          continue;
        }
        // `bash "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh"`
        const viaBash = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+\.sh)/);
        if (viaBash) {
          out.add(viaBash[1]);
          continue;
        }
        throw new Error(`unrecognized hook command shape in hooks.json: ${cmd}`);
      }
    }
  }
  return out;
}

// scripts/setup.sh is the ONLY registered entry this sweep does not fire. It is the
// dependency installer: it runs `npm install` and rewrites the runtime dir, so driving it
// here would install packages mid-suite. Its behavior is covered by tests/install-e2e,
// tests/install-lifecycle and tests/native-binding-selfheal.
const UNSWEPT_BY_DESIGN = new Set(['scripts/setup.sh']);
// …and this set is the one hole the other guards cannot see. "every registered entry has a
// case" skips whatever is listed here, so moving a REAL entry into this set and deleting its
// case leaves all three coverage guards green (verified: 21 → 20 cases, no failure) — the
// sweep would just cover less. The size is therefore pinned below: growing the list must be a
// deliberate edit to a number, visible in the diff, with the justification written above.
const UNSWEPT_COUNT = 1;

// ─── Surface registry ──────────────────────────────────────────────────────────────
// Every case registers through itHook, so the coverage guards below compare the REGISTERED
// artifacts against the set of cases really handed to vitest — not against a second
// hand-maintained list, which could be edited into greenness without writing a case.
// Collection runs every describe callback before the first test body, so SWEPT is complete
// by the time any assertion runs.
const SWEPT = new Set();
function itHook(surface, fn, timeout = 60000) {
  if (SWEPT.has(surface)) throw new Error(`duplicate sweep case for "${surface}"`);
  SWEPT.add(surface);
  return it(surface, fn, timeout);
}

// ─── Sandbox ───────────────────────────────────────────────────────────────────────

let ROOT, DATA_DIR, RUNTIME_DIR, HOME_DIR, BASE_ENV, repoClaudeMdSnapshot;

/** A per-surface cwd. inferProject() turns <sandbox>/work/<name> into "work--<name>". */
function workDir(name) {
  const d = join(ROOT, 'work', name);
  mkdirSync(d, { recursive: true });
  return d;
}
const projectOf = (name) => `work--${name}`;

function childEnv(extra = {}) {
  const env = { ...BASE_ENV, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** Fire one entry point as a subprocess, feeding `stdin` and capturing both streams. */
function fire(cmd, args, { cwd, stdin = '', env = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
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
    // A hook that returns before reading stdin closes the pipe first — EPIPE here is the
    // hook doing its job, not a failure.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

const hookEvent = (event, opts = {}) => fire(process.execPath, [HOOK_PATH, ...event.split(' ')], opts);
const hookScript = (name, opts = {}) => fire(process.execPath, [join(REPO, 'scripts', name)], opts);
const bashPrefilter = (opts = {}) => fire('bash', [join(REPO, 'scripts', 'post-tool-use.sh')], opts);
/** Any bash-entry hook, run the way hooks.json registers it (audit P2-5 added a second). */
const bashHook = (name, opts = {}) => fire('bash', [join(REPO, 'scripts', name)], opts);

/** Seed rows through the real CLI (the sweep never hand-writes schema). */
async function cli(args, cwd) {
  const r = await fire(process.execPath, [CLI_PATH, ...args], { cwd });
  expect(r.code, `cli ${args.join(' ')} exited ${r.code}\n${r.stdout}\n${r.stderr}`).toBe(0);
  return r.stdout;
}
async function seedObs(cwd, text, flags = []) {
  const out = await cli(['save', text, ...flags], cwd);
  const m = out.match(/Saved #(\d+)/);
  expect(m, `expected a "Saved #N" confirmation, got: ${out}`).toBeTruthy();
  return Number(m[1]);
}

/** Open the sandbox memory DB for verification independent of the hook's own read path. */
function withDb(fn) {
  const db = new Database(join(DATA_DIR, 'claude-mem-lite.db'));
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}
/** Backdate a project's rows so the age-gated workers (compress / maintain) engage. */
function ageProject(project, days) {
  return withDb((db) => {
    const epoch = Date.now() - days * 86400000;
    return db
      .prepare('UPDATE observations SET created_at_epoch = ?, created_at = ? WHERE project = ?')
      .run(epoch, new Date(epoch).toISOString(), project).changes;
  });
}

// ─── Envelope contract ─────────────────────────────────────────────────────────────

const STACK_TRACE = /^\s+at .+:\d+:\d+|^\w*(?:Type|Reference|Syntax|Range)Error: |^Error: /m;

/**
 * Structural check of one hook fire's stdout.
 *
 * @param {string} out raw stdout
 * @param {object} spec
 *   spec.event        hookEventName every JSON line must carry, or null when this surface
 *                     may not emit a JSON envelope at all.
 *   spec.plainAllowed whether non-JSON lines are a legal channel here. false = any prose is
 *                     the `<text>{json}` corruption class.
 *   spec.label        surface name, for the failure message.
 * @returns {object[]} the parsed envelopes, for content assertions in the caller.
 */
function expectHookStdout(out, { event = null, plainAllowed = false, label }) {
  const jsonLines = [],
    plainLines = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    // An envelope that does not START its line is invisible — and takes the rest of the
    // line with it. This is the exact shape of the PostToolUse error-recall bug fixed in
    // v3.48 (raw text + JSON in one write).
    expect(
      /^[^{].*[{,]\s*"(?:suppressOutput|hookSpecificOutput)"/.test(line),
      `${label}: JSON envelope is not at the start of its line — the host drops it:\n${line}`,
    ).toBe(false);
    (line.startsWith('{') ? jsonLines : plainLines).push(line);
  }

  // At most ONE envelope, and nothing else beside it. Claude Code parses hook stdout
  // as a single JSON document (2.1.233 `Hxi`: `if(!t.startsWith("{")) return {plainText:e}`
  // then JSON.parse of the WHOLE trimmed string, catch → plainText). This helper used to
  // encode a line-based parser that does not exist, so two envelopes on two lines read as
  // compliant while the host was actually discarding both. See lib/hook-stdout.mjs.
  expect(
    jsonLines.length,
    `${label}: ${jsonLines.length} JSON envelopes on one stdout — the host JSON.parses the whole ` +
      `thing, so this degrades to plain text and every envelope is lost:\n${out}`,
  ).toBeLessThanOrEqual(1);
  if (jsonLines.length === 1) {
    expect(
      plainLines,
      `${label}: prose alongside a JSON envelope makes stdout unparseable as one document`,
    ).toEqual([]);
  }

  if (event === null) {
    expect(jsonLines, `${label}: emitted a JSON envelope on a plain-text/silent surface`).toEqual([]);
  }
  const parsed = [];
  for (const line of jsonLines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`${label}: stdout line is not parseable JSON (${e.message}):\n${line}`, { cause: e });
    }
    expect(obj.hookSpecificOutput?.hookEventName, `${label}: wrong hookEventName in ${line}`).toBe(event);
    parsed.push(obj);
  }

  if (!plainAllowed) {
    expect(plainLines, `${label}: stray non-envelope stdout`).toEqual([]);
  }
  return parsed;
}

// The payload shapes a hook must survive. Claude Code should never send most of these,
// but a truncated pipe, a protocol change or a third-party wrapper can — and a non-zero exit
// or a crash here degrades the user's session with no error surface.
const MALFORMED = [
  ['empty stdin', ''],
  ['invalid JSON', 'not json at all {{{'],
  ['valid JSON, required fields missing', '{}'],
  // `'null'` is VALID JSON that parses to null, so it slips past the parse guard and
  // reaches the destructure — which throws. Added after review found every handler here
  // shares the hole and none of the four shapes above reaches it.
  ['valid JSON that is null', 'null'],
  ['valid JSON that is a scalar', '42'],
  [
    'unexpected types',
    JSON.stringify({
      session_id: [],
      tool_name: 42,
      tool_input: 'not-an-object',
      tool_response: { a: 1 },
      prompt: { b: 2 },
      transcript_path: 17,
      source: false,
    }),
  ],
];

/**
 * Fire the four malformed payloads at one surface (in parallel — each gets its own cwd, so
 * they share no episode buffer or session file) and assert the resilience contract.
 *
 * @param {string} label   surface name
 * @param {object} spec    the surface's envelope contract (see expectHookStdout)
 * @param {(payload: string, cwd: string) => Promise<object>} run
 */
async function expectMalformedResilience(label, spec, run) {
  const slug = label.replace(/[^a-z0-9]/gi, '').slice(0, 24);
  const results = await Promise.all(
    MALFORMED.map(([name, payload], i) => run(payload, workDir(`mal-${slug}-${i}`)).then((r) => [name, r])),
  );
  for (const [name, r] of results) {
    const where = `${label} — ${name}`;
    expect(
      r.code,
      `${where}: exited ${r.code} (a non-zero hook exit degrades the host session)\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    ).toBe(0);
    expect(STACK_TRACE.test(r.stdout), `${where}: stack trace reached stdout:\n${r.stdout}`).toBe(false);
    expectHookStdout(r.stdout, { ...spec, label: where });
  }
}

// ─── Setup / teardown ──────────────────────────────────────────────────────────────

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-hooksweep-'));
  DATA_DIR = join(ROOT, 'data');
  RUNTIME_DIR = join(DATA_DIR, 'runtime');
  HOME_DIR = join(ROOT, 'home');
  mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  repoClaudeMdSnapshot = existsSync(REPO_CLAUDE_MD) ? readFileSync(REPO_CLAUDE_MD, 'utf8') : null;

  BASE_ENV = { ...process.env };
  // Scrub the developer's OWN plugin flags before setting ours. A dev shell running this
  // plugin exports CLAUDE_MEM_SUBAGENT_INJECT / CLAUDE_MEM_TASK_IMPERATIVE / MEM_QUIET_HOOKS
  // etc., and `...process.env` hands every one of them to the spawned hook — which silently
  // flips default-OFF surfaces on (the #8608 leak class vitest.config.mjs scrubs for the
  // runner, but children get their env from here). Everything this sweep depends on is set
  // explicitly below; anything else must be at its shipped default.
  for (const k of Object.keys(BASE_ENV)) {
    if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  }
  Object.assign(BASE_ENV, {
    HOME: HOME_DIR,
    CLAUDE_MEM_DIR: DATA_DIR,
    // No reachable LLM by default: haiku-client's detectMode() falls back to 'cli' with no
    // API key and would spawn the real `claude`. The four worker cases that need an LLM
    // answer override this with scripts/mock-claude.mjs.
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_SKIP_UPDATE: '1', // no GitHub release fetch (banner + update-check)
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1', // no detached llm-episode worker on a flush
    CLAUDE_MEM_SKIP_COMPRESS: '1', // no detached auto-compress from SessionStart
    CLAUDE_MEM_SKIP_OPTIMIZE: '1', // no detached llm-optimize from SessionStart
    CLAUDE_MEM_SKIP_MAINTAIN: '1', // no detached auto-maintain from SessionStart
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1', // no detached enrich-save from a CLI seed
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1', // background workers skip their 0.5-5s jitter
  });
  // See isolation contract #2: cwd must be the ONLY project source.
  delete BASE_ENV.CLAUDE_PROJECT_DIR;
  delete BASE_ENV.PWD;
});

afterAll(async () => {
  // The Stop handler spawns a detached llm-summary worker; give it a moment to finish so it
  // cannot recreate the data dir after rmSync (it would resolve CLAUDE_MEM_DIR and mkdir it).
  await new Promise((r) => setTimeout(r, 500));
  try {
    // Isolation contract #4: no hook fire may have touched this repo's own CLAUDE.md.
    // Inside the try so that FIRING it still removes the sandbox.
    if (repoClaudeMdSnapshot !== null) {
      expect(readFileSync(REPO_CLAUDE_MD, 'utf8')).toBe(repoClaudeMdSnapshot);
    }
  } finally {
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ─── Coverage guards ───────────────────────────────────────────────────────────────

describe('hook feature sweep: registered surface', () => {
  it('every event hook.mjs dispatches has a sweep case', () => {
    // Parsed out of hook.mjs's own switch, so adding `case 'foo':` without an
    // itHook('hook.mjs foo', …) case fails here — and cannot be silenced by editing a list.
    const dispatched = dispatchedEvents()
      .map((e) => `hook.mjs ${e}`)
      .sort();
    const swept = [...SWEPT].filter((s) => s.startsWith('hook.mjs ')).sort();
    expect(swept).toEqual(dispatched);
  });

  it('every hook entry hooks/hooks.json registers has a sweep case', () => {
    const registered = [...registeredEntries()].filter((e) => !UNSWEPT_BY_DESIGN.has(e)).sort();
    const missing = registered.filter((e) => !SWEPT.has(e));
    expect(missing, 'registered hook entries with no sweep case').toEqual([]);
    // The exclusion cannot silently grow: every name in it must still be registered…
    for (const skipped of UNSWEPT_BY_DESIGN) expect([...registeredEntries()]).toContain(skipped);
    // …and there must still be exactly one of them. FAILS IF: a second entry is added to
    // UNSWEPT_BY_DESIGN (e.g. moving 'scripts/post-tool-use.sh' there and deleting its case,
    // which every other guard in this describe accepts silently).
    expect(
      UNSWEPT_BY_DESIGN.size,
      `the sweep's exclusion list grew to [${[...UNSWEPT_BY_DESIGN].join(', ')}] — each name in it is a registered hook entry point NOBODY fires here`,
    ).toBe(UNSWEPT_COUNT);
    expect([...UNSWEPT_BY_DESIGN]).toEqual(['scripts/setup.sh']);
  });

  it('every sweep case names a real entry point (no phantom coverage)', () => {
    const dispatched = dispatchedEvents();
    for (const surface of SWEPT) {
      if (surface.startsWith('hook.mjs ')) {
        expect(dispatched, `sweep case "${surface}" names an event hook.mjs does not dispatch`).toContain(
          surface.slice('hook.mjs '.length),
        );
      } else {
        expect(existsSync(join(REPO, surface)), `sweep case "${surface}" names a missing file`).toBe(true);
      }
    }
  });
});

// ─── hook.mjs: the five foreground Claude Code events ──────────────────────────────

describe('hook feature sweep: hook.mjs foreground events', () => {
  itHook('hook.mjs session-start', async () => {
    const NAME = 'hs-session';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    const TITLE = 'Fixed the widget cache invalidation race in lib/widget-cache.mjs';
    await seedObs(cwd, TITLE, [
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      'Invalidate the widget cache on write, never on read',
    ]);
    await cli(
      ['activity', 'save', '--type', 'lesson', 'Session start sweep event', '--body', 'event body'],
      cwd,
    );

    const r = await hookEvent('session-start', {
      cwd,
      stdin: JSON.stringify({ session_id: 'cc-hooksweep-session', source: 'startup' }),
    });
    expect(r.code, `session-start exited ${r.code}\n${r.stderr}`).toBe(0);

    const envelopes = expectHookStdout(r.stdout, {
      event: 'SessionStart',
      plainAllowed: false,
      label: 'hook.mjs session-start',
    });
    // The startup dashboard rides the JSON channel and must name the one event seeded above
    // (a dashboard computed over the wrong project — or over the live DB — says "0 entries"
    // or nothing at all).
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].hookSpecificOutput.additionalContext).toContain('mem events: 1 entries');
    expect(envelopes[0].suppressOutput).toBe(true);
    // …and the context block rides the SAME envelope, carrying the seeded memory.
    // Asserted against additionalContext, not against raw stdout: `stdout` contains
    // the block either way (JSON.stringify does not escape angle brackets), so a
    // stdout-level toContain cannot tell the merged shape from the pre-v3.70 shape
    // where a second raw write made the envelope unparseable for the host.
    const ctx = envelopes[0].hookSpecificOutput.additionalContext;
    expect(ctx).toContain('<claude-mem-context>');
    expect(ctx).toContain('</claude-mem-context>');
    expect(ctx).toContain('Session start sweep event');
    expect(ctx).toContain('Fixed the widget cache invalidation race');
    // Nothing may ride outside the envelope on this surface.
    expect(
      r.stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('{')),
    ).toEqual([]);

    // Side effects landed in the SANDBOX, under the project derived from the sandbox cwd.
    expect(
      withDb((db) => db.prepare('SELECT status FROM sdk_sessions WHERE project = ?').get(project)),
    ).toMatchObject({ status: 'active' });
    expect(existsSync(join(RUNTIME_DIR, `session-${project}`))).toBe(true);
    // SessionStart auto-adopts, which writes <cwd>/CLAUDE.md — here, and never the repo's
    // (afterAll asserts the negative half).
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toContain('<!-- claude-mem-lite:begin');

    await expectMalformedResilience(
      'hook.mjs session-start',
      { event: 'SessionStart', plainAllowed: false },
      (stdin, malCwd) => hookEvent('session-start', { cwd: malCwd, stdin }),
    );
  });

  itHook('hook.mjs user-prompt', async () => {
    const NAME = 'hs-uprompt';
    const cwd = workDir(NAME);
    const LESSON = 'Invalidate the widget cache on write, never on read';
    const targetId = await seedObs(cwd, 'Fixed the widget cache invalidation race in lib/widget-cache.mjs', [
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      LESSON,
    ]);
    // handleUserPrompt excludes ONLY ids actually rendered somewhere (the path-A
    // UPS marker and the SessionStart keyctx marker — D#123: exclusion mirrors
    // real injections, never a DB query). This sandbox has neither marker for
    // this project+session, so the target is always eligible; the fillers just
    // give the corpus enough rows that the adaptive BM25 threshold (>=5 obs)
    // applies, matching real installs.
    for (const filler of [
      'Chose postgres over sqlite for the billing ledger store',
      'Renamed the deployment runbook chapter headings',
      'Documented the nightly export window change',
      'Split the retry helper out of the transport module',
      'Trimmed the onboarding screenshot set',
    ])
      await cli(['save', filler, '--type', 'decision', '--importance', '2'], cwd);

    const PROMPT = 'why does the widget cache invalidation race happen and how do we fix it';
    const r = await hookEvent('user-prompt', {
      cwd,
      stdin: JSON.stringify({ session_id: 'cc-hooksweep-prompt', prompt: PROMPT }),
    });
    expect(r.code, `user-prompt exited ${r.code}\n${r.stderr}`).toBe(0);
    expectHookStdout(r.stdout, { event: null, plainAllowed: true, label: 'hook.mjs user-prompt' });

    // Functional: the matching memory is injected, by id and with its lesson.
    expect(r.stdout).toContain('<memory-context relevance="high">');
    expect(r.stdout).toContain('</memory-context>');
    expect(r.stdout).toContain(`(#${targetId})`);
    expect(r.stdout).toContain(LESSON);

    // …and the prompt is persisted to the sandbox DB under the cwd-derived project.
    const prompt = withDb((db) =>
      db
        .prepare(
          `
      SELECT p.prompt_text, s.project FROM user_prompts p
      JOIN sdk_sessions s ON s.content_session_id = p.content_session_id
      WHERE p.prompt_text = ?
    `,
        )
        .get(PROMPT),
    );
    expect(prompt).toMatchObject({ prompt_text: PROMPT, project: projectOf(NAME) });

    await expectMalformedResilience(
      'hook.mjs user-prompt',
      { event: null, plainAllowed: true },
      (stdin, malCwd) => hookEvent('user-prompt', { cwd: malCwd, stdin }),
    );
  });

  itHook('hook.mjs post-tool-use', async () => {
    const NAME = 'hs-posttool';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    const recallId = await seedObs(cwd, 'Fixed the widget cache invalidation race in lib/widget-cache.mjs', [
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      'Invalidate the widget cache on write, never on read',
    ]);

    // (a) A failing test command is a hard error → error-triggered recall, delivered on the
    // JSON channel (MED-3: it used to be a raw multi-line write that corrupted a co-emitted
    // episode receipt).
    const errFire = await hookEvent('post-tool-use', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-post',
        tool_name: 'Bash',
        tool_input: { command: 'node --test widget-cache.test.mjs' },
        tool_response:
          'FAIL widget-cache.test.mjs\nError: widget cache invalidation race detected\nnpm ERR! Test failed. See above for more details.',
      }),
    });
    expect(errFire.code, `post-tool-use exited ${errFire.code}\n${errFire.stderr}`).toBe(0);
    const [recall] = expectHookStdout(errFire.stdout, {
      event: 'PostToolUse',
      plainAllowed: false,
      label: 'hook.mjs post-tool-use (error recall)',
    });
    expect(recall, `no error-recall envelope emitted:\n${errFire.stdout}`).toBeTruthy();
    expect(recall.hookSpecificOutput.additionalContext).toContain('Related memories found for this error');
    expect(recall.hookSpecificOutput.additionalContext).toContain(`#${recallId}`);

    // (b) An Edit is buffered into the episode file — the surface's real job between flushes.
    const editFire = await hookEvent('post-tool-use', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-post',
        tool_name: 'Edit',
        tool_input: {
          file_path: join(cwd, 'widget-cache.mjs'),
          old_string: 'readPath()',
          new_string: 'writePath()',
        },
        tool_response: 'The file has been updated successfully with the new content applied.',
      }),
    });
    expect(editFire.code).toBe(0);
    expect(editFire.stdout).toBe(''); // buffering is silent; only a flush emits a receipt

    const episode = JSON.parse(readFileSync(join(RUNTIME_DIR, `ep-${project}.json`), 'utf8'));
    expect(episode.project).toBe(project);
    expect(episode.entries.map((e) => e.tool)).toEqual(['Bash', 'Edit']);
    expect(episode.entries[0].isHardError).toBe(true);
    expect(episode.entries[1].files).toContain(join(cwd, 'widget-cache.mjs'));
    expect(episode.entries[1].ccSession).toBe('cc-hooksweep-post');

    await expectMalformedResilience(
      'hook.mjs post-tool-use',
      { event: 'PostToolUse', plainAllowed: false },
      (stdin, malCwd) => hookEvent('post-tool-use', { cwd: malCwd, stdin }),
    );
  });

  itHook('hook.mjs post-tool-failure', async () => {
    // D#170. The event PostToolUse never sees: Claude Code routes tool calls it judged
    // FAILED here instead. The sibling case above proves the surface works on an exit-0
    // command that printed error text; this one proves it works on the population that
    // used to be invisible — and that it reads `error`, since the payload has no
    // `tool_response` at all.
    const NAME = 'hs-postfail';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    const recallId = await seedObs(cwd, 'ENOENT on package.json means the build ran from the wrong cwd', [
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      'Run the build from the package root, not from scripts/',
    ]);

    const fire = await hookEvent('post-tool-failure', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-postfail',
        tool_name: 'Bash',
        tool_input: { command: 'node scripts/build.mjs' },
        tool_use_id: 'toolu_sweep_d170',
        error:
          "Error: ENOENT: no such file or directory, open '/app/package.json'\n    at Object.openSync (node:fs:596:3)",
      }),
    });
    expect(fire.code, `post-tool-failure exited ${fire.code}\n${fire.stderr}`).toBe(0);
    const [recall] = expectHookStdout(fire.stdout, {
      event: 'PostToolUseFailure',
      plainAllowed: false,
      label: 'hook.mjs post-tool-failure',
    });
    expect(recall, `no error-recall envelope emitted:\n${fire.stdout}`).toBeTruthy();
    expect(recall.hookSpecificOutput.additionalContext).toContain('Related memories found for this error');
    expect(recall.hookSpecificOutput.additionalContext).toContain(`#${recallId}`);

    // Scope, asserted against the real subprocess rather than the manifest matcher: a
    // tool-chain refusal is not a program failure, and 68.9% of host-flagged Bash
    // failures on the maintainer's machine were of that kind.
    // The refusal text must carry terms that WOULD match the row seeded above, or this
    // asserts nothing: the first version used `§8 SAFETY … rm -rf`, on which
    // planErrorRecall returns null, so the surface was silent no matter what the gate
    // did. Mutation confirmed it survived. Same ENOENT/package.json vocabulary as the
    // firing case, one marker added.
    const refused = await hookEvent('post-tool-failure', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-postfail',
        tool_name: 'Bash',
        tool_input: { command: 'node scripts/build.mjs' },
        error:
          '[claudemd] §11 memory-hint: refused — the ENOENT probe on package.json was blocked before it ran.\nError: command not executed.',
      }),
    });
    expect(refused.code).toBe(0);
    expect(refused.stdout, 'a denied command must not recall').toBe('');

    // This path deliberately does NOT feed the episode buffer (scope: episode entries
    // flow into LLM summarisation and the save-nudge, unmeasured under an influx of
    // failures). The buffer must therefore hold nothing from either fire above.
    expect(
      existsSync(join(RUNTIME_DIR, `ep-${project}.json`)),
      'post-tool-failure must not write an episode entry',
    ).toBe(false);

    await expectMalformedResilience(
      'hook.mjs post-tool-failure',
      { event: 'PostToolUseFailure', plainAllowed: false },
      (stdin, malCwd) => hookEvent('post-tool-failure', { cwd: malCwd, stdin }),
    );
  });

  itHook('hook.mjs stop', async () => {
    const NAME = 'hs-stop';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    // A Write to a schema file: significant (an edit), and substantive enough to clear the
    // write-side noise gate (rule importance 2 from the `schema.` filename heuristic), so the
    // flush leaves a durable row rather than being dropped as auto-capture noise.
    const schemaFile = join(cwd, 'db-schema.sql');
    const post = await hookEvent('post-tool-use', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-stop',
        tool_name: 'Write',
        tool_input: {
          file_path: schemaFile,
          content: 'CREATE TABLE widgets (id INTEGER, cache_epoch INTEGER);\n',
        },
        tool_response: `File created successfully at: ${schemaFile}`,
      }),
    });
    expect(post.code).toBe(0);
    expect(existsSync(join(RUNTIME_DIR, `ep-${project}.json`))).toBe(true);

    const r = await hookEvent('stop', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-stop',
        transcript_path: join(ROOT, 'no-such-transcript.jsonl'),
      }),
    });
    expect(r.code, `stop exited ${r.code}\n${r.stderr}`).toBe(0);
    // Stop's schema rejects hookSpecificOutput at the root (v2.33.4) — silence is the contract.
    expect(r.stdout).toBe('');
    expectHookStdout(r.stdout, { event: null, plainAllowed: false, label: 'hook.mjs stop' });

    // Functional: the buffered episode was flushed to a readable observation, and the
    // session was closed out.
    expect(existsSync(join(RUNTIME_DIR, `ep-${project}.json`))).toBe(false);
    const row = withDb((db) =>
      db
        .prepare('SELECT title, type, importance, files_modified FROM observations WHERE project = ?')
        .get(project),
    );
    expect(row, `Stop did not flush an observation for ${project}`).toBeTruthy();
    expect(row.title).toBe('Modified db-schema.sql');
    expect(row.files_modified).toContain('db-schema.sql');
    expect(
      withDb((db) => db.prepare('SELECT status FROM sdk_sessions WHERE project = ?').get(project)),
    ).toMatchObject({ status: 'completed' });

    await expectMalformedResilience('hook.mjs stop', { event: null, plainAllowed: false }, (stdin, malCwd) =>
      hookEvent('stop', { cwd: malCwd, stdin }),
    );
  });

  itHook('hook.mjs pre-compact', async () => {
    const NAME = 'hs-precompact';
    const cwd = workDir(NAME);
    await seedObs(cwd, 'Traced the retry backoff reset to every redirect hop', [
      '--type',
      'discovery',
      '--importance',
      '3',
      '--lesson',
      'Reset the backoff only on a fresh request, not per hop',
    ]);

    const r = await hookEvent('pre-compact', {
      cwd,
      stdin: JSON.stringify({ session_id: 'cc-hooksweep-compact', trigger: 'auto' }),
    });
    expect(r.code, `pre-compact exited ${r.code}\n${r.stderr}`).toBe(0);
    expectHookStdout(r.stdout, { event: null, plainAllowed: true, label: 'hook.mjs pre-compact' });
    // Functional: memory is re-emitted BEFORE compaction so the summarizer sees it.
    expect(r.stdout.startsWith('<claude-mem-context>')).toBe(true);
    expect(r.stdout.trimEnd().endsWith('</claude-mem-context>')).toBe(true);
    expect(r.stdout).toContain('Traced the retry backoff reset to every redirect hop');

    await expectMalformedResilience(
      'hook.mjs pre-compact',
      { event: null, plainAllowed: true },
      (stdin, malCwd) => hookEvent('pre-compact', { cwd: malCwd, stdin }),
    );
  });
});

// ─── episode.filesRead is a per-FLUSH slice, not a per-episode total (D#175) ────────
// The one link in D#171's won't-fix chain that is a property of CODE rather than of a
// corpus at a timestamp: flushEpisodeWithDb RENAMES reads-<project>.txt aside and then
// UNLINKS the collected copy on every flush (hook.mjs:222-232), so `episode.filesRead`
// only ever carries the Reads since the LAST flush. Every other figure in that docblock
// (1861 Reads / 0.98 per episode / 1.8% of rows non-empty) is a measurement and correctly
// ships as prose — a test over those would be a snapshot that rots. This one is different:
// make the collect a copy instead of a rename and the whole "a threshold of 8 is out of
// reach at ~1 Read per episode" rationale becomes false while nothing goes red.
//
// Not hypothetical hygiene. D#174 records that this exact axis already moved silently
// once: files_read fed the threshold on 44-60% of rows for three straight months and
// collapsed to 6.2% in 2026-05, cause never identified. This is the alarm that was
// missing then.
//
// SHAPE — the discriminating pair is flush 1 vs flush 2, and flush 1 is not decoration.
// Asserting only "flush 2 read nothing" passes just as well when the seeding never worked
// at all, which is v3.79.0's "my assertion was satisfied by another cause" repeated; so
// flush 1 must first prove both seeded paths reached the row.
//
// TWO INDEPENDENT MUTATIONS, because one assertion does not cover both statements:
//   copy instead of rename  → flush 2 inherits the same paths  → the files_read equality fails.
//   drop the unlinkSync     → flush 2 is STILL empty (the residue is named .collect-<ts>,
//                             which no flush looks for) → only the residue sweep fails.

describe('hook flush: the reads-file is consumed, not accumulated (D#175)', () => {
  it('a flush consumes reads-<project>.txt and the next flush starts empty', async () => {
    const NAME = 'hs-readslice';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    const readsFile = join(RUNTIME_DIR, `reads-${project}.txt`);
    const readsResidue = () => readdirSync(RUNTIME_DIR).filter((f) => f.startsWith(`reads-${project}`));

    // The Read paths must differ from the file each episode WRITES: buildImmediateObservation
    // subtracts modified files back out of filesRead (hook-llm.mjs:602), so reusing one name
    // would empty the row for a reason that has nothing to do with the rename.
    const readA = join(cwd, 'alpha-config.mjs');
    const readB = join(cwd, 'beta-config.mjs');

    // (1) Seed through the REAL bash prefilter — the only writer of this file, and the
    // reason a Read never reaches Node at all (scripts/post-tool-use.sh:49-93).
    for (const p of [readA, readB]) {
      const r = await bashPrefilter({
        cwd,
        stdin: JSON.stringify({
          session_id: 'cc-readslice-1',
          tool_name: 'Read',
          tool_input: { file_path: p },
        }),
      });
      expect(r.code, `post-tool-use.sh exited ${r.code}\n${r.stderr}`).toBe(0);
    }
    // Both halves of the seed asserted before anything downstream runs: a silently absent
    // reads file would make every later assertion in this case vacuous.
    expect(
      existsSync(readsFile),
      'the bash prefilter wrote no reads file — the rest of this case would assert nothing',
    ).toBe(true);
    expect(readFileSync(readsFile, 'utf8').split('\n').filter(Boolean)).toEqual([readA, readB]);

    /** Buffer one significant Write, then Stop — the real flush path. */
    async function writeThenFlush(session, schemaFile) {
      // `…schema.sql` clears the write-side noise gate at rule importance 2, exactly as the
      // `hook.mjs stop` case above relies on; a dropped row would leave nothing to read.
      const post = await hookEvent('post-tool-use', {
        cwd,
        stdin: JSON.stringify({
          session_id: session,
          tool_name: 'Write',
          tool_input: { file_path: schemaFile, content: 'CREATE TABLE widgets (id INTEGER);\n' },
          tool_response: `File created successfully at: ${schemaFile}`,
        }),
      });
      expect(post.code, `post-tool-use exited ${post.code}\n${post.stderr}`).toBe(0);
      expect(existsSync(join(RUNTIME_DIR, `ep-${project}.json`))).toBe(true);

      const stop = await hookEvent('stop', {
        cwd,
        stdin: JSON.stringify({
          session_id: session,
          transcript_path: join(ROOT, 'no-such-transcript.jsonl'),
        }),
      });
      expect(stop.code, `stop exited ${stop.code}\n${stop.stderr}`).toBe(0);
      expect(existsSync(join(RUNTIME_DIR, `ep-${project}.json`))).toBe(false);

      const row = withDb((db) =>
        db
          .prepare(
            'SELECT title, files_read, files_modified FROM observations WHERE project = ? AND files_modified LIKE ? ORDER BY id DESC LIMIT 1',
          )
          .get(project, `%${schemaFile.split('/').pop()}%`),
      );
      expect(row, `no observation flushed for ${schemaFile}`).toBeTruthy();
      return row;
    }

    // (2) First flush: it carries the seeded Reads …
    const first = await writeThenFlush('cc-readslice-1', join(cwd, 'alpha-schema.sql'));
    expect(JSON.parse(first.files_read)).toEqual([readA, readB]);

    // … and consumed the file rather than reading it in place.
    expect(
      existsSync(readsFile),
      'the flush left reads-<project>.txt in place — filesRead would accumulate across flushes',
    ).toBe(false);
    // The rename target too: a collect copy left behind is an unswept per-flush file that
    // grows forever and leaks captured paths, and the emptiness assertion below cannot see it.
    expect(readsResidue(), 'the flush left reads-file residue in RUNTIME_DIR').toEqual([]);

    // (3) Second flush with no intervening Read — the assertion that actually pins the
    // per-flush semantics. A row IS produced (files_modified proves it), and its read set
    // is empty rather than inheriting round 1's.
    const second = await writeThenFlush('cc-readslice-2', join(cwd, 'beta-schema.sql'));
    expect(second.files_modified).toContain('beta-schema.sql');
    expect(
      JSON.parse(second.files_read),
      "the second flush inherited the first flush's Reads — filesRead is no longer a per-flush slice, and D#171's closure rationale is void",
    ).toEqual([]);
    expect(readsResidue()).toEqual([]);
  }, 60000);
});

// ─── an INSIGNIFICANT flush must not eat the accumulated Reads (D#178) ──────────────
// The D#175 case above pins that a flush CONSUMES the reads file. This one pins the other
// half of that statement, which was the defect: the consumption used to happen before
// anything knew whether the flush would persist an observation, so a flush with entries
// but no significance swallowed every Read since the last flush and dropped them. Measured
// over 1121 real transcripts (benchmark/episode-flush-replay.mjs): 42.8% of all collected
// reads died that way.
//
// TWO ARMS, and both are load-bearing:
//   default (v3.83.0: ON) — the fix. Reverting the reorder in flushEpisodeWithDb makes BOTH
//     of its assertions fail (the file is gone after the insignificant flush, and the later
//     row's files_read is empty). Verified by mutation, not by reading.
//   CLAUDE_MEM_READS_CARRY=0 — the off switch, pinned against the OLD behavior. Without
//     this arm the switch is documentation: an off switch that silently stopped switching
//     anything would keep the default arm green and nobody would know.
//
// The insignificant flush is a plain `echo` Bash entry: no edit (rule 1), not a test/build
// error (rule 2), no important-looking file in the command (rule 3 reads episode.files via
// extractFilePaths, so the command must contain no path), and one entry is far under the
// research threshold (rule 4).
describe('hook flush: an insignificant flush does not destroy accumulated Reads (D#178)', () => {
  /** Seed Read paths through the REAL bash prefilter — the only writer of the reads file. */
  async function seedReads(cwd, session, paths) {
    for (const p of paths) {
      const r = await bashPrefilter({
        cwd,
        stdin: JSON.stringify({ session_id: session, tool_name: 'Read', tool_input: { file_path: p } }),
      });
      expect(r.code, `post-tool-use.sh exited ${r.code}\n${r.stderr}`).toBe(0);
    }
  }

  /** Buffer one entry, then Stop. `significant` picks which rule the entry trips. */
  async function bufferThenFlush(cwd, session, { significant, env = {}, schemaFile }) {
    const stdin = significant
      ? JSON.stringify({
          session_id: session,
          tool_name: 'Write',
          tool_input: { file_path: schemaFile, content: 'CREATE TABLE widgets (id INTEGER);\n' },
          tool_response: `File created successfully at: ${schemaFile}`,
        })
      : JSON.stringify({
          session_id: session,
          tool_name: 'Bash',
          tool_input: { command: 'echo hello from the harness' },
          tool_response: 'hello from the harness\n',
        });
    const post = await hookEvent('post-tool-use', { cwd, stdin, env });
    expect(post.code, `post-tool-use exited ${post.code}\n${post.stderr}`).toBe(0);
    const stop = await hookEvent('stop', {
      cwd,
      env,
      stdin: JSON.stringify({ session_id: session, transcript_path: join(ROOT, 'no-such-transcript.jsonl') }),
    });
    expect(stop.code, `stop exited ${stop.code}\n${stop.stderr}`).toBe(0);
  }

  const rowFor = (project, schemaFile) =>
    withDb((db) =>
      db
        .prepare(
          'SELECT title, files_read, files_modified FROM observations WHERE project = ? AND files_modified LIKE ? ORDER BY id DESC LIMIT 1',
        )
        .get(project, `%${schemaFile.split('/').pop()}%`),
    );

  it('CLAUDE_MEM_READS_CARRY=0: the insignificant flush consumes and discards them (pre-D#178)', async () => {
    const NAME = 'hs-readseat-off';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    const readsFile = join(RUNTIME_DIR, `reads-${project}.txt`);
    const readA = join(cwd, 'alpha-config.mjs');
    const readB = join(cwd, 'beta-config.mjs');
    const env = { CLAUDE_MEM_READS_CARRY: '0' };

    await seedReads(cwd, 'cc-off-1', [readA, readB]);
    expect(
      existsSync(readsFile),
      'the bash prefilter wrote no reads file — every later assertion would be vacuous',
    ).toBe(true);

    await bufferThenFlush(cwd, 'cc-off-1', { significant: false, env });
    expect(
      existsSync(readsFile),
      'the off switch did not switch anything off: the insignificant flush left the reads file',
    ).toBe(false);

    const schema = join(cwd, 'alpha-schema.sql');
    await bufferThenFlush(cwd, 'cc-off-2', { significant: true, schemaFile: schema, env });
    const row = rowFor(project, schema);
    expect(row, 'no observation flushed for the significant episode').toBeTruthy();
    expect(
      JSON.parse(row.files_read),
      'the off switch did not restore the old behavior: the reads survived the insignificant flush',
    ).toEqual([]);
  }, 60000);

  // The reorder put `planEpisodeFlush` ABOVE the collection, and its multi-session branch
  // builds fresh sub-objects that copied whatever `filesRead` the buffer held at that
  // moment — always `[]`. One line writes the collected paths back into every sub. Without
  // this case that line is invisible: deleting it leaves the whole suite (309 files / 5231
  // tests) green while every concurrent same-project session silently loses its reads, and
  // it fails in BOTH flag arms, because the reorder is not gated on the flag. Found by the
  // pre-tag review, which mutated the line and watched nothing go red.
  it('two concurrent sessions in one project: BOTH observations carry the reads', async () => {
    const NAME = 'hs-readseat-multi';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    const readsFile = join(RUNTIME_DIR, `reads-${project}.txt`);
    const readA = join(cwd, 'alpha-config.mjs');
    const readB = join(cwd, 'beta-config.mjs');

    await seedReads(cwd, 'cc-multi-1', [readA, readB]);
    expect(
      existsSync(readsFile),
      'the bash prefilter wrote no reads file — the case would assert nothing',
    ).toBe(true);

    // Two DIFFERENT session ids buffered into the one per-project episode file, so
    // planEpisodeFlush takes its multi-session branch on the flush below.
    const schemaA = join(cwd, 'alpha-schema.sql');
    const schemaB = join(cwd, 'beta-schema.sql');
    for (const [session, file] of [
      ['cc-multi-1', schemaA],
      ['cc-multi-2', schemaB],
    ]) {
      const post = await hookEvent('post-tool-use', {
        cwd,
        stdin: JSON.stringify({
          session_id: session,
          tool_name: 'Write',
          tool_input: { file_path: file, content: 'CREATE TABLE widgets (id INTEGER);\n' },
          tool_response: `File created successfully at: ${file}`,
        }),
      });
      expect(post.code, `post-tool-use exited ${post.code}\n${post.stderr}`).toBe(0);
    }
    const stop = await hookEvent('stop', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-multi-1',
        transcript_path: join(ROOT, 'no-such-transcript.jsonl'),
      }),
    });
    expect(stop.code, `stop exited ${stop.code}\n${stop.stderr}`).toBe(0);

    // Both sub-episodes saved, and BOTH carry the reads — the multi-session branch
    // inherits the collected set by value, so a missing write-back empties both.
    for (const schema of [schemaA, schemaB]) {
      const row = rowFor(project, schema);
      expect(row, `no observation flushed for ${schema}`).toBeTruthy();
      expect(
        JSON.parse(row.files_read),
        `${schema.split('/').pop()}'s sub-episode lost the collected reads — planEpisodeFlush now runs before the collect, so every sub needs the write-back`,
      ).toEqual([readA, readB]);
    }
  }, 60000);

  it('default (v3.83.0): the reads survive and land on the next significant flush', async () => {
    const NAME = 'hs-readseat-on';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    const readsFile = join(RUNTIME_DIR, `reads-${project}.txt`);
    const readA = join(cwd, 'alpha-config.mjs');
    const readB = join(cwd, 'beta-config.mjs');
    const env = {};

    await seedReads(cwd, 'cc-on-1', [readA, readB]);
    expect(existsSync(readsFile)).toBe(true);

    await bufferThenFlush(cwd, 'cc-on-1', { significant: false, env });
    expect(existsSync(readsFile), 'the insignificant flush still consumed the reads file').toBe(true);
    expect(readFileSync(readsFile, 'utf8').split('\n').filter(Boolean)).toEqual([readA, readB]);

    const schema = join(cwd, 'alpha-schema.sql');
    await bufferThenFlush(cwd, 'cc-on-2', { significant: true, schemaFile: schema, env });
    const row = rowFor(project, schema);
    expect(row, 'no observation flushed for the significant episode').toBeTruthy();
    expect(JSON.parse(row.files_read), 'the carried reads did not reach the saved observation').toEqual([
      readA,
      readB,
    ]);
    // …and the significant flush DID consume: the carry is a deferral, not a leak.
    expect(
      existsSync(readsFile),
      'the significant flush left the reads file in place — it would accumulate forever',
    ).toBe(false);
  }, 60000);
});

// ─── hook.mjs: the background workers (spawnBackground / detached) ──────────────────
// These run under CLAUDE_MEM_HOOK_RUNNING=1 — the recursion guard exits every other event
// immediately, so without it each case would assert "exit 0, no output" against a process
// that never ran its handler. They are spawned with stdio:'ignore' in production, so their
// stdout contract is silence.

describe('hook feature sweep: hook.mjs background workers', () => {
  const BG = { CLAUDE_MEM_HOOK_RUNNING: '1' };
  const WITH_MOCK_LLM = { ...BG, CLAUDE_CODE_PATH: MOCK_CLAUDE };

  /** Every worker: exit 0, silent stdout, no network signature. */
  function expectSilentWorker(label, r) {
    expect(r.code, `${label} exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(r.stdout, `${label} wrote to stdout; background workers are stdio:'ignore'`).toBe('');
    expect(r.stdout + r.stderr, `${label} attempted network I/O`).not.toMatch(
      /ENOTFOUND|ETIMEDOUT|fetch failed/,
    );
    expectHookStdout(r.stdout, { event: null, plainAllowed: false, label });
  }

  itHook('hook.mjs llm-episode', async () => {
    const NAME = 'hs-episode';
    const cwd = workDir(NAME);
    const savedId = await seedObs(cwd, 'Immediate observation the episode worker upgrades', [
      '--type',
      'change',
      '--importance',
      '1',
    ]);
    mkdirSync(RUNTIME_DIR, { recursive: true });
    const flushFile = join(RUNTIME_DIR, 'ep-flush-hooksweep.json');
    writeFileSync(
      flushFile,
      JSON.stringify({
        sessionId: 'hook-hooksweep-episode',
        project: projectOf(NAME),
        savedId,
        entries: [
          {
            tool: 'Edit',
            desc: 'transport.mjs: split the retry helper out of the transport module',
            files: [join(cwd, 'transport.mjs')],
            ts: Date.now(),
            isError: false,
            isSignificant: true,
          },
        ],
        files: [join(cwd, 'transport.mjs')],
        filesRead: [],
        startedAt: Date.now(),
        lastAt: Date.now(),
      }),
    );

    // Fired exactly as spawnBackground('llm-episode', flushFile) does — the flush file is
    // argv[3], and without it the worker is a no-op.
    const r = await fire(process.execPath, [HOOK_PATH, 'llm-episode', flushFile], {
      cwd,
      env: WITH_MOCK_LLM,
      timeout: 60000,
    });
    expectSilentWorker('hook.mjs llm-episode', r);
    // Functional: the pre-saved row is upgraded IN PLACE from the LLM answer, and the flush
    // file is consumed (a leaked one is retried forever — the v2.x guard in handleLLMEpisode).
    const row = withDb((db) =>
      db
        .prepare('SELECT title, narrative, lesson_learned, concepts FROM observations WHERE id = ?')
        .get(savedId),
    );
    expect(row.title).toBe('Mock single observation');
    expect(row.narrative).toBe('Mock narrative from LLM extraction describing what happened.');
    expect(row.lesson_learned).toContain('Mock lesson');
    expect(row.concepts).toContain('mock-concept');
    expect(existsSync(flushFile)).toBe(false);

    await expectMalformedResilience(
      'hook.mjs llm-episode',
      { event: null, plainAllowed: false },
      (stdin, malCwd) => hookEvent('llm-episode', { cwd: malCwd, stdin, env: BG }),
    );
  });

  itHook('hook.mjs llm-summary', async () => {
    const NAME = 'hs-summary';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    const SESSION = 'hook-hooksweep-summary';
    // The worker summarizes a session's own observations (memory_session_id keyed) plus its
    // prompts, so the fixture is a completed session with one of each.
    withDb((db) => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
                  VALUES (?, ?, ?, ?, ?, 'completed')`,
      ).run(SESSION, SESSION, project, new Date(now).toISOString(), now);
      db.prepare(
        `INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
                  VALUES (?, ?, ?, ?, ?)`,
      ).run(SESSION, 'trace the widget cache invalidation race', 1, new Date(now).toISOString(), now);
      db.prepare(
        `INSERT INTO observations (memory_session_id, project, type, title, narrative, text, importance, created_at, created_at_epoch)
                  VALUES (?, ?, 'bugfix', ?, ?, ?, 2, ?, ?)`,
      ).run(
        SESSION,
        project,
        'Fixed the widget cache invalidation race',
        'Traced the race to a read-path invalidation and moved it to the write path.',
        'Traced the race to a read-path invalidation and moved it to the write path.',
        new Date(now).toISOString(),
        now,
      );
    });

    // handleLLMSummary takes its session id + project from argv — fired the way
    // spawnBackground('llm-summary', sessionId, project) does.
    const r = await fire(process.execPath, [HOOK_PATH, 'llm-summary', SESSION, project], {
      cwd,
      env: WITH_MOCK_LLM,
      timeout: 60000,
    });
    expectSilentWorker('hook.mjs llm-summary', r);
    // Functional: the session now has a persisted summary built from the LLM answer.
    const summary = withDb((db) =>
      db
        .prepare(
          'SELECT request, completed, next_steps, project FROM session_summaries WHERE memory_session_id = ?',
        )
        .get(SESSION),
    );
    expect(summary, 'llm-summary wrote no session_summaries row').toBeTruthy();
    expect(summary).toMatchObject({
      request: 'Mock session request description',
      completed: 'Mock accomplishments',
      next_steps: 'Mock suggested follow-up',
      project,
    });

    await expectMalformedResilience(
      'hook.mjs llm-summary',
      { event: null, plainAllowed: false },
      (stdin, malCwd) => hookEvent('llm-summary', { cwd: malCwd, stdin, env: BG }),
    );
  });

  itHook('hook.mjs llm-optimize', async () => {
    const NAME = 'hs-optimize';
    const cwd = workDir(NAME);
    // A wide-scope re-enrich candidate: bugfix, no lesson, narrative > 100 chars
    // (hook-optimize.mjs findReenrichCandidates). The daily worker passes scope 'wide'.
    const id = await seedObs(
      cwd,
      'Reworked the queue drain sequence so the flush waits for in-flight acknowledgements before closing the socket, which removed the intermittent truncation on shutdown.',
      ['--type', 'bugfix', '--project', 'hooksweep-optimize'],
    );
    expect(
      withDb((db) => db.prepare('SELECT optimized_at FROM observations WHERE id = ?').get(id)).optimized_at,
    ).toBeNull();

    const r = await hookEvent('llm-optimize', { cwd, stdin: '', env: WITH_MOCK_LLM, timeout: 60000 });
    expectSilentWorker('hook.mjs llm-optimize', r);
    // Functional: the candidate was re-enriched and stamped, so a later pass skips it.
    const row = withDb((db) =>
      db.prepare('SELECT lesson_learned, concepts, optimized_at FROM observations WHERE id = ?').get(id),
    );
    expect(row.lesson_learned).toContain('Mock lesson');
    expect(row.concepts).toContain('mock-concept');
    expect(typeof row.optimized_at).toBe('number');

    await expectMalformedResilience(
      'hook.mjs llm-optimize',
      { event: null, plainAllowed: false },
      (stdin, malCwd) => hookEvent('llm-optimize', { cwd: malCwd, stdin, env: BG }),
    );
  });

  itHook('hook.mjs enrich-save', async () => {
    const NAME = 'hs-enrich';
    const cwd = workDir(NAME);
    const id = await seedObs(cwd, 'Traced a flaky upload to an unclosed multipart stream in the uploader', [
      '--type',
      'bugfix',
      '--project',
      'hooksweep-enrich',
    ]);
    expect(
      withDb((db) =>
        db.prepare('SELECT lesson_learned, search_aliases FROM observations WHERE id = ?').get(id),
      ),
    ).toMatchObject({ lesson_learned: null, search_aliases: null });

    const r = await fire(process.execPath, [HOOK_PATH, 'enrich-save', String(id)], {
      cwd,
      env: WITH_MOCK_LLM,
      timeout: 60000,
    });
    expectSilentWorker('hook.mjs enrich-save', r);
    // Functional: the fill-only-empty backfill landed on the row the id names.
    const row = withDb((db) =>
      db.prepare('SELECT lesson_learned, search_aliases FROM observations WHERE id = ?').get(id),
    );
    expect(row.lesson_learned).toContain('Mock distilled lesson');
    expect(row.search_aliases).toContain('mock alias one');

    // The id arrives as argv, so the malformed arm covers a non-numeric id too.
    const badId = await fire(process.execPath, [HOOK_PATH, 'enrich-save', 'not-a-number'], { cwd, env: BG });
    expectSilentWorker('hook.mjs enrich-save (non-numeric id)', badId);
    await expectMalformedResilience(
      'hook.mjs enrich-save',
      { event: null, plainAllowed: false },
      (stdin, malCwd) =>
        fire(process.execPath, [HOOK_PATH, 'enrich-save', String(id)], { cwd: malCwd, stdin, env: BG }),
    );
  });

  itHook('hook.mjs auto-compress', async () => {
    const NAME = 'hs-compress';
    const cwd = workDir(NAME);
    const P = 'hooksweep-compress';
    // Compression needs >=3 rows of one project-week, >=60d old, importance <=1, lesson-free.
    for (const text of [
      'Renamed the changelog heading ahead of the quarterly audit',
      'Bumped the linter rule covering trailing commas in vendor files',
      'Removed an obsolete screenshot from the onboarding docs folder',
    ])
      await cli(['save', text, '--importance', '1', '--project', P], cwd);
    expect(ageProject(P, 90)).toBe(3);

    const r = await hookEvent('auto-compress', { cwd, stdin: '', env: BG, timeout: 60000 });
    expectSilentWorker('hook.mjs auto-compress', r);
    // Functional: the three originals now point at one weekly summary row.
    const rows = withDb((db) =>
      db.prepare('SELECT id, title, compressed_into FROM observations WHERE project = ?').all(P),
    );
    const compressed = rows.filter((o) => o.compressed_into);
    const survivors = rows.filter((o) => !o.compressed_into);
    expect(compressed).toHaveLength(3);
    expect(survivors).toHaveLength(1);
    expect(new Set(compressed.map((o) => o.compressed_into))).toEqual(new Set([survivors[0].id]));
    expect(survivors[0].title).toMatch(/^Weekly summary:/);

    await expectMalformedResilience(
      'hook.mjs auto-compress',
      { event: null, plainAllowed: false },
      (stdin, malCwd) => hookEvent('auto-compress', { cwd: malCwd, stdin, env: BG }),
    );
  });

  itHook('hook.mjs auto-maintain', async () => {
    const NAME = 'hs-maintain';
    const cwd = workDir(NAME);
    const P = 'hooksweep-maintain';
    const id = await seedObs(cwd, 'Stale row awaiting the idle decay sweep in maintenance', [
      '--importance',
      '1',
      '--project',
      P,
    ]);
    expect(ageProject(P, 90)).toBe(1);

    const r = await hookEvent('auto-maintain', { cwd, stdin: '', env: BG, timeout: 60000 });
    expectSilentWorker('hook.mjs auto-maintain', r);
    // Functional: the idle row is marked pending-purge, and the 24h gate file is stamped so
    // the next SessionStart does not re-run the sweep.
    expect(
      withDb((db) => db.prepare('SELECT compressed_into FROM observations WHERE id = ?').get(id))
        .compressed_into,
    ).toBe(COMPRESSED_PENDING_PURGE);
    const gate = JSON.parse(readFileSync(join(RUNTIME_DIR, 'last-auto-maintain.json'), 'utf8'));
    expect(Date.now() - gate.epoch).toBeLessThan(120000);

    await expectMalformedResilience(
      'hook.mjs auto-maintain',
      { event: null, plainAllowed: false },
      (stdin, malCwd) => hookEvent('auto-maintain', { cwd: malCwd, stdin, env: BG }),
    );
  });

  itHook('hook.mjs update-check', async () => {
    const NAME = 'hs-update';
    const cwd = workDir(NAME);
    const stateFile = join(RUNTIME_DIR, 'update-state.json');
    expect(existsSync(stateFile)).toBe(false);

    // Every fetch in these arms is refused IN-PROCESS: a CJS preload replaces globalThis.fetch
    // with a stub that records the URL and throws. Nothing leaves the machine — the stub IS
    // the network boundary — and that recording is what makes "did the release lookup happen?"
    // an observable question offline, which is what this case previously could not answer.
    const fetchLog = join(ROOT, 'update-check-fetches.txt');
    const offlineFetch = join(ROOT, 'offline-fetch.cjs');
    writeFileSync(
      offlineFetch,
      [
        "const fs = require('fs');",
        'globalThis.fetch = async (url) => {',
        "  try { fs.appendFileSync(process.env.SWEEP_FETCH_LOG, String(url) + '\\n'); } catch { /* best-effort */ }",
        "  throw new Error('offline: this sweep refuses every fetch');",
        '};',
        '',
      ].join('\n'),
    );
    // The blanked proxy vars are part of the network boundary, not hygiene: when a
    // proxy is configured hook-update takes the CONNECT tunnel, which does NOT go
    // through globalThis.fetch — so on a proxy-bound developer machine this stub
    // would be silently bypassed and the arms below would hit api.github.com.
    const OFFLINE = {
      SWEEP_FETCH_LOG: fetchLog,
      NODE_OPTIONS: `--require "${offlineFetch}"`,
      HTTPS_PROXY: '',
      https_proxy: '',
      HTTP_PROXY: '',
      http_proxy: '',
    };

    // This event is spawned in production as `spawnBackground('update-check')`, i.e. with
    // CLAUDE_MEM_HOOK_RUNNING=1. That used to kill it: `update-check` was missing from
    // hook.mjs's BG_EVENTS, so hook.mjs:116 exited the process before the dispatch switch,
    // which is why this case once stayed green with its handler deleted. Fixed as audit F6
    // (2026-08-14) — the production env is now pinned by
    // `tests/audit-findings-20260814.test.mjs` ("F6 — update-check reaches its handler under
    // the recursion guard"), which fires this event WITH the env var set. The arms below run
    // without BG and cover the handler's own behavior.
    //
    // (a) Skip flag honored: CLAUDE_MEM_SKIP_UPDATE=1 (set for the whole sweep) must suppress
    // the check — no release lookup at all, so no update-state.json and no banner.
    // FAILS IF: the `isDevMode() || CLAUDE_MEM_SKIP_UPDATE` early return goes away — the stub
    // then records the GitHub URLs and the state file appears.
    const r = await hookEvent('update-check', { cwd, stdin: '', env: OFFLINE, timeout: 60000 });
    expectSilentWorker('hook.mjs update-check', r);
    expect(
      existsSync(fetchLog),
      'update-check attempted a release lookup despite CLAUDE_MEM_SKIP_UPDATE=1',
    ).toBe(false);
    expect(
      existsSync(stateFile),
      'update-check wrote update-state.json despite CLAUDE_MEM_SKIP_UPDATE=1',
    ).toBe(false);

    // (b) The behavioral arm: flag CLEARED, so the handler runs its real no-release path.
    const live = await hookEvent('update-check', {
      cwd,
      stdin: '',
      timeout: 60000,
      env: { ...OFFLINE, CLAUDE_MEM_SKIP_UPDATE: undefined }, // childEnv drops undefined keys
    });
    expectSilentWorker('hook.mjs update-check (offline)', live);

    // It reached hook-update's release lookup — the releases/latest call first, then the
    // tags fallback the null result triggers. FAILS IF: the dispatch case is deleted or
    // stops calling checkForUpdate (no file at all), or the lookup changes endpoint.
    expect(
      existsSync(fetchLog),
      'update-check made no release lookup at all — the handler never ran (deleted case? recursion guard?)',
    ).toBe(true);
    const urls = readFileSync(fetchLog, 'utf8').trim().split('\n');
    expect(urls[0]).toBe('https://api.github.com/repos/sdsrss/claude-mem-lite/releases/latest');
    expect(urls[1]).toMatch(/^https:\/\/api\.github\.com\/repos\/sdsrss\/claude-mem-lite\/tags\b/);
    expect(urls).toHaveLength(2);
    // …and persisted the attempt into the SANDBOX state file (absent one assertion earlier),
    // with a timestamp from this run. FAILS IF: the no-release path stops stamping lastCheck
    // — every session would then re-fetch, the 24h throttle silently dead.
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(
      Date.now() - new Date(state.lastCheck).getTime(),
      `update-state.json carries no fresh lastCheck: ${JSON.stringify(state)}`,
    ).toBeLessThan(120000);
    // No install may have been attempted off a failed lookup (the worker CAN install when it
    // is not in plugin mode, and this arm runs with CLAUDE_PLUGIN_ROOT unset).
    expect(
      existsSync(join(HOME_DIR, '.claude-mem-lite', 'package.json')),
      'a failed release lookup still touched the install dir',
    ).toBe(false);

    await expectMalformedResilience(
      'hook.mjs update-check',
      { event: null, plainAllowed: false },
      (stdin, malCwd) => hookEvent('update-check', { cwd: malCwd, stdin, env: BG }),
    );
  });
});

// ─── The standalone hook scripts (these never go through hook.mjs) ──────────────────
// v3.60.0 shipped a self-heal that only covered hook.mjs, because these five entry points
// bypass it entirely — which is exactly why they get their own per-surface pass here.

describe('hook feature sweep: standalone hook scripts', () => {
  itHook('scripts/pre-tool-recall.js', async () => {
    const NAME = 'hs-pretool';
    const cwd = workDir(NAME);
    const target = join(cwd, 'widget-cache.mjs');
    writeFileSync(target, 'export function writeWidget() {\n  invalidateWidgetCache();\n}\n');
    const LESSON = 'Always call invalidateWidgetCache after a write, never on read';
    const id = await seedObs(cwd, 'Fixed the widget cache invalidation race', [
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      LESSON,
      '--files',
      target,
    ]);

    const r = await hookScript('pre-tool-recall.js', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-pretool',
        tool_name: 'Edit',
        tool_input: { file_path: target, old_string: 'invalidateWidgetCache()', new_string: 'noop()' },
      }),
    });
    expect(r.code, `pre-tool-recall exited ${r.code}\n${r.stderr}`).toBe(0);
    const [envelope] = expectHookStdout(r.stdout, {
      event: 'PreToolUse',
      plainAllowed: false,
      label: 'scripts/pre-tool-recall.js',
    });
    expect(envelope, `no PreToolUse envelope emitted:\n${r.stdout}`).toBeTruthy();
    // Functional: the file's own lesson reaches the agent before the edit, with its id.
    const ctx = envelope.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Lessons for widget-cache.mjs');
    expect(ctx).toContain(`#${id}`);
    expect(ctx).toContain(LESSON);
    // …and the session-scoped cooldown was written to the SANDBOX runtime dir, carrying the
    // ids the episode-flush cite-back hint later reads.
    const cooldown = JSON.parse(
      readFileSync(join(RUNTIME_DIR, 'pre-recall-cooldown-cc-hooksweep-pretool.json'), 'utf8'),
    );
    expect(cooldown[target].lessonIds).toContain(id);
    expect(cooldown[target].mode).toBe('edit');

    await expectMalformedResilience(
      'scripts/pre-tool-recall.js',
      { event: 'PreToolUse', plainAllowed: false },
      (stdin, malCwd) => hookScript('pre-tool-recall.js', { cwd: malCwd, stdin }),
    );
  });

  itHook('scripts/post-tool-recall.js', async () => {
    const NAME = 'hs-postrecall';
    const cwd = workDir(NAME);
    const target = join(cwd, 'widget-cache.mjs');
    writeFileSync(target, 'export function writeWidget() {\n  invalidateWidgetCache();\n}\n');
    const id = await seedObs(cwd, 'Fixed the widget cache invalidation race', [
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      'Always call invalidateWidgetCache after a write, never on read',
      '--files',
      target,
    ]);
    const BIND = { CLAUDE_MEM_SALIENCE: 'bind' };
    const stdin = JSON.stringify({
      session_id: 'cc-hooksweep-bind',
      tool_name: 'Edit',
      tool_input: { file_path: target, old_string: 'invalidateWidgetCache()', new_string: 'noop()' },
    });

    // The pre-edit half records which identifiers the lesson names AND the file still has;
    // driving the real sibling (not a hand-written cooldown) is what makes this a check of
    // the pair rather than of this script's parser.
    const pre = await hookScript('pre-tool-recall.js', { cwd, stdin, env: BIND });
    expect(pre.code).toBe(0);
    // Now perform the edit the lesson warns about: the flagged identifier is gone.
    writeFileSync(target, 'export function writeWidget() {\n  noop();\n}\n');

    const r = await hookScript('post-tool-recall.js', { cwd, stdin, env: BIND });
    expect(r.code, `post-tool-recall exited ${r.code}\n${r.stderr}`).toBe(0);
    const [envelope] = expectHookStdout(r.stdout, {
      event: 'PostToolUse',
      plainAllowed: false,
      label: 'scripts/post-tool-recall.js',
    });
    expect(envelope, `no PostToolUse envelope emitted:\n${r.stdout}`).toBeTruthy();
    expect(envelope.hookSpecificOutput.additionalContext).toContain('dropped `invalidateWidgetCache`');
    expect(envelope.hookSpecificOutput.additionalContext).toContain(`#${id}`);

    // Default salience is not `bind`, and the whole surface is off then — silence, not noise.
    const off = await hookScript('post-tool-recall.js', { cwd, stdin });
    expect(off.code).toBe(0);
    expect(off.stdout).toBe('');

    await expectMalformedResilience(
      'scripts/post-tool-recall.js',
      { event: 'PostToolUse', plainAllowed: false },
      (stdinPayload, malCwd) =>
        hookScript('post-tool-recall.js', { cwd: malCwd, stdin: stdinPayload, env: BIND }),
    );
  });

  itHook('scripts/pre-skill-bridge.js', async () => {
    const NAME = 'hs-skill';
    const cwd = workDir(NAME);
    const BODY = 'HOOKSWEEPSKILLBODY — the managed skill body must reach the caller verbatim.';
    const skillDir = join(DATA_DIR, 'managed', 'skills', 'hooksweep-skill');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(
      skillPath,
      `---\nname: hooksweep-skill\ndescription: hook sweep fixture skill\n---\n\n${BODY}\n`,
    );
    await cli(
      [
        'registry',
        'import',
        '--name',
        'hooksweep-skill',
        '--resource-type',
        'skill',
        '--local-path',
        skillPath,
        '--capability-summary',
        'hook sweep fixture skill',
      ],
      cwd,
    );

    const r = await hookScript('pre-skill-bridge.js', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-skill',
        tool_name: 'Skill',
        tool_input: { skill: 'hooksweep-skill' },
      }),
    });
    expect(r.code, `pre-skill-bridge exited ${r.code}\n${r.stderr}`).toBe(0);
    const [envelope] = expectHookStdout(r.stdout, {
      event: 'PreToolUse',
      plainAllowed: false,
      label: 'scripts/pre-skill-bridge.js',
    });
    expect(envelope, `no PreToolUse envelope emitted:\n${r.stdout}`).toBeTruthy();
    const ctx = envelope.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('<skill-bridge name="hooksweep-skill" source="managed">');
    expect(ctx).toContain(BODY); // file contents, not just a pointer
    expect(ctx).toContain('</skill-bridge>');

    // A skill the registry does not know must stay silent — the bridge only intercepts
    // managed skills, and a stray envelope here would shadow Claude Code's own Skill load.
    const unknown = await hookScript('pre-skill-bridge.js', {
      cwd,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-skill',
        tool_name: 'Skill',
        tool_input: { skill: 'zqxwvrunk' },
      }),
    });
    expect(unknown.code).toBe(0);
    expect(unknown.stdout).toBe('');

    await expectMalformedResilience(
      'scripts/pre-skill-bridge.js',
      { event: 'PreToolUse', plainAllowed: false },
      (stdin, malCwd) => hookScript('pre-skill-bridge.js', { cwd: malCwd, stdin }),
    );
  });

  // Registered surface is the PREFILTER (audit P2-5): hooks.json names the .sh, which
  // execs the .js only when CLAUDE_MEM_SUBAGENT_INJECT is on. Firing the .js directly here
  // would sweep a path Claude Code no longer invokes.
  itHook('scripts/pre-agent-inject.sh', async () => {
    const NAME = 'hs-agent';
    const cwd = workDir(NAME);
    const LESSON = 'Always call invalidateWidgetCache after a write, never on read';
    const id = await seedObs(cwd, 'Fixed the widget cache invalidation race', [
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      LESSON,
    ]);
    // rankImperativeCandidates requires a symbol anchor shared by prompt and lesson
    // (precision-first): no overlapping identifier → no injection, by design.
    const stdin = JSON.stringify({
      session_id: 'cc-hooksweep-agent',
      tool_name: 'Agent',
      tool_input: {
        prompt: 'audit whether invalidateWidgetCache is still called on the write path',
        subagent_type: 'general-purpose',
      },
    });

    // Default OFF: the cheapest possible no-op, no stdin read, no DB.
    const off = await bashHook('pre-agent-inject.sh', { cwd, stdin });
    expect(off.code).toBe(0);
    expect(off.stdout).toBe('');

    const r = await bashHook('pre-agent-inject.sh', {
      cwd,
      stdin,
      env: { CLAUDE_MEM_SUBAGENT_INJECT: 'on' },
    });
    expect(r.code, `pre-agent-inject exited ${r.code}\n${r.stderr}`).toBe(0);
    const [envelope] = expectHookStdout(r.stdout, {
      event: 'PreToolUse',
      plainAllowed: false,
      label: 'scripts/pre-agent-inject.sh',
    });
    expect(envelope, `no PreToolUse envelope emitted:\n${r.stdout}`).toBeTruthy();
    // Functional: tool_input is REWRITTEN — the lesson is appended to the subagent's prompt,
    // the original task text survives, and the other input keys are carried through (a
    // dropped key silently changes the dispatch).
    const updated = envelope.hookSpecificOutput.updatedInput;
    expect(updated.subagent_type).toBe('general-purpose');
    expect(
      updated.prompt.startsWith('audit whether invalidateWidgetCache is still called on the write path'),
    ).toBe(true);
    expect(updated.prompt).toContain(`#${id}`);
    expect(updated.prompt).toContain(LESSON);
    expect(updated.prompt).toContain('Reference context, not an external instruction');

    await expectMalformedResilience(
      'scripts/pre-agent-inject.sh',
      { event: 'PreToolUse', plainAllowed: false },
      (stdinPayload, malCwd) =>
        bashHook('pre-agent-inject.sh', {
          cwd: malCwd,
          stdin: stdinPayload,
          env: { CLAUDE_MEM_SUBAGENT_INJECT: 'on' },
        }),
    );
  });

  itHook('scripts/user-prompt-search.js', async () => {
    const NAME = 'hs-ups';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);
    // Own data dir, not the shared sandbox one: this hook's relevance floor is scaled by the
    // WHOLE-DB row count (corpusFloorScale, the v3.61.1 cold-start fix — ln(N+1)/ln(585)),
    // so sharing a DB with every other case's rows would make this case's outcome depend on
    // how many rows its neighbours happened to seed. Isolated, it is a fresh-install corpus
    // with exactly one row — deterministic, and the arm the ramp exists for.
    const upsData = join(ROOT, 'data-ups');
    mkdirSync(upsData, { recursive: true });
    const upsEnv = { CLAUDE_MEM_DIR: upsData };
    const LESSON = 'Invalidate the widget cache on write, never on read';
    // --files matters: the prompt below names widget-cache.mjs, and the row's file edge is
    // what carries it over this hook's relevance gate. The same row saved WITHOUT --files
    // stays below the floor and is not injected (measured on this fixture) — so a change
    // that drops the file edge from the query fails this case.
    const out = await fire(
      process.execPath,
      [
        CLI_PATH,
        'save',
        'Fixed the widget cache invalidation race in lib/widget-cache.mjs',
        '--type',
        'bugfix',
        '--importance',
        '3',
        '--lesson',
        LESSON,
        '--files',
        join(cwd, 'widget-cache.mjs'),
      ],
      { cwd, env: upsEnv },
    );
    expect(out.code, `seed save exited ${out.code}\n${out.stderr}`).toBe(0);
    const id = Number(out.stdout.match(/Saved #(\d+)/)[1]);

    const r = await hookScript('user-prompt-search.js', {
      cwd,
      env: upsEnv,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-ups',
        prompt: 'why does the widget cache invalidation race happen in widget-cache.mjs',
      }),
    });
    expect(r.code, `user-prompt-search exited ${r.code}\n${r.stderr}`).toBe(0);
    // UserPromptSubmit delivers on the plain-text channel; a JSON envelope here would be a
    // channel change, not a formatting one.
    expectHookStdout(r.stdout, { event: null, plainAllowed: true, label: 'scripts/user-prompt-search.js' });
    expect(r.stdout).toContain('[mem] FYI — Related memories');
    expect(r.stdout).toContain(`#${id}`);
    expect(r.stdout).toContain('Invalidate the widget cache on write');
    // The injected ids are recorded so the sibling hook.mjs user-prompt pass and the next
    // prompt inside the dedup window do not re-inject the same rows.
    // D#120: the marker file is session-keyed — one file per CC session.
    const injected = JSON.parse(
      readFileSync(join(upsData, 'runtime', `.claude-mem-injected-${project}-cc-hooksweep-ups`), 'utf8'),
    );
    expect(injected.ids).toContain(id);

    await expectMalformedResilience(
      'scripts/user-prompt-search.js',
      { event: null, plainAllowed: true },
      (stdin, malCwd) => hookScript('user-prompt-search.js', { cwd: malCwd, stdin, env: upsEnv }),
    );
  });

  itHook('scripts/post-tool-use.sh', async () => {
    const NAME = 'hs-prefilter';
    const cwd = workDir(NAME);
    const project = projectOf(NAME);

    // (a) Read: the ~5ms fast path records the file for episode context and returns without
    // ever launching Node. The path lands in the SANDBOX runtime dir (CLAUDE_MEM_DIR-aware),
    // under the project bash derives the same way inferProject() does.
    const read = await bashPrefilter({
      cwd,
      stdin: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/repo/lib/widget-cache.mjs' } }),
    });
    expect(read.code).toBe(0);
    expect(read.stdout).toBe('');
    expect(
      readFileSync(join(RUNTIME_DIR, `reads-${project}.txt`), 'utf8')
        .trim()
        .split('\n'),
    ).toContain('/repo/lib/widget-cache.mjs');

    // (b) A skip-listed tool costs nothing and reaches neither Node nor the episode buffer.
    const skipped = await bashPrefilter({
      cwd,
      stdin: JSON.stringify({
        tool_name: 'Glob',
        tool_input: { pattern: '**/*.mjs' },
        tool_response: 'a.mjs\nb.mjs',
      }),
    });
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).toBe('');
    expect(existsSync(join(RUNTIME_DIR, `ep-${project}.json`))).toBe(false);

    // (c) A non-skipped tool hands the SAME stdin off to Node — the handoff this prefilter
    // exists to make, and the one place a shell-quoting slip would silently drop every
    // observation. Proof it arrived: the episode buffer now holds the entry.
    const editPayload = JSON.stringify({
      session_id: 'cc-hooksweep-prefilter',
      tool_name: 'Edit',
      tool_input: {
        file_path: join(cwd, 'transport.mjs'),
        old_string: 'retry()',
        new_string: 'retryWithBackoff()',
      },
      tool_response: 'The file has been updated successfully with the new content applied.',
    });
    const handoff = await bashPrefilter({ cwd, stdin: editPayload, timeout: 60000 });
    expect(handoff.code, `prefilter handoff exited ${handoff.code}\n${handoff.stderr}`).toBe(0);
    // Buffering an Edit is SILENT (same contract the sibling `hook.mjs post-tool-use` case
    // pins), so on this payload "exactly the envelope" means exactly nothing. Stated as an
    // equality rather than left to expectHookStdout, which can only reject lines it sees.
    expect(handoff.stdout, `buffering an Edit must stay silent, got:\n${handoff.stdout}`).toBe('');
    const episode = JSON.parse(readFileSync(join(RUNTIME_DIR, `ep-${project}.json`), 'utf8'));
    expect(episode.entries.map((e) => e.tool)).toEqual(['Edit']);
    expect(episode.entries[0].files).toContain(join(cwd, 'transport.mjs'));

    // (d) …which is exactly why the envelope half of the contract needs a payload that MUST
    // produce one. A failing test command is a hard error → hook.mjs answers with the
    // error-recall PostToolUse envelope, and this prefilter has to carry Node's stdout back
    // to the host verbatim. Absence is the failure mode this arm exists for: on (c)'s empty
    // stdout, `node … >/dev/null` at the tail of post-tool-use.sh — or a handoff that never
    // launched Node at all — satisfies expectHookStdout without emitting anything.
    const recallId = await seedObs(cwd, 'Fixed the widget cache invalidation race in lib/widget-cache.mjs', [
      '--type',
      'bugfix',
      '--importance',
      '3',
      '--lesson',
      'Invalidate the widget cache on write, never on read',
    ]);
    const errHandoff = await bashPrefilter({
      cwd,
      timeout: 60000,
      stdin: JSON.stringify({
        session_id: 'cc-hooksweep-prefilter',
        tool_name: 'Bash',
        tool_input: { command: 'node --test widget-cache.test.mjs' },
        tool_response:
          'FAIL widget-cache.test.mjs\nError: widget cache invalidation race detected\nnpm ERR! Test failed. See above for more details.',
      }),
    });
    expect(errHandoff.code, `prefilter error handoff exited ${errHandoff.code}\n${errHandoff.stderr}`).toBe(
      0,
    );
    const envelopes = expectHookStdout(errHandoff.stdout, {
      event: 'PostToolUse',
      plainAllowed: false,
      label: 'scripts/post-tool-use.sh (Node handoff)',
    });
    expect(
      envelopes,
      `the prefilter delivered no envelope — Node's stdout did not reach the host: ${JSON.stringify(errHandoff.stdout)}`,
    ).toHaveLength(1);
    const ctx = envelopes[0].hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Related memories found for this error');
    expect(ctx).toContain(`#${recallId}`);

    await expectMalformedResilience(
      'scripts/post-tool-use.sh',
      { event: 'PostToolUse', plainAllowed: false },
      (stdin, malCwd) => bashPrefilter({ cwd: malCwd, stdin }),
    );
  });
});
