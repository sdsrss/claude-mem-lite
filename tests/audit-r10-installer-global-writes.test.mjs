// R10 P1-7 + P1-8 + P2-8 + P2-10 — four independent defects in how the installer treats
// files it does not own. Each drives the real writer; none asserts on this machine's own
// state, which is how the settings.json clobber of 71507b7 stayed invisible for a round.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
  rmSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { Worker } from 'node:worker_threads';
import { acquireLock } from '../lib/proc-lock.mjs';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_PATH = join(REPO, 'install.mjs');

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-globalwrite-'));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── P1-7 ─────────────────────────────────────────────────────────────────────
// The lock's whole reason for existing (its own header comment) is that two Claude Code
// windows reopening at once both run SessionStart self-heal. A stale lock is exactly what
// the previous holder leaves when it crashes — so the steal path is the hot path, not a
// corner. Stealing was unlink-then-create: A unlinks, A creates, B unlinks A's BRAND NEW
// lock, B creates. Both hold it, and both go on to run installExtractedRelease's rename
// loop over the same tree.

describe('R10 P1-7 — a stale lock is stolen by exactly one process', () => {
  function seedStaleLock(lockPath) {
    mkdirSync(dirname(lockPath), { recursive: true });
    // A pid that is provably dead: isStale() reclaims on a dead pid regardless of ts.
    writeFileSync(lockPath, JSON.stringify({ pid: 0x7ffffffe, ts: Date.now() }));
  }

  // Two worker threads that attempt the steal at the SAME INSTANT, synchronised by an
  // Atomics barrier. execFileSync cannot express this — two blocking spawns run one after
  // the other, the first releases before the second starts, and every round reads as a
  // double acquire for a reason that has nothing to do with the bug. Workers also start in
  // ~5ms rather than ~40ms, which is what makes 200 rounds affordable.
  //
  // Neither worker releases inside a round; the main thread re-seeds the lock file between
  // rounds. So "both returned a release fn" means both held it at the same moment.
  function raceSteal(lockPath, rounds) {
    const sab = new SharedArrayBuffer(4 * 4);
    const ctl = new Int32Array(sab); // [0]=round gate, [1]=finished count, [2]/[3]=results
    const code = `
      import { parentPort, workerData } from 'node:worker_threads';
      import { acquireLock } from ${JSON.stringify(join(REPO, 'lib', 'proc-lock.mjs'))};
      const ctl = new Int32Array(workerData.sab);
      const { id, rounds, lockPath } = workerData;
      for (let r = 0; r < rounds; r++) {
        // Spin-wait on the gate so both workers leave at the same instant.
        while (Atomics.load(ctl, 0) !== r + 1) Atomics.wait(ctl, 0, r, 50);
        const rel = acquireLock(lockPath);
        Atomics.store(ctl, 2 + id, rel ? 1 : 0);
        Atomics.add(ctl, 1, 1);
        Atomics.notify(ctl, 1);
      }
      parentPort.postMessage('done');
    `;
    const workers = [0, 1].map(
      (id) => new Worker(code, { eval: true, workerData: { sab, id, rounds, lockPath } }),
    );
    let doubleAcquire = 0,
      neither = 0;
    const done = Promise.all(
      workers.map((w) => new Promise((res, rej) => (w.on('message', res), w.on('error', rej)))),
    );
    const drive = (async () => {
      for (let r = 0; r < rounds; r++) {
        rmSync(lockPath, { force: true });
        seedStaleLock(lockPath);
        Atomics.store(ctl, 1, 0);
        Atomics.store(ctl, 0, r + 1);
        Atomics.notify(ctl, 0);
        while (Atomics.load(ctl, 1) !== 2) await new Promise((res) => setTimeout(res, 0));
        const a = Atomics.load(ctl, 2),
          b = Atomics.load(ctl, 3);
        if (a && b) doubleAcquire++;
        if (!a && !b) neither++;
      }
    })();
    return Promise.all([drive, done])
      .then(() => Promise.all(workers.map((w) => w.terminate())))
      .then(() => ({ doubleAcquire, neither, rounds }));
  }

  it('two concurrent stealers, 200 rounds: never both, never neither', async () => {
    const lockPath = join(root, 'runtime', 'install.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    const r = await raceSteal(lockPath, 200);
    expect(r.doubleAcquire, 'two processes held the same lock simultaneously').toBe(0);
    expect(r.neither, 'nobody could reclaim a stale lock — the lock is now a deadlock').toBe(0);
  }, 60000);

  // The second defect the race harness exposed, and the one that survived the first fix.
  // writeFileSync(path, data, { flag: 'wx' }) is TWO syscalls — create, then write — so the
  // lock file is briefly visible EMPTY. isStale() treats an unparseable lock as stale by
  // design, so a peer reading in that window stole a lock whose owner was mid-create and
  // already believed it held it. This case watches the file while a peer acquires it in a
  // loop and asserts the empty state is never observable; the statistical race case above
  // only reproduces it under CPU load, which a test must not depend on.
  it('the lock file is never observable in an empty, half-created state', async () => {
    const lockPath = join(root, 'runtime', 'watched.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    // BOTH sides are workers so the watcher can busy-spin. A main-thread watcher has to
    // await between reads to let the event loop run, and at one sample per tick it misses
    // the window about two runs in three — a guard that flaky is worse than none.
    const sab = new SharedArrayBuffer(12);
    const ctl = new Int32Array(sab); // [0]=stop flag, [1]=empty reads seen, [2]=acquisitions
    const acquirer = new Worker(
      `import { parentPort, workerData } from 'node:worker_threads';
       import { acquireLock } from ${JSON.stringify(join(REPO, 'lib', 'proc-lock.mjs'))};
       const ctl = new Int32Array(workerData.sab);
       // Time-bounded, not iteration-bounded: on a loaded box a fixed iteration count made
       // this case run for minutes against a busy-spinning watcher.
       const deadline = Date.now() + 2000;
       let n = 0;
       while (Date.now() < deadline) { const r = acquireLock(workerData.lockPath); if (r) r(); n++; }
       Atomics.store(ctl, 2, n);
       Atomics.store(ctl, 0, 1);
       parentPort.postMessage('done');`,
      { eval: true, workerData: { sab, lockPath } },
    );
    const watcher = new Worker(
      `import { parentPort, workerData } from 'node:worker_threads';
       import { readFileSync } from 'node:fs';
       const ctl = new Int32Array(workerData.sab);
       let reads = 0;
       while (Atomics.load(ctl, 0) === 0) {
         try { if (readFileSync(workerData.lockPath, 'utf8').length === 0) Atomics.add(ctl, 1, 1); reads++; }
         catch { /* between release and the next acquire */ }
       }
       parentPort.postMessage(reads);`,
      { eval: true, workerData: { sab, lockPath } },
    );
    // Attach BOTH listeners before awaiting either: a worker that finishes first emits its
    // message into the void and the later await never settles (this case hung for 60 s).
    const pAcq = new Promise((res, rej) => (acquirer.on('message', res), acquirer.on('error', rej)));
    const pWatch = new Promise((res, rej) => (watcher.on('message', res), watcher.on('error', rej)));
    const [, reads] = await Promise.all([pAcq, pWatch]);
    await Promise.all([acquirer.terminate(), watcher.terminate()]);
    expect(Atomics.load(ctl, 2), 'the acquirer barely ran; this case proves nothing').toBeGreaterThan(500);
    expect(reads, 'the watcher never saw the lock at all; this case proves nothing').toBeGreaterThan(500);
    // Measured on this box, 2 s per arm, three runs each: the two-syscall create leaves
    // 15,024 / 17,071 / 23,575 empty reads; link() leaves 0 / 0 / 0.
    expect(Atomics.load(ctl, 1), 'a peer can read the lock file before its contents are written').toBe(0);
  }, 60000);

  it('still refuses a LIVE lock', () => {
    const lockPath = join(root, 'runtime', 'live.lock');
    mkdirSync(dirname(lockPath), { recursive: true });
    const release = acquireLock(lockPath);
    expect(release).toBeTypeOf('function');
    expect(acquireLock(lockPath)).toBeNull();
    release();
    expect(acquireLock(lockPath)).toBeTypeOf('function');
  });

  it('still steals a lock whose ts has aged out, and one whose pid is dead', () => {
    const byAge = join(root, 'runtime', 'age.lock');
    mkdirSync(dirname(byAge), { recursive: true });
    writeFileSync(byAge, JSON.stringify({ pid: process.pid, ts: Date.now() - 10 * 60 * 1000 }));
    expect(acquireLock(byAge), 'an aged-out lock must still be reclaimable').toBeTypeOf('function');

    const byPid = join(root, 'runtime', 'pid.lock');
    writeFileSync(byPid, JSON.stringify({ pid: 0x7ffffffe, ts: Date.now() }));
    expect(acquireLock(byPid), 'a dead-pid lock must still be reclaimable').toBeTypeOf('function');
  });

  it('still reclaims an unparseable lock file', () => {
    const p = join(root, 'runtime', 'junk.lock');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'not json at all');
    expect(acquireLock(p)).toBeTypeOf('function');
  });

  it('leaves no tombstone behind after a steal', () => {
    const p = join(root, 'runtime', 'tomb.lock');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ pid: 0x7ffffffe, ts: Date.now() }));
    const release = acquireLock(p);
    release();
    const leftovers = execFileSync('ls', ['-a', dirname(p)], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.includes('tomb.lock'));
    expect(leftovers, 'the steal protocol left a residue file').toEqual([]);
  });
});

