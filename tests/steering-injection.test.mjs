// Report §9-A (docs/audits/20260929-sandbox-usage-eval.md): auto-adopt no longer writes
// CLAUDE.md + .claude/plugin_claude_mem_lite.md into every project. SessionStart carries the
// same steering text instead, and "steering delivered" still counts as adopted for the quiet
// gate — otherwise every project would silently turn verbose (Key Context sections, the
// VERBOSE MCP instructions) the moment the files stopped being written.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { isAdoptedHere, effectiveQuiet } from '../lib/quiet-scope.mjs';
import { memdirPath, disableSentinelPath } from '../memdir.mjs';
import { buildClaudeMdBlock } from '../adopt-content.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEERING_HEADING = '## claude-mem-lite — persistent memory';

describe('injected steering counts as adopted', () => {
  let home;
  let cwd;
  const saved = {};
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cml-steer-'));
    cwd = join(home, 'work', 'app');
    mkdirSync(cwd, { recursive: true });
    for (const k of ['HOME', 'MEM_NO_AUTO_ADOPT', 'MEM_QUIET_HOOKS']) saved[k] = process.env[k];
    process.env.HOME = home;
    delete process.env.MEM_NO_AUTO_ADOPT;
    delete process.env.MEM_QUIET_HOOKS;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('a project with no files is adopted (and quiet) while auto-adopt is on', () => {
    expect(existsSync(join(cwd, 'CLAUDE.md'))).toBe(false);
    expect(isAdoptedHere(cwd)).toBe(true);
    expect(effectiveQuiet(cwd)).toBe(true);
  });

  it('MEM_NO_AUTO_ADOPT=1 means no steering at all, so not adopted', () => {
    process.env.MEM_NO_AUTO_ADOPT = '1';
    expect(isAdoptedHere(cwd)).toBe(false);
  });

  it('the per-project .mem-no-auto-adopt sentinel means not adopted', () => {
    const memdir = memdirPath(cwd);
    mkdirSync(memdir, { recursive: true });
    writeFileSync(disableSentinelPath(memdir), '{}');
    expect(isAdoptedHere(cwd)).toBe(false);
  });
});

describe('the steering block can point at a detail doc outside the project', () => {
  it('file mode keeps the committed relative reference; injection names the given path', () => {
    expect(buildClaudeMdBlock()).toContain('→ `.claude/plugin_claude_mem_lite.md`');
    const injected = buildClaudeMdBlock({ detailDocRef: '/data/cml/plugin_claude_mem_lite.md' });
    expect(injected).toContain('→ `/data/cml/plugin_claude_mem_lite.md`');
    expect(injected).not.toContain('.claude/plugin_claude_mem_lite.md');
  });
});

describe('SessionStart delivers the steering without touching the project', () => {
  let home;
  let cwd;
  let dataDir;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cml-steer-e2e-'));
    cwd = join(home, 'work', 'app');
    dataDir = join(home, 'data');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const sessionStart = (extraEnv = {}) =>
    spawnSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
      cwd,
      input: JSON.stringify({ session_id: 'steer-e2e-1', source: 'startup', cwd }),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|MEM_)/.test(k))),
        HOME: home,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_PROJECT_DIR: cwd,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        ...extraEnv,
      },
    });

  it('an unadopted project gets the steering in context and no file under cwd', () => {
    const r = sessionStart();
    expect(r.status).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
    const ctx = JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(STEERING_HEADING);
    // The detail doc it points at exists, and lives in the plugin's own data dir.
    const ref = /→ `([^`]+plugin_claude_mem_lite\.md)`/.exec(ctx)?.[1];
    expect(ref && ref.startsWith(dataDir)).toBe(true);
    expect(existsSync(ref)).toBe(true);
  });

  it('MEM_NO_AUTO_ADOPT=1 injects nothing', () => {
    const r = sessionStart({ MEM_NO_AUTO_ADOPT: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(STEERING_HEADING);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it('a project that carries the block is not injected twice', () => {
    writeFileSync(
      join(cwd, 'CLAUDE.md'),
      `<!-- claude-mem-lite:begin v1 -->\n${buildClaudeMdBlock()}\n<!-- claude-mem-lite:end -->\n`,
    );
    const r = sessionStart();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(STEERING_HEADING);
  });
});

// §9-A follow-up (user decision 2026-09-29): injected steering does not drive saves the way the
// CLAUDE.md block does (S3 bugfix saves 0/8 injected vs 7/12 written). So the USER — not the
// model — is offered the block once per project, on the human systemMessage channel.
describe('the one-time adopt offer', () => {
  let home;
  let cwd;
  let dataDir;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cml-offer-'));
    cwd = join(home, 'work', 'app');
    dataDir = join(home, 'data');
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const sessionStart = (extraEnv = {}) => {
    const r = spawnSync(process.execPath, [join(REPO, 'hook.mjs'), 'session-start'], {
      cwd,
      input: JSON.stringify({ session_id: 'offer-e2e', source: 'startup', cwd }),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|MEM_)/.test(k))),
        HOME: home,
        CLAUDE_MEM_DIR: dataDir,
        CLAUDE_PROJECT_DIR: cwd,
        CLAUDE_MEM_SKIP_UPDATE: '1',
        CLAUDE_MEM_SKIP_MAINTAIN: '1',
        ...extraEnv,
      },
    });
    expect(r.status).toBe(0);
    // A session with nothing to say writes nothing at all — an empty stdout is no envelope.
    return r.stdout.trim() ? JSON.parse(r.stdout.trim()) : {};
  };

  it('is shown to the user on the first injected session of a project, and only then', () => {
    const first = sessionStart();
    expect(first.systemMessage).toMatch(/\/adopt/);
    expect(first.systemMessage).toMatch(/CLAUDE\.md/);
    // The offer is for the human; the model's context carries the steering, not the offer.
    expect(first.hookSpecificOutput.additionalContext).not.toMatch(/once per project/);
    const second = sessionStart();
    expect(second.systemMessage).toBeUndefined();
  });

  it('MEM_NO_ADOPT_HINT=1 silences it', () => {
    expect(sessionStart({ MEM_NO_ADOPT_HINT: '1' }).systemMessage).toBeUndefined();
  });

  it('is not shown where the block is already written', () => {
    writeFileSync(
      join(cwd, 'CLAUDE.md'),
      `<!-- claude-mem-lite:begin v1 -->\n${buildClaudeMdBlock()}\n<!-- claude-mem-lite:end -->\n`,
    );
    expect(sessionStart().systemMessage).toBeUndefined();
  });
});
