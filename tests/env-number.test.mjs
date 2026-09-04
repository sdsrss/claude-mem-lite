// Numeric env overrides must fail loudly, not become NaN.
//
// The defect (2026-09-04): every UPS knob was `Number(process.env.X || DEFAULT)`.
// `Number('abc')` is NaN, so a typo did not fall back — it propagated NaN into the
// consumer, where the behaviour depends on which consumer it was:
//
//   MAX_RESULTS           → `rows.slice(0, NaN)` === []          face goes dark
//   PROMPT_FALLBACK_LIMIT → `LIMIT ?` bound NaN                  SqliteError
//   TOP_REL_FLOOR         → `Math.abs(rel) < NaN` is false       floor stops firing
//   OR_TOP_BM25_FLOOR     → `orFloor > 0` is false               floor stops firing
//
// i.e. one typo either silences the injection face or disables the gates that keep
// it quiet, with no error either way.
//
// Three layers here, deliberately different in kind:
//   1. the helper's own contract (unit),
//   2. a SOURCE sweep so the idiom cannot come back anywhere in the tree (class-level),
//   3. one END-TO-END case driving the real hook in a subprocess, because (1) and (2)
//      together still do not prove the call sites were rewired.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { envNumber } from '../lib/env-number.mjs';

// join(), never `new URL('../x.mjs', import.meta.url)`: the URL form drops whatever
// module it names out of knip's unused-export report entirely (CLAUDE.md knip rule 4).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('envNumber — the contract lib/cli-flags.mjs already has for CLI flags', () => {
  const capture = () => { const seen = []; return { warn: (m) => seen.push(m), seen }; };

  it('returns the parsed value for a well-formed number', () => {
    expect(envNumber('7', { name: 'X', defaultValue: 3 })).toBe(7);
    expect(envNumber('1e-5', { name: 'X', defaultValue: 3 })).toBe(1e-5);
    expect(envNumber(' 12 ', { name: 'X', defaultValue: 3 })).toBe(12);
    expect(envNumber('-2.5', { name: 'X', defaultValue: 3 })).toBe(-2.5);
  });

  it('accepts scientific notation, which parseInt would silently misread', () => {
    // Not decoration: BM25_MIN_SCORE / FOLLOWUP_BM25_MIN_SCORE default to 1e-5 / 5e-6,
    // so a helper built on parseInt would turn a user's own documented value into 1
    // and 5 — a 10^5 error with no warning. This pins the choice of primitive.
    expect(envNumber('5e-6', { name: 'X', defaultValue: 1 })).toBe(5e-6);
    expect(parseInt('5e-6', 10)).toBe(5); // the shape being ruled out
  });

  it('falls back SILENTLY when unset or empty — that is not a mistake', () => {
    const c = capture();
    expect(envNumber(undefined, { name: 'X', defaultValue: 3, warn: c.warn })).toBe(3);
    expect(envNumber(null, { name: 'X', defaultValue: 3, warn: c.warn })).toBe(3);
    expect(envNumber('', { name: 'X', defaultValue: 3, warn: c.warn })).toBe(3);
    expect(envNumber('   ', { name: 'X', defaultValue: 3, warn: c.warn })).toBe(3);
    expect(c.seen, 'unset must not warn — `CLAUDE_MEM_X=` is how a shell clears it').toEqual([]);
  });

  it('falls back LOUDLY on the values that used to become NaN', () => {
    for (const bad of ['abc', '2abc', 'NaN', 'Infinity', '-Infinity', 'null', '1,5']) {
      const c = capture();
      expect(envNumber(bad, { name: 'CLAUDE_MEM_X', defaultValue: 3, warn: c.warn }),
        `"${bad}" did not fall back`).toBe(3);
      expect(c.seen.length, `"${bad}" fell back without warning`).toBe(1);
      expect(c.seen[0]).toContain('CLAUDE_MEM_X');
      expect(c.seen[0]).toContain(bad);
    }
  });

  it('honours an explicit 0 — the `|| DEFAULT` idiom swallowed it', () => {
    // CLAUDE_MEM_UPS_TOP_MIN=0 is the documented seed-mode kill switch for the
    // absolute floors, and CLAUDE_MEM_CITE_NUDGE_MIN_INJECTED=0 means "no volume
    // requirement". Both were unreachable through `Number(env || d)` / `Number(env) || d`.
    const c = capture();
    expect(envNumber('0', { name: 'X', defaultValue: 50, min: 0, warn: c.warn })).toBe(0);
    expect(c.seen).toEqual([]);
  });

  it('enforces the range and says what the range was', () => {
    const c = capture();
    expect(envNumber('-1', { name: 'X', defaultValue: 8, min: 0, max: 50, warn: c.warn })).toBe(8);
    expect(envNumber('51', { name: 'X', defaultValue: 8, min: 0, max: 50, warn: c.warn })).toBe(8);
    expect(c.seen.length).toBe(2);
    for (const m of c.seen) expect(m).toContain('between 0 and 50');
  });

  it('enforces integrality only when asked', () => {
    const c = capture();
    expect(envNumber('3.7', { name: 'X', defaultValue: 3, integer: true, warn: c.warn })).toBe(3);
    expect(c.seen[0]).toContain('an integer');
    expect(envNumber('3.7', { name: 'X', defaultValue: 3 })).toBe(3.7);
  });
});

