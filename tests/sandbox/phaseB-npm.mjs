// phaseB-npm.mjs — simulate a real user installing the npm way:
//   npm i -g claude-mem-lite     (README "Method 2/3" + the optional shell CLI)
//   claude-mem-lite install
// then exercise functionality, the real auto-update path, self-heal, and uninstall.

import {
  REPO,
  setPhase,
  check,
  summary,
  node,
  run,
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
} from './lib.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { sandboxBase } from './sbx-base.mjs';
// Asked, not spelled: B9 builds a plugin cache at the path install.mjs will walk, and a
// hardcoded 'sdsrss' here would keep passing after a marketplace rename while testing a
// directory nothing writes.
import { MARKETPLACE_KEY } from '../../lib/plugin-key.mjs';

const SBX = mkdtempSync(join(sandboxBase(), 'memsbx-B-'));
const HOME = join(SBX, 'home');
const PROJECT = join(SBX, 'work', 'my-app');
const NPM_PREFIX = join(SBX, 'npm-global');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const DATA = join(HOME, '.claude-mem-lite');
const SESSION = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

// Every check this phase must run — see summary()'s doc. B8 lost eight checks to a stale
// path behind an `if`, and the tally was the only witness.
// 56 = 53 `check(` call sites, one of which (the CLI-subcommand loop) runs four times.
// Derived by enumerating the call sites, NOT by copying what a run printed — the README
// carried 45 for a revision that had 44, which is how a wrong tally survives.
// 45 → 52: B9 (R10-P2-11, plugin-cache launch.mjs sync) adds seven, two of them premises
// without which the section measures nothing and says PASS.
// 52 → 56: B10 (R10-P2-12, install under live hook traffic) adds four, one a premise that
// fails if the loop never overlapped the install — a stress probe that did not overlap is
// not a negative result, it is no result.
const EXPECTED_CHECKS = 56;

// A real user's settings.json is not empty, and "uninstall left nothing behind" is only
// meaningful against something it MUST leave behind. The end-of-phase check used to count
// surviving hook groups and then `return { ok: true }` — unfailable by construction, and
// counting a file that had never held a foreign hook in the first place.
const FOREIGN_HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other-plugin-hook' }] };

console.log(`sandbox: ${SBX}\nversion: ${VERSION}`);
mkdirSync(join(HOME, '.claude'), { recursive: true });
mkdirSync(join(HOME, 'tmp'), { recursive: true });
mkdirSync(PROJECT, { recursive: true });
mkdirSync(NPM_PREFIX, { recursive: true });
makeFakeClaudeBin(HOME);
writeFileSync(
  join(HOME, '.claude', 'settings.json'),
  JSON.stringify({ hooks: { PostToolUse: [FOREIGN_HOOK] } }, null, 2),
);
execFileSync('git', ['init', '-q'], { cwd: PROJECT });
writeFileSync(join(PROJECT, 'app.js'), 'export const answer = 42;\n');

const ENV = sandboxEnv(HOME, {
  PATH: `${join(NPM_PREFIX, 'bin')}:${join(HOME, 'bin')}:${process.env.PATH}`,
  npm_config_prefix: NPM_PREFIX,
});
const CLI = join(NPM_PREFIX, 'bin', 'claude-mem-lite');

// ── 1. npm pack + npm i -g (exactly what a user runs) ───────────────────────
setPhase('B1: npm pack + npm i -g <tarball>');

const packOut = run('npm', ['pack', '--pack-destination', SBX], {
  cwd: REPO,
  env: process.env,
  timeout: 300_000,
});
const tarball = join(SBX, packOut.stdout.trim().split('\n').pop());
check('npm pack produced a tarball', () => ({
  ok: existsSync(tarball),
  detail: `${tarball} ${packOut.stderr.slice(-200)}`,
}));

const gi = run('npm', ['install', '-g', tarball, '--no-audit', '--no-fund'], {
  env: ENV,
  cwd: SBX,
  timeout: 600_000,
});
check('npm i -g succeeds', () => ({
  ok: gi.code === 0,
  detail: `exit=${gi.code} ${(gi.stdout + gi.stderr).slice(-500)}`,
}));
check('claude-mem-lite lands on PATH', () => ({ ok: existsSync(CLI), detail: CLI }));
check('the globally-installed package can run at all', () => {
  const r = run(CLI, ['--help'], { env: ENV, cwd: PROJECT });
  return {
    ok: r.code === 0 && /claude-mem-lite/.test(r.stdout + r.stderr),
    detail: `exit=${r.code} ${(r.stdout || r.stderr).slice(0, 200)}`,
  };
});

