// v3.13 CLAUDE.md-steering: E2E for adopt-cli.mjs. Routes through
// cmdAdopt/cmdUnadopt/silentAutoAdopt with a sandboxed HOME + CLAUDE_PROJECT_DIR
// so the real ~/.claude is never touched (memdirPath()'s ~/.claude resolves
// inside tmpHome via $HOME).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import {
  cmdAdopt,
  cmdUnadopt,
  silentAutoAdopt,
  hasAutoAdoptMarker,
  disableSentinelPath,
  isAutoAdoptDisabled,
} from '../adopt-cli.mjs';
import { memdirPath, writePluginSection, isAdopted as memdirIsAdopted } from '../memdir.mjs';
import { PLUGIN_SLUG } from '../adopt-content.mjs';
import { isOwnAdoptionArtifact } from '../claudemd.mjs';
import { mkdtempWithoutInstructionAncestors } from './test-helpers.mjs';

function claudeMd(cwd) {
  return join(cwd, 'CLAUDE.md');
}
function detailDoc(cwd) {
  return join(cwd, '.claude', 'plugin_claude_mem_lite.md');
}
const BEGIN = `<!-- ${PLUGIN_SLUG}:begin v1 -->`;

// Seed a legacy memory-dir sentinel for `cwd` (the pre-v3.13 scheme) so we can
// assert migration strips it.
function seedLegacy(cwd) {
  const md = memdirPath(cwd);
  mkdirSync(md, { recursive: true });
  writePluginSection(md, { slug: PLUGIN_SLUG, version: 'v1', contentLine: '- legacy line' });
}

