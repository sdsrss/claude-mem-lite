// Drift guard for the README "Environment Variables" reference (audit 2026-08-22 P1-2).
//
// The flag surface rotted to 4-of-59 documented because nothing tied the reference table
// to the code that reads the env. This test is that tie: every env var the SHIPPED files
// actually read must be named somewhere in README.md, and README must not advertise a flag
// no shipped file reads (the six dead flags the audit found were exactly that shape).
//
// Scope is package.json#files on purpose — a flag only benchmark/ or tests/ reads is not a
// user-facing knob and must not be documented as one.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Prefixes that denote a claude-mem-lite-owned or provider-credential env var. Anything
// outside these (PATH, HOME, CI, CLAUDE_PLUGIN_ROOT, …) is the harness's, not ours.
const FLAG_RE = /(?:CLAUDE_MEM|MEM|OPENROUTER|ANTHROPIC)_[A-Z0-9_]+/;

// Reads of the form `process.env.X`, `process.env['X']`, `env.X`, `env['X']`.
const ENV_READ_RE =
  /(?:process\.env|env)\s*[.[]\s*['"]?\b((?:CLAUDE_MEM|MEM|OPENROUTER|ANTHROPIC)_[A-Z0-9_]+)/g;

function shippedSourceFiles() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.files
    .filter((f) => /\.(mjs|js|sh)$/.test(f))
    .map((f) => join(ROOT, f))
    .filter(existsSync);
}

function envVarsReadByShippedCode() {
  const found = new Map(); // name -> first file that reads it
  for (const path of shippedSourceFiles()) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(ENV_READ_RE)) {
      if (!found.has(m[1])) found.set(m[1], path.slice(ROOT.length + 1));
    }
  }
  return found;
}

describe('README environment-variable reference', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('documents every env var the shipped code reads', () => {
    const read = envVarsReadByShippedCode();
    // Guard the guard: if the detector stops finding flags, the assertion below passes
    // vacuously and the drift it exists to catch goes silent.
    expect(read.size).toBeGreaterThan(50);

    const undocumented = [...read.entries()]
      .filter(([name]) => !readme.includes(name))
      .map(([name, file]) => `${name} (read by ${file})`)
      .sort();

    expect(undocumented, `undocumented env flags:\n${undocumented.join('\n')}`).toEqual([]);
  });

  it('does not document env vars no shipped file references', () => {
    // Deliberately broader than envVarsReadByShippedCode(): a flag can be read through a
    // named constant (`env[BINDING_HEAL_GUARD_ENV]`), which the process.env shape misses.
    // For "is this flag dead?", any occurrence in shipped source is proof of life.
    const referenced = new Set();
    for (const path of shippedSourceFiles()) {
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(/(?:CLAUDE_MEM|MEM|OPENROUTER|ANTHROPIC)_[A-Z0-9_]+/g)) {
        referenced.add(m[0]);
      }
    }
    const mentioned = new Set();
    // Only backtick-quoted names count as "documented" — prose that merely mentions a
    // historical flag in a migration note stays legal.
    for (const m of readme.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      if (FLAG_RE.test(m[1])) mentioned.add(m[1]);
    }

    // Names that are documented-but-unread on purpose.
    const ALLOWED_UNREAD = new Set([
      // Per-project opt-out sentinel written by `adopt --disable`, referenced in prose.
      'MEM_NO_AUTO_ADOPT_FILE',
    ]);

    const stale = [...mentioned].filter((n) => !referenced.has(n) && !ALLOWED_UNREAD.has(n)).sort();

    expect(stale, `README documents flags no shipped file references:\n${stale.join('\n')}`).toEqual([]);
  });
});
