#!/usr/bin/env node
// Runs `claude plugin validate --strict --json` over BOTH manifests and grades the report.
//
// Why this exists as well as tests/plugin-manifest.test.mjs: that guard encodes the
// documented field set locally, so it can say NO on every machine but only about the rules
// it was told. It cannot see a rule the upstream CLI adds later — and the first run of this
// script found exactly that class: `.claude-plugin/plugin.json` still exits 1 under
// `--strict` (CLAUDE.md at the plugin root), which the field-set guard has no way to notice
// because the marketplace half was the only one anybody had checked.
//
// Why not just `claude plugin validate . --strict` in a CI `run:` line: `.` resolves to the
// MARKETPLACE manifest alone, so the plugin manifest goes unvalidated; and a bare invocation
// has no way to carry a known, deliberate warning. This grades three ways instead —
// error, unexpected warning, expected warning — so a red baseline does not have to mean the
// check is off.
//
// Failure to RUN the CLI is a failure, never a skip. A spawn-based check that quietly passes
// on a machine without the tool is the permanently-skipped-test shape this repo has been
// burned by (tests/pre-commit-hook-sync.test.mjs sat skipped for a whole audit round). CI
// pins the CLI version, so "not installed" is a broken workflow, not an environment quirk.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Warnings we have looked at and deliberately carry, each with the reason it is not being
 * fixed. Matched on a substring of the message. Keep this list SHORT and dated — an entry
 * that outlives its reason turns this check back into the thing it replaced.
 */
export const ALLOWED_WARNINGS = [
  {
    // 2026-09-08. True and deliberate: CLAUDE.md at this repo's root is the DEVELOPER's file
    // — the measurement doctrine, the baselines, the invariants — not context meant for
    // plugin users, and Claude Code correctly does not load it as project context. It is
    // also a release guard (tests/install-e2e.test.mjs pins the `**Version**:` line in it),
    // referenced throughout docs/measurement/, and outside package.json#files so it never
    // reaches the npm tarball. Moving it to satisfy a warning about shipping context we are
    // not trying to ship would cost more than it buys.
    match: 'CLAUDE.md at the plugin root is not loaded as project context',
    why: 'developer-facing file; not context we ship. Reviewed 2026-09-08.',
  },
];

/** Every diagnostic in a `--json` report, flattened with its source file. */
export function collectDiagnostics(report) {
  const sections = [report?.manifest, ...(report?.contents ?? [])].filter(Boolean);
  const out = { errors: [], warnings: [] };
  for (const s of sections) {
    for (const e of s.errors ?? []) out.errors.push({ file: s.file, ...e });
    for (const w of s.warnings ?? []) out.warnings.push({ file: s.file, ...w });
  }
  return out;
}

/**
 * @returns {{ok: boolean, errors: object[], unexpected: object[], allowed: object[]}}
 *   `ok` is false for ANY error, and for any warning outside the allowlist. An allowed
 *   warning is reported but does not fail — and is still printed, so a baseline nobody
 *   revisits stays visible instead of becoming silence.
 */
export function classifyReport(report, allowlist = ALLOWED_WARNINGS) {
  const { errors, warnings } = collectDiagnostics(report);
  const allowed = [];
  const unexpected = [];
  for (const w of warnings) {
    const hit = allowlist.find((a) => String(w.message ?? '').includes(a.match));
    (hit ? allowed : unexpected).push(hit ? { ...w, why: hit.why } : w);
  }
  return { ok: errors.length === 0 && unexpected.length === 0, errors, unexpected, allowed };
}

const TARGETS = ['.claude-plugin/marketplace.json', '.claude-plugin/plugin.json'];

function main() {
  let failed = false;
  for (const target of TARGETS) {
    const r = spawnSync('claude', ['plugin', 'validate', join(ROOT, target), '--strict', '--json'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.error) {
      console.error(
        `FAIL ${target}: could not run \`claude plugin validate\` (${r.error.code || r.error.message})`,
      );
      console.error('  This is a failure, not a skip — CI installs a pinned claude CLI for this job.');
      process.exitCode = 1;
      return;
    }
    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      console.error(`FAIL ${target}: validator produced no JSON report (exit ${r.status})`);
      console.error(r.stdout || r.stderr);
      failed = true;
      continue;
    }
    const v = classifyReport(report);
    for (const e of v.errors) console.error(`  ERROR  ${e.file}: ${e.message}`);
    for (const w of v.unexpected) console.error(`  WARN   ${w.file}: ${w.message}`);
    for (const w of v.allowed) console.log(`  known  ${w.file}: ${w.message}\n         (allowed: ${w.why})`);
    console.log(`${v.ok ? 'ok  ' : 'FAIL'} ${target}`);
    if (!v.ok) failed = true;
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
