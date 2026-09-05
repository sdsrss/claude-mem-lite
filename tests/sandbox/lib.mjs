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

export function summary() {
  const fails = results.filter((r) => !r.ok);
  console.log(`\n\x1b[1m════ SUMMARY ════\x1b[0m`);
  console.log(`${results.length - fails.length}/${results.length} checks passed`);
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

export { join, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync };
