// Regression pins for the 5 product defects the 2026-08-14 feature sweep surfaced
// (tests/feature-sweep-{cli,mcp,hooks}.test.mjs found them; this file is where each
// FIXED behavior is nailed down so it cannot silently reopen).
//
// One describe per finding, named F1..F7 after the audit report:
//   F1  mem_use substituted a DIFFERENT skill's body on a name miss (HIGH)
//   F2  optimize preview printed two spellings of the same line (MCP vs CLI)
//   F3  mem_save `files` was described as "associated" but rendered as "modified"
//   F4  three hook-llm debugLog calls passed 2 args to a 3-arg signature
//   F5  a non-string tool_name threw a swallowed TypeError in the PostToolUse hook
//   F6  the detached update-check worker exited on the recursion guard before dispatch
//   F7  mem_use echoed a caller-crafted name verbatim, forging a <skill-loaded> block
//
// Every case states, in a comment, the input that makes it fail — an assertion whose
// failing input nobody can name is not a test.
//
// ISOLATION: every spawned process gets CLAUDE_MEM_DIR + HOME pointed at a mkdtemp
// sandbox, and a cwd inside it, so nothing can reach the live ~/.claude-mem-lite DB or
// write into this repo. The sandbox is removed in an afterAll `finally`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createTestDb, insertSession } from './test-helpers.mjs';
import { saveObservation } from '../hook-llm.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO, 'hook.mjs');
const CLI_PATH = join(REPO, 'cli.mjs');
const SERVER_PATH = join(REPO, 'server.mjs');

// ─── Sandbox shared by the subprocess-driven cases ─────────────────────────────────

let ROOT, HOME_DIR, BASE_ENV;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-audit0814-'));
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

/**
 * Spawn server.mjs over the real JSON-RPC stdio transport, pointed at `dataDir` with
 * `cwd` as its only project source. Caller closes both handles.
 */
