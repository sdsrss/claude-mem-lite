// D#880: a cloned repository's committed links — a `.claude` directory link, a CLAUDE.md link — made
// SessionStart, adopt and unadopt write or delete files outside it (v6.35.3 pre-tag round 2, F1;
// v6.35.2 alike). A link the user made is untracked, and git says so; a link the repository made is
// not. The layouts users build with links keep working (round 2, F3).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  renameSync,
} from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdtempWithoutInstructionAncestors } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (rel) => JSON.stringify(pathToFileURL(join(REPO, rel)).href);

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const commitAll = (dir) => {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c');
};

const DOC = '.claude/plugin_claude_mem_lite.md';
const STATE = '.claude/.plugin_claude_mem_lite_state.json';
const VICTIM = 'VICTIM user text\n';

let home;
let app;
let outside;
beforeEach(() => {
  home = mkdtempWithoutInstructionAncestors('cml-linkout-');
  app = join(home, 'work', 'app');
  outside = join(home, 'outside');
  mkdirSync(app, { recursive: true });
  mkdirSync(outside);
  git(app, 'init', '-q');
  writeFileSync(join(app, 'README.md'), '# app\n');
  commitAll(app);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Run an ES module body (it may set globalThis.__r) in a child whose HOME and data dir are the sandbox's. */
function run(code, { cwd = app, env: extraEnv = {} } = {}) {
  const env = { ...process.env, HOME: home, CLAUDE_MEM_DIR: join(home, 'data'), PWD: cwd, ...extraEnv };
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
    ' code: process.exitCode ?? 0 })));\n' +
    code;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  const out = line ? JSON.parse(line.slice(2)) : null;
  return { status: r.status, r: out?.r ?? null, code: out?.code ?? null, stdout: r.stdout, stderr: r.stderr };
}

const IMPORTS = `const m = await import(${url('claudemd.mjs')});
const c = await import(${url('adopt-content.mjs')});
const managed = (doc) => ({ slug: c.PLUGIN_SLUG, version: c.CURRENT_SENTINEL_VERSION, block: c.buildClaudeMdBlock(), doc });`;
// Adopted, with a detail doc older than the shipped one: the next SessionStart refreshes it.
const ADOPT_OLDER_DOC = `${IMPORTS}
m.writeManaged(process.cwd(), managed('an older doc'));`;
// A block whose text has drifted, written into the file at argv path: the next sync rewrites it.
const DRIFTED_BLOCK_AT = (p) => `${IMPORTS}
m.writeBlockAt(${JSON.stringify(p)}, { slug: c.PLUGIN_SLUG, version: c.CURRENT_SENTINEL_VERSION, block: 'OLD TEXT' });`;
const SESSION_START = `const { silentAutoAdopt } = await import(${url('adopt-cli.mjs')});
globalThis.__r = silentAutoAdopt({ cwd: process.cwd() });`;
const ADOPT = `const a = await import(${url('adopt-cli.mjs')}); a.cmdAdopt([]);`;
const UNADOPT = `const a = await import(${url('adopt-cli.mjs')}); a.cmdUnadopt([]);`;
const LEGACY_CLEANUP = `const h = await import(${url('hook-context.mjs')}); h.cleanupClaudeMdLegacyBlock(); globalThis.__r = 'done';`;

const ok = (s) => expect(s.status, `${s.stderr}`.slice(0, 400)).toBe(0);
const read = (p) => readFileSync(p, 'utf8');

/** Adopt app, then commit `.claude` as a link to `outside`, holding the plugin's own two files. */
function claudeDirLinkedOut({ victims = true } = {}) {
  ok(run(ADOPT_OLDER_DOC));
  rmSync(join(app, '.claude'), { recursive: true });
  if (victims) {
    writeFileSync(join(outside, 'plugin_claude_mem_lite.md'), VICTIM);
    writeFileSync(join(outside, '.plugin_claude_mem_lite_state.json'), VICTIM);
  }
  symlinkSync('../../outside', join(app, '.claude'));
  commitAll(app);
}

describe('a committed .claude directory link out of the repository', () => {
  it('SessionStart does not overwrite the two files in the linked directory', () => {
    claudeDirLinkedOut();
    ok(run(SESSION_START));
    expect(read(join(outside, 'plugin_claude_mem_lite.md'))).toBe(VICTIM);
    expect(read(join(outside, '.plugin_claude_mem_lite_state.json'))).toBe(VICTIM);
  });

  it('SessionStart creates nothing in the linked directory', () => {
    claudeDirLinkedOut({ victims: false });
    ok(run(SESSION_START));
    expect(existsSync(join(outside, 'plugin_claude_mem_lite.md'))).toBe(false);
    expect(existsSync(join(outside, '.plugin_claude_mem_lite_state.json'))).toBe(false);
  });

  it('adopt refuses, names the link and the remedy, and writes nothing, CLAUDE.md included', () => {
    claudeDirLinkedOut();
    ok(run(DRIFTED_BLOCK_AT(join(app, 'CLAUDE.md'))));
    const before = read(join(app, 'CLAUDE.md'));
    const s = run(ADOPT);
    expect(s.code).toBe(1);
    expect(s.stdout).toContain(join(app, '.claude'));
    expect(s.stdout).toMatch(/outside this project/);
    expect(s.stdout).toMatch(/Replace the link/);
    expect(read(join(app, 'CLAUDE.md'))).toBe(before);
    expect(read(join(outside, 'plugin_claude_mem_lite.md'))).toBe(VICTIM);
  });

  it('unadopt --all leaves the files in the linked directory and says so', () => {
    claudeDirLinkedOut();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app]: {} } }));
    const s = run(`const a = await import(${url('adopt-cli.mjs')}); a.cmdUnadopt(['--all']);`);
    ok(s);
    expect(read(join(outside, 'plugin_claude_mem_lite.md'))).toBe(VICTIM);
    expect(read(join(outside, '.plugin_claude_mem_lite_state.json'))).toBe(VICTIM);
    expect(s.stdout).toContain(`left ${join(app, '.claude')} alone`);
  });

  it('unadopt removes the block and leaves the files in the linked directory', () => {
    claudeDirLinkedOut();
    const s = run(UNADOPT);
    ok(s);
    expect(s.stdout.split(`left ${join(app, '.claude')} alone`)).toHaveLength(2);
    // CLAUDE.md held only the block, so unadopt deleted it.
    expect(existsSync(join(app, 'CLAUDE.md'))).toBe(false);
    expect(read(join(outside, 'plugin_claude_mem_lite.md'))).toBe(VICTIM);
    expect(read(join(outside, '.plugin_claude_mem_lite_state.json'))).toBe(VICTIM);
    expect(s.stdout).toContain(`left ${join(app, '.claude')} alone`);
  });
});

