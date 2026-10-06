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
  chmodSync,
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
  excludeWouldFail,
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
    CLAUDE_MEM_RULES_STEERING: process.env.CLAUDE_MEM_RULES_STEERING,
  };
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.MEM_NO_AUTO_ADOPT;
  // The rules-file channel is opt-in (D#212 A/B, docs/audits/20261006-d212-ab.md). The suites below
  // test it switched on; 'the rules file is opt-in' at the end tests the default.
  process.env.CLAUDE_MEM_RULES_STEERING = '1';
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
        ...(process.env.CLAUDE_MEM_RULES_STEERING
          ? { CLAUDE_MEM_RULES_STEERING: process.env.CLAUDE_MEM_RULES_STEERING }
          : {}),
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
    expect(first.systemMessage ?? '').toContain(join(app, 'AGENTS.md'));
    expect(first.systemMessage ?? '').toMatch(/npm publish could ship it/);
    // CLAUDE.local.md is refused at a package root too: the setting would not give a file here.
    expect(first.systemMessage ?? '').not.toMatch(/claude-md-and-agents-md/);
    // The AGENTS.md is where the session started, so the CLAUDE.md /adopt writes imports it.
    expect(first.systemMessage ?? '').toMatch(/\/adopt .*imports AGENTS\.md/);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
    expect(existsSync(join(app, RULES_MD))).toBe(false);
    const second = sessionStart(app);
    expect(second.hookSpecificOutput?.additionalContext ?? '').toContain(HEADING);
    expect(second.systemMessage).toBeUndefined();
  });

  // Pre-tag defect review of D#212, P3-1: the session that moves the block out of CLAUDE.local.md
  // loaded that file at startup, so it gets no injected copy on top.
  it('the session that moves the block to the rules file injects nothing', () => {
    sessionStart(app);
    expect(existsSync(join(app, LOCAL_MD))).toBe(true);
    writeFileSync(join(app, 'AGENTS.md'), '# Instructions for coding agents\n');
    const moving = sessionStart(app);
    expect(existsSync(join(app, RULES_MD))).toBe(true);
    expect(existsSync(join(app, LOCAL_MD))).toBe(false);
    expect(moving.hookSpecificOutput?.additionalContext ?? '').not.toContain(HEADING);
  });

  // Pre-tag claims review P1-1: /adopt imports only the AGENTS.md beside the CLAUDE.md it writes; one
  // tracked in a subdirectory (or above the directory) would stop loading. Not offered there.
  it('an AGENTS.md only in a subdirectory: the note does not offer /adopt', () => {
    mkdirSync(join(app, 'packages', 'web'), { recursive: true });
    writeFileSync(join(app, 'packages', 'web', 'AGENTS.md'), '# web agents\n');
    git(app, 'add', '-A');
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'web');
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
    const out = sessionStart(app);
    expect(out.systemMessage ?? '').toContain(join(app, 'packages', 'web', 'AGENTS.md'));
    expect(out.systemMessage ?? '').not.toMatch(/\/adopt/);
  });

  // Pre-tag claims review P2-1: where CLAUDE.local.md could be written (the refusal is the rules
  // file's own), the setting is a way to a file; where it is refused too, it is not offered.
  it('a refusal of the rules file alone: the note offers the setting, which leads to CLAUDE.local.md', () => {
    writeFileSync(join(app, 'AGENTS.md'), '# Instructions for coding agents\n');
    mkdirSync(join(app, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(app, RULES_MD), '# a rule of mine\n');
    const out = sessionStart(app);
    expect(out.systemMessage ?? '').toMatch(/a file of that name, without the block, is already there/);
    expect(out.systemMessage ?? '').toMatch(/claude-md-and-agents-md .*CLAUDE\.local\.md/);
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
    // The session that takes it out loaded it at startup: no injected copy on top (delta D6).
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'already-adopted',
      reason: 'local-npm-publishable',
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-npm-publishable',
    });
    // The plugin took it out, not the user, so it is not remembered as a removal.
    pkg(app(), { name: 'lib', version: '1.0.0', private: true });
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', written: 'created' });
  });

  it('with template refresh frozen, a root that became a package loses the block too', () => {
    silentAutoAdopt({ cwd: app() });
    pkg(app(), { name: 'lib', version: '1.0.0' });
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    try {
      // Taken out in this session, which loaded it at startup (delta D6); injected from the next.
      expect(silentAutoAdopt({ cwd: app() }).action).toBe('already-adopted');
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
    // `present`: this session loaded CLAUDE.local.md at startup, so it gets no injected copy (delta D6).
    expect(write()).toMatchObject({
      action: 'refused',
      reason: 'agents-md',
      detail: 'npm-publishable',
      present: true,
    });
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

// Pre-tag defect review of D#212 (docs/audits/20261006-d212-pretag-defect.md).
describe('pre-tag defect review (D#212): the rules file', () => {
  const app = () => join(home, 'work', 'app');
  const block = () => buildClaudeMdBlock({ detailDocRef: '/data/plugin_claude_mem_lite.md' });
  const write = (cwd = app()) => writeLocalSteering(app(), { slug: SLUG, version: V, block: block(), cwd });
  const rulesPath = () => join(app(), RULES_MD);
  const commitAll = (dir, msg = 'c') => {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg);
  };
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
  // Commits only .gitignore: `git add -A` would commit a rules file git no longer ignores.
  const commitGitignore = () => {
    git(app(), 'add', '.gitignore');
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'ignore');
  };
  beforeEach(() => {
    initRepo(app());
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    commitAll(app());
  });

  // P1-2: a negation added after the file was written makes git see it again; the file came out of
  // the exclude's protection, so it must come out of the tree, not stay and be injected on top.
  it('an exclude entry that stops working takes the written rules file out, and nothing loads twice', () => {
    write();
    writeFileSync(join(app(), '.gitignore'), '.claude/*\n!.claude/rules/\n!.claude/rules/**\n');
    commitGitignore();
    expect(status(app())).toBe('?? .claude/');
    expect(write()).toMatchObject({ action: 'refused', reason: 'agents-md', detail: 'exclude-failed' });
    expect(existsSync(rulesPath())).toBe(false);
    expect(status(app())).toBe('');
  });

  // P1-3: npm does not honour git's "a parent excluded cannot be re-included", so a negation that can
  // match the file ships it. Only a literal negation naming none of its path parts is harmless.
  it.each([
    [
      '.npmignore: .claude, !**/claude-mem-lite.md',
      '.npmignore',
      '.claude\n!**/claude-mem-lite.md\n',
      'refused',
    ],
    ['.npmignore: .claude, !**/*.md', '.npmignore', '.claude\n!**/*.md\n', 'refused'],
    ['.npmignore: .claude/, !**', '.npmignore', '.claude/\n!**\n', 'refused'],
    ['.npmignore: the file, !*.md', '.npmignore', '.claude/rules/claude-mem-lite.md\n!*.md\n', 'refused'],
    [
      '.npmignore: .claude, !.Claude/rules/claude-mem-lite.md',
      '.npmignore',
      '.claude\n!.Claude/rules/claude-mem-lite.md\n',
      'refused',
    ],
    ['.gitignore: .claude/, !**/*.md', '.gitignore', '.claude/\n!**/*.md\n', 'refused'],
    ['.npmignore: .claude, !.env.example', '.npmignore', '.claude\n!.env.example\n', 'created'],
  ])('package root, %s → %s', (_, file, text, action) => {
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
    writeFileSync(join(app(), file), text);
    expect(write().action).toBe(action);
  });

  it('a backslash in a `files` entry counts as a pattern', () => {
    writeFileSync(
      join(app(), 'package.json'),
      JSON.stringify({ name: 'p', version: '1.0.0', files: ['\\.claude'] }),
    );
    expect(write()).toMatchObject({ action: 'refused', detail: 'npm-publishable' });
  });

  // P2-1: the ✓ line said "excluded from git" for a file git tracks.
  it('--status says a tracked rules file is tracked', () => {
    mkdirSync(dirname(rulesPath()), { recursive: true });
    writeFileSync(rulesPath(), `<!-- ${SLUG}:begin ${V} -->\nteam copy\n<!-- ${SLUG}:end -->\n`);
    git(app(), 'add', '-f', RULES_MD);
    commitAll(app());
    expect(withCwd(app(), () => captureLog(() => cmdAdopt(['--status'])))).toMatch(
      /local: +✓ .*claude-mem-lite\.md \(tracked by git/,
    );
  });

  // P2-2: adopt in a subdirectory writes a CLAUDE.md that steers that subtree only; taking the root's
  // file out left every root session without it, and called that the user's removal.
  it('adopt in a subdirectory leaves the root rules file, and the root keeps it', () => {
    write();
    const pkg = join(app(), 'pkg');
    mkdirSync(pkg);
    withCwd(pkg, () => captureLog(() => cmdAdopt([])));
    expect(existsSync(join(pkg, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(rulesPath())).toBe(true);
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: RULES_MD });
    // And a session in that subdirectory, whose CLAUDE.md carries the block, leaves it too.
    expect(silentAutoAdopt({ cwd: pkg }).action).toBe('already-adopted');
    expect(existsSync(rulesPath())).toBe(true);
  });

  // P2-3: the write side refuses a tracked file; the SessionStart sync must not delete one either.
  it('a session whose CLAUDE.md carries the block does not delete a tracked rules file', () => {
    mkdirSync(dirname(rulesPath()), { recursive: true });
    writeFileSync(rulesPath(), `<!-- ${SLUG}:begin ${V} -->\nteam copy\n<!-- ${SLUG}:end -->\n`);
    git(app(), 'add', '-f', RULES_MD);
    writeManaged(app(), { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    commitAll(app());
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('already-adopted');
    expect(existsSync(rulesPath())).toBe(true);
    // (CLAUDE.md gains its AGENTS.md import here; the tracked rules file is not deleted.)
    expect(status(app())).not.toMatch(/claude-mem-lite\.md/);
  });

  // P2-4: written while the user's .gitignore covered .claude/, the file had no exclude entry of its
  // own, and showed up in `git status` once the user narrowed that rule.
  it('the rules file gets its own exclude entry even where .gitignore covers it', () => {
    writeFileSync(join(app(), '.gitignore'), '.claude/\n');
    commitGitignore();
    write();
    writeFileSync(join(app(), '.gitignore'), '.claude/settings.local.json\n');
    commitGitignore();
    expect(status(app())).toBe('');
  });

  // P3-1: the session that moves the block from CLAUDE.local.md loaded that file at startup already.
  it('moving the block is reported as a move, so the session that did it is not injected', () => {
    rmSync(join(app(), 'AGENTS.md'));
    commitAll(app());
    write();
    writeFileSync(join(app(), 'AGENTS.md'), '# agents\n');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'local',
      written: 'created',
      moved: true,
    });
  });

  // P3-6: an info/exclude saved with CRLF line endings kept our two lines on removal.
  it('removal finds its exclude lines in a CRLF info/exclude', () => {
    write();
    const ex = join(app(), '.git', 'info', 'exclude');
    writeFileSync(ex, readFileSync(ex, 'utf8').replace(/\r?\n/g, '\r\n'));
    removeLocalSteering(app(), SLUG);
    expect(readFileSync(ex, 'utf8')).not.toMatch(/claude-mem-lite/);
  });

  // P3-7: a failed write left the exclude entry behind, and every later session failed the same way.
  it('a write that fails takes its exclude entry back', () => {
    writeFileSync(join(app(), '.claude'), 'a file, not a directory\n');
    const before = excludeOf(app());
    expect(write()).toMatchObject({ action: 'refused', detail: 'write-failed' });
    expect(excludeOf(app())).toBe(before);
  });

  // P3-8: an unreadable rules path threw out of the sync, and the session got no guidance at all.
  it('a directory where the rules file goes is refused, and the steering is injected', () => {
    mkdirSync(rulesPath(), { recursive: true });
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ ok: true, action: 'inject', detail: 'foreign' });
    // Removal and the quiet gate read the same path; neither may throw on it.
    expect(removeLocalSteering(app(), SLUG)).toEqual({ action: 'absent' });
    expect(isAdoptedHere(app())).toBe(true);
  });
});

