#!/usr/bin/env node
// Repeatable code-metrics snapshot for docs/audit/*.md.
//
//   node scripts/audit-metrics.mjs            # JSON to stdout, reuses coverage/ + runs eslint/knip/prettier
//   node scripts/audit-metrics.mjs --md       # Markdown table instead of JSON
//   node scripts/audit-metrics.mjs --run-tests  # also runs `vitest run --coverage` first (slow, ~1 min)
//   node scripts/audit-metrics.mjs --no-tools   # skip eslint / knip / prettier / coverage (pure static scan)
//   node scripts/audit-metrics.mjs --inventory  # Markdown module table (layer / lines / header / exports) for docs/ARCHITECTURE.md
//   node scripts/audit-metrics.mjs --deps       # Markdown dependency section (layer matrix, upward edges, hubs, mermaid) for docs/ARCHITECTURE.md
//
// Every number is derived from the working tree at run time. Nothing here is a
// baseline to carry forward — re-run the script and diff the output.
//
// Method notes (so a later reader can reproduce or challenge a figure):
//   • "source" scope = root *.mjs + lib/ + cli/ + server/ + scripts/ (*.mjs, *.js, *.sh).
//     tests/ and benchmark/ are reported separately, never mixed into source figures.
//   • Long functions: acorn AST, every FunctionDeclaration / FunctionExpression /
//     ArrowFunctionExpression / method value; length = end line - start line + 1.
//   • Duplicate rate: 6-line sliding window over NORMALISED lines (trimmed, blank and
//     comment-only lines dropped, internal whitespace collapsed). A line is "duplicated"
//     when at least one window containing it occurs ≥2 times in the corpus. Two figures:
//     `any` (repeat may be inside the same file) and `crossFile` (repeat in another file).
//   • Cycles: static `import … from` / `export … from` edges between repo-relative modules,
//     Tarjan SCC; dynamic `import('…')` edges reported separately as `lazy`.
//   • Untested modules: source modules that no file under tests/ imports (static or
//     dynamic specifier resolving to that module). This is a REACHABILITY signal only —
//     a module can be exercised through a subprocess E2E without any import.
//   • Coverage: read from coverage/coverage-summary.json (the mtime is reported so a
//     stale summary is visible); `--run-tests` regenerates it.

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, extname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as acorn from 'acorn';

// Normally the repo this file sits in. `AUDIT_METRICS_REPO` exists so a COPY of this script
// can be run from a temp dir against the real tree — which is how `--self-check` is proven
// able to fail without writing a scratch `.mjs` into `scripts/`, where it would move the
// per-file case count `tests/obs-id-caliber-sync.test.mjs` generates.
const REPO = process.env.AUDIT_METRICS_REPO
  ? resolve(process.env.AUDIT_METRICS_REPO)
  : resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const WANT_MD = args.has('--md');
const WANT_INVENTORY = args.has('--inventory');
const WANT_DEPS = args.has('--deps');
const RUN_TESTS = args.has('--run-tests');
const NO_TOOLS = args.has('--no-tools');

const LONG_FN_LINES = 50;
const DUP_WINDOW = 6;
const TOP_N = 10;

// ── file discovery ─────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  'docs',
  'tasks',
  'tmp',
  '.tmp',
  'managed',
  '.claude',
  '.claude-plugin',
  '.code-graph',
  '.loop',
  '.worktrees',
  'experiment',
  'datasets',
  'results',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const CODE_EXT = new Set(['.mjs', '.js']);
const SOURCE_EXT = new Set(['.mjs', '.js', '.sh']);

// THE module-graph population, in one place (A20260905-R5-P3-2). Four reporters used to
// spell this filter out for themselves and two of them forgot the `*.config.mjs` half, so
// `--deps` printed "161 modules" while `--md` printed "163" for what reads as the same set,
// and `eslint.config.mjs` was listed as a SOURCE MODULE with no test — a lint config that
// can never have one. Build/lint configs are tooling INPUTS: nothing in the shipped tree
// imports them (verified: both carry zero local imports, so excluding them changes no edge,
// only the node count). Doctrine rule 3 — "which rows" is a required field — applies to a
// ruler's own numbers first. `--self-check` requires all three reporters to agree.
const CONFIG_MODULE_RE = /\.config\.mjs$/;
const isGraphModule = (f) => CODE_EXT.has(extname(f)) && !CONFIG_MODULE_RE.test(f);

function rel(p) {
  return relative(REPO, p).split('\\').join('/');
}

function classify(p) {
  const r = rel(p);
  const ext = extname(r);
  if (r.startsWith('tests/')) return CODE_EXT.has(ext) ? 'tests' : null;
  if (r.startsWith('benchmark/')) return ext === '.mjs' ? 'benchmark' : null;
  if (!SOURCE_EXT.has(ext)) return null;
  if (!r.includes('/')) return 'source';
  if (/^(lib|cli|server|scripts)\//.test(r)) return 'source';
  return null;
}

const files = { source: [], tests: [], benchmark: [] };
for (const f of walk(REPO)) {
  const c = classify(f);
  if (c) files[c].push(f);
}
for (const k of Object.keys(files)) files[k].sort();

function countLines(text) {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.endsWith('\n')) n--;
  return n;
}

const textOf = new Map();
function read(p) {
  if (!textOf.has(p)) textOf.set(p, readFileSync(p, 'utf8'));
  return textOf.get(p);
}

