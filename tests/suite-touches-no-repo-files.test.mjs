// The unit suite must not rewrite THIS repository's own tracked files.
//
// It did, for exactly one round. `tests/install-e2e.test.mjs`'s runInstall sandboxed HOME
// but nothing else, so install.mjs's dogfood branch (which detects this repo by its git
// remote, not by cwd) called cmdAdopt with no target — and adopt-cli resolves its target
// from CLAUDE_PROJECT_DIR ‖ PWD ‖ process.cwd(), where PWD was vitest's, the repo root.
// Every `vitest run` rewrote the tracked CLAUDE.md managed block and
// .claude/plugin_claude_mem_lite.md to the HEAD template, silently discarding any
// uncommitted edit to them. R9 called this the "fourth trap" without finding the writer;
// R10 P2-17 bisected 60 candidate files down to this one.
//
// The escape hatch install.mjs was missing is MEM_NO_AUTO_ADOPT=1 — the GLOBAL opt-out
// that the managed block itself advertises and that hook.mjs:2299 already honoured. So
// this guard drives the real writer twice, once each way: the first case proves the writer
// still reaches a project directory (otherwise the second passes vacuously), the second
// proves the env var stops it. Both then assert the real repo did not move, which is the
// symptom, while the pair above is the mechanism.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_PATH = join(REPO, 'install.mjs');
const REPO_CLAUDE_MD = join(REPO, 'CLAUDE.md');
const REPO_SIDECAR = join(REPO, '.claude', 'plugin_claude_mem_lite.md');

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-repofiles-'));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function snapshot(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** A sandbox HOME + a sandbox project dir with its own CLAUDE.md. */
function seed() {
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(proj, { recursive: true });
  const md = join(proj, 'CLAUDE.md');
  writeFileSync(md, '# Sandbox project\n\nNothing managed here yet.\n');
  return { home, proj, md };
}

function runInstall(home, proj, extraEnv) {
  // `--dev` symlinks node_modules instead of running `npm install`. Without it this case
  // needs the network: install.mjs shells out to npm, better-sqlite3 has no prebuild for
  // every Node, and node-gyp then downloads headers from nodejs.org — which is exactly how
  // this file failed under `--coverage` on a slow link, for a reason with nothing to do
  // with what it tests. Dev mode still runs dogfoodAutoAdopt (install.mjs:959 is
  // unconditional), which is the branch under test.
  return execFileSync(process.execPath, [INSTALL_PATH, 'install', '--dev'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: proj,
      CLAUDE_MEM_SKIP_REPOS: '1',
      ...extraEnv,
    },
    cwd: proj,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60000,
  });
}

// The product half above is only half the mechanism: install.mjs can honour the opt-out
// perfectly and the repo still gets rewritten if a test spawns install.mjs without setting
// it. That is the exact shape a `git revert` of the install-e2e change restores, and no
// assertion about a sandbox project can see it — so this one reads the spawners.
describe('no test spawns install.mjs without opting out of auto-adopt', () => {
  it('every test file that runs `install.mjs install` sets MEM_NO_AUTO_ADOPT or --no-adopt', () => {
    // Offender shape, all three required: builds a path to install.mjs, hands it to a
    // child process, and passes the `install` (or `repair`) subcommand — the only two
    // that reach dogfoodAutoAdopt (install.mjs:959). `doctor` / `status` / `uninstall` /
    // `cleanup-hooks` spawners are not offenders and must not be flagged, or this guard
    // gets suppressed as noise. 'uninstall' does not match: the quote sits before the u.
    const SPAWN = /(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*[^,]+,\s*\[([^\]]*)\]/gs;
    const ADOPTING_CMD = /['"](?:install|repair)['"]/;
    const offenders = [];
    for (const name of readdirSync(join(REPO, 'tests'))) {
      if (!name.endsWith('.test.mjs')) continue;
      const src = readFileSync(join(REPO, 'tests', name), 'utf8');
      if (!/['"]install\.mjs['"]/.test(src)) continue;
      const argvs = [...src.matchAll(SPAWN)].map((m) => m[1]);
      if (!argvs.some((a) => /INSTALL/i.test(a) || a.includes('install.mjs'))) continue;
      if (!ADOPTING_CMD.test(src)) continue;
      if (/MEM_NO_AUTO_ADOPT/.test(src) || /--no-adopt/.test(src)) continue;
      offenders.push(name);
    }
    expect(
      offenders,
      'these run `install.mjs install` with the repository as cwd, so its dogfood branch rewrites tracked files',
    ).toEqual([]);
  });
});

describe('install never adopts a project the caller did not point it at', () => {
  it('adopts the sandbox project when nothing opts out — the premise', () => {
    const { home, proj, md } = seed();
    runInstall(home, proj, {});
    expect(
      readFileSync(md, 'utf8'),
      'dogfood auto-adopt no longer reaches a project dir; the opt-out case below would pass vacuously',
    ).toContain('claude-mem-lite:begin');
  });

  it('MEM_NO_AUTO_ADOPT=1 leaves the sandbox project byte-identical', () => {
    const { home, proj, md } = seed();
    const before = readFileSync(md, 'utf8');
    runInstall(home, proj, { MEM_NO_AUTO_ADOPT: '1' });
    expect(readFileSync(md, 'utf8'), 'install ignored the global auto-adopt opt-out').toBe(before);
    expect(existsSync(join(proj, '.claude', 'plugin_claude_mem_lite.md'))).toBe(false);
  });

  it('leaves this repository CLAUDE.md and .claude sidecar byte-identical across an install', () => {
    const mdBefore = snapshot(REPO_CLAUDE_MD);
    const sideBefore = snapshot(REPO_SIDECAR);
    const { home, proj } = seed();
    runInstall(home, proj, { MEM_NO_AUTO_ADOPT: '1' });
    expect(snapshot(REPO_CLAUDE_MD), 'the suite rewrote the repo own CLAUDE.md').toBe(mdBefore);
    expect(snapshot(REPO_SIDECAR), 'the suite rewrote the repo own .claude sidecar').toBe(sideBefore);
  });
});
