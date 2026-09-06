// lib.mjs — shared sandbox harness utilities for simulating a real user.
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  cpSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not hardcoded: the harness is checked in now, so it has to
// work from any clone.
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const results = [];
let phase = '(none)';

export function setPhase(p) {
  phase = p;
  console.log(`\n\x1b[1m━━━ ${p} ━━━\x1b[0m`);
}

export function check(name, fn) {
  let ok;
  let detail = '';
  try {
    const r = fn();
    if (r && typeof r === 'object' && 'ok' in r) {
      ok = !!r.ok;
      detail = r.detail || '';
    } else {
      ok = r !== false;
    }
  } catch (e) {
    ok = false;
    detail = (e.message || String(e)).split('\n').slice(0, 4).join(' | ');
  }
  results.push({ phase, name, ok, detail });
  console.log(
    `${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? `\n       ${detail}` : ''}`,
  );
  return ok;
}

/**
 * Print the tally and return the failure count.
 *
 * `expected` is not decoration. Phase B's whole self-heal section lived behind an
 * `if (existsSync(bindingPath))` whose path went stale with better-sqlite3 13, so EIGHT
 * checks stopped running and the only trace was the run printing 37 where the README said
 * 45 — a number nobody diffs. A phase that silently shrinks is a phase that stopped
 * measuring, so the count is now an assertion.
 *
 * @param {number} [expected] Exact number of checks this phase must have run.
 * @returns {number} failing checks (a missing/extra check counts as one)
 */
export function summary(expected) {
  const fails = results.filter((r) => !r.ok);
  console.log(`\n\x1b[1m════ SUMMARY ════\x1b[0m`);
  console.log(`${results.length - fails.length}/${results.length} checks passed`);
  if (typeof expected === 'number' && results.length !== expected) {
    console.log(
      `\n\x1b[31mCHECK-COUNT MISMATCH\x1b[0m ran ${results.length}, expected ${expected} — ` +
        `a check was skipped or added. Update the constant deliberately, never to make this quiet.`,
    );
    return fails.length + 1;
  }
  if (fails.length) {
    console.log(`\n\x1b[31mFAILURES:\x1b[0m`);
    for (const f of fails) console.log(`  [${f.phase}] ${f.name}\n      ${f.detail}`);
  }
  return fails.length;
}

// ── shell helpers ───────────────────────────────────────────────────────────

export function run(cmd, args, opts = {}) {
  const res = { code: 0, stdout: '', stderr: '' };
  try {
    res.stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 120_000,
      ...opts,
      env: opts.env ? { ...opts.env } : process.env,
    });
  } catch (e) {
    res.code = e.status ?? -1;
    res.stdout = e.stdout || '';
    res.stderr = e.stderr || e.message || '';
  }
  return res;
}

export function node(args, opts = {}) {
  return run(process.execPath, args, opts);
}

// ── sandbox construction ────────────────────────────────────────────────────

/** Snapshot the repo (tracked + untracked-not-ignored) into `dest`. */
export function snapshotRepo(dest) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].filter(Boolean);
  let copied = 0;
  for (const f of files) {
    const src = join(REPO, f);
    if (!existsSync(src)) continue;
    // The command sandbox masks deny-listed paths by overlaying /dev/null char
    // devices into the tree; they surface in `git ls-files --others` but are not
    // repo content. Copy regular files only.
    let st;
    try {
      st = statSync(src);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const dst = join(dest, f);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { dereference: true });
    copied++;
  }
  return copied;
}

/** A fake `claude` CLI that records `claude mcp add/remove/list` into a state file. */
export function makeFakeClaudeBin(home) {
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, 'claude');
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
STATE="${home}/.claude/mcp-state.txt"
mkdir -p "${home}/.claude"
touch "$STATE"
if [[ "\${1:-}" != "mcp" ]]; then exit 0; fi
shift; cmd="\${1:-}"; shift || true
case "$cmd" in
  add)
    scope="user"; name=""
    while [[ $# -gt 0 ]]; do
      case "$1" in -s) scope="$2"; shift 2 ;; -t) shift 2 ;; --) break ;; *) if [[ -z "$name" && "$1" != -* ]]; then name="$1"; fi; shift ;; esac
    done
    if [[ -n "$name" ]]; then
      grep -v "^\${scope}:\${name}$" "$STATE" > "$STATE.tmp" 2>/dev/null || true
      mv "$STATE.tmp" "$STATE"
      printf '%s:%s\\n' "$scope" "$name" >> "$STATE"
    fi ;;
  remove)
    scope="user"; name=""
    while [[ $# -gt 0 ]]; do
      case "$1" in -s) scope="$2"; shift 2 ;; *) if [[ -z "$name" && "$1" != -* ]]; then name="$1"; fi; shift ;; esac
    done
    if [[ -n "$name" ]]; then
      grep -v "^\${scope}:\${name}$" "$STATE" > "$STATE.tmp" 2>/dev/null || true
      mv "$STATE.tmp" "$STATE"
    fi ;;
  list)
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      name="\${line#*:}"
      printf '%s: stdio\\n' "$name"
    done < "$STATE" ;;
