// `claude-mem-lite status` shelled out to `claude mcp list` and then asked one question of
// the output: does it contain the substring `mem-lite:`. A plugin-provided server prints as
// `plugin:claude-mem-lite:mem-lite: …`, which contains it — so a plugin user was reported as
// carrying a bare-name registration they do not have, and the branch written for them was
// unreachable. Same accidental-match class as the `\bmem\b` regex v2.79.1 removed from the
// very same block.
//
// Two consequences, both fixed: status no longer runs the exec at all on a plugin install
// (the official help says approved servers are health-checked, i.e. every MCP server on the
// machine is STARTED — 2.546s wall for three servers here on 2026-09-08), and doctor gained
// the duplicate-registration check the README's mixed-install section has described for
// releases with nothing detecting it.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { nonPluginMemRegistrations, pluginIsRegistered } from '../install.mjs';
import { makeFixtureTracker } from './test-helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

// Captured from a real `claude mcp list` on 2026-09-08, trimmed. Kept verbatim rather than
// idealised — the diagnostics block below the list is where a loose parser goes wrong.
const REAL_OUTPUT = `Checking MCP server health…

plugin:claude-mem-lite:mem-lite: node /home/u/.claude/plugins/cache/sdsrss/claude-mem-lite/6.3.0/scripts/launch.mjs - ✔ Connected
plugin:code-graph-mcp:code-graph: node /home/u/.claude/plugins/cache/code-graph-mcp/0.142.0/scripts/mcp-launcher.js - ✔ Connected
plugin:context7:context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected

MCP config diagnostics ⚠

For help configuring MCP servers, see: https://code.claude.com/docs/en/mcp

[Contains warnings] Project config (shared via .mcp.json)
Location: /home/u/dev/claude-mem-lite/.mcp.json
 └ [Warning] [mem-lite] mcpServers.mem-lite: Missing environment variables: CLAUDE_PLUGIN_ROOT
`;

describe('nonPluginMemRegistrations', () => {
  it('does not count a plugin-provided server as a bare registration', () => {
    // The defect, stated as a case: the whole REAL_OUTPUT above contains `mem-lite:` three
    // times and yet holds no bare registration.
    expect(REAL_OUTPUT).toContain('mem-lite:'); // premise for the assertion below
    expect(nonPluginMemRegistrations(REAL_OUTPUT)).toEqual([]);
  });

  it('counts a bare user-scope registration', () => {
    const out = 'mem-lite: node /home/u/.claude-mem-lite/server.mjs - ✔ Connected\n';
    expect(nonPluginMemRegistrations(out)).toEqual(['mem-lite']);
  });

  it('still recognises the pre-v2.78 legacy name', () => {
    expect(nonPluginMemRegistrations('mem: node /home/u/.claude-mem-lite/server.mjs - ✔\n')).toEqual(['mem']);
  });

  it('finds the duplicate when both shapes are present', () => {
    const out = REAL_OUTPUT + 'mem-lite: node /home/u/.claude-mem-lite/server.mjs - ✔ Connected\n';
    expect(nonPluginMemRegistrations(out)).toEqual(['mem-lite']);
  });

  it('ignores the indented diagnostics lines that mention the same name', () => {
    // ` └ [Warning] [mem-lite] mcpServers.mem-lite: Missing environment variables…` is not a
    // registration. It is in REAL_OUTPUT above and the first case already depends on it, but
    // assert it directly so the reason is legible when this breaks.
    const diag = ' └ [Warning] [mem-lite] mcpServers.mem-lite: Missing environment variables: X\n';
    expect(nonPluginMemRegistrations(diag)).toEqual([]);
  });

  it('ignores unrelated `key: value` lines in the diagnostics block', () => {
    expect(nonPluginMemRegistrations('Location: /home/u/dev/x/.mcp.json\n')).toEqual([]);
  });

  it('survives empty and nullish input', () => {
    for (const v of ['', null, undefined]) expect(nonPluginMemRegistrations(v)).toEqual([]);
  });
});

