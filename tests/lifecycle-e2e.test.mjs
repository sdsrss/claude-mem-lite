// Full plugin-lifecycle E2E: install → SessionStart auto-adopt → status →
// update → uninstall(--purge) → unadopt, all inside an isolated HOME with a
// fake `claude` bin and --dev symlinks (no network: CLAUDE_MEM_SKIP_REPOS=1).
//
// ORDER-SENSITIVE: the it() blocks below share module state and run in source
// order (vitest is sequential within a file). uninstall/unadopt are destructive
// and must stay last.
//
// CRITICAL isolation — adopt-cli detectCwd() and hook inferProject() resolve the
// project via CLAUDE_PROJECT_DIR || PWD || process.cwd(). execFileSync's `cwd`
// option does NOT update the inherited PWD env var, so without scrubbing +
// re-injecting PWD/CLAUDE_PROJECT_DIR=cwd a drill launched from the real repo
// would have unadopt delete the REAL repo's CLAUDE.md block. The afterAll guard
// asserts the real repo CLAUDE.md is byte-identical — a regression net for that.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_CLAUDE_MD = join(REPO, 'CLAUDE.md');

let HOME, PROJ, dataDir, cliLink, BASE_ENV, repoClaudeMdSnapshot;
const settingsPath = () => join(HOME, '.claude', 'settings.json');
const pluginsDir = () => join(HOME, '.claude', 'plugins');
const USER_CLAUDE_MD = '# myapp\n\nMy own project notes.\n\n## Conventions\n- use tabs\n';