// The npm-shipped tarball is what auto-update also unpacks; a missing file here
// is invisible to every repo-run test.
setPhase('B2: shipped tarball completeness');
const globalPkgDir = join(NPM_PREFIX, 'lib', 'node_modules', 'claude-mem-lite');
check('better-sqlite3 present in the global install', () =>
  existsSync(join(globalPkgDir, 'node_modules', 'better-sqlite3')),
);
// npm >= 12 ships with lifecycle scripts blocked, so `npm i -g` ALWAYS leaves
// better-sqlite3 uncompiled and no postinstall hook can fix that from inside the
// package. What must hold is that the user never meets the failure: the CLI
// heals and re-execs on first DB use.
check('ships lib/install-shape.mjs (doctor imports it — a missing file breaks the recovery command)', () =>
  existsSync(join(globalPkgDir, 'lib', 'install-shape.mjs')),
);
check('the CLI works on first use despite npm leaving the binding uncompiled', () => {
  const r = run(CLI, ['stats'], { env: ENV, cwd: PROJECT, timeout: 600_000 });
  return { ok: r.code === 0, detail: `exit=${r.code} ${(r.stdout || r.stderr).slice(0, 200)}` };
});

// ── 3. claude-mem-lite install ──────────────────────────────────────────────
setPhase('B3: claude-mem-lite install');

const inst = run(CLI, ['install'], { env: ENV, cwd: PROJECT, timeout: 600_000 });
check('install exits 0', () => ({
  ok: inst.code === 0,
  detail: `exit=${inst.code} ${(inst.stdout + inst.stderr).slice(-700)}`,
}));
check(
  'code deployed into ~/.claude-mem-lite',
  () =>
    existsSync(join(DATA, 'server.mjs')) &&
    existsSync(join(DATA, 'hook.mjs')) &&
    existsSync(join(DATA, 'cli.mjs')),
);
check('hooks registered in settings.json', () => {
  const s = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
  const events = Object.keys(s.hooks || {});
  return { ok: events.length >= 5, detail: events.join(',') };
});
check('MCP registered via the claude CLI', () => {
  const st = join(HOME, '.claude', 'mcp-state.txt');
  const txt = existsSync(st) ? readFileSync(st, 'utf8') : '';
  return { ok: /mem-lite/.test(txt), detail: txt.trim() };
});
check('doctor is green on the install it just made', () => {
  const r = run(CLI, ['doctor'], { env: ENV, cwd: PROJECT, timeout: 120_000 });
  return {
    ok: r.code === 0,
    detail: `exit=${r.code}\n${
      (r.stdout || r.stderr)
        .split('\n')
        .filter((l) => /✗|issue/.test(l))
        .join('\n') || '(no ✗ lines)'
    }`,
  };
});
check('status is green on the install it just made', () => {
  const r = run(CLI, ['status'], { env: ENV, cwd: PROJECT, timeout: 120_000 });
  return {
    ok: r.code === 0 && !/✗/.test(r.stdout),
    detail: `exit=${r.code}\n${
      (r.stdout || r.stderr)
        .split('\n')
        .filter((l) => /✗/.test(l))
        .join('\n') || '(no ✗ lines)'
    }`,
  };
});

// ── 4. Functionality through the installed CLI ──────────────────────────────
setPhase('B4: functionality via the installed CLI');

check('save writes a memory', () => {
  const r = run(
    CLI,
    [
      'save',
      '--type',
      'bugfix',
      '--lesson',
      'Stale ABI bindings must be rebuilt, not reinstalled.',
      'Sandbox npm-form smoke memory about sqlite binding repair',
    ],
    { env: ENV, cwd: PROJECT },
  );
  return { ok: r.code === 0, detail: `exit=${r.code} ${(r.stdout || r.stderr).slice(0, 250)}` };
});
check('search finds it back', () => {
  const r = run(CLI, ['search', 'sqlite binding repair'], { env: ENV, cwd: PROJECT });
  return {
    ok: r.code === 0 && /Sandbox npm-form smoke/i.test(r.stdout),
    detail: `exit=${r.code} ${(r.stdout || r.stderr).slice(0, 300)}`,
  };
});
for (const [label, args] of [
  ['recent', ['recent', '3']],
  ['stats', ['stats']],
  ['timeline', ['timeline']],
  ['activity', ['activity', 'recent']],
]) {
  const r = run(CLI, args, { env: ENV, cwd: PROJECT });
  check(`CLI ${label} exits 0`, () => ({
    ok: r.code === 0,
    detail: `exit=${r.code} ${(r.stdout || r.stderr).slice(0, 200)}`,
  }));
}