function scopeStats(list) {
  let lines = 0;
  const perFile = [];
  for (const f of list) {
    const n = countLines(read(f));
    lines += n;
    perFile.push({ file: rel(f), lines: n });
  }
  perFile.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  return { files: list.length, lines, largest: perFile.slice(0, TOP_N) };
}

// ── long functions (acorn) ─────────────────────────────────────────────────────

function parse(src, file) {
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true };
  try {
    return acorn.parse(src, { ...opts, sourceType: 'module' });
  } catch (e1) {
    try {
      return acorn.parse(src, { ...opts, sourceType: 'script' });
    } catch {
      return { error: `${file}: ${e1.message}` };
    }
  }
}

function fnName(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if (parent?.type === 'Property' && parent.key) return parent.key.name || String(parent.key.value);
  if (parent?.type === 'MethodDefinition' && parent.key) return parent.key.name || String(parent.key.value);
  if (parent?.type === 'AssignmentExpression' && parent.left?.type === 'Identifier') return parent.left.name;
  if (parent?.type === 'CallExpression') return '(callback)';
  return '(anonymous)';
}

function walkAst(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'parent') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walkAst(c, visit, node);
    } else if (v && typeof v.type === 'string') walkAst(v, visit, node);
  }
}

const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function longFunctions(list) {
  const all = [];
  const parseErrors = [];
  for (const f of list) {
    if (!CODE_EXT.has(extname(f))) continue;
    const ast = parse(read(f), rel(f));
    if (ast.error) {
      parseErrors.push(ast.error);
      continue;
    }
    walkAst(ast, (node, parent) => {
      if (!FN_TYPES.has(node.type)) return;
      const len = node.loc.end.line - node.loc.start.line + 1;
      all.push({ file: rel(f), line: node.loc.start.line, name: fnName(node, parent), lines: len });
    });
  }
  all.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file) || a.line - b.line);
  const over = all.filter((x) => x.lines > LONG_FN_LINES);
  return {
    total: all.length,
    over: over.length,
    threshold: LONG_FN_LINES,
    longest: all.slice(0, TOP_N),
    parseErrors,
  };
}

// ── duplicate windows ──────────────────────────────────────────────────────────

function normalisedLines(src, ext) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '') continue;
    if (ext === '.sh') {
      if (line.startsWith('#')) continue;
    } else {
      if (line.startsWith('//') || line.startsWith('*')) continue;
      if (line.startsWith('/*')) {
        if (!line.includes('*/')) inBlock = true;
        continue;
      }
    }
    line = line.replace(/\s+/g, ' ');
    out.push(line);
  }
  return out;
}

function duplicateRate(list) {
  const windows = new Map(); // hash → [{fileIdx, start}]
  const perFile = [];
  let totalLines = 0;
  list.forEach((f, idx) => {
    const lines = normalisedLines(read(f), extname(f));
    perFile.push(lines);
    totalLines += lines.length;
    for (let i = 0; i + DUP_WINDOW <= lines.length; i++) {
      const key = lines.slice(i, i + DUP_WINDOW).join('\n');
      let arr = windows.get(key);
      if (!arr) {
        arr = [];
        windows.set(key, arr);
      }
      arr.push({ idx, start: i });
    }
  });
  const dupAny = perFile.map((l) => new Uint8Array(l.length));
  const dupCross = perFile.map((l) => new Uint8Array(l.length));
  let dupWindowGroups = 0;
  for (const occ of windows.values()) {
    if (occ.length < 2) continue;
    dupWindowGroups++;
    const fileSet = new Set(occ.map((o) => o.idx));
    for (const o of occ) {
      for (let k = 0; k < DUP_WINDOW; k++) {
        dupAny[o.idx][o.start + k] = 1;
        if (fileSet.size > 1) dupCross[o.idx][o.start + k] = 1;
      }
    }
  }
  const sum = (arrs) => arrs.reduce((acc, a) => acc + a.reduce((x, y) => x + y, 0), 0);
  const anyLines = sum(dupAny);
  const crossLines = sum(dupCross);
  const pct = (n) => (totalLines ? +((100 * n) / totalLines).toFixed(2) : 0);
  return {
    window: DUP_WINDOW,
    normalisedLines: totalLines,
    duplicatedWindowGroups: dupWindowGroups,
    any: { lines: anyLines, pct: pct(anyLines) },
    crossFile: { lines: crossLines, pct: pct(crossLines) },
  };
}

// ── import graph + cycles ──────────────────────────────────────────────────────

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  let target = resolve(dirname(fromFile), spec);
  if (!existsSync(target)) {
    for (const ext of ['.mjs', '.js'])
      if (existsSync(target + ext)) {
        target = target + ext;
        break;
      }
  }
  if (!existsSync(target)) return null;
  try {
    if (statSync(target).isDirectory()) return null;
  } catch {
    return null;
  }
  return target;
}

