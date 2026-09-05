// Regression pins for the 2026-08-22 audit, P1-3 — the last un-collapsed CLI/MCP twin.
//
// `registry import|remove|reindex` was the only pair of the five twins where both sides
// still wrote their own SQL. The drift the audit found: the CLI granted a freshly imported
// resource `quality_tier = 'installed'` (mem-cli.mjs:2358 — "the user explicitly chose to
// add this"), and the MCP twin did not. Same user intent, two different rows, and
// quality_tier feeds the retriever's ranking bonus + the recommendation gate, so the
// import route silently decided how discoverable the resource would be.
//
// The failing input, stated plainly: import `parity-probe` with no --source on each side,
// then read back quality_tier. Pre-fix CLI = 'installed', MCP = the schema default.
//
// Both cases run through the REAL surfaces (spawned cli.mjs / server.mjs over stdio), not
// through lib/registry-core.mjs directly — a shared core that no surface actually calls is
// exactly the failure mode this pins against.
//
// ISOLATION: every child gets CLAUDE_MEM_DIR + HOME inside a mkdtemp sandbox and a cwd
// inside it, so nothing touches the live ~/.claude-mem-lite DB or this repo.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(REPO, 'cli.mjs');
const SERVER_PATH = join(REPO, 'server.mjs');

let ROOT, HOME_DIR, BASE_ENV;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'mem-parity0822-'));
  HOME_DIR = join(ROOT, 'home');
  mkdirSync(join(HOME_DIR, '.claude'), { recursive: true });

  BASE_ENV = { ...process.env };
  // The developer's own plugin flags would otherwise flip default-OFF surfaces on in the
  // child (the #8608 leak class).
  for (const k of Object.keys(BASE_ENV)) {
    if (/^(CLAUDE_MEM_|MEM_|CLAUDE_PLUGIN_)/.test(k)) delete BASE_ENV[k];
  }
  Object.assign(BASE_ENV, {
    HOME: HOME_DIR,
    CLAUDE_CODE_PATH: join(ROOT, 'no-such-claude-binary'), // no LLM spend, no network
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLAUDE_MEM_SKIP_UPDATE: '1',
    CLAUDE_MEM_SKIP_EPISODE_LLM: '1',
    CLAUDE_MEM_SKIP_COMPRESS: '1',
    CLAUDE_MEM_SKIP_OPTIMIZE: '1',
    CLAUDE_MEM_SKIP_MAINTAIN: '1',
    CLAUDE_MEM_SKIP_SAVE_ENRICH: '1',
    CLAUDE_MEM_SKIP_REPOS: '1',
    CLAUDE_MEM_NO_DELAY: '1',
  });
  delete BASE_ENV.CLAUDE_PROJECT_DIR;
  delete BASE_ENV.PWD;
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function sandboxDir(...parts) {
  const d = join(ROOT, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

function fire(cmd, args, { cwd, env = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...BASE_ENV, ...env };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} did not exit within ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end('');
  });
}

