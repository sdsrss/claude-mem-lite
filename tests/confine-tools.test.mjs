import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';

const SCRIPT = resolve(import.meta.dirname, '../benchmark/confine-tools.js');
function run(input) {
  return new Promise((res, rej) => {
    const c = spawn('node', [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.on('close', (code) => res({ out, code }));
    c.on('error', rej);
    c.stdin.write(JSON.stringify(input));
    c.stdin.end();
    setTimeout(() => {
      c.kill();
      rej(new Error('timeout'));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}

describe('confine-tools (harness-only deny hook)', () => {
  it('denies Bash with a permissionDecision + reason', async () => {
    const { out, code } = await run({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    const d = JSON.parse(out).hookSpecificOutput;
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason).toMatch(/Edit tool/);
    expect(code).toBe(0);
  });
  it('denies Agent and Task too', async () => {
    for (const t of ['Agent', 'Task']) {
      const { out } = await run({ tool_name: t, tool_input: {} });
      expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });
  it('allows Edit and Read (empty stdout = no decision)', async () => {
    for (const t of ['Edit', 'Read']) {
      const { out, code } = await run({ tool_name: t, tool_input: { file_path: '/x' } });
      expect(out).toBe('');
      expect(code).toBe(0);
    }
  });
  it('survives malformed stdin (exit 0, empty out)', async () => {
    const c = spawn('node', [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    const code = await new Promise((r) => {
      c.on('close', r);
      c.stdin.write('not json');
      c.stdin.end();
    });
    expect(out).toBe('');
    expect(code).toBe(0);
  });
});