// The predicate that decides whether a plugin manifest is credited with providing anything.
// It exists because `activePluginVersion` answers a DIFFERENT question — "is there a cache
// directory" — and crediting a leftover one produced a destructive remedy (pre-ship review P1).
describe('pluginIsRegistered', () => {
  function home({ recorded = false, entries = null } = {}) {
    const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-reg-')));
    mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
    if (recorded || entries) {
      writeFileSync(
        join(dir, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify(entries ?? { 'claude-mem-lite@sdsrss': { version: '1.0.0' } }),
      );
    }
    return dir;
  }

  it('is false for a cache directory with nothing recording an install', () => {
    expect(pluginIsRegistered({ home: home(), settings: {} })).toBe(false);
  });

  it('is true when installed_plugins.json records it', () => {
    expect(pluginIsRegistered({ home: home({ recorded: true }), settings: {} })).toBe(true);
  });

  it('accepts the nested `plugins` shape the registry also uses', () => {
    const h = home({ entries: { plugins: { 'claude-mem-lite@sdsrss': [{ version: '1.0.0' }] } } });
    expect(pluginIsRegistered({ home: h, settings: {} })).toBe(true);
  });

  it('is true when settings enable it, even with no registry file', () => {
    expect(
      pluginIsRegistered({ home: home(), settings: { enabledPlugins: { 'claude-mem-lite@sdsrss': true } } }),
    ).toBe(true);
  });

  it('is false when the user explicitly disabled it, whatever the registry says', () => {
    // An explicit `false` is a decision to honour — the same rule lib/plugin-key.mjs states.
    expect(
      pluginIsRegistered({
        home: home({ recorded: true }),
        settings: { enabledPlugins: { 'claude-mem-lite@sdsrss': false } },
      }),
    ).toBe(false);
  });

  it('is false — never throws — on an unparseable registry', () => {
    // Both callers sit on diagnostic paths; a corrupt registry must not take doctor down.
    const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-reg-bad-')));
    mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'plugins', 'installed_plugins.json'), '{not json');
    expect(pluginIsRegistered({ home: dir, settings: {} })).toBe(false);
  });

  it('ignores a sibling plugin from the same marketplace', () => {
    const h = home({ entries: { 'other-plugin@sdsrss': { version: '1.0.0' } } });
    expect(pluginIsRegistered({ home: h, settings: {} })).toBe(false);
  });
});

