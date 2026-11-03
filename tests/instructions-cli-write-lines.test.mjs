// R3 O6 (docs/audits/20261103-r3-optimization-plan.md): the MCP instructions listed only READ
// verbs for the CLI, so a session writing through the CLI looked its flags up first, and the full
// help is 15.7 KB.
// The two write lines are run here EXACTLY as advertised (placeholders filled), against a sandbox
// store, so a flag the CLI does not read cannot be advertised.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildServerInstructions } from '../search-scoring.mjs';
import { CLI_INVOKE } from '../cli-path.mjs';

const FILL = [
  ['"<title>"', '"probe deferred title"'],
  ['1|2|3', '3'],
  ['"<why>"', '"probe deferred detail"'],
  ['"<what happened>"', '"probe saved text about the anchor"'],
  ['"<root cause + fix>"', '"probe lesson body"'],
  ['--files <path>', '--files src/probe.mjs'],
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
    // The edge PreToolUse recall keys on, read from the junction itself (delta review F5).
    const db = new Database(join(root, 'data', 'claude-mem-lite.db'), { readonly: true });
    const edges = db.prepare('SELECT filename FROM observation_files WHERE obs_id = ?').all(Number(id));
    db.close();
    expect(edges.map((e) => e.filename).join(' '), 'observation_files carries the --files path').toContain(
      'probe.mjs',
    );
  });
});

// R3 O5: /claude-mem-lite:verify checks the commits a note cites
// (docs/audits/20261103-r3-optimization-plan.md).
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

  // v6.31.0 review r1 (claims P2-2): a commit re-made under another sha (a rebase, a squash, a
  // cherry-pick — this repository re-makes its release commits that way) also exits 1 from
  // --is-ancestor, so exit 1 alone proposed STALE for notes whose code is current. The skill names
  // `git cherry`, which compares patches; both readings are run here exactly as the skill writes them.
  it('tells a change re-made under another sha from one that never landed', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const text = readFileSync(
      join(dirname(dirname(fileURLToPath(import.meta.url))), 'commands', 'verify.md'),
      'utf8',
    );
    const CHERRY = 'git cherry HEAD <sha> <sha>~1';
    expect(text).toContain(CHERRY);
    expect(text).toMatch(/`-` = the same change landed under another sha/);
    expect(text).toMatch(/`\+` = it never landed/);

    const repo = join(root, 'cherry-repo');
    mkdirSync(repo, { recursive: true });
    const genv = { ...process.env };
    for (const k of Object.keys(genv)) if (k.startsWith('GIT_')) delete genv[k];
    const git = (...args) => {
      const r = spawnSync(
        'git',
        ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
        { encoding: 'utf8', env: genv },
      );
      return { code: r.status, out: (r.stdout || '').trim() };
    };
    const { writeFileSync } = await import('node:fs');
    const commitFile = (name, body) => {
      writeFileSync(join(repo, name), body);
      expect(git('add', name).code).toBe(0);
      expect(git('commit', '-q', '-m', name).code).toBe(0);
      return git('rev-parse', 'HEAD').out;
    };
    expect(git('init', '-q', '-b', 'main').code).toBe(0);
    commitFile('a.txt', 'a\n');
    expect(git('checkout', '-q', '-b', 'side').code).toBe(0);
    const remade = commitFile('b.txt', 'b\n');
    expect(git('checkout', '-q', '-b', 'abandoned', 'main').code).toBe(0);
    const abandoned = commitFile('c.txt', 'c\n');
    expect(git('checkout', '-q', 'main').code).toBe(0);
    commitFile('d.txt', 'd\n'); // main moved on, so the pick gets a new parent and a new sha
    expect(git('cherry-pick', remade).code).toBe(0);

    const run = (sha) => {
      const anc = git('merge-base', '--is-ancestor', sha, 'HEAD').code;
      const [cmd, ...args] = CHERRY.replaceAll('<sha>', sha).split(' ');
      expect(cmd).toBe('git');
      return { anc, cherry: git(...args).out };
    };
    // Premise: both are off the branch to --is-ancestor; only the cherry reading separates them.
    expect(run(remade)).toEqual({ anc: 1, cherry: `- ${remade}` });
    expect(run(abandoned)).toEqual({ anc: 1, cherry: `+ ${abandoned}` });
  });
});