async function startMcp(dataDir, cwd) {
  const env = { ...BASE_ENV, CLAUDE_MEM_DIR: dataDir, MEM_QUIET_HOOKS: '1', CLAUDE_MEM_AUTO_DEEP: '0' };
  delete env.CLAUDE_MEM_HOOK_RUNNING;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], cwd, env });
  const client = new Client({ name: 'mem-parity0822-client', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

const textOf = (res) =>
  (res?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** Read one resource row straight out of the registry DB the surface just wrote. */
function readResource(dataDir, type, name) {
  const db = new Database(join(dataDir, 'resource-registry.db'), { readonly: true });
  try {
    return db.prepare('SELECT * FROM resources WHERE type = ? AND name = ?').get(type, name);
  } finally {
    db.close();
  }
}

describe('P1-3 — registry import/remove/reindex behave identically on CLI and MCP', () => {
  const NAME = 'parity-probe';
  const TYPE = 'skill';
  const SUMMARY = 'Probe resource for the CLI/MCP registry parity pin.';

  let cliRow, mcpRow;

  beforeAll(async () => {
    // ── CLI side ──
    const cliDir = sandboxDir('cli-data');
    const cliCwd = sandboxDir('cli-proj');
    const r = await fire(
      process.execPath,
      [
        CLI_PATH,
        'registry',
        'import',
        '--name',
        NAME,
        '--resource-type',
        TYPE,
        '--capability-summary',
        SUMMARY,
      ],
      { cwd: cliCwd, env: { CLAUDE_MEM_DIR: cliDir } },
    );
    expect(r.code, `CLI import failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    cliRow = readResource(cliDir, TYPE, NAME);

    // ── MCP side ──
    const mcpDir = sandboxDir('mcp-data');
    const mcpCwd = sandboxDir('mcp-proj');
    const { client, transport } = await startMcp(mcpDir, mcpCwd);
    try {
      const res = await client.callTool({
        name: 'mem_registry',
        arguments: { action: 'import', name: NAME, resource_type: TYPE, capability_summary: SUMMARY },
      });
      expect(textOf(res), 'MCP import did not report success').toMatch(/Imported/);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
    mcpRow = readResource(mcpDir, TYPE, NAME);
  }, 60000);

  it('both sides actually created the row', () => {
    expect(cliRow, 'CLI import wrote no row').toBeTruthy();
    expect(mcpRow, 'MCP import wrote no row').toBeTruthy();
  });

  // THE drift the audit named. Pre-fix: cli 'installed', mcp null/default.
  it('grants the same quality_tier for a user-initiated import (no --source)', () => {
    expect(cliRow.quality_tier).toBe('installed');
    expect(mcpRow.quality_tier).toBe(cliRow.quality_tier);
  });

  it('records the same source provenance for a new resource', () => {
    expect(cliRow.source).toBe('user');
    expect(mcpRow.source).toBe(cliRow.source);
  });

  // Everything else the two sides write about the same import must match too — a field
  // that drifts later is the same defect wearing a different column name. Columns that
  // legitimately differ per-row (identity, timestamps) are excluded by name, not by
  // sampling, so a NEW column is compared by default rather than silently skipped.
  it('writes identical values in every non-identity column', () => {
    const PER_ROW = new Set(['id', 'created_at', 'updated_at', 'indexed_at', 'last_used_at']);
    const differing = Object.keys(cliRow)
      .filter((k) => !PER_ROW.has(k))
      .filter((k) => cliRow[k] !== mcpRow[k])
      .map((k) => `${k}: cli=${JSON.stringify(cliRow[k])} mcp=${JSON.stringify(mcpRow[k])}`);
    expect(differing, `columns that drift between the twins:\n${differing.join('\n')}`).toEqual([]);
  });

  it('remove reports the same not-found outcome on both sides', async () => {
    const dir = sandboxDir('rm-data');
    const cwd = sandboxDir('rm-proj');
    // Seed via CLI so the row exists, then remove it via MCP: cross-surface, which is the
    // only way a shared core is actually proven shared.
    await fire(process.execPath, [CLI_PATH, 'registry', 'import', '--name', NAME, '--resource-type', TYPE], {
      cwd,
      env: { CLAUDE_MEM_DIR: dir },
    });

    const { client, transport } = await startMcp(dir, cwd);
    try {
      const hit = await client.callTool({
        name: 'mem_registry',
        arguments: { action: 'remove', name: NAME, resource_type: TYPE },
      });
      expect(textOf(hit)).toMatch(/Removed/);
      expect(readResource(dir, TYPE, NAME)).toBeFalsy();

      const miss = await client.callTool({
        name: 'mem_registry',
        arguments: { action: 'remove', name: NAME, resource_type: TYPE },
      });
      expect(textOf(miss)).toMatch(/[Nn]ot found/);
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }

    // And the CLI's own not-found path still reports not-found, not a crash or a lie.
    const cli = await fire(
      process.execPath,
      [CLI_PATH, 'registry', 'remove', '--name', NAME, '--resource-type', TYPE],
      { cwd, env: { CLAUDE_MEM_DIR: dir } },
    );
    expect(cli.stdout).toMatch(/Not found/);
  }, 60000);

  it('reindex reports the same active count on both sides', async () => {
    const dir = sandboxDir('ri-data');
    const cwd = sandboxDir('ri-proj');
    for (const n of ['ri-a', 'ri-b']) {
      await fire(process.execPath, [CLI_PATH, 'registry', 'import', '--name', n, '--resource-type', TYPE], {
        cwd,
        env: { CLAUDE_MEM_DIR: dir },
      });
    }

    const cli = await fire(process.execPath, [CLI_PATH, 'registry', 'reindex'], {
      cwd,
      env: { CLAUDE_MEM_DIR: dir },
    });
    const cliCount = cli.stdout.match(/(\d+) active resources/)?.[1];
    expect(cliCount, `CLI reindex output had no count:\n${cli.stdout}`).toBeTruthy();

    const { client, transport } = await startMcp(dir, cwd);
    let mcpCount;
    try {
      const res = await client.callTool({ name: 'mem_registry', arguments: { action: 'reindex' } });
      mcpCount = textOf(res).match(/(\d+) active resources/)?.[1];
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
    expect(mcpCount).toBe(cliCount);
  }, 60000);
});

// P2-6 — the get detail face fetched and rendered three sources with hand-copied SQL on
// each side, and the prompt source had already drifted: MCP rendered prompt_number and
// created_at, the CLI rendered neither. A prompt_number is how a user cross-references a
// P# against a session transcript, so on the CLI it was searchable-but-invisible — the
// exact shape SESSION_DETAIL_FIELDS was introduced to close, reopened one source over.

describe('P2-6 — get renders the same prompt/event fields on both faces', () => {
  let dataDir, cwd;

  beforeAll(async () => {
    dataDir = sandboxDir('get-data');
    cwd = sandboxDir('get-proj');
    // Seed through the real save surface so the row shape is production's, not a fixture's.
    const r = await fire(
      process.execPath,
      [
        CLI_PATH,
        'save',
        'Prompt/event parity probe body',
        '--type',
        'decision',
        '--title',
        'Parity probe for the get detail face',
      ],
      { cwd, env: { CLAUDE_MEM_DIR: dataDir } },
    );
    expect(r.code, `seed save failed:\n${r.stdout}\n${r.stderr}`).toBe(0);

    // A user_prompts row with a prompt_number — the field the CLI face was dropping.
    const db = new Database(join(dataDir, 'claude-mem-lite.db'));
    try {
      const now = Date.now();
      const sess = db.prepare('SELECT content_session_id FROM sdk_sessions LIMIT 1').get();
      db.prepare(
        `
        INSERT INTO user_prompts (content_session_id, prompt_text, prompt_number, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `,
      ).run(
        sess.content_session_id,
        'How did we fix the parser null deref?',
        7,
        new Date(now).toISOString(),
        now,
      );
    } finally {
      db.close();
    }
  }, 60000);

  /** The P# id of the seeded prompt row. */
  function promptId() {
    const db = new Database(join(dataDir, 'claude-mem-lite.db'), { readonly: true });
    try {
      return db.prepare('SELECT id FROM user_prompts ORDER BY id DESC LIMIT 1').get().id;
    } finally {
      db.close();
    }
  }

  // FAILS IF: the CLI prompt renderer stops iterating PROMPT_DETAIL_FIELDS — prompt_number
  // disappears from the CLI detail view while remaining FTS-searchable.
  it('the CLI prompt detail renders prompt_number', async () => {
    const r = await fire(process.execPath, [CLI_PATH, 'get', `P#${promptId()}`], {
      cwd,
      env: { CLAUDE_MEM_DIR: dataDir },
    });
    expect(r.stdout).toMatch(/Prompt number: 7/);
    expect(r.stdout).toMatch(/How did we fix the parser null deref\?/);
  }, 60000);

  // Both faces must expose the same field SET. Labels and ordering are each face's own
  // convention; which columns reach the user is not.
  it('both faces expose the same prompt fields', async () => {
    const id = promptId();
    const cli = await fire(process.execPath, [CLI_PATH, 'get', `P#${id}`], {
      cwd,
      env: { CLAUDE_MEM_DIR: dataDir },
    });

    const { client, transport } = await startMcp(dataDir, cwd);
    let mcp;
    try {
      mcp = textOf(await client.callTool({ name: 'mem_get', arguments: { ids: [`P#${id}`] } }));
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }

    // prompt_number reaches both; the prompt text reaches both.
    for (const probe of ['7', 'How did we fix the parser null deref?']) {
      expect(cli.stdout, `CLI dropped ${probe}`).toContain(probe);
      expect(mcp, `MCP dropped ${probe}`).toContain(probe);
    }
  }, 60000);

  // Neither face may re-inline its own SELECT for these two sources.
  it('neither face hand-rolls the prompt/event fetch', async () => {
    const { readFileSync } = await import('fs');
    for (const f of ['mem-cli.mjs', 'server.mjs']) {
      const src = readFileSync(join(REPO, f), 'utf8');
      expect(src, `${f} re-inlined a user_prompts detail SELECT`).not.toMatch(
        /SELECT \* FROM user_prompts WHERE id IN/,
      );
      expect(src, `${f} re-inlined an events detail SELECT`).not.toMatch(/SELECT \* FROM events WHERE id IN/);
    }
  });
});
