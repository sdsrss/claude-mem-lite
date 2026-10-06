// Steering channel r3 (tasks/specs/sandbox-eval-l3.md; docs/audits/20260929-sandbox-usage-eval.md
// §8.5). Injected SessionStart steering cost most of the agent's proactive memory writes
// (1.5 per trajectory vs 5.25 from a CLAUDE.md block, exact p=0.029) and never reached
// subagents (0/12 vs 12/12). A managed block in CLAUDE.local.md — a file Claude Code loads
// like CLAUDE.md — restored the write rate (5.25) and reached subagents (12/12), and with
// the file listed in the repository's info/exclude it never enters a commit.
//
// So auto-adopt writes <git top-level>/CLAUDE.local.md inside a git work tree and keeps
// injecting everywhere else. It never writes where the file would be committed (tracked),
// where it would steer every project below it ($HOME, `/`), or where the user opted out.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  symlinkSync,
  appendFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import {
  LOCAL_MD,
  RULES_MD,
  localSteeringRoot,
  writeLocalSteering,
  readLocalSteering,
  removeLocalSteering,
  forgetLocalSteering,
  isSharedAncestor,
} from '../lib/local-steering.mjs';
import { silentAutoAdopt, cmdUnadopt, cmdAdopt } from '../adopt-cli.mjs';
import { isOwnAdoptionArtifact, readBlock, writeManaged } from '../claudemd.mjs';
import {
  buildClaudeMdBlock,
  getDetailDoc,
  PLUGIN_SLUG,
  CURRENT_SENTINEL_VERSION,
} from '../adopt-content.mjs';
import { memdirPath, disableSentinelPath } from '../memdir.mjs';
import { isAdoptedHere } from '../lib/quiet-scope.mjs';
import { mkdtempWithoutInstructionAncestors } from './test-helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = PLUGIN_SLUG;
const V = CURRENT_SENTINEL_VERSION;
const HEADING = '## claude-mem-lite — persistent memory';
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const initRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
};
const status = (dir) => git(dir, 'status', '--porcelain').trim();
const excludeOf = (dir) => readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');

let home;
let saved;
beforeEach(() => {
  home = mkdtempWithoutInstructionAncestors('cml-local-');
  saved = {
    HOME: process.env.HOME,
    MEM_NO_AUTO_ADOPT: process.env.MEM_NO_AUTO_ADOPT,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.MEM_NO_AUTO_ADOPT;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('localSteeringRoot', () => {
  it('is the git top-level, from the root or a subdirectory', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    mkdirSync(join(app, 'src'));
    expect(localSteeringRoot(app)).toBe(app);
    expect(localSteeringRoot(join(app, 'src'))).toBe(app);
  });

  it('is null outside a git work tree', () => {
    const plain = join(home, 'work', 'plain');
    mkdirSync(plain, { recursive: true });
    expect(localSteeringRoot(plain)).toBeNull();
  });

  it('is null when the work tree is $HOME itself (the file would steer every project below)', () => {
    initRepo(home);
    const proj = join(home, 'dev', 'proj');
    mkdirSync(proj, { recursive: true });
    expect(localSteeringRoot(proj)).toBeNull();
  });
});

describe('writeLocalSteering / removeLocalSteering', () => {
  let app;
  beforeEach(() => {
    app = join(home, 'work', 'app');
    initRepo(app);
  });
  const block = () => buildClaudeMdBlock({ detailDocRef: '/data/plugin_claude_mem_lite.md' });

  it('writes the block, excludes the file, and leaves `git status` clean', () => {
    const r = writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    expect(r.action).toBe('created');
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toContain(HEADING);
    expect(excludeOf(app)).toMatch(/^CLAUDE\.local\.md$/m);
    expect(status(app)).toBe('');
    expect(readLocalSteering(app, SLUG).body).not.toBeNull();
  });

  it('is idempotent: a second write changes nothing and adds no second exclude line', () => {
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    const before = readFileSync(join(app, LOCAL_MD), 'utf8');
    expect(writeLocalSteering(app, { slug: SLUG, version: V, block: block() }).action).toBe('unchanged');
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toBe(before);
    expect(excludeOf(app).match(/^CLAUDE\.local\.md$/gm)).toHaveLength(1);
  });

  it("keeps the user's own CLAUDE.local.md text around the block", () => {
    writeFileSync(join(app, LOCAL_MD), '# my notes\n\nUse pnpm.\n');
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    const text = readFileSync(join(app, LOCAL_MD), 'utf8');
    expect(text).toMatch(/^# my notes\n\nUse pnpm\.\n/);
    expect(text).toContain(HEADING);
    removeLocalSteering(app, SLUG);
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toBe('# my notes\n\nUse pnpm.\n');
  });

  it('does not add an exclude line when the file is already ignored', () => {
    writeFileSync(join(app, '.gitignore'), 'CLAUDE.local.md\n');
    git(app, 'add', '.gitignore');
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore');
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    expect(excludeOf(app)).not.toMatch(/^CLAUDE\.local\.md$/m);
    expect(status(app)).toBe('');
  });

  it('refuses when CLAUDE.local.md is tracked — writing it would dirty the repository', () => {
    writeFileSync(join(app, LOCAL_MD), 'team notes\n');
    git(app, 'add', LOCAL_MD);
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked');
    const r = writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    expect(r.action).toBe('refused');
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toBe('team notes\n');
    expect(status(app)).toBe('');
  });

  it('removal deletes a file that held only the block and drops the exclude lines it added', () => {
    const userLine = 'secret.txt';
    writeFileSync(join(app, '.git', 'info', 'exclude'), `${userLine}\n`);
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    const r = removeLocalSteering(app, SLUG);
    expect(r.action).toBe('removed');
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
    expect(excludeOf(app)).toBe(`${userLine}\n`);
  });

  it('a CLAUDE.local.md holding only the block is the plugin’s own artifact', () => {
    writeLocalSteering(app, { slug: SLUG, version: V, block: block() });
    expect(isOwnAdoptionArtifact(app, LOCAL_MD, SLUG)).toBe(true);
    writeFileSync(join(app, LOCAL_MD), `mine\n${readFileSync(join(app, LOCAL_MD), 'utf8')}`);
    expect(isOwnAdoptionArtifact(app, LOCAL_MD, SLUG)).toBe(false);
  });
});

describe('silentAutoAdopt picks the channel', () => {
  it('a git project gets CLAUDE.local.md and nothing else under the tree', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    const r = silentAutoAdopt({ cwd: app });
    expect(r.action).toBe('local');
    expect(readdirSync(app).sort()).toEqual(['.git', 'CLAUDE.local.md', 'README.md']);
    expect(status(app)).toBe('');
  });

  it('a directory outside git keeps the injected steering', () => {
    const plain = join(home, 'work', 'plain');
    mkdirSync(plain, { recursive: true });
    expect(silentAutoAdopt({ cwd: plain }).action).toBe('inject');
    expect(readdirSync(plain)).toEqual([]);
  });

  it('a tracked CLAUDE.local.md falls back to injection', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    writeFileSync(join(app, LOCAL_MD), 'team notes\n');
    git(app, 'add', LOCAL_MD);
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked');
    // The reason, not only the outcome: with the exclude roll-back, removing the tracked check
    // would still refuse (as exclude-failed) after touching info/exclude twice.
    expect(silentAutoAdopt({ cwd: app })).toMatchObject({ action: 'inject', reason: 'local-tracked' });
  });

  it('a project that carries the CLAUDE.md block is synced and loses a stale local block', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    writeLocalSteering(app, { slug: SLUG, version: V, block: 'stale' });
    writeManaged(app, { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    silentAutoAdopt({ cwd: app });
    expect(readBlock(app, SLUG).body).not.toBeNull();
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });

  it('CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 leaves an existing local block as it is', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    writeLocalSteering(app, { slug: SLUG, version: V, block: 'frozen by the user' });
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    try {
      expect(silentAutoAdopt({ cwd: app })).toMatchObject({ action: 'local', written: 'unchanged' });
    } finally {
      delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    }
    expect(readLocalSteering(app, SLUG).body).toBe('frozen by the user');
  });

  it('when the exclude entry cannot be written, nothing is written and the steering is injected', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    const exclude = join(app, '.git', 'info', 'exclude');
    rmSync(exclude, { force: true });
    mkdirSync(exclude); // appending to a directory fails
    const r = silentAutoAdopt({ cwd: app });
    expect(r).toMatchObject({ action: 'inject', reason: 'local-exclude-failed' });
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });

  it('the per-project opt-out writes nothing', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    mkdirSync(memdirPath(app), { recursive: true });
    writeFileSync(disableSentinelPath(memdirPath(app)), '{}');
    expect(silentAutoAdopt({ cwd: app }).action).toBe('disabled');
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });
});