// ── 5. Hooks fire from settings.json (the install.mjs-managed shape) ────────
setPhase('B5: settings.json hooks actually fire');

const settings = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
const fired = [];
for (const [event, groups] of Object.entries(settings.hooks || {})) {
  for (const g of groups) {
    for (const h of g.hooks || []) {
      const cmd = String(h.command || '');
      if (!/claude-mem-lite|hook-launcher|post-tool-use/.test(cmd)) continue;
      const payload = {
        session_id: SESSION,
        cwd: PROJECT,
        hook_event_name: event,
        source: 'startup',
        prompt: 'why did the binding break?',
        tool_name: event.startsWith('Pre') || event.startsWith('Post') ? 'Edit' : undefined,
        tool_input: { file_path: join(PROJECT, 'app.js'), old_string: '42', new_string: '43' },
        tool_response: { filePath: join(PROJECT, 'app.js'), success: true },
      };
      const r = runHook(cmd, payload, { env: { ...ENV, CLAUDE_MEM_SKIP_SUMMARY: '1' }, cwd: PROJECT });
      fired.push({ event, cmd, code: r.code, stderr: r.stderr, stdout: r.stdout });
    }
  }
}
check('every registered hook exits 0', () => {
  const bad = fired.filter((f) => f.code !== 0);
  return {
    ok: bad.length === 0,
    detail:
      bad.map((b) => `${b.event}: exit=${b.code} ${b.stderr.slice(0, 200)}`).join('\n') ||
      `${fired.length} hooks fired clean`,
  };
});
// A surface may speak pure JSON or pure prose; it may NOT mix the two, because a
// JSON document followed by raw prose stops the host parsing the envelope at all.
check('no hook mixes a JSON envelope with raw prose on one stdout', () => {
  const bad = fired.filter((f) => {
    const s = f.stdout.trim();
    if (!s) return false;
    try {
      JSON.parse(s);
      return false;
    } catch {
      /* not one document — look closer */
    }
    return s.split('\n').some((l) => l.trim().startsWith('{'));
  });
  return {
    ok: bad.length === 0,
    detail:
      bad.map((b) => `${b.event}: ${b.stdout.slice(0, 220)}`).join('\n') || `${fired.length} surfaces clean`,
  };
});
check('SessionStart specifically emits exactly one envelope', () => {
  const ss = fired.filter((f) => f.event === 'SessionStart' && f.stdout.trim());
  const bad = ss.filter((f) => {
    try {
      JSON.parse(f.stdout.trim());
      return false;
    } catch {
      return true;
    }
  });
  return {
    ok: bad.length === 0,
    detail:
      bad.map((b) => b.stdout.slice(0, 220)).join('\n') ||
      `${ss.length} SessionStart write(s), all single-envelope`,
  };
});
check('no hook wrote a settings-referenced path that does not exist (orphan check)', () => {
  const r = run(CLI, ['status'], { env: ENV, cwd: PROJECT });
  return { ok: !/Orphan/.test(r.stdout), detail: r.stdout.slice(0, 300) };
});

// ── 6. MCP server from the managed install ─────────────────────────────────
setPhase('B6: MCP server from ~/.claude-mem-lite');

const mcp = await mcpSession(process.execPath, [join(DATA, 'server.mjs')], {
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
          content: 'MCP-form save from the npm install sandbox',
          title: 'npm-form MCP smoke',
          type: 'decision',
          lesson_learned: 'The managed install runs server.mjs directly, not through launch.mjs.',
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'mem_search', arguments: { query: 'npm-form MCP smoke' } },
    },
  ],
});
check('MCP initialize + tools/list', () => {
  const a = mcp.responses.find((x) => x.id === 1);
  const b = mcp.responses.find((x) => x.id === 2);
  return {
    ok: !!a?.result?.serverInfo && (b?.result?.tools || []).length === 9,
    detail: `${(b?.result?.tools || []).length} tools; ${mcp.stderr.slice(0, 200)}`,
  };
});
check('MCP mem_save then mem_search round-trips', () => {
  const s = mcp.responses.find((x) => x.id === 3);
  const q = mcp.responses.find((x) => x.id === 4);
  const qt = q?.result?.content?.[0]?.text || '';
  return {
    ok: !s?.result?.isError && /npm-form MCP smoke/i.test(qt),
    detail: `${(s?.result?.content?.[0]?.text || '').slice(0, 120)} || ${qt.slice(0, 200)}`,
  };
});

