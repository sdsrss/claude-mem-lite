// Audit P3-4: a plugin disabled in the Claude UI must stop growing runtime state.
//
// Pre-fix symptom: install.mjs writes DIRECT hook entries into ~/.claude/settings.json,
// so disabling the plugin in the UI (enabledPlugins["claude-mem-lite@sdsrss"] = false)
// leaves those hooks wired. hook.mjs:114 makes the Node side exit(0) when disabled, but
// the bash pre-filter's Read fast-path never reaches Node — it appended the read path to
// runtime/reads-<project>.txt on EVERY Read. The 24h sweep that reaps those files
// (sweepOrphanEpisodeFiles, called from runSessionStartAutoMaintain) lives behind that
// same exit(0), so nothing ever collected them: unbounded growth for a disabled plugin.
//
// The bash guard must agree with hook.mjs isPluginExplicitlyDisabled() — same key, same
// file, same fail-open-on-unreadable semantics. The cases at the bottom pin that.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  chmodSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve, win32, posix } from 'path';

const SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-use.sh');
const HOOK_MJS = resolve(import.meta.dirname, '../hook.mjs');
// Imported, not re-typed. This file compares a BASH literal against the JS side, so the JS
// side has to be the shipped value — a third hand-written copy here would let the shell and
// the code drift together while the test kept agreeing with itself (#10716).
const { PLUGIN_KEY } = await import('../lib/plugin-key.mjs');

