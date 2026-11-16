// A repository can commit a symlink to a device (`CLAUDE.md -> /dev/zero`), and a local process can
// leave a FIFO in a project. Claude Code skips an instruction file that is not a regular file; this
// plugin read several project files with a plain readFileSync, which reads a device without end and
// blocks on a FIFO with no writer. Measured 2026-11-16 before the fix: SessionStart's auto-adopt in
// a repository whose CLAUDE.md links to /dev/zero was killed at a 1 GiB memory cap after 421 ms
// (straySentinelLines; the bounded readBlockAt on the same path took 0 ms). Population and per-site
// handling: tasks/specs/project-files-not-regular.md (local) and the commit that adds this file.
//
// A blocked synchronous read cannot be interrupted from inside the worker, so each case runs in a
// child with a deadline and its data segment capped at 1 GiB (as tests/steering-above-fifo.test.mjs
// does for files ABOVE the project); peak RSS tells a read that was stopped from one that failed
// only when memory ran out.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstatSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdtempWithoutInstructionAncestors } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (rel) => JSON.stringify(pathToFileURL(join(REPO, rel)).href);
const RSS_CEILING_KB = 400_000;

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const commitAll = (dir) => {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c');
};
const mkfifo = (p) => execFileSync('mkfifo', [p]);

let home;
let app;
beforeEach(() => {
  home = mkdtempWithoutInstructionAncestors('cml-notreg-');
  app = join(home, 'work', 'app');
  mkdirSync(app, { recursive: true });
  git(app, 'init', '-q');
  writeFileSync(join(app, 'README.md'), '# app\n');
  commitAll(app);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Run `code` (an ES module body that may set globalThis.__r) in a capped child. */
function capped(code, extraEnv = {}) {
  const env = { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(home, 'data'), ...extraEnv };
  for (const k of [
    'CLAUDE_CONFIG_DIR',
    'MEM_NO_AUTO_ADOPT',
    'CLAUDE_MEM_NO_TEMPLATE_REFRESH',
    'CLAUDE_MEM_RUNTIME_DIR',
    'CLAUDE_PROJECT_DIR',
  ])
    if (!(k in extraEnv)) delete env[k];
  const body =
    "process.on('exit', () => process.stdout.write('\\n@@' + JSON.stringify({ r: globalThis.__r ?? null," +
    ' rssKb: process.resourceUsage().maxRSS })));\n' +
    code;
  const r = spawnSync(
    'sh',
    ['-c', 'ulimit -d 1048576; exec "$0" "$@"', process.execPath, '--input-type=module', '-e', body],
    { cwd: app, env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' },
  );
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  const out = line ? JSON.parse(line.slice(2)) : null;
  return {
    signal: r.signal,
    status: r.status,
    r: out?.r ?? null,
    rssKb: out?.rssKb ?? null,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

const expectBounded = (s) => {
  expect(s.signal, `killed (stderr: ${String(s.stderr).slice(0, 300)})`).toBeNull();
  expect(s.rssKb, 'peak RSS: the device must not be read').toBeLessThan(RSS_CEILING_KB);
};

const ADOPT_IN_APP = `const { silentAutoAdopt } = await import(${url('adopt-cli.mjs')});
try { globalThis.__r = silentAutoAdopt({ cwd: process.cwd() }); } catch (e) { globalThis.__r = { threw: String(e.message) }; }`;

describe('SessionStart auto-adopt in a repository holding a link to a device or a FIFO', () => {
  it('CLAUDE.md committed as a link to /dev/zero: no block, the local copy is written', () => {
    symlinkSync('/dev/zero', join(app, 'CLAUDE.md'));
    commitAll(app);
    const s = capped(ADOPT_IN_APP);
    expectBounded(s);
    expect(s.status).toBe(0);
    expect(s.r).toMatchObject({ action: 'local', written: 'created' });
  });

  it('a FIFO CLAUDE.md in the project: no block, no stall', () => {
    mkfifo(join(app, 'CLAUDE.md'));
    const s = capped(ADOPT_IN_APP);
    expectBounded(s);
    expect(s.r).toMatchObject({ action: 'local', written: 'created' });
  });

  it('package.json committed as a link to /dev/zero counts as publishable (fail closed)', () => {
    symlinkSync('/dev/zero', join(app, 'package.json'));
    commitAll(app);
    const s = capped(ADOPT_IN_APP);
    expectBounded(s);
    expect(s.r).toMatchObject({ action: 'inject' });
  });

  it('.npmignore committed as a link to /dev/zero counts as publishable (fail closed)', () => {
    writeFileSync(join(app, 'package.json'), '{"name":"app"}\n');
    symlinkSync('/dev/zero', join(app, '.npmignore'));
    commitAll(app);
    const s = capped(ADOPT_IN_APP);
    expectBounded(s);
    expect(s.r).toMatchObject({ action: 'inject' });
  });

  it('.claude/settings.json committed as a link to /dev/zero sets nothing', () => {
    mkdirSync(join(app, '.claude'));
    symlinkSync('/dev/zero', join(app, '.claude', 'settings.json'));
    commitAll(app);
    const s = capped(ADOPT_IN_APP);
    expectBounded(s);
    expect(s.r).toMatchObject({ action: 'local', written: 'created' });
  });

  it('an adopted CLAUDE.md whose committed detail doc links to /dev/zero: the link is not read or replaced', () => {
    const s0 = capped(`const m = await import(${url('claudemd.mjs')});
const c = await import(${url('adopt-content.mjs')});
m.writeManaged(process.cwd(), { slug: c.PLUGIN_SLUG, version: c.CURRENT_SENTINEL_VERSION, block: c.buildClaudeMdBlock(), doc: 'an older doc' });`);
    expect(s0.status).toBe(0);
    const doc = join(app, '.claude', 'plugin_claude_mem_lite.md');
    rmSync(doc);
    symlinkSync('/dev/zero', doc);
    commitAll(app);
    const s = capped(ADOPT_IN_APP);
    expectBounded(s);
    expect(s.status).toBe(0);
    expect(lstatSync(doc).isSymbolicLink()).toBe(true);
  });
});

describe('every hook event reads the project settings scopes', () => {
  it('.claude/settings.local.json committed as a link to /dev/zero does not stall hook.mjs', () => {
    mkdirSync(join(app, '.claude'));
    symlinkSync('/dev/zero', join(app, '.claude', 'settings.local.json'));
    // An event hook.mjs does not handle: the module-level disabled check runs, then nothing else.
    const s = capped(`process.argv[2] = 'not-an-event'; await import(${url('hook.mjs')});`, {
      CLAUDE_PROJECT_DIR: app,
    });
    expectBounded(s);
  });

  it('isPluginDisabledForProject reads a linked scope as setting nothing', () => {
    mkdirSync(join(app, '.claude'));
    symlinkSync('/dev/zero', join(app, '.claude', 'settings.json'));
    const s = capped(`const k = await import(${url('lib/plugin-key.mjs')});
globalThis.__r = k.isPluginDisabledForProject(process.env.HOME + '/.claude', process.cwd());`);
    expectBounded(s);
    expect(s.r).toBe(false);
  });
});

describe('the other readers of project files', () => {
  it('removeBlockAt (unadopt) on a CLAUDE.md linked to /dev/zero finds no block', () => {
    symlinkSync('/dev/zero', join(app, 'CLAUDE.md'));
    const s = capped(`const m = await import(${url('claudemd.mjs')});
globalThis.__r = m.removeBlockAt(process.cwd() + '/CLAUDE.md', 'claude-mem-lite');`);
    expectBounded(s);
    expect(s.r).toMatchObject({ action: 'absent' });
    expect(lstatSync(join(app, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('addAgentsImports (adopt) refuses a CLAUDE.md linked to /dev/zero and leaves the link', () => {
    symlinkSync('/dev/zero', join(app, 'CLAUDE.md'));
    const s = capped(`const m = await import(${url('claudemd.mjs')});
try { m.addAgentsImports(process.cwd(), 'claude-mem-lite', ['AGENTS.md']); globalThis.__r = 'wrote'; } catch { globalThis.__r = 'refused'; }`);
    expectBounded(s);
    expect(s.r).toBe('refused');
    expect(lstatSync(join(app, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('writeBlockAt refuses a FIFO and leaves it', () => {
    const p = join(app, 'CLAUDE.local.md');
    mkfifo(p);
    const s = capped(`const m = await import(${url('claudemd.mjs')});
try { m.writeBlockAt(process.cwd() + '/CLAUDE.local.md', { slug: 'claude-mem-lite', version: 'v1', block: 'x' }); globalThis.__r = 'wrote'; } catch { globalThis.__r = 'refused'; }`);
    expectBounded(s);
    expect(s.r).toBe('refused');
    expect(lstatSync(p).isFIFO()).toBe(true);
  });

  // The state is then written through the link (atomicWriteFileSync follows links on purpose, for
  // dotfile repos) and that write fails into /dev: unchanged, and not what this case is about.
  it("writeManaged's state read does not read a sidecar linked to /dev/zero", () => {
    mkdirSync(join(app, '.claude'));
    const state = join(app, '.claude', '.plugin_claude_mem_lite_state.json');
    symlinkSync('/dev/zero', state);
    const s = capped(`const m = await import(${url('claudemd.mjs')});
try { m.writeManaged(process.cwd(), { slug: 'claude-mem-lite', version: 'v1', block: 'b', doc: 'd' }); globalThis.__r = 'done'; } catch { globalThis.__r = 'threw'; }`);
    expectBounded(s);
    expect(s.status).toBe(0);
    expect(s.r).not.toBeNull();
    expect(lstatSync(state).isSymbolicLink()).toBe(true);
  });

  it('isOwnAdoptionArtifact does not stall on a FIFO detail doc', () => {
    mkdirSync(join(app, '.claude'));
    mkfifo(join(app, '.claude', 'plugin_claude_mem_lite.md'));
    const s = capped(`const m = await import(${url('claudemd.mjs')});
globalThis.__r = m.isOwnAdoptionArtifact(process.cwd(), '.claude/plugin_claude_mem_lite.md', 'claude-mem-lite');`);
    expectBounded(s);
    expect(s.r).toBe(false);
  });

  it("SessionStart's legacy-block cleanup does not read a CLAUDE.md linked to /dev/zero", () => {
    symlinkSync('/dev/zero', join(app, 'CLAUDE.md'));
    const s = capped(
      `const h = await import(${url('hook-context.mjs')}); h.cleanupClaudeMdLegacyBlock(); globalThis.__r = 'done';`,
      { CLAUDE_PROJECT_DIR: app },
    );
    expectBounded(s);
    expect(s.r).toBe('done');
  });

  it('readPausedNote skips a FIFO note and reads the newest regular one', () => {
    mkdirSync(join(app, 'tasks'));
    const note = join(app, 'tasks', 'a-paused.md');
    writeFileSync(note, '# 暂停 — a\n\n## 未完成\n\n1. an item\n');
    const older = new Date(Date.now() - 60_000);
    utimesSync(note, older, older);
    mkfifo(join(app, 'tasks', 'b-paused.md'));
    const s = capped(`const p = await import(${url('lib/paused-reader.mjs')});
globalThis.__r = p.readPausedNote({ projectPath: process.cwd() });`);
    expectBounded(s);
    expect(s.r?.items).toEqual(['an item']);
  });

  it('rulesRefusal (the rules-file channel) counts a package.json linked to /dev/zero as publishable', () => {
    symlinkSync('/dev/zero', join(app, 'package.json'));
    const s = capped(`const l = await import(${url('lib/local-steering.mjs')});
globalThis.__r = l.rulesRefusal(process.cwd(), 'claude-mem-lite');`);
    expectBounded(s);
    expect(s.r).toBe('npm-publishable');
  });

  it('rulesRefusal counts a .gitignore linked to /dev/zero as shipping the rules file', () => {
    writeFileSync(join(app, 'package.json'), '{"name":"app"}\n');
    symlinkSync('/dev/zero', join(app, '.gitignore'));
    const s = capped(`const l = await import(${url('lib/local-steering.mjs')});
globalThis.__r = l.rulesRefusal(process.cwd(), 'claude-mem-lite');`);
    expectBounded(s);
    expect(s.r).toBe('npm-publishable');
  });

  it('status reads a .claude/settings.local.json linked to /dev/zero as no project override', () => {
    mkdirSync(join(app, '.claude'));
    symlinkSync('/dev/zero', join(app, '.claude', 'settings.local.json'));
    // node alone on PATH: status must not reach a real `claude`.
    const bin = join(home, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    const s = capped(
      `process.argv[1] = ${JSON.stringify(join(REPO, 'install.mjs'))}; process.argv[2] = 'status';
await import(${url('install.mjs')});`,
      { PATH: `${bin}:/usr/bin:/bin`, MEM_NO_AUTO_ADOPT: '1' },
    );
    expectBounded(s);
    expect(s.stdout).toMatch(/Plugin:/);
    expect(s.stdout).not.toMatch(/in this project by/);
  });

  it('projectScopedMemRegistrations reads a .mcp.json linked to /dev/zero as no registrations', () => {
    symlinkSync('/dev/zero', join(app, '.mcp.json'));
    const s = capped(`const i = await import(${url('install.mjs')});
globalThis.__r = i.projectScopedMemRegistrations(process.cwd());`);
    expectBounded(s);
    expect(s.r?.names).toEqual([]);
  });
});