// ── 7. Auto-update: the real staged-install path against a mock release ─────
setPhase('B7: auto-update (managed form)');

check('self-update in a healthy install exits 0 (no-op when current)', () => {
  // CLAUDE_MEM_FORCE_UPDATE_CHECK removed (P1-13): nothing in the tree reads it, so it was
  // decoration implying a force mechanism that does not exist. `self-update` is explicit and
  // needs no forcing.
  const r = run(CLI, ['self-update'], { env: ENV, cwd: PROJECT, timeout: 180_000 });
  return { ok: r.code === 0, detail: `exit=${r.code} ${(r.stdout || r.stderr).slice(0, 400)}` };
});
check('doctor never prescribes `claude-mem-lite update` (that is the observation editor)', () => {
  const r = run(CLI, ['doctor'], { env: ENV, cwd: PROJECT, timeout: 120_000 });
  const bad = (r.stdout || '').match(/claude-mem-lite update(?!\s*<)/);
  return { ok: !bad, detail: bad ? bad[0] : '(clean)' };
});
check('update did not damage the install', () => {
  const r = run(CLI, ['doctor'], { env: ENV, cwd: PROJECT, timeout: 120_000 });
  return {
    ok: r.code === 0,
    detail: `doctor exit=${r.code} ${(r.stdout || '')
      .split('\n')
      .filter((l) => /✗/.test(l))
      .join(' | ')}`,
  };
});
check('update state file written to the data dir', () => {
  const f = join(DATA, 'runtime', 'update-state.json');
  return { ok: existsSync(f), detail: existsSync(f) ? readFileSync(f, 'utf8').slice(0, 250) : 'missing' };
});

// ── 8. Self-heal in the managed form ────────────────────────────────────────
setPhase('B8: self-heal — broken binding in the managed install');

// Break the tree the HOOKS and the registered MCP server resolve, and leave the
// tree the CLI itself resolves healthy. This is the asymmetry doctor used to be
// blind to: it answered about its own tree and called the system healthy.
const nmHost = DATA;
// Resolved, not named. The literal `build/Release/better_sqlite3.node` this line used to
// carry is a better-sqlite3 **12** path; 13 ships `prebuilds/<platform>.node`. So from
// v4.0.0 the guard went red on its first check and the `if` swallowed the other EIGHT —
// the entire self-heal-and-doctor half of the npm path, measured by nothing. The `if` is
// gone: a tree with no addon now fails every check below, loudly.
const bind = loadedBindingPath(nmHost);
check('managed install has its own binding', () => ({
  ok: !!bind,
  detail: bind ?? `no better-sqlite3 addon resolves under ${nmHost}`,
}));
check('the break landed on the addon the resolver loads', () => breakBinding(nmHost));
{
  check("control: the CLI's OWN tree is still healthy (so a green verdict would be the bug)", () => {
    const r = node(
      [
        '-e',
        `const {createRequire}=require('node:module');const D=createRequire(${JSON.stringify(join(globalPkgDir, 'package.json'))})('better-sqlite3');new D(':memory:').close()`,
      ],
      { env: ENV },
    );
    return { ok: r.code === 0, detail: `exit=${r.code}` };
  });
  check('control: the registered MCP server really is dead in this state', () => {
    const r = node([join(DATA, 'server.mjs')], { env: ENV, cwd: PROJECT, input: '', timeout: 20_000 });
    return { ok: r.code !== 0, detail: `exit=${r.code} ${(r.stderr || '').split('\n')[0].slice(0, 160)}` };
  });
  check('a hook fire on a broken binding still exits 0 (never spams a stack trace)', () => {
    const r = runHook(
      `node "${join(DATA, 'scripts', 'hook-launcher.mjs')}" scripts/pre-tool-recall.js`,
      {
        session_id: SESSION,
        cwd: PROJECT,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: join(PROJECT, 'app.js') },
      },
      { env: ENV, cwd: PROJECT },
    );
    return { ok: r.code === 0, detail: `exit=${r.code} ${r.stderr.slice(0, 250)}` };
  });
  check('doctor NAMES the broken binding instead of going quietly green', () => {
    const r = run(CLI, ['doctor'], { env: ENV, cwd: PROJECT, timeout: 120_000 });
    return {
      ok: r.code === 1 && /binding/i.test(r.stdout),
      detail: `exit=${r.code} ${(r.stdout || '')
        .split('\n')
        .filter((l) => /✗|binding/i.test(l))
        .join(' | ')
        .slice(0, 300)}`,
    };
  });
  check('rebuild-binding repairs it', () => {
    const r = run(CLI, ['rebuild-binding'], { env: ENV, cwd: PROJECT, timeout: 600_000 });
    return { ok: r.code === 0, detail: `exit=${r.code} ${(r.stdout || r.stderr).slice(-300)}` };
  });
  check('binding loads again', () => bindingLoads(nmHost, ENV));
  check('doctor is green again after the repair', () => {
    const r = run(CLI, ['doctor'], { env: ENV, cwd: PROJECT, timeout: 120_000 });
    return {
      ok: r.code === 0,
      detail: `exit=${r.code} ${(r.stdout || '')
        .split('\n')
        .filter((l) => /✗/.test(l))
        .join(' | ')}`,
    };
  });
}

