// R9 discoverability signal (§EXT §2-EXT, released-artifact checklist item 4).
//
// The skill registry was removed in a breaking release. A user with `registry` /
// `import` / `enrich` in a script or in muscle memory gets `Unknown command`, which
// is true and useless: it reads as a typo, and the edit-distance suggester makes it
// worse by proposing `import-jsonl` for `import` — a DIFFERENT feature that would
// happily run against a GitHub URL and do something unintended.
//
// So the router names the removal explicitly. These cases pin BOTH halves: the hint
// fires for exactly the three removed names, and does NOT fire for an ordinary typo.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'cli.mjs');

function run(args) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MEM_QUIET_HOOKS: '1', CLAUDE_MEM_SKIP_UPDATE: '1' },
    });
  } catch (e) {
    // The router exits non-zero on an unknown command; the message is on stderr.
    return (e.stdout || '') + (e.stderr || '');
  }
}

describe('removed registry commands name their removal', () => {
  it.each(['registry', 'import', 'enrich'])('`%s` says it was removed, not just unknown', (cmd) => {
    const out = run([cmd]);
    expect(out, `no removal hint for "${cmd}":\n${out}`).toMatch(/was removed along with/i);
    // The hint must be actionable: it points at where the reasoning lives.
    expect(out).toMatch(/CHANGELOG/);
  });

  it('does not fire for an ordinary typo — the hint would be a lie', () => {
    const out = run(['serach']);
    expect(out).toMatch(/Unknown command/);
    expect(out, `a typo was told a feature had been removed:\n${out}`).not.toMatch(/was removed along with/i);
  });

  it('`import` is not silently re-routed to import-jsonl', () => {
    // The edit-distance suggester's nearest match for `import` is `import-jsonl`, a
    // different feature. The hint must land instead of (or before) that suggestion,
    // and the command must not actually run.
    const out = run(['import', 'https://github.com/obra/superpowers']);
    expect(out).toMatch(/was removed along with/i);
    expect(out).not.toMatch(/Imported \d+/);
  });
});
