// ENG-1 (2026-08-29 audit): CLAUDE_MEM_TEST_GUARD was blind to the bash channel.
//
// The guard lives in containInTests() (lib/resolve-data-dir.mjs) — the NODE exit of the
// PostToolUse channel. That channel has two exits: scripts/post-tool-use.sh handles Read
// entirely in bash and never reaches Node, so a test that spawned the prefilter without
// setting CLAUDE_MEM_DIR appended straight into the developer's live runtime directory.
// v3.83.0 had to clean up exactly that (69 lines written into the real runtime dir), and
// the fix there was a single-file canary keyed on one fingerprint — any other test, under
// any other project name, still walked through.
//
// Hermetic by construction: CLAUDE_MEM_TEST_REALDIR is what containInTests compares
// against, so "the real directory" can be a fixture HOME. Nothing here can touch the
// developer's data dir even if the guard is broken.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PREFILTER = join(REPO, 'scripts', 'post-tool-use.sh');

let root, fakeHome, realDir, sandbox, projectDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-eng1-'));
  fakeHome = join(root, 'home');
  realDir = join(fakeHome, '.claude-mem-lite');
  sandbox = join(root, 'sandbox');
  projectDir = join(root, 'work', 'proj');
  mkdirSync(join(realDir, 'runtime'), { recursive: true });
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Spawn the bash prefilter with a Read payload, exactly as PostToolUse would. */
function runPrefilter(extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: fakeHome,
    TMPDIR: join(root, 'tmpdir'),
    CLAUDE_PROJECT_DIR: projectDir,
    ...extraEnv,
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  execFileSync('bash', [PREFILTER], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(projectDir, 'src', 'thing.mjs') },
    }),
    env,
    stdio: 'pipe',
    timeout: 20_000,
  });
}

const readsFilesIn = (dir) => {
  const rt = join(dir, 'runtime');
  if (!existsSync(rt)) return [];
  return readdirSync(rt).filter((f) => f.startsWith('reads-') && f.endsWith('.txt'));
};

describe('post-tool-use.sh — CLAUDE_MEM_TEST_GUARD containment', () => {
  it('CONTROL: without the guard the Read fast path writes into the resolved home dir', () => {
    // The shape v3.83.0 cleaned up: no CLAUDE_MEM_DIR, so the default resolves. This case
    // is what makes the guarded assertions below mean something — without it, "no reads
    // file in the real dir" is equally consistent with a payload that wrote nothing.
    runPrefilter();
    expect(readsFilesIn(realDir)).toHaveLength(1);
  });

  it('redirects to the run sandbox when the guard is armed and the target is the real dir', () => {
    runPrefilter({
      CLAUDE_MEM_TEST_GUARD: '1',
      CLAUDE_MEM_TEST_REALDIR: realDir,
      CLAUDE_MEM_TEST_SANDBOX: sandbox,
    });
    expect(readsFilesIn(realDir)).toHaveLength(0);
    expect(readsFilesIn(sandbox)).toHaveLength(1);
  });

  it('leaves an explicitly relocated CLAUDE_MEM_DIR alone — the guard blocks ONE directory', () => {
    // A suite that sets CLAUDE_MEM_DIR is already isolated. Redirecting it too would
    // break the relocation the bash path exists to honour.
    const explicit = join(root, 'explicit');
    mkdirSync(explicit, { recursive: true });
    runPrefilter({
      CLAUDE_MEM_DIR: explicit,
      CLAUDE_MEM_TEST_GUARD: '1',
      CLAUDE_MEM_TEST_REALDIR: realDir,
      CLAUDE_MEM_TEST_SANDBOX: sandbox,
    });
    expect(readsFilesIn(explicit)).toHaveLength(1);
    expect(readsFilesIn(realDir)).toHaveLength(0);
    expect(readsFilesIn(sandbox)).toHaveLength(0);
  });

  it('contains a trailing-slash spelling of the real dir (Node resolve()s, bash did not)', () => {
    // The Node exit compares resolve(dir) !== resolve(real); the bash mirror compared raw
    // strings, so `CLAUDE_MEM_DIR="$HOME/.claude-mem-lite/"` walked through the guard and
    // appended into the live runtime dir — the exact leak the mirror exists to close.
    runPrefilter({
      CLAUDE_MEM_DIR: `${realDir}/`,
      CLAUDE_MEM_TEST_GUARD: '1',
      CLAUDE_MEM_TEST_REALDIR: realDir,
      CLAUDE_MEM_TEST_SANDBOX: sandbox,
    });
    expect(readsFilesIn(realDir)).toHaveLength(0);
    expect(readsFilesIn(sandbox)).toHaveLength(1);
  });

  it('falls back to a temp directory when the guard is armed with no sandbox', () => {
    runPrefilter({ CLAUDE_MEM_TEST_GUARD: '1', CLAUDE_MEM_TEST_REALDIR: realDir });
    expect(readsFilesIn(realDir)).toHaveLength(0);
    expect(readsFilesIn(join(root, 'tmpdir', 'claude-mem-test-fallback'))).toHaveLength(1);
  });

  it('agrees with the Node exit of the same channel on every one of those cases', () => {
    // The drift guard. ENG-1 exists because one exit of this channel grew a rule the
    // other never got; asserting the two agree is what stops that recurring silently.
    const cases = [
      { CLAUDE_MEM_TEST_GUARD: '1', CLAUDE_MEM_TEST_REALDIR: realDir, CLAUDE_MEM_TEST_SANDBOX: sandbox },
      {
        CLAUDE_MEM_DIR: join(root, 'explicit'),
        CLAUDE_MEM_TEST_GUARD: '1',
        CLAUDE_MEM_TEST_REALDIR: realDir,
        CLAUDE_MEM_TEST_SANDBOX: sandbox,
      },
      { CLAUDE_MEM_TEST_GUARD: '1', CLAUDE_MEM_TEST_REALDIR: realDir },
      {},
    ];
    for (const extra of cases) {
      const tmpd = join(root, 'tmpdir');
      mkdirSync(tmpd, { recursive: true });
      mkdirSync(join(root, 'explicit'), { recursive: true });

      // What Node resolves, asked in a subprocess so this test's own env stays clean.
      const nodeDir = execFileSync(
        process.execPath,
        [
          '-e',
          'const{resolveDataDir}=await import(process.argv[1]);process.stdout.write(resolveDataDir(process.env.CLAUDE_MEM_DIR));',
          join(REPO, 'lib', 'resolve-data-dir.mjs'),
        ],
        {
          env: { PATH: process.env.PATH, HOME: fakeHome, TMPDIR: tmpd, ...extra },
          encoding: 'utf8',
          stdio: 'pipe',
        },
      ).trim();

      // What bash resolves, read back from where the reads file actually landed.
      rmSync(join(root, 'probe'), { recursive: true, force: true });
      for (const d of [realDir, sandbox, join(root, 'explicit'), join(tmpd, 'claude-mem-test-fallback')]) {
        rmSync(join(d, 'runtime'), { recursive: true, force: true });
      }
      runPrefilter(extra);
      const landed = [
        realDir,
        sandbox,
        join(root, 'explicit'),
        join(tmpd, 'claude-mem-test-fallback'),
      ].filter((d) => readsFilesIn(d).length > 0);
      expect(landed, `env ${JSON.stringify(extra)} — expected exactly one landing dir`).toHaveLength(1);
      expect(landed[0], `env ${JSON.stringify(extra)}`).toBe(nodeDir);
    }
  });
});
