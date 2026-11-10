// D#509(4) pre-ship review P2-1: Claude Code walks the directories above the session up to, but not
// including, the filesystem root (2.1.322: `for (d = cwd; d !== path.parse(d).root; d = dirname(d))`;
// a real run with a block in /CLAUDE.md loaded nothing from /). A block there must not stand in for
// the local copy or the injected text, or the session gets no steering at all. The root cannot be
// written from a test, so `fs` opens a real file in their place (a map of path -> stand-in); the same
// stand-in one level below the session's parent is the control that shows the map is read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, parse } from 'path';
import { mkdtempWithoutInstructionAncestors } from './test-helpers.mjs';

const fake = vi.hoisted(() => new Map());
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal();
  const to = (p) => (typeof p === 'string' && fake.has(p) ? fake.get(p) : p);
  const existsSync = (p, ...a) => real.existsSync(to(p), ...a);
  const openSync = (p, ...a) => real.openSync(to(p), ...a);
  const readFileSync = (p, ...a) => real.readFileSync(to(p), ...a);
  const mocked = { existsSync, openSync, readFileSync };
  return { ...real, ...mocked, default: { ...real, ...mocked } };
});

const { silentAutoAdopt } = await import('../adopt-cli.mjs');
const { LOCAL_MD } = await import('../lib/local-steering.mjs');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const initRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
};

describe('the filesystem root is not a directory Claude Code loads instructions from', () => {
  let home;
  let saved;
  let copy;
  beforeEach(() => {
    home = mkdtempWithoutInstructionAncestors('cml-fsroot-');
    saved = {
      HOME: process.env.HOME,
      MEM_NO_AUTO_ADOPT: process.env.MEM_NO_AUTO_ADOPT,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CLAUDE_MEM_NO_TEMPLATE_REFRESH: process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH,
    };
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.MEM_NO_AUTO_ADOPT;
    delete process.env.CLAUDE_MEM_NO_TEMPLATE_REFRESH;
    process.env.HOME = home;
    // The shipped local copy, as a session writes it: the stand-in for the files faked below.
    const first = join(home, 'first');
    initRepo(first);
    expect(silentAutoAdopt({ cwd: first }).action, 'premise: a repository gets its local copy').toBe('local');
    copy = join(first, LOCAL_MD);
    fake.clear();
  });
  afterEach(() => {
    fake.clear();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('a git repository keeps its local copy', () => {
    const app = join(home, 'work', 'app');
    initRepo(app);
    fake.set(join(home, 'work', LOCAL_MD), copy);
    expect(silentAutoAdopt({ cwd: app }), 'control: the same file above the repository counts').toMatchObject(
      {
        action: 'already-adopted',
        reason: 'above-root',
      },
    );
    fake.clear();
    fake.set(join(parse(home).root, LOCAL_MD), copy);
    expect(silentAutoAdopt({ cwd: app })).toMatchObject({ action: 'local', written: 'created' });
  });

  it('outside git the text is still injected', () => {
    const deep = join(home, 'notes', 'a');
    mkdirSync(deep, { recursive: true });
    fake.set(join(home, 'notes', LOCAL_MD), copy);
    expect(silentAutoAdopt({ cwd: deep }), 'control: the same file above the session counts').toMatchObject({
      action: 'already-adopted',
    });
    fake.clear();
    fake.set(join(parse(home).root, LOCAL_MD), copy);
    expect(silentAutoAdopt({ cwd: deep }).action).toBe('inject');
  });
});
