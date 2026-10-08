// doctor / status / rebuild-binding, driven as SUBPROCESSES against real install shapes.
//
// Why this file exists (pre-tag review, BLOCKER-1): the v3.70.0 change to the
// diagnose→repair chain is ~161 lines in install.mjs, and reverting install.mjs to
// its pre-fix state left the whole 4584-test suite green. tests/install-shape.test.mjs
// covers the extracted helper, but the helper was never the bug — install.mjs asking
// the WRONG helper was. That is exactly the shape of the v3.60 outage: shipped green,
// broken for four days. So these tests assert the user-visible verdicts:
//
//   plugin-only + healthy            → exit 0, no ✗
//   managed tree's binding stale     → exit 1, and the message names THAT tree
//   rebuild-binding, broken non-host → exit 1 (not "success" on the healthy tree)
//
// Each case builds a HOME with real, resolvable trees. `withRealDeps` re-exports the
// repo's compiled better-sqlite3 through a per-root shim so every root is a DISTINCT
// path (dedup keys on the binding's realpath, so sharing one tree would collapse the
// roots and make multi-root assertions pass for the wrong reason).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  copyFileSync,
  chmodSync,
  cpSync,
  readFileSync,
} from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { SOURCE_FILES } from '../source-files.mjs';
import { shellWord } from '../cli-path.mjs';
import Database from 'better-sqlite3';

const INSTALL_PATH = resolve(import.meta.dirname, '../install.mjs');
const REPO = resolve(import.meta.dirname, '..');
let home;

function withRealDeps(root) {
  const pkgDir = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }));
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '12.10.0', main: 'index.js' }),
  );
  writeFileSync(
    join(pkgDir, 'index.js'),
    `module.exports = require(${JSON.stringify(join(REPO, 'node_modules', 'better-sqlite3'))});\n`,
  );
  return root;
}

/** Present but unloadable — the stale-ABI shape, reachable via a real require(). */
function withBrokenDeps(root) {
  const pkgDir = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version: '9.9.9' }));
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '12.10.0', main: 'index.js' }),
  );
  writeFileSync(
    join(pkgDir, 'index.js'),
    'throw new Error("Could not locate the bindings file. Tried: fixture-stale-abi");\n',
  );
  return root;
}

function pluginCacheDir(version) {
  return join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', version);
}

function makePluginVersion(version, { deps = 'real' } = {}) {
  const root = pluginCacheDir(version);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'launch.mjs'), '// launcher\n');
  for (const f of ['cli.mjs', 'server.mjs', 'hook.mjs']) writeFileSync(join(root, f), '// x\n');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [] }] } }),
  );
  if (deps === 'real') withRealDeps(root);
  else if (deps === 'broken') withBrokenDeps(root);
  else writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'claude-mem-lite', version }));
  return root;
}

function makeManagedInstall({ deps = 'real' } = {}) {
  const root = join(home, '.claude-mem-lite');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  for (const f of ['server.mjs', 'hook.mjs', 'cli.mjs', 'mem-cli.mjs', 'install.mjs']) {
    writeFileSync(join(root, f), '// x\n');
  }
  if (deps === 'real') withRealDeps(root);
  else if (deps === 'broken') withBrokenDeps(root);
  return root;
}

function enablePlugin() {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify(
      {
        enabledPlugins: { 'claude-mem-lite@sdsrss': true },
      },
      null,
      2,
    ),
  );
}

