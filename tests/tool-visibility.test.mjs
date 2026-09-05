// v2.34.0 tool-visibility split (expanded v2.70.0): only 9 core tools appear
// in tools/list (the original 6 + mem_defer/mem_defer_list/mem_defer_drop); the
// 11 hidden maintenance/admin tools stay callable by exact name. This test
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
    env: { ...process.env, CLAUDE_MEM_DIR: memDir, MEM_QUIET_HOOKS: '1', ...extraEnv },
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

  it('tools/list returns exactly the 9 core names', async () => {
    await rpc(proc, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tool-visibility-test', version: '0' },
    });
    const resp = await rpc(proc, 2, 'tools/list', {});
    expect(resp.error, 'tools/list error').toBeUndefined();
    const names = resp.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_CORE);
  });

  it('CLAUDE_MEM_ALL_TOOLS=1 restores all 20 tools in tools/list (opt-out)', async () => {
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
    expect(names).toHaveLength(20);
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
