// The self-repair path must be reachable on the ONE install state it exists to repair:
// a tree whose `node_modules` is missing.
//
// Measured chain before the fix (2026-09-08):
//   hook-launcher → `node cli.mjs repair` → INSTALL_COMMANDS → install.mjs::repair()
//   → `await import('./hook-update.mjs')` → `./schema.mjs` → `better-sqlite3` (absent)
//   → throw → catch → "refusing to auto-install unverified code"
//
// hook-update.mjs imported `schema.mjs` for two PATH CONSTANTS (DB_DIR, CODE_DIR), and
// schema.mjs statically imports the native driver. So the Ed25519-verified repair path was
// unreachable exactly when needed, and the printed fallback is the unverified
// default-branch tarball that install.mjs::repair()'s own comment says it replaced.
//
// Two guards, deliberately different in kind:
//   • a STATIC import-graph walk, which fails on any FUTURE edge, not just this one;
//   • a BEHAVIOURAL spawn against a real node_modules-free tree, with a premise control
//     so it cannot pass vacuously.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import * as acorn from 'acorn';
import { makeFixtureTracker } from './test-helpers.mjs';

// dirname(fileURLToPath(...)) + join, never new URL(): the URL form drops the named module
// out of knip's report entirely (tests/no-url-module-paths.test.mjs).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const fixtures = makeFixtureTracker();
afterAll(() => fixtures.disposeAll());

function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) walkAst(c, visit);
    else if (child && typeof child === 'object') walkAst(child, visit);
  }
}

// STATIC specifiers only — `import()` is a lazy edge and does not run at module load, which
// is the whole property under test. AST, not regex: a commented-out import is not a node
// (audit 2026-09-05 P2-9 minted cycles from prose that way).
function staticSpecifiers(file) {
  const ast = acorn.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
  const out = [];
  walkAst(ast, (n) => {
    const isStatic =
      n.type === 'ImportDeclaration' ||
      n.type === 'ExportNamedDeclaration' ||
      n.type === 'ExportAllDeclaration';
    if (isStatic && n.source?.type === 'Literal' && typeof n.source.value === 'string') {
      out.push(n.source.value);
    }
  });
  return out;
}

/** Bare (package) specifiers reachable from `entry` over STATIC edges, builtins excluded. */
function reachablePackages(entry) {
  const seen = new Set();
  const packages = new Set();
  const queue = [join(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticSpecifiers(file)) {
      if (BUILTINS.has(spec)) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const target = join(dirname(file), spec);
        // An unresolvable local edge would silently shrink the graph and make this guard
        // pass by seeing less. Fail instead.
        expect(existsSync(target), `unresolved local import ${spec} from ${file}`).toBe(true);
        queue.push(target);
      } else {
        packages.add(spec);
      }
    }
  }
  return { packages, files: seen };
}

/**
 * A copy of the shipped module tree with NO node_modules anywhere above it — the state a
 * plugin-cache install lands in when Claude Code materializes a new version.
 */
function nodeModulesFreeTree() {
  const dir = fixtures.track(mkdtempSync(join(tmpdir(), 'claude-mem-repair-probe-')));
  // Premise: Node resolves node_modules UP the tree, so a stray one above the fixture would
  // hand the probe a working driver and every assertion below would pass vacuously.
  for (let p = dir; p !== dirname(p); p = dirname(p)) {
    expect(existsSync(join(p, 'node_modules')), `node_modules leak above fixture at ${p}`).toBe(false);
  }
  for (const name of readdirSync(ROOT)) {
    if (name.endsWith('.mjs')) cpSync(join(ROOT, name), join(dir, name));
  }
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  cpSync(join(ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
  return dir;
}

function probeImport(dir, relFile) {
  const script = `import(${JSON.stringify('file://' + join(dir, relFile))})
    .then((m) => console.log('LOADED ' + Object.keys(m).length))
    .catch((e) => console.log('FAILED ' + e.code));`;
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 }).trim();
}

describe('the verified repair path survives a missing node_modules', () => {
  it('reaches no package dependency from hook-update.mjs over static imports', () => {
    const { packages } = reachablePackages('hook-update.mjs');
    // install.mjs::repair() imports this module to get fetchLatestRelease /
    // verifyReleaseAuthenticity. Any package edge here disarms the signature check on the
    // one install state that needs it.
    expect([...packages].sort()).toEqual([]);
  });

  it('reaches no package dependency from install.mjs over static imports', () => {
    // Control: install.mjs was already clean (its driver use is requireFromInstall /
    // await import). This case passes before and after the fix and exists to keep it so.
    const { packages } = reachablePackages('install.mjs');
    expect([...packages].sort()).toEqual([]);
  });

  it('names schema.mjs as a static importer of the native driver (premise)', () => {
    // The two guards above are only meaningful while SOMETHING in the tree still pulls the
    // driver statically. If this ever goes red, the graph changed shape and the assertions
    // above may have become vacuous.
    const { packages } = reachablePackages('schema.mjs');
    expect([...packages]).toContain('better-sqlite3');
  });

  it('loads hook-update.mjs in a tree with no node_modules', () => {
    const dir = nodeModulesFreeTree();
    const out = probeImport(dir, 'hook-update.mjs');
    expect(out).toMatch(/^LOADED /);
  });

  it('exposes the signature-verified release API from that tree', () => {
    // Loading is not the point; repair() destructures five named exports out of it.
    const dir = nodeModulesFreeTree();
    const script = `import(${JSON.stringify('file://' + join(dir, 'hook-update.mjs'))})
      .then((m) => console.log(['fetchLatestRelease','verifyReleaseAuthenticity','validateExtractedTarball','isRepairDowngrade','getCurrentVersion']
        .filter((k) => typeof m[k] === 'function').join(',')))
      .catch((e) => console.log('FAILED ' + e.code));`;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 }).trim();
    expect(out).toBe(
      'fetchLatestRelease,verifyReleaseAuthenticity,validateExtractedTarball,isRepairDowngrade,getCurrentVersion',
    );
  });

  it('fails to load schema.mjs in that same tree (fixture premise)', () => {
    // Without this the two cases above could pass on a fixture that quietly resolved a
    // driver from somewhere, which is the shape the leak check above also guards.
    const dir = nodeModulesFreeTree();
    expect(probeImport(dir, 'schema.mjs')).toBe('FAILED ERR_MODULE_NOT_FOUND');
  });
});