function run(cmd, extraEnv = {}) {
  const env = { ...process.env, HOME: home, CLAUDE_MEM_SKIP_REPOS: '1' };
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_PLUGIN_ROOT$/.test(k)) delete env[k];
  }
  Object.assign(env, extraEnv);
  try {
    const stdout = execFileSync(process.execPath, [INSTALL_PATH, cmd], {
      encoding: 'utf8',
      env,
      timeout: 90000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const failLines = (out) => out.split('\n').filter((l) => l.includes('✗'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-docsh-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
});
afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Each `it` here spawns install.mjs, and on a 2-core CI runner a pile of those
// starves the other vitest workers into 20s timeouts. So related assertions share
// ONE spawn per shape rather than re-running doctor for each claim.
describe('doctor: a healthy plugin-only install is not an error', () => {
  it('exits 0, flags nothing, and prescribes nothing that does not exist', () => {
    makePluginVersion('3.69.1');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    const r = run('doctor');
    expect(failLines(r.stdout), `doctor flagged a healthy plugin-only install:\n${r.stdout}`).toEqual([]);
    expect(r.code, `doctor exited ${r.code}\n${r.stdout}`).toBe(0);
    // The managed layout is not this install shape's to satisfy.
    expect(r.stdout).not.toMatch(/✗ server\.mjs: missing/);
    expect(r.stdout).not.toMatch(/✗ hook\.mjs: missing/);
    expect(r.stdout).not.toMatch(/Managed files: \d+ missing/);
    // `update` is the observation editor; the self-updater is `self-update`.
    expect(r.stdout).not.toMatch(/claude-mem-lite update(?!\s*<)/);
  });

  it('still FAILS a plugin-only install whose cache entry point is gone', () => {
    const root = makePluginVersion('3.69.1');
    rmSync(join(root, 'server.mjs'));
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    const r = run('doctor');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Plugin cache v3\.69\.1: server\.mjs missing/);
  });
});

// D#284 (found beside it). With no install to probe — a checkout before `npm install`, no
// managed tree, no plugin — doctor said "✗ no install on this machine owns a native binding" and,
// further down, "✓ Native DB binding: loadable": a ✓ that nothing had been probed for.
describe('doctor: nothing to probe is not a loadable binding', () => {
  const doctorFrom = (checkout, extraEnv = {}, cmd = 'doctor') => {
    const env = { ...process.env, HOME: home, CLAUDE_MEM_SKIP_REPOS: '1', CLAUDE_MEM_SKIP_UPDATE: '1' };
    for (const k of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_MEM_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_MEM_RUNTIME_DIR'])
      delete env[k];
    env.MEM_NO_AUTO_ADOPT = '1';
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, [join(checkout, 'install.mjs'), cmd], {
      cwd: home,
      encoding: 'utf8',
      env,
      timeout: 90000,
    });
  };
  const checkoutWithoutDeps = () => {
    const checkout = join(home, 'checkout');
    for (const rel of SOURCE_FILES) {
      if (!existsSync(join(REPO, rel))) continue;
      mkdirSync(dirname(join(checkout, rel)), { recursive: true });
      copyFileSync(join(REPO, rel), join(checkout, rel));
    }
    return checkout;
  };

  it('prints the ✗ and no ✓ for the binding', () => {
    const checkout = checkoutWithoutDeps();
    // A marker it can read is still reported, without the "healthy now" it used to come with.
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    writeFileSync(
      join(home, '.claude-mem-lite', 'runtime', 'native-binding-broken'),
      JSON.stringify({ reason: 'abi', ts: Date.now() }),
    );
    const r = doctorFrom(checkout);
    expect(r.stdout).toMatch(/✗ better-sqlite3: no install on this machine owns a native binding/); // premise
    expect(r.stdout).not.toMatch(/✓ Native DB binding/);
    expect(r.stdout).toMatch(
      /⚠ Native DB binding: not checked — no install on this machine owns a native binding to probe; a fire failed ~0h ago \(abi\)/,
    );
  });

  // D#287 (pre-existing): "Database: not found (will be created)" sat beside "nothing here can
  // open the DB". Nothing here can create it either.
  it('does not promise to create a database that nothing here can open', () => {
    const checkout = checkoutWithoutDeps();
    const r = doctorFrom(checkout);
    expect(r.stdout).toMatch(/✗ better-sqlite3: no install on this machine owns a native binding/); // premise
    expect(r.stdout).toMatch(/⚠ Database: not found/);
    expect(r.stdout).not.toMatch(/will be created/);
  });

  // D#284 review P3-4. The managed install DOES own a working binding, inside a dir this process
  // cannot enter: "no install owns one" is a claim the lock kept it from checking.
  it.skipIf(process.getuid?.() === 0)(
    'says "not checked", not "no install owns one", when the managed dir is locked',
    () => {
      const checkout = checkoutWithoutDeps();
      const managed = makeManagedInstall();
      expect(doctorFrom(checkout).stdout).toMatch(
        /✓ better-sqlite3: verified in 1 install \(managed install/,
      ); // premise
      chmodSync(managed, 0o000);
      try {
        const r = doctorFrom(checkout);
        expect(r.stdout).toMatch(/✗ Data directory: .*not accessible/);
        expect(r.stdout).not.toMatch(/no install on this machine owns a native binding/);
        expect(r.stdout).toMatch(/⚠ better-sqlite3: not checked — .* is not accessible/);
        expect(r.stdout).toMatch(/⚠ Native DB binding: not checked — .* is not accessible/);
      } finally {
        chmodSync(managed, 0o755);
      }
    },
  );

  // Same, with the data dir relocated and readable (D#284 review round 2, F5/F6): DB schema still
  // said "no install … owns a native binding", and the binding line dropped a marker it could read.
  it.skipIf(process.getuid?.() === 0)('the relocated shape says the same and keeps the marker', () => {
    const checkout = checkoutWithoutDeps();
    const managed = makeManagedInstall();
    const data = join(home, 'data');
    mkdirSync(join(data, 'runtime'), { recursive: true });
    writeFileSync(join(data, 'claude-mem-lite.db'), '');
    writeFileSync(
      join(data, 'runtime', 'native-binding-broken'),
      JSON.stringify({ reason: 'abi', ts: Date.now() }),
    );
    chmodSync(managed, 0o000);
    try {
      const r = doctorFrom(checkout, { CLAUDE_MEM_DIR: data });
      expect(r.stdout).toMatch(/Entry points: .* is not accessible/); // premise: the code home is locked
      expect(r.stdout).not.toMatch(/no install on this machine owns a native binding/);
      expect(r.stdout).toMatch(/⚠ DB schema: not checked — .* is not accessible/);
      expect(r.stdout).toMatch(
        /⚠ Native DB binding: not checked — .* is not accessible; a fire failed ~0h ago \(abi\)/,
      );
    } finally {
      chmodSync(managed, 0o755);
    }
  });

  // D#297 (v6.25.1 defect review P3-7). A store this doctor has no binding to open was a second ✗
  // ("Database: Cannot find package 'better-sqlite3'") beside the better-sqlite3 line that already
  // named the fault, and DB stats relayed the same message.
  for (const locked of [false, true]) {
    it.skipIf(locked && process.getuid?.() === 0)(
      `a store with no binding to open it is not checked, not a second ✗ (${locked ? 'code home locked' : 'no install'})`,
      () => {
        const checkout = checkoutWithoutDeps();
        const managed = locked ? makeManagedInstall() : null;
        const data = join(home, 'data');
        mkdirSync(join(data, 'runtime'), { recursive: true });
        const db = new Database(join(data, 'claude-mem-lite.db'));
        db.exec('CREATE TABLE observations (id INTEGER)');
        db.close();
        if (managed) chmodSync(managed, 0o000);
        try {
          const r = doctorFrom(checkout, { CLAUDE_MEM_DIR: data });
          expect(r.stdout).toMatch(/better-sqlite3: (no install|not checked)/); // premise: no binding here
          expect(r.stdout).not.toMatch(/Cannot find package 'better-sqlite3'/);
          expect(r.stdout).toMatch(/⚠ Database: not checked — better-sqlite3 cannot be loaded from /);
          // Review P3-4: "see better-sqlite3 above" could point at a ✓ for another install.
          expect(r.stdout).not.toMatch(/see better-sqlite3 above/);
          expect(r.stdout).toMatch(/⚠ DB stats: not checked — /);
          const st = doctorFrom(checkout, { CLAUDE_MEM_DIR: data }, 'status');
          expect(st.stdout).not.toMatch(/Cannot find package 'better-sqlite3'/);
          expect(st.stdout).toMatch(/Database: exists, but not checked — better-sqlite3 cannot be loaded/);
        } finally {
          if (managed) chmodSync(managed, 0o755);
        }
      },
    );
  }

  // Review P3-4: the same for a binding that is there but will not load (a stale ABI, a damaged
  // prebuild): the better-sqlite3 line counts it, and Database counted it again. The addon is a real
  // file Node fails to dlopen (ERR_DLOPEN_FAILED, "invalid ELF header"), loaded the way
  // better-sqlite3 13's lib/binding.js loads one, so the error is the shape the shipped dependency
  // throws for a damaged prebuild, not a message written for the test.
  it('a store whose binding will not load is not checked, not a second ✗', () => {
    const checkout = checkoutWithoutDeps();
    const pkgDir = join(checkout, 'node_modules', 'better-sqlite3');
    mkdirSync(join(pkgDir, 'build', 'Release'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'better-sqlite3', version: '13.0.3', main: 'index.js' }),
    );
    writeFileSync(join(pkgDir, 'build', 'Release', 'better_sqlite3.node'), 'not an ELF object\n');
    writeFileSync(
      join(pkgDir, 'index.js'),
      "module.exports = require(require('path').join(__dirname, 'build', 'Release', 'better_sqlite3.node'));\n",
    );
    const data = join(home, 'data');
    mkdirSync(join(data, 'runtime'), { recursive: true });
    const db = new Database(join(data, 'claude-mem-lite.db'));
    db.exec('CREATE TABLE observations (id INTEGER)');
    db.close();
    const r = doctorFrom(checkout, { CLAUDE_MEM_DIR: data });
    expect(r.stdout).toMatch(/✗ better-sqlite3 unusable in running CLI/); // premise: counted there
    expect(r.stdout).not.toMatch(/✗ Database/);
    expect(r.stdout).toMatch(/⚠ Database: not checked — better-sqlite3 cannot be loaded from /);
    expect(r.stdout).toMatch(/⚠ DB stats: not checked — /);
    const st = doctorFrom(checkout, { CLAUDE_MEM_DIR: data }, 'status');
    expect(st.stdout).toMatch(/Database: exists, but not checked — better-sqlite3 cannot be loaded/);
  });

  // D#306. The two shapes better-sqlite3 13's own loader produces when it has no usable addon,
  // built from the shipped lib/ (copied from this repo's node_modules), not a stand-in index.js:
  //   none      — no prebuild for the platform and no source build: lib/binding.js requires
  //               build/Release/better_sqlite3.node, a plain MODULE_NOT_FOUND. Database was a
  //               second ✗ for it, because the shared classifier did not know the shape.
  //   truncated — the prebuild 13 selects, cut in half with its ELF header intact (an interrupted
  //               extract, a full disk). dlopen raises SIGBUS, and doctor's in-process Database
  //               open killed doctor (exit 135) after its out-of-process probe had already failed.
  // The prebuild's name is asked of the dependency (getPrebuildPath), never computed here.
  const shipped13Loader = (checkout, prebuild) => {
    const src = join(REPO, 'node_modules', 'better-sqlite3');
    const pkgDir = join(checkout, 'node_modules', 'better-sqlite3');
    mkdirSync(pkgDir, { recursive: true });
    cpSync(join(src, 'lib'), join(pkgDir, 'lib'), { recursive: true });
    copyFileSync(join(src, 'package.json'), join(pkgDir, 'package.json'));
    if (prebuild === 'truncated') {
      const real = createRequire(import.meta.url)(join(src, 'lib', 'binding.js')).getPrebuildPath();
      const bytes = readFileSync(real);
      mkdirSync(join(pkgDir, 'prebuilds'), { recursive: true });
      writeFileSync(join(pkgDir, 'prebuilds', basename(real)), bytes.subarray(0, bytes.length >> 1));
    }
  };
  const hasPrebuild = (() => {
    try {
      return !!createRequire(import.meta.url)(
        join(REPO, 'node_modules', 'better-sqlite3', 'lib', 'binding.js'),
      ).getPrebuildPath();
    } catch {
      return false;
    }
  })();
  for (const prebuild of ['none', 'truncated']) {
    it.skipIf(prebuild === 'truncated' && !hasPrebuild)(
      `a store whose 13.x addon is ${prebuild === 'none' ? 'missing' : 'truncated'} is not checked, and doctor survives it`,
      () => {
        const checkout = checkoutWithoutDeps();
        shipped13Loader(checkout, prebuild);
        const data = join(home, 'data');
        mkdirSync(join(data, 'runtime'), { recursive: true });
        const db = new Database(join(data, 'claude-mem-lite.db'));
        db.exec('CREATE TABLE observations (id INTEGER)');
        db.close();
        const r = doctorFrom(checkout, { CLAUDE_MEM_DIR: data });
        expect(r.signal).toBeNull();
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/✗ better-sqlite3 unusable in running CLI/); // premise: counted there
        expect(r.stdout).not.toMatch(/✗ Database/);
        expect(r.stdout).toMatch(/⚠ Database: not checked — better-sqlite3 cannot be loaded from /);
        expect(r.stdout).toMatch(/⚠ DB stats: not checked — /);
        const st = doctorFrom(checkout, { CLAUDE_MEM_DIR: data }, 'status');
        expect(st.signal).toBeNull();
        expect(st.stdout).toMatch(/Database: exists, but not checked — better-sqlite3 cannot be loaded/);
      },
    );
  }

  // P3-7, first half: settings.json hooks that point into a code home this user cannot enter were
  // "missing files", a second ✗ for the fault the Entry points line names.
  it.skipIf(process.getuid?.() === 0)(
    'hooks pointing into a locked code home are not checked, not orphans',
    () => {
      const managed = makeManagedInstall();
      mkdirSync(join(managed, 'scripts'), { recursive: true });
      writeFileSync(join(managed, 'scripts', 'hook-launcher.mjs'), '// x\n');
      const data = join(home, 'data');
      mkdirSync(join(data, 'runtime'), { recursive: true });
      mkdirSync(join(home, '.claude'), { recursive: true });
      const command = `node "${join(managed, 'scripts', 'hook-launcher.mjs')}" hook.mjs stop`;
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
      );
      expect(doctorFrom(REPO, { CLAUDE_MEM_DIR: data }).stdout).toMatch(/✓ Orphan hooks: none/); // premise
      chmodSync(managed, 0o000);
      try {
        const r = doctorFrom(REPO, { CLAUDE_MEM_DIR: data });
        expect(r.stdout).toMatch(/Entry points: .* is not accessible/); // premise: the code home is locked
        expect(r.stdout).not.toMatch(/✗ Orphan hooks/);
        expect(r.stdout).toMatch(/⚠ Orphan hooks: not checked — 2 hook target\(s\) cannot be read/);
      } finally {
        chmodSync(managed, 0o755);
      }
    },
  );
});