// ── 9. Plugin-cache launch.mjs sync (R10-P2-11) ─────────────────────────────
setPhase('B9: install must not push HEAD launch.mjs into OLDER cache version dirs');

// R10 §8: "do not touch install() without reproducing in phaseB". This section is that
// reproduction, and it needs a shape phase B never had — a populated plugin cache. The
// managed npm install and the plugin cache coexist on any machine that tried both install
// methods, which is the population this defect lives in.
//
// The mechanism: dedupePluginCacheAndHooks() walks EVERY version dir under the cache and
// copies the INSTALLER's launch.mjs + launch-preflight.mjs into each one. The comment above
// it says "ensures MCP server loads dev code via symlink detection" (issue #15), but nothing
// gates it on dev mode or on the version matching. So an old cached version gets HEAD's
// entry point running against its OWN lib/ — and HEAD's launch.mjs:72-73 destructures
// `nativeBindingRepairHint` from ../lib/binding-probe.mjs, which v3.95.0 does not export.
// launch.mjs:110 then throws inside a catch, and the user's repair hint disappears.
//
// Precondition, found by running this section before writing it off as obvious: the whole
// block lives inside `if (existsSync(pluginDir))`, where pluginDir is the MARKETPLACE clone
// (~/.claude/plugins/marketplaces/<key>), not the cache. A first run that built only the
// cache measured NOTHING and reported it as "install left the old version alone" — the
// friendly-looking answer. So the audit's "every install / repair" is narrower than it
// reads: every install/repair ON A MACHINE THAT ALSO RAN `/plugin marketplace add`. That is
// still the population that has a plugin cache to damage.
const OLD_VER = '3.95.0';
const marketplaceDir = join(HOME, '.claude', 'plugins', 'marketplaces', MARKETPLACE_KEY);
mkdirSync(join(marketplaceDir, 'hooks'), { recursive: true });
writeFileSync(
  join(marketplaceDir, 'hooks', 'hooks.json'),
  JSON.stringify({ description: 'marketplace', hooks: { PostToolUse: [FOREIGN_HOOK] } }, null, 2),
);
const cacheBase = join(HOME, '.claude', 'plugins', 'cache', MARKETPLACE_KEY, 'claude-mem-lite');
const oldVerDir = join(cacheBase, OLD_VER);
const curVerDir = join(cacheBase, VERSION);
const SENTINEL = (v) => `// CACHE-SENTINEL ${v}\nprocess.exit(0);\n`;