// Audit 2026-09-05 P2-9: this used to run the three regexes over RAW source, so a
// commented-out import counted as a dependency — `lib/save-enrich.mjs:175` says in prose
// that it no longer does `await import('../hook-optimize.mjs')`, and the ruler read that
// sentence as a live lazy edge into the hook layer. The guard test that enforces the same
// rule strips comment lines first, so the two disagreed about the same file, and the
// over-reported edges fed `cycles()` — where a comment is enough to mint a cycle nobody
// wrote. The AST cannot make that mistake: comments and string literals are not nodes.
//
// The regexes stay as the FALLBACK for a file acorn refuses. Returning no edges there
// would be the worse failure: a silently edge-less module cannot participate in a cycle,
// so a parse error would read as a clean graph.
function edgesFromAst(ast, f, stat, lazy) {
  walkAst(ast, (n) => {
    const src = n.source;
    const isStatic =
      n.type === 'ImportDeclaration' ||
      n.type === 'ExportNamedDeclaration' ||
      n.type === 'ExportAllDeclaration';
    if (isStatic && src?.type === 'Literal' && typeof src.value === 'string') {
      const t = resolveSpec(f, src.value);
      if (t) stat.add(t);
    } else if (n.type === 'ImportExpression' && src?.type === 'Literal' && typeof src.value === 'string') {
      // A non-literal specifier (`import(someVar)`) is unresolvable by any method and is
      // skipped here exactly as the regex skipped it.
      const t = resolveSpec(f, src.value);
      if (t) lazy.add(t);
    }
  });
}

function edgesFromRegex(src, f, stat, lazy) {
  for (const re of [STATIC_IMPORT, BARE_IMPORT]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const t = resolveSpec(f, m[1]);
      if (t) stat.add(t);
    }
  }
  DYNAMIC_IMPORT.lastIndex = 0;
  let m;
  while ((m = DYNAMIC_IMPORT.exec(src))) {
    const t = resolveSpec(f, m[1]);
    if (t) lazy.add(t);
  }
}

// Files whose edges came from the regex fallback rather than the AST. Reported so a
// parse failure is visible in §3 instead of quietly degrading the graph.
const unparsedEdgeFiles = [];

function edgesOf(f) {
  const src = read(f);
  const stat = new Set();
  const lazy = new Set();
  const ast = parse(src, rel(f));
  if (ast.error) {
    if (!unparsedEdgeFiles.includes(rel(f))) unparsedEdgeFiles.push(rel(f));
    edgesFromRegex(src, f, stat, lazy);
  } else {
    edgesFromAst(ast, f, stat, lazy);
  }
  return { stat, lazy };
}

function tarjan(nodes, adj) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  function strong(v) {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  }
  for (const v of nodes) if (!idx.has(v)) strong(v);
  return sccs;
}

function cycles(list) {
  const nodes = list.filter(isGraphModule);
  const staticAdj = new Map();
  const fullAdj = new Map();
  let staticEdges = 0;
  let lazyEdges = 0;
  for (const f of nodes) {
    const { stat, lazy } = edgesOf(f);
    staticAdj.set(f, [...stat]);
    staticEdges += stat.size;
    fullAdj.set(f, [...new Set([...stat, ...lazy])]);
    lazyEdges += lazy.size;
  }
  const self = (adj) => nodes.filter((f) => (adj.get(f) || []).includes(f)).map(rel);
  const comps = (adj) =>
    tarjan(nodes, adj)
      .filter((c) => c.length > 1)
      .map((c) => c.map(rel).sort());
  const staticCycles = comps(staticAdj);
  const fullCycles = comps(fullAdj);
  return {
    modules: nodes.length,
    staticEdges,
    lazyEdges,
    static: {
      count: staticCycles.length + self(staticAdj).length,
      components: staticCycles,
      selfLoops: self(staticAdj),
    },
    includingLazy: {
      count: fullCycles.length + self(fullAdj).length,
      components: fullCycles,
      selfLoops: self(fullAdj),
    },
  };
}

// ── test reachability ──────────────────────────────────────────────────────────

function untestedModules(sourceList, testList) {
  const imported = new Set();
  for (const t of testList) {
    const { stat, lazy } = edgesOf(t);
    for (const x of stat) imported.add(x);
    for (const x of lazy) imported.add(x);
  }
  // Transitive closure through source modules: a module imported by a tested module is
  // still only "indirectly reached"; report DIRECT-import gaps, which is what "has a test" means.
  const sources = sourceList.filter(isGraphModule);
  const direct = sources.filter((f) => !imported.has(f)).map(rel);
  // Also flag those whose basename is never even mentioned in tests (subprocess E2E often
  // spawns by path string rather than importing).
  const testText = testList.map(read).join('\n');
  const neverMentioned = direct.filter((r) => !testText.includes(r.split('/').pop()));
  return { sourceModules: sources.length, notDirectlyImported: direct, notMentionedAtAll: neverMentioned };
}

// ── external tools ─────────────────────────────────────────────────────────────

function bin(name) {
  return join(REPO, 'node_modules', '.bin', name);
}

function runJson(cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { error: String(r.error) };
  try {
    return { data: JSON.parse(r.stdout), status: r.status };
  } catch (e) {
    return { error: `${cmd}: non-JSON output (${e.message}); stderr: ${(r.stderr || '').slice(0, 300)}` };
  }
}

function eslintCount() {
  const r = runJson(bin('eslint'), ['.', '-f', 'json']);
  if (r.error) return { error: r.error };
  let errors = 0;
  let warnings = 0;
  for (const f of r.data) {
    errors += f.errorCount;
    warnings += f.warningCount;
  }
  return { files: r.data.length, errors, warnings };
}