describe('cmdAdopt / cmdUnadopt (current project, CLAUDE.md scheme)', () => {
  let tmpHome, fakeCwd, origHome, origCwd, logs;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'adopt-cli-'));
    fakeCwd = join(tmpHome, 'work', 'myproj');
    mkdirSync(fakeCwd, { recursive: true });
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg));
    });
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    rmSync(tmpHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('writes the managed block + detail doc into the project tree', () => {
    cmdAdopt([]);
    expect(existsSync(claudeMd(fakeCwd))).toBe(true);
    expect(existsSync(detailDoc(fakeCwd))).toBe(true);
    const body = readFileSync(claudeMd(fakeCwd), 'utf8');
    expect(body).toContain(BEGIN);
    expect(body).toContain('mem_recall');
    expect(readFileSync(detailDoc(fakeCwd), 'utf8')).toMatch(/^<!-- managed-by: claude-mem-lite -->/);
    expect(process.exitCode).toBe(0);
  });

  // E2E round 2026-09-29: README said "Hash-guarded: editing the managed-block body yourself
  // blocks automatic rewrites unless you pass --force" and `help` listed `--force  Overwrite a
  // manually-edited managed block`. Neither has been true since v3.13 moved the block into
  // CLAUDE.md (its blockHash is written, never read): adopt and every SessionStart regenerate
  // the block, and --force only reaches the legacy memory-dir cleanup — what
  // commands/adopt.md already said. The docs now say so; this pins the behaviour they describe.
  it('rewrites a hand-edited block without --force — keep notes outside the markers', () => {
    writeFileSync(claudeMd(fakeCwd), '# Mine\n\nkept outside\n');
    cmdAdopt([]);
    const edited = readFileSync(claudeMd(fakeCwd), 'utf8').replace(BEGIN, `${BEGIN}\nMY NOTE`);
    writeFileSync(claudeMd(fakeCwd), edited);
    cmdAdopt([]);
    const after = readFileSync(claudeMd(fakeCwd), 'utf8');
    expect(after).not.toContain('MY NOTE');
    expect(after).toContain('kept outside');
    const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
    expect(readme).not.toMatch(/Hash-guarded/);
    expect(readme).toMatch(/hand edits\s+included/);
    const zh = readFileSync(join(import.meta.dirname, '..', 'README.zh-CN.md'), 'utf8');
    expect(zh).not.toMatch(/Hash 守护|UserEditedError/);
  });

  it('migrates away a legacy memory-dir sentinel on adopt', () => {
    seedLegacy(fakeCwd);
    expect(memdirIsAdopted(memdirPath(fakeCwd), PLUGIN_SLUG)).toBe(true);
    cmdAdopt([]);
    expect(memdirIsAdopted(memdirPath(fakeCwd), PLUGIN_SLUG)).toBe(false);
    expect(existsSync(join(memdirPath(fakeCwd), 'plugin_claude_mem_lite.md'))).toBe(false);
    expect(existsSync(claudeMd(fakeCwd))).toBe(true);
  });

  it('migration is slug-scoped — an adjacent code-graph-mcp block survives', () => {
    const md = memdirPath(fakeCwd);
    mkdirSync(md, { recursive: true });
    writeFileSync(join(md, 'MEMORY.md'), '## user\n- note\n');
    writePluginSection(md, { slug: PLUGIN_SLUG, version: 'v1', contentLine: '- legacy' });
    const cg = '<!-- code-graph-mcp:begin v1 -->\n- cg line\n<!-- code-graph-mcp:end -->\n';
    writeFileSync(join(md, 'MEMORY.md'), readFileSync(join(md, 'MEMORY.md'), 'utf8') + cg);
    cmdAdopt([]);
    const mem = readFileSync(join(md, 'MEMORY.md'), 'utf8');
    expect(mem).not.toContain(`${PLUGIN_SLUG}:begin`);
    expect(mem).toContain('code-graph-mcp:begin');
    expect(mem).toContain('- note');
  });

  it('re-adopt is idempotent (CLAUDE.md byte-identical, logs unchanged)', () => {
    cmdAdopt([]);
    const first = readFileSync(claudeMd(fakeCwd), 'utf8');
    logs.length = 0;
    cmdAdopt([]);
    expect(readFileSync(claudeMd(fakeCwd), 'utf8')).toBe(first);
    expect(logs.some((l) => l.includes('unchanged'))).toBe(true);
  });

  it('--dry-run prints intent without writing', () => {
    cmdAdopt(['--dry-run']);
    expect(existsSync(claudeMd(fakeCwd))).toBe(false);
    expect(existsSync(detailDoc(fakeCwd))).toBe(false);
    expect(logs.some((l) => l.includes('--dry-run'))).toBe(true);
  });

  it('preserves user prose outside the sentinel when adopting into an existing CLAUDE.md', () => {
    writeFileSync(claudeMd(fakeCwd), '# My Project\n\nuser intro\n');
    cmdAdopt([]);
    const body = readFileSync(claudeMd(fakeCwd), 'utf8');
    expect(body).toContain('# My Project');
    expect(body).toContain('user intro');
    expect(body).toContain(BEGIN);
  });

  it('unadopt removes block + detail doc but keeps user prose', () => {
    writeFileSync(claudeMd(fakeCwd), '# My Project\n\nuser intro\n');
    cmdAdopt([]);
    cmdUnadopt([]);
    const body = readFileSync(claudeMd(fakeCwd), 'utf8');
    expect(body).toContain('# My Project');
    expect(body).toContain('user intro');
    expect(body).not.toContain(`${PLUGIN_SLUG}:begin`);
    expect(existsSync(detailDoc(fakeCwd))).toBe(false);
  });

  it('unadopt on a never-adopted project is a benign no-op', () => {
    cmdUnadopt([]);
    expect(process.exitCode).toBe(0);
    expect(logs.some((l) => l.includes('absent'))).toBe(true);
  });

  // Lesson #8473: sibling commands must mirror read-only escapes so an
  // extrapolated flag never falls through to the destructive default.
  it('unadopt --status is read-only and does NOT remove the block', () => {
    cmdAdopt([]);
    const before = readFileSync(claudeMd(fakeCwd), 'utf8');
    cmdUnadopt(['--status']);
    expect(readFileSync(claudeMd(fakeCwd), 'utf8')).toBe(before);
    expect(existsSync(detailDoc(fakeCwd))).toBe(true);
    expect(logs.some((l) => l.includes('[adopt --status]'))).toBe(true);
  });

  it('unadopt --dry-run previews but does NOT remove the block', () => {
    cmdAdopt([]);
    const before = readFileSync(claudeMd(fakeCwd), 'utf8');
    cmdUnadopt(['--dry-run']);
    expect(readFileSync(claudeMd(fakeCwd), 'utf8')).toBe(before);
    expect(existsSync(detailDoc(fakeCwd))).toBe(true);
    expect(
      logs.some((l) => l.includes('would-remove') || l.includes('would-clean') || l.includes('--dry-run')),
    ).toBe(true);
  });
});