// ── P2-8 ─────────────────────────────────────────────────────────────────────
// tmp + rename does not inherit the target's mode: the temp is created with the default
// 0666 & ~umask, so a 0600 file comes back 0644. ~/.claude.json is 0600 as Claude Code
// writes it and holds mcpServers[*].env and OAuth account data.

describe('R10 P2-8 — atomic write preserves the target permission bits', () => {
  it('a 0600 target stays 0600', () => {
    const p = join(root, 'secretish.json');
    writeFileSync(p, '{"a":1}\n');
    chmodSync(p, 0o600);
    atomicWriteFileSync(p, '{"a":2}\n');
    expect((statSync(p).mode & 0o7777).toString(8)).toBe('600');
    expect(readFileSync(p, 'utf8')).toBe('{"a":2}\n');
  });

  it('a 0640 target stays 0640, and a fresh file is not forced narrow', () => {
    const p = join(root, 'group.json');
    writeFileSync(p, 'x');
    chmodSync(p, 0o640);
    atomicWriteFileSync(p, 'y');
    expect((statSync(p).mode & 0o7777).toString(8)).toBe('640');

    const fresh = join(root, 'brand-new.json');
    atomicWriteFileSync(fresh, 'z');
    expect(existsSync(fresh)).toBe(true);
    expect(readFileSync(fresh, 'utf8')).toBe('z');
  });

  it('the .bak copy also keeps the mode', () => {
    const p = join(root, 'withbak.json');
    writeFileSync(p, 'a');
    chmodSync(p, 0o600);
    atomicWriteFileSync(p, 'b', { backup: true });
    expect((statSync(p + '.bak').mode & 0o7777).toString(8)).toBe('600');
  });
});

