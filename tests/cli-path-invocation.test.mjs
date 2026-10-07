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
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

import { CLI_PATH, CLI_INVOKE, shellWord } from '../cli-path.mjs';
import { walkShipped } from './shipped-tree.mjs';
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
    expect(CLI_PATH.startsWith('/')).toBe(true); // absolute, never a tilde
    expect(CLI_PATH).not.toContain('~');
    expect(existsSync(CLI_PATH)).toBe(true); // the whole point: it exists
    expect(CLI_INVOKE).toBe(`node ${shellWord(CLI_PATH)}`);
  });
});

describe('LLM-visible CLI hints advertise the resolvable path, not the tilde path', () => {
  test('tool-schemas per-tool "Equivalent CLI" hints', () => {
    const withHint = tools.filter((t) => /Equivalent CLI: node /.test(t.description || ''));
    expect(withHint.length).toBeGreaterThan(10); // ~19 tools carry a CLI hint
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

  // RESTATED for audit R7 P2-1 (was: `expect(doc).toContain(CLI_PATH)`).
  //
  // This case used to demand the ABSOLUTE path in the detail doc, on the v3.1.1 reasoning
  // that an LLM-facing hint must name a command that actually resolves. That reasoning is
  // intact; the mechanism changed. The doc is written into <cwd>/.claude/ — the user's repo,
  // commonly committed — so an absolute, version-pinned path made the file churn on every
  // release and handed teammates a $HOME path that exists on no other machine. The doc now
  // names the bare command and points at the MCP instructions, which is the runtime-resolved
  // surface that DOES carry the absolute path (asserted two cases up, and it must keep doing
  // so or the pointer dangles).
  //
  // Title also corrected: since v3.13 the doc lands in <cwd>/.claude/plugin_<slug>.md, not
  // in the memory-dir MEMORY.md.
  test('adopt detail doc (written into the user project at .claude/plugin_<slug>.md)', () => {
    const doc = getDetailDoc();
    expect(doc).not.toContain(BROKEN);
    // No absolute path of ANY shape — not this install's, not a generic one.
    expect(doc).not.toContain(CLI_PATH);
    expect(doc).not.toMatch(/node\s+\/\S*cli\.mjs/);
    // …but the reader must still be able to reach a resolvable command.
    expect(doc).toContain('claude-mem-lite');
    expect(doc, 'doc must point at the surface that carries the absolute path').toContain('instructions');
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
  //
  // SUPERSEDED IN PART by audit R7 P2-1: the detail doc no longer embeds CLI_PATH at
  // all, so the surface that reddened FIRST under a deep prefix can no longer redden
  // on path length — the D#185 hazard now applies only to the two instructions
  // surfaces. Normalisation stays for those. The doc keeps its budget (it is still
  // written into a user file) but its number is now install-independent by
  // construction rather than by normalisation, which is why the self-check below
  // asserts ZERO occurrences for it instead of a floor.
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
  // R7 P2-1: the two surfaces that are BUILT at runtime and never written to the user's
  // repo must still embed the path (or normalisation is silently a no-op and the budget
  // degrades to a raw-length budget). The detail doc is asserted the other way, below.
  test('the injection budget is decoupled from this install path length', () => {
    for (const [name, text, minOcc] of [
      ['instructions full', buildServerInstructions(false), 3],
      ['instructions BASE', buildServerInstructions(true), 3],
    ]) {
      const occ = text.split(CLI_PATH).length - 1;
      expect(occ, `${name} no longer embeds CLI_PATH — normalisation is a no-op`).toBeGreaterThanOrEqual(
        minOcc,
      );
      // budgeted length must not move when the install prefix does
      const deepInstall = text.split(CLI_PATH).join(`/very/deep${CLI_PATH}`);
      expect(
        deepInstall.split(`/very/deep${CLI_PATH}`).join(REF_CLI_PATH).length,
        `${name} budget still tracks install-path length`,
      ).toBe(contentLen(text));
    }
  });

  // R7 P2-1, the other half: surfaces PERSISTED into the user's project tree must embed
  // the install path ZERO times, so the bytes that land in their repo are identical on
  // every machine and across every plugin version. Stated as a length identity rather
  // than only an occurrence count, so a path smuggled in by some other spelling
  // (a different variable, a hand-typed prefix) still trips it.
  test('files written into the user project are byte-identical across installs', () => {
    for (const [name, text] of [
      ['CLAUDE.md block', buildClaudeMdBlock()],
      ['detail doc', getDetailDoc()],
    ]) {
      expect(text.split(CLI_PATH).length - 1, `${name} embeds the absolute CLI path`).toBe(0);
      expect(contentLen(text), `${name} length moves with the install prefix`).toBe(text.length);
      expect(text, `${name} embeds an absolute node invocation`).not.toMatch(/node\s+\/\S*cli\.mjs/);
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
      expect(src).toContain('cli.mjs');
    }
  });
});

describe('source + manifest guards', () => {
  test('no JS-emitted surface still hardcodes the tilde path', () => {
    for (const rel of [
      'tool-schemas.mjs',
      'adopt-content.mjs',
      'search-scoring.mjs',
      'lib/native-binding-hint.mjs',
      'scripts/hook-launcher.mjs',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} still contains the broken tilde path`).not.toContain(BROKEN);
    }
  });

  test('slash-command manifests use ${CLAUDE_PLUGIN_ROOT}, not the tilde path', () => {
    for (const rel of [
      'commands/adopt.md',
      'commands/unadopt.md',
      'commands/mem.md',
      'commands/bug.md',
      'commands/lesson.md',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} still contains the broken tilde path`).not.toContain(BROKEN);
      expect(src).toContain('${CLAUDE_PLUGIN_ROOT}/cli.mjs');
    }
  });

  test('every ${CLAUDE_PLUGIN_ROOT} in commands/*.md is double-quoted', () => {
    // An unquoted root splits on a space in the install path (a home directory with a space
    // in it), and `!`-prefixed lines run through the shell as written. Every manifest, not a
    // hand-kept list: the list above had drifted to five of the eight files.
    const files = readdirSync(join(ROOT, 'commands')).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(join(ROOT, 'commands', f), 'utf8');
      for (const m of src.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}/g)) {
        seen++;
        const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
        expect(src[m.index - 1], `commands/${f}: unquoted plugin root in: ${line.trim()}`).toBe('"');
      }
    }
    expect(seen).toBeGreaterThanOrEqual(16);
  });

  // A printed `node <path> …` is only runnable if the path stays ONE shell word. Before
  // shellWord, a home directory with a space split CLI_INVOKE (the MCP instructions and every
  // "Equivalent CLI" hint) and nine doctor/repair remedy lines into two arguments.
  test('shellWord round-trips any path through bash as one word, and leaves a plain one byte-identical', () => {
    for (const p of [
      '/plain/p-1_x/cli.mjs',
      '/home/John Smith/cli.mjs',
      "/it's/here/cli.mjs",
      '/a$b`c"d/cli.mjs',
    ]) {
      const r = spawnSync('bash', ['-c', `printf %s ${shellWord(p)}`], { encoding: 'utf8' });
      expect(r.stdout, p).toBe(p);
    }
    expect(shellWord('/plain/p-1_x/cli.mjs')).toBe('/plain/p-1_x/cli.mjs');
  });

  test('CLI_INVOKE computed at a path with a space still names cli.mjs as one word', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cml-cli-path-')), 'dir with space');
    mkdirSync(dir);
    try {
      copyFileSync(join(ROOT, 'cli-path.mjs'), join(dir, 'cli-path.mjs'));
      const mod = await import(pathToFileURL(join(dir, 'cli-path.mjs')).href);
      expect(mod.CLI_PATH).toBe(join(dir, 'cli.mjs'));
      expect(mod.CLI_INVOKE.startsWith('node ')).toBe(true);
      const r = spawnSync('bash', ['-c', `printf '%s|' ${mod.CLI_INVOKE.slice(5)}`], { encoding: 'utf8' });
      expect(r.stdout).toBe(`${join(dir, 'cli.mjs')}|`);
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  test('no shipped module prints `node ${path}` with the path unquoted', () => {
    const offenders = [];
    let quoted = 0;
    for (const f of walkShipped()) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        quoted += (line.match(/node "\$\{|node \$\{shellWord\(/g) || []).length;
        if (/node \$\{(?!shellWord\()/.test(line)) offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
      });
    }
    // Premise: the sweep sees the quoted population (hook registration, the binding hints,
    // CLI_INVOKE, the doctor remedies), so an empty offender list is a reading, not blindness.
    expect(quoted).toBeGreaterThanOrEqual(12);
    expect(offenders).toEqual([]);
  });

  // The template sweep above cannot see string concatenation: pre-ship review of v6.12.1
  // found `'… -- node ' + SERVER_PATH` in install.mjs and a `cd ${root}` remedy in
  // lib/install-shape.mjs, both printed with the path bare.
  const CONCAT_NODE = /'[^']*node '\s*\+|"[^"]*node "\s*\+|`[^`]*node `\s*\+/;
  const BARE_CD = /\bcd \$\{(?!shellWord\()/;
  // Prose that happens to end a fragment on the word "node" — not a command.
  const PROSE = ['The MCP server and the node `'];

  test('the concatenation and `cd` detectors fire on the shapes they exist for', () => {
    expect(CONCAT_NODE.test("warn('Try manually: claude mcp add -- node ' + SERVER_PATH);")).toBe(true);
    expect(CONCAT_NODE.test("warn('Try manually: claude mcp add -- node \"' + SERVER_PATH + '\"');")).toBe(
      false,
    );
    expect(BARE_CD.test('repair: `cd ${root} && npm install --omit=dev`,')).toBe(true);
    expect(BARE_CD.test('repair: `cd "${root}" && npm install --omit=dev`,')).toBe(false);
    expect(BARE_CD.test('repair: `cd ${shellWord(root)} && npm install --omit=dev`,')).toBe(false);
  });

  test('no shipped module prints `node ` + path or `cd ${path}` with the path unquoted', () => {
    const offenders = [];
    for (const f of walkShipped()) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line) || PROSE.some((p) => line.includes(p))) return;
          if (CONCAT_NODE.test(line) || BARE_CD.test(line))
            offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test('cli-path.mjs is registered for shipping (SOURCE_FILES + package.json files)', () => {
    const srcFiles = readFileSync(join(ROOT, 'source-files.mjs'), 'utf8');
    expect(srcFiles).toContain("'cli-path.mjs'");
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('cli-path.mjs');
  });
});

// Deferred D#61 (pre-ship review of v6.12.1, P3-4): the remedies doctor, repair and the DB
// notices print wrapped their paths in DOUBLE quotes. That survives a space and nothing else:
// inside "…" bash still expands `$NAME` and runs a backtick, and a `"` in the path ends the
// quote. For `rm -f "<db>-wal"` / `mv "<db>" …` that is a pasted command acting on a
// DIFFERENT file. shellWord's single-quote form is exact for every byte.
describe('printed remedies keep a hostile path as one exact word (D#61)', () => {
  // A path with every character double quotes fail on: `$HOME` (expands to something
  // non-empty, so the damage is visible), a backtick command, `"`, `'`, a space, a backslash.
  const HOSTILE = 'sp ace$HOME`echo INJECTED`"dq\'sq\\bs';
  // Every verb a remedy starts with is shadowed, so evaluating the printed command only
  // reports the words bash split it into — nothing is removed, moved or installed.
  const PRELUDE = ['node', 'cd', 'rm', 'mv', 'cp', 'npm', 'restart']
    .map((v) => `${v}() { printf '%s\\n' "$@"; }`)
    .join('\n');
  const words = (cmd) => {
    const r = spawnSync('bash', ['-c', `${PRELUDE}\neval "$1"`, '_', cmd], { encoding: 'utf8' });
    return r.stdout.split('\n');
  };
  const withHostileDir = (fn) => {
    const base = mkdtempSync(join(tmpdir(), 'cml-d61-'));
    const dir = join(base, HOSTILE);
    mkdirSync(dir);
    try {
      return fn(dir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };

  test('the harness can say NO: a double-quoted hostile path does not survive', () => {
    withHostileDir((dir) => {
      expect(words(`node "${join(dir, 'cli.mjs')}" repair`)).not.toContain(join(dir, 'cli.mjs'));
      expect(words(`node ${shellWord(join(dir, 'cli.mjs'))} repair`)).toContain(join(dir, 'cli.mjs'));
    });
  });

  test('nativeBindingRepairHint: both the CLI command and the npm fallback', async () => {
    const { nativeBindingRepairHint } = await import('../lib/binding-probe.mjs');
    withHostileDir((dir) => {
      expect(words(nativeBindingRepairHint(dir))).toContain(dir); // no cli.mjs: the npm pair alone
      writeFileSync(join(dir, 'cli.mjs'), '');
      const [cliCmd, fallback] = nativeBindingRepairHint(dir).split('   (or, without the CLI: ');
      expect(words(cliCmd)).toContain(join(dir, 'cli.mjs'));
      expect(words(fallback.replace(/\)$/, ''))).toContain(dir);
    });
  });

  test('dbUnusableRemedy: the set-aside and the restore commands', async () => {
    const { dbUnusableRemedy } = await import('../lib/db-unusable.mjs');
    withHostileDir((dir) => {
      const db = join(dir, 'claude-mem-lite.db');
      writeFileSync(db, '');
      const setAside = dbUnusableRemedy(db);
      expect(setAside.kind).toBe('set-aside');
      expect(words(setAside.command)).toEqual(
        expect.arrayContaining([`${db}-wal`, `${db}-shm`, db, `${db}.corrupt`]),
      );
      const bak = `${db}.2026-09-25T00-00-00Z.bak`;
      writeFileSync(bak, '');
      const restore = dbUnusableRemedy(db);
      expect(restore.kind).toBe('restore');
      expect(words(restore.command)).toEqual(expect.arrayContaining([`${db}-wal`, bak, db]));
    });
  });

  test('hookManifestRepairHint: the cp of the marketplace manifest', async () => {
    const { hookManifestRepairHint } = await import('../install.mjs');
    withHostileDir((dir) => {
      const cache = join(dir, 'cache');
      const mp = join(dir, 'mp');
      mkdirSync(join(mp, 'hooks'), { recursive: true });
      copyFileSync(join(ROOT, 'hooks', 'hooks.json'), join(mp, 'hooks', 'hooks.json'));
      const hint = hookManifestRepairHint(cache, mp);
      expect(hint.startsWith('cp '), hint).toBe(true); // premise: the arm that prints a command
      expect(words(hint)).toEqual(
        expect.arrayContaining([join(mp, 'hooks', 'hooks.json'), join(cache, 'hooks', 'hooks.json')]),
      );
    });
  });

  // The rest print from entry files or from module-location paths a unit test cannot move,
  // so they are held by a sweep: no shell verb in a shipped module may be followed by a
  // double-quoted interpolation. The hook REGISTRATION strings are the exemption — they are
  // written into settings.json and parsed back by `"…"` regexes (hook-prune's
  // launcherEntryPath, install.mjs's collectOrphanHookPaths), so their form is a stored
  // format, not a printed remedy; a format that desyncs from those parsers makes
  // launcherEntryPath resolve a live hook as missing, and hook-prune then deletes it.
  // The paths are `<homedir>/.claude-mem-lite/scripts/*`. Double quotes keep a space, an
  // apostrophe, a drive-letter Windows path and a `$` before `/`, `.`, a space or the end
  // intact. They break on a `$` before a name character, a digit, `{`, `(` or a special
  // parameter (`$$`, `$?`, `$_`, `$-`, …); on a backtick or `"`; and on a backslash before
  // `$`, a backtick, `"` or `\` — so a UNC home `\\srv` loses a backslash (bash-measured
  // 2026-09-25, 19 shapes).
  const VERB_THEN_DQ = /\b(?:node|cd|rm|mv|cp|bash|PATH=)(?:\s[^`]*?)?"(?:\$\{|' \+)/;
  const REGISTRATION = [
    'const nodeHook = (entry, ...args) => `node "${LAUNCHER_PATH}"',
    'command: `bash "${PREFILTER_PATH}"`',
    'command: `bash "${AGENT_PREFILTER_PATH}"`',
    'command: `bash "${BASH_RECALL_PREFILTER_PATH}"`',
  ];

  test('the sweep detector fires on the shapes it exists for', () => {
    expect(VERB_THEN_DQ.test('const clear = `rm -f "${dbPath}-wal"`;')).toBe(true);
    expect(VERB_THEN_DQ.test('command: `${clear} && mv ${shellWord(a)} "${b}"`,')).toBe(true);
    expect(VERB_THEN_DQ.test('`… add it: export PATH="${binDir}:$PATH"`')).toBe(true);
    expect(VERB_THEN_DQ.test(`warn('… -- node "' + SERVER_PATH + '"');`)).toBe(true);
    expect(VERB_THEN_DQ.test('const clear = `rm -f ${shellWord(`${dbPath}-wal`)}`;')).toBe(false);
    expect(VERB_THEN_DQ.test('fail(`[mem] Invalid --type "${type}". Valid: …`);')).toBe(false);
  });

  test('no shipped module prints a shell command with a double-quoted interpolated path', () => {
    const offenders = [];
    const exempted = [];
    for (const f of walkShipped()) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line) || !VERB_THEN_DQ.test(line)) return;
          const at = `${f.slice(ROOT.length + 1)}:${i + 1}`;
          if (REGISTRATION.some((r) => line.includes(r))) exempted.push(at);
          else offenders.push(`${at}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(offenders).toEqual([]);
    // Premise and scope: every exemption is still there, and nothing else rides on it.
    expect(exempted).toHaveLength(REGISTRATION.length);
  });

  // The two launchers may import only node: builtins (they must run on a broken install), so
  // each carries its own copy. A copy that drifts is a quoting rule nobody reviewed.
  test("the launchers' inline shellWord copies match cli-path.mjs", () => {
    const def = (rel) => {
      const m = /const shellWord = (\(s\) => .*);$/m.exec(readFileSync(join(ROOT, rel), 'utf8'));
      expect(m, `${rel}: shellWord definition not found`).toBeTruthy();
      return m[1];
    };
    for (const rel of ['scripts/hook-launcher.mjs', 'scripts/launch.mjs']) {
      expect(def(rel), rel).toBe(def('cli-path.mjs'));
    }
  });
});
