// R3 I-H1 (HIGH): isMemHook must not over-match a user's own hooks. The old
// `hook.mjs` + event-word clause classified `node ~/.config/hook.mjs session-start`
// (a user's generic hook) as ours → install/uninstall silently deleted it.
import { describe, it, expect } from 'vitest';
import { isMemHook } from '../lib/hook-prune.mjs';

const mk = (command) => ({ hooks: [{ type: 'command', command }] });

describe('isMemHook classifies real mem hooks (R3 I-H1)', () => {
  it('matches launcher-routed, install-path, and prefilter commands', () => {
    expect(
      isMemHook(mk('node "/home/me/.claude-mem-lite/scripts/hook-launcher.mjs" hook.mjs session-start')),
    ).toBe(true);
    expect(isMemHook(mk('node "/home/me/.claude-mem-lite/hook.mjs" session-start'))).toBe(true); // legacy direct (install path)
    expect(isMemHook(mk('bash "/home/me/.claude-mem-lite/scripts/post-tool-use.sh"'))).toBe(true);
    expect(isMemHook(mk('node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs" hook.mjs stop'))).toBe(true);
  });
});

describe("isMemHook must NOT delete a user's foreign hooks (R3 I-H1)", () => {
  it("does not match a user's own hook.mjs carrying an event arg", () => {
    expect(isMemHook(mk('node /home/me/.config/hook.mjs session-start'))).toBe(false);
    expect(isMemHook(mk('node /home/me/scripts/hook.mjs stop-daemon'))).toBe(false); // \bstop\b false-matched before
    expect(isMemHook(mk('node "/tmp/other-plugin/hook.mjs" user-prompt'))).toBe(false);
  });
  it('does not match an unrelated foreign command', () => {
    expect(isMemHook(mk('/usr/bin/my-linter'))).toBe(false);
    expect(isMemHook(mk('bash "/opt/tools/backup.sh" --daily'))).toBe(false);
  });
});
