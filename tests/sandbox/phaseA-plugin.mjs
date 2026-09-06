// phaseA-plugin.mjs — simulate a real user installing via the Claude Code plugin marketplace.
//
//   /plugin marketplace add sdsrss/claude-mem-lite
//   /plugin install claude-mem-lite
//
// Claude Code clones the marketplace, copies the plugin into
// ~/.claude/plugins/cache/<mp>/<plugin>/<ver>/, flips enabledPlugins, and then
// runs the manifest's hooks with CLAUDE_PLUGIN_ROOT pointed at the cache dir.
// We reproduce all of that, then exercise every hook + the MCP server for real.

import {
  REPO,
  setPhase,
  check,
  summary,
  node,
  run,
  snapshotRepo,
  makeFakeClaudeBin,
  sandboxEnv,
  mcpSession,
  runHook,
  loadedBindingPath,
  breakBinding,
  bindingLoads,
  join,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from './lib.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { sandboxBase } from './sbx-base.mjs';

const SBX = mkdtempSync(join(sandboxBase(), 'memsbx-A-'));
const HOME = join(SBX, 'home');
const PROJECT = join(SBX, 'work', 'my-app');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

// Every check this phase must run. A phase that quietly shrinks has stopped measuring:
// phase B's self-heal section lost eight checks to a stale `if (existsSync(…))` and the
// only symptom was a tally nobody compared. Change this when you add or remove a check
// on purpose — never to silence it.
const EXPECTED_CHECKS = 47;
const MP = 'sdsrss';
const CACHE = join(HOME, '.claude', 'plugins', 'cache', MP, 'claude-mem-lite', VERSION);
const MARKET = join(HOME, '.claude', 'plugins', 'marketplaces', MP);

console.log(`sandbox: ${SBX}\nversion: ${VERSION}`);

mkdirSync(join(HOME, '.claude'), { recursive: true });
mkdirSync(join(HOME, 'tmp'), { recursive: true });
mkdirSync(PROJECT, { recursive: true });
makeFakeClaudeBin(HOME);
// A real project: a git repo with a file or two.
execFileSync('git', ['init', '-q'], { cwd: PROJECT });
writeFileSync(join(PROJECT, 'app.js'), 'export const answer = 42;\n');

const ENV = sandboxEnv(HOME, { CLAUDE_PLUGIN_ROOT: CACHE });
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── 1. Marketplace add + plugin install (what Claude Code does) ──────────────
setPhase('A1: /plugin marketplace add + /plugin install');

const nFiles = snapshotRepo(MARKET);
check('marketplace clone populated', () => ({ ok: nFiles > 100, detail: `${nFiles} files` }));
check('marketplace clone carries .claude-plugin/marketplace.json', () =>
  existsSync(join(MARKET, '.claude-plugin', 'marketplace.json')),
);

// Claude Code copies the marketplace source into the versioned cache dir.
snapshotRepo(CACHE);
// ...but NOT node_modules — the cache is a git checkout, deps are absent.
check(
  'plugin cache has no node_modules (cold install, as Claude Code leaves it)',
  () => !existsSync(join(CACHE, 'node_modules')),
);

writeFileSync(
  join(HOME, '.claude', 'settings.json'),
  JSON.stringify(
    {
      enabledPlugins: { 'claude-mem-lite@sdsrss': true },
    },
    null,
    2,
  ),
);
mkdirSync(join(HOME, '.claude', 'plugins'), { recursive: true });
writeFileSync(
  join(HOME, '.claude', 'plugins', 'installed_plugins.json'),
  JSON.stringify(
    {
      'claude-mem-lite@sdsrss': { version: VERSION, marketplace: MP },
    },
    null,
    2,
  ),
);

// ── 2. First SessionStart: setup.sh (hook #1) ───────────────────────────────
setPhase('A2: first SessionStart — setup.sh cold path (real npm install)');

const t0 = Date.now();
const setup1 = runHook(`bash "${CACHE}/scripts/setup.sh"`, {}, { env: ENV, cwd: PROJECT });
const setupMs = Date.now() - t0;
check('setup.sh exits 0 on a cold plugin cache', () => ({
  ok: setup1.code === 0,
  detail: `exit=${setup1.code} in ${setupMs}ms; stderr tail: ${setup1.stderr.split('\n').slice(-6).join(' | ')}`,
}));
check('setup.sh stdout is empty (SessionStart stdout is a JSON envelope)', () => ({
  ok: setup1.stdout.trim() === '',
  detail: `stdout=${JSON.stringify(setup1.stdout.slice(0, 300))}`,
}));
check('data dir created at ~/.claude-mem-lite', () => existsSync(join(HOME, '.claude-mem-lite', 'runtime')));
check('deps resolved: node_modules/better-sqlite3 present in plugin cache', () =>
  existsSync(join(CACHE, 'node_modules', 'better-sqlite3')),
);
check('no .deps-broken flag after a successful cold install', () => {
  const f = join(HOME, '.claude-mem-lite', 'runtime', '.deps-broken');
  return { ok: !existsSync(f), detail: existsSync(f) ? readFileSync(f, 'utf8') : '' };
});
check('ABI-keyed binding marker written', () => {
  const nm = join(CACHE, 'node_modules');
  const marks = existsSync(nm) ? readdirSync(nm).filter((f) => f.startsWith('.mem-binding-ok-')) : [];
  return { ok: marks.length === 1, detail: marks.join(',') };
});

// ── 3. SessionStart hook #2: hook.mjs session-start ─────────────────────────
setPhase('A3: SessionStart — hook.mjs session-start envelope');

const ssPayload = {
  session_id: SESSION,
  cwd: PROJECT,
  hook_event_name: 'SessionStart',
  source: 'startup',
  transcript_path: join(HOME, '.claude', 'projects', 'x', `${SESSION}.jsonl`),
};
const ss = runHook(`node "${CACHE}/scripts/hook-launcher.mjs" hook.mjs session-start`, ssPayload, {
  env: ENV,
  cwd: PROJECT,
});
check('session-start hook exits 0', () => ({
  ok: ss.code === 0,
  detail: `exit=${ss.code} stderr=${ss.stderr.slice(0, 400)}`,
}));
check('session-start stdout is ONE parseable JSON envelope (no raw prose alongside)', () => {
  const s = ss.stdout.trim();
  if (!s) return { ok: true, detail: '(empty stdout — allowed: no context to inject)' };
  const o = JSON.parse(s); // throws if a second raw block trails the envelope
  return {
    ok: o.suppressOutput === true && o.hookSpecificOutput?.hookEventName === 'SessionStart',
    detail: JSON.stringify(o).slice(0, 220),
  };
});
check('auto-adopt wrote the steering block into the project CLAUDE.md', () => {
  const p = join(PROJECT, 'CLAUDE.md');
  if (!existsSync(p)) return { ok: false, detail: 'CLAUDE.md not created' };
  const txt = readFileSync(p, 'utf8');
  return { ok: txt.includes('claude-mem-lite'), detail: `${txt.length} bytes` };
});
check('auto-adopt wrote the detail doc', () =>
  existsSync(join(PROJECT, '.claude', 'plugin_claude_mem_lite.md')),
);

// ── 4. UserPromptSubmit ─────────────────────────────────────────────────────
setPhase('A4: UserPromptSubmit hooks');

for (const script of ['scripts/user-prompt-search.js', 'hook.mjs user-prompt']) {
  const r = runHook(
    `node "${CACHE}/scripts/hook-launcher.mjs" ${script}`,
    {
      session_id: SESSION,
      cwd: PROJECT,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'how do I fix the sqlite binding error?',
    },
    { env: ENV, cwd: PROJECT },
  );
  check(`UserPromptSubmit ${script} exits 0`, () => ({
    ok: r.code === 0,
    detail: `exit=${r.code} ${r.stderr.slice(0, 300)}`,
  }));
  check(`UserPromptSubmit ${script} stdout parses as JSON (or is empty)`, () => {
    const s = r.stdout.trim();
    if (!s) return true;
    JSON.parse(s);
    return true;
  });
}

// ── 5. PreToolUse / PostToolUse ─────────────────────────────────────────────
setPhase('A5: PreToolUse / PostToolUse hooks');

const preTool = {
  session_id: SESSION,
  cwd: PROJECT,
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: join(PROJECT, 'app.js'), old_string: '42', new_string: '43' },
};
for (const s of ['scripts/pre-tool-recall.js']) {
  const r = runHook(`node "${CACHE}/scripts/hook-launcher.mjs" ${s}`, preTool, { env: ENV, cwd: PROJECT });
  check(`PreToolUse ${s} exits 0`, () => ({
    ok: r.code === 0,
    detail: `exit=${r.code} ${r.stderr.slice(0, 300)}`,
  }));
}
const preAgent = {
  session_id: SESSION,
  cwd: PROJECT,
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_input: { prompt: 'find the bug', subagent_type: 'general-purpose' },
};
check('PreToolUse pre-agent-inject exits 0', () => {
  const r = runHook(`node "${CACHE}/scripts/hook-launcher.mjs" scripts/pre-agent-inject.js`, preAgent, {
    env: ENV,
    cwd: PROJECT,
  });
  return { ok: r.code === 0, detail: `exit=${r.code} ${r.stderr.slice(0, 300)}` };
});