// ─── Class-level sweep: the idiom must not come back ────────────────────────────
//
// A count of fixed sites is not a fix — this repo's own record is that the
// same shape reappears on a face nobody swept (CLAUDE.md, "修好的那份不是唯一那份").
// The rule is derived from the source, so a site written tomorrow is covered.
//
// What it catches: a numeric parse whose argument folds a fallback into the parse
// (`Number(process.env.X || 3)`), which is exactly the shape that yields NaN.
// What it deliberately does NOT catch, and why: `const raw = process.env.X;` followed
// by `parseInt(raw, 10)` and an explicit `Number.isFinite`/`Number.isInteger` gate.
// Six sites in this tree are written that way and are correct; a rule broad enough to
// flag them would need an allowlist, and an allowlist rots into a raised baseline.
// Being a text rule it is also blind to aliasing (`const e = process.env; Number(e.X || 3)`);
// that is the ceiling of a source guard, not a claim that the class is impossible.

const SWEEP_DIRS = ['lib', 'scripts', 'cli', 'server', 'benchmark'];
const SWEEP_EXT = /\.(mjs|js)$/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SWEEP_EXT.test(e)) out.push(p);
  }
  return out;
}

/** Every production source file the sweep covers (root modules + SWEEP_DIRS). */
export function sweepFiles() {
  const rootFiles = readdirSync(ROOT)
    .filter((f) => /\.mjs$/.test(f))
    .map((f) => join(ROOT, f))
    .filter((f) => statSync(f).isFile());
  const nested = SWEEP_DIRS.flatMap((d) => walk(join(ROOT, d)));
  return [...rootFiles, ...nested];
}

/**
 * Blank out comments, preserving line count so reported line numbers stay true.
 *
 * Needed because lib/env-number.mjs's own docblock QUOTES the banned idiom in order
 * to explain it, and the first version of this sweep flagged that quote. A guard a
 * comment can trip is a guard someone will weaken; blanking comments is the fix that
 * keeps it strict on code. Deliberately conservative — only block comments and lines
 * whose first non-space characters are `//` — so a `//` inside a string literal
 * cannot make the scanner drop real code and go quietly blind.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
}

/**
 * Numeric-parse calls whose ARGUMENT contains both an env read and a `||`/`??`
 * fallback. Scans to the matching close paren rather than regexing the whole call,
 * so a nested call (`Number(foo(a || b))`) is measured on its real argument text.
 *
 * @param {string} raw File source.
 * @returns {Array<{line:number, text:string}>}
 */
export function findFoldedEnvParses(raw) {
  const src = stripComments(raw);
  const hits = [];
  const re = /\b(Number|parseInt|parseFloat)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    const arg = src.slice(m.index + m[0].length, i - 1);
    if (/(^|[^A-Za-z0-9_$])env\s*[.[]|process\.env/.test(arg) && /\|\||\?\?/.test(arg)) {
      hits.push({ line: src.slice(0, m.index).split('\n').length, text: `${m[1]}(${arg})` });
    }
  }
  return hits;
}

