#!/usr/bin/env node
// efficacy-harness.mjs — STEP 3b-full driver for the efficacy A/C severe test.
// Spec: docs/superpowers/specs/2026-06-05-memory-efficacy-validation-design.md
//
// WHAT IT MEASURES (read this before trusting any number it prints):
//   An UPPER BOUND. The injected lesson is derived from the same commit whose bug
//   we test, and the task necessarily touches that exact region, so lesson↔task are
//   near-isomorphic. A positive result means "on-topic injection changes the code
//   the model writes", NOT "realistic memory improves coding". A NULL result is the
//   strong, interesting outcome (system fails even when spoon-fed). Framed as a
//   SEVERE TEST + effect-size estimator, NOT a powered hypothesis test (step 2:
//   pilot scale cannot reach significance).
//
// DESIGN (locked by the 3b dry-run, incl. bug #8648):
//   - construction: surgical `git revert -n <C>` at HEAD (bug latent, code current),
//     oracle test kept OUT of the worktree, applied only at scoring time.
//   - bug-set: tests that are RED at the reverted baseline = the bug's signature.
//     A commit with an empty bug-set is unusable (skipped, logged).
//   - arm A: CLAUDE_MEM_DIR sandbox seeded with the commit's real lesson, under
//     project=projects--mem; arm C: empty sandbox. BOTH set CLAUDE_PROJECT_DIR=REPO
//     (else inferProject keys off the /tmp cwd and injection is silently empty — #8648).
//   - injection is VERIFIED per arm-A run via a direct hook probe (not CLI recall,
//     which filters differently and gives false green).
//   - score: pass = every bug-set test GREEN after the arm's edit.
//   - unit of analysis = COMMIT; k runs/arm estimate per-commit pass-prob; report
//     commit-level paired Δ (NOT pooled runs — that is pseudo-replication).
//
// Resumable: writes tasks/efficacy-results.json after every run; rerun skips done cells.
//
//   node benchmark/efficacy-harness.mjs --baseline-only   # validate constructions, no sessions
//   node benchmark/efficacy-harness.mjs --k=3             # full run (default arms A,C)
//   node benchmark/efficacy-harness.mjs --commit=bac2e85  # one commit
//   node benchmark/efficacy-harness.mjs --concurrency=3
//   node benchmark/efficacy-harness.mjs --isolated --arms=A,AL,C
//     # D#35 mode: pinned CLAUDE_CONFIG_DIR (mem-only hooks, no global plugins/
//     # orchestrator), plus AL = arm A under CLAUDE_MEM_SALIENCE=legacy so
//     # v2.98-salience vs legacy injection format is measured in the SAME env.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, copyFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { execSync, execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
const execFileP = promisify(execFile);

import { armConfig, INJECTED_ARMS, taskSuffixForArm } from '../lib/efficacy-arms.mjs';
import { lessonBindsToRegion, bridgeFired } from '../lib/efficacy-bridge-select.mjs';

const REPO = process.cwd();
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const K = parseInt(args.k || '3', 10);
// Arms: A = lesson injected (current salience, v2.98 ack-directive),
//       AL = lesson injected with CLAUDE_MEM_SALIENCE=legacy (pre-v2.98 format),
//       C = empty sandbox control,
//       F = lesson injected under CLAUDE_MEM_SALIENCE=bind (bind forcing-function),
//       T = empty sandbox + spec.requirement appended to the task (positive control / gauge),
//       U = empty sandbox + the lesson appended at the task-prompt position under the imperative
//           template (channel-isolation vs T; gates the live Phase-2 emitter).
const ARMS = (args.arms || 'A,C').split(',');
const ISOLATED = !!args.isolated;
const BASELINE_ONLY = !!args['baseline-only'];
const ONLY_COMMIT = args.commit || null;
const CONCURRENCY = parseInt(args.concurrency || '3', 10);
const SESSION_TIMEOUT = parseInt(args.timeout || '420', 10); // s
const CONFIG_PATH = join(REPO, 'benchmark/efficacy-commits.json');
const RESULTS_PATH = join(REPO, 'tasks/efficacy-results.json');
const NODE_MODULES = join(REPO, 'node_modules');

