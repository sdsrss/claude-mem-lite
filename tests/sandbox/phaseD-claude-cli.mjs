// phaseD-claude-cli.mjs — the documented install, run by the REAL Claude Code CLI.
//
//   claude plugin marketplace add sdsrss/claude-mem-lite
//   claude plugin install claude-mem-lite@sdsrss
//
// Phases A–C reproduce what Claude Code does with a fake `claude` binary, so they cannot
// see Claude Code itself change its rules. One such rule already exists: `claude plugin
// validate` rejects the name "claude-mem-lite" as reserved (a third party's plugin name
// cannot start with "claude-"), while marketplace add and install still succeed — seen on
// 2.1.303 and again on 2.1.322 (D#463). Renaming breaks every /claude-mem-lite:* command, the MCP tool prefix
// and the enabledPlugins key, so the day that rule reaches the install path is the day
// to know — this phase is that alarm. It installs from GitHub on purpose: a local
// directory source skips the clone-and-validate step a real user's install goes through.
//
// Needs `claude` on PATH and network access. A missing CLI is a failure, not a skip.

import {
  setPhase,
  check,
  summary,
  run,
  sandboxEnv,
  join,
  existsSync,
  readFileSync,
  mkdirSync,
} from './lib.mjs';
import { mkdtempSync } from 'node:fs';
import { sandboxBase } from './sbx-base.mjs';

const SBX = mkdtempSync(join(sandboxBase(), 'memsbx-D-'));
const HOME = join(SBX, 'home');
const MP = 'sdsrss';
const PLUGIN = `claude-mem-lite@${MP}`;
// Same convention as phases A–C: a phase that quietly shrinks has stopped measuring.
const EXPECTED_CHECKS = 8;

console.log(`sandbox: ${SBX}`);
mkdirSync(join(HOME, 'tmp'), { recursive: true });
const env = sandboxEnv(HOME);
const claude = (args, timeout = 180_000) => run('claude', args, { env, cwd: SBX, timeout });
const tail = (r) => `exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`;

setPhase('Real Claude Code CLI');
let version = '';
check('claude CLI runs', () => {
  const r = claude(['--version'], 30_000);
  version = r.stdout.trim();
  return { ok: r.code === 0 && version.length > 0, detail: r.code === 0 ? version : tail(r) };
});

setPhase('Documented install, from GitHub');
check(`claude plugin marketplace add ${MP}/claude-mem-lite exits 0`, () => {
  const r = claude(['plugin', 'marketplace', 'add', `${MP}/claude-mem-lite`]);
  return { ok: r.code === 0, detail: tail(r) };
});

// The version under test is the one the marketplace clone declares, not this checkout's.
const manifest = join(HOME, '.claude', 'plugins', 'marketplaces', MP, '.claude-plugin', 'plugin.json');
let pluginVersion = '';
check('the marketplace clone declares the plugin', () => {
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  pluginVersion = m.version;
  return { ok: m.name === 'claude-mem-lite' && !!pluginVersion, detail: `${m.name}@${m.version}` };
});

check(`claude plugin install ${PLUGIN} exits 0`, () => {
  const r = claude(['plugin', 'install', PLUGIN]);
  return { ok: r.code === 0, detail: tail(r) };
});

const cacheDir = () => join(HOME, '.claude', 'plugins', 'cache', MP, 'claude-mem-lite', pluginVersion);
check('the plugin is copied into the cache under its version', () => {
  const p = join(cacheDir(), '.claude-plugin', 'plugin.json');
  return { ok: existsSync(p) && JSON.parse(readFileSync(p, 'utf8')).name === 'claude-mem-lite', detail: p };
});

// Claude Code 2.1.322 installs the packages a plugin's package.json lists, unless it sets
// `overrides` ("plugin list" then notes they were not installed). Ours does: the overrides
// are security floors for transitive dependencies, which setup.sh's own `npm install`
// applies. So the cache arrives without node_modules — the shape phases A–C stand in and
// setup.sh provisions. A Claude Code that starts installing here (for one, by applying
// overrides) changes that shape, and this is where it shows.
check('the cache has no node_modules (the shape phases A–C model)', () => {
  const nm = join(cacheDir(), 'node_modules');
  return {
    ok: !existsSync(nm),
    detail: existsSync(nm) ? `${nm} exists: Claude Code installed the dependencies itself` : 'absent',
  };
});

check('settings.json enables the plugin', () => {
  const s = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
  return { ok: s.enabledPlugins?.[PLUGIN] === true, detail: JSON.stringify(s.enabledPlugins) };
});

check('claude plugin list names it', () => {
  const r = claude(['plugin', 'list'], 60_000);
  return { ok: r.code === 0 && r.stdout.includes(PLUGIN), detail: tail(r) };
});

// Context, not a check: the validator's verdict on the clone, so a reader of a red run can
// see whether the reserved-name rule is the cause. It fails today (D#463) and that is known.
const v = claude(['plugin', 'validate', join(HOME, '.claude', 'plugins', 'marketplaces', MP)], 60_000);
const errors = `${v.stdout}\n${v.stderr}`
  .split('\n')
  .filter((l) => l.includes('❯'))
  .slice(0, 2)
  .map((l) => `  ${l.trim()}`);
console.log(`\nclaude ${version} — plugin validate on the clone: exit ${v.code}\n${errors.join('\n')}`);

console.log(`\nsandbox kept at: ${SBX}`);
process.exit(summary(EXPECTED_CHECKS) > 0 ? 1 : 0);