describe('a committed CLAUDE.md link out of the repository', () => {
  it('SessionStart does not refresh a block in the linked file', () => {
    const other = join(outside, 'CLAUDE.md');
    writeFileSync(other, 'owner line\n');
    ok(run(DRIFTED_BLOCK_AT(other)));
    const before = read(other);
    symlinkSync('../../outside/CLAUDE.md', join(app, 'CLAUDE.md'));
    commitAll(app);
    ok(run(SESSION_START));
    expect(read(other)).toBe(before);
    expect(existsSync(join(app, DOC))).toBe(false);
  });

  it('adopt does not append the block to the linked file', () => {
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, VICTIM);
    symlinkSync('../../outside/victim.txt', join(app, 'CLAUDE.md'));
    commitAll(app);
    const s = run(ADOPT);
    expect(s.code).toBe(1);
    expect(read(victim)).toBe(VICTIM);
    expect(existsSync(join(app, DOC))).toBe(false);
  });

  it('unadopt leaves the block in the linked file', () => {
    const other = join(outside, 'CLAUDE.md');
    writeFileSync(other, 'owner line\n');
    ok(run(DRIFTED_BLOCK_AT(other)));
    const before = read(other);
    symlinkSync('../../outside/CLAUDE.md', join(app, 'CLAUDE.md'));
    commitAll(app);
    const s = run(UNADOPT);
    ok(s);
    expect(read(other)).toBe(before);
    expect(s.stdout).toContain(`left ${join(app, 'CLAUDE.md')} alone`);
  });

  it('SessionStart does not add the AGENTS.md import to the linked file', () => {
    ok(run(`${IMPORTS}\nm.writeManaged(process.cwd(), managed(c.getDetailDoc()));`));
    const other = join(outside, 'CLAUDE.md');
    renameSync(join(app, 'CLAUDE.md'), other);
    const before = read(other);
    symlinkSync('../../outside/CLAUDE.md', join(app, 'CLAUDE.md'));
    writeFileSync(join(app, 'AGENTS.md'), 'agents line\n');
    commitAll(app);
    ok(run(SESSION_START));
    expect(read(other)).toBe(before);
  });

  it('unadopt --all reports the project as skipped and leaves the block', () => {
    const other = join(outside, 'CLAUDE.md');
    writeFileSync(other, 'owner line\n');
    ok(run(DRIFTED_BLOCK_AT(other)));
    const before = read(other);
    symlinkSync('../../outside/CLAUDE.md', join(app, 'CLAUDE.md'));
    commitAll(app);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app]: {} } }));
    const s = run(`const a = await import(${url('adopt-cli.mjs')}); a.cmdUnadopt(['--all']);`);
    ok(s);
    expect(read(other)).toBe(before);
    expect(s.stdout).toContain(`${app} → skipped-symlink`);
    expect(s.stdout).not.toContain('cleaned partial residue');
  });

  it("SessionStart's legacy cleanup does not rewrite the linked file, auto-adopt off", () => {
    const notes = join(outside, 'NOTES.md');
    const text = 'keep this\n<claude-mem-context>\nold context\n</claude-mem-context>\ntrailing\n';
    writeFileSync(notes, text);
    symlinkSync('../../outside/NOTES.md', join(app, 'CLAUDE.md'));
    commitAll(app);
    const s = run(LEGACY_CLEANUP, { env: { CLAUDE_PROJECT_DIR: app, MEM_NO_AUTO_ADOPT: '1' } });
    ok(s);
    expect(s.r).toBe('done');
    expect(read(notes)).toBe(text);
  });

  it('adopt does not write into the git directory through a committed link', () => {
    const config = join(app, '.git', 'config');
    const before = read(config);
    symlinkSync('.git/config', join(app, 'CLAUDE.md'));
    commitAll(app);
    expect(run(ADOPT).code).toBe(1);
    expect(read(config)).toBe(before);
  });
});