const TASK_SUFFIX = ' Edit the file(s) directly now; do not ask questions.';

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}
function git(cwd, cmd) {
  return sh(`git -C '${cwd}' ${cmd}`);
}

// ── worktree lifecycle ───────────────────────────────────────────────────────
function makeBugPresentWorktree(spec) {
  const wt = mkdtempSync(join(tmpdir(), 'eff-wt-'));
  git(REPO, `worktree add -q '${wt}' HEAD`);
  try {
    symlinkSync(NODE_MODULES, join(wt, 'node_modules'));
  } catch {
    /* exists */
  }
  if (spec.patchFile) {
    // Patch construction: when later commits touched the fix's region, surgical
    // revert conflicts forever (#8650 — the clean-revert pool decays as HEAD moves).
    // A hand-resolved bug-reintroduction patch (old buggy bodies restored onto
    // current code, regression tests excised from the worktree oracle) keeps the
    // cell usable. Oracle at scoring comes from oracleRef (HEAD) in this mode.
    try {
      git(wt, `apply '${join(REPO, spec.patchFile)}'`);
    } catch (e) {
      dropWorktree(wt);
      const err = new Error('patch apply failed');
      err.code = 'REVERT_CONFLICT';
      throw err;
    }
    commitConstruction(wt);
    return wt;
  }
  try {
    git(wt, `revert -n ${spec.hash}`); // bug latent; oracle test also reverted (kept OUT)
  } catch (e) {
    // surgical revert conflicts when later commits touched the same region — older
    // commits are systematically harder to revert cleanly. Mark unusable, don't crash.
    try {
      git(wt, 'revert --abort');
    } catch {
      /* */
    }
    dropWorktree(wt);
    const err = new Error('revert conflict');
    err.code = 'REVERT_CONFLICT';
    throw err;
  }
  commitConstruction(wt);
  return wt;
}

// Oracle-leak guard (found in the 2026-06-13 contamination diagnosis): leaving the
// bug-present construction as an UNCOMMITTED diff lets any session with shell
// access run `git diff` and read exactly what was reverted/excised — including
// the oracle's regression tests. Committing inside the worktree makes the
// construction invisible to git inspection (worktree HEAD is local; REPO is not
// touched). NOTE: this closes only the git-diff channel; see efficacy-README
// "Environment isolation" for the orchestrator/Bash escape that still requires
// a pinned-settings session to fully close.
function commitConstruction(wt) {
  git(wt, 'add -A');
  // --no-verify: worktrees share .git/hooks, so the repo's pre-commit (lint +
  // full suite) would run against the intentionally-buggy construction and
  // reject the commit.
  git(
    wt,
    `-c user.email=harness@efficacy -c user.name=efficacy-harness commit -q --no-verify -m 'chore: routine maintenance'`,
  );
}
function dropWorktree(wt) {
  try {
    git(REPO, `worktree remove --force '${wt}'`);
  } catch {
    /* */
  }
}

