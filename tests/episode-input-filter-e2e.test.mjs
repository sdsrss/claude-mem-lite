// D#69 wiring: the input filters are only real if hook.mjs calls them. These cases drive
// the shipped entry point as a subprocess (PostToolUse → Stop) in a sandboxed data dir,
// each with a control arm through the off switch, so a green here cannot come from the
// fixture never reaching the code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO, 'hook.mjs');
let ROOT, DATA_DIR, RUNTIME_DIR, BASE_ENV;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-d69-'));
  DATA_DIR = join(ROOT, 'data');
  RUNTIME_DIR = join(DATA_DIR, 'runtime');
  mkdirSync(join(ROOT, 'home', '.claude'), { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  BASE_ENV = { ...process.env };
  // The developer's own plugin flags must not reach the child (the #8608 leak class).
  for (const k of Object.keys(BASE_ENV)) if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  delete BASE_ENV.CLAUDE_PROJECT_DIR;
  delete BASE_ENV.PWD;
  Object.assign(BASE_ENV, {
    HOME: join(ROOT, 'home'),
    CLAUDE_MEM_DIR: DATA_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'),
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    MEM_NO_AUTO_ADOPT: '1',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
  });
});

afterAll(async () => {
  // Stop spawns a detached summary worker; let it exit before the sandbox goes.
  await new Promise((r) => setTimeout(r, 500));
  rmSync(ROOT, { recursive: true, force: true });
});