const postTool = {
  session_id: SESSION,
  cwd: PROJECT,
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: join(PROJECT, 'app.js'), old_string: '42', new_string: '43' },
  tool_response: { filePath: join(PROJECT, 'app.js'), success: true },
};
check('PostToolUse post-tool-use.sh exits 0', () => {
  const r = runHook(`bash "${CACHE}/scripts/post-tool-use.sh"`, postTool, { env: ENV, cwd: PROJECT });
  return { ok: r.code === 0, detail: `exit=${r.code} ${r.stderr.slice(0, 300)}` };
});
check('PostToolUse post-tool-recall.js exits 0', () => {
  const r = runHook(`node "${CACHE}/scripts/hook-launcher.mjs" scripts/post-tool-recall.js`, postTool, {
    env: ENV,
    cwd: PROJECT,
  });
  return { ok: r.code === 0, detail: `exit=${r.code} ${r.stderr.slice(0, 300)}` };
});

// ── 6. Stop hook ────────────────────────────────────────────────────────────
setPhase('A6: Stop hook');
const transcriptDir = join(HOME, '.claude', 'projects', 'x');
mkdirSync(transcriptDir, { recursive: true });
const transcript = join(transcriptDir, `${SESSION}.jsonl`);
writeFileSync(
  transcript,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the binding error' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Fixed the ABI mismatch by rebuilding better-sqlite3.' }],
      },
    }),
  ].join('\n') + '\n',
);
check('Stop hook exits 0', () => {
  const r = runHook(
    `node "${CACHE}/scripts/hook-launcher.mjs" hook.mjs stop`,
    {
      session_id: SESSION,
      cwd: PROJECT,
      hook_event_name: 'Stop',
      transcript_path: transcript,
    },
    { env: { ...ENV, CLAUDE_MEM_SKIP_SUMMARY: '1' }, cwd: PROJECT },
  );
  return { ok: r.code === 0, detail: `exit=${r.code} ${r.stderr.slice(0, 300)}` };
});

// ── 7. MCP server over real stdio ───────────────────────────────────────────
setPhase('A7: MCP server (plugin launcher, real stdio JSON-RPC)');

const mcp = await mcpSession(process.execPath, [join(CACHE, 'scripts', 'launch.mjs')], {
  env: ENV,
  cwd: PROJECT,
  requests: [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sbx', version: '1' } },
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'mem_save',
        arguments: {
          title: 'Sandbox smoke memory',
          content: 'Plugin-form install verified end to end in a sandbox HOME.',
          type: 'decision',
          lesson_learned:
            'Cold plugin-cache installs must compile better-sqlite3 before any hook can open the DB.',
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'mem_search', arguments: { query: 'sandbox smoke' } },
    },
  ],
});
check('MCP initialize responds', () => {
  const r = mcp.responses.find((x) => x.id === 1);
  return {
    ok: !!r?.result?.serverInfo,
    detail: JSON.stringify(r?.result?.serverInfo || mcp.stderr.slice(0, 400)),
  };
});
check('MCP tools/list exposes the 9 core tools', () => {
  const r = mcp.responses.find((x) => x.id === 2);
  const names = (r?.result?.tools || []).map((t) => t.name);
  return {
    ok: names.length === 9 && names.includes('mem_search') && names.includes('mem_save'),
    detail: `${names.length}: ${names.join(',')}`,
  };
});
check('MCP mem_save writes a memory', () => {
  const r = mcp.responses.find((x) => x.id === 3);
  const txt = r?.result?.content?.[0]?.text || '';
  return { ok: !r?.result?.isError && /#\d+/.test(txt), detail: txt.slice(0, 200) };
});
check('MCP mem_search finds the memory just saved', () => {
  const r = mcp.responses.find((x) => x.id === 4);
  const txt = r?.result?.content?.[0]?.text || '';
  return { ok: /Sandbox smoke/i.test(txt), detail: txt.slice(0, 250) };
});
const mcp2 = await mcpSession(process.execPath, [join(CACHE, 'scripts', 'launch.mjs')], {
  env: ENV,
  cwd: PROJECT,
  requests: [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sbx', version: '1' } },
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_stats', arguments: {} } },
  ],
});
check('MCP hidden tool mem_stats answers a direct tools/call', () => {
  const r = mcp2.responses.find((x) => x.id === 2);
  const txt = r?.result?.content?.[0]?.text || '';
  return { ok: !!txt && !r?.result?.isError, detail: txt.slice(0, 200) };
});

// ── 8. Bundled CLI (what /mem, /lesson, /bug slash commands invoke) ──────────
setPhase('A8: bundled CLI via ${CLAUDE_PLUGIN_ROOT}/cli.mjs');

for (const [label, args] of [
  ['search', ['search', 'sandbox']],
  ['recent', ['recent', '3']],
  ['stats', ['stats']],
  ['timeline', ['timeline']],
  ['doctor', ['doctor']],
]) {
  const r = node([join(CACHE, 'cli.mjs'), ...args], { env: ENV, cwd: PROJECT });
  check(`CLI ${label} exits 0`, () => ({
    ok: r.code === 0,
    detail: `exit=${r.code} out=${(r.stdout || r.stderr).slice(0, 220)}`,
  }));
}

// ── 9. Auto-update in plugin mode ───────────────────────────────────────────
setPhase('A9: auto-update — plugin mode must report, never self-install');

// Audit 2026-09-02 P1-13: this drove `node hook-update.mjs --check` with
// CLAUDE_MEM_FORCE_UPDATE_CHECK=1. `hook-update.mjs` has NO argv entry point and nothing
// anywhere reads that env var, so the process imported the module, ran nothing and exited
// 0 — both checks passed vacuously, and the contract in this phase's own title was never
// exercised. The real entry is `hook.mjs update-check` (the detached worker SessionStart
// spawns). The env var is gone rather than renamed: inventing a reader for it would be
// building a mechanism to justify a test.
const STATE_JSON = join(HOME, '.claude-mem-lite', 'runtime', 'update-state.json');
const readLastCheck = () => {
  try {
    return JSON.parse(readFileSync(STATE_JSON, 'utf8')).lastCheck ?? null;
  } catch {
    return null;
  }
};
// Backdate the 24h gate so the real entry point actually does its work. `checkForUpdate`
// returns the CACHED state when `shouldCheck` says the last check was recent, and an
// earlier step in this phase has already written one — so without this the entry runs and
// writes nothing, which is indistinguishable from the no-op entry this case replaced. The
// second draft of this case caught exactly that (before === after) and this is the fix;
// the first draft, which only asserted the file exists, passed against both.
try {
  const st = JSON.parse(readFileSync(STATE_JSON, 'utf8'));
  st.lastCheck = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  writeFileSync(STATE_JSON, JSON.stringify(st));
} catch {
  /* no prior state — shouldCheck() then returns true on its own */
}
const lastCheckBefore = readLastCheck();
const before = readdirSync(join(HOME, '.claude', 'plugins', 'cache', MP, 'claude-mem-lite'));
const upd = node([join(CACHE, 'hook.mjs'), 'update-check'], { env: ENV, cwd: PROJECT, timeout: 60_000 });
check('hook.mjs update-check exits 0 in plugin mode', () => ({
  ok: upd.code === 0,
  detail: `exit=${upd.code} ${(upd.stdout || upd.stderr).slice(0, 300)}`,
}));
// PREMISE, and the whole point of the rewrite: prove the path RAN. checkForUpdate writes
// update-state.json on every branch that reaches the network — including the failure and
// rate-limited ones — so this holds with or without connectivity, while a no-op entry
// point (the state this replaces) leaves the file absent.
check('update-check actually ran (update-state.json lastCheck advanced)', () => {
  // Compares BEFORE and AFTER rather than asserting the file exists. The first cut did the
  // latter and the very first real run reported `existedBefore=true` — an earlier phase step
  // had already written it, so "exists && has a lastCheck" would have passed against a
  // no-op entry point too. That is this item's own defect, reproduced in its replacement.
  const lastCheckAfter = readLastCheck();
  return {
    ok: Boolean(lastCheckAfter) && lastCheckAfter !== lastCheckBefore,
    detail: `before=${lastCheckBefore} after=${lastCheckAfter}`,
  };
});
// STATED LIMIT: `hook.mjs`'s update-check case passes `allowInstall: false` unconditionally
// (the F6 staging note there), and canInstall is `!pluginMode && allowInstall`. So this
// proves the update-check worker never installs — it does NOT isolate the plugin-mode arm,
// because the flag alone already forces the same answer. Testing plugin mode on its own
// would need a caller that passes allowInstall:true, and no shipped entry point does.
check('the update-check worker did not mutate the plugin cache', () => {
  const after = readdirSync(join(HOME, '.claude', 'plugins', 'cache', MP, 'claude-mem-lite'));
  return { ok: JSON.stringify(before) === JSON.stringify(after), detail: `${before} -> ${after}` };
});

// ── 10. Self-heal: stale-ABI native binding (the v3.60 field failure) ────────
setPhase('A10: self-heal — stale-ABI better-sqlite3 binding');

// The file to break is RESOLVED, never named. This block spent v4.0.0 through v5.1.0
// corrupting `build/Release/better_sqlite3.node`, which better-sqlite3 13 does not
// produce and no resolver loads — so the four "self-heal worked" checks below were
// vacuous for the whole of that window, and only the control said so.
const bindingPath = loadedBindingPath(CACHE);
check('the addon the resolver actually loads exists before we break it', () => ({
  ok: !!bindingPath,
  detail: bindingPath ?? `no better-sqlite3 addon resolves under ${CACHE}`,
}));
// Corrupt it the way a bad prebuild does: present, plausible, will not dlopen.
check('the break landed on that exact file', () => breakBinding(CACHE));
check('binding is genuinely unloadable now (control)', () => {
  const r = bindingLoads(CACHE, ENV);
  return { ok: !r.ok, detail: r.detail };
});
// What SessionStart owes the user here is NOT a heal. The compile is
// `node-gyp clean && node-gyp rebuild`, it takes ~41 s, and the hook budget is 20 s — a
// truncated attempt deletes build/ and leaves nothing, so scripts/binding-probe-cli.mjs
// passes sourceBuild:false on purpose (A20260906-R8b-P0-1). The contract is therefore:
// degrade without crashing, say so, and hand over a repair THAT WORKS. This block used to
// assert a heal, which is why it needed a binding npm rebuild could fix — a v12 assumption
// that outlived v12.
const DEPS_FLAG = join(HOME, '.claude-mem-lite', 'runtime', '.deps-broken');
const heal = runHook(`bash "${CACHE}/scripts/setup.sh"`, {}, { env: ENV, cwd: PROJECT });
check('setup.sh exits 0 rather than crashing the session', () => ({
  ok: heal.code === 0,
  detail: `exit=${heal.code} ${heal.stderr.split('\n').slice(-4).join(' | ')}`,
}));
check('it records .deps-broken instead of degrading silently', () => ({
  ok: existsSync(DEPS_FLAG),
  detail: existsSync(DEPS_FLAG) ? readFileSync(DEPS_FLAG, 'utf8').slice(0, 200) : 'no flag',
}));
check('the Repair line names the CLI, not the npm pair that cannot fix this shape', () => {
  const repair = existsSync(DEPS_FLAG) ? (JSON.parse(readFileSync(DEPS_FLAG, 'utf8')).repair ?? '') : '';
  // The dashboard prints this verbatim. `npm rebuild … && … build-release` compiles a
  // binding the resolver will not choose while the dead prebuild is still in place, so a
  // user who runs it watches it succeed and stays broken.
  return { ok: repair.includes('rebuild-binding'), detail: repair.slice(0, 260) };
});
const repairRun = run(process.execPath, [join(CACHE, 'cli.mjs'), 'rebuild-binding'], {
  env: ENV,
  cwd: PROJECT,
  timeout: 600_000,
});
check('running that repair exits 0', () => ({
  ok: repairRun.code === 0,
  detail: `exit=${repairRun.code} ${(repairRun.stdout || repairRun.stderr).slice(-300)}`,
}));
check('binding is usable again after the repair', () => bindingLoads(CACHE, ENV));
const heal2 = runHook(`bash "${CACHE}/scripts/setup.sh"`, {}, { env: ENV, cwd: PROJECT });
check('the next SessionStart clears .deps-broken (no stale "hooks degraded" banner)', () => ({
  ok: heal2.code === 0 && !existsSync(DEPS_FLAG),
  detail: `setup exit=${heal2.code} ${existsSync(DEPS_FLAG) ? readFileSync(DEPS_FLAG, 'utf8') : '(flag gone)'}`,
}));
check('hooks work again after the heal', () => {
  const r = runHook(`node "${CACHE}/scripts/hook-launcher.mjs" scripts/pre-tool-recall.js`, preTool, {
    env: ENV,
    cwd: PROJECT,
  });
  return { ok: r.code === 0, detail: `exit=${r.code} ${r.stderr.slice(0, 200)}` };
});

// ── 11. Uninstall ───────────────────────────────────────────────────────────
setPhase('A11: /plugin uninstall — residue check');

const dbBefore = existsSync(join(HOME, '.claude-mem-lite', 'claude-mem-lite.db'));
rmSync(join(HOME, '.claude', 'plugins', 'cache', MP, 'claude-mem-lite'), { recursive: true, force: true });
const s = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
delete s.enabledPlugins['claude-mem-lite@sdsrss'];
writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify(s, null, 2));
check('plugin-form install never wrote hooks into settings.json', () => {
  const raw = readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8');
  return {
    ok: !raw.includes('claude-mem-lite/hook') && !raw.includes('hook-launcher'),
    detail: raw.slice(0, 300),
  };
});
check('user data survives plugin uninstall (DB preserved)', () => ({
  ok: dbBefore && existsSync(join(HOME, '.claude-mem-lite', 'claude-mem-lite.db')),
  detail: `dbBefore=${dbBefore}`,
}));

console.log(`\nsandbox kept at: ${SBX}`);
process.exit(summary(EXPECTED_CHECKS) > 0 ? 1 : 0);