for (const [dir, ver] of [
  [oldVerDir, OLD_VER],
  [curVerDir, VERSION],
]) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'launch.mjs'), SENTINEL(ver));
  writeFileSync(join(dir, 'scripts', 'launch-preflight.mjs'), SENTINEL(ver));
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    JSON.stringify({ description: 'cached', hooks: { PostToolUse: [FOREIGN_HOOK] } }, null, 2),
  );
}
// v3.95.0's binding-probe: the two exports launch.mjs needed THEN, and not the third it
// needs now. Verbatim shape, not a stand-in — the missing export IS the defect.
writeFileSync(
  join(oldVerDir, 'lib', 'binding-probe.mjs'),
  'export function ensureBetterSqlite3Working() {}\nexport function probeBindingInFreshProcess() {}\n',
);

check('premise: the marketplace clone exists, so install reaches its plugin-cache block at all', () => ({
  ok: existsSync(marketplaceDir),
  detail: marketplaceDir,
}));
check('premise: both cache version dirs carry their own launch.mjs before install', () => {
  const a = readFileSync(join(oldVerDir, 'scripts', 'launch.mjs'), 'utf8');
  const b = readFileSync(join(curVerDir, 'scripts', 'launch.mjs'), 'utf8');
  return {
    ok: a.includes(`CACHE-SENTINEL ${OLD_VER}`) && b.includes(`CACHE-SENTINEL ${VERSION}`),
    detail: `${a.split('\n')[0]} | ${b.split('\n')[0]}`,
  };
});

const reinst = run(CLI, ['install'], { env: ENV, cwd: PROJECT, timeout: 600_000 });
check('a second install (the shape a repair spawn also takes) exits 0', () => ({
  ok: reinst.code === 0,
  detail: `exit=${reinst.code} ${(reinst.stdout + reinst.stderr).slice(-400)}`,
}));

check(`install left the OLDER cache version (${OLD_VER}) alone`, () => {
  const txt = readFileSync(join(oldVerDir, 'scripts', 'launch.mjs'), 'utf8');
  return {
    ok: txt.includes(`CACHE-SENTINEL ${OLD_VER}`),
    detail: txt.includes('CACHE-SENTINEL')
      ? txt.split('\n')[0]
      : `overwritten with the installer's own launch.mjs (${txt.length}B)`,
  };
});
check(`no cache version dir calls an export its OWN lib does not have`, () => {
  const bad = [];
  for (const ver of readdirSync(cacheBase)) {
    const lp = join(cacheBase, ver, 'scripts', 'launch.mjs');
    const bp = join(cacheBase, ver, 'lib', 'binding-probe.mjs');
    if (!existsSync(lp) || !existsSync(bp)) continue;
    const launch = readFileSync(lp, 'utf8');
    const probe = readFileSync(bp, 'utf8');
    for (const sym of [
      'nativeBindingRepairHint',
      'ensureBetterSqlite3Working',
      'probeBindingInFreshProcess',
    ]) {
      if (launch.includes(sym) && !probe.includes(`export function ${sym}`)) bad.push(`${ver}: ${sym}`);
    }
  }
  return { ok: bad.length === 0, detail: bad.join(', ') || 'every version dir self-consistent' };
});
check(`install still syncs the CURRENT version dir (${VERSION}) — issue #15's actual job`, () => {
  const txt = readFileSync(join(curVerDir, 'scripts', 'launch.mjs'), 'utf8');
  return {
    ok: !txt.includes('CACHE-SENTINEL'),
    detail: txt.includes('CACHE-SENTINEL') ? txt.split('\n')[0] : `synced (${txt.length}B)`,
  };
});
check('cached hooks.json is still cleared in EVERY version dir (the other half of this block)', () => {
  const bad = [];
  for (const ver of readdirSync(cacheBase)) {
    const hp = join(cacheBase, ver, 'hooks', 'hooks.json');
    if (!existsSync(hp)) continue;
    const h = JSON.parse(readFileSync(hp, 'utf8'));
    if (Object.keys(h.hooks || {}).length > 0) bad.push(ver);
  }
  return { ok: bad.length === 0, detail: bad.join(',') || 'all cleared' };
});

// ── 10. In-place install under live hook traffic (R10-P2-12) ────────────────
setPhase('B10: hooks firing DURING an in-place install');

