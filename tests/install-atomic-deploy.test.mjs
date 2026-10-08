// install-atomic-deploy.test.mjs — D#223 / R10 P2-12: `install` (and the background `repair`
// that ends in it) rewrote ~/.claude-mem-lite while hooks kept importing that tree.
//
// The copy loop used copyFileSync onto the live file: open with O_TRUNC, then write. A hook
// starting in that window imported an empty or half-written module. The weekly sandbox
// harness (tests/sandbox/phaseB-npm.mjs B10) went red on it three Mondays in four with
// `SyntaxError: ... does not provide an export named ...` (10-05 `buildNotLowSignalSql`, 09-28
// `recordMetric`, 09-14 `likeLiteral` / `citeFactorClause`) on a SAME-version re-install, so no
// version mix was needed.
// A probe re-copying SOURCE_FILES under 8 concurrent importers (2026-10-06): in place
// 12 of 2386 overlapping imports failed, that signature among them; temp + rename 0 of 2388.
//
// Two layers, as hook-update.mjs already does for auto-update: every file is replaced by a
// rename (a reader sees the old file or the new one, never a torn one), and the swap marker
// scripts/hook-launcher.mjs honours is armed while install() deploys the code and runs npm
// install (a fire that starts then is skipped instead of importing a mix of two versions).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOURCE_FILES, HOOK_SCRIPT_FILES } from '../source-files.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Counts the copies that go through atomicCopyFileSync; calls the real implementation.
const probe = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/atomic-write.mjs', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    atomicCopyFileSync: (src, dst) => {
      probe.calls++;
      return orig.atomicCopyFileSync(src, dst);
    },
  };
});

const sandboxes = [];
function sandbox(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(d);
  return d;
}
afterAll(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true });
});

describe('atomicCopyFileSync', () => {
  let atomicCopyFileSync;
  beforeAll(async () => {
    ({ atomicCopyFileSync } = await import('../lib/atomic-write.mjs'));
  });

  it('a reader that opened the old file still reads all of it after the copy', () => {
    const dir = sandbox('mem-atomic-copy-');
    const src = join(dir, 'new.mjs');
    const dst = join(dir, 'live.mjs');
    const oldText = 'export const v = 1;\n'.repeat(500);
    writeFileSync(dst, oldText);
    writeFileSync(src, 'export const v = 2;\n');
    const fd = openSync(dst, 'r');
    try {
      atomicCopyFileSync(src, dst);
      const buf = Buffer.alloc(oldText.length + 16);
      const n = readSync(fd, buf, 0, buf.length, 0);
      // In place, the held descriptor sees the truncated-and-rewritten file (20 bytes).
      expect(buf.subarray(0, n).toString()).toBe(oldText);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(dst, 'utf8')).toBe('export const v = 2;\n');
  });

  it("keeps the source's mode bits", () => {
    const dir = sandbox('mem-atomic-copy-');
    const src = join(dir, 'hook.sh');
    const dst = join(dir, 'installed.sh');
    writeFileSync(src, '#!/bin/sh\n');
    chmodSync(src, 0o755);
    writeFileSync(dst, 'old\n');
    chmodSync(dst, 0o644);
    atomicCopyFileSync(src, dst);
    expect(statSync(dst).mode & 0o777).toBe(0o755);
  });

  it('leaves no temp file behind when the rename fails', () => {
    const dir = sandbox('mem-atomic-copy-');
    const src = join(dir, 'a.mjs');
    writeFileSync(src, 'x');
    const dst = join(dir, 'occupied');
    mkdirSync(join(dst, 'child'), { recursive: true }); // a non-empty directory: rename refuses
    expect(() => atomicCopyFileSync(src, dst)).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['a.mjs', 'occupied']);
  });
});

