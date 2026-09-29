// PreToolUse:Bash file recall (N1, docs/audits/20260926-154904-session-history-analysis-r2.md).
//
// On Opus 5.5 82% of file edits and 85% of file reads were Bash commands, so the recall
// face with the highest measured cite rate stopped firing without an error. The Bash leg
// recalls a command as the Edit (first file written) or Read (first file viewed) it stands
// for. Two halves are pinned here through the REAL entry points: the prefilter script
// (scripts/pre-tool-recall-bash.sh, what hooks.json runs) and the node script it execs.
// The "correct usage" half matters as much as the firing half: a recall that fired on
// every `grep -rn` would be worse than the silence it replaces.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { resolve, join, dirname } from 'path';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { initSchema } from '../schema.mjs';
import { insertSession, insertObs, SUBPROCESS_TIMEOUT_MS } from './test-helpers.mjs';
import Database from 'better-sqlite3';

const PREFILTER = resolve(import.meta.dirname, '../scripts/pre-tool-recall-bash.sh');
const SCRIPT = resolve(import.meta.dirname, '../scripts/pre-tool-recall.js');

function run(cmd, args, input, env) {
  return new Promise((resolveP, reject) => {
    const childEnv = { ...process.env, CLAUDE_MEM_HOOK_RUNNING: '', ...env };
    if (!('CLAUDE_MEM_METRICS' in env)) delete childEnv.CLAUDE_MEM_METRICS;
    const child = spawn(cmd, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', () => resolveP({ stdout }));
    child.on('error', reject);
    child.stdin.on('error', () => {}); // a hook may exit before reading everything
    child.stdin.end(JSON.stringify(input));
    setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, SUBPROCESS_TIMEOUT_MS);
  });
}
const viaPrefilter = (input, env) => run('bash', [PREFILTER], input, env);
const viaScript = (input, env) => run('node', [SCRIPT], input, env);

