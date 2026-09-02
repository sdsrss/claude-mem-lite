// phaseC-update.mjs — what a real user experiences across a PLUGIN update.
//
// Claude Code updates a plugin by materializing a NEW version dir in
// ~/.claude/plugins/cache/<mp>/<plugin>/<newver>/ from the refreshed marketplace
// clone. That copy is a git checkout: no node_modules, no compiled binding.
// The next SessionStart runs the new dir's setup.sh. This measures whether the
// user's memory keeps working across that window.

import {
  REPO, setPhase, check, summary, node, snapshotRepo, makeFakeClaudeBin,
  sandboxEnv, mcpSession, runHook, join, existsSync, readFileSync, writeFileSync, mkdirSync,
} from './lib.mjs';
import { mkdtempSync, readdirSync } from 'node:fs';
import { sandboxBase } from './sbx-base.mjs';
import { execFileSync } from 'node:child_process';

const SBX = mkdtempSync(join(sandboxBase(), 'memsbx-C-'));
const HOME = join(SBX, 'home');
const PROJECT = join(SBX, 'work', 'my-app');
const V_OLD = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const V_NEW = V_OLD.replace(/(\d+)$/, (m) => String(Number(m) + 1));
const CACHE_BASE = join(HOME, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
const OLD = join(CACHE_BASE, V_OLD);
const NEW = join(CACHE_BASE, V_NEW);
const DATA = join(HOME, '.claude-mem-lite');
const SESSION = 'cccccccc-1111-2222-3333-444444444444';

console.log(`sandbox: ${SBX}\n${V_OLD} -> ${V_NEW}`);
mkdirSync(join(HOME, '.claude'), { recursive: true });
mkdirSync(join(HOME, 'tmp'), { recursive: true });
mkdirSync(PROJECT, { recursive: true });
makeFakeClaudeBin(HOME);
execFileSync('git', ['init', '-q'], { cwd: PROJECT });
writeFileSync(join(PROJECT, 'app.js'), 'export const answer = 42;\n');
writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-mem-lite@sdsrss': true } }, null, 2));

const envFor = (root) => sandboxEnv(HOME, { CLAUDE_PLUGIN_ROOT: root });
const ssPayload = { session_id: SESSION, cwd: PROJECT, hook_event_name: 'SessionStart', source: 'startup' };

// ── install the "old" version and use it ────────────────────────────────────
setPhase('C1: baseline — plugin installed and working');
snapshotRepo(OLD);
let r = runHook(`bash "${OLD}/scripts/setup.sh"`, {}, { env: envFor(OLD), cwd: PROJECT });
check('initial setup.sh exits 0', () => ({ ok: r.code === 0, detail: `exit=${r.code}` }));
check('initial install has a working binding', () => {
  const p = node(['-e', `const {createRequire}=require('node:module');const D=createRequire(${JSON.stringify(join(OLD, 'package.json'))})('better-sqlite3');new D(':memory:').close()`], { env: envFor(OLD) });
  return { ok: p.code === 0, detail: `exit=${p.code}` };
});
const save = node([join(OLD, 'cli.mjs'), 'save', '--type', 'bugfix', '--lesson', 'Pre-update memory must survive the version swap.', 'Memory written before the plugin update'], { env: envFor(OLD), cwd: PROJECT });
check('a memory is saved before the update', () => ({ ok: save.code === 0, detail: (save.stdout || save.stderr).slice(0, 200) }));

// ── the update: Claude Code drops in a new version dir ─────────────────────
setPhase('C2: /plugin update — new cache version dir appears (no node_modules)');
snapshotRepo(NEW);
for (const f of ['package.json', join('.claude-plugin', 'plugin.json'), join('.claude-plugin', 'marketplace.json')]) {
  const p = join(NEW, f);
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll(V_OLD, V_NEW));
}
check('new version dir has no node_modules (as Claude Code leaves it)', () => !existsSync(join(NEW, 'node_modules')));
check('old version dir still present until pruning', () => existsSync(join(OLD, 'node_modules')));