function hook(event, { cwd, stdin, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, event], {
      cwd,
      env: { ...BASE_ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${event} did not exit`));
    }, 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(stdin));
  });
}

function workDir(name) {
  const d = join(ROOT, 'work', name);
  mkdirSync(d, { recursive: true });
  return { cwd: d, project: `work--${name}` };
}
const bufferOf = (project) => join(RUNTIME_DIR, `ep-${project}.json`);
function metricRows(event) {
  const dir = join(DATA_DIR, 'metrics');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === event);
}

async function post(cwd, stdin, env) {
  const r = await hook('post-tool-use', { cwd, stdin: { session_id: 'cc-d69', ...stdin }, env });
  expect(r.code, r.stderr).toBe(0);
}
async function stop(cwd, env) {
  const r = await hook('stop', {
    cwd,
    stdin: { session_id: 'cc-d69', transcript_path: join(ROOT, 'none.jsonl') },
    env,
  });
  expect(r.code, r.stderr).toBe(0);
}
function narratives(project) {
  const db = new Database(join(DATA_DIR, 'claude-mem-lite.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT narrative FROM observations WHERE project = ?')
      .all(project)
      .map((r) => r.narrative);
  } finally {
    db.close();
  }
}

// `schema.sql`, not any .sql: a plain "Modified widgets.sql" title is dropped by the
// write-side noise gate, and then neither arm lands a row to read.
const schemaWrite = (cwd) => ({
  tool_name: 'Write',
  tool_input: { file_path: join(cwd, 'schema.sql'), content: 'CREATE TABLE widgets (id INTEGER);\n' },
  tool_response: `File created successfully at: ${join(cwd, 'schema.sql')}`,
});

describe('D#69 capture: subagent calls stay out of the episode buffer', () => {
  it('a subagent write OUTSIDE the project buffers nothing; the same call from the main thread does', async () => {
    const { cwd, project } = workDir('sub');
    // A reviewer probing an extracted tree: the file is outside the session's project dir.
    const extracted = join(ROOT, 'extracted-review-tree');
    mkdirSync(extracted, { recursive: true });
    await post(cwd, { ...schemaWrite(extracted), agent_id: 'adefect-lens-1' });
    expect(existsSync(bufferOf(project)), 'a subagent call reached the episode buffer').toBe(false);
    await post(cwd, schemaWrite(extracted)); // control: the main thread's identical call
    expect(existsSync(bufferOf(project)), 'control: a main-thread call must buffer').toBe(true);
  });

  it("a subagent EDIT inside the project is the session's work and is buffered", async () => {
    const { cwd, project } = workDir('sub-impl');
    await post(cwd, { ...schemaWrite(cwd), agent_id: 'aimplementer-1' });
    expect(existsSync(bufferOf(project)), 'an implementer subagent edit was dropped').toBe(true);
  });

  it('a subagent command that edits nothing is not buffered, even inside the project', async () => {
    const { cwd, project } = workDir('sub-read');
    await post(cwd, {
      tool_name: 'Bash',
      tool_input: { command: 'cat schema.sql && git status' },
      tool_response: 'CREATE TABLE widgets (id INTEGER);\nOn branch main\nnothing to commit',
      cwd,
      agent_id: 'areader-1',
    });
    expect(existsSync(bufferOf(project))).toBe(false);
  });

  it('CLAUDE_MEM_EPISODE_INPUT_FILTER=off buffers the subagent call again', async () => {
    const { cwd, project } = workDir('sub-off');
    await post(
      cwd,
      { ...schemaWrite(cwd), agent_id: 'adefect-lens-1' },
      { CLAUDE_MEM_EPISODE_INPUT_FILTER: 'off' },
    );
    expect(existsSync(bufferOf(project))).toBe(true);
  });

  it('captures tags and diagnosis lines onto the buffered entry', async () => {
    const { cwd, project } = workDir('diag');
    await post(cwd, {
      tool_name: 'Bash',
      tool_input: { command: "python3 - <<'PY'\nassert a in s, 'anchor not found'\nPY\necho done" },
      tool_response:
        'Traceback (most recent call last):\n  File "<stdin>", line 1, in <module>\nAssertionError: anchor not found\ndone',
    });
    const [e] = JSON.parse(readFileSync(bufferOf(project), 'utf8')).entries;
    expect(e.inputTags).toContain('slip');
    expect(e.diag).toContain('AssertionError: anchor not found');
    // D#100(3): an output line is marked as tool output for the worker's importance cap.
    expect(e.diagOut).toEqual(e.diag);
  });
});

describe('D#69 capture: a Bash patch contributes its comment block as diagnosis', () => {
  it('reads the heredoc comment only because the hook resolved the command as a WRITE', async () => {
    const { cwd, project } = workDir('bash-patch');
    await post(cwd, {
      cwd,
      tool_name: 'Bash',
      tool_input: {
        command:
          "python3 - <<'PY'\np='lib/a.mjs'; s=open(p).read()\ns=s.replace('x', '''// A LIMIT upstream of a JS filter is a reachability bound:\n// the demoted row was evicted, not ranked lower.\nx''')\nopen(p,'w').write(s)\nPY",
      },
      tool_response: 'patched lib/a.mjs',
    });
    const [e] = JSON.parse(readFileSync(bufferOf(project), 'utf8')).entries;
    expect(e.bashWrites, 'premise: the hook must see this command as a write').toEqual([
      join(cwd, 'lib/a.mjs'),
    ]);
    expect(e.diag).toEqual([
      'A LIMIT upstream of a JS filter is a reachability bound: the demoted row was evicted, not ranked lower.',
    ]);
    expect(e.diagOut, 'a comment the agent wrote is not tool output').toEqual([]);
  });
});

describe('D#69 flush: a probe never reaches the saved observation', () => {
  const PROBE = {
    tool_name: 'Bash',
    tool_input: {
      command:
        'cp lib/x.mjs "$BAK"\nperl -0pi -e "s/a/b/" lib/x.mjs\necho "=== mutation landed? ==="; grep -c b lib/x.mjs',
    },
    tool_response: '=== mutation landed? ===\n1\nPROBEMARK',
  };
  const RED = {
    tool_name: 'Bash',
    tool_input: { command: 'npx vitest run tests/x.test.mjs' },
    tool_response:
      ' FAIL tests/x.test.mjs > guard\nAssertionError: expected 1 to be 0\nREDMARK\n Tests 1 failed (1)',
  };

  async function run(name, env, calls) {
    const { cwd, project } = workDir(name);
    await post(cwd, schemaWrite(cwd), env);
    for (const c of calls) await post(cwd, c, env);
    await stop(cwd, env);
    return narratives(project);
  }

  it('the probe call is gone from the immediate observation, and the flush meters it', async () => {
    const metrics = { CLAUDE_MEM_METRICS: '1' };
    const on = await run('probe', metrics, [PROBE]);
    expect(on, 'premise: the schema write must land a row').toHaveLength(1);
    expect(on[0]).not.toMatch(/mutation landed/);
    expect(metricRows('episode_input_filter')).toContainEqual(expect.objectContaining({ probe: 1, slip: 0 }));
    // Control: with the filter off the same flush runs (its significance row is written)
    // and no filter row appears. The row itself cannot be the control here — unfiltered,
    // "Modified schema.sql" plus a Bash call is dropped by the write-side noise gate.
    const before = metricRows('episode_input_filter').length;
    const sigBefore = metricRows('episode_significance').length;
    await run('probe-off', { ...metrics, CLAUDE_MEM_EPISODE_INPUT_FILTER: 'off' }, [PROBE]);
    expect(metricRows('episode_significance').length).toBeGreaterThan(sigBefore);
    expect(metricRows('episode_input_filter')).toHaveLength(before);
  });

  it('the span takes the probe\'s RED run too — which, unfiltered, turns the row into a dropped "Error:" title', async () => {
    const on = await run('span', {}, [PROBE, RED]);
    expect(on).toHaveLength(1);
    expect(on[0]).not.toMatch(/mutation landed|vitest run/);
    // Pre-D#69 the intentional RED run named the whole window: the immediate title became
    // "Error: schema.sql: FAIL …", which the write-side noise gate drops — the schema
    // write went unrecorded because a probe went red on purpose.
    const off = await run('span-off', { CLAUDE_MEM_EPISODE_INPUT_FILTER: 'off' }, [PROBE, RED]);
    expect(off).toHaveLength(0);
  });
});

// P2-2 (pre-ship defect review): a call that WROTE a project file is dropped only when a
// restore follows. The hook resolves writes against stdin `cwd` and passes its project dir,
// so a probe's write outside the project (a vendored copy) protects nothing.
describe('D#69 flush: an unrestored project write survives the probe filter (P2-2)', () => {
  const probe = (target) => ({
    tool_name: 'Bash',
    tool_input: {
      command: `cp ${target} "$BAK"\nperl -0pi -e "s/a/b/" ${target}\necho "=== mutation landed? ==="`,
    },
    tool_response: '=== mutation landed? ===\n1',
  });
  const restore = (target) => ({
    tool_name: 'Bash',
    tool_input: { command: `cp "$BAK" ${target}\necho "reverted"; md5sum ${target}` },
    tool_response: 'reverted\n1577347ff9c1b4df253c784d7e98ce86  x.mjs',
  });

  async function filterRows(name, calls) {
    const { cwd } = workDir(name);
    const env = { CLAUDE_MEM_METRICS: '1' };
    const before = metricRows('episode_input_filter').length;
    for (const c of calls(cwd)) await post(cwd, { cwd, ...c }, env);
    await stop(cwd, env);
    return metricRows('episode_input_filter').slice(before);
  }

  it('a project write with no restore is kept: nothing is dropped', async () => {
    const sigBefore = metricRows('episode_significance').length;
    expect(await filterRows('keep-write', () => [probe('lib/x.mjs')])).toEqual([]);
    // Premise: the flush ran (a silent [] would also come from no flush at all).
    expect(metricRows('episode_significance').length).toBeGreaterThan(sigBefore);
  });

  it('the same write followed by its restore is dropped with the restore', async () => {
    const rows = await filterRows('restored-write', () => [probe('lib/x.mjs'), restore('lib/x.mjs')]);
    expect(rows).toEqual([expect.objectContaining({ probe: 2 })]);
  });

  it('a write outside the project protects nothing (the hook passes its project dir)', async () => {
    const rows = await filterRows('outside-write', () => [probe('/opt/vendor/x.mjs')]);
    expect(rows).toEqual([expect.objectContaining({ probe: 1 })]);
  });
});