// ── pinned session environment (D#35) ───────────────────────────────────────
// --isolated closes the orchestrator/Bash escape from the 2026-06-13
// contamination diagnosis: `--allowedTools` does not confine a session whose
// global ~/.claude config auto-dispatches Bash-capable subagents. We point
// CLAUDE_CONFIG_DIR at a throwaway dir so the session sees NO global plugins,
// hooks, or orchestrator config — only the two mem hooks the experiment is
// about, wired to THIS checkout. Hook subset is deliberate:
//   • PreToolUse pre-tool-recall.js  — the injection channel under test
//   • UserPromptSubmit user-prompt-search.js — prompt-level injection parity
// setup.sh and post-tool-use.sh are EXCLUDED: both hardcode
// $HOME/.claude-mem-lite and would write to the user's live data dir from
// inside the cells (the node paths honor the CLAUDE_MEM_DIR sandbox; the bash
// ones don't). SessionStart/Stop (hook.mjs) are excluded too — Haiku
// summarization is irrelevant to edit quality and just adds cost.
// Credentials: Linux stores them in ~/.claude/.credentials.json; copy into
// the pinned dir (0600) so headless auth works without the real config.
// Model: MUST be carried over from the user's global settings — the isolated-v1
// run omitted it and all 24 cells ran the `claude -p` default model, flooring
// every arm at 0/8 (a model confounder, not an efficacy result). Cells record
// the model so cross-run pooling mistakes are visible in the data.
function pinnedModel() {
  if (args.model) return args.model;
  try {
    return JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).model ?? null;
  } catch {
    return null;
  }
}
function makePinnedConfigDir(model) {
  const cfg = mkdtempSync(join(tmpdir(), 'eff-cfg-'));
  copyFileSync(join(homedir(), '.claude', '.credentials.json'), join(cfg, '.credentials.json'));
  chmodSync(join(cfg, '.credentials.json'), 0o600);
  const hook = (script, timeout) => ({
    type: 'command',
    command: `node "${join(REPO, 'scripts/hook-launcher.mjs')}" scripts/${script}`,
    timeout,
  });
  const rawHook = (relPath, timeout) => ({
    type: 'command',
    command: `node "${join(REPO, relPath)}"`,
    timeout,
  });
  writeFileSync(
    join(cfg, 'settings.json'),
    JSON.stringify(
      {
        ...(model ? { model } : {}),
        hooks: {
          PreToolUse: [
            { matcher: 'Edit|Write|NotebookEdit|Read', hooks: [hook('pre-tool-recall.js', 3)] },
            { matcher: 'Bash|Agent|Task', hooks: [rawHook('benchmark/confine-tools.js', 2)] },
          ],
          PostToolUse: [{ matcher: 'Edit|Write', hooks: [hook('post-tool-recall.js', 3)] }],
          UserPromptSubmit: [{ matcher: '*', hooks: [hook('user-prompt-search.js', 2)] }],
        },
      },
      null,
      2,
    ),
  );
  return cfg;
}

// ── oracle scoring via vitest json reporter ──────────────────────────────────
// returns Map<testFullName, 'passed'|'failed'>
function runOracle(wt, oracleTestRel, commit) {
  // place the post-fix oracle test into the worktree, then run ONLY it
  // (patch-constructed cells score against the HEAD oracle via oracleRef)
  const oracleContent = git(REPO, `show ${commit}:${oracleTestRel}`);
  writeFileSync(join(wt, oracleTestRel), oracleContent);
  let out;
  try {
    out = sh(`./node_modules/.bin/vitest run ${oracleTestRel} --reporter=json 2>/dev/null`, { cwd: wt });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  } // vitest exits non-zero on fail
  const jsonStart = out.indexOf('{');
  let report;
  try {
    report = JSON.parse(out.slice(jsonStart));
  } catch {
    return null;
  }
  const res = new Map();
  for (const f of report.testResults || []) {
    for (const a of f.assertionResults || []) res.set(a.fullName || a.title, a.status);
  }
  return res;
}

// ── mem sandbox seeding ──────────────────────────────────────────────────────
function seedSandbox(arm, spec) {
  const sb = mkdtempSync(join(tmpdir(), `eff-mem${arm}-`));
  if (armConfig(arm).inject) {
    const filesArg = spec.srcFiles.map((f) => `--files ${f}`).join(' ');
    execFileSync(
      'bash',
      [
        '-c',
        `CLAUDE_MEM_DIR='${sb}' claude-mem-lite save --type bugfix --importance 2 --project projects--mem ` +
          `${filesArg} --title ${JSON.stringify(spec.lessonTitle)} --lesson ${JSON.stringify(spec.lesson)} ` +
          `${JSON.stringify(spec.lessonBody || spec.lesson)}`,
      ],
      { stdio: 'ignore' },
    );
  }
  return sb;
}