// R10-P2-12, mechanism-only in the report: install() / repair overwrite ~/.claude-mem-lite
// file by file with no swap barrier (hook-update.mjs has one — markSwapStart/clearSwapMarker
// at :727/:736, honoured by scripts/hook-launcher.mjs:149 — install does not), while
// PreToolUse / PostToolUse import that same tree on every tool call. The claimed harm is a
// mixed module graph -> ERR_MODULE_NOT_FOUND -> recordBreakage -> the next SessionStart
// spawns repair -> again, capped only by a 6h cooldown.
//
// This is a race, so it gets a stress probe, not a demonstration: fire the launcher in a
// loop for the whole duration of an install and see whether ANY fire lands in a torn tree.
// Two premises keep the result honest — the loop must actually overlap the install, and it
// must fire enough times to have had the chance.
// Sizing, learned by running it: a re-install finishes in ~450ms, while one launcher fire
// costs a bash+node cold start. The first attempt logged 0 of 400 fires inside the window
// and reported it as a clean run — a stress probe that never overlapped is not a negative
// result, it is no result. Hence: four parallel loops, a warm-up barrier before the window
// opens, and five back-to-back installs to widen it.
const fireLog = join(SBX, 'p212-fires.txt');
const fireErr = join(SBX, 'p212-fires.err');
const warmFlag = join(SBX, 'p212-warm.txt');
const launcher = join(DATA, 'scripts', 'hook-launcher.mjs');
const errDir = join(DATA, 'runtime', 'hook-errors');
const errBefore = new Set(existsSync(errDir) ? readdirSync(errDir) : []);
const errSizeBefore = [...errBefore].reduce((n, f) => n + readFileSync(join(errDir, f), 'utf8').length, 0);
// A real PreToolUse payload, not an empty stdin. The first run fired with </dev/null and
// every one of the 480 fires recorded a breakage — 198 KB of them — which reads exactly
// like the defect and was the probe's own doing.
const firePayload = JSON.stringify({
  session_id: SESSION,
  cwd: PROJECT,
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: join(PROJECT, 'app.js'), old_string: '42', new_string: '43' },
});
const payloadFile = join(SBX, 'p212-payload.json');
writeFileSync(payloadFile, firePayload);
const loops = [0, 1, 2, 3].map((i) =>
  spawn(
    'bash',
    [
      '-c',
      `echo ${i} >> ${JSON.stringify(warmFlag)}; for n in $(seq 1 120); do ` +
        `node ${JSON.stringify(launcher)} scripts/pre-tool-recall.js >/dev/null 2>>${JSON.stringify(fireErr)} <${JSON.stringify(payloadFile)}; ` +
        // %s%N, normalised in JS. `date +%s%3N` printed 19 digits here (full nanoseconds,
        // width ignored), so every timestamp compared larger than Date.now() and the
        // overlap count was 0 by arithmetic rather than by scheduling.
        `echo "$? $(date +%s%N)" >> ${JSON.stringify(fireLog)}; done`,
    ],
    { env: ENV, cwd: PROJECT, stdio: 'ignore' },
  ),
);
// Open the window only once every loop has produced a fire, so the node cold start is
// outside it rather than eating it.
for (let i = 0; i < 100; i++) {
  const lines = existsSync(fireLog) ? readFileSync(fireLog, 'utf8').split('\n').filter(Boolean).length : 0;
  if (lines >= 4) break;
  await new Promise((r) => setTimeout(r, 200));
}
const installStart = Date.now();
let raceInst = { code: 0, stdout: '', stderr: '' };
for (let i = 0; i < 5; i++) {
  raceInst = run(CLI, ['install'], { env: ENV, cwd: PROJECT, timeout: 600_000 });
  if (raceInst.code !== 0) break;
}
const installEnd = Date.now();
await Promise.all(
  loops.map(
    (l) =>
      new Promise((resolve) => {
        l.on('exit', resolve);
        setTimeout(() => {
          try {
            l.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          resolve();
        }, 90_000);
      }),
  ),
);

const fires = existsSync(fireLog)
  ? readFileSync(fireLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [code, ts] = l.split(/\s+/);
        // Slice, don't divide: a 19-digit nanosecond string is past 2^53, so Number()
        // loses precision before any arithmetic can normalise it. The first 13 digits are
        // epoch-ms whether the shell gave us ms or ns.
        return { code: Number(code), ts: Number(String(ts).slice(0, 13)) };
      })
  : [];
const during = fires.filter((f) => f.ts >= installStart && f.ts <= installEnd);