// ── P1-8 ─────────────────────────────────────────────────────────────────────
// readSettings caught ENOENT and SyntaxError together and returned {} for both, so a
// settings.json the user was midway through hand-editing (one trailing comma) was replaced
// wholesale: permissions, env, other plugins' hooks, enabledPlugins — all gone. The .bak
// is only written on the FIRST overwrite ever, so on a real machine it is months old.

describe('R10 P1-8 — a settings.json that is not valid JSON is never overwritten', () => {
  function seedHome(content) {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const p = join(home, '.claude', 'settings.json');
    writeFileSync(p, content);
    return { home, p };
  }
  const BAD = `{
  "permissions": { "allow": ["Bash"] },
  "env": { "MY_SECRET_TOKEN": "keepme" },
  "hooks": { "Stop": [{ "matcher": "", "hooks": [] }] },
}`;

  function run(cmd, home) {
    return execFileSync(process.execPath, [INSTALL_PATH, cmd], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CLAUDE_MEM_SKIP_REPOS: '1', MEM_NO_AUTO_ADOPT: '1' },
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });
  }

  for (const cmd of ['install', 'uninstall']) {
    it(`\`${cmd}\` refuses and leaves the file byte-identical`, () => {
      const { home, p } = seedHome(BAD);
      let failed = false;
      let out;
      try {
        out = run(cmd, home);
      } catch (e) {
        failed = true;
        out = `${e.stdout || ''}${e.stderr || ''}`;
      }
      expect(failed, `${cmd} exited 0 despite unparseable settings.json`).toBe(true);
      expect(out).toMatch(/not valid JSON/i);
      expect(readFileSync(p, 'utf8'), `${cmd} overwrote an unparseable settings.json`).toBe(BAD);
      expect(existsSync(p + '.bak'), 'it should not even get as far as writing a .bak').toBe(false);
    });
  }

  it('a MISSING settings.json is still treated as empty, not as an error', () => {
    const home = join(root, 'home2');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const p = join(home, '.claude', 'settings.json');
    expect(existsSync(p)).toBe(false);
    run('install', home);
    expect(existsSync(p), 'install must still create settings.json from nothing').toBe(true);
    expect(() => JSON.parse(readFileSync(p, 'utf8'))).not.toThrow();
  });

  it('a VALID settings.json is still merged, and the user keys survive', () => {
    const { home, p } = seedHome(
      JSON.stringify({ permissions: { allow: ['Bash'] }, env: { KEEP: '1' } }, null, 2) + '\n',
    );
    run('install', home);
    const after = JSON.parse(readFileSync(p, 'utf8'));
    expect(after.permissions).toEqual({ allow: ['Bash'] });
    expect(after.env).toEqual({ KEEP: '1' });
  });
});