// WIRING. The parser is only half the fix; the other half is that status must not SHELL OUT
// on a plugin install. Proven by putting a `claude` on PATH that records every invocation.
describe('status does not health-check every MCP server on a plugin install', () => {
  function sandbox({ plugin, leftoverCache = false }) {
    const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-mcp-home-')));
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(home, 'claude-invocations.log');
    // A stub `claude` that records that it ran. Its output names a bare registration, so a
    // status that DOES shell out on the plugin shape would also print a different line —
    // two independent tells for one mutation.
    writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho 'mem-lite: node /x/server.mjs - ok'\n`,
    );
    chmodSync(join(bin, 'claude'), 0o755);

    if (plugin || leftoverCache) {
      const ver = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '9.9.9');
      // scripts/launch.mjs is what lib/install-shape.mjs::listPluginCacheVersions keys on —
      // a version dir without it is not counted as a code home. The first draft of this
      // fixture omitted it and the plugin case silently graded as an npm-channel install.
      mkdirSync(join(ver, 'scripts'), { recursive: true });
      writeFileSync(join(ver, 'scripts', 'launch.mjs'), '// stub\n');
      writeFileSync(join(ver, '.mcp.json'), '{"mcpServers":{}}');
      writeFileSync(join(ver, 'package.json'), '{"name":"claude-mem-lite","version":"9.9.9"}');
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      // A leftover cache is a DIRECTORY with nothing recording an install — the state
      // `/plugin uninstall` leaves behind, which this round's own README documents.
      if (plugin) {
        writeFileSync(
          join(home, '.claude', 'plugins', 'installed_plugins.json'),
          JSON.stringify({ 'claude-mem-lite@sdsrss': { version: '9.9.9' } }),
        );
      }
    }
    return { home, bin, log };
  }

  function runStatus({ plugin, leftoverCache = false }) {
    const { home, bin, log } = sandbox({ plugin, leftoverCache });
    const dataDir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-mcp-data-')));
    const r = spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'status'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
    });
    return { out: r.stdout, log };
  }

  it('shells out on the npm-channel shape (premise / control)', () => {
    // Without this the case below could pass because the stub was never reachable at all.
    const { out, log } = runStatus({ plugin: false });
    expect(existsOrEmpty(log)).toMatch(/mcp list/);
    expect(out).toMatch(/MCP server: registered/);
  });

  it('does not shell out when the plugin manifest provides the server', () => {
    const { out, log } = runStatus({ plugin: true });
    expect(existsOrEmpty(log)).toBe('');
    expect(out).toMatch(/MCP server: provided by the plugin manifest/);
  });

  it('does not credit a LEFTOVER cache directory with providing the server', () => {
    // Pre-ship review's P1. `/plugin uninstall` leaves the version dirs behind (this round's
    // own README says so), and detectInstallShape falls back to "newest cache dir" when
    // nothing recorded an install — so a working npm-channel user with an old cache dir was
    // told the manifest provides their server, and doctor told them to delete their only
    // registration. The discriminator is the RECORD, not the directory.
    const { out, log } = runStatus({ plugin: false, leftoverCache: true });
    expect(out).toMatch(/MCP server: registered/);
    expect(out).not.toMatch(/provided by the plugin manifest/);
    // It must fall back to asking, which is the pre-fix behaviour and the correct one here.
    expect(existsOrEmpty(log)).toMatch(/mcp list/);
  });
});

// The counterpart: the exec moved to doctor, and it now answers a question nothing answered
// before — is the server registered TWICE. The README's "Mixed-install residue" section has
// described that state since v3 (a plugin user who once ran the npx installer keeps a
// bare-name registration alongside the manifest's), and orphan hooks had a check for their
// half of it while MCP had none.
describe('doctor detects a duplicate MCP registration', () => {
  function runDoctor({ listOutput, claudeExit = 0, recorded = true }) {
    const home = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-dup-home-')));
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\n${listOutput === null ? '' : `cat <<'EOF'\n${listOutput}\nEOF\n`}exit ${claudeExit}\n`,
    );
    chmodSync(join(bin, 'claude'), 0o755);

    const ver = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite', '9.9.9');
    mkdirSync(join(ver, 'scripts'), { recursive: true });
    writeFileSync(join(ver, 'scripts', 'launch.mjs'), '// stub\n');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    if (recorded) {
      writeFileSync(
        join(home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({ 'claude-mem-lite@sdsrss': { version: '9.9.9' } }),
      );
    }

    const dataDir = fixtures.track(mkdtempSync(join(tmpdir(), 'cml-dup-data-')));
    return spawnSync(process.execPath, [join(REPO, 'install.mjs'), 'doctor'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        MEM_NO_AUTO_ADOPT: '1',
      },
    }).stdout;
  }

  const PLUGIN_LINE = 'plugin:claude-mem-lite:mem-lite: node /x/launch.mjs - ✔ Connected';
  const BARE_LINE = 'mem-lite: node /home/u/.claude-mem-lite/server.mjs - ✔ Connected';

  it('warns, and names the removal command, when both registrations exist', () => {
    const out = runDoctor({ listOutput: `${PLUGIN_LINE}\n${BARE_LINE}` });
    expect(out).toMatch(/registered twice/);
    // No `-s` flag: mcp list does not label scope, and this repo's own tracked .mcp.json
    // registers a bare mem-lite at PROJECT scope, which `-s user` cannot remove.
    expect(out).toMatch(/Fix: claude mcp remove mem-lite/);
    expect(out).not.toMatch(/-s user/);
  });

  it('names EVERY bare registration, not just the first', () => {
    const out = runDoctor({ listOutput: `${PLUGIN_LINE}\n${BARE_LINE}\nmem: node /y/server.mjs - ✔` });
    expect(out).toMatch(/Fix: claude mcp remove mem-lite/);
    expect(out).toMatch(/Fix: claude mcp remove mem\b/);
  });

  it('does not call a leftover cache directory a duplicate', () => {
    // The destructive half of pre-ship review's P1: this exact output, with a cache dir but
    // nothing recording an install, told a working npm-channel install to remove its ONLY
    // registration. It must now read as a plain registration instead.
    const out = runDoctor({ listOutput: BARE_LINE, recorded: false });
    expect(out).not.toMatch(/registered twice/);
    expect(out).toMatch(/MCP registration: "mem-lite" registered/);
  });

  it('reports no duplicate when only the plugin provides it (control)', () => {
    const out = runDoctor({ listOutput: PLUGIN_LINE });
    expect(out).toMatch(/provided by the plugin manifest only \(no duplicate\)/);
    expect(out).not.toMatch(/registered twice/);
  });

  it('says it could not check when the claude CLI is unusable', () => {
    // Third outcome. A green "no duplicate" from a check that never ran ends the reader's
    // search on a fact nobody established — the same rule doctor's bash-hook check settled.
    const out = runDoctor({ listOutput: null, claudeExit: 127 });
    expect(out).toMatch(/could not run `claude mcp list`/);
    expect(out).not.toMatch(/no duplicate/);
    expect(out).not.toMatch(/registered twice/);
  });
});

function existsOrEmpty(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