check('premise: hook fires actually overlapped the install window', () => ({
  ok: during.length >= 5,
  detail: `${during.length} of ${fires.length} fires inside the ${installEnd - installStart}ms of installs`,
}));
check('the concurrent installs all exit 0', () => ({
  ok: raceInst.code === 0,
  detail: `exit=${raceInst.code} ${(raceInst.stdout + raceInst.stderr).slice(-300)}`,
}));
check('no hook fire hit a torn module graph during the install', () => {
  const err = existsSync(fireErr) ? readFileSync(fireErr, 'utf8') : '';
  const modErrs = err
    .split('\n')
    .filter((l) => /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/.test(l));
  const nonZero = during.filter((f) => f.code !== 0);
  return {
    ok: modErrs.length === 0 && nonZero.length === 0,
    detail:
      modErrs.slice(0, 3).join(' | ') ||
      (nonZero.length ? `${nonZero.length} non-zero exits` : `${during.length} fires clean`),
  };
});
check('no NEW breakage was recorded (what would drive the repair loop)', () => {
  // Delta, not absolute: the first version of this check counted the whole directory and
  // went red on entries this probe's own empty-stdin fires had written before the window
  // even opened. A pre-existing breakage is a different finding, not this one.
  const files = existsSync(errDir) ? readdirSync(errDir) : [];
  const sizeAfter = files.reduce((n, f) => n + readFileSync(join(errDir, f), 'utf8').length, 0);
  const newFiles = files.filter((f) => !errBefore.has(f));
  // Name the signatures rather than the byte count: "198720 bytes appeared" cannot tell a
  // torn module graph from a payload the probe malformed.
  const sigs = new Set();
  for (const f of files) {
    for (const line of readFileSync(join(errDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        sigs.add(String(r.error || r.message || r.reason || '').slice(0, 80));
      } catch {
        sigs.add(line.slice(0, 80));
      }
    }
  }
  return {
    ok: newFiles.length === 0 && sizeAfter === errSizeBefore,
    detail:
      newFiles.length || sizeAfter !== errSizeBefore
        ? `bytes ${errSizeBefore}→${sizeAfter}; signatures: ${[...sigs].slice(0, 3).join(' | ')}`
        : `unchanged (${errSizeBefore}B in ${files.length} file(s))`,
  };
});

// ── 11. Uninstall ───────────────────────────────────────────────────────────
setPhase('B11: uninstall (data preserved) then --purge');

const un = run(CLI, ['uninstall'], { env: ENV, cwd: PROJECT, timeout: 180_000 });
check('uninstall exits 0', () => ({
  ok: un.code === 0,
  detail: `exit=${un.code} ${(un.stdout + un.stderr).slice(-400)}`,
}));
check('settings.json has no claude-mem-lite hooks left', () => {
  const raw = readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8');
  return { ok: !/claude-mem-lite|hook-launcher|post-tool-use/.test(raw), detail: raw.slice(0, 400) };
});
check('MCP registration removed', () => {
  const st = join(HOME, '.claude', 'mcp-state.txt');
  const txt = existsSync(st) ? readFileSync(st, 'utf8') : '';
  return { ok: !/mem-lite/.test(txt), detail: txt.trim() || '(empty)' };
});
check('user DB survives a plain uninstall', () => existsSync(join(DATA, 'claude-mem-lite.db')));
check('uninstall preserved the foreign hook group it never owned', () => {
  const s = JSON.parse(readFileSync(join(HOME, '.claude', 'settings.json'), 'utf8'));
  const groups = Object.values(s.hooks || {}).flat();
  const kept = groups.filter((g) => JSON.stringify(g) === JSON.stringify(FOREIGN_HOOK));
  return {
    ok: kept.length === 1 && groups.length === 1,
    detail: `${groups.length} group(s) left: ${JSON.stringify(groups).slice(0, 240)}`,
  };
});

const pur = run(CLI, ['uninstall', '--purge'], { env: ENV, cwd: PROJECT, timeout: 180_000 });
check('uninstall --purge exits 0', () => ({
  ok: pur.code === 0,
  detail: `exit=${pur.code} ${(pur.stdout + pur.stderr).slice(-400)}`,
}));
check('--purge removes the data dir', () => ({
  ok: !existsSync(join(DATA, 'claude-mem-lite.db')),
  detail: existsSync(DATA) ? readdirSync(DATA).join(',') : '(dir gone)',
}));

console.log(`\nsandbox kept at: ${SBX}`);
process.exit(summary(EXPECTED_CHECKS) > 0 ? 1 : 0);