describe('a committed detail-doc link stays refused wherever it points', () => {
  it("SessionStart does not overwrite the user's untracked file inside the repository", () => {
    ok(run(ADOPT_OLDER_DOC));
    const env = join(app, '.env');
    writeFileSync(env, VICTIM);
    rmSync(join(app, DOC));
    symlinkSync('../.env', join(app, DOC));
    git(app, 'add', DOC);
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'doc link');
    ok(run(SESSION_START));
    expect(read(env)).toBe(VICTIM);
  });
});

describe('layouts built with links keep working', () => {
  it('an untracked .claude linked into a dotfiles directory is written', () => {
    ok(run(ADOPT_OLDER_DOC));
    const dot = join(home, 'dotfiles', 'app-claude');
    mkdirSync(dirname(dot), { recursive: true });
    renameSync(join(app, '.claude'), dot);
    symlinkSync(dot, join(app, '.claude'));
    ok(run(SESSION_START));
    expect(read(join(dot, 'plugin_claude_mem_lite.md'))).not.toContain('an older doc');
  });

  it('an untracked CLAUDE.md linked into a dotfiles directory is refreshed', () => {
    const dot = join(home, 'dotfiles', 'CLAUDE.md');
    mkdirSync(dirname(dot), { recursive: true });
    writeFileSync(dot, 'owner line\n');
    ok(run(DRIFTED_BLOCK_AT(dot)));
    symlinkSync(dot, join(app, 'CLAUDE.md'));
    ok(run(SESSION_START));
    expect(read(dot)).not.toContain('OLD TEXT');
    expect(read(dot)).toContain('owner line');
  });

  it('a committed CLAUDE.md -> AGENTS.md is refreshed in AGENTS.md', () => {
    writeFileSync(join(app, 'AGENTS.md'), 'team line\n');
    ok(run(DRIFTED_BLOCK_AT(join(app, 'AGENTS.md'))));
    symlinkSync('AGENTS.md', join(app, 'CLAUDE.md'));
    commitAll(app);
    ok(run(SESSION_START));
    expect(read(join(app, 'AGENTS.md'))).not.toContain('OLD TEXT');
    expect(lstatSync(join(app, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
  });

  it('a committed .claude linked to a directory inside the repository is written', () => {
    ok(run(ADOPT_OLDER_DOC));
    mkdirSync(join(app, 'config'));
    renameSync(join(app, '.claude'), join(app, 'config', 'claude'));
    symlinkSync('config/claude', join(app, '.claude'));
    commitAll(app);
    ok(run(SESSION_START));
    expect(read(join(app, 'config', 'claude', 'plugin_claude_mem_lite.md'))).not.toContain('an older doc');
  });

  it('in a subdirectory, a committed .claude linked elsewhere inside the repository is written', () => {
    const pkg = join(app, 'pkg');
    mkdirSync(join(app, 'shared-claude'), { recursive: true });
    mkdirSync(pkg);
    symlinkSync('../shared-claude', join(pkg, '.claude'));
    commitAll(app);
    ok(run(ADOPT, { cwd: pkg }));
    expect(existsSync(join(app, 'shared-claude', 'plugin_claude_mem_lite.md'))).toBe(true);
  });

  it('an untracked state sidecar linked into a stow-style tree is written (round 2, F3)', () => {
    ok(run(ADOPT_OLDER_DOC));
    commitAll(app);
    const stow = join(home, 'stow', 'state.json');
    mkdirSync(dirname(stow), { recursive: true });
    renameSync(join(app, STATE), stow);
    symlinkSync(stow, join(app, STATE));
    const before = read(stow);
    ok(run(SESSION_START));
    expect(read(stow)).not.toBe(before);
    expect(lstatSync(join(app, STATE)).isSymbolicLink()).toBe(true);
  });
});

describe('a directory git does not track', () => {
  it('adopt refuses a .claude linked out of it', () => {
    const plain = join(home, 'plain');
    mkdirSync(plain);
    symlinkSync('../outside', join(plain, '.claude'));
    const s = run(ADOPT, { cwd: plain });
    expect(s.code).toBe(1);
    expect(existsSync(join(outside, 'plugin_claude_mem_lite.md'))).toBe(false);
  });

  it('adopt refuses a CLAUDE.md linked out of it (a dotfiles CLAUDE.md is written through inside git only)', () => {
    const plain = join(home, 'plain');
    mkdirSync(plain);
    const dot = join(home, 'dotfiles', 'CLAUDE.md');
    mkdirSync(dirname(dot), { recursive: true });
    writeFileSync(dot, 'owner line\n');
    symlinkSync(dot, join(plain, 'CLAUDE.md'));
    const s = run(ADOPT, { cwd: plain });
    expect(s.code).toBe(1);
    expect(s.stdout).toMatch(/git does not show as one you made/);
    expect(read(dot)).toBe('owner line\n');
  });

  it('adopt writes through a .claude linked inside it', () => {
    const plain = join(home, 'plain');
    mkdirSync(join(plain, 'cfg'), { recursive: true });
    symlinkSync('cfg', join(plain, '.claude'));
    ok(run(ADOPT, { cwd: plain }));
    expect(existsSync(join(plain, 'cfg', 'plugin_claude_mem_lite.md'))).toBe(true);
  });
});

describe("the legacy <claude-mem-context> cleanup keeps the user's line breaks", () => {
  it('removes the span without joining the lines around it', () => {
    writeFileSync(
      join(app, 'CLAUDE.md'),
      'keep this\n<claude-mem-context>\nold context\n</claude-mem-context>\ntrailing\n',
    );
    ok(run(LEGACY_CLEANUP, { env: { CLAUDE_PROJECT_DIR: app, MEM_NO_AUTO_ADOPT: '1' } }));
    expect(read(join(app, 'CLAUDE.md'))).toBe('keep this\ntrailing\n');
  });

  it('a span between blank lines leaves one blank line', () => {
    writeFileSync(
      join(app, 'CLAUDE.md'),
      'keep this\n\n<claude-mem-context>\nold context\n</claude-mem-context>\n\ntrailing\n',
    );
    ok(run(LEGACY_CLEANUP, { env: { CLAUDE_PROJECT_DIR: app, MEM_NO_AUTO_ADOPT: '1' } }));
    expect(read(join(app, 'CLAUDE.md'))).toBe('keep this\n\ntrailing\n');
  });
});