describe('cmdAdopt --all (legacy-cleanup sweep)', () => {
  let tmpHome, origHome, origCwd, logs;

  function makeLegacyProject(name) {
    const dir = join(tmpHome, '.claude', 'projects', name, 'memory');
    mkdirSync(dir, { recursive: true });
    writePluginSection(dir, { slug: PLUGIN_SLUG, version: 'v1', contentLine: '- legacy' });
    return dir;
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'adopt-cli-all-'));
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    delete process.env.CLAUDE_PROJECT_DIR;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg));
    });
    process.exitCode = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    rmSync(tmpHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('strips legacy memory-dir sentinels across every memdir', () => {
    const a = makeLegacyProject('-proj-a');
    const b = makeLegacyProject('-proj-b');
    cmdAdopt(['--all']);
    expect(readFileSync(join(a, 'MEMORY.md'), 'utf8')).not.toContain(`${PLUGIN_SLUG}:begin`);
    expect(readFileSync(join(b, 'MEMORY.md'), 'utf8')).not.toContain(`${PLUGIN_SLUG}:begin`);
    expect(existsSync(join(a, 'plugin_claude_mem_lite.md'))).toBe(false);
    expect(logs.some((l) => l.includes('legacy memory-dir cleanup'))).toBe(true);
    expect(logs.some((l) => l.includes('per-project'))).toBe(true);
  });

  it('--all --dry-run reports would-remove without writing', () => {
    const a = makeLegacyProject('-proj-a');
    cmdAdopt(['--all', '--dry-run']);
    expect(readFileSync(join(a, 'MEMORY.md'), 'utf8')).toContain(`${PLUGIN_SLUG}:begin`);
    expect(logs.some((l) => l.includes('would-remove'))).toBe(true);
  });

  it('unadopt --all also sweeps legacy memdirs', () => {
    const a = makeLegacyProject('-proj-a');
    cmdUnadopt(['--all']);
    expect(readFileSync(join(a, 'MEMORY.md'), 'utf8')).not.toContain(`${PLUGIN_SLUG}:begin`);
  });

  it('--all on empty ~/.claude/projects reports no memdirs', () => {
    cmdAdopt(['--all']);
    expect(logs.some((l) => l.includes('no memdirs'))).toBe(true);
  });
});

describe('silentAutoAdopt (SessionStart sync)', () => {
  let tmpHome, fakeCwd, markerDir, origHome, origCwd;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'silent-adopt-'));
    fakeCwd = join(tmpHome, 'work', 'proj');
    mkdirSync(fakeCwd, { recursive: true });
    markerDir = join(tmpHome, 'runtime');
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // Report §9-A (docs/audits/20260929-sandbox-usage-eval.md): the first SessionStart used to
  // write CLAUDE.md + .claude/plugin_claude_mem_lite.md into every project, unasked — 4 of 4
  // sandbox repos, swept into the next `git add -A`. The steering now rides SessionStart
  // context (action 'inject'); only an explicit `adopt` writes files.
  it('first call on an unadopted project: migrates, writes NOTHING under cwd, returns inject', () => {
    seedLegacy(fakeCwd);
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('inject');
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(true);
    expect(existsSync(claudeMd(fakeCwd))).toBe(false);
    expect(existsSync(join(fakeCwd, '.claude'))).toBe(false);
    expect(memdirIsAdopted(memdirPath(fakeCwd), PLUGIN_SLUG)).toBe(false); // legacy migrated
  });

  it('a project adopted explicitly is kept in sync: already-adopted, CLAUDE.md unchanged', () => {
    cmdAdopt([]);
    silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    const before = readFileSync(claudeMd(fakeCwd), 'utf8');
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.action).toBe('already-adopted');
    expect(readFileSync(claudeMd(fakeCwd), 'utf8')).toBe(before);
  });

  it('refreshes when the installed block version drifts', () => {
    cmdAdopt([]);
    // Simulate an older version installed.
    const stale = readFileSync(claudeMd(fakeCwd), 'utf8').replace(
      `${PLUGIN_SLUG}:begin v1`,
      `${PLUGIN_SLUG}:begin v0`,
    );
    writeFileSync(claudeMd(fakeCwd), stale);
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.action).toBe('refreshed');
    expect(readFileSync(claudeMd(fakeCwd), 'utf8')).toContain(BEGIN);
  });

  it('CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 freezes the block against drift', () => {
    cmdAdopt([]);
    const stale = readFileSync(claudeMd(fakeCwd), 'utf8').replace(
      `${PLUGIN_SLUG}:begin v1`,
      `${PLUGIN_SLUG}:begin v0`,
    );
    writeFileSync(claudeMd(fakeCwd), stale);
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.action).toBe('already-adopted');
    expect(readFileSync(claudeMd(fakeCwd), 'utf8')).toContain(`${PLUGIN_SLUG}:begin v0`);
  });

  it('hasAutoAdoptMarker is per-key (scoping works)', () => {
    silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(true);
    expect(hasAutoAdoptMarker(markerDir, 'proj-y')).toBe(false);
  });

  it('skips with action=disabled when .mem-no-auto-adopt sentinel exists', () => {
    const memdir = memdirPath(fakeCwd);
    mkdirSync(memdir, { recursive: true });
    writeFileSync(disableSentinelPath(memdir), '{}');
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('disabled');
    expect(r.reason).toBe('disabled-by-sentinel');
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(false);
    expect(existsSync(claudeMd(fakeCwd))).toBe(false);
  });
});