function run(file, args, { cwd = PROJ, env = {}, allowFail = false } = {}) {
  try {
    const out = execFileSync('node', [join(REPO, file), ...args], {
      encoding: 'utf8',
      cwd,
      // Re-inject PWD + CLAUDE_PROJECT_DIR so cwd resolution can never escape to the real repo.
      env: { ...BASE_ENV, PWD: cwd, CLAUDE_PROJECT_DIR: cwd, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
    return { ok: true, out };
  } catch (e) {
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    if (!allowFail) throw new Error(`${file} ${args.join(' ')} exited ${e.status}:\n${out}`, { cause: e });
    return { ok: false, out, code: e.status };
  }
}

const readJSON = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
function memHookCount(s) {
  let n = 0;
  for (const ev of Object.values(s?.hooks || {}))
    for (const m of ev)
      for (const h of m.hooks || []) if (/claude-mem-lite|\.claude-mem-lite/.test(h.command || '')) n++;
  return n;
}
function adoptedBlock(dir) {
  const p = join(dir, 'CLAUDE.md');
  if (!existsSync(p)) return { present: false, count: 0, raw: '' };
  const raw = readFileSync(p, 'utf8');
  const count = (raw.match(/<!-- claude-mem-lite:begin/g) || []).length;
  return { present: count > 0, count, raw, version: (raw.match(/claude-mem-lite:begin (v\d+)/) || [])[1] };
}

function fakeClaudeBin() {
  const binDir = join(HOME, 'bin');
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, 'claude');
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
STATE="${HOME}/.claude/mcp-state.txt"; mkdir -p "${HOME}/.claude"; touch "$STATE"
[[ "\${1:-}" != "mcp" ]] && exit 0
shift; cmd="\${1:-}"; shift || true
case "$cmd" in
  add) name=""; while [[ $# -gt 0 ]]; do case "$1" in -s) shift 2;; -t) shift 2;; --) break;; *) [[ -z "$name" && "$1" != -* ]] && name="$1"; shift;; esac; done
       [[ -n "$name" ]] && { grep -v "^$name\\$" "$STATE" > "$STATE.tmp" || true; mv "$STATE.tmp" "$STATE"; echo "$name" >> "$STATE"; } ;;
  remove) name=""; while [[ $# -gt 0 ]]; do case "$1" in -s) shift 2;; *) [[ -z "$name" && "$1" != -* ]] && name="$1"; shift;; esac; done
       [[ -n "$name" ]] && { grep -v "^$name\\$" "$STATE" > "$STATE.tmp" || true; mv "$STATE.tmp" "$STATE"; } ;;
  list) while IFS= read -r l; do [[ -n "$l" ]] && printf '%s: stdio\\n' "$l"; done < "$STATE" ;;
esac
`,
  );
  execFileSync('chmod', ['+x', script]);
  return binDir;
}

describe('plugin lifecycle: install → adopt → update → uninstall → unadopt', () => {
  beforeAll(() => {
    HOME = mkdtempSync(join(tmpdir(), 'mem-lifecycle-'));
    PROJ = join(HOME, 'work', 'myapp');
    dataDir = join(HOME, '.claude-mem-lite');
    cliLink = join(HOME, '.local', 'bin', 'claude-mem-lite');
    repoClaudeMdSnapshot = existsSync(REPO_CLAUDE_MD) ? readFileSync(REPO_CLAUDE_MD, 'utf8') : null;

    BASE_ENV = { ...process.env, HOME, CLAUDE_MEM_SKIP_REPOS: '1' };
    delete BASE_ENV.CLAUDE_MEM_DIR;
    delete BASE_ENV.MEM_QUIET_HOOKS;
    delete BASE_ENV.MEM_NO_AUTO_ADOPT;
    delete BASE_ENV.CLAUDE_PROJECT_DIR;
    delete BASE_ENV.PWD;

    mkdirSync(join(HOME, '.claude'), { recursive: true });
    mkdirSync(PROJ, { recursive: true });
    writeFileSync(join(PROJ, 'CLAUDE.md'), USER_CLAUDE_MD);
    writeFileSync(join(PROJ, 'package.json'), '{"name":"myapp"}\n');
    // Simulate a prior marketplace install so uninstall has artifacts to sweep.
    mkdirSync(join(pluginsDir(), 'marketplaces', 'sdsrss'), { recursive: true });
    mkdirSync(join(pluginsDir(), 'cache', 'sdsrss'), { recursive: true });
    writeFileSync(
      join(pluginsDir(), 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'claude-mem-lite@sdsrss': [{ version: '3.14.0' }] } }, null, 2),
    );
    writeFileSync(
      join(pluginsDir(), 'known_marketplaces.json'),
      JSON.stringify({ sdsrss: { url: 'https://example.com' } }, null, 2),
    );
    writeFileSync(
      settingsPath(),
      JSON.stringify(
        {
          enabledPlugins: { 'claude-mem-lite@sdsrss': true, 'other@vendor': true },
          extraKnownMarketplaces: { sdsrss: { url: 'x' } },
        },
        null,
        2,
      ),
    );

    // Fake claude bin on PATH for the WHOLE run so neither install nor uninstall
    // can ever touch the real `claude` CLI / real MCP registration.
    const binDir = fakeClaudeBin();
    BASE_ENV.PATH = `${binDir}:${process.env.PATH}`;

    run('install.mjs', ['install', '--dev', '--no-adopt']);
  }, 120000);

  afterAll(() => {
    // Regression net: the drill must never have modified the real repo CLAUDE.md.
    if (repoClaudeMdSnapshot !== null) {
      expect(readFileSync(REPO_CLAUDE_MD, 'utf8')).toBe(repoClaudeMdSnapshot);
    }
    try {
      rmSync(HOME, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('install: data dir, hooks, CLI symlink; preserves unrelated plugin', () => {
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(join(dataDir, 'hook.mjs'))).toBe(true);
    expect(existsSync(cliLink)).toBe(true);
    const s = readJSON(settingsPath());
    expect(memHookCount(s)).toBeGreaterThan(0);
    expect(s.enabledPlugins['other@vendor']).toBe(true);
  });

  it('SessionStart auto-adopts: v1 English block, preserves user content, writes detail doc + marker', () => {
    run('hook.mjs', ['session-start'], { allowFail: true });
    const a = adoptedBlock(PROJ);
    expect(a.present).toBe(true);
    expect(a.count).toBe(1);
    expect(a.version).toBe('v1');
    expect(a.raw).toContain('persistent memory');
    expect(a.raw).not.toMatch(/持久记忆/);
    expect(a.raw).toContain('use tabs'); // pre-existing user content survives
    expect(a.raw).toContain('My own project notes');
    expect(existsSync(join(PROJ, '.claude', 'plugin_claude_mem_lite.md'))).toBe(true);
    const markers = readdirSync(join(dataDir, 'runtime')).filter((f) => f.startsWith('.auto-adopt-'));
    expect(markers.length).toBeGreaterThan(0);
    // DB is lazy-created on first hook use (install does not create it).
    expect(existsSync(join(dataDir, 'claude-mem-lite.db'))).toBe(true);
  });

  it('second SessionStart is idempotent (no duplicate block)', () => {
    run('hook.mjs', ['session-start'], { allowFail: true });
    expect(adoptedBlock(PROJ).count).toBe(1);
  });

  it('status --json emits structured checks', () => {
    const st = run('install.mjs', ['status', '--json'], { allowFail: true });
    const j = JSON.parse(st.out);
    expect(typeof j).toBe('object');
    expect(Object.keys(j).length).toBeGreaterThanOrEqual(3);
    expect(j.hooks?.level).toBe('ok');
  });

  it('update in dev-mode skips remote without network error', () => {
    const up = run('install.mjs', ['update'], { allowFail: true });
    expect(up.out).toMatch(/up to date|available|update/i);
    expect(up.out).not.toMatch(/ENOTFOUND|ETIMEDOUT|network error/i);
  });

  it('uninstall --purge cleans global artifacts but leaves project adoption (by design)', () => {
    run('install.mjs', ['uninstall', '--purge'], { allowFail: true });
    const s = readJSON(settingsPath());
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(cliLink)).toBe(false);
    expect(memHookCount(s)).toBe(0);
    expect(s.enabledPlugins?.['claude-mem-lite@sdsrss']).toBeUndefined();
    expect(s.enabledPlugins?.['other@vendor']).toBe(true);
    expect(
      readJSON(join(pluginsDir(), 'installed_plugins.json'))?.plugins?.['claude-mem-lite@sdsrss'],
    ).toBeUndefined();
    expect(existsSync(join(pluginsDir(), 'marketplaces', 'sdsrss'))).toBe(false);
    expect(existsSync(join(pluginsDir(), 'cache', 'sdsrss'))).toBe(false);
    // The documented gap: uninstall does NOT unadopt — the project block survives.
    expect(adoptedBlock(PROJ).present).toBe(true);
    expect(existsSync(join(PROJ, '.claude', 'plugin_claude_mem_lite.md'))).toBe(true);
  });

  it('unadopt (per-project) removes the block + detail doc, keeps user content', () => {
    run('cli.mjs', ['unadopt'], { allowFail: true });
    expect(adoptedBlock(PROJ).present).toBe(false);
    const md = readFileSync(join(PROJ, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('use tabs');
    expect(md).toContain('My own project notes');
    expect(existsSync(join(PROJ, '.claude', 'plugin_claude_mem_lite.md'))).toBe(false);
  });
});