// Pre-tag claims review (P1-2/3/4, P2-3, P1-5): the plugin wrote the file back after the user
// removed it, a root-level opt-out did not hold for a session started in a subdirectory, a
// subdirectory session added a local copy next to the root's CLAUDE.md block, and the file named
// the data dir by absolute path (the username), while `npm pack` does not read info/exclude.
describe('a removed or opted-out local block stays removed', () => {
  const app = () => join(home, 'work', 'app');
  beforeEach(() => initRepo(app()));

  it('a CLAUDE.local.md the user deleted is not written again; the steering is injected instead', () => {
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('local');
    rmSync(join(app(), LOCAL_MD));
    const r = silentAutoAdopt({ cwd: app() });
    expect(r).toMatchObject({ action: 'inject', reason: 'local-removed' });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('after unadopt the next session does not write it again', () => {
    silentAutoAdopt({ cwd: app() });
    const cwdBefore = process.cwd();
    process.chdir(app());
    process.env.CLAUDE_PROJECT_DIR = app();
    try {
      cmdUnadopt([]);
    } finally {
      process.chdir(cwdBefore);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('inject');
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('adopt --enable re-arms it', () => {
    silentAutoAdopt({ cwd: app() });
    rmSync(join(app(), LOCAL_MD));
    const cwdBefore = process.cwd();
    process.chdir(app());
    process.env.CLAUDE_PROJECT_DIR = app();
    try {
      cmdAdopt(['--enable']);
    } finally {
      process.chdir(cwdBefore);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('local');
    expect(existsSync(join(app(), LOCAL_MD))).toBe(true);
  });

  it('an opt-out at the repository root holds for a session started in a subdirectory', () => {
    const sub = join(app(), 'pkg');
    mkdirSync(sub);
    mkdirSync(memdirPath(app()), { recursive: true });
    writeFileSync(disableSentinelPath(memdirPath(app())), '{}');
    // Off means off: no file, and no injected copy or /adopt offer either (delta review P2-2).
    expect(silentAutoAdopt({ cwd: sub })).toMatchObject({ action: 'disabled', reason: 'root-disabled' });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('a subdirectory session of a repository whose root CLAUDE.md carries the block adds nothing', () => {
    writeManaged(app(), { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    const sub = join(app(), 'pkg');
    mkdirSync(sub);
    const r = silentAutoAdopt({ cwd: sub });
    expect(r.action).toBe('already-adopted');
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('the file names the detail doc under ~, not by the home path', () => {
    silentAutoAdopt({ cwd: app() });
    const text = readFileSync(join(app(), LOCAL_MD), 'utf8');
    expect(text).not.toContain(home);
    expect(text).toMatch(/→ `~\/[^`]*plugin_claude_mem_lite\.md`/);
  });
});

describe('the CLI verbs clean the local block up', () => {
  let app;
  let cwdBefore;
  beforeEach(() => {
    app = join(home, 'work', 'app');
    initRepo(app);
    cwdBefore = process.cwd();
    process.chdir(app);
    process.env.CLAUDE_PROJECT_DIR = app;
    silentAutoAdopt({ cwd: app });
    expect(existsSync(join(app, LOCAL_MD))).toBe(true);
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it('unadopt removes it and its exclude line', () => {
    cmdUnadopt([]);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
    expect(excludeOf(app)).not.toMatch(/^CLAUDE\.local\.md$/m);
  });

  it('adopt --disable removes it (the guidance is off for this project)', () => {
    cmdAdopt(['--disable']);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });

  it('an explicit adopt moves the steering into CLAUDE.md and drops the local copy', () => {
    cmdAdopt([]);
    expect(readBlock(app, SLUG).body).not.toBeNull();
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });
});

describe('SessionStart end to end', () => {
  let app;
  let dataDir;
  beforeEach(() => {
    app = join(home, 'work', 'app');
    initRepo(app);
    dataDir = join(home, 'data');
  });
  const sessionStart = (cwd, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
      cwd,
      input: JSON.stringify({ session_id: 'local-e2e', source: 'startup', cwd }),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|MEM_)/.test(k))),
        HOME: home,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_PROJECT_DIR: cwd,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        ...extraEnv,
      },
    });
    expect(r.status).toBe(0);
    return r.stdout.trim() ? JSON.parse(r.stdout.trim()) : {};
  };

  it('MEM_NO_ADOPT_HINT=1 silences the local-file note but still writes the file', () => {
    const out = sessionStart(app, { MEM_NO_ADOPT_HINT: '1' });
    expect(out.systemMessage).toBeUndefined();
    expect(existsSync(join(app, LOCAL_MD))).toBe(true);
  });

  // Claude Code reads CLAUDE.local.md at startup, BEFORE SessionStart hooks run, so the session
  // that creates the file does not load it. The release-tree sandbox run showed it: in the first
  // session of every project neither the main agent nor its subagents had any steering (0/4).
  // That session gets the block injected once; from the next session on the file carries it.
  it('first session: writes CLAUDE.local.md AND injects the block once; later sessions rely on the file', () => {
    const first = sessionStart(app);
    expect(readFileSync(join(app, LOCAL_MD), 'utf8')).toContain(HEADING);
    expect(first.hookSpecificOutput?.additionalContext ?? '').toContain(HEADING);
    expect(status(app)).toBe('');
    expect(first.systemMessage).toMatch(/CLAUDE\.local\.md/);
    // The undo it names is the one that holds (a removed file stays removed).
    expect(first.systemMessage).toMatch(
      /Delete it or run `claude-mem-lite unadopt` and it is not written again/,
    );
    // The block points at a detail doc that exists, in the plugin's data dir, named under ~.
    const ref = /→ `([^`]+plugin_claude_mem_lite\.md)`/.exec(readFileSync(join(app, LOCAL_MD), 'utf8'))?.[1];
    const abs = ref?.replace(/^~/, home);
    expect(abs && abs.startsWith(dataDir) && existsSync(abs)).toBe(true);
    const second = sessionStart(app);
    expect(second.hookSpecificOutput?.additionalContext ?? '').not.toContain(HEADING);
    expect(second.systemMessage).toBeUndefined();
  });

  it('at $HOME the steering is injected without suggesting /adopt, which would write ~/CLAUDE.md', () => {
    const out = sessionStart(home);
    expect(out.hookSpecificOutput.additionalContext).toContain(HEADING);
    expect(out.systemMessage ?? '').not.toMatch(/\/adopt/);
  });

  // Claude Code hands the hook the real path; $HOME may be a symlink to it (delta review P3-14).
  it('at a symlinked $HOME entered by its real path, /adopt is not suggested either', () => {
    const real = join(home, 'realhome');
    const link = join(home, 'linkhome');
    mkdirSync(real);
    symlinkSync(real, link);
    const out = sessionStart(real, { HOME: link });
    expect(out.hookSpecificOutput.additionalContext).toContain(HEADING);
    expect(out.systemMessage ?? '').not.toMatch(/\/adopt/);
  });

  // Delta review P2-2: `adopt --disable` at the root said it covered subdirectory sessions, and
  // those still had the steering injected plus the /adopt offer.
  it('a subdirectory session of a repository opted out at its root gets no steering and no offer', () => {
    mkdirSync(memdirPath(app), { recursive: true });
    writeFileSync(disableSentinelPath(memdirPath(app)), '{}');
    const sub = join(app, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    const out = sessionStart(sub);
    expect(out.hookSpecificOutput?.additionalContext ?? '').not.toContain(HEADING);
    expect(out.systemMessage ?? '').not.toMatch(/\/adopt/);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
  });

  it('outside git the steering is still injected', () => {
    const plain = join(home, 'work', 'plain');
    mkdirSync(plain, { recursive: true });
    const out = sessionStart(plain);
    expect(out.hookSpecificOutput.additionalContext).toContain(HEADING);
    expect(readdirSync(plain)).toEqual([]);
  });

  // D#212: a repository whose instructions are AGENTS.md gets the block in .claude/rules/, which
  // Claude Code loads beside AGENTS.md (CLAUDE.local.md would switch it off). Like CLAUDE.local.md,
  // the file is read before this hook runs, so the session that creates it gets the block injected
  // once; a one-time note says where the guidance is and why it is not CLAUDE.local.md.
  it('an AGENTS.md repository: the rules file, injected once, and a one-time note naming it', () => {
    writeFileSync(join(app, 'AGENTS.md'), '# Instructions for coding agents\n');
    git(app, 'add', 'AGENTS.md');
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'agents');
    const first = sessionStart(app);
    expect(readFileSync(join(app, RULES_MD), 'utf8')).toContain(HEADING);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
    expect(first.hookSpecificOutput?.additionalContext ?? '').toContain(HEADING);
    expect(first.systemMessage ?? '').toContain('.claude/rules/claude-mem-lite.md');
    expect(first.systemMessage ?? '').toMatch(/AGENTS\.md/);
    expect(first.systemMessage ?? '').toMatch(/not written again/);
    expect(status(app)).toBe('');
    const second = sessionStart(app);
    expect(second.hookSpecificOutput?.additionalContext ?? '').not.toContain(HEADING);
    expect(second.systemMessage).toBeUndefined();
  });

  // When the rules file cannot be written either, the steering is injected and the one-time note
  // names AGENTS.md, why the rules file is not there, and the two ways to a file that leave it
  // loading: the setting that reads both, or /adopt, whose CLAUDE.md imports it.
  it('an AGENTS.md repository at a publishable package root: injected, the note says why', () => {
    writeFileSync(join(app, 'AGENTS.md'), '# Instructions for coding agents\n');
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
    const first = sessionStart(app);
    expect(first.hookSpecificOutput?.additionalContext ?? '').toContain(HEADING);
    expect(first.systemMessage ?? '').toMatch(/AGENTS\.md/);
    expect(first.systemMessage ?? '').toMatch(/npm publish would ship it/);
    expect(first.systemMessage ?? '').toMatch(/claude-md-and-agents-md/);
    expect(first.systemMessage ?? '').toMatch(/\/adopt .*imports AGENTS\.md/);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
    expect(existsSync(join(app, RULES_MD))).toBe(false);
    const second = sessionStart(app);
    expect(second.hookSpecificOutput?.additionalContext ?? '').toContain(HEADING);
    expect(second.systemMessage).toBeUndefined();
  });
});

// Pre-tag defect review (v6.20.0, against 80335a4): P2-1 worktrees, P2-2 symlinks, P1-1 npm pack,
// P2-3 a pre-upgrade opt-out under ~/.claude, P2-4 --disable --all without a memdir, and the
// mutations no test could catch (tracked refusal leaving exclude alone, filesystem-root refusal,
// the post-append check, exclude cleanup after a hand delete, the note switch, quiet-scope, the
// --all sweeps, CLAUDE_CONFIG_DIR wiring, --dry-run and --status lines).
describe('pre-tag defect review: local steering edges', () => {
  const app = () => join(home, 'work', 'app');
  const withCwd = (dir, fn) => {
    const before = process.cwd();
    process.chdir(dir);
    process.env.CLAUDE_PROJECT_DIR = dir;
    try {
      return fn();
    } finally {
      process.chdir(before);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
  };
  const captureLog = (fn) => {
    const lines = [];
    const orig = console.log;
    console.log = (m) => lines.push(String(m));
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return lines.join('\n');
  };
  beforeEach(() => initRepo(app()));

  it('a symlinked CLAUDE.local.md is not written through', () => {
    const other = join(home, 'dotfiles');
    mkdirSync(other);
    writeFileSync(join(other, 'shared.md'), 'shared notes\n');
    symlinkSync(join(other, 'shared.md'), join(app(), LOCAL_MD));
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'inject', reason: 'local-symlink' });
    expect(readFileSync(join(other, 'shared.md'), 'utf8')).toBe('shared notes\n');
  });

  it('removing one worktree’s block keeps the shared exclude entry while another worktree still has one', () => {
    const wt = join(home, 'work', 'wt');
    git(app(), 'worktree', 'add', '-q', wt);
    silentAutoAdopt({ cwd: app() });
    silentAutoAdopt({ cwd: wt });
    removeLocalSteering(wt, SLUG);
    expect(status(app())).toBe('');
    removeLocalSteering(app(), SLUG);
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
  });

  it('with template refresh frozen, a missing exclude entry is restored', () => {
    silentAutoAdopt({ cwd: app() });
    writeFileSync(join(app(), '.git', 'info', 'exclude'), '');
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    try {
      silentAutoAdopt({ cwd: app() });
    } finally {
      delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    }
    expect(status(app())).toBe('');
  });

  it('a publishable npm package at the root gets injection, not a file npm pack would ship', () => {
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-npm-publishable',
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('a private package, a files whitelist, or an .npmignore entry keeps the local file', () => {
    for (const [i, setup] of [
      () => writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'a', private: true })),
      () => writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'b', files: ['index.js'] })),
      () => {
        writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'c' }));
        writeFileSync(join(app(), '.npmignore'), 'CLAUDE.local.md\n');
      },
    ].entries()) {
      const dir = join(home, 'work', `pkg${i}`);
      initRepo(dir);
      const before = process.cwd();
      process.chdir(dir);
      try {
        setup.call(null);
      } finally {
        process.chdir(before);
      }
      for (const f of ['package.json', '.npmignore']) {
        if (existsSync(join(app(), f))) {
          writeFileSync(join(dir, f), readFileSync(join(app(), f)));
          rmSync(join(app(), f));
        }
      }
      expect(silentAutoAdopt({ cwd: dir }).action, `setup ${i}`).toBe('local');
    }
  });

  it('refusing a tracked CLAUDE.local.md leaves info/exclude as it was', () => {
    writeFileSync(join(app(), LOCAL_MD), 'team\n');
    git(app(), 'add', LOCAL_MD);
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'tracked');
    const before = excludeOf(app());
    silentAutoAdopt({ cwd: app() });
    expect(excludeOf(app())).toBe(before);
  });

  it('a negated ignore rule makes the exclude entry useless: nothing written, exclude restored', () => {
    writeFileSync(join(app(), '.gitignore'), '!CLAUDE.local.md\n');
    git(app(), 'add', '.gitignore');
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'negate');
    const before = excludeOf(app());
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-exclude-failed',
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(excludeOf(app())).toBe(before);
  });

  it('the filesystem root and $HOME are never a steering root', () => {
    expect(isSharedAncestor('/')).toBe(true);
    expect(isSharedAncestor(home)).toBe(true);
    expect(isSharedAncestor(app())).toBe(false);
  });

  it('unadopt after a hand delete still drops the exclude entry', () => {
    silentAutoAdopt({ cwd: app() });
    rmSync(join(app(), LOCAL_MD));
    withCwd(app(), () => cmdUnadopt([]));
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
  });

  it('quiet-scope counts a local block as adopted even with MEM_NO_AUTO_ADOPT=1', () => {
    silentAutoAdopt({ cwd: app() });
    process.env.MEM_NO_AUTO_ADOPT = '1';
    expect(isAdoptedHere(app())).toBe(true);
    rmSync(join(app(), LOCAL_MD));
    expect(isAdoptedHere(app())).toBe(false);
  });

  it('unadopt --all and adopt --disable --all sweep the local block of every known project', () => {
    const other = join(home, 'work', 'other');
    initRepo(other);
    silentAutoAdopt({ cwd: app() });
    silentAutoAdopt({ cwd: other });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app()]: {}, [other]: {} } }));
    withCwd(app(), () => cmdUnadopt(['--all']));
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(existsSync(join(other, LOCAL_MD))).toBe(false);
  });

  it('adopt --disable --all disables known projects that have no memory dir', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app()]: {} } }));
    silentAutoAdopt({ cwd: app() });
    withCwd(app(), () => cmdAdopt(['--disable', '--all']));
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('disabled');
  });

  it('with CLAUDE_CONFIG_DIR, unadopt --all reads the moved .claude.json', () => {
    const cfg = join(home, 'cfg');
    mkdirSync(cfg);
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ projects: { [app()]: {} } }));
    silentAutoAdopt({ cwd: app() });
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      withCwd(home, () => cmdUnadopt(['--all']));
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('an opt-out written under ~/.claude before CLAUDE_CONFIG_DIR was honoured still holds', () => {
    const cfg = join(home, 'cfg');
    mkdirSync(cfg);
    const legacy = join(home, '.claude', 'projects', app().replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(disableSentinelPath(legacy), '{}');
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      expect(silentAutoAdopt({ cwd: app() }).action).toBe('disabled');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('--dry-run and --status name the local file', () => {
    silentAutoAdopt({ cwd: app() });
    expect(withCwd(app(), () => captureLog(() => cmdUnadopt(['--dry-run'])))).toMatch(
      /would-remove the block in .*CLAUDE\.local\.md/,
    );
    expect(withCwd(app(), () => captureLog(() => cmdAdopt(['--status'])))).toMatch(
      /local: +✓ .*CLAUDE\.local\.md/,
    );
    expect(existsSync(join(app(), LOCAL_MD))).toBe(true);
  });
});

// Pre-tag delta review, round 2 (v6.20.0, against 067a423): P1-1 a root that became an npm
// package after the file was written, P2-1 `files` globs, P2-3 a symlinked $HOME, P2-4 removal
// through a symlink, P2-5 notes left in a plugin-created file, and the mutations the suite could
// not catch (M4-M7 the `files` matcher, M9 an unparseable package.json, M12 the rollback of an
// exclude file it created, M18 a corrupt state file, A9/A10 --enable, Q1 quiet-scope's legacy
// sentinel).
describe('pre-tag delta review: local steering edges, round 2', () => {
  const app = () => join(home, 'work', 'app');
  const withCwd = (dir, fn) => {
    const before = process.cwd();
    process.chdir(dir);
    process.env.CLAUDE_PROJECT_DIR = dir;
    try {
      return fn();
    } finally {
      process.chdir(before);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
  };
  const pkg = (dir, obj) => writeFileSync(join(dir, 'package.json'), JSON.stringify(obj));
  const commitAll = (dir, msg) => git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg);
  const legacyOptOut = () => {
    const legacy = join(home, '.claude', 'projects', app().replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(disableSentinelPath(legacy), '{}');
  };
  beforeEach(() => initRepo(app()));

  it('a root that becomes a publishable package loses the block written before, and gets it back once private', () => {
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', written: 'created' });
    pkg(app(), { name: 'lib', version: '1.0.0' });
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-npm-publishable',
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
    // The plugin took it out, not the user, so it is not remembered as a removal.
    pkg(app(), { name: 'lib', version: '1.0.0', private: true });
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', written: 'created' });
  });

  it('with template refresh frozen, a root that became a package loses the block too', () => {
    silentAutoAdopt({ cwd: app() });
    pkg(app(), { name: 'lib', version: '1.0.0' });
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    try {
      expect(silentAutoAdopt({ cwd: app() }).action).toBe('inject');
    } finally {
      delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    }
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('taking the block out of a package root keeps the user’s own notes in the file', () => {
    silentAutoAdopt({ cwd: app() });
    appendFileSync(join(app(), LOCAL_MD), '\nmy notes\n');
    pkg(app(), { name: 'lib', version: '1.0.0' });
    silentAutoAdopt({ cwd: app() });
    const text = readFileSync(join(app(), LOCAL_MD), 'utf8');
    expect(text).toContain('my notes');
    expect(text).not.toContain(HEADING);
  });

  // Ground truth: `npm pack --dry-run --json` (npm 11.19.0), 2026-09-29, each list in its own
  // package with a CLAUDE.local.md at the root: every list below shipped it.
  it.each([
    ['**/*.md'],
    ['*.*'],
    ['/'],
    ['/*'],
    ['./'],
    ['*'],
    ['*.md'],
    ['*.local.md'],
    ['C*'],
    ['[A-Z]*'],
    ['{lib,*.md}'],
    ['CLAUDE.local.md'],
    ['./CLAUDE.local.md'],
    ['lib/../CLAUDE.local.md'],
    ['lib/../*.md'],
    ['?LAUDE.local.md'],
  ])('a `files` entry npm ships the root file under (%s) gets no file', (entry) => {
    pkg(app(), { name: 'lib', version: '1.0.0', files: [entry] });
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-npm-publishable',
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  // Same run: none of these shipped it.
  it.each([
    [[]],
    [['index.js']],
    [['lib/']],
    [['dist/**/*.js']],
    [['lib/*.md']],
    [['index.js', '!CLAUDE.local.md']],
  ])('a `files` list that leaves the root file out (%j) keeps the local file', (files) => {
    pkg(app(), { name: 'lib', version: '1.0.0', files });
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', written: 'created' });
  });

  // npm 11 does not ship the file under `.`; the matcher refuses it anyway, on purpose: a
  // missing file costs injection, a shipped one leaks.
  it('a `files` entry of `.` is refused (the conservative reading)', () => {
    pkg(app(), { name: 'lib', version: '1.0.0', files: ['.'] });
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ reason: 'local-npm-publishable' });
  });

  it('a root .npmignore does not override `files`, so naming the file there does not keep it out', () => {
    pkg(app(), { name: 'lib', version: '1.0.0', files: ['*.md'] });
    writeFileSync(join(app(), '.npmignore'), 'CLAUDE.local.md\n');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ reason: 'local-npm-publishable' });
  });

  it('an unparseable package.json counts as publishable', () => {
    writeFileSync(join(app(), 'package.json'), '{ "name": ');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ reason: 'local-npm-publishable' });
  });

  it('a $HOME reached through a symlink is still never a steering root', () => {
    const real = join(home, 'realhome');
    const link = join(home, 'linkhome');
    mkdirSync(join(real, 'code', 'scratch'), { recursive: true });
    symlinkSync(real, link);
    git(real, 'init', '-q');
    process.env.HOME = link;
    expect(isSharedAncestor(real)).toBe(true);
    expect(silentAutoAdopt({ cwd: join(link, 'code', 'scratch') }).action).not.toBe('local');
    expect(existsSync(join(real, LOCAL_MD))).toBe(false);
  });

  it('a symlinked CLAUDE.local.md is never edited through the link: not by a session, unadopt or --disable', () => {
    const other = join(home, 'work', 'other');
    initRepo(other);
    silentAutoAdopt({ cwd: other });
    const before = readFileSync(join(other, LOCAL_MD), 'utf8');
    expect(before).toContain(HEADING);
    symlinkSync(join(other, LOCAL_MD), join(app(), LOCAL_MD));
    writeManaged(app(), { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    silentAutoAdopt({ cwd: app() });
    expect(readFileSync(join(other, LOCAL_MD), 'utf8')).toBe(before);
    withCwd(app(), () => cmdUnadopt([]));
    expect(readFileSync(join(other, LOCAL_MD), 'utf8')).toBe(before);
    withCwd(app(), () => cmdAdopt(['--disable']));
    expect(readFileSync(join(other, LOCAL_MD), 'utf8')).toBe(before);
    const lines = [];
    const orig = console.log;
    console.log = (m) => lines.push(String(m));
    try {
      withCwd(app(), () => cmdAdopt([]));
    } finally {
      console.log = orig;
    }
    expect(readFileSync(join(other, LOCAL_MD), 'utf8')).toBe(before);
    expect(lines.join('\n')).toMatch(/left .*CLAUDE\.local\.md alone: it is a symlink/);
  });

  // The host loads the file whatever the plugin may write, so a block already in it is not
  // injected a second time.
  it('a symlink to a file that carries the block is not injected on top of it', () => {
    const other = join(home, 'work', 'other');
    initRepo(other);
    silentAutoAdopt({ cwd: other });
    symlinkSync(join(other, LOCAL_MD), join(app(), LOCAL_MD));
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'already-adopted',
      reason: 'local-symlink',
    });
  });

  it('a tracked CLAUDE.local.md that carries the block is not injected on top of it', () => {
    silentAutoAdopt({ cwd: app() });
    git(app(), 'add', '-f', LOCAL_MD);
    commitAll(app(), 'commit the local file');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'already-adopted',
      reason: 'local-tracked',
    });
  });

  it('unadopt, adopt and adopt --disable keep a plugin-created file with the user’s notes out of `git status`', () => {
    for (const [i, run] of [
      () => cmdUnadopt([]),
      () => cmdAdopt([]),
      () => cmdAdopt(['--disable']),
    ].entries()) {
      const dir = join(home, 'work', `notes${i}`);
      initRepo(dir);
      silentAutoAdopt({ cwd: dir });
      appendFileSync(join(dir, LOCAL_MD), '\nmy notes\n');
      withCwd(dir, run);
      expect(readFileSync(join(dir, LOCAL_MD), 'utf8'), `verb ${i}`).toContain('my notes');
      expect(status(dir), `verb ${i}`).not.toMatch(/CLAUDE\.local\.md/);
    }
  });

  it('a CLAUDE.local.md the user had before goes back to how git saw it when the block is removed', () => {
    writeFileSync(join(app(), LOCAL_MD), 'mine\n');
    expect(status(app())).toBe('?? CLAUDE.local.md');
    silentAutoAdopt({ cwd: app() });
    expect(status(app())).toBe('');
    withCwd(app(), () => cmdUnadopt([]));
    expect(status(app())).toBe('?? CLAUDE.local.md');
    expect(readFileSync(join(app(), LOCAL_MD), 'utf8')).toBe('mine\n');
  });

  it('rolling back a useless exclude entry removes an exclude file it had to create', () => {
    rmSync(join(app(), '.git', 'info', 'exclude'));
    writeFileSync(join(app(), '.gitignore'), '!CLAUDE.local.md\n');
    git(app(), 'add', '.gitignore');
    commitAll(app(), 'negate');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ reason: 'local-exclude-failed' });
    expect(existsSync(join(app(), '.git', 'info', 'exclude'))).toBe(false);
  });

  it('a corrupt state file still reads as "created here": a deleted file stays deleted', () => {
    silentAutoAdopt({ cwd: app() });
    rmSync(join(app(), LOCAL_MD));
    writeFileSync(join(app(), '.git', 'claude-mem-lite-local-steering.json'), 'not json');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'inject', reason: 'local-removed' });
  });

  it('with CLAUDE_CONFIG_DIR, adopt --enable removes an opt-out left under ~/.claude', () => {
    const cfg = join(home, 'cfg');
    mkdirSync(cfg);
    legacyOptOut();
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      expect(silentAutoAdopt({ cwd: app() }).action).toBe('disabled');
      withCwd(app(), () => cmdAdopt(['--enable']));
      expect(silentAutoAdopt({ cwd: app() }).action).toBe('local');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('adopt --enable --all re-arms every known project', () => {
    const other = join(home, 'work', 'other');
    initRepo(other);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app()]: {}, [other]: {} } }));
    for (const d of [app(), other]) {
      silentAutoAdopt({ cwd: d });
      rmSync(join(d, LOCAL_MD));
      expect(silentAutoAdopt({ cwd: d }).action).toBe('inject');
    }
    withCwd(home, () => cmdAdopt(['--enable', '--all']));
    for (const d of [app(), other]) expect(silentAutoAdopt({ cwd: d }).action, d).toBe('local');
  });

  it('quiet-scope honours an opt-out left under ~/.claude when CLAUDE_CONFIG_DIR is set', () => {
    const cfg = join(home, 'cfg');
    mkdirSync(cfg);
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      expect(isAdoptedHere(app())).toBe(true);
      legacyOptOut();
      expect(isAdoptedHere(app())).toBe(false);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  // P2-2's other half: the quiet gate must agree with silentAutoAdopt, or a subdirectory session
  // of an opted-out repository gets neither the steering nor the verbose hook sections.
  it('quiet-scope: a root opt-out turns a subdirectory session verbose, unless the root CLAUDE.md carries the block', () => {
    const sub = join(app(), 'pkg');
    mkdirSync(sub);
    expect(isAdoptedHere(sub)).toBe(true);
    mkdirSync(memdirPath(app()), { recursive: true });
    writeFileSync(disableSentinelPath(memdirPath(app())), '{}');
    expect(isAdoptedHere(sub)).toBe(false);
    writeManaged(app(), { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    expect(silentAutoAdopt({ cwd: sub }).action).toBe('already-adopted');
    expect(isAdoptedHere(sub)).toBe(true);
  });

  // A repository at $HOME is never a steering root (silentAutoAdopt injects below it), so an
  // opt-out recorded for $HOME does not silence a project directory under it either.
  it('quiet-scope: a work tree at $HOME is not a root whose opt-out covers the directories below', () => {
    git(home, 'init', '-q');
    const proj = join(home, 'proj');
    mkdirSync(proj);
    mkdirSync(memdirPath(home), { recursive: true });
    writeFileSync(disableSentinelPath(memdirPath(home)), '{}');
    expect(silentAutoAdopt({ cwd: proj }).action).toBe('inject');
    expect(isAdoptedHere(proj)).toBe(true);
  });
});

// Claude Code (v2.1.277+) reads AGENTS.md as a project's instructions only while no CLAUDE.md,
// .claude/CLAUDE.md or CLAUDE.local.md exists in the session's directory or above it
// (code.claude.com/docs/en/memory#agents-md); `.claude/rules/` files do not count. The
// CLAUDE.local.md auto-adopt wrote into a repository set up for other coding agents therefore
// switched its AGENTS.md off from the second session on, unseen: reproduced 2026-10-06 on
// Claude Code 2.1.291 with a canary in AGENTS.md — read before, NONE after silentAutoAdopt,
// read again with a `.claude/rules/` file in its place. D#212: such a repository gets the block in
// .claude/rules/claude-mem-lite.md, which loads beside AGENTS.md as project instructions, in
// subagents too (probe 2026-10-06), instead of the injection 5dddb48 fell back to.
describe('AGENTS.md: auto-adopt does not switch it off', () => {
  const app = () => join(home, 'work', 'app');
  const block = () => buildClaudeMdBlock({ detailDocRef: '/data/plugin_claude_mem_lite.md' });
  const commitAll = (dir) => {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'agents');
  };
  const agentsMd = (dir, rel = 'AGENTS.md') => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), '# Instructions for coding agents\n');
  };
  const userSettings = (dir, instructionFiles, id = 'cc-plugin-agents-md@builtin') => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ pluginConfigs: { [id]: { options: { instructionFiles } } } }),
    );
  };
  beforeEach(() => initRepo(app()));

  it('a repository whose AGENTS.md is its instructions gets the block in .claude/rules, no CLAUDE.local.md', () => {
    agentsMd(app());
    commitAll(app());
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'local',
      written: 'created',
      file: RULES_MD,
    });
    expect(readFileSync(join(app(), RULES_MD), 'utf8')).toContain(HEADING);
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(excludeOf(app())).toMatch(/^\.claude\/rules\/claude-mem-lite\.md$/m);
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
    expect(status(app())).toBe('');
  });

  // Each case is seen by one look alone: the walk up from the session's directory (the first
  // three) or git's list of tracked files (the last).
  it.each([
    [
      'an untracked .claude/AGENTS.md at the root',
      (a) => agentsMd(a, join('.claude', 'AGENTS.md')),
      (a) => a,
    ],
    ['an AGENTS.md in a directory above the repository', (a) => agentsMd(dirname(a)), (a) => a],
    [
      'an untracked AGENTS.md where the session started',
      (a) => agentsMd(join(a, 'pkg')),
      (a) => join(a, 'pkg'),
    ],
    [
      'an AGENTS.md git tracks in a subdirectory, for a session at the root',
      (a) => {
        agentsMd(a, join('packages', 'api', 'AGENTS.md'));
        commitAll(a);
      },
      (a) => a,
    ],
  ])('%s counts', (_, arrange, cwdOf) => {
    arrange(app());
    const r = writeLocalSteering(app(), { slug: SLUG, version: V, block: block(), cwd: cwdOf(app()) });
    expect(r).toMatchObject({ action: 'created', file: RULES_MD });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('a SessionStart in a subdirectory looks from there: its untracked AGENTS.md counts', () => {
    agentsMd(join(app(), 'pkg'));
    expect(silentAutoAdopt({ cwd: join(app(), 'pkg') })).toMatchObject({ action: 'local', file: RULES_MD });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  // An untracked AGENTS.md in a subdirectory is seen only from a session started there. Once the
  // rules file is written it stays the channel: it switches nothing off, and going back to
  // CLAUDE.local.md from a root session would switch that AGENTS.md off again.
  it('the rules file is kept by a later session that sees no AGENTS.md', () => {
    agentsMd(join(app(), 'pkg'));
    silentAutoAdopt({ cwd: join(app(), 'pkg') });
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'local',
      written: 'unchanged',
      file: RULES_MD,
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  it('a tracked AGENTS.md deleted from the working tree is not read, so it does not count', () => {
    agentsMd(app(), join('packages', 'api', 'AGENTS.md'));
    commitAll(app());
    rmSync(join(app(), 'packages', 'api', 'AGENTS.md'));
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'local',
      written: 'created',
      file: LOCAL_MD,
    });
  });

  it('AGENTS.local.md, which Claude Code does not read, does not count', () => {
    agentsMd(app(), 'AGENTS.local.md');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'local',
      written: 'created',
      file: LOCAL_MD,
    });
  });

  it('a CLAUDE.local.md block written before AGENTS.md appeared moves to the rules file', () => {
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: LOCAL_MD });
    agentsMd(app());
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'local',
      written: 'created',
      file: RULES_MD,
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
    // The plugin moved it, not the user: nothing reads as a removal, and it stays where it is.
    rmSync(join(app(), 'AGENTS.md'));
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: RULES_MD });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  // CLAUDE_MEM_NO_TEMPLATE_REFRESH=1 keeps the user's hand-edited block. It cannot stay in
  // CLAUDE.local.md beside an AGENTS.md, so the text moves as it is.
  it('with template refresh frozen, the hand-edited block moves to the rules file unchanged', () => {
    writeLocalSteering(app(), { slug: SLUG, version: V, block: 'my edited guidance' });
    agentsMd(app());
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    try {
      expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: RULES_MD });
    } finally {
      delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    }
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(readLocalSteering(app(), SLUG).body).toBe('my edited guidance');
  });

  it.each([['CLAUDE.md'], [join('.claude', 'CLAUDE.md')]])(
    "the user's own %s at the root has switched AGENTS.md off already: CLAUDE.local.md is written",
    (rel) => {
      agentsMd(app());
      mkdirSync(dirname(join(app(), rel)), { recursive: true });
      writeFileSync(join(app(), rel), '# our conventions\n');
      expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
        action: 'local',
        written: 'created',
        file: LOCAL_MD,
      });
    },
  );

  // code.claude.com/docs/en/memory#choose-which-instruction-files-load: only the default value
  // lets a CLAUDE.local.md switch AGENTS.md off. Before v2.1.285 the entry's id was
  // `agents-md@builtin`, and later versions read either.
  it.each([
    ['claude-md-and-agents-md', 'cc-plugin-agents-md@builtin', LOCAL_MD],
    ['claude-md-and-agents-md', 'agents-md@builtin', LOCAL_MD],
    ['claude-md', 'cc-plugin-agents-md@builtin', LOCAL_MD],
    ['managed-only', 'cc-plugin-agents-md@builtin', LOCAL_MD],
    ['claude-md-or-agents-md', 'cc-plugin-agents-md@builtin', RULES_MD],
    ['a-value-from-a-later-version', 'cc-plugin-agents-md@builtin', RULES_MD],
  ])('instructionFiles=%s under %s in the user settings → %s', (value, id, file) => {
    agentsMd(app());
    userSettings(join(home, '.claude'), value, id);
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file });
  });

  it('the user settings are read from CLAUDE_CONFIG_DIR when it is set', () => {
    agentsMd(app());
    const cfg = join(home, 'cfg');
    userSettings(cfg, 'claude-md-and-agents-md');
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: LOCAL_MD });
  });

  it('settings that do not parse count as the default', () => {
    agentsMd(app());
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: RULES_MD });
  });
});

