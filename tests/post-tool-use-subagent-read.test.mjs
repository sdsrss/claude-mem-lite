// D#69 follow-up (pre-ship defect review P3-5): a subagent's Read must not become the main
// thread's files_read.
//
// hook.mjs keeps subagent calls (hook stdin `agent_id`, set by the host only inside a
// subagent) out of the episode buffer, but a Read never reaches hook.mjs: the bash
// prefilter's fast path appends its file_path to runtime/reads-<project>.txt, and the next
// main-thread flush collects that file as the observation's files_read. So a reviewer
// reading an extracted tree put its paths on the main thread's next row.
//
// Driven through the real script with a sandboxed HOME and CLAUDE_MEM_DIR; each case has a
// control arm (the same Read without agent_id appends) so a green cannot come from the
// fast path never running.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dirname, '../scripts/post-tool-use.sh');
const sandboxes = [];
afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true });
});

function read(payloadExtra, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mem-subread-home-'));
  const memDir = mkdtempSync(join(tmpdir(), 'mem-subread-data-'));
  sandboxes.push(home, memDir);
  const base = { ...process.env };
  // The developer's own plugin flags must not reach the child.
  for (const k of Object.keys(base)) if (/^(CLAUDE_MEM_|MEM_)/.test(k)) delete base[k];
  const r = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify({
      session_id: 'subread',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/review-tree/lib/alpha.mjs' },
      ...payloadExtra,
    }),
    env: { ...base, HOME: home, CLAUDE_MEM_DIR: memDir, CLAUDE_PROJECT_DIR: '/tmp/org/proj', ...env },
    encoding: 'utf8',
  });
  const readsFile = join(memDir, 'runtime', 'reads-org--proj.txt');
  return {
    r,
    lines: existsSync(readsFile) ? readFileSync(readsFile, 'utf8').split('\n').filter(Boolean) : [],
  };
}

describe('post-tool-use.sh Read fast path: subagent Reads (P3-5)', () => {
  it('control: a main-thread Read is appended', () => {
    const { r, lines } = read({});
    expect(r.status).toBe(0);
    expect(lines).toEqual(['/tmp/review-tree/lib/alpha.mjs']);
  });

  // Pre-ship delta review P3-7: the head -c 262144 window is all the script used to look
  // at, so an agent_id serialised AFTER a >256 KB tool_response was never seen.
  it('an agent_id past a >256 KB tool_response still keeps the Read out', () => {
    const { r, lines } = read({ tool_response: { content: 'x'.repeat(300000) }, agent_id: 'areviewer-9' });
    expect(r.status).toBe(0);
    expect(lines).toEqual([]);
  });

  it('control: the same >256 KB Read without agent_id is appended', () => {
    const { lines } = read({ tool_response: { content: 'x'.repeat(300000) } });
    expect(lines).toEqual(['/tmp/review-tree/lib/alpha.mjs']);
  });

  it('a Read carrying agent_id appends nothing', () => {
    const { r, lines } = read({ agent_id: 'adefect-lens-1', agent_type: 'general-purpose' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(lines).toEqual([]);
  });

  it('an EMPTY agent_id is the main thread and still appends', () => {
    expect(read({ agent_id: '' }).lines).toHaveLength(1);
  });

  it('agent_type alone (main thread of a --agent session) still appends', () => {
    expect(read({ agent_type: 'code-reviewer' }).lines).toHaveLength(1);
  });

  it('agent_id text inside the tool input is not the field', () => {
    const { lines } = read({ tool_input: { file_path: '/tmp/org/proj/a.json', note: '"agent_id":"x"' } });
    expect(lines).toEqual(['/tmp/org/proj/a.json']);
  });

  it('CLAUDE_MEM_EPISODE_INPUT_FILTER=off (any case) appends the subagent Read again', () => {
    for (const v of ['off', 'OFF', 'Off', '0', 'false', 'No']) {
      const { lines } = read({ agent_id: 'adefect-lens-1' }, { CLAUDE_MEM_EPISODE_INPUT_FILTER: v });
      expect(lines, `CLAUDE_MEM_EPISODE_INPUT_FILTER=${v}`).toHaveLength(1);
    }
    expect(read({ agent_id: 'a' }, { CLAUDE_MEM_EPISODE_INPUT_FILTER: 'on' }).lines).toEqual([]);
  });

  it('the bash switch agrees with hook.mjs on every value (one switch, two readers)', async () => {
    const { episodeInputFilterEnabled } = await import('../lib/episode-input-filter.mjs');
    for (const v of ['off', 'OFF', '0', 'false', 'No', 'on', '1', '', 'offf', ' off']) {
      const bashKept = read({ agent_id: 'a' }, { CLAUDE_MEM_EPISODE_INPUT_FILTER: v }).lines.length === 1;
      expect(bashKept, `value ${JSON.stringify(v)}`).toBe(
        !episodeInputFilterEnabled({ CLAUDE_MEM_EPISODE_INPUT_FILTER: v }),
      );
    }
  });
});