// ── injection probe (arm A only): assert the hook really injects ─────────────
function probeInjection(sandbox, wt, srcFile) {
  const event = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: join(wt, srcFile) },
    session_id: `probe-${Math.floor(performance.now())}`,
  });
  let out;
  try {
    out = execFileSync(
      'bash',
      [
        '-c',
        `echo '${event.replace(/'/g, "'\\''")}' | CLAUDE_MEM_DIR='${sandbox}' CLAUDE_PROJECT_DIR='${REPO}' node scripts/pre-tool-recall.js`,
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  return /\[mem\] Lessons for/.test(out); // true = lesson actually injected
}

// arm-B probe: run the hook with CLAUDE_MEM_SALIENCE=bridge and check if the
// bridge marker (→ this edit must:) appears. Called AFTER the contamination-fix
// runtime wipe; callers must wipe runtime again before the real session.
// regionText (the fix-region diff) is fed as the Edit hunk: bridgeTopLesson
// abstains immediately on empty changeText (pre-tool-recall.js:85), so a hunk-less
// probe would report bridgeFired=false for EVERY cell. The hunk exercises the real
// identifier-overlap gate (line 95) + Haiku bridge path.
function probeBridgeFired(sandbox, wt, srcFile, regionText) {
  const hunk = String(regionText || '').slice(0, 1500);
  const event = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: join(wt, srcFile), old_string: hunk },
    session_id: `bridge-probe-${Math.floor(performance.now())}`,
  });
  let out;
  try {
    out = execFileSync(
      'bash',
      [
        '-c',
        `echo '${event.replace(/'/g, "'\\''")}' | CLAUDE_MEM_DIR='${sandbox}' CLAUDE_PROJECT_DIR='${REPO}' CLAUDE_MEM_SALIENCE=bridge node scripts/pre-tool-recall.js`,
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  return bridgeFired(out);
}

// ── one session ──────────────────────────────────────────────────────────────
async function runArmSeed(spec, arm, seed, cfgDir, model) {
  let wt;
  try {
    wt = makeBugPresentWorktree(spec);
  } catch (e) {
    return {
      commit: spec.hash,
      arm,
      seed,
      pass: null,
      note: e.code === 'REVERT_CONFLICT' ? 'revert conflict' : 'worktree fail',
    };
  }
  const sb = seedSandbox(arm, spec);
  const cell = { commit: spec.hash, arm, seed };
  if (cfgDir) {
    cell.env = 'isolated-v2';
    cell.model = model || 'cli-default';
  }
  const cfg = armConfig(arm);
  if (cfg.inject) cell.salience = cfg.salience || 'current';
  try {
    if (cfg.inject) {
      cell.injected = probeInjection(sb, wt, spec.srcFiles[0]);
      if (!cell.injected) {
        cell.pass = null;
        cell.note = 'INJECTION FAILED — discard';
        return cell;
      }
      // CONTAMINATION FIX (2026-06-22): probeInjection runs pre-tool-recall, which
      // writes the PROJECT-scoped cross-hook dedup file (.claude-mem-injected-<project>)
      // + a probe cooldown into the sandbox runtime. Left in place, the real session
      // reads them (readCrossHookInjected) and DEDUPS the lesson away → ZERO injection
      // in every injected arm (A/AL/F floored at 0 not because the directive is inert
      // but because the model never saw the lesson). Wipe the sandbox runtime so the
      // session's first recall injects fresh. Arm T (not injected) never probes.
      rmSync(join(sb, 'runtime'), { recursive: true, force: true });
      if (arm === 'B') {
        // Bridge-fired probe: run with CLAUDE_MEM_SALIENCE=bridge to check if the
        // bridge marker fires. This is a pre-session proxy (the real session hook
        // outputs are not captured by execFileP). Wipe runtime again before the
        // real session so the bridge probe doesn't dedup the lesson away.
        cell.bridgeFired = probeBridgeFired(sb, wt, spec.srcFiles[0], spec.bridgeRegion || '');
        rmSync(join(sb, 'runtime'), { recursive: true, force: true });
      }
    }
    const task = spec.task + taskSuffixForArm(arm, spec) + TASK_SUFFIX;
    const envVars = [
      `CLAUDE_MEM_DIR='${sb}'`,
      `CLAUDE_PROJECT_DIR='${REPO}'`,
      cfgDir ? `CLAUDE_CONFIG_DIR='${cfgDir}'` : '',
      cfg.salience ? `CLAUDE_MEM_SALIENCE=${cfg.salience}` : '',
      // Non-isolated cells (no cfgDir) spawn `claude -p` under the real ~/.claude,
      // whose SessionStart auto-adopt (hook.mjs, gated on MEM_NO_AUTO_ADOPT) writes a
      // sentinel into a throwaway worktree memdir that outlives the deleted worktree.
      // Opt out so efficacy runs leave no ~/.claude/projects/*/memory residue.
      `MEM_NO_AUTO_ADOPT=1`,
    ]
      .filter(Boolean)
      .join(' ');
    try {
      await execFileP(
        'bash',
        [
          '-c',
          `cd '${wt}' && ${envVars} timeout ${SESSION_TIMEOUT} ` +
            `claude -p ${JSON.stringify(task)} --permission-mode bypassPermissions --allowedTools 'Read,Edit' --output-format text`,
        ],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: (SESSION_TIMEOUT + 30) * 1000 },
      );
    } catch (e) {
      cell.sessionErr = String(e.message).slice(0, 120);
    }
    const res = runOracle(wt, spec.oracleTest, spec.oracleRef || spec.hash);
    if (!res) {
      cell.pass = null;
      cell.note = 'oracle parse failed';
      return cell;
    }
    cell.pass = spec.bugSet.every((t) => res.get(t) === 'passed') ? 1 : 0;
    cell.bugSetResults = spec.bugSet.map((t) => [t, res.get(t)]);
  } finally {
    dropWorktree(wt);
    rmSync(sb, { recursive: true, force: true });
  }
  return cell;
}

// ── baseline: discover bug-set + validate construction (no sessions) ─────────
function validateConstruction(spec) {
  let wt;
  try {
    wt = makeBugPresentWorktree(spec);
  } catch (e) {
    return {
      ok: false,
      reason:
        e.code === 'REVERT_CONFLICT'
          ? 'revert conflict (older commit, region changed since)'
          : String(e.message).slice(0, 80),
    };
  }
  try {
    const res = runOracle(wt, spec.oracleTest, spec.oracleRef || spec.hash);
    if (!res) return { ok: false, reason: 'oracle parse failed' };
    const failing = [...res.entries()].filter(([, s]) => s === 'failed').map(([t]) => t);
    if (failing.length === 0)
      return { ok: false, reason: 'empty bug-set (revert did not make oracle RED) — unusable' };
    return { ok: true, bugSet: failing, total: res.size };
  } finally {
    dropWorktree(wt);
  }
}

// ── results store (resumable) ────────────────────────────────────────────────
function loadResults() {
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
  } catch {
    return { cells: [] };
  }
}
function saveResults(r) {
  writeFileSync(RESULTS_PATH, JSON.stringify(r, null, 2));
}
const cellKey = (c) => `${c.commit}|${c.arm}|${c.seed}`;