async function startMcp(dataDir, cwd) {
  const env = { ...BASE_ENV, CLAUDE_MEM_DIR: dataDir, MEM_QUIET_HOOKS: '1', CLAUDE_MEM_AUTO_DEEP: '0' };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], cwd, env });
  const client = new Client({ name: 'mem-audit0814-client', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Join the text blocks of a tools/call result (isError results included, for F1). */
const textOf = (res) =>
  (res?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

// ─── F4 — hook-llm's three write-side noise diagnostics ────────────────────────────
// utils.mjs debugLog(level, context, msg) takes THREE args. hook-llm.mjs:159/175/185
// passed two, so the level slot held the context and the message slot was `undefined`:
// the line rendered as "[saveObservation] <title>: undefined" and could not be filtered
// by level. 11 other call sites in the same file already passed three.

describe('F4 — write-side noise-gate diagnostics log at a real level with a real message', () => {
  const DEBUG_LINE = /^\[claude-mem-lite\] \[[^\]]+\] \[(DEBUG|WARN|ERROR)\] ([^:]+): (.+)$/;
  let db, errSpy, prevDebug;

  beforeEach(() => {
    prevDebug = process.env.CLAUDE_MEM_DEBUG;
    process.env.CLAUDE_MEM_DEBUG = '1'; // debugLog is gated on this
    db = createTestDb();
    insertSession(db, { id: 'sess-f4', project: 'test' });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    db.close();
    if (prevDebug === undefined) delete process.env.CLAUDE_MEM_DEBUG;
    else process.env.CLAUDE_MEM_DEBUG = prevDebug;
  });

  /** The one line the given drop produced, split into level / context / message. */
  function soleDiagnostic() {
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    expect(lines, `expected exactly one debugLog line, got:\n${lines.join('\n')}`).toHaveLength(1);
    const m = lines[0].match(DEBUG_LINE);
    expect(m, `debugLog line does not match the utils.mjs format:\n${lines[0]}`).toBeTruthy();
    return { level: m[1], context: m[2], message: m[3], raw: lines[0] };
  }

  // FAILS IF: the call reverts to debugLog('saveObservation', msg) — then level='saveObservation'
  // (not in the DEBUG|WARN|ERROR alternation) so DEBUG_LINE does not match at all.
  it('drop-as-noise names its level, its context and the dropped title', () => {
    // isNoiseObservation: LOW_SIGNAL title pattern, no lesson, no facts, importance<2.
    const id = saveObservation(
      { type: 'change', title: 'Modified widget-cache.mjs', narrative: 'edited it', importance: 1 },
      'test',
      'sess-f4',
      db,
    );
    expect(id).toBeNull(); // it really took the drop branch
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('dropped noise: Modified widget-cache.mjs');
  });

  // FAILS IF: the message argument is dropped again — `message` would then be 'undefined'.
  it('drop-as-low-yield-change names its level, its context and the dropped title', () => {
    const id = saveObservation(
      {
        type: 'change',
        title: 'Adjusted the retry backoff in the API client',
        narrative: 'edited the client',
        importance: 1,
        lessonLearned: null,
      },
      'test',
      'sess-f4',
      db,
    );
    expect(id).toBeNull();
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('dropped low-yield change: Adjusted the retry backoff in the API client');
  });

  // FAILS IF: the importance-cap diagnostic loses its message — the before→after numbers
  // are the whole payload of this line.
  it('importance-cap names its level, its context and the before→after importance', () => {
    // capNoiseImportance: a LOW_SIGNAL title that escaped BOTH drop gates on importance>=2
    // alone (no lesson, no facts) is written, but demoted to importance 1.
    const id = saveObservation(
      { type: 'discovery', title: 'Modified transport.mjs', narrative: 'edited it', importance: 3 },
      'test',
      'sess-f4',
      db,
    );
    expect(id).toBeGreaterThan(0);
    expect(db.prepare('SELECT importance FROM observations WHERE id = ?').get(id).importance).toBe(1);
    const { level, context, message } = soleDiagnostic();
    expect(level).toBe('DEBUG');
    expect(context).toBe('saveObservation');
    expect(message).toBe('capped imp 3→1: Modified transport.mjs');
  });
});

// ─── F5 — a non-string tool_name in the PostToolUse payload ────────────────────────
// hook.mjs:302 guarded `if (!tool_name) return;` (falsiness only), then called
// tool_name.startsWith(p) two lines down. A number/object/array tool_name therefore threw
// a TypeError that the top-level catch absorbed: exit 0, clean stdout, and NO attributable
// record — a host field-shape change would have silently killed every observation with
// nothing to find. The guard now matches scripts/pre-skill-bridge.js:43 (typeof check) and
// routes the case to the telemetry log instead of a swallowed throw.

describe('F5 — a non-string tool_name is recorded, not thrown-and-swallowed', () => {
  const HOOK_ERROR_SCOPE = 'post-tool-use:tool_name-type';
  let dataDir, runtimeDir, cwd;

  /** All hook-error records written under this case's runtime dir. */
  function hookErrorRecords() {
    const dir = join(runtimeDir, 'hook-errors');
    if (!existsSync(dir)) return [];
    const shard = join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');
    if (!existsSync(shard)) return [];
    return readFileSync(shard, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  const post = (payload) =>
    fire(process.execPath, [HOOK_PATH, 'post-tool-use'], {
      cwd,
      stdin: JSON.stringify(payload),
      env: { CLAUDE_MEM_DIR: dataDir },
    });

  beforeEach(() => {
    // Own data dir per case so the hook-errors shard holds only this case's records.
    const slug = 'f5-' + Math.random().toString(36).slice(2, 8);
    dataDir = sandboxDir('data-' + slug);
    runtimeDir = join(dataDir, 'runtime');
    cwd = sandboxDir('work', slug);
  });

  // FAILS IF: the typeof guard is removed — tool_name.startsWith then throws, the top-level
  // catch prints "[ERROR] post-tool-use: tool_name.startsWith is not a function" to stderr
  // and writes no record, so BOTH the stderr assertion and the record assertion red.
  it('records the malformed field instead of throwing a TypeError into the void', async () => {
    const r = await post({
      session_id: 'cc-f5-number',
      tool_name: 42,
      tool_input: { file_path: join(cwd, 'widget-cache.mjs') },
      tool_response: 'The file has been updated successfully with the new content applied.',
    });
    expect(r.code, `hook exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toBe(''); // host-visible channel stays clean
    expect(r.stderr).not.toMatch(/is not a function|TypeError/); // the throw is gone

    const records = hookErrorRecords();
    expect(
      records.map((x) => x.scope),
      `no ${HOOK_ERROR_SCOPE} record:\n${JSON.stringify(records)}`,
    ).toContain(HOOK_ERROR_SCOPE);
    const rec = records.find((x) => x.scope === HOOK_ERROR_SCOPE);
    expect(rec.ctx, 'the record must name the type that arrived, else it is unactionable').toMatch(/number/);
  });

  // Array and object shapes take the same path (an array's .startsWith is also undefined),
  // so the guard cannot be a number-only special case.
  // FAILS IF: the guard is narrowed to `typeof tool_name === 'number'`.
  it('covers the array and object shapes too', async () => {
    for (const shape of [['Edit'], { name: 'Edit' }]) {
      const r = await post({
        session_id: 'cc-f5-shape',
        tool_name: shape,
        tool_input: {},
        tool_response: 'ok',
      });
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/is not a function|TypeError/);
    }
    expect(hookErrorRecords().filter((x) => x.scope === HOOK_ERROR_SCOPE)).toHaveLength(2);
  });

  // The counter-case: a well-formed payload must NOT produce a telemetry record. Without
  // this, an unconditional recordHookError call would pass the two cases above.
  // FAILS IF: the guard is written without the typeof test (e.g. always record).
  it('a well-formed string tool_name writes no hook-error record', async () => {
    const r = await post({
      session_id: 'cc-f5-ok',
      tool_name: 'Edit',
      tool_input: { file_path: join(cwd, 'widget-cache.mjs'), old_string: 'a', new_string: 'b' },
      tool_response: 'The file has been updated successfully with the new content applied.',
    });
    expect(r.code, `hook exited ${r.code}\n${r.stderr}`).toBe(0);
    // Proof the payload really reached the capture path (so the "no record" claim is about a
    // handled payload, not about a payload the hook ignored for some other reason).
    const episode = JSON.parse(
      readFileSync(join(runtimeDir, `ep-${'work--' + cwd.split('/').pop()}.json`), 'utf8'),
    );
    expect(episode.entries.map((e) => e.tool)).toEqual(['Edit']);
    expect(hookErrorRecords()).toEqual([]);
  });
});

// ─── F3 — `files` was described as "associated", rendered as "modified" ────────────
// tool-schemas.mjs:209 described mem_save's `files` as "File paths associated with this
// observation", but lib/save-observation.mjs:117 stores it in `files_modified` and both
// `get` paths rendered the raw column name — so a file the caller only READ came back
// labelled as modified. Per the F3 decision this is a prose/label fix: no column rename,
// no new field, no migration. The label the reader sees is now `files`, matching the
// input parameter's own name; `--fields files_modified` still selects it by column.

describe('F3 — an attached file is not rendered as a modification', () => {
  let dataDir, cwd;
  const readOnlyFile = () => join(cwd, 'widget-cache.mjs');

  const run = (args) =>
    fire(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { CLAUDE_MEM_DIR: dataDir },
    });

  beforeEach(() => {
    const slug = 'f3-' + Math.random().toString(36).slice(2, 8);
    dataDir = sandboxDir('data-' + slug);
    cwd = sandboxDir('work', slug);
  });

  // FAILS IF: the render label goes back to the raw column name — `files_modified: [...]`
  // matches the negative assertion, and the `files: [...]` line the positive one looks for
  // is not emitted.
  it('CLI get labels an attached path `files`, never `files_modified`', async () => {
    const saved = await run([
      'save',
      'Reviewed the retry backoff implementation before touching it',
      '--type',
      'discovery',
      '--files',
      readOnlyFile(),
    ]);
    expect(saved.code, saved.stderr).toBe(0);
    const id = Number(saved.stdout.match(/Saved #(\d+)/)[1]);

    const got = await run(['get', String(id)]);
    expect(got.code, got.stderr).toBe(0);
    expect(got.stdout).toContain(`files: ["${readOnlyFile()}"]`);
    expect(got.stdout, 'a file that was only read must not be labelled modified').not.toMatch(
      /^files_modified:/m,
    );
  });

  // The column name stays the selector (no rename, per the F3 decision), so a caller who
  // asks for it by column still gets the row — under the honest label.
  // FAILS IF: the fix renamed the column or dropped it from OBS_FIELDS — `--fields
  // files_modified` would then be rejected as an unknown field and print nothing.
  it('--fields files_modified still selects the column and renders the new label', async () => {
    const saved = await run([
      'save',
      'Read through the transport module to map its retries',
      '--type',
      'discovery',
      '--files',
      readOnlyFile(),
    ]);
    const id = Number(saved.stdout.match(/Saved #(\d+)/)[1]);

    const got = await run(['get', String(id), '--fields', 'files_modified']);
    expect(got.code, got.stderr).toBe(0);
    expect(got.stderr).not.toMatch(/Unknown field/);
    expect(got.stdout).toContain(`files: ["${readOnlyFile()}"]`);
  });

  // FAILS IF: the schema description reverts to "File paths associated with this
  // observation" — it then names neither the column the value lands in nor the fact that
  // passing a path is not a claim the file was edited.
  it('the mem_save schema says where the value lands and what it does not claim', async () => {
    const { memSaveSchema } = await import('../tool-schemas.mjs');
    const description = memSaveSchema.files.description;
    expect(description).toContain('files_modified');
    expect(description).toMatch(/not assert|does not claim|not a claim/i);
  });
});

// ─── F2 — one preview, two spellings ───────────────────────────────────────────────
// server.mjs:1305-1306 printed "Cluster-merge candidates: N clusters" /
// "Smart-compress candidates: N clusters" while mem-cli.mjs:3122-3123 printed
// "Cluster-merge: N clusters" / "Smart-compress: N clusters" — the same optimizePreview()
// numbers under two labels, so a doc, a grep or a user's mental model that fits one
// surface misses the other. Converged on the MCP spelling: the sibling line
// "Re-enrich candidates: N" already read that way on BOTH surfaces.

describe('F2 — the optimize preview reads the same on the CLI and over MCP', () => {
  let dataDir, cwd, client, transport;

  /** The indented body lines of a preview block, as [label, rest] pairs. */
  function previewFields(text) {
    return text
      .split('\n')
      .filter((l) => /^\s{2,}\S/.test(l) && l.includes(':'))
      .map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      });
  }

  beforeAll(async () => {
    dataDir = sandboxDir('data-f2');
    cwd = sandboxDir('work', 'f2');
    // Rows the preview can count: re-enrich candidates are lesson-free bugfixes with a
    // narrative over 100 chars, so the numbers below are non-zero on both surfaces and a
    // label assertion cannot pass against an empty block.
    for (const text of [
      'Reworked the queue drain sequence so the flush waits for in-flight acknowledgements before closing the socket, which removed the intermittent truncation on shutdown.',
      'Traced the retry backoff reset to every redirect hop, so a long redirect chain never backed off and hammered the upstream until the circuit breaker tripped open.',
    ]) {
      const r = await fire(process.execPath, [CLI_PATH, 'save', text, '--type', 'bugfix'], {
        cwd,
        env: { CLAUDE_MEM_DIR: dataDir },
      });
      expect(r.code, r.stderr).toBe(0);
    }
    ({ client, transport } = await startMcp(dataDir, cwd));
  }, 60000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* already gone */
    }
    try {
      await transport?.close();
    } catch {
      /* already gone */
    }
  });

  // FAILS IF: either surface changes a label without the other — the two label lists are
  // read from two independently produced real outputs, so neither side can be edited into
  // agreement on its own. (Verified by mutation: reverting mem-cli.mjs to "Cluster-merge:"
  // reds this with ['Cluster-merge'] vs ['Cluster-merge candidates'].)
  it('both surfaces label the preview identically, using the `candidates` spelling', async () => {
    const cliRun = await fire(process.execPath, [CLI_PATH, 'optimize'], {
      cwd,
      env: { CLAUDE_MEM_DIR: dataDir },
    });
    expect(cliRun.code, cliRun.stderr).toBe(0);
    const mcpRun = textOf(await client.callTool({ name: 'mem_optimize', arguments: { action: 'preview' } }));

    const cliFields = previewFields(cliRun.stdout);
    const mcpFields = previewFields(mcpRun);
    expect(cliFields.length, `no preview body parsed from the CLI output:\n${cliRun.stdout}`).toBeGreaterThan(
      3,
    );
    expect(cliFields.map(([label]) => label)).toEqual(mcpFields.map(([label]) => label));
    expect(cliFields.map(([label]) => label)).toContain('Cluster-merge candidates');
    expect(cliFields.map(([label]) => label)).toContain('Smart-compress candidates');

    // The two drift-prone lines carry no surface-specific decoration, so their VALUES must
    // match too — same optimizePreview() data, same rendering.
    const pick = (fields, label) => fields.find(([l]) => l === label)?.[1];
    for (const label of ['Cluster-merge candidates', 'Smart-compress candidates', 'Total']) {
      expect(pick(cliFields, label), `${label} disagrees across surfaces`).toBe(pick(mcpFields, label));
    }
    // …and the seeded rows really are counted, so the labels above were not read off an
    // all-zero block that any spelling would satisfy.
    expect(Number(pick(cliFields, 'Re-enrich candidates').split(/\s+/)[0])).toBeGreaterThan(0);
  }, 60000);
});

// ─── F7 — mem_use echoed a caller-crafted name verbatim ───────────────────────────
// server.mjs:1606-1614 interpolated the caller's `name` straight into the miss message —
// twice (the head and the mem_registry pointer). `<skill-loaded>` is deliberately ABSENT
// from CONTEXT_DELIMITER_RE (format-utils.mjs:49) because the legitimate load path must
// emit it for real, so defangResult (server.mjs:203) does not neutralize it either: a
// crafted `name` forged a whole <skill-loaded> block plus "Follow the instructions above
// to execute this skill." inside a message the caller controls end to end. Pre-existing,
// not a regression from F1. Fixed by bounding the echoed name and neutralizing skill-block
// delimiters in it — the legitimate load path is untouched and still emits a real wrapper.

// ─── F6 — the detached update-check worker exited before its handler ───────────────
// hook.mjs:1432 spawns `update-check` via spawnBackground(), which sets
// CLAUDE_MEM_HOOK_RUNNING=1 on the child (hook-shared.mjs:212). The recursion guard at
// hook.mjs:116 exits every event that is not in BG_EVENTS — and `update-check` was not in
// it, so the worker died before the dispatch case at :1790. isUpdateCheckDue() reads the
// update-state.json that worker was supposed to write, so every SessionStart respawned a
// worker that immediately exit(0)'d: a dead 24h release check that looked, from the
// outside, exactly like "the worker ran and found nothing".
//
// NETWORK: none. A CJS preload (--require) replaces globalThis.fetch with a stub that
// records the URL and throws, and a preflight probe proves the stub is installed before
// the arm that depends on it runs — so a stub that failed to load REDS the preflight
// instead of quietly letting a request reach api.github.com.

describe('F6 — update-check reaches its handler under the recursion guard', () => {
  let dataDir, runtimeDir, cwd, fetchLog, offlineFetch;

  /** Env that makes every fetch in the child an in-process, recorded, thrown refusal.
   *  The blanked proxy vars are load-bearing, not hygiene: hook-update picks its
   *  transport from them, and the CONNECT tunnel does NOT go through globalThis.fetch.
   *  A child inheriting a real HTTPS_PROXY would sail past the stub and reach
   *  api.github.com for real — the preflight would still pass, because it probes the
   *  stub, not the branch under test. */
  const offlineEnv = (log) => ({
    AUDIT_FETCH_LOG: log,
    NODE_OPTIONS: `--require "${offlineFetch}"`,
    HTTPS_PROXY: '',
    https_proxy: '',
    HTTP_PROXY: '',
    http_proxy: '',
  });
  const fetched = (log) =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];

  beforeAll(async () => {
    dataDir = sandboxDir('data-f6');
    runtimeDir = join(dataDir, 'runtime');
    cwd = sandboxDir('work', 'f6');
    fetchLog = join(ROOT, 'f6-fetches.txt');
    offlineFetch = join(ROOT, 'offline-fetch.cjs');
    writeFileSync(
      offlineFetch,
      [
        "const fs = require('fs');",
        'globalThis.fetch = async (url) => {',
        "  try { fs.appendFileSync(process.env.AUDIT_FETCH_LOG, String(url) + '\\n'); } catch { /* best-effort */ }",
        "  throw new Error('offline: this audit refuses every fetch');",
        '};',
        '',
      ].join('\n'),
    );

    // Preflight: the stub must actually intercept in a child spawned exactly like the arms
    // below. FAILS IF: NODE_OPTIONS is ignored / the preload throws — the probe URL is then
    // absent and every later "no fetch happened" reading would be unfounded.
    const probeLog = join(ROOT, 'f6-preflight.txt');
    const probe = await fire(
      process.execPath,
      ['-e', "fetch('https://stub-probe.invalid/preflight').then(() => {}, () => {})"],
      { cwd, env: offlineEnv(probeLog) },
    );
    expect(probe.code, probe.stderr).toBe(0);
    expect(
      fetched(probeLog),
      'the offline fetch stub did not load — no arm below can claim the network was untouched',
    ).toEqual(['https://stub-probe.invalid/preflight']);
  }, 60000);

  // FAILS IF: 'update-check' is dropped from BG_EVENTS again — hook.mjs:116 then exits before
  // the dispatch case, so NO fetch is recorded and update-state.json is never written (that is
  // exactly the pre-fix reading: 0 URLs, no state file).
  it('the detached worker performs the release lookup with CLAUDE_MEM_HOOK_RUNNING=1', async () => {
    const r = await fire(process.execPath, [HOOK_PATH, 'update-check'], {
      cwd,
      env: {
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_HOOK_RUNNING: '1', // what spawnBackground sets on the child
        CLAUDE_MEM_SKIP_UPDATE: undefined, // BASE_ENV sets it; drop it so the handler runs
        ...offlineEnv(fetchLog),
      },
      timeout: 60000,
    });
    expect(r.code, `update-check exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(r.stdout, "background workers run stdio:'ignore'; stdout must stay empty").toBe('');

    const urls = fetched(fetchLog);
    expect(urls[0], `update-check made no release lookup: ${JSON.stringify(urls)}`).toBe(
      'https://api.github.com/repos/sdsrss/claude-mem-lite/releases/latest',
    );
    expect(urls[1]).toMatch(/^https:\/\/api\.github\.com\/repos\/sdsrss\/claude-mem-lite\/tags\b/);
    expect(urls).toHaveLength(2);

    // …and the 24h throttle it feeds was stamped, which is the whole reason the worker exists.
    const state = JSON.parse(readFileSync(join(runtimeDir, 'update-state.json'), 'utf8'));
    expect(
      Date.now() - new Date(state.lastCheck).getTime(),
      `update-state.json carries no fresh lastCheck: ${JSON.stringify(state)}`,
    ).toBeLessThan(120000);
    // A failed lookup must not have tried to install anything.
    expect(
      existsSync(join(HOME_DIR, '.claude-mem-lite', 'package.json')),
      'a failed release lookup still touched the install dir',
    ).toBe(false);
  }, 60000);

  // The counter-case: the fix must not be "delete the recursion guard". A foreground event
  // under CLAUDE_MEM_HOOK_RUNNING=1 still has to die before doing any work.
  // FAILS IF: hook.mjs:116 is removed, or BG_EVENTS is widened to everything — the guarded
  // arm then captures the episode entry the unguarded arm proves this payload produces.
  it('a non-background event under the same env is still refused', async () => {
    const payload = (project) => ({
      session_id: 'cc-f6-guard',
      tool_name: 'Edit',
      tool_input: { file_path: join(project, 'widget-cache.mjs'), old_string: 'a', new_string: 'b' },
      tool_response: 'The file has been updated successfully with the new content applied.',
    });
    const episodeFile = (data, project) =>
      join(data, 'runtime', `ep-${'work--' + project.split('/').pop()}.json`);

    const guardedData = sandboxDir('data-f6-guarded');
    const guardedCwd = sandboxDir('work', 'f6-guarded');
    const guarded = await fire(process.execPath, [HOOK_PATH, 'post-tool-use'], {
      cwd: guardedCwd,
      stdin: JSON.stringify(payload(guardedCwd)),
      env: { CLAUDE_MEM_DIR: guardedData, CLAUDE_MEM_HOOK_RUNNING: '1' },
    });
    expect(guarded.code, guarded.stderr).toBe(0);
    expect(
      existsSync(episodeFile(guardedData, guardedCwd)),
      'post-tool-use ran its handler under CLAUDE_MEM_HOOK_RUNNING=1 — the recursion guard is gone',
    ).toBe(false);

    // Same payload, guard env removed: proof the "no episode file" above is the guard's doing
    // and not an inert payload.
    const openData = sandboxDir('data-f6-open');
    const openCwd = sandboxDir('work', 'f6-open');
    const open = await fire(process.execPath, [HOOK_PATH, 'post-tool-use'], {
      cwd: openCwd,
      stdin: JSON.stringify(payload(openCwd)),
      env: { CLAUDE_MEM_DIR: openData },
    });
    expect(open.code, open.stderr).toBe(0);
    const episode = JSON.parse(readFileSync(episodeFile(openData, openCwd), 'utf8'));
    expect(episode.entries.map((e) => e.tool)).toEqual(['Edit']);
  }, 60000);

  // The structural guard against reintroduction: BG_EVENTS is a hand-maintained list that a
  // new detached spawn must be added to, and the failure mode (silent exit 0) is invisible.
  // Both detached spawners are scanned — spawnBackground() in hook.mjs and the direct
  // `spawn(node, [HOOK_PATH, '<event>'])` in lib/save-enrich.mjs — since both set
  // CLAUDE_MEM_HOOK_RUNNING=1 on the child.
  // FAILS IF: any event is spawned detached without being listed (the F6 defect itself:
  // pre-fix this reds with ['update-check']).
  it('every detached worker event is listed in BG_EVENTS', () => {
    const hookSrc = readFileSync(HOOK_PATH, 'utf8');
    const declared = hookSrc.match(/const BG_EVENTS = new Set\(\[([\s\S]*?)\]\)/);
    expect(declared, 'BG_EVENTS is no longer a literal Set — this guard cannot read it').toBeTruthy();
    const listed = new Set([...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

    const spawned = new Set();
    for (const file of [HOOK_PATH, join(REPO, 'lib', 'save-enrich.mjs')]) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/spawnBackground\(\s*'([\w-]+)'/g)) spawned.add(m[1]);
      for (const m of src.matchAll(/HOOK_PATH,\s*'([\w-]+)'/g)) spawned.add(m[1]);
    }
    // Guard the guard: if the scan matches nothing, the assertion below is vacuous.
    expect(
      spawned.size,
      'the detached-spawn scan found no call sites — the patterns went stale',
    ).toBeGreaterThanOrEqual(6);
    expect(
      [...spawned].filter((e) => !listed.has(e)),
      'these events are spawned detached (CLAUDE_MEM_HOOK_RUNNING=1) but absent from BG_EVENTS, so hook.mjs:116 exits them before dispatch',
    ).toEqual([]);
  });
});

// ─── F6b (pre-tag review) — the resurrected worker CHECKS, it does not self-install ─
// F6 brings a path back from the dead: `update-check` has not reached its handler since
// v2.85.0 (2026-06-03), because it was missing from BG_EVENTS. What it dispatches is
// `checkForUpdate()` with NO options, and hook-update.mjs:44 reads
// `allowInstall = options.allowInstall ?? !pluginMode` — so on a direct / settings.json
// install (no CLAUDE_PLUGIN_ROOT) allowInstall defaults to TRUE and the path proceeds into
// downloadAndInstall: curl the tarball, `npm install` in staging, per-file renameSync swap
// of ~/.claude-mem-lite. Fixing F6 would therefore switch a ten-week-dormant self-installer
// back on for every direct-install user in the same release that resurrects it.
// Staged instead (user decision): this release restores the CHECK + banner only, by passing
// `allowInstall: false` at this ONE dispatch. hook-update.mjs's own default and the
// installer's guards are untouched — `install.mjs` still passes allowInstall:true for the
// explicit, user-invoked update.
//
// NETWORK: none, twice over. A CJS preload replaces globalThis.fetch with a stub that
// serves a fabricated v999.0.0 release for the releases/latest URL and throws on anything
// else, and a fake `curl` earlier on PATH stands in for the installer's only network call
// (execFileSync('curl', …), which a JS preload cannot intercept). Both are proven live by
// preflight probes before the arm that depends on them runs, so a stub that failed to load
// REDS the preflight instead of letting a real request out.

describe('F6b — the restored update-check checks for a release but does not install it', () => {
  const LATEST_URL = 'https://api.github.com/repos/sdsrss/claude-mem-lite/releases/latest';
  let dataDir, runtimeDir, cwd, binDir, fetchLog, curlLog, releaseFetch;

  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
  /** Child env: a DIRECT install (no CLAUDE_PLUGIN_ROOT ⇒ allowInstall defaults to true). */
  const childEnv = (extra = {}) => ({
    CLAUDE_MEM_DIR: dataDir,
    CLAUDE_MEM_HOOK_RUNNING: '1', // what spawnBackground sets on the detached child
    CLAUDE_MEM_SKIP_UPDATE: undefined, // BASE_ENV sets it; drop it so the handler runs
    CLAUDE_PLUGIN_ROOT: undefined, // the install shape where the installer was reachable
    AUDIT_FETCH_LOG: fetchLog,
    AUDIT_CURL_LOG: curlLog,
    NODE_OPTIONS: `--require "${releaseFetch}"`,
    PATH: `${binDir}:${process.env.PATH}`,
    // Load-bearing: hook-update switches to a CONNECT tunnel when a proxy is
    // configured, and that tunnel bypasses globalThis.fetch — so an inherited
    // HTTPS_PROXY would make this canned-release stub invisible and send the
    // child at the real api.github.com.
    HTTPS_PROXY: '',
    https_proxy: '',
    HTTP_PROXY: '',
    http_proxy: '',
    ...extra,
  });

  beforeAll(async () => {
    dataDir = sandboxDir('data-f6b');
    runtimeDir = join(dataDir, 'runtime');
    cwd = sandboxDir('work', 'f6b');
    binDir = sandboxDir('f6b-bin');
    fetchLog = join(ROOT, 'f6b-fetches.txt');
    curlLog = join(ROOT, 'f6b-curl.txt');

    releaseFetch = join(ROOT, 'release-fetch.cjs');
    writeFileSync(
      releaseFetch,
      [
        "const fs = require('fs');",
        `const LATEST = ${JSON.stringify(LATEST_URL)};`,
        'globalThis.fetch = async (url) => {',
        "  try { fs.appendFileSync(process.env.AUDIT_FETCH_LOG, String(url) + '\\n'); } catch { /* best-effort */ }",
        '  if (String(url) === LATEST) {',
        '    return { ok: true, status: 200, json: async () => ({',
        "      tag_name: 'v999.0.0',",
        "      tarball_url: 'https://api.github.com/repos/sdsrss/claude-mem-lite/tarball/v999.0.0',",
        "      html_url: 'https://github.com/sdsrss/claude-mem-lite/releases/tag/v999.0.0',",
        '      assets: [],',
        '    }) };',
        '  }',
        "  throw new Error('offline: this audit refuses every other fetch');",
        '};',
        '',
      ].join('\n'),
    );

    // The installer's download is execFileSync('curl', …) — a separate process, so the JS
    // preload cannot see it. Shadow `curl` on PATH with a recorder that never opens a
    // socket and exits non-zero, which is also what makes downloadAndInstall bail early.
    const fakeCurl = join(binDir, 'curl');
    writeFileSync(fakeCurl, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$AUDIT_CURL_LOG"\nexit 1\n');
    chmodSync(fakeCurl, 0o755);

    // Preflight 1: the fetch stub really intercepts, in a child spawned exactly like the
    // arm below. FAILS IF: NODE_OPTIONS is ignored / the preload throws — the fabricated
    // release never appears and the arm's "the check ran" reading would be unfounded (and a
    // real request could reach api.github.com).
    const probeLog = join(ROOT, 'f6b-preflight-fetch.txt');
    const probe = await fire(
      process.execPath,
      [
        '-e',
        `fetch(${JSON.stringify(LATEST_URL)}).then((r) => r.json()).then((j) => console.log(j.tag_name), (e) => console.log('ERR ' + e.message))`,
      ],
      { cwd, env: childEnv({ AUDIT_FETCH_LOG: probeLog }) },
    );
    expect(probe.stdout.trim(), `the release fetch stub did not load: ${probe.stderr}`).toBe('v999.0.0');
    expect(lines(probeLog)).toEqual([LATEST_URL]);

    // Preflight 2: the fake curl really shadows the real one. FAILS IF: PATH ordering stops
    // working — the arm's "no curl ran" reading would then be about a curl that was never
    // recorded rather than one that never ran.
    const curlProbeLog = join(ROOT, 'f6b-preflight-curl.txt');
    const curlProbe = await fire('curl', ['-sL', 'https://stub-probe.invalid/preflight'], {
      cwd,
      env: childEnv({ AUDIT_CURL_LOG: curlProbeLog }),
    });
    expect(curlProbe.code, 'the shadowing curl is not the one that ran').toBe(1);
    expect(lines(curlProbeLog).join(' '), 'the fake curl on PATH did not record the invocation').toContain(
      'stub-probe.invalid',
    );
  }, 60000);

  // FAILS IF: the dispatch goes back to a bare `await checkForUpdate()` — allowInstall then
  // defaults to true on this (non-plugin) install shape, downloadAndInstall runs, and the
  // curl log carries the v999.0.0 tarball URL. Verified by mutation: reverting hook.mjs to
  // `await checkForUpdate()` reds the curl assertion with
  // ['-sL -H Accept: application/vnd.github+json https://api.github.com/repos/sdsrss/claude-mem-lite/tarball/v999.0.0 -o …'].
  it('runs the release lookup and writes the banner state without entering the installer', async () => {
    const r = await fire(process.execPath, [HOOK_PATH, 'update-check'], {
      cwd,
      env: childEnv(),
      timeout: 60000,
    });
    expect(r.code, `update-check exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(r.stdout, "background workers run stdio:'ignore'; stdout must stay empty").toBe('');

    // 1. The CHECK half still happens — this is what F6 restored, and staging must not
    //    silently disable it too.
    expect(
      lines(fetchLog),
      `update-check made no release lookup: ${JSON.stringify(lines(fetchLog))}`,
    ).toEqual([LATEST_URL]);

    // 2. The banner half lands: an update WAS found and recorded for the next SessionStart.
    const state = JSON.parse(readFileSync(join(runtimeDir, 'update-state.json'), 'utf8'));
    expect(state.latestVersion, `no release recorded in ${JSON.stringify(state)}`).toBe('999.0.0');
    expect(state.updateAvailable, 'an available update was not flagged for the banner').toBe(true);
    expect(Date.now() - new Date(state.lastCheck).getTime()).toBeLessThan(120000);

    // 3. …and the self-replacing install half does NOT. curl is the installer's first
    //    action, so an empty log means downloadAndInstall was never entered.
    expect(lines(curlLog), 'the dispatched update-check entered the self-replacing installer').toEqual([]);
    // Nothing was staged or swapped into the install dir either.
    expect(
      existsSync(join(HOME_DIR, '.claude-mem-lite', 'package.json')),
      'the update path wrote into the install dir',
    ).toBe(false);
  }, 60000);

  // The staging is at the DISPATCH, not in hook-update.mjs: an explicit caller that asks to
  // install must still be able to (install.mjs passes allowInstall:true for the user-invoked
  // update, and that path is unchanged by this fix).
  // FAILS IF: the default in hook-update.mjs is flipped instead of the dispatch — the
  // installer would then be unreachable even when a caller explicitly asks for it, and the
  // curl log stays empty here.
  it('an explicit allowInstall:true caller still reaches the installer', async () => {
    const explicitLog = join(ROOT, 'f6b-curl-explicit.txt');
    const explicitData = sandboxDir('data-f6b-explicit');
    const r = await fire(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const { checkForUpdate } = await import(process.env.AUDIT_UPDATE_MODULE); await checkForUpdate({ force: true, allowInstall: true });',
      ],
      {
        cwd,
        env: childEnv({
          AUDIT_UPDATE_MODULE: join(REPO, 'hook-update.mjs'),
          AUDIT_CURL_LOG: explicitLog,
          AUDIT_FETCH_LOG: join(ROOT, 'f6b-fetches-explicit.txt'),
          CLAUDE_MEM_DIR: explicitData,
        }),
        timeout: 60000,
      },
    );
    expect(r.code, `explicit update call exited ${r.code}\n${r.stderr}`).toBe(0);
    expect(
      lines(explicitLog).join(' '),
      'an explicit allowInstall:true call no longer reaches the download — the fix was applied to the module default, not the dispatch',
    ).toContain('/tarball/v999.0.0');
  }, 60000);

  // The staging is meant to be temporary and attributable, so it has to be visible in the
  // source rather than an unexplained literal.
  // FAILS IF: the option is dropped, or re-enabled without saying so.
  it('the dispatch states why the install half is staged off', () => {
    const src = readFileSync(HOOK_PATH, 'utf8');
    const dispatch = src.match(/case 'update-check':[\s\S]{0,120}/)?.[0] || '';
    expect(dispatch, `the update-check dispatch no longer passes allowInstall: ${dispatch}`).toMatch(
      /checkForUpdate\(\{[^}]*allowInstall:\s*false/,
    );
    const preamble = src.slice(
      Math.max(0, src.indexOf("case 'update-check':") - 700),
      src.indexOf("case 'update-check':"),
    );
    expect(
      preamble,
      'the staging carries no explanation of why install is off or when it comes back',
    ).toMatch(/v2\.85\.0|follow-up/);
  });
});

// ─── F1 — mem_use served a DIFFERENT skill's body on a name miss ───────────────────
// server.mjs:1594-1600 fell through an exact-name miss to searchResources(…, {limit:1})
// and rendered whatever FTS ranked first as `<skill-loaded name=…>` + "Follow the
// instructions above to execute this skill." — no marker that a substitution happened.
// With only `deploy-rollback-runbook` registered, `deploy-notes` / `rollback-checklist` /
// `runbook-index` each returned its full body, so an agent that asked for skill A was
// handed skill B's instructions and told to run them. Per the F1 decision the fuzzy search
// stays (it is what produces the candidate list) but its result is now a SUGGESTION: names
// plus a mem_registry pointer, never a body and never the execute imperative.