// Pre-tag delta review of the D#212 repairs (docs/audits/20261006-d212-pretag-delta.md).
describe('pre-tag delta review (D#212 repairs)', () => {
  const app = () => join(home, 'work', 'app');
  const block = () => buildClaudeMdBlock({ detailDocRef: '/data/plugin_claude_mem_lite.md' });
  const write = () => writeLocalSteering(app(), { slug: SLUG, version: V, block: block() });
  const rulesPath = () => join(app(), RULES_MD);
  const commitOnly = (rel) => {
    git(app(), 'add', rel);
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', rel);
  };
  const statusLine = (dir) => {
    const before = process.cwd();
    const lines = [];
    const orig = console.log;
    process.chdir(dir);
    process.env.CLAUDE_PROJECT_DIR = dir;
    console.log = (m) => lines.push(String(m));
    try {
      cmdAdopt(['--status']);
    } finally {
      console.log = orig;
      process.chdir(before);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    return lines.find((l) => l.trimStart().startsWith('local:')) ?? '';
  };
  const agents = () => {
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    commitOnly('AGENTS.md');
  };
  beforeEach(() => initRepo(app()));

  // D1: git names the root by its real path; a session or adopt reaching it through a symlink is
  // still at the root, and the local copy still goes when CLAUDE.md takes over.
  it('adopt at the root reached through a symlink still removes the local copy', () => {
    silentAutoAdopt({ cwd: app() });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(true);
    const link = join(home, 'link');
    symlinkSync(join(home, 'work'), link);
    const viaLink = join(link, 'app');
    const before = process.cwd();
    process.chdir(viaLink);
    process.env.CLAUDE_PROJECT_DIR = viaLink;
    const orig = console.log;
    console.log = () => {};
    try {
      cmdAdopt([]);
    } finally {
      console.log = orig;
      process.chdir(before);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  // D3: the status line and the notes did not foresee an exclude entry that cannot work.
  it('after a negation took the rules file out, --status says it cannot be written, not "next session"', () => {
    agents();
    write();
    writeFileSync(join(app(), '.gitignore'), '!.claude/rules/claude-mem-lite.md\n');
    commitOnly('.gitignore');
    silentAutoAdopt({ cwd: app() });
    expect(existsSync(rulesPath())).toBe(false);
    expect(statusLine(app())).toMatch(/✗ not written: .*git would not ignore it/);
  });

  it('where CLAUDE.local.md could not be kept out of git either, the setting is not offered', () => {
    agents();
    writeFileSync(join(app(), '.gitignore'), '/build\n!*.md\n');
    commitOnly('.gitignore');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      detail: 'exclude-failed',
      settingGivesFile: false,
    });
  });

  it('a repository without .git/info gets its exclude entry all the same', () => {
    agents();
    rmSync(join(app(), '.git', 'info'), { recursive: true, force: true });
    expect(write()).toMatchObject({ action: 'created', file: RULES_MD });
    expect(status(app())).toBe('');
  });

  // D4: npm reads nested ignore files and extglob negations.
  it.each([
    [
      '.claude/.npmignore re-includes rules',
      () => {
        writeFileSync(join(app(), '.gitignore'), '.claude/rules\n');
        mkdirSync(join(app(), '.claude'), { recursive: true });
        writeFileSync(join(app(), '.claude', '.npmignore'), '!rules\n');
      },
    ],
    ['an extglob negation', () => writeFileSync(join(app(), '.gitignore'), '.claude\n!@(.claude)\n')],
  ])('package root, %s → refused', (_, arrange) => {
    agents();
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
    arrange();
    expect(write()).toMatchObject({ action: 'refused', detail: 'npm-publishable' });
  });

  // D5: a file that cannot be edited is a failure, not "nothing there".
  it('removal in a read-only directory reports a failure', () => {
    write();
    chmodSync(app(), 0o555);
    try {
      expect(removeLocalSteering(app(), SLUG).action).toBe('failed');
    } finally {
      chmodSync(app(), 0o755);
    }
    expect(readFileSync(join(app(), LOCAL_MD), 'utf8')).toContain(HEADING);
  });

  // D6: the session that takes a loaded file out has it in context already.
  it('the session that takes the rules file out is not injected (it loaded the file)', () => {
    agents();
    write();
    writeFileSync(join(app(), '.gitignore'), '!.claude/rules/claude-mem-lite.md\n');
    commitOnly('.gitignore');
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('already-adopted');
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('inject');
  });

  it('the session that takes CLAUDE.local.md out of a new package root is not injected either', () => {
    silentAutoAdopt({ cwd: app() });
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('already-adopted');
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(silentAutoAdopt({ cwd: app() }).action).toBe('inject');
  });

  // D7: a failed write puts info/exclude back byte for byte.
  it.each([
    ['ends without a newline', 'no-newline-at-end'],
    ['did not exist', null],
  ])('a failed write restores an info/exclude that %s', (_, before) => {
    agents();
    const ex = join(app(), '.git', 'info', 'exclude');
    if (before === null) rmSync(ex, { force: true });
    else writeFileSync(ex, before);
    writeFileSync(join(app(), '.claude'), 'a file\n');
    expect(write()).toMatchObject({ action: 'refused', detail: 'write-failed' });
    if (before === null) expect(existsSync(ex)).toBe(false);
    else expect(readFileSync(ex, 'utf8')).toBe(before);
  });

  // D9: a CLAUDE.local.md or CLAUDE.md that is a directory left the session with no guidance.
  it('a directory named CLAUDE.local.md: the steering is injected, and info/exclude is left alone', () => {
    mkdirSync(join(app(), LOCAL_MD));
    const before = excludeOf(app());
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ ok: true, action: 'inject' });
    expect(excludeOf(app())).toBe(before);
  });

  it('a directory named CLAUDE.md: the sync still delivers the steering', () => {
    mkdirSync(join(app(), 'CLAUDE.md'));
    const r = silentAutoAdopt({ cwd: app() });
    expect(r.ok).toBe(true);
    expect(['inject', 'local']).toContain(r.action);
  });

  // D11: status lines that did not match the next session.
  it('outside git, a CLAUDE.md that carries the block: --status says so', () => {
    const plain = join(home, 'work', 'plain');
    mkdirSync(plain, { recursive: true });
    writeManaged(plain, { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    expect(statusLine(plain)).toMatch(/— none: CLAUDE\.md carries the block/);
  });

  it('a local copy beside a CLAUDE.md that carries the block: --status says it goes', () => {
    silentAutoAdopt({ cwd: app() });
    writeManaged(app(), { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    expect(statusLine(app())).toMatch(/CLAUDE\.md carries the block.*removed at the next session start/);
  });

  it('a rules file behind a linked .claude: --status says it is behind a link', () => {
    const other = join(home, 'work', 'other');
    initRepo(other);
    writeFileSync(join(other, 'AGENTS.md'), '# agents\n');
    writeLocalSteering(other, { slug: SLUG, version: V, block: block() });
    symlinkSync(join(other, '.claude'), join(app(), '.claude'));
    expect(statusLine(app())).toMatch(/✓ .*claude-mem-lite\.md \(behind a symbolic link/);
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
    const out = statusOut();
    expect(out).toMatch(/local: +✗ not written: .*AGENTS\.md.*npm publish could ship it/);
    // CLAUDE.local.md is refused at a package root too, so the setting is not offered; the
    // AGENTS.md is at the root, so the CLAUDE.md `adopt` writes imports it.
    expect(out).not.toMatch(/claude-md-and-agents-md/);
    expect(out).toMatch(/run `claude-mem-lite adopt`, whose CLAUDE\.md imports AGENTS\.md/);
  });

  it('a removed block stays removed until adopt --enable', () => {
    silentAutoAdopt({ cwd: app() });
    rmSync(join(app(), LOCAL_MD));
    expect(statusOut()).toMatch(/local: +✗ removed.*adopt --enable/);
  });

  it('a repository where it was never written says what the next session writes', () => {
    expect(statusOut()).toMatch(/local: +— none yet: the next session writes .*CLAUDE\.local\.md/);
  });

  // Pre-tag claims review P2-2: four states the line described wrongly.
  it('after an explicit adopt it says CLAUDE.md carries the block', () => {
    silentAutoAdopt({ cwd: app() });
    process.env.CLAUDE_PROJECT_DIR = app();
    const before = process.cwd();
    process.chdir(app());
    try {
      cmdAdopt([]);
    } finally {
      process.chdir(before);
      delete process.env.CLAUDE_PROJECT_DIR;
    }
    expect(statusOut()).toMatch(/local: +— none: CLAUDE\.md carries the block/);
  });

  it('with auto-adopt off for the project it says so, not "removed" or "none yet"', () => {
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    mkdirSync(memdirPath(app()), { recursive: true });
    writeFileSync(disableSentinelPath(memdirPath(app())), '{}');
    expect(statusOut()).toMatch(/local: +— none: auto-adopt is off for this project/);
  });

  it('a tracked CLAUDE.local.md beside an AGENTS.md: not written, and why', () => {
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    writeFileSync(join(app(), LOCAL_MD), 'team notes\n');
    git(app(), 'add', '-A');
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'local');
    expect(statusOut()).toMatch(/local: +✗ not written: .*CLAUDE\.local\.md is tracked by git/);
  });

  it('"removed" says --enable lets the next session write it again, not that --enable writes it', () => {
    silentAutoAdopt({ cwd: app() });
    rmSync(join(app(), LOCAL_MD));
    expect(statusOut()).toMatch(
      /✗ removed: .*after `claude-mem-lite adopt --enable` the next session may write it again/,
    );
  });
});

// Pre-tag round-3 review (docs/audits/20261006-d212-pretag-round3.md).
describe('pre-tag round-3 review (D#212)', () => {
  const app = () => join(home, 'work', 'app');
  const rulesPath = () => join(app(), RULES_MD);
  const excludeFile = () => join(app(), '.git', 'info', 'exclude');
  const commitOnly = (dir, rel) => {
    git(dir, 'add', rel);
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', rel);
  };
  const agents = () => {
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    commitOnly(app(), 'AGENTS.md');
  };
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
  const statusLine = (dir) =>
    captureLog(() => withCwd(dir, () => cmdAdopt(['--status'])))
      .split('\n')
      .find((l) => l.trimStart().startsWith('local:')) ?? '';
  let exitBefore;
  beforeEach(() => {
    initRepo(app());
    exitBefore = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = exitBefore;
    delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
  });

  // R3-1: the CLAUDE.local.md side of P1-2. A `.gitignore` negation added after the file was
  // written left it in `git status`, loading beside an injected copy, while --status said it was
  // excluded.
  it('a CLAUDE.local.md that git sees again is taken out, and that session gets no injected copy', () => {
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', written: 'created' });
    writeFileSync(join(app(), '.gitignore'), '!CLAUDE.local.md\n');
    commitOnly(app(), '.gitignore');
    expect(statusLine(app())).not.toMatch(/excluded from git/);
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'already-adopted',
      reason: 'local-exclude-failed',
    });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(status(app())).toBe('');
    expect(excludeOf(app())).not.toMatch(/^CLAUDE\.local\.md$/m);
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-exclude-failed',
    });
  });

  it('the same with the template frozen', () => {
    silentAutoAdopt({ cwd: app() });
    writeFileSync(join(app(), '.gitignore'), '!CLAUDE.local.md\n');
    commitOnly(app(), '.gitignore');
    process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH = '1';
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'already-adopted' });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
  });

  // R3-9: the CLAUDE.local.md side of the rules file's snapshot restore (delta D7).
  it('a CLAUDE.local.md that cannot be written leaves info/exclude byte for byte', () => {
    writeFileSync(excludeFile(), 'no-newline');
    chmodSync(app(), 0o555);
    try {
      expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
        action: 'inject',
        reason: 'local-write-failed',
      });
    } finally {
      chmodSync(app(), 0o755);
    }
    expect(readFileSync(excludeFile(), 'utf8')).toBe('no-newline');
  });

  // R3-8: info/exclude went through UTF-8, so a Latin-1 pattern came back as U+FFFD and stopped
  // matching — the user's excluded file showed up in `git status`.
  it('a Latin-1 pattern in info/exclude survives the entry being added and removed', () => {
    const bytes = Buffer.from('caf\xe9.log\n', 'latin1');
    writeFileSync(excludeFile(), bytes);
    silentAutoAdopt({ cwd: app() });
    withCwd(app(), () => captureLog(() => cmdUnadopt([])));
    expect(readFileSync(excludeFile()).equals(bytes)).toBe(true);
  });

  it('and survives an entry that did not take, put back as it was', () => {
    const bytes = Buffer.from('caf\xe9.log\n', 'latin1');
    writeFileSync(excludeFile(), bytes);
    writeFileSync(join(app(), '.gitignore'), '!CLAUDE.local.md\n');
    commitOnly(app(), '.gitignore');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-exclude-failed',
    });
    expect(readFileSync(excludeFile()).equals(bytes)).toBe(true);
  });

  it('and survives a rules file that could not be written', () => {
    agents();
    const bytes = Buffer.from('caf\xe9.log\n', 'latin1');
    writeFileSync(excludeFile(), bytes);
    writeFileSync(join(app(), '.claude'), 'not a directory\n');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'inject', detail: 'write-failed' });
    expect(readFileSync(excludeFile()).equals(bytes)).toBe(true);
  });

  // R3-3: a directory named CLAUDE.local.md made the session inject on top of the rules file it
  // had loaded.
  it('a directory named CLAUDE.local.md does not stop the rules file being the channel', () => {
    agents();
    silentAutoAdopt({ cwd: app() });
    expect(existsSync(rulesPath())).toBe(true);
    mkdirSync(join(app(), LOCAL_MD));
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: RULES_MD });
  });

  // The same shape: a CLAUDE.local.md the team commits later (without the block) was refused as
  // tracked, and the session injected on top of the rules file it had loaded.
  it('a tracked CLAUDE.local.md added later does not stop the rules file being the channel', () => {
    agents();
    silentAutoAdopt({ cwd: app() });
    writeFileSync(join(app(), LOCAL_MD), 'team notes\n');
    commitOnly(app(), LOCAL_MD);
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: RULES_MD });
    expect(readFileSync(join(app(), LOCAL_MD), 'utf8')).toBe('team notes\n');
    expect(statusLine(app())).toMatch(
      /✓ .*\.claude\/rules\/claude-mem-lite\.md \(auto-written, excluded from git\)/,
    );
  });

  it('with auto-adopt off, --status says git sees a copy a .gitignore rule let through', () => {
    silentAutoAdopt({ cwd: app() });
    writeFileSync(join(app(), '.gitignore'), '!CLAUDE.local.md\n');
    commitOnly(app(), '.gitignore');
    process.env.MEM_NO_AUTO_ADOPT = '1';
    expect(statusLine(app())).toMatch(/⚠ .*CLAUDE\.local\.md \(auto-written, but git sees it/);
  });

  // R3-10: a rules file that cannot be read still holds the block; "absent" ended the search.
  it('unadopt reports an unreadable rules file as a failure, not as nothing to remove', () => {
    agents();
    silentAutoAdopt({ cwd: app() });
    chmodSync(rulesPath(), 0o000);
    try {
      expect(removeLocalSteering(app(), SLUG).action).toBe('failed');
    } finally {
      chmodSync(rulesPath(), 0o644);
    }
    expect(readFileSync(rulesPath(), 'utf8')).toContain('claude-mem-lite:begin');
  });

  // R3-4: the `failed` removal was handled by single-project unadopt only.
  describe('a local copy that cannot be removed', () => {
    const lock = () => chmodSync(join(app(), '.claude', 'rules'), 0o555);
    const unlock = () => chmodSync(join(app(), '.claude', 'rules'), 0o755);
    beforeEach(() => {
      agents();
      silentAutoAdopt({ cwd: app() });
      lock();
    });
    afterEach(unlock);

    it('adopt says it could not remove it, and exits 1', () => {
      const out = captureLog(() => withCwd(app(), () => cmdAdopt([])));
      expect(out).not.toMatch(/\+removed the block/);
      expect(out).toMatch(/could not edit .*claude-mem-lite\.md/);
      expect(process.exitCode).toBe(1);
    });

    it('--status does not promise the next session removes it', () => {
      captureLog(() => withCwd(app(), () => cmdAdopt([])));
      process.exitCode = exitBefore;
      expect(statusLine(app())).not.toMatch(/removed at the next session start/);
    });

    it('unadopt --all does not count it as removed, and exits 1', () => {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [app()]: {} } }));
      const out = captureLog(() => withCwd(app(), () => cmdUnadopt(['--all'])));
      expect(out).toMatch(/→ failed/);
      expect(out).toMatch(/and 0 local-file block\(s\)/);
      expect(out).toMatch(/1 could not be removed/);
      expect(process.exitCode).toBe(1);
    });

    it('adopt --disable exits 1', () => {
      const out = captureLog(() => withCwd(app(), () => cmdAdopt(['--disable'])));
      expect(out).toMatch(/→ failed/);
      expect(process.exitCode).toBe(1);
    });
  });

  // R3-5: core.excludesFile named `.gitignore` sits below info/exclude; its negation does not win.
  it('a negation in a global excludes file named .gitignore does not read as "would fail"', () => {
    const global = join(home, '.gitignore');
    writeFileSync(global, '!CLAUDE.local.md\n');
    git(app(), 'config', 'core.excludesFile', global);
    expect(excludeWouldFail(app(), LOCAL_MD)).toBe(false);
    expect(statusLine(app())).toMatch(/— none yet: the next session writes .*CLAUDE\.local\.md/);
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', written: 'created' });
  });

  // R3-6: the "CLAUDE.md first" status branch hid a local copy that still loads.
  it('from a subdirectory with its own CLAUDE.md, --status says the root copy still loads', () => {
    silentAutoAdopt({ cwd: app() });
    const sub = join(app(), 'sub');
    mkdirSync(sub);
    captureLog(() => withCwd(sub, () => cmdAdopt([])));
    expect(existsSync(join(app(), LOCAL_MD))).toBe(true);
    expect(statusLine(sub)).toMatch(/CLAUDE\.local\.md.*also/);
  });

  it('with MEM_NO_AUTO_ADOPT=1 it does not promise the next session removes the local copy', () => {
    silentAutoAdopt({ cwd: app() });
    writeManaged(app(), {
      slug: SLUG,
      version: V,
      block: buildClaudeMdBlock(),
      doc: getDetailDoc(),
    });
    process.env.MEM_NO_AUTO_ADOPT = '1';
    expect(statusLine(app())).not.toMatch(/removed at the next session start/);
    expect(statusLine(app())).toMatch(/CLAUDE\.local\.md.*also/);
  });

  it('beside a CLAUDE.md block, a tracked local copy is not promised away (the sync keeps it)', () => {
    silentAutoAdopt({ cwd: app() });
    git(app(), 'add', '-f', LOCAL_MD);
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'local');
    writeManaged(app(), { slug: SLUG, version: V, block: buildClaudeMdBlock(), doc: getDetailDoc() });
    const line = statusLine(app());
    expect(line).not.toMatch(/removed at the next session start/);
    expect(line).toMatch(/CLAUDE\.local\.md also does \(tracked by git/);
  });

  // R3-13: a ✓ for a file the next session takes out or moves.
  it('--status says the next session takes the copy out once the root is a package npm would ship', () => {
    silentAutoAdopt({ cwd: app() });
    writeFileSync(join(app(), 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
    expect(statusLine(app())).toMatch(/npm publish.*the next session removes it/);
  });

  it('--status says the next session moves the copy once an AGENTS.md is tracked', () => {
    silentAutoAdopt({ cwd: app() });
    agents();
    expect(statusLine(app())).toMatch(/next session moves it to .*\.claude\/rules\/claude-mem-lite\.md/);
  });

  it('outside git with auto-adopt off, --status does not say the steering is injected', () => {
    const plain = join(home, 'plain');
    mkdirSync(plain);
    process.env.MEM_NO_AUTO_ADOPT = '1';
    expect(statusLine(plain)).not.toMatch(/injected/);
  });

  // R3-7: a directory or unreadable file crashed --status, --dry-run and the --all sweep.
  it('--status names a CLAUDE.local.md that is a directory instead of crashing', () => {
    mkdirSync(join(app(), LOCAL_MD));
    expect(statusLine(app())).toMatch(/✗ not written: CLAUDE\.local\.md is a directory or cannot be read/);
  });

  it('--status survives a CLAUDE.md that is a directory, here and in a known project', () => {
    mkdirSync(join(app(), 'CLAUDE.md'));
    const other = join(home, 'work', 'other');
    mkdirSync(join(other, 'CLAUDE.md'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [other]: {} } }));
    const out = captureLog(() => withCwd(app(), () => cmdAdopt(['--status'])));
    expect(out).toMatch(/CLAUDE\.md: +✗ cannot be read/);
    expect(out).toMatch(/known projects .*1 scanned, 0 with/);
  });

  it('unadopt --dry-run survives a CLAUDE.local.md and a CLAUDE.md that are directories', () => {
    mkdirSync(join(app(), LOCAL_MD));
    mkdirSync(join(app(), 'CLAUDE.md'));
    expect(captureLog(() => withCwd(app(), () => cmdUnadopt(['--dry-run'])))).toMatch(
      /CLAUDE\.md cannot be read/,
    );
  });

  it('unadopt --all goes on past a project it cannot read', () => {
    const broken = join(home, 'work', 'broken');
    initRepo(broken);
    mkdirSync(join(broken, LOCAL_MD));
    mkdirSync(join(broken, 'CLAUDE.md'));
    silentAutoAdopt({ cwd: app() });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [broken]: {}, [app()]: {} } }));
    const out = captureLog(() => withCwd(app(), () => cmdUnadopt(['--all'])));
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(out).toMatch(/broken → error/);
    expect(process.exitCode).toBe(1);
  });

  // R3-15: at a $HOME that git tracks AGENTS.md in, the warning was printed twice.
  it('adopt at a $HOME whose git tracks AGENTS.md names it once', () => {
    initRepo(home);
    writeFileSync(join(home, 'AGENTS.md'), '# home\n');
    commitOnly(home, 'AGENTS.md');
    const out = captureLog(() => withCwd(home, () => cmdAdopt([])));
    expect(out.match(/AGENTS\.md stops loading/g)).toHaveLength(1);
  });
});