describe('cmdAdopt --disable / --enable', () => {
  let tmpHome, fakeCwd, markerDir, origHome, origCwd, logs;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'adopt-disable-'));
    fakeCwd = join(tmpHome, 'work', 'proj');
    mkdirSync(fakeCwd, { recursive: true });
    markerDir = join(tmpHome, 'runtime');
    origHome = process.env.HOME;
    origCwd = process.env.CLAUDE_PROJECT_DIR;
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg));
    });
    process.exitCode = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCwd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origCwd;
    rmSync(tmpHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('--disable writes .mem-no-auto-adopt; --enable removes it (roundtrip)', () => {
    cmdAdopt(['--disable']);
    const memdir = memdirPath(fakeCwd);
    expect(isAutoAdoptDisabled(memdir)).toBe(true);
    expect(logs.some((l) => l.includes('disabled'))).toBe(true);
    cmdAdopt(['--enable']);
    expect(isAutoAdoptDisabled(memdir)).toBe(false);
    expect(logs.some((l) => l.includes('enabled'))).toBe(true);
  });

  it('--disable is idempotent (already-disabled, not error)', () => {
    cmdAdopt(['--disable']);
    logs.length = 0;
    cmdAdopt(['--disable']);
    expect(logs.some((l) => l.includes('already-disabled'))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('end-to-end: --disable blocks silentAutoAdopt; --enable re-arms it', () => {
    cmdAdopt(['--disable']);
    const r1 = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r1.action).toBe('disabled');
    expect(existsSync(claudeMd(fakeCwd))).toBe(false);

    cmdAdopt(['--enable']);
    const r2 = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r2.action).toBe('inject'); // re-armed: steering is injected again, still no files
    expect(existsSync(claudeMd(fakeCwd))).toBe(false);
  });

  it('--status reports current-project adoption state', () => {
    cmdAdopt([]);
    logs.length = 0;
    cmdAdopt(['--status']);
    expect(logs.some((l) => l.includes('CLAUDE.md:') && l.includes('adopted'))).toBe(true);
    expect(logs.some((l) => l.includes('Auto-adopt gates'))).toBe(true);
  });
});