// ── P2-10 ────────────────────────────────────────────────────────────────────
// .update-backup-* is the ONLY rollback copy of an in-flight update, and it holds the
// journal hook-update replays. cleanup deleted it with no age gate and no lock check,
// while doctor actively suggests running cleanup — including during the minutes-long
// source-compile window between swap-in and smoke-pass.

describe('R10 P2-10 — cleanup does not delete an in-flight update rollback copy', () => {
  function seedDataDir() {
    const data = join(root, 'data');
    mkdirSync(join(data, 'runtime'), { recursive: true });
    mkdirSync(join(data, '.update-backup-1700000000000'), { recursive: true });
    writeFileSync(join(data, '.update-backup-1700000000000', 'journal.json'), '{}');
    mkdirSync(join(data, '.update-staging-1700000000000'), { recursive: true });
    return data;
  }

  function runCleanup(data, extra = []) {
    return execFileSync(process.execPath, [INSTALL_PATH, 'cleanup', ...extra], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        CLAUDE_MEM_DIR: data,
        CLAUDE_MEM_SKIP_REPOS: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });
  }

  it('skips update residue while a LIVE installer holds install.lock', () => {
    const data = seedDataDir();
    const lock = join(data, 'runtime', 'install.lock');
    // A live holder: this very process.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const out = runCleanup(data);
    expect(existsSync(join(data, '.update-backup-1700000000000')), out).toBe(true);
    expect(existsSync(join(data, '.update-staging-1700000000000'))).toBe(true);
    expect(out).toMatch(/install in progress|skipped/i);
  });

  it('still removes update residue when no installer is running', () => {
    const data = seedDataDir();
    runCleanup(data);
    expect(existsSync(join(data, '.update-backup-1700000000000'))).toBe(false);
    expect(existsSync(join(data, '.update-staging-1700000000000'))).toBe(false);
  });

  it('releases the lock it takes, so a later installer is not blocked', () => {
    const data = seedDataDir();
    runCleanup(data);
    const lock = join(data, 'runtime', 'install.lock');
    expect(existsSync(lock), 'cleanup left install.lock held after exiting').toBe(false);
  });
});