describe('no numeric env parse may fold its own fallback into the parse', () => {
  it('the scanner can actually say yes — otherwise a clean sweep proves nothing', () => {
    // The sweep below reports zero. A scanner that always returned [] would look
    // identical, which is how this repo has shipped a guard that could not fail.
    expect(findFoldedEnvParses('const a = Number(process.env.X || 3);')).toHaveLength(1);
    expect(findFoldedEnvParses('const a = Number(env.X ?? 3);')).toHaveLength(1);
    expect(findFoldedEnvParses('const a = parseInt(process.env.X || 3, 10);')).toHaveLength(1);
    // ...and no on the correct shapes, so it is not just "always yes".
    expect(findFoldedEnvParses('const r = process.env.X; const a = Number(r);')).toHaveLength(0);
    expect(findFoldedEnvParses('const a = Number(x || 3);')).toHaveLength(0);
    expect(findFoldedEnvParses('const a = Number(process.env.X);')).toHaveLength(0);
  });

  it('ignores the idiom when it appears in a comment, but not one line below it', () => {
    // lib/env-number.mjs quotes the banned form to explain it; the tree sweep must not
    // fire on documentation. The second half is the half that matters — a stripper that
    // over-reached would blank real code and the sweep would pass by seeing nothing.
    expect(findFoldedEnvParses('// bad: Number(process.env.X || 3)\n')).toHaveLength(0);
    expect(findFoldedEnvParses('/* bad: Number(process.env.X || 3) */\n')).toHaveLength(0);
    const mixed = '// bad: Number(process.env.X || 3)\nconst a = Number(process.env.Y || 4);\n';
    const hits = findFoldedEnvParses(mixed);
    expect(hits).toHaveLength(1);
    expect(hits[0].line, 'line numbers must survive comment blanking').toBe(2);
  });

  it('the sweep covers the files that carried the defect', () => {
    // Premise assertion: a sweep over an empty or mis-rooted file list passes vacuously.
    const files = sweepFiles();
    expect(files.length).toBeGreaterThan(80);
    for (const must of ['scripts/user-prompt-search.js', 'lib/relevance-floor.mjs',
      'lib/cite-back-hint.mjs', 'benchmark/adoption-rankers.mjs']) {
      expect(files, `sweep does not reach ${must}`).toContain(join(ROOT, must));
    }
  });

  it('finds none in the tree', () => {
    const offenders = [];
    for (const f of sweepFiles()) {
      for (const h of findFoldedEnvParses(readFileSync(f, 'utf8'))) {
        offenders.push(`${f.slice(ROOT.length + 1)}:${h.line}  ${h.text}`);
      }
    }
    expect(offenders, `use envNumber() from lib/env-number.mjs:\n${offenders.join('\n')}`).toEqual([]);
  });
});

// ─── End-to-end: the real hook, a real corpus, a malformed knob ─────────────────