// ── run ───────────────────────────────────────────────────────────────────────
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
let commits = config.commits;
if (ONLY_COMMIT) commits = commits.filter((c) => c.hash.startsWith(ONLY_COMMIT));

console.log(
  `efficacy-harness: ${commits.length} commits, arms=${ARMS}, k=${K}, baseline-only=${BASELINE_ONLY}, isolated=${ISOLATED}`,
);
console.log('NOTE: measures an UPPER BOUND (lesson↔task isomorphic). Severe test, not a powered test.');
if (!ISOLATED && !BASELINE_ONLY)
  console.log(
    'WARNING: running under the user global ~/.claude config — cells are NOT comparable across config changes (see efficacy-README "Environment isolation"). Use --isolated.',
  );
console.log('');

// Phase 1: validate constructions + discover bug-sets
for (const spec of commits) {
  const v = validateConstruction(spec);
  if (!v.ok) {
    console.log(`  ✗ ${spec.hash}  UNUSABLE: ${v.reason}`);
    spec._skip = true;
    continue;
  }
  spec.bugSet = v.bugSet;
  // bridgeBindable: true iff a lesson identifier appears in the commit's diff
  // (proxy for the revert diff — both touch the same identifiers). Uses git show
  // which is read-only and safe to run in the Phase-1 loop.
  const lessonText = spec.lesson || spec.lessonBody || '';
  let revertDiff = '';
  try {
    revertDiff = sh(`git show ${spec.hash} -- ${spec.srcFiles.join(' ')}`);
  } catch {
    /* not bindable */
  }
  spec.bridgeBindable = lessonBindsToRegion(lessonText, revertDiff);
  spec.bridgeRegion = revertDiff; // fed to the arm-B bridge probe as the change hunk (else changeText='' → bridge abstains)
  console.log(
    `  ✓ ${spec.hash}  bug-set = ${v.bugSet.length}/${v.total} RED: ${v.bugSet.map((t) => t.slice(0, 40)).join(' | ')}  bridgeBindable=${spec.bridgeBindable}`,
  );
}
const usable = commits.filter((c) => !c._skip);
console.log(`\n${usable.length}/${commits.length} commits usable.`);
if (BASELINE_ONLY) {
  console.log('--baseline-only: stopping before any session.');
  process.exit(0);
}
if (!usable.length) process.exit(1);

