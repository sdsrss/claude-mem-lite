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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { sandboxBase } from './sbx-base.mjs';

const SBX = mkdtempSync(join(sandboxBase(), 'memsbx-B-'));
const HOME = join(SBX, 'home');
const PROJECT = join(SBX, 'work', 'my-app');
const NPM_PREFIX = join(SBX, 'npm-global');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const DATA = join(HOME, '.claude-mem-lite');
const SESSION = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

// Every check this phase must run — see summary()'s doc. B8 lost eight checks to a stale
// path behind an `if`, and the tally was the only witness.
// 45 = 42 `check(` call sites, one of which (the CLI-subcommand loop) runs four times.
// Derived by enumerating the call sites, NOT by copying what a run printed — the README
// carried 45 for a revision that had 44, which is how a wrong tally survives.
const EXPECTED_CHECKS = 45;

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

// ── 9. Uninstall ────────────────────────────────────────────────────────────
setPhase('B9: uninstall (data preserved) then --purge');

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