const SCRIPT_PATH = resolve(ROOT, 'scripts/user-prompt-search.js');
const PROJECT = 'x--envnum';
const PROMPT = 'why does refreshSessionToken keep throwing after the deploy';
const dirs = [];

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'env-number-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'claude-mem-lite.db'));
  initSchema(db);
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
              VALUES ('cc-seed','mem-seed', ?, datetime('now'), ?)`).run(PROJECT, Date.now());
  const base = Date.now();
  let target;
  db.transaction(() => {
    target = saveObservation(db, {
      content: 'refreshSessionToken threw after every deploy because the rotated signing key '
        + 'was read once at module load instead of per call',
      type: 'bugfix', importance: 3, project: PROJECT,
      lesson_learned: 'read refreshSessionToken signing keys per call, not at module load',
      now: new Date(base),
    });
    for (let i = 1; i < 12; i++) {
      saveObservation(db, {
        content: `unrelated cleanup pass ${i} over the deploy scripts and their logging`,
        type: 'change', importance: 1, project: PROJECT, now: new Date(base - i * 10 * 60_000),
      });
    }
  })();
  db.close();
  return { dir, targetId: target.id };
}

function runHook(dir, extraEnv, sessionId) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [SCRIPT_PATH], {
      env: {
        ...process.env,
        CLAUDE_MEM_DIR: dir,
        CLAUDE_PROJECT_DIR: '/x/envnum',
        PWD: '/x/envnum',
        CLAUDE_MEM_SKIP_UPDATE: '1',
        MEM_QUIET_HOOKS: '1',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 20_000);
    proc.on('close', () => { clearTimeout(killer); done({ stdout, stderr }); });
    proc.stdin.write(JSON.stringify({ session_id: sessionId, prompt: PROMPT, cwd: '/x/envnum' }));
    proc.stdin.end();
  });
}

describe('a malformed numeric env must not silence the UserPromptSubmit face', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  });

  it('injects with the knob unset — the premise every case below rests on', async () => {
    const { dir, targetId } = seed();
    const { stdout } = await runHook(dir, {}, 'env-baseline');
    expect(stdout, 'baseline injects nothing — the cases below would pass vacuously').toContain(`#${targetId}`);
  });

  it('still injects with CLAUDE_MEM_UPS_MAX_RESULTS set to garbage', async () => {
    // Pre-fix this returned '' : NaN reached `rows.slice(0, MAX_RESULTS)`, which is
    // `slice(0, 0)`, and the face emitted nothing at all with no error anywhere.
    const { dir, targetId } = seed();
    const { stdout, stderr } = await runHook(dir, { CLAUDE_MEM_UPS_MAX_RESULTS: 'abc' }, 'env-garbage');
    expect(stdout, 'garbage cap silenced the face').toContain(`#${targetId}`);
    expect(stderr, 'fell back without telling anyone').toContain('CLAUDE_MEM_UPS_MAX_RESULTS');
  });

  it('still injects with every UPS numeric knob set to garbage at once', async () => {
    const { dir, targetId } = seed();
    const { stdout } = await runHook(dir, {
      CLAUDE_MEM_UPS_MAX_RESULTS: 'abc',
      CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT: 'abc',
      CLAUDE_MEM_UPS_BM25_MIN: 'abc',
      CLAUDE_MEM_UPS_BM25_MIN_FOLLOWUP: 'abc',
      CLAUDE_MEM_UPS_TOP_MIN: 'abc',
      CLAUDE_MEM_UPS_OR_BM25_MIN: 'abc',
      CLAUDE_MEM_UPS_FLOOR_REF_CORPUS: 'abc',
    }, 'env-garbage-all');
    expect(stdout).toContain(`#${targetId}`);
  });

  it('the LOW values these knobs are documented to take are not "invalid"', async () => {
    // Earned, not hypothetical: the first cut of this guard gave FLOOR_REF_CORPUS a
    // `min: 2` on the reasoning that maxIdf is 0 below n=2. corpusFloorScale already
    // handles that (`ref <= 1` returns 1, and so does `!(refIdf > 0)`), and 1 is the
    // documented way to pin the corpus ramp OFF — two cases in user-prompt-search.test
    // depend on it. min 2 silently replaced it with 584 and unfired both floor gates.
    // A range bound is a behaviour change; it has to be read off the consumer, not
    // reasoned about from the name.
    const { dir } = seed();
    const { stderr } = await runHook(dir, {
      CLAUDE_MEM_UPS_FLOOR_REF_CORPUS: '1',
      CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT: '0',
      CLAUDE_MEM_UPS_MAX_RESULTS: '0',
    }, 'env-low');
    for (const knob of ['CLAUDE_MEM_UPS_FLOOR_REF_CORPUS', 'CLAUDE_MEM_UPS_PROMPT_FALLBACK_LIMIT',
      'CLAUDE_MEM_UPS_MAX_RESULTS']) {
      expect(stderr, `${knob} rejected a value the code documents as meaningful`).not.toContain(knob);
    }
  });

  it('an explicit 0 on the floor knob still means "kill the absolute floors"', async () => {
    // The documented seed-mode switch. Guards against a fix that treats 0 as invalid.
    const { dir, targetId } = seed();
    const { stdout, stderr } = await runHook(dir, { CLAUDE_MEM_UPS_TOP_MIN: '0' }, 'env-zero');
    expect(stdout).toContain(`#${targetId}`);
    expect(stderr, '0 is a valid value and must not warn').not.toContain('CLAUDE_MEM_UPS_TOP_MIN');
  });
});