// Claude Code (v2.1.277+) reads AGENTS.md as a project's instructions only while no CLAUDE.md,
// .claude/CLAUDE.md or CLAUDE.local.md is in the session's directory or above it
// (code.claude.com/docs/en/memory#agents-md). An explicit adopt that CREATED CLAUDE.md next to an
// AGENTS.md therefore switched that AGENTS.md off, without a word. The CLAUDE.md it creates there
// now imports it first — the docs' own remedy — behind a marker comment, which Claude Code strips
// before injecting the file (probe 2026-10-06, Claude Code 2.1.291: a canary in AGENTS.md was
// answered through `<marker>\n@AGENTS.md\n\n<block>`, and the marker never reached the context).
describe('adopt next to an AGENTS.md', () => {
  let tmpHome, fakeCwd, saved, logs;
  const MARKER = `<!-- ${PLUGIN_SLUG} adopt: imports AGENTS.md, which Claude Code stops reading once a CLAUDE.md exists -->`;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  const commitAll = (dir) => {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c');
  };
  const agentsMd = (dir, rel = 'AGENTS.md') => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), '# Instructions for coding agents\n');
  };
  const body = () => readFileSync(claudeMd(fakeCwd), 'utf8');
  const out = () => logs.join('\n');

  beforeEach(() => {
    tmpHome = mkdtempWithoutInstructionAncestors('adopt-agents-');
    fakeCwd = join(tmpHome, 'work', 'myproj');
    mkdirSync(fakeCwd, { recursive: true });
    saved = {
      HOME: process.env.HOME,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      MEM_NO_AUTO_ADOPT: process.env.MEM_NO_AUTO_ADOPT,
    };
    process.env.HOME = tmpHome;
    process.env.CLAUDE_PROJECT_DIR = fakeCwd;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.MEM_NO_AUTO_ADOPT;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg));
    });
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpHome, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('the CLAUDE.md adopt creates next to AGENTS.md imports it first, behind the marker', () => {
    agentsMd(fakeCwd);
    cmdAdopt([]);
    expect(body().startsWith(`${MARKER}\n@AGENTS.md\n\n${BEGIN}`)).toBe(true);
    expect(out()).toMatch(/imported AGENTS\.md/);
    expect(process.exitCode).toBe(0);
  });

  it('a .claude/AGENTS.md beside it is imported too', () => {
    agentsMd(fakeCwd);
    agentsMd(fakeCwd, join('.claude', 'AGENTS.md'));
    cmdAdopt([]);
    expect(body().startsWith(`${MARKER}\n@AGENTS.md\n@.claude/AGENTS.md\n\n${BEGIN}`)).toBe(true);
  });

  it('re-adopt keeps one import; re-adopting a CLAUDE.md that holds only an older block adds it', () => {
    cmdAdopt([]);
    expect(body()).not.toContain(MARKER);
    agentsMd(fakeCwd);
    cmdAdopt([]);
    cmdAdopt([]);
    expect(body().startsWith(`${MARKER}\n@AGENTS.md\n\n${BEGIN}`)).toBe(true);
    expect(body().split(MARKER).length - 1).toBe(1);
  });

  it('unadopt deletes a file that holds only the import and the block', () => {
    agentsMd(fakeCwd);
    cmdAdopt([]);
    cmdUnadopt([]);
    expect(existsSync(claudeMd(fakeCwd))).toBe(false);
  });

  it('unadopt keeps the import once the user has written into the file', () => {
    agentsMd(fakeCwd);
    cmdAdopt([]);
    appendFileSync(claudeMd(fakeCwd), '\n## Our conventions\n');
    cmdUnadopt([]);
    expect(body()).toContain('@AGENTS.md');
    expect(body()).toContain('## Our conventions');
    expect(body()).not.toContain(`${PLUGIN_SLUG}:begin`);
  });

  it('the file adopt created counts as its own artifact, until the user writes into it', () => {
    agentsMd(fakeCwd);
    cmdAdopt([]);
    expect(isOwnAdoptionArtifact(fakeCwd, 'CLAUDE.md', PLUGIN_SLUG)).toBe(true);
    appendFileSync(claudeMd(fakeCwd), '\nmine\n');
    expect(isOwnAdoptionArtifact(fakeCwd, 'CLAUDE.md', PLUGIN_SLUG)).toBe(false);
  });

  // AGENTS.md was not being read here before adopt, so importing it would add instructions the
  // user's setup leaves out.
  it.each([
    ["the user's own CLAUDE.md", () => writeFileSync(claudeMd(fakeCwd), '# Ours\n')],
    ["the user's own .claude/CLAUDE.md", () => agentsMd(fakeCwd, join('.claude', 'CLAUDE.md'))],
    ['a CLAUDE.md in a directory above', () => writeFileSync(join(dirname(fakeCwd), 'CLAUDE.md'), '# Up\n')],
    ['a CLAUDE.local.md of the user’s', () => writeFileSync(join(fakeCwd, 'CLAUDE.local.md'), 'notes\n')],
  ])('with %s, nothing is imported', (_, arrange) => {
    agentsMd(fakeCwd);
    arrange();
    cmdAdopt([]);
    expect(body()).not.toContain('@AGENTS.md');
  });

  it.each([['claude-md-and-agents-md'], ['claude-md'], ['managed-only']])(
    'with Project instructions = %s in the user settings, nothing is imported',
    (instructionFiles) => {
      agentsMd(fakeCwd);
      mkdirSync(join(tmpHome, '.claude'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.claude', 'settings.json'),
        JSON.stringify({
          pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles } } },
        }),
      );
      cmdAdopt([]);
      expect(body()).not.toContain('@AGENTS.md');
    },
  );

  // An import of a file outside the working directory makes Claude Code ask for approval, and one
  // of a subdirectory's file would load it in every session: named, not imported.
  it('an AGENTS.md in a directory above is named with the setting that keeps it, not imported', () => {
    agentsMd(dirname(fakeCwd));
    cmdAdopt([]);
    expect(body()).not.toContain('@');
    expect(out()).toContain(join(dirname(fakeCwd), 'AGENTS.md'));
    expect(out()).toMatch(/claude-md-and-agents-md/);
  });

  it('an AGENTS.md git tracks in a subdirectory is named, not imported', () => {
    git(fakeCwd, 'init', '-q');
    agentsMd(fakeCwd, join('packages', 'api', 'AGENTS.md'));
    commitAll(fakeCwd);
    cmdAdopt([]);
    expect(body()).not.toContain('@');
    expect(out()).toContain(join(fakeCwd, 'packages', 'api', 'AGENTS.md'));
  });

  it('the CLAUDE.local.md copy auto-adopt wrote is no user file: the import is added, the copy removed', () => {
    git(fakeCwd, 'init', '-q');
    writeFileSync(join(fakeCwd, 'README.md'), '# app\n');
    commitAll(fakeCwd);
    expect(silentAutoAdopt({ cwd: fakeCwd })).toMatchObject({ action: 'local', written: 'created' });
    agentsMd(fakeCwd);
    cmdAdopt([]);
    expect(body().startsWith(`${MARKER}\n@AGENTS.md\n\n${BEGIN}`)).toBe(true);
    expect(existsSync(join(fakeCwd, 'CLAUDE.local.md'))).toBe(false);
  });

  it('~/.claude/CLAUDE.md is user memory, not a project file: the import is still added', () => {
    agentsMd(fakeCwd);
    agentsMd(tmpHome, join('.claude', 'CLAUDE.md'));
    cmdAdopt([]);
    expect(body().startsWith(`${MARKER}\n@AGENTS.md\n\n${BEGIN}`)).toBe(true);
  });

  it('an AGENTS.md git tracks beside CLAUDE.md is imported, and not also named as one it cannot import', () => {
    git(fakeCwd, 'init', '-q');
    agentsMd(fakeCwd);
    commitAll(fakeCwd);
    cmdAdopt([]);
    expect(body().startsWith(`${MARKER}\n@AGENTS.md\n\n${BEGIN}`)).toBe(true);
    expect(out()).not.toContain('⚠');
  });

  // The docs' own setup: a CLAUDE.md the user wrote to import AGENTS.md. Without the marker
  // those lines are the user's, and unadopt leaves them.
  it("a CLAUDE.md of the user's that imports AGENTS.md itself is not deleted by unadopt", () => {
    agentsMd(fakeCwd);
    agentsMd(fakeCwd, join('.claude', 'AGENTS.md'));
    writeFileSync(claudeMd(fakeCwd), '@AGENTS.md\n@.claude/AGENTS.md\n');
    cmdAdopt([]);
    cmdUnadopt([]);
    expect(body()).toBe('@AGENTS.md\n@.claude/AGENTS.md\n');
  });

  it('--dry-run says it would import AGENTS.md, and writes nothing', () => {
    agentsMd(fakeCwd);
    cmdAdopt(['--dry-run']);
    expect(out()).toMatch(/would import AGENTS\.md/);
    expect(existsSync(claudeMd(fakeCwd))).toBe(false);
  });

  // A CLAUDE.md holding only the block — what auto-adopt wrote into every project before 6.20.0,
  // and adopt before it imported AGENTS.md — switches AGENTS.md off just as a new one would.
  // The session-start sync gives it the import adopt writes now, once.
  it('session start adds the import to a CLAUDE.md that holds only the block, once', () => {
    cmdAdopt([]);
    agentsMd(fakeCwd);
    const r = silentAutoAdopt({ cwd: fakeCwd });
    expect(r).toMatchObject({ ok: true, action: 'already-adopted' });
    expect(r.agents).toEqual({ imported: ['AGENTS.md'], elsewhere: [] });
    expect(body().startsWith(`${MARKER}\n@AGENTS.md\n\n${BEGIN}`)).toBe(true);
    const after = body();
    const again = silentAutoAdopt({ cwd: fakeCwd });
    expect(again.agents).toBeUndefined();
    expect(body()).toBe(after);
  });

  it('session start adds no import once the user has written into CLAUDE.md', () => {
    cmdAdopt([]);
    appendFileSync(claudeMd(fakeCwd), '\n## Our conventions\n');
    agentsMd(fakeCwd);
    const r = silentAutoAdopt({ cwd: fakeCwd });
    expect(r.agents).toBeUndefined();
    expect(body()).not.toContain('@AGENTS.md');
  });

  it('CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 keeps session start from adding the import', () => {
    cmdAdopt([]);
    agentsMd(fakeCwd);
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    try {
      expect(silentAutoAdopt({ cwd: fakeCwd }).agents).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    }
    expect(body()).not.toContain('@AGENTS.md');
  });

  it('session start reports an AGENTS.md above the directory, and imports nothing', () => {
    cmdAdopt([]);
    agentsMd(dirname(fakeCwd));
    const r = silentAutoAdopt({ cwd: fakeCwd });
    expect(r.agents).toEqual({ imported: [], elsewhere: [join(dirname(fakeCwd), 'AGENTS.md')] });
    expect(body()).not.toContain('@');
  });

  // Pre-tag defect review (D#212) P2-5: at $HOME an import in ~/CLAUDE.md would reach every project
  // below it, each asking to approve an import from outside its directory. Not added there.
  it('session start adds no import to a CLAUDE.md at $HOME', () => {
    process.env.CLAUDE_PROJECT_DIR = tmpHome;
    cmdAdopt([]);
    agentsMd(tmpHome);
    expect(silentAutoAdopt({ cwd: tmpHome }).agents).toBeUndefined();
    expect(readFileSync(claudeMd(tmpHome), 'utf8')).not.toContain('@AGENTS.md');
  });

  // Delta review D8: an explicit adopt at $HOME does not import ~/AGENTS.md either; it names it.
  it('adopt at $HOME names ~/AGENTS.md instead of importing it', () => {
    process.env.CLAUDE_PROJECT_DIR = tmpHome;
    agentsMd(tmpHome);
    cmdAdopt([]);
    expect(readFileSync(claudeMd(tmpHome), 'utf8')).not.toContain('@AGENTS.md');
    expect(out()).toContain(join(tmpHome, 'AGENTS.md'));
  });

  // P3-9: with the import line deleted by hand, what is left — the marker — is still the plugin's.
  it('unadopt deletes a CLAUDE.md left with the marker and the block', () => {
    agentsMd(fakeCwd);
    cmdAdopt([]);
    writeFileSync(claudeMd(fakeCwd), body().replace('@AGENTS.md\n', ''));
    cmdUnadopt([]);
    expect(existsSync(claudeMd(fakeCwd))).toBe(false);
  });

  // Seen from a subdirectory the root's `@AGENTS.md` resolves outside the working directory, which
  // Claude Code asks the user to approve; the next session started at the root adds it.
  it("a session started in a subdirectory leaves the root's CLAUDE.md alone", () => {
    git(fakeCwd, 'init', '-q');
    cmdAdopt([]);
    agentsMd(fakeCwd);
    const sub = join(fakeCwd, 'src');
    mkdirSync(sub);
    const before = body();
    const r = silentAutoAdopt({ cwd: sub });
    expect(r).toMatchObject({ action: 'already-adopted', reason: 'root-claude-md' });
    expect(body()).toBe(before);
  });
});
