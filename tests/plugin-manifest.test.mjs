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

  // `claude plugin validate . --strict` exited 1 on this repo: marketplace `metadata` carried
  // a `homepage` key, which the runtime tolerates and --strict rejects as unrecognized. The
  // field is real, it just belongs on the plugin ENTRY, where the reference documents it.
  //
  // Guarded HERE rather than by shelling out to `claude plugin validate`, deliberately: the
  // CLI is not a dev dependency, so a spawn-based check would skip silently on any machine
  // or CI runner that lacks it — the permanently-skipped-test shape this repo has been
  // burned by before (tests/pre-commit-hook-sync.test.mjs). Encoding the documented field
  // set costs one list that must be updated when the reference changes, and it can say NO
  // on every machine.
  it('uses only marketplace metadata fields the reference documents', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json');
    // https://code.claude.com/docs/en/plugin-marketplaces — marketplace-level `metadata`
    // accepts pluginRoot / description / version and nothing else.
    const ALLOWED_METADATA = new Set(['pluginRoot', 'description', 'version']);
    const unknown = Object.keys(marketplace.metadata ?? {}).filter((k) => !ALLOWED_METADATA.has(k));
    expect(unknown).toEqual([]);
  });

  it('keeps the marketplace homepage on the plugin entry, where it is a valid field', () => {
    // The counterpart to the check above: the fix must MOVE the field, not delete it, or the
    // manifest validates by having lost information. `homepage` is documented on a plugin
    // entry, so this is where it belongs.
    const marketplace = readJson('.claude-plugin/marketplace.json');
    const entry = marketplace.plugins?.find((p) => p.name === 'claude-mem-lite');
    expect(entry).toBeTruthy();
    expect(entry.homepage).toMatch(/^https:\/\//);
    expect(marketplace.metadata?.homepage).toBeUndefined();
  });
});
