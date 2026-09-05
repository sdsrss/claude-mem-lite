// doctor's stale-process check must not flag unrelated processes.
//
// Found by CI, not locally: the v3.70.0 Release run reported `1 issue(s) found`
// and exited 1 on a healthy plugin-only install because the legacy clause
// `/claude-mem.*worker/` matched vitest's own worker —
// `…/claude-mem-lite/node_modules/vitest/dist/workers/forks.js` — since GitHub
// Actions checks the repo out into a directory named after the package. Every
// other check was green. It was invisible on the dev machine only because that
// checkout lives at a path with no `claude-mem` in it, which is exactly the kind
// of environment-shaped blind spot a cwd-independent unit test closes.

import { describe, it, expect } from 'vitest';
import { isStaleMemProcess } from '../install.mjs';

const V = '3.70.0';

describe('isStaleMemProcess — legacy artifacts', () => {
  it('flags the legacy worker under the pre-v2.20 data dir', () => {
    expect(isStaleMemProcess('4242 node /home/u/.claude-mem/worker.mjs', V)).toBe(true);
  });

  it('flags a chroma server', () => {
    expect(isStaleMemProcess('4242 /usr/bin/chroma run --path /home/u/.claude-mem/vector-db', V)).toBe(true);
  });
});

describe('isStaleMemProcess — must NOT flag', () => {
  it('vitest workers running from a checkout named claude-mem-lite (the CI false-red)', () => {
    const line =
      '12505 /opt/hostedtoolcache/node/22.23.2/x64/bin/node ' +
      '--require /home/runner/work/claude-mem-lite/claude-mem-lite/node_modules/vitest/suppress-warnings.cjs ' +
      '/home/runner/work/claude-mem-lite/claude-mem-lite/node_modules/vitest/dist/workers/forks.js';
    expect(isStaleMemProcess(line, V)).toBe(false);
  });

  it('any worker process merely living under a claude-mem-lite checkout', () => {
    expect(isStaleMemProcess('777 node /src/claude-mem-lite/node_modules/foo/dist/worker.js', V)).toBe(false);
  });

  it('a word that merely contains "chroma"', () => {
    expect(isStaleMemProcess('888 node /opt/synchromatic/server.js', V)).toBe(false);
  });

  // The second bite, during the same release: the `git commit` publishing the FIRST
  // fix for this check tripped it, because the commit message text — sitting in a
  // live bash process's argv — contained the word "chroma". Anything that takes a
  // program as an argument can quote us.
  it("a shell whose ARGUMENTS merely mention chroma (the fix's own commit)", () => {
    const line =
      '2 /bin/bash -c git commit -m "the legacy clause was meant for ' +
      'the pre-v2.20 chroma worker under ~/.claude-mem/"';
    expect(isStaleMemProcess(line, V)).toBe(false);
  });

  it('a shell whose arguments mention an old plugin-cache server path', () => {
    const line = '3 /bin/zsh -c echo "…/claude-mem-lite/3.66.1/server.mjs is stale"';
    expect(isStaleMemProcess(line, V)).toBe(false);
  });

  it('a grep searching for our own name', () => {
    expect(isStaleMemProcess('4 grep -rn chroma /src/claude-mem-lite', V)).toBe(false);
  });

  it('an editor holding a file that talks about chroma', () => {
    expect(isStaleMemProcess('5 /usr/bin/vim /src/claude-mem-lite/CHANGELOG.md', V)).toBe(false);
  });

  it('the CURRENT plugin-cache launcher', () => {
    expect(
      isStaleMemProcess(
        `999 node /home/u/.claude/plugins/cache/sdsrss/claude-mem-lite/${V}/scripts/launch.mjs`,
        V,
      ),
    ).toBe(false);
  });

  it('a dev-install launcher with no version segment', () => {
    expect(isStaleMemProcess('999 node /src/mem/scripts/launch.mjs', V)).toBe(false);
  });

  // Drives the end-of-token anchor: a backup/adjacent file is not a running script.
  it('a path that merely CONTAINS an old server.mjs (a .bak, not an executed script)', () => {
    expect(
      isStaleMemProcess(
        '999 node /home/u/.claude/plugins/cache/sdsrss/claude-mem-lite/3.66.1/server.mjs.bak',
        V,
      ),
    ).toBe(false);
  });

  it('an empty line', () => {
    expect(isStaleMemProcess('', V)).toBe(false);
  });
});

describe('isStaleMemProcess — version-mismatched plugin cache', () => {
  it('flags an OLD cache version still serving the MCP server', () => {
    expect(
      isStaleMemProcess('999 node /home/u/.claude/plugins/cache/sdsrss/claude-mem-lite/3.66.1/server.mjs', V),
    ).toBe(true);
  });

  it('flags an old cache launcher', () => {
    expect(
      isStaleMemProcess(
        '999 node /home/u/.claude/plugins/cache/sdsrss/claude-mem-lite/3.66.1/scripts/launch.mjs',
        V,
      ),
    ).toBe(true);
  });

  it('cannot judge a mismatch when the running version is unknown', () => {
    expect(
      isStaleMemProcess(
        '999 node /home/u/.claude/plugins/cache/sdsrss/claude-mem-lite/3.66.1/server.mjs',
        '',
      ),
    ).toBe(false);
  });
});