function knipCount() {
  const r = runJson(bin('knip'), ['--reporter', 'json']);
  if (r.error) return { error: r.error };
  const issues = r.data.issues || [];
  // `files` is ALWAYS an array on every issue object (CLAUDE.md knip rule 4): count elements.
  const unusedFiles = issues.flatMap((i) => i.files || []).length;
  const unusedExports = issues.flatMap((i) => (i.exports || []).map((e) => `${i.file}:${e.name}`)).length;
  return { unusedExports, unusedFiles };
}

function prettierCheck() {
  if (!existsSync(bin('prettier'))) return { error: 'prettier not installed' };
  const r = spawnSync(bin('prettier'), ['--check', '**/*.{mjs,js}'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { error: String(r.error) };
  const unformatted = (r.stderr + r.stdout)
    .split('\n')
    .filter((l) => /^\[warn\] .+\.(mjs|js)$/.test(l)).length;
  return { unformatted, status: r.status };
}

// Tail kept when a run goes red. 200 lines covers vitest's summary block plus the
// last failure's diff; the FAIL names are extracted separately so the number and the
// name reach the report together.
const VITEST_FAIL_TAIL_LINES = 200;

function runVitestCoverage() {
  const r = spawnSync(
    bin('vitest'),
    ['run', '--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=text'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const out = (r.stdout || '') + (r.stderr || '');
  const tf =
    /Test Files\s+(\d+) passed(?: \| (\d+) failed)?/.exec(out) ||
    /Test Files\s+(\d+) failed \| (\d+) passed/.exec(out);
  const tc =
    /Tests\s+(\d+) passed(?: \| (\d+) failed)?/.exec(out) || /Tests\s+(\d+) failed \| (\d+) passed/.exec(out);
  const dur = /Duration\s+([\d.]+s)/.exec(out);
  const res = {
    status: r.status,
    testFiles: tf ? tf[0].replace(/\s+/g, ' ') : 'unparsed',
    tests: tc ? tc[0].replace(/\s+/g, ' ') : 'unparsed',
    duration: dur ? dur[1] : null,
  };
  // Audit 2026-09-05 P2-7: everything but the summary regex used to be dropped, so a
  // red run reported "1 failed" and the NAME was unrecoverable — which is why that
  // round's single failure (P2-8) could not be attributed or reproduced. A count is a
  // smoke alarm; the name is the evidence.
  if (r.status !== 0) {
    res.failed = [...out.matchAll(/^\s*FAIL\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
    try {
      const dir = join(REPO, 'tmp');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const log = join(dir, `audit-vitest-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      writeFileSync(log, out.split('\n').slice(-VITEST_FAIL_TAIL_LINES).join('\n'));
      res.log = relative(REPO, log);
    } catch (e) {
      res.log = `unwritable: ${e.message}`;
    }
  }
  return res;
}

function coverageSummary() {
  const p = join(REPO, 'coverage', 'coverage-summary.json');
  if (!existsSync(p))
    return {
      error:
        'coverage/coverage-summary.json missing — run with --run-tests or `npm run test:coverage -- --coverage.reporter=json-summary`',
    };
  const t = JSON.parse(readFileSync(p, 'utf8')).total;
  const pick = (k) => ({ pct: t[k].pct, covered: t[k].covered, total: t[k].total });
  return {
    generatedAt: statSync(p).mtime.toISOString(),
    statements: pick('statements'),
    branches: pick('branches'),
    functions: pick('functions'),
    lines: pick('lines'),
  };
}

function gitHead() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: null };
  }
}

// ── module inventory (docs/ARCHITECTURE.md §4) ────────────────────────────────

function layerOf(r) {
  if (/^scripts\/(hook-launcher\.mjs|launch(-preflight)?\.mjs)$/.test(r) || /^scripts\/.*\.js$/.test(r))
    return 'entry';
  if (['cli.mjs', 'hook.mjs', 'server.mjs', 'install.mjs'].includes(r)) return 'entry';
  if (r.startsWith('scripts/')) return 'tooling';
  if (/^(mem-cli\.mjs|cli\/|server\/|adopt-cli\.mjs)/.test(r)) return 'face';
  if (r.startsWith('lib/')) return 'lib';
  if (
    /^(hook-|search-|scoring-sql|deep-search|rerank|registry|resource-discovery|haiku-client|memdir|claudemd|adopt-content|install-metadata|plugin-cache-guard|tool-schemas|schema\.mjs)/.test(
      r,
    )
  )
    return 'engine';
  return 'leaf';
}

const LAYER_TITLES = {
  entry: 'Entry points',
  face: 'Faces (arg parsing + rendering)',
  engine: 'Engines (root modules)',
  lib: 'Shared cores (lib/)',
  leaf: 'Leaf utilities (root)',
  tooling: 'Dev / CI tooling (scripts/)',
};

function exportsOf(ast) {
  const out = [];
  for (const n of ast.body || []) {
    if (n.type === 'ExportNamedDeclaration') {
      if (n.declaration) {
        if (n.declaration.type === 'VariableDeclaration')
          for (const d of n.declaration.declarations) out.push(d.id.name || '(pattern)');
        else
          out.push(
            (n.declaration.id?.name || '?') + (n.declaration.type === 'FunctionDeclaration' ? '()' : ''),
          );
      } else
        for (const s of n.specifiers) out.push((s.exported.name || s.exported.value) + (n.source ? '*' : ''));
    } else if (n.type === 'ExportDefaultDeclaration') out.push('default');
  }
  return out;
}

function headerOf(src) {
  const h = src
    .split('\n')
    .slice(0, 12)
    .filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/^\s*(\/\/|\/\*+|\*+\/?)\s?/, ''))
    .join(' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/^claude-mem-lite:?\s*/i, '')
    .replace(/^([\w./-]+\.m?js)\s*[—–-]+\s*/, '')
    .trim();
  if (!h) return '(no header comment)';
  const cut = h.slice(0, 150);
  return cut.length < h.length ? cut.replace(/\s\S*$/, '') + '…' : cut;
}

function inventoryMd(list) {
  const rows = [];
  for (const f of list) {
    if (!isGraphModule(f)) continue;
    const src = read(f);
    const ast = parse(src, rel(f));
    const exps = ast.error ? ['(parse error)'] : exportsOf(ast);
    const shown = exps.length
      ? exps.length > 7
        ? `${exps.slice(0, 7).join(', ')} … (+${exps.length - 7})`
        : exps.join(', ')
      : '(entry — no exports)';
    rows.push({
      layer: layerOf(rel(f)),
      file: rel(f),
      lines: countLines(src),
      header: headerOf(src),
      exports: shown,
    });
  }
  const L = [];
  for (const layer of ['entry', 'face', 'engine', 'lib', 'leaf', 'tooling']) {
    L.push(
      '',
      `### ${LAYER_TITLES[layer]}`,
      '',
      '| Module | Lines | Responsibility | Public interface (exports; `*` = re-export) |',
      '|---|---|---|---|',
    );
    for (const r of rows.filter((x) => x.layer === layer).sort((a, b) => a.file.localeCompare(b.file))) {
      L.push(`| \`${r.file}\` | ${r.lines} | ${r.header} | ${r.exports} |`);
    }
  }
  return L.join('\n') + '\n';
}

if (WANT_INVENTORY) {
  process.stdout.write(inventoryMd(files.source));
  process.exit(0);
}

// ── dependency section (docs/ARCHITECTURE.md §3) ─────────────────────────────
//
// Same edge extraction as `cycles()`; aggregated by `layerOf` so the doc can state the
// dependency DIRECTION as a measured table rather than a diagram someone drew once. The
// "upward" list is the evidence for any layering claim: an edge from a lower layer into a
// higher one. `tooling` is excluded from that list (dev scripts may import anything) and
// `lib -> engine` is reported on its own line because CLAUDE.md sanctions it (shared
// cores call the engines they front), so it is a fact to record, not a violation.

const LAYER_ORDER = ['entry', 'face', 'engine', 'lib', 'leaf', 'tooling'];

function depsMd(list) {
  const nodes = list.filter(isGraphModule);
  const edges = [];
  for (const f of nodes) {
    const { stat, lazy } = edgesOf(f);
    for (const t of stat) edges.push({ from: rel(f), to: rel(t), kind: 'static' });
    for (const t of lazy) edges.push({ from: rel(f), to: rel(t), kind: 'lazy' });
  }
  const matrix = {};
  const fanIn = new Map();
  const fanOut = new Map();
  for (const e of edges) {
    const key = `${layerOf(e.from)}→${layerOf(e.to)}`;
    matrix[key] = (matrix[key] || 0) + 1;
    fanIn.set(e.to, (fanIn.get(e.to) || 0) + 1);
    fanOut.set(e.from, (fanOut.get(e.from) || 0) + 1);
  }
  const rank = (l) => LAYER_ORDER.indexOf(l);
  const upward = edges.filter(
    (e) => layerOf(e.from) !== 'tooling' && rank(layerOf(e.from)) > rank(layerOf(e.to)),
  );
  const libToEngine = upward.filter((e) => layerOf(e.from) === 'lib' && layerOf(e.to) === 'engine');
  const leafUp = upward.filter((e) => layerOf(e.from) === 'leaf');

  const L = [];
  L.push(
    `Modules: ${nodes.length} · edges: ${edges.filter((e) => e.kind === 'static').length} static + ${edges.filter((e) => e.kind === 'lazy').length} lazy (relative \`import\`/\`export … from\` + literal \`import()\`, read from the AST — comments and string literals are not edges).`,
  );
  if (unparsedEdgeFiles.length) {
    L.push('');
    L.push(
      `> **${unparsedEdgeFiles.length} file(s) fell back to regex edge extraction** (acorn could not parse them), so their edges may include commented-out imports: ${unparsedEdgeFiles.map((r) => `\`${r}\``).join(', ')}.`,
    );
  }
  L.push('');
  L.push('### Layer matrix (rows import columns; count of edges)');
  L.push('');
  L.push(`| from \\ to | ${LAYER_ORDER.join(' | ')} |`);
  L.push(`|---|${LAYER_ORDER.map(() => '---').join('|')}|`);
  for (const a of LAYER_ORDER)
    L.push(`| **${a}** | ${LAYER_ORDER.map((b) => matrix[`${a}→${b}`] || 0).join(' | ')} |`);
  L.push('');
  L.push(`### Upward edges (lower layer importing a higher one; tooling excluded): ${upward.length}`);
  L.push('');
  L.push(`- lib → engine: ${libToEngine.length} (sanctioned — shared cores front the engines)`);
  for (const e of libToEngine) L.push(`  - \`${e.from}\` → \`${e.to}\`${e.kind === 'lazy' ? ' (lazy)' : ''}`);
  L.push(`- leaf → lib / engine: ${leafUp.length}`);
  for (const e of leafUp) L.push(`  - \`${e.from}\` → \`${e.to}\`${e.kind === 'lazy' ? ' (lazy)' : ''}`);
  const other = upward.filter((e) => !libToEngine.includes(e) && !leafUp.includes(e));
  L.push(`- other: ${other.length}`);
  for (const e of other) L.push(`  - \`${e.from}\` → \`${e.to}\`${e.kind === 'lazy' ? ' (lazy)' : ''}`);
  L.push('');
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  L.push('### Hubs');
  L.push('');
  L.push('| Most imported (fan-in) | edges | Most importing (fan-out) | edges |');
  L.push('|---|---|---|---|');
  const fi = top(fanIn);
  const fo = top(fanOut);
  for (let i = 0; i < 12; i++)
    L.push(
      `| \`${fi[i]?.[0] ?? ''}\` | ${fi[i]?.[1] ?? ''} | \`${fo[i]?.[0] ?? ''}\` | ${fo[i]?.[1] ?? ''} |`,
    );
  L.push('');
  L.push(
    '### Entry → module graph (mermaid; static edges from entry/face files into engine-layer modules, lib/ and leaves collapsed)',
  );
  L.push('');
  L.push('```mermaid');
  L.push('graph LR');
  const id = (r) => r.replace(/[^A-Za-z0-9]/g, '_');
  const shown = new Set();
  const node = (r) => {
    const l = layerOf(r);
    const label = l === 'lib' ? 'lib/ (shared cores)' : l === 'leaf' ? 'leaf utilities' : r;
    const k = l === 'lib' ? 'LIB' : l === 'leaf' ? 'LEAF' : id(r);
    if (!shown.has(k)) {
      shown.add(k);
      L.push(`  ${k}["${label}"]`);
    }
    return k;
  };
  const seen = new Set();
  for (const e of edges) {
    const lf = layerOf(e.from);
    const lt = layerOf(e.to);
    if (!['entry', 'face'].includes(lf) || lt === 'tooling') continue;
    if (lt === 'leaf') continue;
    const a = node(e.from);
    const b = node(e.to);
    const key = `${a}>${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    L.push(`  ${a} ${e.kind === 'lazy' ? '-.->' : '-->'} ${b}`);
  }
  L.push('```');
  return L.join('\n') + '\n';
}

if (WANT_DEPS) {
  process.stdout.write(depsMd(files.source));
  process.exit(0);
}

// ── self-check ─────────────────────────────────────────────────────────────────
//
// This file is a RULER: `docs/audit/*.md` quotes its duplicate rate, its long-function
// counts and its cycle counts as measurements. This repo's standing rule for a ruler is
// that it must carry a check able to FAIL rather than a promise that it works — the failure
// mode being guarded is not a crash but a plausible WRONG NUMBER, and the specific shape
// already recorded here is a detector that silently returns empty (the `grep` that returned
// 0 self-checks and produced an undercount, CLAUDE.md's knip rule 3).
//
// Each check is written so that breaking the thing it measures makes it throw.
// `tests/audit-metrics-selfcheck.test.mjs` drives this mode and asserts it exits 0, and
// asserts the harness can go non-zero.
if (args.has('--self-check')) {
  const fail = (msg) => {
    process.stderr.write(`SELF-CHECK FAILED: ${msg}\n`);
    process.exit(1);
  };

  // 1. The file walk found a plausible corpus. A walk returning [] makes every figure
  //    below it read as a clean, tiny, well-factored repo.
  if (files.source.length < 60) fail(`source walk found ${files.source.length} files, expected >= 60`);
  if (files.tests.length < 60) fail(`test walk found ${files.tests.length} files, expected >= 60`);

  // 2. The duplicate detector can say YES and NO. Real files on disk, because
  //    duplicateRate reads them itself. Without the NO arm a detector that flags
  //    everything scores 100% and reads as a catastrophic finding; without the YES arm one
  //    that flags nothing scores 0% and reads as a clean tree — and 0% is the answer that
  //    gets believed.
  const probeDir = mkdtempSync(join(tmpdir(), 'audit-metrics-selfcheck-'));
  try {
    const body = Array.from({ length: DUP_WINDOW + 2 }, (_, i) => `const dupProbe${i} = ${i} + 1;`).join(
      '\n',
    );
    const uniqA = Array.from({ length: DUP_WINDOW + 2 }, (_, i) => `const onlyA${i} = ${i} * 2;`).join('\n');
    const uniqB = Array.from({ length: DUP_WINDOW + 2 }, (_, i) => `const onlyB${i} = ${i} * 3;`).join('\n');
    const dupA = join(probeDir, 'dup-a.mjs');
    const dupB = join(probeDir, 'dup-b.mjs');
    const uA = join(probeDir, 'uniq-a.mjs');
    const uB = join(probeDir, 'uniq-b.mjs');
    writeFileSync(dupA, body);
    writeFileSync(dupB, body);
    writeFileSync(uA, uniqA);
    writeFileSync(uB, uniqB);

    const yes = duplicateRate([dupA, dupB]);
    if (yes.crossFile.lines === 0) fail('duplicateRate reported 0 cross-file lines on two identical files');
    const no = duplicateRate([uA, uB]);
    if (no.crossFile.lines !== 0)
      fail(`duplicateRate reported ${no.crossFile.lines} cross-file lines on two files sharing nothing`);

    // 3. The long-function detector can say YES and NO, and reports parse errors rather
    //    than swallowing them — a file that fails to parse is silently zero functions.
    const longFile = join(probeDir, 'long.mjs');
    // Distinct names per line: `const x` repeated is a redeclaration, which acorn REJECTS.
    // The first cut of this probe did that, `parse` returned {error}, the function was never
    // counted and the check reported "longFunctions did not flag a function over the
    // threshold" — a probe defect wearing a detector defect's message.
    const longBody = Array.from({ length: LONG_FN_LINES + 5 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    writeFileSync(longFile, `function tooLong() {\n${longBody}\n}\n`);
    const shortFile = join(probeDir, 'short.mjs');
    writeFileSync(shortFile, 'function tiny() { return 1; }\n');
    if (longFunctions([longFile]).over !== 1)
      fail('longFunctions did not flag a function over the threshold');
    if (longFunctions([shortFile]).over !== 0) fail('longFunctions flagged a one-line function');
    const badFile = join(probeDir, 'bad.mjs');
    writeFileSync(badFile, 'function ( { unparseable\n');
    if (longFunctions([badFile]).parseErrors.length !== 1)
      fail('longFunctions swallowed a parse error instead of reporting it');

    // 4. The edge extractor can say YES and NO (audit 2026-09-05 P2-9). It read raw source
    //    with three regexes, so a commented-out `import()` counted as a dependency —
    //    over-reporting §3's graph and feeding cycles(), where a comment is enough to mint a
    //    cycle nobody wrote. The NO arm is the one that regressed; the YES arms are what
    //    stop a "fix" that simply stops finding imports, which would read as a clean DAG.
    //    The probe specifier is assembled from TGT rather than written inline, because
    //    `tests/import-graph.test.mjs` scans THIS file's text with the same kind of regex
    //    this check exists to retire, and a literal './edge-target.mjs' here reads to it as
    //    an unresolvable import OF audit-metrics.mjs. That second home of the defect is
    //    filed as P2-10 rather than fixed here.
    const TGT = './edge-target.mjs';
    const edgeTarget = join(probeDir, 'edge-target.mjs');
    writeFileSync(edgeTarget, 'export const t = 1;\n');
    const edgeReal = join(probeDir, 'edge-real.mjs');
    writeFileSync(
      edgeReal,
      `import { t } from '${TGT}';\nconst p = await import('${TGT}');\nexport { t, p };\n`,
    );
    const realEdges = edgesOf(edgeReal);
    if (!realEdges.stat.has(edgeTarget)) fail('edgesOf missed a real static import');
    if (!realEdges.lazy.has(edgeTarget)) fail('edgesOf missed a real dynamic import');
    const edgeCommented = join(probeDir, 'edge-commented.mjs');
    writeFileSync(
      edgeCommented,
      `// This used to \`await import('${TGT}')\` and no longer does.\n/* import { t } from '${TGT}'; */\nexport const q = 2;\n`,
    );
    const commentedEdges = edgesOf(edgeCommented);
    if (commentedEdges.stat.size !== 0 || commentedEdges.lazy.size !== 0) {
      fail(
        `edgesOf counted a commented-out import as an edge (${commentedEdges.stat.size} static, ${commentedEdges.lazy.size} lazy)`,
      );
    }
    // A specifier inside a real string literal is not an import either.
    const edgeString = join(probeDir, 'edge-string.mjs');
    writeFileSync(edgeString, `export const msg = "run import('${TGT}') yourself";\n`);
    if (edgesOf(edgeString).lazy.size !== 0) fail('edgesOf counted a string literal as a dynamic import');

    // 5. Every reporter that quotes a MODULE COUNT quotes the SAME population
    //    (A20260905-R5-P3-2). It did not hold: depsMd() filtered *.config.mjs out of the
    //    graph while cycles() and untestedModules() did not, so `--deps` printed 161 and
    //    `--md` printed 163 for what a reader takes to be one set, and eslint.config.mjs
    //    appeared in "source modules with no test". A count nobody can attach a population
    //    to is doctrine rule 3's failure mode, and this is the ruler's own output.
    //
    //    Both arms first: a predicate that admits everything, or nothing, would make the
    //    three-way agreement below pass vacuously.
    if (isGraphModule(join(probeDir, 'plain.mjs')) !== true)
      fail('isGraphModule rejected a plain .mjs module');
    if (isGraphModule(join(probeDir, 'x.config.mjs')) !== false)
      fail('isGraphModule admitted a *.config.mjs into the module graph');
    if (isGraphModule(join(probeDir, 'notes.md')) !== false)
      fail('isGraphModule admitted a non-code file into the module graph');

    //    Then the agreement itself, read back out of each reporter's real output rather
    //    than from the shared predicate — that is what catches a future reporter quietly
    //    re-implementing the filter inline, which is exactly how the two drifted apart.
    const cyclePop = cycles(files.source).modules;
    const reachPop = untestedModules(files.source, files.tests).sourceModules;
    const depsPop = Number(/^Modules: (\d+) /m.exec(depsMd(files.source))?.[1]);
    if (!Number.isInteger(depsPop)) fail('could not read a module count out of depsMd() output');
    if (cyclePop !== reachPop || reachPop !== depsPop)
      fail(`module populations disagree: cycles=${cyclePop}, testReachability=${reachPop}, deps=${depsPop}`);
  } finally {
    try {
      rmSync(probeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  process.stdout.write('audit-metrics self-check: OK\n');
  process.exit(0);
}

// ── assemble ───────────────────────────────────────────────────────────────────

const result = {
  generatedAt: new Date().toISOString(),
  git: gitHead(),
  version: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version,
  scopes: {
    source: scopeStats(files.source),
    tests: scopeStats(files.tests),
    benchmark: scopeStats(files.benchmark),
  },
  longFunctions: longFunctions(files.source),
  duplicates: duplicateRate(files.source),
  cycles: cycles(files.source),
  testReachability: untestedModules(files.source, files.tests),
};

if (!NO_TOOLS) {
  if (RUN_TESTS) result.vitest = runVitestCoverage();
  result.coverage = coverageSummary();
  result.eslint = eslintCount();
  result.knip = knipCount();
  result.prettier = prettierCheck();
}

// ── output ─────────────────────────────────────────────────────────────────────

function md(r) {
  const L = [];
  const s = r.scopes;
  L.push(`# Code metrics — ${r.generatedAt}`);
  L.push('');
  L.push(`Tree: v${r.version} @ ${r.git.sha}${r.git.dirty ? ' (dirty)' : ' (clean)'}`);
  L.push('');
  L.push('| Metric | Value |');
  L.push('|---|---|');
  L.push(`| Source files / lines (root+lib+cli+server+scripts) | ${s.source.files} / ${s.source.lines} |`);
  L.push(`| Test files / lines | ${s.tests.files} / ${s.tests.lines} |`);
  L.push(`| Benchmark files / lines | ${s.benchmark.files} / ${s.benchmark.lines} |`);
  L.push(
    `| Functions > ${r.longFunctions.threshold} lines (of ${r.longFunctions.total}) | ${r.longFunctions.over} |`,
  );
  L.push(
    `| Duplicate rate, ${r.duplicates.window}-line window (any / cross-file) | ${r.duplicates.any.pct}% (${r.duplicates.any.lines}/${r.duplicates.normalisedLines}) / ${r.duplicates.crossFile.pct}% (${r.duplicates.crossFile.lines}) |`,
  );
  L.push(
    `| Import cycles static / incl. lazy (${r.cycles.modules} modules, ${r.cycles.staticEdges} static + ${r.cycles.lazyEdges} lazy edges) | ${r.cycles.static.count} / ${r.cycles.includingLazy.count} |`,
  );
  L.push(
    `| Source modules not directly imported by any test / not mentioned at all | ${r.testReachability.notDirectlyImported.length} / ${r.testReachability.notMentionedAtAll.length} (of ${r.testReachability.sourceModules}) |`,
  );
  if (r.vitest) {
    const fail =
      r.vitest.status === 0
        ? ''
        : ` — **failed: ${r.vitest.failed?.length ? r.vitest.failed.join(', ') : 'no FAIL line parsed'}**; output tail: \`${r.vitest.log}\``;
    L.push(
      `| vitest | ${r.vitest.testFiles}; ${r.vitest.tests}; ${r.vitest.duration} (exit ${r.vitest.status})${fail} |`,
    );
  }
  if (r.coverage) {
    if (r.coverage.error) L.push(`| Coverage | ${r.coverage.error} |`);
    else
      L.push(
        `| Coverage stmts / branches / functions / lines (summary ${r.coverage.generatedAt}) | ${r.coverage.statements.pct} / ${r.coverage.branches.pct} / ${r.coverage.functions.pct} / ${r.coverage.lines.pct} |`,
      );
  }
  if (r.eslint)
    L.push(
      `| eslint errors / warnings | ${r.eslint.error ?? `${r.eslint.errors} / ${r.eslint.warnings} (${r.eslint.files} files)`} |`,
    );
  if (r.knip)
    L.push(
      `| knip unused exports / files | ${r.knip.error ?? `${r.knip.unusedExports} / ${r.knip.unusedFiles}`} |`,
    );
  if (r.prettier)
    L.push(`| prettier --check unformatted files | ${r.prettier.error ?? r.prettier.unformatted} |`);
  L.push('');
  L.push(`## Largest ${TOP_N} source files`);
  L.push('');
  L.push('| File | Lines |');
  L.push('|---|---|');
  for (const f of s.source.largest) L.push(`| ${f.file} | ${f.lines} |`);
  L.push('');
  L.push(`## Longest ${TOP_N} functions`);
  L.push('');
  L.push('| Function | Lines |');
  L.push('|---|---|');
  for (const f of r.longFunctions.longest) L.push(`| ${f.file}:${f.line} ${f.name} | ${f.lines} |`);
  if (r.longFunctions.parseErrors.length) {
    L.push('');
    L.push(`Parse errors: ${r.longFunctions.parseErrors.join('; ')}`);
  }
  if (r.cycles.static.count || r.cycles.includingLazy.count) {
    L.push('');
    L.push('## Cycles');
    L.push('');
    for (const c of r.cycles.includingLazy.components) L.push(`- ${c.join(' → ')}`);
    for (const c of r.cycles.includingLazy.selfLoops) L.push(`- self-loop: ${c}`);
  }
  L.push('');
  L.push('## Source modules not directly imported by any test');
  L.push('');
  for (const m of r.testReachability.notDirectlyImported) {
    L.push(
      `- ${m}${r.testReachability.notMentionedAtAll.includes(m) ? '  (basename never appears in tests/ either)' : ''}`,
    );
  }
  return L.join('\n') + '\n';
}

process.stdout.write(WANT_MD ? md(result) : JSON.stringify(result, null, 2) + '\n');
