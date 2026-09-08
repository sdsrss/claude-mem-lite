// v6.3.0 shipped a detector for the SYMPTOM — a database newer than the code that must open
// it. This covers the near cause: Claude Code updates a git-source marketplace by pulling
// its local clone, a dirty working tree blocks that pull, and the plugin then stops updating
// with nothing saying so. On the machine that produced the v6.3.0 report the clone sat 22
// commits behind while every check was green.
//
// The clone gets dirty on its own. With a DIRECTORY-source marketplace `${CLAUDE_PLUGIN_ROOT}`
// resolves inside it, and scripts/launch.mjs runs `npm install` there whenever
// node_modules/better-sqlite3 is absent — i.e. after every version materialization. The dirt
// that matters is the TRACKED file that install rewrites, package-lock.json; node_modules
// itself is gitignored in this repo's clone and does not block a fast-forward.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { marketplaceCloneHealth } from '../install.mjs';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

function makeClone({ dirty = false, nodeModules = false, gitignore = false, lockfile = false } = {}) {
  const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-mp-clone-')));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, '.claude-plugin'), 'x');
  // The real clone carries this repo's own .gitignore. A fixture without it is a shape that
  // cannot occur, and building one is how the first cut of this check tested a dead branch.
  if (gitignore) writeFileSync(join(dir, '.gitignore'), '/node_modules\n');
  if (lockfile) writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  if (nodeModules) {
    mkdirSync(join(dir, 'node_modules', 'better-sqlite3'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'better-sqlite3', 'index.js'), '// stub\n');
  }
  // Committed first, then rewritten — the shape `npm install` produces.
  if (lockfile) writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":1}\n');
  if (dirty) writeFileSync(join(dir, 'marketplace.json'), '{}');
  return dir;
}

describe('marketplaceCloneHealth', () => {
  it('reports clean for a committed tree', () => {
    expect(marketplaceCloneHealth(makeClone())).toEqual({ kind: 'clean' });
  });

  it('reports dirty, with a count, for an uncommitted change', () => {
    const r = marketplaceCloneHealth(makeClone({ dirty: true }));
    expect(r.kind).toBe('dirty');
    expect(r.count).toBeGreaterThan(0);
  });

  it('is not fooled by an IGNORED node_modules, which is the real clone shape', () => {
    // Pre-ship review measured the first cut's `hasNodeModules` branch dead: the marketplace
    // clone is a clone of THIS repo, whose .gitignore carries `/node_modules`, so porcelain
    // never lists it — the branch was reachable only from a fixture that omitted the
    // .gitignore the real clone always has. An ignored node_modules also does not block a
    // fast-forward, so `clean` is the correct verdict, not a miss.
    const r = marketplaceCloneHealth(makeClone({ nodeModules: true, gitignore: true }));
    expect(r).toEqual({ kind: 'clean' });
  });

  it('DOES fire on the tracked file npm install rewrites', () => {
    // package-lock.json is tracked, so `npm install` inside the clone dirties it — that is the
    // mechanism the check exists for, and the one that actually blocks the updater's pull.
    const r = marketplaceCloneHealth(makeClone({ nodeModules: true, gitignore: true, lockfile: true }));
    expect(r.kind).toBe('dirty');
    expect(r.count).toBe(1);
  });

  it('reports absent when there is no clone', () => {
    expect(marketplaceCloneHealth(join(tmpdir(), 'cml-no-such-clone-xyz'))).toEqual({ kind: 'absent' });
  });

  it('reports not-git for a directory that is not a checkout', () => {
    const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-mp-plain-')));
    expect(marketplaceCloneHealth(dir)).toEqual({ kind: 'not-git' });
  });

  it('reports unknown — not clean — when git cannot run', () => {
    // The outcome that must not collapse into `clean`. A machine without git would otherwise
    // be told its clone is fine by a check that never ran.
    const dir = makeClone();
    const r = marketplaceCloneHealth(dir, () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    });
    expect(r).toEqual({ kind: 'unknown', reason: 'ENOENT' });
  });
});

// WIRING: the shipped doctor must actually surface it.
describe('doctor reports marketplace clone updatability', () => {
  function runDoctor(build) {
    const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-mp-home-')));
    const marketplaces = join(home, '.claude', 'plugins', 'marketplaces');
    mkdirSync(marketplaces, { recursive: true });
    build?.(join(marketplaces, 'sdsrss'));
    const dataDir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-mp-data-')));
    return spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
    }).stdout;
  }

  const cloneInto = (target, opts) => {
    const src = makeClone(opts);
    execFileSync('cp', ['-r', src, target]);
  };

  it('warns and explains the consequence when the clone is dirty', () => {
    const out = runDoctor((target) => cloneInto(target, { gitignore: true, lockfile: true }));
    expect(out).toMatch(/Marketplace clone: \d+ uncommitted change\(s\)/);
    expect(out).toMatch(/stops updating silently/);
  });

  it('reports clean for a committed clone (control)', () => {
    const out = runDoctor((target) => cloneInto(target, { gitignore: true }));
    expect(out).toMatch(/Marketplace clone: clean/);
  });

  it('says nothing at all when there is no clone', () => {
    // An npm-channel or npx user has no marketplace clone; a line about a thing you do not
    // have is noise, and it is also how a green tick starts meaning nothing.
    const out = runDoctor(null);
    expect(out).not.toMatch(/Marketplace clone/);
  });
});