describe('doctor: a stale binding is found in whichever install owns it', () => {
  it('exits 1, NAMES the managed tree, and points the repair at THAT tree', () => {
    // The CLI's own tree (the repo, where install.mjs runs from) is healthy, so a
    // single-root probe answers "verified" — the v3.60 false-green.
    const managed = makeManagedInstall({ deps: 'broken' });
    const r = run('doctor');
    expect(r.code, `doctor exited ${r.code} on a broken managed tree\n${r.stdout}`).toBe(1);
    expect(r.stdout).toMatch(/better-sqlite3 unusable in .*managed install/);
    expect(r.stdout).toMatch(/Native DB binding: unusable in .*managed install/);
    // Sending the user to rebuild the healthy tree is how the pre-fix repair
    // "succeeded" while the broken install stayed broken.
    // Quoted since v4.0.2 (roots can contain spaces). The INTENT is unchanged and is what
    // this line has always been about: the repair must name THIS tree, not the healthy one.
    expect(r.stdout).toContain(`cd ${shellWord(managed)} `);
    expect(r.stdout).not.toContain(`cd ${shellWord(REPO)} `);
  });

  it('exits 1 when a CERTIFIED code home cannot load better-sqlite3 at all', () => {
    // The failure mode is ERR_MODULE_NOT_FOUND on every hook fire, which is not in
    // NATIVE_BINDING_PATTERNS, so nothing else records it either.
    //
    // Asserted on the VERDICT and the repair, not on the probe's error text: whether
    // the resolver reaches an ancestor node_modules depends on where the OS put the
    // temp dir (locally it lands under $HOME and finds one; on CI it lands under /tmp
    // and does not). Pinning the message would make this test pass or fail on the
    // machine's directory layout, which is the exact blind spot that shipped a
    // free-text pgrep match in this same release.
    const root = join(home, '.claude-mem-lite');
    mkdirSync(join(root, 'runtime'), { recursive: true });
    for (const f of ['server.mjs', 'hook.mjs']) writeFileSync(join(root, f), '// x\n');
    const r = run('doctor');
    expect(r.code, `doctor exited ${r.code} on a managed install that cannot load\n${r.stdout}`).toBe(1);
    expect(r.stdout).toMatch(/better-sqlite3 unusable in .*managed install/);
    // An absent tree needs an install; rebuilding nothing exits 0 and heals nothing.
    expect(r.stdout).toMatch(/npm install --omit=dev/);
  });

  it('ignores a stale NON-ACTIVE cache version instead of going red forever', () => {
    // Claude Code never prunes; a never-started old version stays stale after a Node
    // upgrade. Reporting it made doctor permanently red about a tree nothing loads.
    makePluginVersion('3.69.1');
    makePluginVersion('3.66.1', { deps: 'broken' });
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    const r = run('doctor');
    expect(failLines(r.stdout), `a dead cache version made doctor red:\n${r.stdout}`).toEqual([]);
    expect(r.code).toBe(0);
  });
});

