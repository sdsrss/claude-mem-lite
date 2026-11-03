// R3 O6 (docs/audits/20261103-r3-optimization-plan.md): the MCP instructions listed only READ
// verbs for the CLI, so a session writing through the CLI looked its flags up first — 54 `help`
// calls against 115 CLI writes in 138 sessions of other projects, and the full help is 15.7 KB.
// The two write lines are run here EXACTLY as advertised (placeholders filled), against a sandbox
// store, so a flag the CLI does not read cannot be advertised.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServerInstructions } from '../search-scoring.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

const FILL = [
  ['"<title>"', '"probe deferred title"'],
  ['1|2|3', '3'],
  ['"<why>"', '"probe deferred detail"'],
  ['"<what happened>"', '"probe saved text about the anchor"'],
  ['"<root cause + fix>"', '"probe lesson body"'],
];

let root, env;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mem-instr-cli-'));
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  mkdirSync(join(root, 'proj'), { recursive: true });
  env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  Object.assign(env, {
    HOME: join(root, 'home'),
    CLAUDE_MEM_DIR: join(root, 'data'),
    CLAUDE_PROJECT_DIR: join(root, 'proj'),
    PWD: join(root, 'proj'),
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_CODE_PATH: join(root, 'no-claude'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function advertised(verb) {
  const line = buildServerInstructions(true)
    .split('\n')
    .find((l) => l.startsWith(`  ${CLI_INVOKE} ${verb} `));
  expect(line, `instructions BASE advertise \`${verb}\``).toBeTruthy();
  let cmd = line.slice(2).split('  — ')[0];
  for (const [a, b] of FILL) cmd = cmd.split(a).join(b);
  expect(cmd, 'every placeholder is filled').not.toMatch(/[<>]/);
  return cmd;
}
const run = (cmd) => spawnSync('bash', ['-c', cmd], { cwd: join(root, 'proj'), env, encoding: 'utf8' });

describe('the CLI write lines in the MCP instructions run as written', () => {
  it('quiet (adopted) and full instructions both carry them', () => {
    for (const quiet of [true, false]) {
      const text = buildServerInstructions(quiet);
      expect(text).toContain(`${CLI_INVOKE} defer add `);
      expect(text).toContain(`${CLI_INVOKE} save `);
    }
  });

  it('`defer add` stores the title, the priority and the detail', () => {
    const r = run(advertised('defer add'));
    expect(r.status, r.stderr).toBe(0);
    const id = /D#(\d+)/.exec(r.stdout)?.[1];
    expect(id, r.stdout).toBeTruthy();
    const got = run(`${CLI_INVOKE} get D#${id}`);
    expect(got.stdout).toContain('probe deferred title');
    expect(got.stdout).toContain('probe deferred detail');
    expect(got.stdout).toContain('[P3]');
  });

  it('`save` stores the text as a bugfix with its lesson', () => {
    const r = run(advertised('save'));
    expect(r.status, r.stderr).toBe(0);
    const id = /#(\d+)/.exec(r.stdout)?.[1];
    expect(id, r.stdout).toBeTruthy();
    const got = run(`${CLI_INVOKE} get ${id}`);
    expect(got.stdout).toContain('probe lesson body');
    expect(got.stdout).toMatch(/bugfix/);
  });
});

// R3 O5: /claude-mem-lite:verify checks the commits a note cites (20 of 177 commit-citing notes in
// the maintainer's store cited a reverted or never-merged commit, docs/audits/20261103-r3-optimization-plan.md).
describe('verify skill: cited commits are checked against the branch', () => {
  it('names both checks and how each one reads', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const text = readFileSync(
      join(dirname(dirname(fileURLToPath(import.meta.url))), 'commands', 'verify.md'),
      'utf8',
    );
    expect(text).toContain('git merge-base --is-ancestor <sha> HEAD');
    expect(text).toContain('git log --oneline --grep=<first 8 hex>');
    expect(text).toMatch(/note that itself records the revert stays VALID/);
  });
});
