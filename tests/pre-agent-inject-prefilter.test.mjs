// Audit 2026-08-22 P2-5: subagent dispatch-time injection is default-off, and the
// registered Agent|Task hook command used to start a Node interpreter on EVERY Agent
// dispatch just to read one env var and return (22.6ms, measured, flag unset). The
// hook command in both registries is now scripts/pre-agent-inject.sh, which hands off
// to Node only when the flag is on.
//
// The assertion that matters is "does it start Node at all" — a stdout/exit-code test
// passes identically whether the interpreter ran or not, which is the entire cost being
// removed. So: a fake `node` first on PATH that records the fact it was invoked.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const PREFILTER = resolve(import.meta.dirname, '../scripts/pre-agent-inject.sh');
const PAYLOAD = JSON.stringify({
  tool_name: 'Agent',
  tool_input: { prompt: 'refactor the FTS sanitizer' },
  session_id: 'sess-prefilter',
  cwd: process.cwd(),
});

let sandbox, binDir, recordDir;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'agent-prefilter-'));
  binDir = join(sandbox, 'bin');
  recordDir = join(sandbox, 'record');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(recordDir, { recursive: true });
  // Fake `node`: records that it ran, with what argv and what stdin. Never loads the
  // real hook, so this test cannot be slowed or flaked by the injection path itself.
  const fake = join(binDir, 'node');
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > "${join(recordDir, 'argv.txt')}"`,
      `cat > "${join(recordDir, 'stdin.txt')}"`,
      '',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);
});

afterAll(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* gone */
  }
});

function runPrefilter(flag, { payload = PAYLOAD } = {}) {
  for (const f of ['argv.txt', 'stdin.txt']) {
    try {
      rmSync(join(recordDir, f));
    } catch {
      /* absent */
    }
  }
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  // The maintainer's own shell exports this flag; deleting it is what makes "off"
  // actually off here (the first measurement of this change timed the ON path twice
  // because of exactly that).
  delete env.CLAUDE_MEM_SUBAGENT_INJECT;
  if (flag !== undefined) env.CLAUDE_MEM_SUBAGENT_INJECT = flag;
  const stdout = execFileSync('bash', [PREFILTER], { input: payload, env, encoding: 'utf8', timeout: 15000 });
  return {
    stdout,
    nodeRan: existsSync(join(recordDir, 'argv.txt')),
    argv: existsSync(join(recordDir, 'argv.txt'))
      ? readFileSync(join(recordDir, 'argv.txt'), 'utf8').trim().split('\n')
      : [],
    forwardedStdin: existsSync(join(recordDir, 'stdin.txt'))
      ? readFileSync(join(recordDir, 'stdin.txt'), 'utf8')
      : null,
  };
}

describe('pre-agent-inject.sh (Agent|Task prefilter)', () => {
  it('never starts Node when the feature is off', () => {
    const r = runPrefilter(undefined);
    expect(r.nodeRan, 'the disabled path started a Node interpreter').toBe(false);
    expect(r.stdout).toBe('');
  });

  it('treats every non-on value as off, matching the JS gate it fronts', () => {
    // pre-agent-inject.js enables on exactly 'on' and '1'. A prefilter that enabled on
    // more values would start Node where the JS immediately returns — the old cost back,
    // with an extra shell.
    for (const v of ['', 'off', '0', 'true', 'yes', 'ON']) {
      expect(runPrefilter(v).nodeRan, `value ${JSON.stringify(v)} started Node`).toBe(false);
    }
  });

  it('hands off to the launcher, with stdin intact, on on/1', () => {
    for (const v of ['on', '1']) {
      const r = runPrefilter(v);
      expect(r.nodeRan, `value ${v} did not reach Node`).toBe(true);
      expect(r.argv[0]).toMatch(/scripts\/hook-launcher\.mjs$/);
      expect(r.argv[1]).toBe('scripts/pre-agent-inject.js');
      // Verbatim: the hook echoes the whole subagent prompt back via updatedInput, so
      // anything the prefilter consumed or reshaped would corrupt the dispatch.
      expect(r.forwardedStdin).toBe(PAYLOAD);
    }
  });

  it('forwards a payload larger than a pipe buffer without truncating it', () => {
    // >64KB is where "read it in bash and echo it onward" would start losing data, and
    // where a truncated updatedInput stops being valid JSON.
    const big = JSON.stringify({
      tool_name: 'Agent',
      tool_input: { prompt: 'x'.repeat(200_000) },
      session_id: 'sess-big',
    });
    const r = runPrefilter('on', { payload: big });
    expect(r.forwardedStdin.length).toBe(big.length);
    expect(r.forwardedStdin).toBe(big);
  });
});