// Phase 2: run sessions (resumable, bounded concurrency)
const results = loadResults();
const done = new Set(results.cells.map(cellKey));
const queue = [];
for (const spec of usable)
  for (const arm of ARMS)
    for (let s = 1; s <= K; s++) {
      if (!done.has(`${spec.hash}|${arm}|${s}`)) queue.push({ spec, arm, seed: s });
    }
console.log(`${queue.length} sessions to run (${done.size} already done), concurrency=${CONCURRENCY}\n`);

const pinModel = ISOLATED ? pinnedModel() : null;
const cfgDir = ISOLATED && queue.length ? makePinnedConfigDir(pinModel) : null;
if (cfgDir)
  console.log(
    `pinned session config: ${cfgDir} (mem-only hooks, no global plugins, model=${pinModel || 'cli-default'})\n`,
  );
process.on('exit', () => {
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
});

let active = 0,
  idx = 0,
  completed = 0;
await new Promise((resolve) => {
  const pump = () => {
    if (idx >= queue.length && active === 0) return resolve();
    while (active < CONCURRENCY && idx < queue.length) {
      const job = queue[idx++];
      active++;
      Promise.resolve()
        .then(() => runArmSeed(job.spec, job.arm, job.seed, cfgDir, pinModel))
        .then((cell) => {
          results.cells.push(cell);
          saveResults(results);
          active--;
          completed++;
          console.log(
            `  [${completed}/${queue.length}] ${cell.commit} arm ${cell.arm} #${cell.seed}: ` +
              (cell.pass === null ? `SKIP(${cell.note})` : cell.pass ? 'PASS' : 'FAIL') +
              (INJECTED_ARMS.has(cell.arm) && cell.injected === false ? ' ⚠NOINJECT' : '') +
              (cell.arm === 'B' && cell.bridgeFired === false ? ' ⚠NOBRIDGE' : ''),
          );
          pump();
        });
    }
  };
  pump();
});