// D#212: every refusal of the rules file, and what the plugin does around it. Where it refuses, an
// AGENTS.md repository gets injection (reason `agents-md`, `detail` naming the refusal).
describe('D#212: the rules file and its refusals', () => {
  const app = () => join(home, 'work', 'app');
  const block = () => buildClaudeMdBlock({ detailDocRef: '/data/plugin_claude_mem_lite.md' });
  const write = () => writeLocalSteering(app(), { slug: SLUG, version: V, block: block() });
  const rulesPath = () => join(app(), RULES_MD);
  const commitAll = (dir) => {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c');
  };
  beforeEach(() => {
    initRepo(app());
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    commitAll(app());
  });

  it('`git add -A` in a repository whose .claude/ is tracked does not stage it', () => {
    mkdirSync(join(app(), '.claude'), { recursive: true });
    writeFileSync(join(app(), '.claude', 'settings.json'), '{}\n');
    commitAll(app());
    expect(write()).toMatchObject({ action: 'created', file: RULES_MD });
    git(app(), 'add', '-A');
    expect(status(app())).toBe('');
  });

  it('readLocalSteering reads the rules file, with its path', () => {
    write();
    const r = readLocalSteering(app(), SLUG);
    expect(r.body).toContain(HEADING);
    expect(r.path).toBe(rulesPath());
  });

  it('a tracked rules file is refused; one that carries the block is reported present', () => {
    mkdirSync(dirname(rulesPath()), { recursive: true });
    writeFileSync(rulesPath(), `<!-- ${SLUG}:begin ${V} -->\nteam copy\n<!-- ${SLUG}:end -->\n`);
    commitAll(app());
    expect(write()).toMatchObject({
      action: 'refused',
      reason: 'agents-md',
      detail: 'tracked',
      present: true,
    });
    expect(status(app())).toBe('');
  });

  it.each([
    ['the rules file', (o) => symlinkSync(join(o, 'x.md'), join(app(), RULES_MD))],
    ['.claude/rules', (o) => symlinkSync(o, join(app(), '.claude', 'rules'))],
    ['.claude', (o) => symlinkSync(o, join(app(), '.claude'))],
  ])('a symlink at %s is refused and nothing is written through it', (_, link) => {
    const other = join(home, 'shared-dotfiles');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.md'), 'theirs\n');
    mkdirSync(join(app(), '.claude'), { recursive: true });
    if (_ === '.claude') rmSync(join(app(), '.claude'), { recursive: true });
    if (_ === 'the rules file') mkdirSync(join(app(), '.claude', 'rules'), { recursive: true });
    link(other);
    expect(write()).toMatchObject({ action: 'refused', reason: 'agents-md', detail: 'symlink' });
    expect(readdirSync(other).sort()).toEqual(['x.md']);
    expect(readFileSync(join(other, 'x.md'), 'utf8')).toBe('theirs\n');
    // Removal does not go through the link either, and with nothing of ours behind it there is
    // nothing to report.
    expect(removeLocalSteering(app(), SLUG)).toEqual({ action: 'absent' });
    expect(readdirSync(other).sort()).toEqual(['x.md']);
  });

  // Another repository's .claude/ reached through a link can hold a block the plugin wrote there:
  // unadopt here must not take it out of that repository.
  it("removal does not reach through a linked .claude into another repository's rules file", () => {
    const other = join(home, 'work', 'other');
    initRepo(other);
    writeFileSync(join(other, 'AGENTS.md'), '# agents\n');
    writeLocalSteering(other, { slug: SLUG, version: V, block: block() });
    const before = readFileSync(join(other, RULES_MD), 'utf8');
    symlinkSync(join(other, '.claude'), join(app(), '.claude'));
    expect(removeLocalSteering(app(), SLUG)).toMatchObject({ action: 'skipped-symlink' });
    expect(readFileSync(join(other, RULES_MD), 'utf8')).toBe(before);
  });

  it('a file of that name the user wrote is left alone and not hidden from git', () => {
    mkdirSync(dirname(rulesPath()), { recursive: true });
    writeFileSync(rulesPath(), '# my own rule\n');
    expect(write()).toMatchObject({ action: 'refused', reason: 'agents-md', detail: 'foreign' });
    expect(readFileSync(rulesPath(), 'utf8')).toBe('# my own rule\n');
    expect(excludeOf(app())).not.toMatch(/claude-mem-lite\.md/);
  });

  // npm 11.19.0, `npm pack --dry-run`, 2026-10-06: which package roots ship
  // .claude/rules/claude-mem-lite.md. Without `files`, npm reads .npmignore, or .gitignore when
  // there is none; with `files`, a first segment of `.claude`, `**` or a wildcard can take it in.
  it.each([
    ['no files list and nothing ignoring it', 'refused', {}, null, null],
    ['.gitignore names .claude/', 'created', {}, null, '.claude/\n'],
    ['.npmignore present without it, .gitignore with it', 'refused', {}, 'dist\n', '.claude/\n'],
    ['.npmignore names /.claude/rules/', 'created', {}, '/.claude/rules/\n', null],
    ['.npmignore names the file', 'created', {}, '.claude/rules/claude-mem-lite.md\n', null],
    ['files: ["src"]', 'created', { files: ['src'] }, null, null],
    ['files: [".claude"]', 'refused', { files: ['.claude'] }, null, null],
    ['files: ["**/*.md"]', 'refused', { files: ['**/*.md'] }, null, null],
    ['files: ["*"]', 'refused', { files: ['*'] }, null, null],
    ['files: ["src/**/*.md"]', 'created', { files: ['src/**/*.md'] }, null, null],
    [
      '.gitignore names .claude/ and re-includes the file',
      'refused',
      {},
      null,
      '.claude/\n!.claude/rules/claude-mem-lite.md\n',
    ],
    ['private: true', 'created', { private: true }, null, null],
  ])('package root, %s → %s', (_, action, extra, npmignore, gitignore) => {
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', ...extra }));
    if (npmignore !== null) writeFileSync(join(app(), '.npmignore'), npmignore);
    if (gitignore !== null) writeFileSync(join(app(), '.gitignore'), gitignore);
    const r = write();
    expect(r.action).toBe(action);
    if (action === 'refused') expect(r).toMatchObject({ reason: 'agents-md', detail: 'npm-publishable' });
    expect(existsSync(rulesPath())).toBe(action === 'created');
  });

  it('a root that becomes a publishable package loses the rules block, and gets it back once private', () => {
    write();
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
    expect(write()).toMatchObject({ action: 'refused', detail: 'npm-publishable' });
    expect(existsSync(rulesPath())).toBe(false);
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', private: true }));
    expect(write()).toMatchObject({ action: 'created', file: RULES_MD });
  });

  it('a negated ignore rule makes the exclude entry useless: nothing written, exclude restored', () => {
    writeFileSync(join(app(), '.gitignore'), '!.claude/rules/claude-mem-lite.md\n');
    commitAll(app());
    const before = excludeOf(app());
    expect(write()).toMatchObject({ action: 'refused', reason: 'agents-md', detail: 'exclude-failed' });
    expect(existsSync(rulesPath())).toBe(false);
    expect(excludeOf(app())).toBe(before);
  });

  it('a rules file the user deleted is not written again until adopt --enable forgets it', () => {
    write();
    rmSync(rulesPath());
    expect(write()).toMatchObject({ action: 'refused', reason: 'agents-md', detail: 'removed' });
    expect(existsSync(rulesPath())).toBe(false);
    forgetLocalSteering(app());
    expect(write()).toMatchObject({ action: 'created', file: RULES_MD });
  });

  it('removal deletes the file, its exclude line and the directories it emptied, nothing more', () => {
    write();
    expect(removeLocalSteering(app(), SLUG)).toMatchObject({ action: 'removed', path: rulesPath() });
    expect(existsSync(join(app(), '.claude'))).toBe(false);
    expect(excludeOf(app())).not.toMatch(/claude-mem-lite\.md/);
    mkdirSync(join(app(), '.claude'), { recursive: true });
    writeFileSync(join(app(), '.claude', 'settings.json'), '{}\n');
    forgetLocalSteering(app());
    write();
    removeLocalSteering(app(), SLUG);
    expect(readdirSync(join(app(), '.claude'))).toEqual(['settings.json']);
  });

  it('notes the user added to the rules file survive removal and stay out of `git status`', () => {
    write();
    appendFileSync(rulesPath(), '\nmy notes\n');
    removeLocalSteering(app(), SLUG);
    expect(readFileSync(rulesPath(), 'utf8')).toContain('my notes');
    expect(status(app())).toBe('');
  });

  // The file name is the plugin's, so the file is too, whatever the state file says or whether
  // there is one.
  it('…also when the state file is gone', () => {
    write();
    appendFileSync(rulesPath(), '\nmy notes\n');
    forgetLocalSteering(app());
    removeLocalSteering(app(), SLUG);
    expect(readFileSync(rulesPath(), 'utf8')).toContain('my notes');
    expect(status(app())).toBe('');
  });

  // Moving the block reads `createdFile` from the state the CLAUDE.local.md write left, before the
  // rules write replaces it: the user's own file goes back to how git saw it.
  it("moving the block out of the user's own CLAUDE.local.md puts that file back in `git status`", () => {
    rmSync(join(app(), 'AGENTS.md'));
    commitAll(app());
    writeFileSync(join(app(), LOCAL_MD), 'mine\n');
    write();
    expect(status(app())).toBe('');
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    commitAll(app());
    expect(write()).toMatchObject({ action: 'created', file: RULES_MD });
    expect(readFileSync(join(app(), LOCAL_MD), 'utf8')).toBe('mine\n');
    expect(status(app())).toBe('?? CLAUDE.local.md');
  });

  // Refused, the rules file leaves the steering to injection; the CLAUDE.local.md block still has to
  // go (it switches AGENTS.md off), and the plugin taking it out is not the user's removal.
  it('when the rules file is refused, an earlier CLAUDE.local.md block comes out and is not remembered', () => {
    rmSync(join(app(), 'AGENTS.md'));
    commitAll(app());
    expect(write()).toMatchObject({ action: 'created', file: LOCAL_MD });
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
    expect(write()).toMatchObject({ action: 'refused', reason: 'agents-md', detail: 'npm-publishable' });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', private: true }));
    expect(write()).toMatchObject({ action: 'created', file: RULES_MD });
  });

  it('removing one worktree’s rules block keeps the shared exclude entry while another still has one', () => {
    write();
    const wt = join(home, 'work', 'wt');
    git(app(), 'worktree', 'add', '-q', wt);
    writeLocalSteering(wt, { slug: SLUG, version: V, block: block() });
    expect(existsSync(join(wt, RULES_MD))).toBe(true);
    removeLocalSteering(app(), SLUG);
    expect(excludeOf(app())).toMatch(/^\.claude\/rules\/claude-mem-lite\.md$/m);
    removeLocalSteering(wt, SLUG);
    expect(excludeOf(app())).not.toMatch(/claude-mem-lite\.md/);
  });

  it('with template refresh frozen, a missing exclude entry is restored', () => {
    write();
    writeFileSync(join(app(), '.git', 'info', 'exclude'), '');
    writeLocalSteering(app(), { slug: SLUG, version: V, block: 'other', frozen: true });
    expect(excludeOf(app())).toMatch(/^\.claude\/rules\/claude-mem-lite\.md$/m);
    expect(readLocalSteering(app(), SLUG).body).toContain(HEADING);
  });

  it('quiet-scope counts a rules block as adopted even with MEM_NO_AUTO_ADOPT=1', () => {
    write();
    process.env.MEM_NO_AUTO_ADOPT = '1';
    expect(isAdoptedHere(app())).toBe(true);
    rmSync(rulesPath());
    expect(isAdoptedHere(app())).toBe(false);
  });

  describe('the CLI verbs', () => {
    let cwdBefore;
    const captureLog = (fn) => {
      const lines = [];
      const orig = console.log;
      console.log = (m) => lines.push(String(m));
      try {
        fn();
      } finally {
        console.log = orig;
      }
      return lines.join('\n');
    };
    beforeEach(() => {
      cwdBefore = process.cwd();
      process.chdir(app());
      process.env.CLAUDE_PROJECT_DIR = app();
      silentAutoAdopt({ cwd: app() });
      expect(existsSync(rulesPath())).toBe(true);
    });
    afterEach(() => {
      process.chdir(cwdBefore);
      delete process.env.CLAUDE_PROJECT_DIR;
    });

    it('unadopt removes it and its exclude line, and says which file', () => {
      expect(captureLog(() => cmdUnadopt([]))).toContain(rulesPath());
      expect(existsSync(rulesPath())).toBe(false);
      expect(excludeOf(app())).not.toMatch(/claude-mem-lite\.md/);
    });

    it('adopt --disable removes it', () => {
      cmdAdopt(['--disable']);
      expect(existsSync(rulesPath())).toBe(false);
    });

    it('an explicit adopt moves the steering into CLAUDE.md, which imports AGENTS.md, and drops the rules copy', () => {
      cmdAdopt([]);
      expect(readBlock(app(), SLUG).body).not.toBeNull();
      expect(readFileSync(join(app(), 'CLAUDE.md'), 'utf8')).toMatch(/^<!-- .*-->\n@AGENTS\.md\n/);
      expect(existsSync(rulesPath())).toBe(false);
    });

    it('unadopt --all sweeps it', () => {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app()]: {} } }));
      expect(captureLog(() => cmdUnadopt(['--all']))).toContain(rulesPath());
      expect(existsSync(rulesPath())).toBe(false);
    });

    it('--dry-run and --status name the rules file', () => {
      expect(captureLog(() => cmdUnadopt(['--dry-run']))).toMatch(
        /would-remove the block in .*\.claude\/rules\/claude-mem-lite\.md/,
      );
      expect(captureLog(() => cmdAdopt(['--status']))).toMatch(
        /local: +✓ .*\.claude\/rules\/claude-mem-lite\.md/,
      );
      expect(existsSync(rulesPath())).toBe(true);
    });
  });
});

