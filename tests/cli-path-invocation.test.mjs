// Regression lock for the v3.1.1 path-resolution fix (code review 2026-06-20,
// findings #1/#2/#3/#13). The bundled CLI must be advertised by an absolute,
// import.meta.url-resolved path that exists on EVERY install shape — NOT the
// pre-v3.1.1 `~/.claude-mem-lite/cli.mjs`, which is absent on a plugin-only
// install (setup.sh provisions the data dir but never materializes source).
//
// Two correct strategies, asserted separately:
//   • JS-emitted/runtime-resolved surfaces  → absolute CLI_INVOKE (this file)
//   • plugin MANIFEST files (commands/*.md)  → literal ${CLAUDE_PLUGIN_ROOT}

import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { CLI_PATH, CLI_INVOKE } from '../cli-path.mjs';
import { tools } from '../tool-schemas.mjs';
import { buildServerInstructions } from '../search-scoring.mjs';
import { getDetailDoc, buildClaudeMdBlock } from '../adopt-content.mjs';

// D#207: `join()`, not `new URL('../cli-path.mjs', import.meta.url)`. Naming a module
// that way anywhere in the analysed tree makes knip drop it from the unused-export
// report entirely. Pinned for the class by tests/no-url-module-paths.test.mjs.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROKEN = '~/.claude-mem-lite/cli.mjs';

describe('cli-path single source of truth', () => {
  test('CLI_PATH resolves to the real bundled cli.mjs on this install shape', () => {
    expect(CLI_PATH.endsWith('cli.mjs')).toBe(true);
    expect(CLI_PATH.startsWith('/')).toBe(true);      // absolute, never a tilde
    expect(CLI_PATH).not.toContain('~');
    expect(existsSync(CLI_PATH)).toBe(true);          // the whole point: it exists
    expect(CLI_INVOKE).toBe(`node ${CLI_PATH}`);
  });
});

describe('LLM-visible CLI hints advertise the resolvable path, not the tilde path', () => {
  test('tool-schemas per-tool "Equivalent CLI" hints', () => {
    const withHint = tools.filter((t) => /Equivalent CLI: node /.test(t.description || ''));
    expect(withHint.length).toBeGreaterThan(10);      // ~18 tools carry a CLI hint
    for (const t of tools) {
      expect(t.description || '').not.toContain(BROKEN);
    }
    expect(tools.some((t) => (t.description || '').includes(CLI_PATH))).toBe(true);
  });

  test('MCP server instructions (highest-authority Claude-facing surface)', () => {
    for (const instr of [buildServerInstructions(false), buildServerInstructions(true)]) {
      expect(instr).not.toContain(BROKEN);
      expect(instr).toContain(CLI_PATH);
      // the copyable examples must NOT be the bare `claude-mem-lite <cmd>` form
      expect(instr).not.toMatch(/\n {2}claude-mem-lite (search|recall|recent|get|timeline) /);
    }
  });

  test('adopt detail doc (persisted verbatim into the user MEMORY.md)', () => {
    const doc = getDetailDoc();
    expect(doc).not.toContain(BROKEN);
    expect(doc).toContain(CLI_PATH);
    // routing-cost guidance present: deferred mem_* → CLI is fewer round-trips
    expect(doc).toContain('ToolSearch');
    expect(doc).toContain('round-trip');
  });

  test('adopt CLAUDE.md block carries the round-trip routing note, stays machine-stable', () => {
    const block = buildClaudeMdBlock();
    expect(block).toContain('ToolSearch');
    expect(block).toContain('round-trips');
    // committed/refreshed block must NOT bake an absolute per-install path
    expect(block).not.toContain(CLI_PATH);
  });
});