// D#212 A/B (docs/audits/20261006-d212-ab.md): the rules file did not beat injection by the
// pre-registered bar (subagent sessions with a proactive record 1/12 vs 0/12, p=1.00), so beside an
// AGENTS.md the default is injection, as before D#212, and the rules file is written only with
// CLAUDE_MEM_RULES_STEERING=1.
describe('the rules file is opt-in', () => {
  const app = () => join(home, 'work', 'app');
  const rulesPath = () => join(app(), RULES_MD);
  const agents = () => {
    writeFileSync(join(app(), 'AGENTS.md'), '# Instructions for coding agents\n');
    git(app(), 'add', 'AGENTS.md');
    git(app(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'agents');
  };
  const statusLine = () => {
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
    return lines.find((l) => l.trimStart().startsWith('local:')) ?? '';
  };
  beforeEach(() => {
    initRepo(app());
    delete process.env.CLAUDE_MEM_RULES_STEERING;
  });

  it('beside an AGENTS.md the steering is injected and no file is written', () => {
    agents();
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'inject',
      reason: 'local-agents-md',
      detail: 'off',
    });
    expect(existsSync(rulesPath())).toBe(false);
    expect(existsSync(join(app(), '.claude'))).toBe(false);
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(excludeOf(app())).not.toMatch(/claude-mem-lite\.md/);
  });

  it('a CLAUDE.local.md block written before the AGENTS.md comes out, and that session gets no copy', () => {
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: LOCAL_MD });
    agents();
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'already-adopted' });
    expect(existsSync(join(app(), LOCAL_MD))).toBe(false);
    expect(existsSync(rulesPath())).toBe(false);
    expect(status(app())).toBe('');
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'inject', detail: 'off' });
  });

  it('without an AGENTS.md, CLAUDE.local.md is written as before', () => {
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({
      action: 'local',
      written: 'created',
      file: LOCAL_MD,
    });
  });

  it('a rules file written while it was on stays the channel', () => {
    agents();
    process.env.CLAUDE_MEM_RULES_STEERING = '1';
    silentAutoAdopt({ cwd: app() });
    delete process.env.CLAUDE_MEM_RULES_STEERING;
    expect(silentAutoAdopt({ cwd: app() })).toMatchObject({ action: 'local', file: RULES_MD });
  });

  it('--status says how to get the rules file', () => {
    agents();
    const line = statusLine();
    expect(line).toMatch(
      /✗ not written: .*AGENTS\.md.*claude-mem-lite\.md is written only with CLAUDE_MEM_RULES_STEERING=1/,
    );
    expect(line).not.toMatch(/cannot be written here/);
  });

  it('--status says the next session takes out a CLAUDE.local.md an AGENTS.md now stops', () => {
    silentAutoAdopt({ cwd: app() });
    agents();
    expect(statusLine()).toMatch(
      /⚠ .*CLAUDE\.local\.md \(auto-written, but .*is written only with CLAUDE_MEM_RULES_STEERING=1: the next session removes it/,
    );
  });

  it('the one-time note says the guidance is injected and how to get the rules file', () => {
    agents();
    const r = spawnSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
      cwd: app(),
      input: JSON.stringify({ session_id: 'optin-e2e', source: 'startup', cwd: app() }),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|MEM_)/.test(k))),
        HOME: home,
        CLAUDE_MEM_DIR: join(home, 'data'),
        CLAUDE_PROJECT_DIR: app(),
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain(HEADING);
    expect(out.systemMessage ?? '').toMatch(/injected at session start/);
    expect(out.systemMessage ?? '').toMatch(/CLAUDE_MEM_RULES_STEERING=1/);
    expect(out.systemMessage ?? '').not.toMatch(/cannot be written here/);
    expect(existsSync(rulesPath())).toBe(false);
  });
});