// ── the very first hook fire from the NEW root, BEFORE setup.sh ─────────────
// Claude Code runs setup.sh first in the SessionStart chain, but PreToolUse /
// UserPromptSubmit from the new root can also be the first thing that fires
// after a mid-session update.
setPhase('C3: a hook fires from the NEW root before its deps exist');
const preTool = { session_id: SESSION, cwd: PROJECT, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(PROJECT, 'app.js') } };
r = runHook(`node "${NEW}/scripts/hook-launcher.mjs" scripts/pre-tool-recall.js`, preTool, { env: envFor(NEW), cwd: PROJECT });
check('hook from a depless new root still exits 0 (no stack trace in the session)', () => ({ ok: r.code === 0, detail: `exit=${r.code} stderr=${r.stderr.slice(0, 250)}` }));
check('hook from a depless new root writes nothing broken to stdout', () => {
  const s = r.stdout.trim();
  if (!s) return { ok: true, detail: '(empty)' };
  try { JSON.parse(s); return { ok: true, detail: 'json' }; } catch { return { ok: false, detail: s.slice(0, 200) }; }
});

// ── SessionStart on the new root: setup.sh must provision it ───────────────
setPhase('C4: first SessionStart on the new version — setup.sh provisions deps');
const t0 = Date.now();
r = runHook(`bash "${NEW}/scripts/setup.sh"`, {}, { env: envFor(NEW), cwd: PROJECT });
const ms = Date.now() - t0;
check('setup.sh on the new version exits 0', () => ({ ok: r.code === 0, detail: `exit=${r.code} in ${ms}ms; ${r.stderr.split('\n').slice(-4).join(' | ')}` }));
check('new version has a working binding after setup.sh', () => {
  const p = node(['-e', `const {createRequire}=require('node:module');const D=createRequire(${JSON.stringify(join(NEW, 'package.json'))})('better-sqlite3');new D(':memory:').close()`], { env: envFor(NEW) });
  return { ok: p.code === 0, detail: `exit=${p.code} ${p.stderr.split('\n')[0]}` };
});
check('no .deps-broken flag after the update', () => {
  const f = join(DATA, 'runtime', '.deps-broken');
  return { ok: !existsSync(f), detail: existsSync(f) ? readFileSync(f, 'utf8') : '' };
});

// ── the user's memory must still be there and reachable ────────────────────
setPhase('C5: memory survives and is reachable from the new version');
r = runHook(`node "${NEW}/scripts/hook-launcher.mjs" hook.mjs session-start`, ssPayload, { env: envFor(NEW), cwd: PROJECT });
check('session-start from the new version exits 0', () => ({ ok: r.code === 0, detail: `exit=${r.code} ${r.stderr.slice(0, 250)}` }));
const q = node([join(NEW, 'cli.mjs'), 'search', 'before the plugin update'], { env: envFor(NEW), cwd: PROJECT });
check('the pre-update memory is still searchable', () => ({
  ok: q.code === 0 && /before the plugin update/i.test(q.stdout),
  detail: `exit=${q.code} ${(q.stdout || q.stderr).slice(0, 250)}`,
}));
const mcp = await mcpSession(process.execPath, [join(NEW, 'scripts', 'launch.mjs')], {
  env: envFor(NEW), cwd: PROJECT,
  requests: [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sbx', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_search', arguments: { query: 'before the plugin update' } } },
  ],
});
check('MCP from the new version answers with the old memory', () => {
  const t = mcp.responses.find((x) => x.id === 2)?.result?.content?.[0]?.text || '';
  return { ok: /before the plugin update/i.test(t), detail: (t || mcp.stderr).slice(0, 250) };
});

// ── pruning ────────────────────────────────────────────────────────────────
setPhase('C6: cache pruning keeps the latest 3');
for (const v of ['3.60.0', '3.61.0', '3.62.0', '3.63.0']) {
  mkdirSync(join(CACHE_BASE, v), { recursive: true });
  writeFileSync(join(CACHE_BASE, v, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version: v }));
}
r = runHook(`bash "${NEW}/scripts/setup.sh"`, {}, { env: envFor(NEW), cwd: PROJECT });
check('setup.sh prunes to the latest 3 versions', () => {
  const left = readdirSync(CACHE_BASE).filter((n) => /^\d+\./.test(n)).sort();
  return { ok: left.length === 3 && left.includes(V_NEW), detail: left.join(',') };
});
check('pruning did not delete the version currently running', () => existsSync(join(NEW, 'cli.mjs')));

console.log(`\nsandbox kept at: ${SBX}`);
process.exit(summary() > 0 ? 1 : 0);