describe('steering-surface consistency + injection budget', () => {
  // #8846: the four LLM-facing steering surfaces (MCP instructions BASE, the
  // VERBOSE triggers, the adopt CLAUDE.md block, the detail doc) change together.
  // The defer trio is exposed via tools/list and referenced in the block + doc,
  // but the always-injected instructions roster once omitted it — this pins that
  // gap closed so a future roster edit that forgets a surface fails here.
  test('mem_defer roster appears in every LLM-facing steering surface', () => {
    const surfaces = {
      'instructions (full)': buildServerInstructions(false),
      'instructions (quiet/BASE)': buildServerInstructions(true),
      'CLAUDE.md block': buildClaudeMdBlock(),
      'detail doc': getDetailDoc(),
    };
    for (const [name, text] of Object.entries(surfaces)) {
      expect(text, `${name} omits mem_defer`).toContain('mem_defer');
    }
  });

  test('the defer trio is both exposed (tools/list) and advertised (instructions)', () => {
    const exposed = tools.map((t) => t.name);
    const base = buildServerInstructions(true);
    for (const n of ['mem_defer', 'mem_defer_list', 'mem_defer_drop']) {
      expect(exposed, `${n} not exposed in tools`).toContain(n);
      expect(base, `${n} not advertised in instructions BASE`).toContain(n);
    }
  });

  // §7 metric-coupling: block + instructions are injected EVERY session; the
  // detail doc is written verbatim into a user file. Guard against unbounded
  // growth. Ceilings sit ~20-60% above the 2026-07 post-defer baseline
  // (block 1226 / doc 6293 / instr-full 2866 / instr-BASE 1492, re-measured 2026-09-01;
  // the doc figure stood at a stale 5139 until then) — a tripwire,
  // not a straitjacket: if an intended addition trips one, RAISE it deliberately
  // (and re-check the MCP instructions field against the harness cutoff).
  //
  // D#185: three of these surfaces embed the absolute CLI_PATH, 26 times in the
  // detail doc alone, so a raw `.length` budget is partly a budget on how deep the
  // reader's install prefix happens to be. Measured at the time of the fix, the
  // thresholds at which each assertion reddens on CLI_PATH length alone were: doc
  // >=104 chars, instr-full >=129, instr-BASE >=140 (the block embeds it zero times
  // and could never redden). This machine's CLI_PATH is 38 chars and the surfaces
  // were nowhere near their ceilings — but PR #17's external contributor reported
  // this failing in their environment while all 12 cases passed here, and a deep
  // prefix (`/Users/<name>/Library/Application Support/...`) clears 104 easily. Note
  // the first surface to redden is the detail DOC, not the instructions.
  //
  // Fix: budget the CONTENT by normalising every CLI_PATH occurrence to one fixed
  // reference install path, so the measured number is the same on every machine.
  const REF_CLI_PATH = '/usr/lib/node_modules/claude-mem-lite/cli.mjs';
  const contentLen = (s) => s.split(CLI_PATH).join(REF_CLI_PATH).length;

  test('steering surfaces stay within their injection budget', () => {
    expect(contentLen(buildClaudeMdBlock()), 'CLAUDE.md block').toBeLessThan(2000);
    expect(contentLen(getDetailDoc()), 'detail doc').toBeLessThan(8000);
    expect(contentLen(buildServerInstructions(false)), 'instructions full').toBeLessThan(3500);
    expect(contentLen(buildServerInstructions(true)), 'instructions BASE').toBeLessThan(2200);
  });

  // Self-check on the fix above: normalisation that silently stops finding CLI_PATH
  // degrades back to a raw-length budget without failing anything, so pin that the
  // surfaces which are SUPPOSED to embed the path still do, and that the budget is
  // genuinely independent of how long that path is.
  test('the injection budget is decoupled from this install path length', () => {
    for (const [name, text, minOcc] of [
      ['detail doc', getDetailDoc(), 10],
      ['instructions full', buildServerInstructions(false), 3],
      ['instructions BASE', buildServerInstructions(true), 3],
    ]) {
      const occ = text.split(CLI_PATH).length - 1;
      expect(occ, `${name} no longer embeds CLI_PATH — normalisation is a no-op`)
        .toBeGreaterThanOrEqual(minOcc);
      // budgeted length must not move when the install prefix does
      const deepInstall = text.split(CLI_PATH).join(`/very/deep${CLI_PATH}`);
      expect(deepInstall.split(`/very/deep${CLI_PATH}`).join(REF_CLI_PATH).length,
        `${name} budget still tracks install-path length`).toBe(contentLen(text));
    }
  });
});

describe('runtime recovery hints resolve `repair` by absolute path', () => {
  // #3: hook-launcher + native-binding-hint advised bare `claude-mem-lite repair`,
  // which is not on PATH for a plugin-only install. They must now emit an
  // absolute `node <cli.mjs> repair`.
  test('no bare `claude-mem-lite repair` survives in the recovery hints', () => {
    for (const rel of ['scripts/hook-launcher.mjs', 'lib/native-binding-hint.mjs']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} still emits bare 'claude-mem-lite repair'`).not.toContain('claude-mem-lite repair');
      expect(src).toContain('cli.mjs') ;
    }
  });
});

describe('source + manifest guards', () => {
  test('no JS-emitted surface still hardcodes the tilde path', () => {
    for (const rel of ['tool-schemas.mjs', 'adopt-content.mjs', 'search-scoring.mjs',
                       'lib/native-binding-hint.mjs', 'scripts/hook-launcher.mjs']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} still contains the broken tilde path`).not.toContain(BROKEN);
    }
  });

  test('slash-command manifests use ${CLAUDE_PLUGIN_ROOT}, not the tilde path', () => {
    for (const rel of ['commands/adopt.md', 'commands/unadopt.md', 'commands/mem.md',
                       'commands/bug.md', 'commands/lesson.md']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} still contains the broken tilde path`).not.toContain(BROKEN);
      expect(src).toContain('${CLAUDE_PLUGIN_ROOT}/cli.mjs');
    }
  });

  test('cli-path.mjs is registered for shipping (SOURCE_FILES + package.json files)', () => {
    const srcFiles = readFileSync(join(ROOT, 'source-files.mjs'), 'utf8');
    expect(srcFiles).toContain("'cli-path.mjs'");
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('cli-path.mjs');
  });
});