// Phase 3: aggregate (commit-level)
console.log('\n── per-commit pass-rates (k=' + K + ') ──');
const perCommit = [];
for (const spec of usable) {
  const row = { commit: spec.hash };
  for (const arm of ARMS) {
    // ITT (intention-to-treat): count ALL non-null cells. For arm B, non-fired cells
    // fail open to the ACK directive (≈ arm A) — that IS what "turn the flag on" does
    // in production, so they belong in the headline. Silently dropping them would bias
    // Δ optimistic (it can manufacture a positive result by removing ~0-scoring cells).
    const cells = results.cells.filter((c) => c.commit === spec.hash && c.arm === arm && c.pass !== null);
    row[arm] = { n: cells.length, pass: cells.filter((c) => c.pass === 1).length };
  }
  // arm-B per-protocol (fired-only) subset: a secondary, OPTIMISTIC diagnostic that
  // excludes fail-open-to-ACK cells. Never the headline; feeds the Δ_fired lines below.
  if (ARMS.includes('B')) {
    const fired = results.cells.filter(
      (c) => c.commit === spec.hash && c.arm === 'B' && c.pass !== null && c.bridgeFired !== false,
    );
    row.B_fired = { n: fired.length, pass: fired.filter((c) => c.pass === 1).length };
  }
  perCommit.push(row);
  const c = row.C;
  const armStr =
    ARMS.map((arm) => `${arm}=${row[arm]?.pass}/${row[arm]?.n}`).join('  ') +
    (row.B_fired ? `  B_fired=${row.B_fired.pass}/${row.B_fired.n}` : '');
  const deltaStr = ARMS.filter((arm) => arm !== 'C')
    .map((arm) => {
      const a = row[arm];
      return `Δ(${arm}−C)=${a && c && a.n && c.n ? ((a.pass / a.n - c.pass / c.n) * 100).toFixed(0) + 'pp' : 'n/a'}`;
    })
    .join('  ');
  console.log(`  ${spec.hash}  ${armStr}  ${deltaStr}`);
}
// commit-level paired mean Δ between two row keys, over commits where both have ≥1 cell.
function pairedMeanDelta(left, right) {
  const deltas = perCommit
    .filter((r) => r[left]?.n && r[right]?.n)
    .map((r) => r[left].pass / r[left].n - r[right].pass / r[right].n);
  return {
    meanD: deltas.length ? deltas.reduce((x, y) => x + y, 0) / deltas.length : null,
    n: deltas.length,
  };
}
const fmtD = (d) => (d.meanD == null ? 'n/a' : (d.meanD * 100).toFixed(1) + 'pp');

// ITT (intention-to-treat) headline, one line per injected arm vs C. For arm B this
// includes fail-open-to-ACK cells — the trustworthy "what flipping the flag does" number.
for (const arm of ARMS.filter((a) => a !== 'C')) {
  const d = pairedMeanDelta(arm, 'C');
  const label = arm === 'B' ? 'Δ_ITT(B−C)' : `Δ(${arm}−C)`;
  console.log(
    `\nCOMMIT-LEVEL mean ${label} = ${fmtD(d)} over ${d.n} commits.` +
      (arm === 'B' ? '  [ITT — trustworthy/primary: includes fail-open-to-ACK cells]' : ''),
  );
}
// arm B extra deltas: ITT vs A, plus the fired-only (per-protocol) subset. Fired-only
// EXCLUDES fail-open-to-ACK cells → OPTIMISTIC, so it is a diagnostic, NOT the headline.
if (ARMS.includes('B')) {
  if (ARMS.includes('A')) {
    const d = pairedMeanDelta('B', 'A');
    console.log(
      `COMMIT-LEVEL mean Δ_ITT(B−A) = ${fmtD(d)} over ${d.n} commits.  [ITT — trustworthy/primary]`,
    );
  }
  const dfc = pairedMeanDelta('B_fired', 'C');
  console.log(
    `COMMIT-LEVEL mean Δ_fired(B−C) = ${fmtD(dfc)} over ${dfc.n} commits.  [fired-only (per-protocol — excludes fail-open-to-ACK cells; OPTIMISTIC)]`,
  );
  if (ARMS.includes('A')) {
    const dfa = pairedMeanDelta('B_fired', 'A');
    console.log(
      `COMMIT-LEVEL mean Δ_fired(B−A) = ${fmtD(dfa)} over ${dfa.n} commits.  [fired-only (per-protocol — OPTIMISTIC)]`,
    );
  }
}
console.log(
  'UPPER BOUND. No significance claimed (step-2 power). NULL/near-0 here = strong negative; large + = on-topic injection works (not realistic efficacy).',
);
saveResults(results);