describe('status: the plugin manifest doing its job is not two failures', () => {
  it('reports MCP and hooks as provided by the manifest', () => {
    makePluginVersion('3.69.1');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    const r = run('status');
    expect(r.stdout).not.toMatch(/✗ MCP server: not registered/);
    expect(r.stdout).not.toMatch(/✗ Hooks: not configured/);
    expect(r.stdout).toMatch(/provided by the plugin manifest/);
  });

  it('still FAILS when neither the plugin nor settings.json provides hooks', () => {
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({}));
    const r = run('status');
    expect(r.stdout).toMatch(/✗ Hooks: not configured/);
  });
});

// The live v3.95.0 defect: something emptied the active cache version's
// hooks/hooks.json, so Claude Code registered ZERO hooks from the next session on —
// and both commands printed green, because "settings.json holds none" + "an active
// plugin version exists" was the entire test. An emptied manifest is indistinguishable
// from a healthy npm-shape install by those two facts alone, so both now open it.
describe('an EMPTY plugin manifest is not the healthy plugin shape', () => {
  function emptyTheManifest(version) {
    writeFileSync(
      join(pluginCacheDir(version), 'hooks', 'hooks.json'),
      JSON.stringify({
        description: 'claude-mem-lite hooks',
        _note: 'Auto-cleared by hook-update.mjs post-install — prevents double hook registration',
        hooks: {},
      }),
    );
  }

  it('status goes RED, names the state, and prints a repair', () => {
    makePluginVersion('3.95.0');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    // Control: populated manifest is green, so the red below is attributable to the
    // emptying and not to the fixture's shape.
    expect(run('status').stdout).toMatch(/✓ Hooks: provided by the plugin manifest/);

    emptyTheManifest('3.95.0');
    const r = run('status');
    expect(r.stdout).toMatch(/✗ Hooks: plugin manifest v3\.95\.0 registers NO hooks \(empty\)/);
    // Which repair it prescribes depends on the marketplace copy — both branches
    // are pinned in "the repair line it prints" below. Here: it prints one.
    expect(r.stdout).toMatch(/Repair: \S/);
  });

  it('doctor goes RED and exits 1', () => {
    makePluginVersion('3.95.0');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    expect(failLines(run('doctor').stdout), 'a healthy fixture was already red').toEqual([]);

    emptyTheManifest('3.95.0');
    const r = run('doctor');
    expect(r.stdout).toMatch(/registers NO hooks \(empty\)/);
    expect(r.code, `doctor exited ${r.code} over an unregistered hook chain\n${r.stdout}`).toBe(1);
  });

  it('a missing manifest is caught too, not just an emptied one', () => {
    makePluginVersion('3.95.0');
    mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
    enablePlugin();
    expect(run('status').stdout, 'fixture was not green to begin with').toMatch(
      /✓ Hooks: provided by the plugin manifest/,
    );

    rmSync(join(pluginCacheDir('3.95.0'), 'hooks', 'hooks.json'));
    expect(run('status').stdout).toMatch(/registers NO hooks \(no-manifest\)/);
    const d = run('doctor');
    expect(d.stdout).toMatch(/registers NO hooks \(no-manifest\)/);
    expect(d.code).toBe(1);
  });

  // The prescribed repair must not be a silent no-op. `install` empties the
  // MARKETPLACE manifest as well as the cache one, so after install +
  // cleanup-hooks both are `{"hooks":{}}` and a cp between them changes nothing.
  describe('the repair line it prints', () => {
    function marketplaceHooks(body) {
      const dir = join(home, '.claude', 'plugins', 'marketplaces', 'sdsrss', 'hooks');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'hooks.json'), JSON.stringify(body));
    }

    beforeEach(() => {
      makePluginVersion('3.95.0');
      emptyTheManifest('3.95.0');
      mkdirSync(join(home, '.claude-mem-lite', 'runtime'), { recursive: true });
      enablePlugin();
    });

    it('prescribes the cp when the marketplace copy still has the hooks', () => {
      marketplaceHooks({ hooks: { SessionStart: [{ matcher: '*', hooks: [] }] } });
      const out = run('status').stdout;
      expect(out).toMatch(/Repair: cp /);
      expect(out).not.toMatch(/reinstall the plugin/);
    });

    it('prescribes a reinstall instead when the marketplace copy is empty too', () => {
      marketplaceHooks({ description: 'x', _note: 'cleared', hooks: {} });
      const out = run('status').stdout;
      expect(out).toMatch(/no usable marketplace copy to restore from — reinstall the plugin/);
      expect(out).not.toMatch(/Repair: cp /);
    });
  });
});

describe('rebuild-binding: repairs every broken tree, and says so honestly', () => {
  // One spawn: this command shells out to npm, so it is the most expensive case in
  // the file. Generous timeout for a cold 2-core runner.
  it('exits NON-zero, names the broken root, and keeps the breakage marker', () => {
    // Pre-fix this rebuilt bindingHostDir() — the healthy tree — and printed
    // `✓ ... verified`, so the documented repair reported success while the broken
    // install stayed broken.
    const managed = makeManagedInstall({ deps: 'broken' });
    const runtimeDir = join(managed, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const marker = join(runtimeDir, 'native-binding-broken.json');
    writeFileSync(marker, JSON.stringify({ ts: Date.now(), reason: 'seeded', event: 'test' }));

    const r = run('rebuild-binding');
    expect(r.code, `rebuild-binding exited ${r.code}\n${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/still unusable in .*managed install/);
    expect(r.stdout + r.stderr).toContain(managed);
    // Clearing the marker while a live tree is broken is what made the launcher
    // re-spawn npm every 6h forever (2026-08-13).
    expect(existsSync(marker), 'marker cleared while a tree was still broken').toBe(true);
  }, 120_000);
});
