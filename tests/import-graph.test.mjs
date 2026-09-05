// Guard: the module graph must stay acyclic.
//
// utils.mjs is a backward-compat BARREL re-exporting from extracted leaf modules.
// A leaf that imports back from the barrel creates a cycle that works today only
// because ESM live bindings tolerate it — it breaks the moment someone splits the
// barrel further, or adds tooling that walks the graph. Keep this at zero.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `tasks/` belongs here for the same reason `tmp/` does (D#168): it is gitignored local
// workspace — specs, plans, review reports, mutation backups — not shipped source, and a
// scanner that walks it turns red because of what a session happened to leave behind. The
// two sibling walkers (obs-types-invariant.test.mjs, time-constants.test.mjs) already skip
// it; this one was the odd one out, and a pre-tag reviewer's `cp` backups under
// tasks/bak-3810/ are what surfaced it.
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'tmp', 'tasks']);

/** Collect every .mjs file in the repo, excluding vendored/generated trees. */
function collectMjs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectMjs(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

// Static `import ... from '<spec>'`, bare `import '<spec>'`, `export ... from '<spec>'`
// (capture 1), and lazy `import('<spec>')` with a literal specifier (capture 2).
const SPEC_RE =
  /(?:^|[\s;}])(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Path-like specifiers only — bare ones ('node:fs', 'better-sqlite3') are package resolution. */
function pathSpecs(source) {
  const specs = [];
  for (const m of source.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2];
    if (spec && (spec.startsWith('.') || spec.startsWith('/'))) {
      specs.push({ spec, lazy: m[2] !== undefined });
    }
  }
  return specs;
}

const relativeSpecs = (source) => pathSpecs(source).filter((s) => s.spec.startsWith('.'));

/** @param {boolean} includeLazy Follow `await import()` edges too. */
function buildGraph(files, includeLazy) {
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const deps = [];
    for (const { spec, lazy } of relativeSpecs(readFileSync(file, 'utf8'))) {
      if (lazy && !includeLazy) continue;
      let target = resolve(dirname(file), spec);
      if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.mjs');
      if (known.has(target)) deps.push(target);
    }
    graph.set(file, deps);
  }
  return graph;
}

/** Iterative DFS with an explicit stack; returns every cycle found as a node path. */
function findCycles(graph) {
  const WHITE = 0,
    GREY = 1,
    BLACK = 2;
  const color = new Map([...graph.keys()].map((k) => [k, WHITE]));
  const cycles = [];

  for (const root of graph.keys()) {
    if (color.get(root) !== WHITE) continue;
    const path = [];
    const stack = [{ node: root, iter: 0 }];
    color.set(root, GREY);
    path.push(root);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = graph.get(frame.node) || [];
      if (frame.iter >= deps.length) {
        color.set(frame.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const next = deps[frame.iter++];
      const state = color.get(next);
      if (state === GREY) {
        cycles.push([...path.slice(path.indexOf(next)), next]);
      } else if (state === WHITE) {
        color.set(next, GREY);
        path.push(next);
        stack.push({ node: next, iter: 0 });
      }
    }
  }
  return cycles;
}

// Cycles that exist ONLY through a deliberate `await import()`. A lazy edge is the
// standard remedy for a cycle, not a defect — the module is not on the importer's
// load path. Listed explicitly so a NEW lazy cycle still fails this suite.
const KNOWN_LAZY_CYCLES = [
  // Was: 'utils.mjs -> schema.mjs -> utils.mjs' — debugCatch()'s sampler lazy-loaded
  // schema.mjs for DB_DIR while schema.mjs statically imports utils.mjs. The sampler now
  // takes lib/resolve-data-dir.mjs (node:os + node:path only), so the cycle is gone
  // rather than tolerated. Keep this list EMPTY if you can: an entry here means a real
  // cycle that only an await-import keeps off the load path.
];

const fmt = (cycles) => cycles.map((c) => c.map((f) => relative(ROOT, f)).join(' -> ')).sort();

describe('module import graph', () => {
  const files = collectMjs(ROOT);
  const staticGraph = buildGraph(files, false);
  const fullGraph = buildGraph(files, true);

  it('indexes the repo (sanity: the graph is non-trivial)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect([...staticGraph.values()].reduce((n, d) => n + d.length, 0)).toBeGreaterThan(100);
  });

  it('has zero circular static imports', () => {
    const cycles = fmt(findCycles(staticGraph));
    expect(cycles, `circular imports found:\n  ${cycles.join('\n  ')}`).toEqual([]);
  });

  it('adds no undocumented lazy-import cycles', () => {
    expect(fmt(findCycles(fullGraph))).toEqual([...KNOWN_LAZY_CYCLES].sort());
  });

  it('imports no absolute filesystem paths', () => {
    // v3.56 P3-15: scripts/p0-forward-probe.mjs imported
    // '/mnt/data_ssd/dev/projects/mem/scoring-sql.mjs' — another machine's checkout.
    // `node --check` passes on that file (it parses, never resolves), so only a
    // resolution check catches it. An absolute specifier is never portable here;
    // sibling modules must be reached relatively.
    const absolute = [];
    for (const file of files) {
      for (const { spec } of pathSpecs(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('/')) absolute.push(`${relative(ROOT, file)} -> ${spec}`);
      }
    }
    expect(absolute, `absolute-path imports:\n  ${absolute.join('\n  ')}`).toEqual([]);
  });

  it('resolves every relative import in the non-test source tree', () => {
    // Scoped to shipped source: tests/ and preflight scripts embed sample specifiers
    // ('./x.mjs') in comments and fixture strings that this regex scan cannot
    // distinguish from real imports.
    const broken = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel.startsWith('tests/') || rel.startsWith('benchmark/') || rel.includes('preflight')) continue;
      for (const { spec } of relativeSpecs(readFileSync(file, 'utf8'))) {
        const base = resolve(dirname(file), spec);
        const hit = [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs')].some(
          (c) => existsSync(c) && statSync(c).isFile(),
        );
        if (!hit) broken.push(`${rel} -> ${spec}`);
      }
    }
    expect(broken, `unresolvable imports:\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  it('project-utils.mjs does not import from the utils.mjs barrel', () => {
    // Direct assertion on the specific trap: utils.mjs re-exports project-utils.mjs,
    // so project-utils.mjs must stay a leaf.
    const deps = (fullGraph.get(join(ROOT, 'project-utils.mjs')) || []).map((f) => relative(ROOT, f));
    expect(deps).not.toContain('utils.mjs');
  });
});
