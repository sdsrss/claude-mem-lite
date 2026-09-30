// v2.34.0 tool-visibility split: only core tools appear in tools/list; the
// 9 hidden maintenance/admin tools stay callable by exact name. This test
// spawns the real server over stdio and drives the MCP handshake so it
// catches regressions in both the filter and the registration wiring.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';

const SERVER_PATH = resolve(new URL('..', import.meta.url).pathname, 'server.mjs');

const EXPECTED_CORE = [
  'mem_defer',
  'mem_defer_drop',
  'mem_defer_list',
  'mem_get',
  'mem_recall',
  'mem_recent',
  'mem_save',
  'mem_search',
  'mem_timeline',
];

function startServer(memDir, extraEnv = {}) {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      CLAUDE_MEM_DIR: memDir,
      CLAUDE_MEM_SEARCH_TELEMETRY: '0',
      MEM_QUIET_HOOKS: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', () => {}); // swallow startup chatter
  return proc;
}

function rpc(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            proc.stdout.off('data', onData);
            return resolve(msg);
          }
        } catch {
          // ignore non-JSON / partial frames; buf keeps the remainder
        }
      }
      buf = lines[lines.length - 1];
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(payload);
    setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`timeout waiting for id=${id} method=${method}`));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}

describe('MCP tools/list filter (v2.34.0 hidden-but-callable)', () => {
  let tmp, proc;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mem-vis-'));
    proc = startServer(tmp);
  });

  afterEach(async () => {
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
    // Best-effort wait for process to settle before cleaning the tmp DB.
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('tools/list omits feedback when search telemetry is disabled', async () => {
    await rpc(proc, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tool-visibility-test', version: '0' },
    });
    const resp = await rpc(proc, 2, 'tools/list', {});
    expect(resp.error, 'tools/list error').toBeUndefined();
    const names = resp.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_CORE);

    const call = await rpc(proc, 3, 'tools/call', {
      name: 'mem_search_feedback',
      arguments: { search_id: 1, relevant: ['#1'] },
    });
    expect(call.result?.isError).toBe(true);
    expect(call.result?.content?.[0]?.text).toContain('not found');
  });

  it('tools/list includes feedback when search telemetry is enabled', async () => {
    proc.stdin.end();
    proc.kill('SIGTERM');
    proc = startServer(tmp, { CLAUDE_MEM_SEARCH_TELEMETRY: '1' });
    await rpc(proc, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tool-visibility-test', version: '0' },
    });
    const resp = await rpc(proc, 2, 'tools/list', {});
    const names = resp.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_CORE, 'mem_search_feedback'].sort());
  });

  it('CLAUDE_MEM_ALL_TOOLS=1 exposes all 18 registered default tools', async () => {
    // Spin up a dedicated server with the env var set — the default fixture
    // runs without it, so we need a separate process for this case.
    try {
      proc.stdin.end();
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    proc = startServer(tmp, { CLAUDE_MEM_ALL_TOOLS: '1' });
    await rpc(proc, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tool-visibility-test', version: '0' },
    });
    const resp = await rpc(proc, 2, 'tools/list', {});
    expect(resp.error, 'tools/list error').toBeUndefined();
    const names = resp.result.tools.map((t) => t.name);
    expect(names).toHaveLength(18);
    expect(names).not.toContain('mem_search_feedback');
    // Spot-check hidden names are present
    expect(names).toContain('mem_stats');
    expect(names).toContain('mem_browse');
    expect(names).toContain('mem_maintain');
  });

  it('tools/call on a hidden tool (mem_stats) still succeeds', async () => {
    await rpc(proc, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tool-visibility-test', version: '0' },
    });
    const resp = await rpc(proc, 2, 'tools/call', {
      name: 'mem_stats',
      arguments: { days: 30 },
    });
    // Empty tmp DB should not throw "tool disabled" — should return a stats payload.
    expect(resp.error, 'tools/call error').toBeUndefined();
    expect(resp.result?.isError, 'result.isError').not.toBe(true);
    expect(resp.result?.content?.[0]?.type).toBe('text');
  });
});