describe('PreToolUse:Bash file recall', () => {
  let tmpRoot;
  let projectDir;
  const env = (extra = {}) => ({ CLAUDE_MEM_DIR: tmpRoot, CLAUDE_PROJECT_DIR: projectDir, ...extra });
  const bash = (command, sid = 's1') => ({
    tool_name: 'Bash',
    session_id: sid,
    cwd: projectDir,
    tool_input: { command, description: 'x' },
  });
  const hookErrors = () => {
    const d = join(tmpRoot, 'runtime', 'hook-errors');
    return existsSync(d) ? readdirSync(d) : [];
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), `pre-recall-bash-${process.pid}-`));
    projectDir = join(tmpRoot, 'parent', 'bashtest');
    mkdirSync(join(projectDir, 'lib'), { recursive: true });
    writeFileSync(join(projectDir, 'lib', 'm.mjs'), 'export const v = 1;\n');
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    db.pragma('foreign_keys = OFF');
    initSchema(db);
    insertSession(db, { id: 'sess-b', project: 'parent--bashtest', memoryId: 'mem-b' });
    insertObs(db, {
      sessionId: 'mem-b',
      project: 'parent--bashtest',
      type: 'bugfix',
      importance: 2,
      title: 'm.mjs export order',
      lessonLearned: 'Keep the v export first: the loader reads it before init.',
      filesModified: JSON.stringify([join(projectDir, 'lib', 'm.mjs')]),
    });
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  it('a Bash view recalls the file in read mode', async () => {
    const { stdout } = await viaPrefilter(bash("sed -n '1,40p' lib/m.mjs"), env());
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Lessons for m.mjs');
    expect(ctx).toContain('Keep the v export first');
    expect(ctx).not.toContain('Before this edit');
  });

  it('CLAUDE_MEM_BASH_RECALL=off silences the Bash leg (control: same call fires without it)', async () => {
    const cmd = bash("sed -n '1,40p' lib/m.mjs", 'soff');
    for (const v of ['off', 'OFF', 'False', 'no', '0']) {
      expect((await viaPrefilter(cmd, env({ CLAUDE_MEM_BASH_RECALL: v }))).stdout, v).toBe('');
    }
    expect((await viaPrefilter(bash("sed -n '1,40p' lib/m.mjs", 'son'), env())).stdout).toContain(
      'Keep the v export first',
    );
  });

  it('a Bash edit recalls the file in edit mode, with the ack directive', async () => {
    const { stdout } = await viaPrefilter(bash(`cd ${projectDir} && sed -i 's/1/2/' lib/m.mjs`), env());
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Keep the v export first');
    expect(ctx).toContain('Before this edit');
  });

  it('a python heredoc patch is an edit of the file it names', async () => {
    const cmd = `python3 - <<'EOF'\np = "${projectDir}/lib/m.mjs"\ns = open(p).read()\nopen(p, "w").write(s)\nEOF`;
    const { stdout } = await viaPrefilter(bash(cmd), env());
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain('Before this edit');
  });

  it('a Bash view then an Edit of the same file gets the Read→Edit ack nudge', async () => {
    await viaPrefilter(bash('cat lib/m.mjs', 's9'), env());
    const { stdout } = await viaScript(
      { tool_name: 'Edit', session_id: 's9', tool_input: { file_path: join(projectDir, 'lib', 'm.mjs') } },
      env(),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toMatch(
      /Lessons #\d+ were shown when you Read m\.mjs/,
    );
  });

  // Pre-ship review P3-3: a Bash page (`sed -n`) wrote the file's cooldown entry with
  // reread.full=false, and a later full Read exited at the cooldown without arming the
  // guard — so a Bash view silenced the repeated-read guard for that file all session.
  it('a Bash page does not disarm the repeated-read guard for later full Reads', async () => {
    const big = join(projectDir, 'lib', 'big.mjs');
    writeFileSync(big, 'export const line = "some reasonably long content for token mass";\n'.repeat(400));
    const read = { tool_name: 'Read', session_id: 'sr', tool_input: { file_path: big } };
    await viaPrefilter(bash("sed -n '1,20p' lib/big.mjs", 'sr'), env());
    await viaScript(read, env()); // first full read: arms the guard
    const { stdout } = await viaScript(read, env()); // unchanged full re-read: warns
    expect(stdout).toMatch(/big\.mjs/);
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toMatch(/already|re-?read/i);
  });

  it('control: without the Bash page, Read then Read warns the same way', async () => {
    const big = join(projectDir, 'lib', 'big2.mjs');
    writeFileSync(big, 'export const line = "some reasonably long content for token mass";\n'.repeat(400));
    const read = { tool_name: 'Read', session_id: 'sr2', tool_input: { file_path: big } };
    await viaScript(read, env());
    const { stdout } = await viaScript(read, env());
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toMatch(/already|re-?read/i);
  });

  it('meters the firing as via bash', async () => {
    await viaPrefilter(bash('head -n 5 lib/m.mjs'), env({ CLAUDE_MEM_METRICS: '1' }));
    const day = new Date().toISOString().slice(0, 10);
    const rows = readFileSync(join(tmpRoot, 'metrics', `${day}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === 'pretool_recall');
    expect(rows).toMatchObject([{ mode: 'read', via: 'bash', injected: 1 }]);
  });

  it('a session-scoped path is never recalled, even when a lesson is filed under it', async () => {
    const dep = join(projectDir, 'node_modules', 'pkg', 'index.js');
    mkdirSync(dirname(dep), { recursive: true });
    writeFileSync(dep, 'module.exports = 1;\n');
    const db = new Database(join(tmpRoot, 'claude-mem-lite.db'));
    insertObs(db, {
      sessionId: 'mem-b',
      project: 'parent--bashtest',
      type: 'bugfix',
      importance: 2,
      title: 'dep',
      lessonLearned: 'Vendored dependency lesson that must not surface.',
      filesModified: JSON.stringify([dep]),
    });
    db.close();
    // Control: the same lesson IS reachable through the Read tool, so silence below is the
    // transient-path rule and not a missing edge.
    const control = await viaScript(
      { tool_name: 'Read', session_id: 'sc', tool_input: { file_path: dep } },
      env(),
    );
    expect(control.stdout).toContain('Vendored dependency lesson');
    const { stdout } = await viaPrefilter(bash('cat node_modules/pkg/index.js', 'sd'), env());
    expect(stdout).toBe('');
  });

  // The prefilter's whole job is not starting Node. Observed directly: a `node` shim on
  // PATH records every start.
  describe('prefilter: when Node starts', () => {
    const withShim = async (command) => {
      const bin = join(tmpRoot, 'bin');
      mkdirSync(bin, { recursive: true });
      const marker = join(tmpRoot, 'node-started');
      writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\ncat >/dev/null\necho x >> "${marker}"\n`, {
        mode: 0o755,
      });
      rmSync(marker, { force: true });
      await viaPrefilter(bash(command), env({ PATH: `${bin}:${process.env.PATH}` }));
      return existsSync(marker);
    };
    it.each([
      ['cat lib/m.mjs', true],
      ["sed -i 's/a/b/' lib/m.mjs", true],
      ['python3 - <<EOF\nopen("lib/m.mjs")\nEOF', true],
      ['echo x > lib/out.json', true],
      // Pre-ship review P3-1: shapes the node side recalls that the prefilter used to skip.
      ['python3 <<EOF\nopen("lib/m.mjs", "w")\nEOF', true],
      ['python3 <<"EOF"\nopen("lib/m.mjs", "w")\nEOF', true],
      ['python3 <<-EOF\nopen("lib/m.mjs", "w")\nEOF', true],
      ["/usr/bin/python3 -c \"open('lib/out.json','w')\"", true],
      ["python3.12 -c \"open('lib/out.json','w')\"", true],
      ['truncate -s 0 lib/x.log', true],
      ['ln -sf lib/a.mjs lib/b.mjs', true],
      ['time cat lib/m.mjs', true],
      ['env FOO=1 cat lib/m.mjs', true],
      ['sudo -u root cat lib/m.mjs', true],
      ['timeout -s KILL 5 cat lib/m.mjs', true],
      ['for l in 1 2; do sed -n "1,${l}p" lib/m.mjs; done', true],
      ['echo hi\n\tcat lib/m.mjs', true],
      ['git status', false],
      ['node cli.mjs search foo | head -5', false], // a pipe tail reads stdin, not a file
      ['npx vitest run tests/x.test.mjs 2>&1 | tail -20', false],
      ['cat $SP/notes.md', false], // expansion: the node side would skip it anyway
      ['grep -rn foo lib/m.mjs', false],
    ])('%s → starts node: %s', async (command, expected) => {
      expect(await withShim(command)).toBe(expected);
    });
  });

  // Pre-ship delta review P2-B: JSON escapes a heredoc's newlines and tabs, so a data
  // heredoc is one long whitespace-free token to bash. A regex token that could span
  // those escapes made the prefilter quadratic — 8.8 s at 149 KB against a 3 s hook
  // timeout. Measured linear after the fix (66 ms at 149 KB); the bound leaves ~20x.
  it('a large tab-separated data heredoc clears the prefilter well inside the hook timeout', async () => {
    const row = Array.from({ length: 12 }, (_, i) => `${i % 2 ? '-' : ''}0.${(143 * i) % 997}`).join('\t');
    const body = [];
    for (let n = 0; n < 149 * 1024; n += row.length + 1) body.push(row);
    const t0 = Date.now();
    await viaPrefilter(bash(`python3 analyze.py <<'EOF'\n${body.join('\n')}\nEOF`), env());
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  // Pre-ship round-3 review P2-3: non-heredoc runs with many command-start characters.
  it.each([
    'echo a.mjs ' + ';x='.repeat(30000),
    'echo a.mjs ' + '( -a('.repeat(20000),
    'echo a.mjs ' + ';a/python'.repeat(12000),
  ])('the prefilter stays bounded on %#', async (command) => {
    const t0 = Date.now();
    await viaPrefilter(bash(command), env());
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('drains a multi-megabyte payload even when it exits early (no EPIPE for the writer)', async () => {
    const big = JSON.stringify(bash(`cat <<'EOF' > lib/big.txt\n${'x'.repeat(4 * 1024 * 1024)}\nEOF`));
    const pipeErrors = [];
    await new Promise((resolveP, reject) => {
      const child = spawn('bash', [PREFILTER], {
        env: { ...process.env, ...env({ CLAUDE_MEM_BASH_RECALL: 'off' }), CLAUDE_MEM_HOOK_RUNNING: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', (e) => pipeErrors.push(e.code));
      child.on('close', resolveP);
      child.on('error', reject);
      child.stdin.end(big);
    });
    expect(pipeErrors).toEqual([]);
  });

  // Correct-usage sweep: none of these views or writes one file. Each must stay silent
  // through BOTH entry points and must not log a hook error (for Bash, no target is the
  // normal case, not the upstream field rename the shape probe records).
  it.each([
    'grep -rn "export" lib',
    'grep -n export lib/m.mjs',
    'rg export lib/m.mjs',
    'git status',
    'git diff lib/m.mjs',
    'npx vitest run lib/m.mjs',
    'node lib/m.mjs',
    'wc -l lib/m.mjs',
    'ls lib',
    'npm run format >/dev/null 2>&1',
    'echo lib/m.mjs',
    'cat /tmp/claude-1000/-p/sess/scratchpad/notes.md',
  ])('stays silent on %s', async (command) => {
    const a = await viaPrefilter(bash(command), env());
    const b = await viaScript(bash(command), env());
    expect(a.stdout).toBe('');
    expect(b.stdout).toBe('');
    expect(hookErrors()).toEqual([]);
  });
});
