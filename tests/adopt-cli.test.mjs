// v3.13 CLAUDE.md-steering: E2E for adopt-cli.mjs. Routes through
// cmdAdopt/cmdUnadopt/silentAutoAdopt with a sandboxed HOME + CLAUDE_PROJECT_DIR
// so the real ~/.claude is never touched (memdirPath()'s ~/.claude resolves
// inside tmpHome via $HOME).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  it('first call: migrates + writes block + doc + marker, returns adopted', () => {
    seedLegacy(fakeCwd);
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('adopted');
    expect(hasAutoAdoptMarker(markerDir, 'proj-x')).toBe(true);
    expect(existsSync(claudeMd(fakeCwd))).toBe(true);
    expect(existsSync(detailDoc(fakeCwd))).toBe(true);
    expect(memdirIsAdopted(memdirPath(fakeCwd), PLUGIN_SLUG)).toBe(false); // legacy migrated
  });

  it('second call is idempotent: already-adopted, CLAUDE.md unchanged', () => {
    silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    const before = readFileSync(claudeMd(fakeCwd), 'utf8');
    const r = silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
    expect(r.action).toBe('already-adopted');
    expect(readFileSync(claudeMd(fakeCwd), 'utf8')).toBe(before);
  });

  it('refreshes when the installed block version drifts', () => {
    silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
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
    silentAutoAdopt({ cwd: fakeCwd, markerDir, markerKey: 'proj-x' });
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
    expect(r2.action).toBe('adopted');
    expect(existsSync(claudeMd(fakeCwd))).toBe(true);
  });

  it('--status reports current-project adoption state', () => {
    cmdAdopt([]);
    logs.length = 0;
    cmdAdopt(['--status']);
    expect(logs.some((l) => l.includes('CLAUDE.md:') && l.includes('adopted'))).toBe(true);
    expect(logs.some((l) => l.includes('Auto-adopt gates'))).toBe(true);
  });
});