describe('install: deploying the code tree under live hook traffic (D#223)', () => {
  let home;
  let dataDir;
  let install;
  const saved = {};

  beforeAll(async () => {
    home = sandbox('mem-atomic-deploy-');
    for (const k of ['HOME', 'CLAUDE_MEM_DIR', 'CLAUDE_MEM_RUNTIME_DIR']) saved[k] = process.env[k];
    process.env.HOME = home;
    delete process.env.CLAUDE_MEM_DIR;
    delete process.env.CLAUDE_MEM_RUNTIME_DIR;
    vi.resetModules();
    // install.mjs computes its paths from homedir() at import time.
    install = await import('../install.mjs');
    dataDir = join(home, '.claude-mem-lite');
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a re-deploy replaces every code file instead of rewriting it', () => {
    install.deployCodeTree(false);
    const files = [
      ...SOURCE_FILES.filter((f) => existsSync(join(REPO, f))),
      ...HOOK_SCRIPT_FILES.filter((n) => existsSync(join(REPO, 'scripts', n))).map((n) => `scripts/${n}`),
    ];
    const before = new Map(files.map((f) => [f, statSync(join(dataDir, f)).ino]));

    probe.calls = 0;
    install.deployCodeTree(false);

    // Premise: the deploy went through the recorded helper at all, once per file.
    expect(probe.calls).toBe(files.length);
    // A file rewritten in place keeps its inode; a renamed-in replacement cannot, because
    // the replacement existed alongside the old file before the rename.
    expect(files.filter((f) => statSync(join(dataDir, f)).ino === before.get(f))).toEqual([]);
  });

  it('the marker install arms is the one scripts/hook-launcher.mjs honours', async () => {
    const ranFlag = join(home, 'entry-ran.txt');
    const entry = join(home, 'entry.mjs');
    writeFileSync(
      entry,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ranFlag)}, 'ran');\n`,
    );
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_MEM_DIR;
    delete env.CLAUDE_MEM_RUNTIME_DIR;
    const fire = () =>
      spawnSync(process.execPath, [join(REPO, 'scripts', 'hook-launcher.mjs'), entry], {
        env,
        input: '{}',
        encoding: 'utf8',
        timeout: 30_000,
      });

    const during = await install.withSwapBarrier(() => {
      const r = fire();
      return { code: r.status, ran: existsSync(ranFlag) };
    });
    expect(during).toEqual({ code: 0, ran: false });

    // Premise: the same fire runs once the barrier is down — otherwise "skipped" above
    // could be any launcher failure that also exits 0.
    const after = fire();
    expect(after.status).toBe(0);
    expect(existsSync(ranFlag)).toBe(true);
  });

  it('the marker stays up across an awaited step and comes down after it', async () => {
    const marker = join(dataDir, 'runtime', 'swap-in-progress');
    const seen = await install.withSwapBarrier(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return existsSync(marker); // npm install is awaited inside the barrier
    });
    expect(seen).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('the marker comes down when the deploy throws or rejects', async () => {
    const marker = join(dataDir, 'runtime', 'swap-in-progress');
    await expect(
      install.withSwapBarrier(() => {
        throw new Error('copy failed');
      }),
    ).rejects.toThrow('copy failed');
    expect(existsSync(marker)).toBe(false);
    await expect(
      install.withSwapBarrier(async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('npm failed');
      }),
    ).rejects.toThrow('npm failed');
    expect(existsSync(marker)).toBe(false);
  });

  it('install() prepares the dirs, finishes an interrupted swap, then deploys the code, retires any journal left, and installs its dependencies inside one barrier', () => {
    // install() itself is not unit-runnable (npm, MCP registration, settings.json), so its
    // wiring is read from source, comments stripped so a commented-out call cannot satisfy it.
    // The interrupted swap is finished BEFORE the barrier: its recovery arms and clears the same
    // marker, and replayed after the deploy it would put an older release back (D#289;
    // tests/update-residue-faces.test.mjs runs that behaviour end to end).
    const src = readFileSync(join(REPO, 'install.mjs'), 'utf8');
    const start = src.indexOf('async function install() {');
    expect(start).toBeGreaterThan(-1);
    const body = src
      .slice(start, src.indexOf('\n}\n', start))
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(body).toMatch(
      /prepareInstallDirs\(\);\s*await finishInterruptedSwaps\(\);\s*await withSwapBarrier\(async \(\) => \{\s*deployCodeTree\(IS_DEV\);\s*retireLeftoverJournals\(\);\s*await installDependencies\(IS_DEV\);\s*\}\);/,
    );
  });
});

describe('install: the swap marker under a relocated data dir and a runtime override', () => {
  // The marker is installation identity: the launcher reads it under CLAUDE_MEM_DIR's runtime dir
  // and deliberately NOT under CLAUDE_MEM_RUNTIME_DIR (a per-harness override it keeps for hook
  // markers). The default-env test above cannot tell those apart from the home-rooted dir.
  let home;
  let dataDir;
  let rtDir;
  let install;
  const saved = {};

  beforeAll(async () => {
    home = sandbox('mem-atomic-reloc-');
    dataDir = join(home, 'relocated-data');
    rtDir = join(home, 'runtime-override');
    for (const k of ['HOME', 'CLAUDE_MEM_DIR', 'CLAUDE_MEM_RUNTIME_DIR']) saved[k] = process.env[k];
    process.env.HOME = home;
    process.env.CLAUDE_MEM_DIR = dataDir;
    process.env.CLAUDE_MEM_RUNTIME_DIR = rtDir;
    vi.resetModules();
    install = await import('../install.mjs');
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the launcher, given the same env, skips a fire while install holds the barrier', async () => {
    const ranFlag = join(home, 'entry-ran.txt');
    const entry = join(home, 'entry.mjs');
    writeFileSync(
      entry,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ranFlag)}, 'ran');\n`,
    );
    const env = { ...process.env, HOME: home, CLAUDE_MEM_DIR: dataDir, CLAUDE_MEM_RUNTIME_DIR: rtDir };
    const fire = () =>
      spawnSync(process.execPath, [join(REPO, 'scripts', 'hook-launcher.mjs'), entry], {
        env,
        input: '{}',
        encoding: 'utf8',
        timeout: 30_000,
      });

    const during = await install.withSwapBarrier(() => {
      const r = fire();
      return {
        code: r.status,
        ran: existsSync(ranFlag),
        underDataDir: existsSync(join(dataDir, 'runtime', 'swap-in-progress')),
      };
    });
    expect(during).toEqual({ code: 0, ran: false, underDataDir: true });

    const after = fire();
    expect(after.status).toBe(0);
    expect(existsSync(ranFlag)).toBe(true);
  });
});