const sandboxes = [];
function sandbox(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(d);
  return d;
}
afterEach(() => {
  while (sandboxes.length) {
    const d = sandboxes.pop();
    try {
      chmodSync(join(d, '.claude', 'settings.json'), 0o600);
    } catch {
      /* not every sandbox has one */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Run the bash pre-filter on a Read event against an isolated HOME.
 * `settings` === null writes no settings.json at all.
 */
function readEvent(settings, { filePath = '/home/user/secret-project/plan.md' } = {}) {
  const home = sandbox('mem-disabled-home-');
  const memDir = sandbox('mem-disabled-data-');
  if (settings !== null) {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), settings);
  }
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify({
      session_id: 'disabled-guard-test',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_MEM_DIR: memDir,
      CLAUDE_PROJECT_DIR: '/tmp/org/proj',
      CLAUDE_MEM_HOOK_RUNNING: '',
    },
    encoding: 'utf8',
  });
  return { r, home, readsFile: join(memDir, 'runtime', 'reads-org--proj.txt') };
}

const settingsWith = (value) =>
  JSON.stringify(
    {
      model: 'opus',
      enabledPlugins: { 'some-other@vendor': true, [PLUGIN_KEY]: value },
      hooks: {
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash post-tool-use.sh' }] }],
      },
    },
    null,
    2,
  );

describe('P3-4 disabled plugin stops appending reads-<project>.txt', () => {
  it('skips the append when the plugin is explicitly disabled', () => {
    const { r, readsFile } = readEvent(settingsWith(false));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(existsSync(readsFile), 'reads file must NOT be created while the plugin is disabled').toBe(false);
  });

  it('still appends when the plugin is enabled (no false positive)', () => {
    const { r, readsFile } = readEvent(settingsWith(true));
    expect(r.status).toBe(0);
    expect(existsSync(readsFile)).toBe(true);
    expect(readFileSync(readsFile, 'utf8')).toBe('/home/user/secret-project/plan.md\n');
  });

  it('still appends when the key is absent from enabledPlugins', () => {
    const { readsFile } = readEvent(JSON.stringify({ enabledPlugins: { 'other@vendor': false } }));
    expect(existsSync(readsFile)).toBe(true);
  });

  it('fails open when settings.json does not exist', () => {
    const { r, readsFile } = readEvent(null);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(existsSync(readsFile)).toBe(true);
  });

  it('fails open when settings.json is unreadable', () => {
    const home = sandbox('mem-disabled-home-');
    const memDir = sandbox('mem-disabled-data-');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const sp = join(home, '.claude', 'settings.json');
    writeFileSync(sp, settingsWith(false));
    chmodSync(sp, 0o000);
    const r = spawnSync('bash', [SCRIPT], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x/y.mjs' } }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: memDir,
        CLAUDE_PROJECT_DIR: '/tmp/org/proj',
        CLAUDE_MEM_HOOK_RUNNING: '',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    // Unreadable settings === "cannot prove disabled" — hook.mjs's try/catch returns
    // false in the same situation, so the bash side must also treat it as enabled.
    const readsFile = join(memDir, 'runtime', 'reads-org--proj.txt');
    if (process.getuid?.() === 0) return; // root ignores mode 000; nothing to assert
    expect(existsSync(readsFile)).toBe(true);
  });

  it('keeps the owner-only perms on the append path (P3-2 stays fixed)', () => {
    const { readsFile } = readEvent(settingsWith(true));
    // umask 077 added by the sibling P3-2 fix — this asserts the disable guard did
    // not get inserted in a way that skips it.
    expect(statSync(readsFile).mode & 0o777).toBe(0o600);
  });
});

describe('bash/Node disable-detection parity', () => {
  const bash = readFileSync(SCRIPT, 'utf8');
  const nodeSrc = readFileSync(HOOK_MJS, 'utf8');

  it('the shell copy carries the same plugin key as the JS side', () => {
    // The Node key is no longer a literal in hook.mjs: audit P2-7 moved it to
    // lib/plugin-key.mjs, which install.mjs imports too. This case used to grep hook.mjs
    // for `const PLUGIN_KEY = '…'` and went RED on that move — the source-text guard whose
    // anchor legitimately relocated, which this repo has now recorded in both directions
    // (P3-16). It is anchored on the IMPORTED value instead, so the key can live anywhere
    // and only a genuine bash/JS divergence fails.
    expect(PLUGIN_KEY, 'premise: the shared module must export a non-empty key').toBeTruthy();
    expect(bash, 'post-tool-use.sh must carry the same key literal as lib/plugin-key.mjs').toContain(
      PLUGIN_KEY,
    );
    // hook.mjs must still REACH that key rather than having quietly re-typed one: an
    // inline literal here would satisfy the bash check above while being free to drift.
    expect(nodeSrc, 'hook.mjs must take the key from the shared module').toMatch(
      /from\s+'\.\/lib\/plugin-key\.mjs'/,
    );
    expect(nodeSrc, 'hook.mjs must not re-type the plugin key').not.toMatch(/const PLUGIN_KEY\s*=\s*['"]/);
  });

  // D#176: both sides read the HOST's settings.json: an absolute CLAUDE_CONFIG_DIR moves it (Claude
  // Code 2.1.292: `claude plugin list` reads enabledPlugins and installed_plugins.json from
  // there), else $HOME/.claude. A relative value is ignored on both sides. Behavioural, not a
  // source grep: each case runs the bash Read fast-path AND hook.mjs session-start against the
  // same files and asks each whether it acted.
  describe('both sides read the settings.json of the config home the host uses', () => {
    // Writes the two candidate files and returns [bashActed, nodeActed].
    function run({ homeValue, cfgValue, cfgEnv }) {
      const home = sandbox('mem-cfgdir-home-');
      const cfg = sandbox('mem-cfgdir-cfg-');
      const memDir = sandbox('mem-cfgdir-data-');
      if (homeValue !== undefined) {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'settings.json'), settingsWith(homeValue));
      }
      if (cfgValue !== undefined) writeFileSync(join(cfg, 'settings.json'), settingsWith(cfgValue));
      const env = {
        ...process.env,
        HOME: home,
        CLAUDE_MEM_DIR: memDir,
        CLAUDE_PROJECT_DIR: '/tmp/org/proj',
        CLAUDE_MEM_HOOK_RUNNING: '',
        MEM_NO_AUTO_ADOPT: '1',
        CLAUDE_CONFIG_DIR: cfgEnv === 'abs' ? cfg : cfgEnv === 'rel' ? 'relative-cfg' : cfgEnv || undefined,
      };
      if (env.CLAUDE_CONFIG_DIR === undefined) delete env.CLAUDE_CONFIG_DIR;
      spawnSync('bash', [SCRIPT], {
        input: JSON.stringify({
          session_id: 'cfg',
          tool_name: 'Read',
          tool_input: { file_path: '/x/plan.md' },
        }),
        env,
        encoding: 'utf8',
      });
      const bashActed = existsSync(join(memDir, 'runtime', 'reads-org--proj.txt'));
      spawnSync(process.execPath, [HOOK_MJS, 'session-start'], {
        input: '{}',
        env,
        cwd: home,
        encoding: 'utf8',
      });
      const nodeActed = existsSync(join(memDir, 'claude-mem-lite.db'));
      return [bashActed, nodeActed];
    }

    it('CLAUDE_CONFIG_DIR set: its opt-out holds, whatever ~/.claude says', () => {
      expect(run({ homeValue: true, cfgValue: false, cfgEnv: 'abs' })).toEqual([false, false]);
    });

    it("CLAUDE_CONFIG_DIR set: another profile's opt-out in ~/.claude does not switch this one off", () => {
      expect(run({ homeValue: false, cfgValue: true, cfgEnv: 'abs' })).toEqual([true, true]);
    });

    it('a relative CLAUDE_CONFIG_DIR is ignored: ~/.claude decides', () => {
      expect(run({ homeValue: false, cfgValue: true, cfgEnv: 'rel' })).toEqual([false, false]);
    });

    it('premise: unset, ~/.claude decides both ways', () => {
      expect(run({ homeValue: false, cfgEnv: '' })).toEqual([false, false]);
      expect(run({ homeValue: true, cfgEnv: '' })).toEqual([true, true]);
    });

    // D#269: bash took a drive letter as absolute on every OS; Node's isAbsolute rejects it here.
    it('a drive-letter value is relative off Windows on both sides: ~/.claude decides', () => {
      expect(run({ homeValue: false, cfgValue: true, cfgEnv: 'C:/cfg' })).toEqual([false, false]);
    });
  });

  // D#269: on Windows, Node's isAbsolute also takes a leading backslash (UNC, root of the drive),
  // which bash called relative. Node cannot be put in win32 mode here, so bash is held to
  // path.win32 / path.posix directly: it runs with OSTYPE set (bash keeps an inherited value) in a
  // cwd holding `<value>/settings.json` that switches the plugin off, so it acts exactly when it
  // calls the value relative and reads the enabled ~/.claude instead.
  describe('bash takes the CLAUDE_CONFIG_DIR values Node takes as absolute on that platform', () => {
    const VALUES = ['C:/cfg', 'C:\\cfg', '\\\\srv\\cfg', '\\cfg', 'C:cfg', 'cfg'];
    function bashActs(value, ostype) {
      const home = sandbox('mem-cfgabs-home-');
      const cwd = sandbox('mem-cfgabs-cwd-');
      const memDir = sandbox('mem-cfgabs-data-');
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), settingsWith(true));
      mkdirSync(join(cwd, value), { recursive: true });
      writeFileSync(join(cwd, value, 'settings.json'), settingsWith(false));
      const env = {
        ...process.env,
        HOME: home,
        OSTYPE: ostype,
        CLAUDE_CONFIG_DIR: value,
        CLAUDE_MEM_DIR: memDir,
        CLAUDE_PROJECT_DIR: '/tmp/org/proj',
        CLAUDE_MEM_HOOK_RUNNING: '',
      };
      spawnSync('bash', [SCRIPT], {
        input: JSON.stringify({
          session_id: 'cfg',
          tool_name: 'Read',
          tool_input: { file_path: '/x/plan.md' },
        }),
        env,
        cwd,
        encoding: 'utf8',
      });
      return existsSync(join(memDir, 'runtime', 'reads-org--proj.txt'));
    }

    it('a Windows shell (OSTYPE=msys, cygwin) follows path.win32.isAbsolute', () => {
      for (const ostype of ['msys', 'cygwin']) {
        const got = VALUES.map((v) => [v, bashActs(v, ostype) ? 'relative' : 'absolute']);
        expect(got, ostype).toEqual(VALUES.map((v) => [v, win32.isAbsolute(v) ? 'absolute' : 'relative']));
        expect(new Set(got.map(([, k]) => k)).size, 'premise: the values split both ways').toBe(2);
      }
    });

    it('elsewhere (OSTYPE=linux-gnu) follows path.posix.isAbsolute', () => {
      const got = VALUES.map((v) => [v, bashActs(v, 'linux-gnu') ? 'relative' : 'absolute']);
      expect(got).toEqual(VALUES.map((v) => [v, posix.isAbsolute(v) ? 'absolute' : 'relative']));
    });

    // setup.sh decides the same question for the files it edits; its behaviour is in
    // install-lifecycle, this holds the two copies of the rule together.
    it('setup.sh carries the same _mem_is_abs body', () => {
      const body = (src) => src.match(/^_mem_is_abs\(\) \{\n[\s\S]*?\n\}$/m)?.[0];
      const here = body(readFileSync(SCRIPT, 'utf8'));
      expect(here, 'premise: post-tool-use.sh defines it').toMatch(/msys/);
      expect(body(readFileSync(resolve(import.meta.dirname, '../scripts/setup.sh'), 'utf8'))).toBe(here);
    });
  });
});
