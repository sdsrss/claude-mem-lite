// install-e2e.test.mjs — End-to-end installation tests
// Tests the three installation methods (plugin, direct/npx, git clone --dev)
// against a sandboxed HOME directory. Verifies:
//   - File deployment (source files, scripts, directories)
//   - Hook registration (settings.json for direct, hooks.json for plugin)
//   - MCP server registration
//   - Version consistency across manifests
//   - Smart invocation scripts presence
//   - Directory structure matches expected layout

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const INSTALL_PATH = resolve('install.mjs');
const SETUP_PATH = resolve('scripts/setup.sh');
const PROJECT_DIR = resolve('.');
// Use --dev mode for E2E tests: skips npm install (fast), uses symlinks, tests same hook logic

function makeTmpDir() {
  const dir = join(tmpdir(), `mem-e2e-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeFakeClaudeBin(home) {
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, 'claude');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `STATE="${home}/.claude/mcp-state.txt"`,
      `mkdir -p "${home}/.claude"`,
      'touch "$STATE"',
      'if [[ "${1:-}" != "mcp" ]]; then exit 0; fi',
      'shift; cmd="${1:-}"; shift || true',
      'case "$cmd" in',
      '  add)',
      '    scope="user"; name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in -s) scope="$2"; shift 2 ;; -t) shift 2 ;; --) break ;; *) if [[ -z "$name" && "$1" != -* ]]; then name="$1"; fi; shift ;; esac',
      '    done',
      '    if [[ -n "$name" ]]; then',
      '      grep -v "^${scope}:${name}$" "$STATE" > "$STATE.tmp" 2>/dev/null || true',
      '      mv "$STATE.tmp" "$STATE"',
      '      printf \'%s:%s\\n\' "$scope" "$name" >> "$STATE"',
      '    fi ;;',
      '  remove)',
      '    scope="user"; name=""',
      '    while [[ $# -gt 0 ]]; do',
      '      case "$1" in -s) scope="$2"; shift 2 ;; *) if [[ -z "$name" && "$1" != -* ]]; then name="$1"; fi; shift ;; esac',
      '    done',
      '    if [[ -n "$name" ]]; then',
      '      grep -v "^${scope}:${name}$" "$STATE" > "$STATE.tmp" 2>/dev/null || true',
      '      mv "$STATE.tmp" "$STATE"',
      '    fi ;;',
      '  list)',
      '    while IFS= read -r line; do',
      '      [[ -n "$line" ]] || continue',
      '      name="${line#*:}"',
      '      printf \'%s: stdio\\n\' "$name"',
      '    done < "$STATE" ;;',
      'esac',
    ].join('\n'),
  );
  execFileSync('chmod', ['+x', script]);
  return binDir;
}

function runInstall(command, home, args = [], extraEnv = {}) {
  return execFileSync(process.execPath, [INSTALL_PATH, command, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      // Skip managed repo cloning by suppressing git commands
      CLAUDE_MEM_SKIP_REPOS: '1',
      // R10 P2-17: without this, install.mjs's dogfood branch (it detects THIS repo by
      // git remote) ran cmdAdopt against the inherited PWD — the repository root — and
      // rewrote the tracked CLAUDE.md managed block plus .claude/plugin_claude_mem_lite.md
      // on every `vitest run`. HOME is sandboxed here; the adopt target was not.
      MEM_NO_AUTO_ADOPT: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ─── Plugin Install Mode ────────────────────────────────────────────────────

describe('E2E: Plugin install mode', () => {
  // Plugin mode is managed by Claude Code. We verify the manifest + hooks files
  // that Claude Code reads to set up the plugin.

  it('plugin.json has required fields for Claude Code plugin system', () => {
    const plugin = readJson('.claude-plugin/plugin.json');
    expect(plugin.name).toBe('claude-mem-lite');
    expect(plugin.version).toBeTruthy();
    expect(plugin.repository).toContain('github.com');
    expect(plugin.license).toBe('MIT');
  });

  it('marketplace.json has matching version for plugin discovery', () => {
    const pkg = readJson('package.json');
    const marketplace = readJson('.claude-plugin/marketplace.json');
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe('claude-mem-lite');
    expect(marketplace.plugins[0].version).toBe(pkg.version);
    expect(marketplace.plugins[0].source).toBe('./');
  });

  it('.mcp.json registers MCP server via plugin launcher', () => {
    const mcp = readJson('.mcp.json');
    expect(mcp.mcpServers['mem-lite']).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs'],
    });
  });

  // Shape of the plugin-manifest registry only. Its PARITY with install.mjs's
  // settings.json registry (event set, matchers, entries) is pinned separately in
  // tests/audit-silent-20260814.test.mjs, which diffs this file against a real
  // `install --dev` run — this case never noticed that install.mjs was missing an
  // entire event (audit B3, 2026-08-14).
  it('hooks/hooks.json declares all 7 hook events', () => {
    const hooks = readJson('hooks/hooks.json');
    expect(hooks.hooks).toBeTruthy();
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
      'PreCompact',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);

    // PostToolUseFailure (D#170) — a SEPARATE event, not a variant of PostToolUse, which
    // Claude Code does not fire for a tool call it judged failed. Scoped to Bash: the
    // surface it feeds queries on a command plus its output.
    expect(hooks.hooks.PostToolUseFailure[0].matcher).toBe('Bash');
    expect(hooks.hooks.PostToolUseFailure[0].hooks[0].command).toContain('hook.mjs post-tool-failure');

    // PreCompact — re-emits the memory block BEFORE compaction rewrites the transcript.
    expect(hooks.hooks.PreCompact[0].hooks[0].command).toContain('hook.mjs pre-compact');

    // SessionStart
    const sessionStart = hooks.hooks.SessionStart?.[0]?.hooks?.map((h) => h.command) || [];
    expect(sessionStart).toContain('bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh"');
    // v2.84: Node hook entries routed through hook-launcher.mjs for self-heal.
    expect(sessionStart).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" hook.mjs session-start',
    );

    // PreToolUse — two matchers (the `Skill` bridge went with the skill-registry
    // subsystem in 2026-09; see docs/audits/20260906-145304.md)
    const preToolUse = hooks.hooks.PreToolUse;
    expect(preToolUse).toHaveLength(2);
    const preMatchers = preToolUse.map((h) => h.matcher);
    expect(preMatchers).toContain('Edit|Write|NotebookEdit|Read');
    expect(preMatchers).not.toContain('Skill');
    expect(preMatchers).toContain('Agent|Task');

    // PreToolUse Agent|Task subagent-injection hook (P0)
    const agentInject = preToolUse.find((h) => h.matcher === 'Agent|Task');
    // The registered command is the bash prefilter, not the Node entry (audit P2-5): a
    // default-off feature must not start an interpreter on every Agent dispatch. The .sh
    // execs the .js when the flag is on.
    expect(agentInject.hooks[0].command).toContain('pre-agent-inject.sh');
    expect(agentInject.hooks[0].command.startsWith('bash ')).toBe(true);

    // PostToolUse — the '*' bash prefilter plus the edit-only bind-salience companion
    // (audit B6, 2026-08-14: post-tool-recall.js shipped signed + tested but was
    // registered nowhere, so bind-salience component 2 could never fire).
    const postToolUse = hooks.hooks.PostToolUse;
    expect(postToolUse).toHaveLength(2);
    const prefilter = postToolUse.find((h) => h.matcher === '*');
    expect(prefilter.hooks[0].command).toContain('post-tool-use.sh');
    const postRecall = postToolUse.find((h) => h.matcher === 'Edit|Write|NotebookEdit');
    expect(postRecall, 'post-tool-recall.js must be registered on the edit tools').toBeTruthy();
    expect(postRecall.hooks[0].command).toContain('post-tool-recall.js');

    // Stop
    expect(hooks.hooks.Stop).toHaveLength(1);

    // UserPromptSubmit
    const userPrompt = hooks.hooks.UserPromptSubmit?.[0]?.hooks?.map((h) => h.command) || [];
    expect(userPrompt.some((c) => c.includes('user-prompt-search.js'))).toBe(true);
    expect(userPrompt.some((c) => c.includes('hook.mjs'))).toBe(true);
  });

  it('plugin setup.sh creates node_modules symlink and clears stale MCP', () => {
    const home = makeTmpDir();
    try {
      const dataDir = join(home, '.claude-mem-lite');
      const pluginRoot = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      // Pre-create node_modules symlink (simulating previous install)
      symlinkSync(resolve('node_modules'), join(dataDir, 'node_modules'));

      // Stale global MCP that setup should clean
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify(
          {
            mcpServers: { mem: { command: 'node', args: ['old-server.mjs'] } },
          },
          null,
          2,
        ),
      );

      execFileSync('bash', [SETUP_PATH], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // node_modules symlinked from plugin cache to data dir
      expect(existsSync(join(pluginRoot, 'node_modules'))).toBe(true);

      // Stale global MCP removed
      const claudeJson = readJson(join(home, '.claude.json'));
      expect(claudeJson.mcpServers?.mem).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── Direct Install Mode (git clone / npx) ─────────────────────────────────

describe('E2E: Direct install mode (git clone / npx)', () => {
  let home;
  let binDir;

  beforeEach(() => {
    home = makeTmpDir();
    binDir = makeFakeClaudeBin(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('install creates data directory and deploys source files', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    const dataDir = join(home, '.claude-mem-lite');
    expect(existsSync(dataDir)).toBe(true);

    // Core source files present
    const requiredFiles = [
      'server.mjs',
      'hook.mjs',
      'schema.mjs',
      'utils.mjs',
      'mem-cli.mjs',
      'package.json',
    ];
    for (const f of requiredFiles) {
      expect(existsSync(join(dataDir, f))).toBe(true);
    }

    // Scripts directory with smart invocation scripts
    expect(existsSync(join(dataDir, 'scripts', 'post-tool-use.sh'))).toBe(true);
    expect(existsSync(join(dataDir, 'scripts', 'user-prompt-search.js'))).toBe(true);
    expect(existsSync(join(dataDir, 'scripts', 'prompt-search-utils.mjs'))).toBe(true);
  });

  it('install registers hooks in settings.json with all 5 events', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    const settings = readJson(join(home, '.claude', 'settings.json'));

    // All 5 hook events registered
    expect(settings.hooks.SessionStart).toBeTruthy();
    expect(settings.hooks.PostToolUse).toBeTruthy();
    expect(settings.hooks.Stop).toBeTruthy();
    expect(settings.hooks.UserPromptSubmit).toBeTruthy();
    expect(settings.hooks.PreToolUse).toBeTruthy();

    // PreToolUse has two separate matchers
    const preToolUse = settings.hooks.PreToolUse;
    expect(preToolUse.length).toBeGreaterThanOrEqual(2);

    // Edit/Write/Read recall hook (v2.34.6 extended Read)
    const editMatcher = preToolUse.find((h) => h.matcher === 'Edit|Write|NotebookEdit|Read');
    expect(editMatcher).toBeTruthy();
    expect(editMatcher.hooks[0].command).toContain('pre-tool-recall.js');

    // No `Skill` matcher: the bridge was removed with the skill-registry subsystem
    // (2026-09). Asserted negatively so a reinstated twin cannot slip back in silently.
    expect(preToolUse.find((h) => h.matcher === 'Skill')).toBeUndefined();

    // Agent|Task subagent-injection hook (P0)
    const agentMatcher = preToolUse.find((h) => h.matcher === 'Agent|Task');
    expect(agentMatcher).toBeTruthy();
    expect(agentMatcher.hooks[0].command).toContain('pre-agent-inject.sh');
    expect(agentMatcher.hooks[0].command.startsWith('bash ')).toBe(true);

    // UserPromptSubmit has both search + hook handlers
    const userPromptHooks = settings.hooks.UserPromptSubmit[0].hooks.map((h) => h.command);
    expect(userPromptHooks.some((c) => c.includes('user-prompt-search.js'))).toBe(true);
    expect(userPromptHooks.some((c) => c.includes('hook.mjs'))).toBe(true);
  });

  it('install registers MCP server via fake claude binary', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    const statePath = join(home, '.claude', 'mcp-state.txt');
    const state = readFileSync(statePath, 'utf8');
    expect(state).toContain('user:mem');
  });

  it('install hook paths point to ~/.claude-mem-lite/ data directory', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const dataDir = join(home, '.claude-mem-lite');

    // All hook commands should reference the data dir
    const allCommands = [];
    for (const event of Object.values(settings.hooks)) {
      for (const entry of event) {
        for (const hook of entry.hooks) {
          allCommands.push(hook.command);
        }
      }
    }

    for (const cmd of allCommands) {
      // Every command should reference the data dir path
      expect(cmd).toContain(dataDir);
    }
  });

  it('install clears stale hooks.json in every plugin cache version to prevent double firing', () => {
    // Simulate prior marketplace install: cache dirs contain populated hooks.json
    // that Claude Code runtime would read, causing hooks to register twice
    // (once from cache, once from settings.json written by install.mjs).
    const cacheBase = join(home, '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');
    const marketplaceDir = join(home, '.claude', 'plugins', 'marketplaces', 'sdsrss');
    mkdirSync(marketplaceDir, { recursive: true });

    const populatedHooks = {
      description: 'claude-mem-lite memory system hooks',
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-search.js"',
                timeout: 2,
              },
              { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hook.mjs" user-prompt', timeout: 5 },
            ],
          },
        ],
      },
    };

    for (const ver of ['2.28.1', '2.30.0']) {
      mkdirSync(join(cacheBase, ver, 'hooks'), { recursive: true });
      mkdirSync(join(cacheBase, ver, 'scripts'), { recursive: true });
      writeFileSync(
        join(cacheBase, ver, 'hooks', 'hooks.json'),
        JSON.stringify(populatedHooks, null, 2) + '\n',
      );
    }

    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    for (const ver of ['2.28.1', '2.30.0']) {
      const cleared = readJson(join(cacheBase, ver, 'hooks', 'hooks.json'));
      expect(cleared.hooks).toEqual({});
      expect(cleared._note).toMatch(/managed by install\.mjs/i);
    }
  });

  it('status shows MCP registered and hooks configured', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });
    const output = runInstall('status', home, [], { PATH: `${binDir}:${process.env.PATH}` });

    expect(output).toContain('MCP server: registered');
    expect(output).toContain('Hooks:');
  });

  it('uninstall removes hooks and MCP but preserves data', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    const dataDir = join(home, '.claude-mem-lite');
    expect(existsSync(dataDir)).toBe(true);

    runInstall('uninstall', home, [], { PATH: `${binDir}:${process.env.PATH}` });

    // Hooks should be removed from settings
    const settings = readJson(join(home, '.claude', 'settings.json'));
    const hasMemHook = JSON.stringify(settings.hooks || {}).includes('claude-mem-lite');
    expect(hasMemHook).toBe(false);

    // Data directory preserved
    expect(existsSync(dataDir)).toBe(true);
  });

  it('uninstall --purge removes data directory', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    const dataDir = join(home, '.claude-mem-lite');
    expect(existsSync(dataDir)).toBe(true);

    runInstall('uninstall', home, ['--purge'], { PATH: `${binDir}:${process.env.PATH}` });

    expect(existsSync(dataDir)).toBe(false);
  });
});

// ─── Dev Install Mode (git clone --dev) ─────────────────────────────────────

describe('E2E: Dev install mode (git clone --dev)', () => {
  let home;
  let binDir;

  beforeEach(() => {
    home = makeTmpDir();
    binDir = makeFakeClaudeBin(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('--dev creates symlinks instead of copies', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    const dataDir = join(home, '.claude-mem-lite');

    // Core files should be symlinks to project dir
    const serverLink = join(dataDir, 'server.mjs');
    expect(existsSync(serverLink)).toBe(true);

    // Scripts dir should be a symlink
    const scriptsLink = join(dataDir, 'scripts');
    expect(existsSync(scriptsLink)).toBe(true);

    // node_modules should be a symlink
    const nmLink = join(dataDir, 'node_modules');
    expect(existsSync(nmLink)).toBe(true);
  });

  it('--dev hooks point to ~/.claude-mem-lite/ (via symlinks)', () => {
    runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

    const settings = readJson(join(home, '.claude', 'settings.json'));
    const dataDir = join(home, '.claude-mem-lite');

    // Hooks should reference the data dir, not the project dir
    const sessionHook = settings.hooks.SessionStart?.[0]?.hooks?.[0]?.command || '';
    expect(sessionHook).toContain(dataDir);
    expect(sessionHook).not.toContain(PROJECT_DIR);
  });
});

// ─── Smart Invocation Scripts Presence ──────────────────────────────────────

describe('E2E: Smart invocation scripts deployed', () => {
  it('plugin hooks.json references all smart invocation scripts', () => {
    const hooks = readJson('hooks/hooks.json');

    // Pre-tool-recall for Edit/Write/Read
    const preToolUse = hooks.hooks.PreToolUse;
    const recallHook = preToolUse.find((h) => h.matcher === 'Edit|Write|NotebookEdit|Read');
    expect(recallHook).toBeTruthy();
    expect(recallHook.hooks[0].command).toContain('pre-tool-recall.js');
    expect(recallHook.hooks[0].timeout).toBe(3);

    // User-prompt-search for L1 auto-load
    const userPrompt = hooks.hooks.UserPromptSubmit[0].hooks;
    const searchHook = userPrompt.find((h) => h.command.includes('user-prompt-search.js'));
    expect(searchHook).toBeTruthy();
    expect(searchHook.timeout).toBe(2);
  });

  it('direct install deploys smart invocation scripts to scripts/', () => {
    const home = makeTmpDir();
    const binDir = makeFakeClaudeBin(home);
    try {
      runInstall('install', home, ['--dev', '--skip-repos'], { PATH: `${binDir}:${process.env.PATH}` });

      const dataDir = join(home, '.claude-mem-lite');
      // --dev mode creates a scripts symlink → all scripts accessible
      expect(existsSync(join(dataDir, 'scripts'))).toBe(true);
      // Verify the smart invocation scripts exist in the project
      expect(existsSync(join(PROJECT_DIR, 'scripts', 'user-prompt-search.js'))).toBe(true);
      expect(existsSync(join(PROJECT_DIR, 'scripts', 'prompt-search-utils.mjs'))).toBe(true);
      expect(existsSync(join(PROJECT_DIR, 'scripts', 'pre-tool-recall.js'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─── Version Consistency ────────────────────────────────────────────────────

describe('E2E: Version consistency across all manifests', () => {
  it('package.json, plugin.json, marketplace.json, CLAUDE.md all match', () => {
    const pkg = readJson('package.json');
    const plugin = readJson('.claude-plugin/plugin.json');
    const marketplace = readJson('.claude-plugin/marketplace.json');

    const version = pkg.version;
    expect(plugin.version).toBe(version);
    expect(marketplace.plugins[0].version).toBe(version);

    // CLAUDE.md is developer-local and untracked (it is in .gitignore), so a fresh
    // clone — CI included — does not have it. The three SHIPPED manifests above are
    // checked unconditionally; the CLAUDE.md leg only runs where a REAL one exists.
    //
    // "Exists" is not the right predicate, and plain existsSync was measured wrong:
    // this plugin's own SessionStart adopt hook RECREATES CLAUDE.md within seconds of
    // it going missing, writing a file that holds nothing but the managed block. So on
    // any adopted machine the file is present again almost immediately, carries no
    // `**Version**:` line, and an existence check turns that into a hard failure for a
    // developer who never touched the version at all.
    //
    // The predicate is therefore "is there project content OUTSIDE the managed
    // sentinel blocks" — true for a real CLAUDE.md, false for an adopt-generated stub.
    // Deliberately NOT a silent skip: this repo's doctrine is that a case which cannot
    // fail is not a case, and this assertion has already caught a real defect (a
    // reformat that dropped the literal `**Version**:` token). Where a real file is
    // present the check is exactly as strict as before.
    const claudeMd = existsSync('CLAUDE.md') ? readFileSync('CLAUDE.md', 'utf8') : '';
    const outsideManagedBlocks = claudeMd
      .replace(/<!--\s*[\w-]+:begin[^>]*-->[\s\S]*?<!--\s*[\w-]+:end\s*-->/g, '')
      .trim();
    if (outsideManagedBlocks) {
      expect(claudeMd).toContain(`**Version**: ${version}`);
    }
  });

  it('npm package includes all necessary files for publishing', () => {
    const pkg = readJson('package.json');
    const files = pkg.files || [];

    // Core files
    expect(files).toContain('server.mjs');
    expect(files).toContain('hook.mjs');
    expect(files).toContain('schema.mjs');
    expect(files).toContain('install.mjs');
    expect(files).toContain('cli.mjs');

    // Plugin manifests (exact paths in files array)
    expect(files).toContain('.claude-plugin/plugin.json');
    expect(files).toContain('.claude-plugin/marketplace.json');
    expect(files).toContain('.mcp.json');
    expect(files).toContain('hooks/hooks.json');

    // Smart invocation scripts
    expect(files).toContain('scripts/pre-agent-inject.js');
    expect(files).toContain('scripts/user-prompt-search.js');
    expect(files).toContain('scripts/prompt-search-utils.mjs');
    expect(files).toContain('scripts/pre-tool-recall.js');

    // CLI
    expect(files).toContain('mem-cli.mjs');
  });
});

// ─── Migration Paths ────────────────────────────────────────────────────────

describe('E2E: Install prune stale modules and zero-byte DBs (v2.48 P1-4)', () => {
  it('pruneStaleInstallFiles removes top-level .mjs not in SOURCE_FILES', async () => {
    const { pruneStaleInstallFiles } = await import('../install.mjs');
    const { SOURCE_FILES } = await import('../source-files.mjs');
    const tmpDir = makeTmpDir();
    try {
      // Simulate a post-v2.20 install: dispatch-* removed from SOURCE_FILES but
      // leftover on disk. Mix of real + stale + protected.
      writeFileSync(join(tmpDir, 'server.mjs'), 'real'); // in SOURCE_FILES
      writeFileSync(join(tmpDir, 'hook.mjs'), 'real'); // in SOURCE_FILES
      writeFileSync(join(tmpDir, 'dispatch.mjs'), 'stale'); // NOT in SOURCE_FILES
      writeFileSync(join(tmpDir, 'dispatch-feedback.mjs'), 'stale');
      writeFileSync(join(tmpDir, 'dispatch-inject.mjs'), 'stale');
      writeFileSync(join(tmpDir, 'dispatch-workflow.mjs'), 'stale');
      writeFileSync(join(tmpDir, 'README.txt'), 'non-mjs'); // not .mjs — don't touch
      writeFileSync(join(tmpDir, 'package.json'), '{}'); // in SOURCE_FILES

      const removed = pruneStaleInstallFiles(tmpDir, SOURCE_FILES);
      const removedNames = removed.map((r) => r.split('/').pop()).sort();
      expect(removedNames).toEqual([
        'dispatch-feedback.mjs',
        'dispatch-inject.mjs',
        'dispatch-workflow.mjs',
        'dispatch.mjs',
      ]);

      // Protected files still present
      expect(existsSync(join(tmpDir, 'server.mjs'))).toBe(true);
      expect(existsSync(join(tmpDir, 'hook.mjs'))).toBe(true);
      expect(existsSync(join(tmpDir, 'README.txt'))).toBe(true);
      expect(existsSync(join(tmpDir, 'package.json'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pruneStaleInstallFiles removes zero-byte .db files except whitelist', async () => {
    const { pruneStaleInstallFiles } = await import('../install.mjs');
    const { SOURCE_FILES } = await import('../source-files.mjs');
    const tmpDir = makeTmpDir();
    try {
      // Whitelist entries (always preserve, even if 0 bytes — WAL/SHM transients)
      writeFileSync(join(tmpDir, 'claude-mem-lite.db'), '');
      writeFileSync(join(tmpDir, 'resource-registry.db'), 'non-empty-data');
      // Stale 0-byte DB files from older versions (mem.db, memory.db, registry.db)
      writeFileSync(join(tmpDir, 'mem.db'), '');
      writeFileSync(join(tmpDir, 'memory.db'), '');
      writeFileSync(join(tmpDir, 'registry.db'), '');
      // Non-empty stale: preserve — real data risk is unacceptable
      writeFileSync(join(tmpDir, 'ghost.db'), 'oops-data');

      const removed = pruneStaleInstallFiles(tmpDir, SOURCE_FILES);
      const removedNames = removed.map((r) => r.split('/').pop()).sort();
      expect(removedNames).toEqual(['mem.db', 'memory.db', 'registry.db']);

      // Whitelist intact, non-empty stale preserved
      expect(existsSync(join(tmpDir, 'claude-mem-lite.db'))).toBe(true);
      expect(existsSync(join(tmpDir, 'resource-registry.db'))).toBe(true);
      expect(existsSync(join(tmpDir, 'ghost.db'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pruneStaleInstallFiles does not descend into subdirectories', async () => {
    const { pruneStaleInstallFiles } = await import('../install.mjs');
    const { SOURCE_FILES } = await import('../source-files.mjs');
    const tmpDir = makeTmpDir();
    try {
      mkdirSync(join(tmpDir, 'managed'), { recursive: true });
      mkdirSync(join(tmpDir, 'runtime'), { recursive: true });
      mkdirSync(join(tmpDir, 'scripts'), { recursive: true });
      mkdirSync(join(tmpDir, 'lib'), { recursive: true });
      // Subdir entries that LOOK like stale top-level files but are actually scoped
      writeFileSync(join(tmpDir, 'managed', 'dispatch.mjs'), 'user-agent-file');
      writeFileSync(join(tmpDir, 'lib', 'orphan.mjs'), 'subdir-lib-file');
      writeFileSync(join(tmpDir, 'runtime', 'mem.db'), ''); // 0-byte in runtime — hands off
      writeFileSync(join(tmpDir, 'scripts', 'old.mjs'), 'script');

      const removed = pruneStaleInstallFiles(tmpDir, SOURCE_FILES);
      expect(removed).toEqual([]);

      // Everything under subdirs preserved
      expect(existsSync(join(tmpDir, 'managed', 'dispatch.mjs'))).toBe(true);
      expect(existsSync(join(tmpDir, 'lib', 'orphan.mjs'))).toBe(true);
      expect(existsSync(join(tmpDir, 'runtime', 'mem.db'))).toBe(true);
      expect(existsSync(join(tmpDir, 'scripts', 'old.mjs'))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pruneStaleInstallFiles is idempotent and no-op on clean dir', async () => {
    const { pruneStaleInstallFiles } = await import('../install.mjs');
    const { SOURCE_FILES } = await import('../source-files.mjs');
    const tmpDir = makeTmpDir();
    try {
      writeFileSync(join(tmpDir, 'server.mjs'), 'real');
      writeFileSync(join(tmpDir, 'hook.mjs'), 'real');

      const r1 = pruneStaleInstallFiles(tmpDir, SOURCE_FILES);
      const r2 = pruneStaleInstallFiles(tmpDir, SOURCE_FILES);
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('E2E: Migration from older versions', () => {
  it('backs up legacy ~/.claude-mem/claude-mem.db without reusing it as the new DB', () => {
    const home = makeTmpDir();
    const binDir = makeFakeClaudeBin(home);
    try {
      // Simulate old claude-mem install (v16 schema, incompatible with v28)
      const oldDir = join(home, '.claude-mem');
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, 'claude-mem.db'), 'fake-legacy-db');

      const output = runInstall('install', home, ['--dev', '--skip-repos'], {
        PATH: `${binDir}:${process.env.PATH}`,
      });
      expect(output).toMatch(/backed up|backup/i);

      const newDir = join(home, '.claude-mem-lite');
      // Legacy DB must NOT be reused as the new DB — schema is incompatible.
      expect(existsSync(join(newDir, 'claude-mem-lite.db'))).toBe(false);
      // A timestamped backup must exist for recovery.
      const backups = readdirSync(newDir).filter((f) => f.includes('legacy-backup'));
      expect(backups.length).toBeGreaterThan(0);
      expect(backups.some((f) => /^claude-mem-lite\.db\.legacy-backup-\d+$/.test(f))).toBe(true);
      // Legacy file moved (renamed), not copied.
      expect(existsSync(join(oldDir, 'claude-mem.db'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('renames claude-mem.db to claude-mem-lite.db in data dir', () => {
    const home = makeTmpDir();
    const binDir = makeFakeClaudeBin(home);
    try {
      // Pre-create data dir with old db name
      const dataDir = join(home, '.claude-mem-lite');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'claude-mem.db'), 'old-name-db');

      const output = runInstall('install', home, ['--dev', '--skip-repos'], {
        PATH: `${binDir}:${process.env.PATH}`,
      });
      expect(output).toContain('renamed');

      expect(existsSync(join(dataDir, 'claude-mem-lite.db'))).toBe(true);
      expect(existsSync(join(dataDir, 'claude-mem.db'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
