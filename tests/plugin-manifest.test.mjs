import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('plugin manifests', () => {
  it('declares plugin-mode MCP launcher in root .mcp.json', () => {
    const manifest = readJson('.mcp.json');
    expect(manifest.mcpServers).toBeTruthy();
    expect(manifest.mcpServers['mem-lite']).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/scripts/launch.mjs'],
    });
    // Guard: the pre-v2.78 generic name "mem" must not coexist with the new name.
    expect(manifest.mcpServers.mem).toBeUndefined();
  });

  it('keeps MCP manifest at plugin root and not under plugin metadata directories', () => {
    expect(existsSync('.mcp.json')).toBe(true);
    expect(existsSync('claude-plugin/.mcp.json')).toBe(false);
    expect(existsSync('.claude-plugin/.mcp.json')).toBe(false);

    const pkg = readJson('package.json');
    expect(pkg.files).toContain('.mcp.json');
    expect(pkg.files).not.toContain('.claude-plugin/.mcp.json');
    expect(pkg.files).not.toContain('claude-plugin/.mcp.json');
  });

  it('keeps package, plugin, and marketplace versions in sync for releases', () => {
    const pkg = readJson('package.json');
    const plugin = readJson('.claude-plugin/plugin.json');
    const marketplace = readJson('.claude-plugin/marketplace.json');

    expect(plugin.version).toBe(pkg.version);
    expect(marketplace.plugins?.[0]?.version).toBe(pkg.version);
  });

  it('declares plugin-mode session hooks in hooks/hooks.json', () => {
    const hooks = readJson('hooks/hooks.json');
    const sessionHooks = hooks.hooks?.SessionStart?.[0]?.hooks ?? [];
    expect(sessionHooks.map((h) => h.command)).toContain('bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh"');
    // v2.84: Node hook entries routed through hook-launcher.mjs for self-heal.
    expect(sessionHooks.map((h) => h.command)).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" hook.mjs session-start',
    );
  });
});
