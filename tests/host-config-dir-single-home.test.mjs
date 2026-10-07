// D#173 / D#176: Claude Code's config home has ONE spelling in shipped code.
//
// With CLAUDE_CONFIG_DIR set, Claude Code keeps settings.json, plugins/ and .claude.json in that
// directory (docs: settings.md; verified on 2.1.292 with `claude plugin list` in a sandbox). The
// plugin had ~25 sites that built ~/.claude or ~/.claude.json from homedir() — the installer, the
// update path, the disabled-plugin check and setup.sh — so for such a user it wrote hooks the host
// never read, and with two profiles it pruned and edited the OTHER profile's files. Every site
// now asks lib/data-paths.mjs (claudeConfigDir / claudeConfigDirFor / claudeStatePath), and the
// two bash scripts carry one `_mem_is_abs` each with the same body and spell the default once. This sweep fails on a
// new site built the old way; the behaviour of each helper is tested in claude-config-dir,
// hook-update, install-lifecycle and post-tool-use-disabled.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { REPO, walkShipped, relShipped, sourceWithoutComments } from './shipped-tree.mjs';

// homedir() + '.claude' / '.claude.json', or a `home` parameter joined with '.claude'.
const JS_OLD_SHAPE = /homedir\(\)\s*,\s*['"]\.claude(?:\.json)?['"]|join\(\s*home\s*,\s*['"]\.claude['"]/;
// The resolver itself, and memdir.mjs's deliberate legacy fallback (an opt-out written under
// ~/.claude before CLAUDE_CONFIG_DIR was honoured still holds; tests/local-steering pins it).
const JS_ALLOWED = new Set(['lib/data-paths.mjs', 'memdir.mjs']);

// `.claude` alone too (D#269: a default spelled as a bare dir slipped past `/` and `.json`), but
// not the data dirs that only share the prefix (`.claude-mem-lite`, `.claude-mem`).
const SH_OLD_SHAPE = /\$\{?HOME\}?\/\.claude(?:\/|\.json|(?![\w.-]))/;
// The defaults each script spells once: setup.sh's two variables (its config-home choice and its
// one-shot marker keys read them, D#270) and post-tool-use.sh's one.
const SH_ALLOWED_LINES = new Set([
  'CC_DEFAULT_CONFIG_DIR="$HOME/.claude"',
  'CC_DEFAULT_STATE_FILE="$HOME/.claude.json"',
  '_mem_config_home="${HOME}/.claude"',
]);

function jsOffenders(text) {
  return text.split('\n').filter((l) => JS_OLD_SHAPE.test(l));
}
function shOffenders(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && SH_OLD_SHAPE.test(l) && !SH_ALLOWED_LINES.has(l));
}

describe('the host config home has one spelling in shipped code', () => {
  it('no shipped module builds ~/.claude or ~/.claude.json from homedir()', () => {
    const offenders = walkShipped()
      .filter((f) => !JS_ALLOWED.has(relShipped(f)))
      .flatMap((f) => jsOffenders(sourceWithoutComments(f)).map((l) => `${relShipped(f)}: ${l.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('no shipped bash script reads $HOME/.claude outside its config-home case', () => {
    const dir = join(REPO, 'scripts');
    const offenders = readdirSync(dir)
      .filter((n) => n.endsWith('.sh'))
      .flatMap((n) => shOffenders(readFileSync(join(dir, n), 'utf8')).map((l) => `scripts/${n}: ${l}`));
    expect(offenders).toEqual([]);
  });

  // The sweep must be able to say no. Counter-examples are lines from the code before the fix.
  it('self-check: the pre-fix lines are flagged', () => {
    expect(
      jsOffenders(
        "  const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', 'sdsrss', 'claude-mem-lite');",
      ),
    ).toHaveLength(1);
    expect(jsOffenders("        const claudeJsonPath = join(homedir(), '.claude.json');")).toHaveLength(1);
    expect(jsOffenders("  const settingsPath = join(home, '.claude', 'settings.json');")).toHaveLength(1);
    expect(shOffenders('  CACHE_DIR="$HOME/.claude/plugins/cache/sdsrss/claude-mem-lite"')).toHaveLength(1);
    expect(shOffenders('  CLAUDE_JSON="$HOME/.claude.json" node -e \'')).toHaveLength(1);
    expect(shOffenders('_mem_settings_file="${HOME}/.claude/settings.json"')).toHaveLength(1);
    // The bare dir, the shape a second default spelling takes when it ends in a quote (D#269).
    expect(shOffenders('    CC_CONFIG_DIR="$HOME/.claude"')).toHaveLength(1);
    expect(shOffenders('marker_suffix "$CC_CONFIG_DIR" "$HOME/.claude"')).toHaveLength(1);
    // …and the data dir, which only shares a prefix, is not.
    expect(jsOffenders("const DATA_DIR = join(homedir(), '.claude-mem-lite');")).toHaveLength(0);
    expect(shOffenders('CODE_DIR="$HOME/.claude-mem-lite"')).toHaveLength(0);
  });
});
