// Grading logic for scripts/validate-plugin-manifests.mjs.
//
// Only the PURE half is tested here, on purpose. Spawning `claude plugin validate` from
// vitest would pass vacuously on any machine without the CLI — the permanently-skipped-test
// shape this repo has been burned by — so the CLI invocation is CI's job (pinned version,
// failure to run is a job failure) and the classification is tested everywhere.
//
// Verified by hand on 2026-09-08 that the whole chain can say NO: re-adding
// `metadata.homepage` to marketplace.json (the exact field the previous round removed) made
// the script exit 1 naming that field; reverting it byte-identical returned exit 0.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyReport,
  collectDiagnostics,
  ALLOWED_WARNINGS,
  ALLOWED_ERRORS,
} from '../scripts/validate-plugin-manifests.mjs';

const PLUGIN_NAME = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'), 'utf8'),
).name;
// Verbatim from `claude plugin validate --strict --json` on Claude Code 2.1.292 (2026-10-06).
const reservedNameError = (name) => ({
  path: 'name',
  message:
    `Plugin name "${name}" is reserved: it passes as one of Anthropic's own. A third party's plugin name ` +
    'cannot start with "claude-", "anthropic-", "anthropics-", or "cc-plugin-", be "claude", "anthropic", ' +
    '"anthropics", "claude-code", or "claude-mods", or put "official" beside "claude" or "anthropic". Name it ' +
    "for what it does. If this is one of Anthropic's own plugins, validate the marketplace that lists it.",
});

const report = ({ manifestWarnings = [], manifestErrors = [], contents = [] } = {}) => ({
  success: true,
  manifest: { file: 'plugin.json', errors: manifestErrors, warnings: manifestWarnings, notes: [] },
  contents,
});

describe('collectDiagnostics', () => {
  it('flattens the manifest section and every contents section', () => {
    const r = report({
      manifestWarnings: [{ message: 'a' }],
      contents: [
        { file: 'X.md', errors: [{ message: 'b' }], warnings: [{ message: 'c' }] },
        { file: 'Y.md', errors: [], warnings: [] },
      ],
    });
    const d = collectDiagnostics(r);
    expect(d.warnings.map((w) => w.message)).toEqual(['a', 'c']);
    expect(d.errors.map((e) => e.message)).toEqual(['b']);
    // The file must survive the flatten or the output cannot say WHERE.
    expect(d.errors[0].file).toBe('X.md');
  });

  it('survives a report with no contents array', () => {
    expect(collectDiagnostics({ manifest: { errors: [], warnings: [] } })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('survives a nullish report rather than throwing on the CI path', () => {
    expect(collectDiagnostics(null)).toEqual({ errors: [], warnings: [] });
  });
});

describe('classifyReport', () => {
  it('fails on any error', () => {
    const v = classifyReport(report({ manifestErrors: [{ message: 'bad name' }] }));
    expect(v.ok).toBe(false);
    expect(v.errors).toHaveLength(1);
  });

  it('fails on a warning that is not on the allowlist', () => {
    // The real regression shape: `metadata.homepage`, which the runtime tolerates and
    // --strict rejects. Verified end-to-end against the CLI (see the header).
    const v = classifyReport(
      report({
        manifestWarnings: [{ message: "Unknown field 'homepage'. Claude Code ignores it at load time." }],
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.unexpected).toHaveLength(1);
    expect(v.allowed).toHaveLength(0);
  });

  it('passes a warning that is on the allowlist, and still reports it', () => {
    const v = classifyReport(
      report({
        contents: [
          {
            file: 'CLAUDE.md',
            errors: [],
            warnings: [{ message: 'CLAUDE.md at the plugin root is not loaded as project context. …' }],
          },
        ],
      }),
    );
    expect(v.ok).toBe(true);
    // Reported, not swallowed: a carried baseline that stops being printed becomes silence,
    // and nobody revisits silence.
    expect(v.allowed).toHaveLength(1);
    expect(v.allowed[0].why).toMatch(/2026-09-08/);
  });

  it('an allowlist entry does not blanket-allow other warnings from the same file', () => {
    const v = classifyReport(
      report({
        contents: [
          {
            file: 'CLAUDE.md',
            errors: [],
            warnings: [
              { message: 'CLAUDE.md at the plugin root is not loaded as project context. …' },
              { message: 'something new upstream started warning about' },
            ],
          },
        ],
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.unexpected.map((w) => w.message)).toEqual(['something new upstream started warning about']);
  });

  it('passes a clean report', () => {
    const v = classifyReport(report());
    expect(v).toEqual({ ok: true, errors: [], unexpected: [], allowed: [], allowedErrors: [] });
  });

  it("passes the reserved-name error for this plugin's own name, and still reports it", () => {
    // D#221: newer validators reserve the `claude-` prefix; the plugin keeps its name because
    // Claude Code installs and loads it regardless and a rename breaks every install.
    const v = classifyReport(report({ manifestErrors: [reservedNameError(PLUGIN_NAME)] }));
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.allowedErrors).toHaveLength(1);
    expect(v.allowedErrors[0].why).toMatch(/2026-10-06/);
  });

  it('does not pass the reserved-name error for any other name', () => {
    const v = classifyReport(report({ manifestErrors: [reservedNameError('claude-something-else')] }));
    expect(v.ok).toBe(false);
    expect(v.errors).toHaveLength(1);
    expect(v.allowedErrors).toEqual([]);
  });

  it('an allowed error does not hide another error beside it', () => {
    const v = classifyReport(
      report({ manifestErrors: [reservedNameError(PLUGIN_NAME), { message: 'Path not found' }] }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.message)).toEqual(['Path not found']);
  });

  it('keeps the allowlist short and reasoned', () => {
    // Not style policing: an allowlist that grows unexamined is how a check stops checking.
    // Every entry must carry the reason it is carried, so review has something to read.
    expect(ALLOWED_WARNINGS.length).toBeLessThanOrEqual(3);
    for (const a of ALLOWED_WARNINGS) {
      expect(a.match.length).toBeGreaterThan(20); // specific enough not to match by accident
      expect(a.why).toBeTruthy();
    }
    // An allowed ERROR is the stronger exception: one entry, naming this plugin's own name,
    // so a rename (or a copy of this script into another plugin) does not inherit it.
    expect(ALLOWED_ERRORS.length).toBeLessThanOrEqual(1);
    for (const a of ALLOWED_ERRORS) {
      expect(a.match).toContain(`"${PLUGIN_NAME}"`);
      expect(a.why).toBeTruthy();
    }
  });
});