esac
`,
  );
  chmodSync(script, 0o755);
  return binDir;
}

/** Build the env a Claude Code session would hand a hook / the CLI. */
export function sandboxEnv(home, extra = {}) {
  // Inherit the ambient env — a real user's shell has proxy vars, locale, etc.
  // Stripping it (env -i) breaks npm's network access on proxied machines and
  // produces failures that belong to the harness, not the product. Drop only the
  // vars that would leak THIS repo's session into the sandbox.
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith('CLAUDE_') || k.startsWith('MEM_') || k === 'CLAUDE_PLUGIN_ROOT') delete base[k];
  }
  return {
    ...base,
    PATH: `${join(home, 'bin')}:${process.env.PATH}`,
    HOME: home,
    TMPDIR: join(home, 'tmp'),
    npm_config_cache: join(home, '.npm-cache'),
    ...extra,
  };
}

// ── MCP stdio client ────────────────────────────────────────────────────────

/**
 * Speak real MCP over stdio to a launched server. Returns { responses, stderr, code }.
 * `requests` is a list of JSON-RPC objects sent in order.
 */
export function mcpSession(cmd, args, { env, cwd, requests, timeout = 60_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const responses = [];
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ responses, stderr: err, stdout: out, code });
    };
    const timer = setTimeout(() => finish('TIMEOUT'), timeout);
    child.stdout.on('data', (d) => {
      out += d.toString();
      let idx;
      while ((idx = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, idx).trim();
        out = out.slice(idx + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          responses.push({ _unparseable: line });
        }
        if (responses.length >= requests.length) finish(0);
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      err += `\nspawn error: ${e.message}`;
      finish(-1);
    });
    child.on('exit', (code) => setTimeout(() => finish(code), 300));
    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
  });
}

/** Run a Claude Code hook the way the runtime does: JSON on stdin, JSON envelope on stdout. */
export function runHook(cmdline, payload, { env, cwd }) {
  const res = { code: 0, stdout: '', stderr: '' };
  try {
    res.stdout = execFileSync('bash', ['-c', cmdline], {
      encoding: 'utf8',
      input: JSON.stringify(payload),
      env,
      cwd,
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    res.code = e.status ?? -1;
    res.stdout = e.stdout || '';
    res.stderr = e.stderr || e.message || '';
  }
  return res;
}

// ── native binding ──────────────────────────────────────────────────────────

/**
 * The `.node` file better-sqlite3 will actually dlopen out of `installDir`.
 *
 * NOT a hardcoded path, and that is the entire point. Both phases used to name
 * `build/Release/better_sqlite3.node`, which is where better-sqlite3 **12** compiled its
 * addon. Version 13 ships `prebuilds/<platform>.node` and its `lib/binding.js` prefers a
 * prebuild over `build/`, so from v4.0.0 the file the phases broke was one no resolver
 * loads — and the self-heal sections have measured nothing since. The controls said so
 * ("binding is genuinely unloadable now" went red); nothing else did.
 *
 * So ask the installed package rather than guessing: its own `getPrebuildPath()` applies
 * the platform/arch/musl logic that decides this, and it tests EXISTENCE only, so it still
 * answers for a prebuild that is present and unloadable — which is the case that matters.
 * `lib/binding.js` is not in the package's `exports` map, so it is required by file path.
 *
 * @param {string} installDir Directory whose node_modules holds better-sqlite3
 * @returns {string|null} absolute path, or null when the package resolves no addon at all
 */
export function loadedBindingPath(installDir) {
  const pkgRoot = join(installDir, 'node_modules', 'better-sqlite3');
  const bindingJs = join(pkgRoot, 'lib', 'binding.js');
  if (existsSync(bindingJs)) {
    const r = node([
      '-e',
      `const b=require(${JSON.stringify(bindingJs)});` +
        `process.stdout.write((b.getPrebuildPath&&b.getPrebuildPath())||'')`,
    ]);
    const prebuild = r.code === 0 ? r.stdout.trim() : '';
    if (prebuild && existsSync(prebuild)) return prebuild;
  }
  // better-sqlite3's own fallback order, for a tree with no matching prebuild.
  for (const p of [
    join(pkgRoot, 'build', 'Debug', 'better_sqlite3.node'),
    join(pkgRoot, 'build', 'Release', 'better_sqlite3.node'),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Corrupt the addon `installDir` actually loads, the way a bad prebuild does: the file is
 * present, the right size class, and will not dlopen. Also drops the `.mem-binding-ok-*`
 * marker so setup.sh leaves its fast path and really probes.
 *
 * Returns a `check()`-shaped result so a tree with nothing to break FAILS LOUDLY instead of
 * being skipped over — the shape that hid phase B's eight missing checks.
 *
 * @param {string} installDir
 * @returns {{ok: boolean, detail: string}}
 */
export function breakBinding(installDir) {
  const target = loadedBindingPath(installDir);
  if (!target) return { ok: false, detail: `no better-sqlite3 addon resolves under ${installDir}` };
  const good = readFileSync(target);
  writeFileSync(target, Buffer.concat([Buffer.from('\x7fELF broken-abi '), good.subarray(16, 4096)]));
  const nm = join(installDir, 'node_modules');
  let markers = 0;
  for (const f of readdirSync(nm).filter((x) => x.startsWith('.mem-binding-ok-'))) {
    rmSync(join(nm, f), { force: true });
    markers++;
  }
  return { ok: true, detail: `${target} (cleared ${markers} ABI marker(s))` };
}

/** Load better-sqlite3 out of `installDir` in a fresh process. `{ok:true}` when the DB opens. */
export function bindingLoads(installDir, env) {
  const r = node(
    [
      '-e',
      `const {createRequire}=require('node:module');` +
        `const D=createRequire(${JSON.stringify(join(installDir, 'package.json'))})('better-sqlite3');` +
        `new D(':memory:').close()`,
    ],
    env ? { env } : {},
  );
  return { ok: r.code === 0, detail: `exit=${r.code} ${(r.stderr || '').split('\n')[0]}` };
}

export { join, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync };
