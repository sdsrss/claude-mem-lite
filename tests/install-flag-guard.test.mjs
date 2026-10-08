// Install-family commands used to ignore every flag they did not read, so `uninstall --dry-run`
// and `uninstall --help` UNINSTALLED — removed the MCP registration, the CLI symlink and every
// hook — and `install --help` installed. `cleanup` honours `--dry-run`, which is exactly why a
// user expects its siblings to. A command that writes must refuse a flag it does not know, and
// `--help` / `-h` must print usage and do nothing.
//
// §8.V3: destructive paths run against a sandbox HOME with a fake `claude` on PATH that only
// records its argv, so an unguarded run shows up as a recorded `mcp remove` rather than as damage.
import { describe, it, expect, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

const OUR_HOOK = {
  hooks: [{ type: 'command', command: 'node "/x/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs stop' }],
};

function sandbox() {
  const root = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-flag-guard-')));
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settings = join(home, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: { Stop: [OUR_HOOK] } }, null, 2));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'claude-calls.log');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> "${calls}"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  return { root, home, settings, bin, calls, before: readFileSync(settings, 'utf8') };
}

function run(s, args) {
  return spawnSync(process.execPath, [join(REPO, 'install.mjs'), ...args], {
    cwd: s.root,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: s.home,
      // cleanup sweeps os.tmpdir(); keep an unguarded run inside the sandbox too.
      TMPDIR: s.root,
      PATH: `${s.bin}:${process.env.PATH}`,
      CLAUDE_MEM_DIR: join(s.root, 'data'),
      CLAUDE_MEM_SKIP_UPDATE: '1',
      MEM_NO_AUTO_ADOPT: '1',
      // A runtime-dir override exported in the developer's shell would move the markers the
      // cases below write; spawnSync drops an undefined value, so the child never sees it.
      CLAUDE_MEM_RUNTIME_DIR: undefined,
    },
  });
}

const untouched = (s) => {
  expect(readFileSync(s.settings, 'utf8')).toBe(s.before);
  expect(existsSync(s.calls)).toBe(false);
};

describe('install-family commands do nothing on a flag they do not know', () => {
  it('premise: plain uninstall does write — the sandbox can see damage', () => {
    const s = sandbox();
    const r = run(s, ['uninstall']);
    expect(r.status).toBe(0);
    expect(readFileSync(s.settings, 'utf8')).not.toBe(s.before);
    expect(readFileSync(s.calls, 'utf8')).toMatch(/mcp remove/);
  });

  for (const flag of ['--dry-run', '--bogus']) {
    it(`uninstall ${flag} refuses, exits 1 and names the flag`, () => {
      const s = sandbox();
      const r = run(s, ['uninstall', flag]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(flag);
      expect(r.stderr).toMatch(/nothing was done/);
      untouched(s);
    });
  }

  // `install`, `repair` and `release` are left out on purpose: unguarded, they run npm, fetch
  // a tarball, or rewrite this repository's own manifests. The guard sits in main(), ahead of
  // every command, and the table case below keeps each command inside it.
  for (const cmd of ['uninstall', 'cleanup', 'cleanup-hooks']) {
    for (const flag of ['--help', '-h']) {
      it(`${cmd} ${flag} prints usage and exits 0 without acting`, () => {
        const s = sandbox();
        const r = run(s, [cmd, flag]);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/Usage:/);
        untouched(s);
      });
    }
  }

  it('a read-only command reports an unknown flag and still runs', () => {
    const s = sandbox();
    const r = run(s, ['status', '--bogus']);
    expect(r.stderr).toMatch(/Unknown flag --bogus/);
    expect(r.stdout).toMatch(/status/i);
    // status reads `claude mcp list`; it must not add or remove anything.
    expect(readFileSync(s.settings, 'utf8')).toBe(s.before);
    const calls = existsSync(s.calls) ? readFileSync(s.calls, 'utf8') : '';
    expect(calls).not.toMatch(/mcp (add|remove)/);
  });

  it('every install-family command the CLI routes has a flag table', async () => {
    const { INSTALL_COMMAND_FLAGS } = await import('../install.mjs');
    const cli = readFileSync(join(REPO, 'cli.mjs'), 'utf8');
    const block = cli.match(/const INSTALL_COMMANDS = new Set\(\[([\s\S]*?)\]\)/)[1];
    const routed = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(routed.length).toBeGreaterThanOrEqual(10);
    for (const c of routed) expect(Object.keys(INSTALL_COMMAND_FLAGS)).toContain(c);
  });

  it('flags a command documents are still accepted', () => {
    const s = sandbox();
    const r = run(s, ['cleanup', '--dry-run']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/Unknown flag/);
    untouched(s);
  });
});

// Same file, neighbouring defect: install and uninstall refused an unparseable settings.json
// only AFTER their first side effects — install had copied files, run npm and registered the
// MCP server; uninstall had removed the MCP registration and the CLI link — and then printed
// "fix it first; nothing was written". Both now check it before doing anything.
describe('an unparseable settings.json stops install/uninstall before any side effect', () => {
  for (const cmd of ['uninstall', 'install']) {
    it(`${cmd} exits 1 and calls nothing`, () => {
      const s = sandbox();
      writeFileSync(s.settings, '{,\n  "hooks": {}\n}\n');
      const r = run(s, [cmd]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/not valid JSON/);
      expect(existsSync(s.calls)).toBe(false);
      expect(existsSync(join(s.home, '.claude-mem-lite'))).toBe(false);
    }, 120_000);
  }
});

// Same round: a data dir the user cannot enter (chmod 000, wrong owner after `sudo`) read as
// ABSENT everywhere — doctor said "no database yet" and "server.mjs: missing" over an intact
// install, and install said "Another install/repair is in progress — skipping" and exited 0,
// because acquireLock answers null for a permission error and for a live peer alike.
describe('an inaccessible data dir is named as a permission problem', () => {
  const skip = process.getuid?.() === 0; // root ignores the mode bits this relies on
  function locked() {
    const s = sandbox();
    const data = join(s.root, 'data');
    mkdirSync(join(data, 'runtime'), { recursive: true });
    writeFileSync(join(data, 'claude-mem-lite.db'), '');
    chmodSync(data, 0o000);
    return { s, data, restore: () => chmodSync(data, 0o755) };
  }
  it.skipIf(skip)('install exits 1 and says the directory is not accessible', () => {
    const { s, data, restore } = locked();
    try {
      const r = run(s, ['install']);
      expect(r.status).toBe(1);
      expect(r.stderr + r.stdout).toMatch(/not accessible/);
      expect(r.stderr + r.stdout).toContain(data);
      expect(r.stdout).not.toMatch(/Another install\/repair is in progress/);
    } finally {
      restore();
    }
  });
  it.skipIf(skip)('doctor leads with the permission problem', () => {
    const { s, data, restore } = locked();
    try {
      const r = run(s, ['doctor']);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(new RegExp(`✗ Data directory: .*not accessible \\(EACCES\\)`));
      expect(r.stdout).toContain(`chmod u+rwx ${data}`);
    } finally {
      restore();
    }
  });
  // status had no access check at all and said "⚠ Database: not found" over the same store.
  it.skipIf(skip)('status names the locked data dir instead of a missing database', () => {
    const { s, data, restore } = locked();
    try {
      const r = run(s, ['status']);
      expect(r.stdout).toMatch(new RegExp(`✗ Database: ${data} is not accessible \\(EACCES\\)`));
      expect(r.stdout).not.toMatch(/Database: not found/);
      const j = JSON.parse(run(s, ['status', '--json']).stdout);
      expect(j.database).toMatchObject({ level: 'fail', exists: null, error: 'EACCES' });
    } finally {
      restore();
    }
  });
  // D#199: the lines below the ✗ still read the locked dir as an empty one — a ✓ "no
  // database yet" and a 0.0MB footprint over a store that exists. They now say they did not look.
  it.skipIf(skip)('doctor does not grade the locked store as absent or empty', () => {
    const { s, restore } = locked();
    try {
      const r = run(s, ['doctor']);
      expect(r.stdout).not.toMatch(/DB schema: no database yet/);
      expect(r.stdout).not.toMatch(/Database: not found/);
      expect(r.stdout).not.toMatch(/✓ Disk footprint/);
      for (const what of ['DB schema', 'Database', 'Disk footprint']) {
        expect(r.stdout).toMatch(new RegExp(`⚠ ${what}: not checked — .* is not accessible`));
      }
    } finally {
      restore();
    }
  });
  // Default shape: the code and the data share ~/.claude-mem-lite, so the entry-point check
  // read the locked dir as an install with no server.mjs and added two issues to the one above.
  it.skipIf(skip)('doctor does not call the entry points missing when the shared dir is locked', () => {
    const s = sandbox();
    const dir = join(s.home, '.claude-mem-lite');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'server.mjs'), '');
    writeFileSync(join(dir, 'hook.mjs'), '');
    chmodSync(dir, 0o000);
    try {
      const env = { ...process.env, HOME: s.home, TMPDIR: s.root, PATH: `${s.bin}:${process.env.PATH}` };
      env.CLAUDE_MEM_SKIP_UPDATE = '1';
      env.MEM_NO_AUTO_ADOPT = '1';
      for (const k of ['CLAUDE_MEM_DIR', 'CLAUDE_CONFIG_DIR', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'])
        delete env[k];
      const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
        cwd: s.root,
        encoding: 'utf8',
        timeout: 60_000,
        env,
      });
      expect(r.stdout).toMatch(/✗ Data directory: .*not accessible/);
      expect(r.stdout).not.toMatch(/server\.mjs: missing/);
      expect(r.stdout).not.toMatch(/hook\.mjs: missing/);
      expect(r.stdout).toMatch(/⚠ Entry points: not checked — .* is not accessible/);
      // The two drift checks read the same dir as a never-deployed install.
      expect(r.stdout).not.toMatch(/no claude-mem-lite code is deployed/);
      expect(r.stdout).not.toMatch(/Hook scripts: .* is absent/);
      for (const what of ['Managed files', 'Hook scripts']) {
        expect(r.stdout).toMatch(new RegExp(`⚠ ${what}: not checked — .* is not accessible`));
      }
    } finally {
      chmodSync(dir, 0o755);
    }
  });
  // Under CLAUDE_MEM_DIR the data dir is fine and only the code dir is locked: nothing above
  // reports it, so the entry-point line is the ✗ and carries the fix.
  it.skipIf(skip)('a locked code dir under relocation is one ✗ with its fix, not two missing files', () => {
    const s = sandbox();
    mkdirSync(join(s.root, 'data'), { recursive: true });
    const dir = join(s.home, '.claude-mem-lite');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'server.mjs'), '');
    chmodSync(dir, 0o000);
    try {
      const r = run(s, ['doctor']);
      expect(r.stdout).not.toMatch(/Data directory: .*not accessible/);
      expect(r.stdout).not.toMatch(/server\.mjs: missing/);
      expect(r.stdout).toMatch(
        new RegExp(`✗ Entry points: ${dir} is not accessible \\(EACCES\\) — Fix: chmod u\\+rwx`),
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // Pre-tag review of D#199. Every case above sets CLAUDE_MEM_SKIP_UPDATE, which answers Update
  // state before it looks; with checks on (the default) it and Hook self-heal still graded the
  // locked dir ("no state file (first run?)" over a state file that exists).
  const doctorEnv = (s, extra = {}) => {
    const env = { ...process.env, HOME: s.home, TMPDIR: s.root, PATH: `${s.bin}:${process.env.PATH}` };
    env.MEM_NO_AUTO_ADOPT = '1';
    for (const k of [
      'CLAUDE_MEM_DIR',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_MEM_RUNTIME_DIR',
      'CLAUDE_MEM_SKIP_UPDATE',
      'OPENROUTER_API_KEY',
      'ANTHROPIC_API_KEY',
    ])
      delete env[k];
    return { ...env, ...extra };
  };
  const doctor = (s, env) =>
    spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
      cwd: s.root,
      encoding: 'utf8',
      timeout: 60_000,
      env,
    });

  it.skipIf(skip)(
    'with update checks on, Update state and Hook self-heal do not grade the locked dir',
    () => {
      const s = sandbox();
      const dir = join(s.home, '.claude-mem-lite');
      mkdirSync(join(dir, 'runtime'), { recursive: true });
      writeFileSync(join(dir, 'runtime', 'update-state.json'), '{}');
      chmodSync(dir, 0o000);
      try {
        const r = doctor(s, doctorEnv(s));
        expect(r.stdout).not.toMatch(/no state file \(first run\?\)/);
        expect(r.stdout).not.toMatch(/✓ Hook self-heal/);
        for (const what of ['Update state', 'Hook self-heal']) {
          expect(r.stdout).toMatch(new RegExp(`⚠ ${what}: not checked — .* is not accessible`));
        }
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  // A dir a `sudo` run created as root is usually 755: readable, not writable. Its checks read
  // it correctly, so they run; only the ✗ says what is wrong (review P3-5).
  it.skipIf(skip)('a readable but unwritable data dir is a ✗, and the checks that read it still run', () => {
    const { s, data, restore } = locked();
    chmodSync(data, 0o500);
    try {
      const r = run(s, ['doctor']);
      expect(r.stdout).toMatch(
        new RegExp(
          `✗ Data directory: ${data} is not accessible \\(EACCES\\) — it can be read but not written`,
        ),
      );
      expect(r.stdout).not.toMatch(/not checked — .* is not accessible/);
      expect(r.stdout).toMatch(/DB schema: /);
    } finally {
      restore();
    }
  });

  // One directory spelled two ways (a trailing slash on CLAUDE_MEM_DIR) is still one directory:
  // one ✗, not a second one for the "separate" code dir (review P3-6).
  it.skipIf(skip)('CLAUDE_MEM_DIR naming the code dir with a trailing slash counts the lock once', () => {
    const s = sandbox();
    const dir = join(s.home, '.claude-mem-lite');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    chmodSync(dir, 0o000);
    try {
      const r = doctor(s, doctorEnv(s, { CLAUDE_MEM_DIR: `${dir}/`, CLAUDE_MEM_SKIP_UPDATE: '1' }));
      expect(r.stdout).not.toMatch(/✗ Entry points/);
      expect(r.stdout).toMatch(/⚠ Entry points: not checked/);
      // The sandbox's settings.json carries a fixture hook, so count the lock's own ✗ lines.
      expect(r.stdout.match(/✗ .* is not accessible/g)).toHaveLength(1);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // D#284. status asked for read, write AND search access, so the 755 a `sudo` run leaves owned
  // by root printed "not accessible" and dropped the counts it could read (6.24.0 printed them).
  // The store is WAL (schema.mjs), as every real one is: a read-only open needs <db>-shm, which
  // SQLite creates in the directory unless a live connection already holds it.
  function walStore(s) {
    const data = join(s.root, 'data');
    mkdirSync(data, { recursive: true });
    const db = new Database(join(data, 'claude-mem-lite.db'));
    db.pragma('journal_mode = WAL');
    db.exec(
      'CREATE TABLE observations (id INTEGER); CREATE TABLE session_summaries (memory_session_id TEXT);',
    );
    db.exec("INSERT INTO observations VALUES (1), (2); INSERT INTO session_summaries VALUES ('s1');");
    return { data, db };
  }
  it.skipIf(skip)('status reads the counts of a readable but unwritable data dir, under its ✗', () => {
    const s = sandbox();
    const { data, db } = walStore(s); // held open: -wal and -shm exist
    expect(run(s, ['status']).stdout).toMatch(/✓ Database: 2 observations, 1 sessions/); // premise
    chmodSync(data, 0o500);
    try {
      const r = run(s, ['status']);
      expect(r.stdout).toMatch(
        new RegExp(
          `✗ Database: 2 observations, 1 sessions — ${data} can be read but not written \\(EACCES\\)`,
        ),
      );
      expect(r.stdout).toContain(`chmod u+rwx ${data}`);
      const j = JSON.parse(run(s, ['status', '--json']).stdout);
      expect(j.database).toMatchObject({ level: 'fail', exists: true, observations: 2, error: 'EACCES' });
    } finally {
      chmodSync(data, 0o755);
      db.close();
    }
  });
  // Closed, as a `sudo` run leaves it: SQLite cannot read it there at all (D#284 review P2-1). The
  // line says why instead of passing on SQLite's "attempt to write a readonly database", and the
  // JSON keeps the errno a consumer keys on.
  // The errno replaces SQLite's message only where the directory is the cause: a corrupt store in the
  // same dir is still reported as corrupt to a JSON consumer (D#284 review round 2, F7).
  it.skipIf(skip)('status --json names a corrupt store in an unwritable dir by its own error', () => {
    const s = sandbox();
    const data = join(s.root, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'claude-mem-lite.db'), 'this is not an sqlite database, just text '.repeat(200));
    chmodSync(data, 0o500);
    try {
      const j = JSON.parse(run(s, ['status', '--json']).stdout);
      expect(j.database).toMatchObject({ level: 'fail', exists: true });
      expect(j.database.error).toMatch(/not a database/);
    } finally {
      chmodSync(data, 0o755);
    }
  });
  it.skipIf(skip)('status says why a closed WAL store in an unwritable dir has no counts', () => {
    const s = sandbox();
    const { data, db } = walStore(s);
    db.close(); // checkpoints and removes -wal / -shm
    expect(existsSync(join(data, 'claude-mem-lite.db-shm'))).toBe(false); // premise
    chmodSync(data, 0o500);
    try {
      const r = run(s, ['status']);
      expect(r.stdout).toMatch(
        new RegExp(
          `✗ Database: exists, but SQLite cannot open a WAL database without creating its -wal/-shm files beside it — ${data} can be read but not written \\(EACCES\\)`,
        ),
      );
      expect(r.stdout).not.toMatch(/attempt to write a readonly database/);
      const j = JSON.parse(run(s, ['status', '--json']).stdout);
      expect(j.database).toMatchObject({ level: 'fail', exists: true, error: 'EACCES' });
    } finally {
      chmodSync(data, 0o755);
    }
  });

  // D#287. doctor over the same closed store relayed SQLite's "attempt to write a readonly
  // database" on three lines, and its ✗ Database counted a second issue for the fault the
  // ✗ Data directory line already names and counts (the D#199 shape). The lines now say they did
  // not look, and why, in status's words.
  it.skipIf(skip)('doctor says why it could not check a closed WAL store in an unwritable dir', () => {
    const s = sandbox();
    const { data, db } = walStore(s);
    db.exec('CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (1);');
    db.close();
    chmodSync(data, 0o500);
    try {
      const r = run(s, ['doctor']);
      expect(r.stdout).toMatch(/✗ Data directory: .*it can be read but not written/); // premise
      expect(r.stdout).not.toMatch(/attempt to write a readonly database/);
      expect(r.stdout).not.toMatch(/✗ Database/);
      for (const what of ['DB schema', 'Database', 'DB stats']) {
        expect(r.stdout).toMatch(
          new RegExp(
            `⚠ ${what}: not checked.* — SQLite cannot open a WAL database without creating its -wal/-shm files beside it`,
          ),
        );
      }
    } finally {
      chmodSync(data, 0o755);
    }
  });

  // D#284. The breakage marker sits in the locked dir, so it read as absent and the line said ✓.
  it.skipIf(skip)('doctor does not put a ✓ on a native-binding marker it could not read', () => {
    const s = sandbox();
    const dir = join(s.home, '.claude-mem-lite');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(
      join(dir, 'runtime', 'native-binding-broken'),
      JSON.stringify({ reason: 'abi', ts: Date.now() }),
    );
    const env = doctorEnv(s, { CLAUDE_MEM_SKIP_UPDATE: '1' });
    expect(doctor(s, env).stdout).toMatch(/⚠ Native DB binding: healthy now, but a fire failed/); // premise
    chmodSync(dir, 0o000);
    try {
      const r = doctor(s, env);
      expect(r.stdout).not.toMatch(/✓ Native DB binding/);
      expect(r.stdout).toMatch(/⚠ Native DB binding: .*not checked — .* is not accessible/);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  // Guards for two branches nothing exercised (D#284). A runtime dir moved OUT of the locked data
  // dir by CLAUDE_MEM_RUNTIME_DIR is readable, so the checks that read it still run.
  it.skipIf(skip)('a runtime dir outside the locked data dir is still read', () => {
    const { s, restore } = locked();
    const runtime = join(s.root, 'elsewhere');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'hook-launcher-broken'), JSON.stringify({ reason: 'gone', ts: Date.now() }));
    writeFileSync(join(runtime, 'native-binding-broken'), JSON.stringify({ reason: 'abi', ts: Date.now() }));
    try {
      const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
        cwd: s.root,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...doctorEnv(s, { CLAUDE_MEM_SKIP_UPDATE: '1' }),
          CLAUDE_MEM_DIR: join(s.root, 'data'),
          CLAUDE_MEM_RUNTIME_DIR: runtime,
        },
      });
      expect(r.stdout).toMatch(/✗ Data directory: .*not accessible/); // premise: the data dir is locked
      expect(r.stdout).toMatch(/⚠ Hook self-heal: a recent hook fire degraded to exit-0 \(last: gone/);
      expect(r.stdout).toMatch(/⚠ Native DB binding: healthy now, but a fire failed/);
    } finally {
      restore();
    }
  });

  // One directory reached through a symlinked HOME and through its real path is still one
  // directory: one ✗, not a second one for the "separate" code dir (D#284; review P3-6 pinned only
  // the trailing slash, which resolve() alone also fixes).
  it.skipIf(skip)('a symlinked HOME and the real path count one locked dir once', () => {
    const s = sandbox();
    const linkHome = join(s.root, 'home-link');
    symlinkSync(s.home, linkHome);
    const dir = join(s.home, '.claude-mem-lite');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    chmodSync(dir, 0o000);
    try {
      const env = { ...doctorEnv(s, { CLAUDE_MEM_DIR: dir, CLAUDE_MEM_SKIP_UPDATE: '1' }), HOME: linkHome };
      const r = doctor(s, env);
      expect(r.stdout).toMatch(/✗ Data directory: .*not accessible/);
      expect(r.stdout).not.toMatch(/✗ Entry points/);
      expect(r.stdout).toMatch(/⚠ Entry points: not checked/);
      expect(r.stdout.match(/✗ .* is not accessible/g)).toHaveLength(1);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

// A failed `repair` left its staging dir behind: the catch ended in process.exit(1), which
// skips the finally that removes it. repair is also what hook-launcher runs on its own after
// an ERR_MODULE_NOT_FOUND, so an offline machine gained a `claude-mem-lite-repair-*` dir per
// attempt. Network stubbed out with a preloaded fetch that rejects.
describe('a failed repair cleans up its staging dir', () => {
  it('exits 1 and leaves no claude-mem-lite-repair-* dir', async () => {
    const { readdirSync } = await import('node:fs');
    const s = sandbox();
    const offline = 'data:text/javascript,globalThis.fetch=()=>Promise.reject(new Error("offline"))';
    const r = spawnSync(process.execPath, ['--import', offline, join(REPO, 'install.mjs'), 'repair'], {
      cwd: s.root,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: s.home,
        TMPDIR: s.root,
        PATH: `${s.bin}:${process.env.PATH}`,
        CLAUDE_MEM_DIR: join(s.root, 'data'),
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_NO_AUTO_ADOPT: '1',
        // Load-bearing: with any of these set, the release lookup takes the CONNECT tunnel,
        // which never calls globalThis.fetch. On a proxy-bound machine this test then passed
        // only because the tunnel sent `Host: api.github.com:80` and GitHub answered 400;
        // once that was fixed, the "offline" repair ran a real one for 17 s.
        HTTPS_PROXY: '',
        https_proxy: '',
        HTTP_PROXY: '',
        http_proxy: '',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Repair failed/);
    expect(readdirSync(s.root).filter((n) => n.startsWith('claude-mem-lite-repair-'))).toEqual([]);
  });
});

// uninstall printed "run `claude-mem-lite unadopt --all` — best done BEFORE uninstall, while
// the CLI is still on PATH" right after it had removed that CLI link: advice the reader could
// no longer follow. It now names a command that still runs.
describe('uninstall names an unadopt command that still works afterwards', () => {
  it('points at the kept cli.mjs, or at npx when the code is gone', () => {
    const s = sandbox();
    const r = run(s, ['uninstall']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/while the CLI is still on PATH/);
    expect(r.stdout).toMatch(/npx claude-mem-lite unadopt --all|cli\.mjs"? unadopt --all/);
  });
});

// D#287. accessSync(W_OK) on a read-only mount fails with EROFS, and every face printed
// "Fix: chmod u+rwx <dir>", which cannot help there. The remedy is chosen by the error code; no
// call site may leave the code out (EROFS itself needs a read-only mount, which this suite cannot make).
describe('the data dir remedy follows the error', () => {
  it('a read-only file system is not a chmod problem', async () => {
    const { dataDirAccessRemedy } = await import('../install.mjs');
    expect(dataDirAccessRemedy('EROFS')).toMatch(/mounted read-only/);
    expect(dataDirAccessRemedy('EROFS')).not.toMatch(/chmod/);
    expect(dataDirAccessRemedy('EACCES')).toMatch(/^chmod u\+rwx /);
  });
  it('every call site passes the code it is reporting', () => {
    const src = readFileSync(join(REPO, 'install.mjs'), 'utf8');
    const calls = src.match(/dataDirAccessRemedy\([^)]*\)/g) || [];
    expect(calls.length, 'premise: the call sites are found').toBeGreaterThanOrEqual(4);
    expect(calls.filter((c) => c === 'dataDirAccessRemedy()')).toEqual([]);
  });
});