// `adopt --status` printed "✗ none" for every repository without the file, including one whose
// block the plugin will never write back (removed by the user or unadopt, lib/local-steering.mjs
// readState) and one where AGENTS.md keeps it out. Both now say why, and what changes it.
describe('adopt --status says why there is no CLAUDE.local.md', () => {
  const app = () => join(home, 'work', 'app');
  const statusOut = () => {
    const before = process.cwd();
    const lines = [];
    const orig = console.log;
    process.chdir(app());
    process.env.CLAUDE_PROJECT_DIR = app();
    console.log = (m) => lines.push(String(m));
    try {
      cmdAdopt(['--status']);
    } finally {
      console.log = orig;
      process.chdir(before);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    return lines.join('\n');
  };
  beforeEach(() => initRepo(app()));

  it('AGENTS.md: before any session, the next one writes the rules file', () => {
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    expect(statusOut()).toMatch(
      /local: +— none yet: the next session writes .*\.claude\/rules\/claude-mem-lite\.md.*AGENTS\.md/,
    );
  });

  it('AGENTS.md at a publishable package root keeps both files out, and says why', () => {
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
    silentAutoAdopt({ cwd: app() });
    expect(statusOut()).toMatch(
      /local: +✗ not written: .*AGENTS\.md.*npm publish would ship it.*claude-md-and-agents-md/,
    );
  });

  it('a removed block stays removed until adopt --enable', () => {
    silentAutoAdopt({ cwd: app() });
    rmSync(join(app(), LOCAL_MD));
    expect(statusOut()).toMatch(/local: +✗ removed.*adopt --enable/);
  });

  it('a repository where it was never written still reads "none"', () => {
    expect(statusOut()).toMatch(/local: +✗ none$/m);
  });
});
