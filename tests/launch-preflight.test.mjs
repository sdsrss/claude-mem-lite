// launch-preflight.test.mjs — Verify install-corruption detection + fallback
// behavior covering issue #15 (server.mjs present, search-engine.mjs missing).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectMissingImports, resolveLaunchEntry } from '../scripts/launch-preflight.mjs';

const created = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'cml-preflight-'));
  created.push(d);
  return d;
}

afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('detectMissingImports', () => {
  it('returns [] when all relative imports exist', () => {
    const d = tmp();
    writeFileSync(
      join(d, 'server.mjs'),
      `import { x } from './foo.mjs';\nimport { y } from './lib/bar.mjs';\n`,
    );
    writeFileSync(join(d, 'foo.mjs'), 'export const x = 1;');
    mkdirSync(join(d, 'lib'));
    writeFileSync(join(d, 'lib/bar.mjs'), 'export const y = 1;');
    expect(detectMissingImports(d)).toEqual([]);
  });

  it('reports missing relative imports', () => {
    const d = tmp();
    writeFileSync(join(d, 'server.mjs'), `import { x } from './foo.mjs';\nimport { y } from './bar.mjs';\n`);
    writeFileSync(join(d, 'foo.mjs'), 'export const x = 1;');
    expect(detectMissingImports(d)).toEqual(['bar.mjs']);
  });

  it('returns ["server.mjs"] when server.mjs itself is missing', () => {
    const d = tmp();
    expect(detectMissingImports(d)).toEqual(['server.mjs']);
  });

  it('reproduces issue #15 — search-engine.mjs missing', () => {
    const d = tmp();
    writeFileSync(
      join(d, 'server.mjs'),
      `import { searchObservationsHybrid } from './search-engine.mjs';\n` +
        `import { x } from './utils.mjs';\n`,
    );
    writeFileSync(join(d, 'utils.mjs'), 'export const x = 1;');
    expect(detectMissingImports(d)).toEqual(['search-engine.mjs']);
  });

  it('catches dynamic imports too', () => {
    const d = tmp();
    writeFileSync(join(d, 'server.mjs'), `const m = await import('./lib/save-observation.mjs');\n`);
    expect(detectMissingImports(d)).toEqual(['lib/save-observation.mjs']);
  });

  it('ignores node: builtins and package imports', () => {
    const d = tmp();
    writeFileSync(
      join(d, 'server.mjs'),
      `import { readFile } from 'node:fs';\n` +
        `import { foo } from '@modelcontextprotocol/sdk/server.js';\n` +
        `import bar from 'better-sqlite3';\n`,
    );
    expect(detectMissingImports(d)).toEqual([]);
  });

  it('ignores example strings in line + block comments', () => {
    const d = tmp();
    writeFileSync(
      join(d, 'server.mjs'),
      `// Example: import { x } from './nonexistent.mjs';\n` +
        `/* import './also-nonexistent.mjs' */\n` +
        `import { y } from './real.mjs';\n`,
    );
    writeFileSync(join(d, 'real.mjs'), '');
    expect(detectMissingImports(d)).toEqual([]);
  });

  it('deduplicates the same missing file mentioned in static + dynamic imports', () => {
    const d = tmp();
    writeFileSync(
      join(d, 'server.mjs'),
      `import { a } from './x.mjs';\nconst m = await import('./x.mjs');\n`,
    );
    expect(detectMissingImports(d)).toEqual(['x.mjs']);
  });
});

describe('resolveLaunchEntry', () => {
  it('returns primary when healthy', () => {
    const p = tmp();
    writeFileSync(join(p, 'server.mjs'), `import './foo.mjs';\n`);
    writeFileSync(join(p, 'foo.mjs'), '');
    const result = resolveLaunchEntry({ primaryRoot: p, fallbackRoot: '/nonexistent' });
    expect(result).toEqual({ path: join(p, 'server.mjs'), source: 'primary' });
  });

  it('falls back when primary broken but fallback healthy, with stderr warning', () => {
    const p = tmp();
    const f = tmp();
    writeFileSync(join(p, 'server.mjs'), `import './missing.mjs';\n`);
    writeFileSync(join(f, 'server.mjs'), `import './have.mjs';\n`);
    writeFileSync(join(f, 'have.mjs'), '');

    const warns = [];
    const result = resolveLaunchEntry({
      primaryRoot: p,
      fallbackRoot: f,
      warn: (m) => warns.push(m),
    });

    expect(result.source).toBe('fallback');
    expect(result.path).toBe(join(f, 'server.mjs'));
    expect(result.missingFromPrimary).toEqual(['missing.mjs']);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('missing.mjs');
    expect(warns[0]).toContain('Falling back');
  });

  it('throws INSTALL_INCOMPLETE with repair command when both broken', () => {
    const p = tmp();
    writeFileSync(join(p, 'server.mjs'), `import './missing.mjs';\n`);
    let err;
    try {
      resolveLaunchEntry({ primaryRoot: p, fallbackRoot: '/nonexistent' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('INSTALL_INCOMPLETE');
    expect(err.missing).toEqual(['missing.mjs']);
    expect(err.message).toMatch(/npm install -g claude-mem-lite@latest --force/);
  });

  it('does not infinite-loop / double-warn when primaryRoot === fallbackRoot', () => {
    const d = tmp();
    writeFileSync(join(d, 'server.mjs'), `import './missing.mjs';\n`);
    const warns = [];
    expect(() => resolveLaunchEntry({ primaryRoot: d, fallbackRoot: d, warn: (m) => warns.push(m) })).toThrow(
      /Install incomplete/,
    );
    expect(warns).toHaveLength(0);
  });

  it('throws if both primary and fallback are broken', () => {
    const p = tmp();
    const f = tmp();
    writeFileSync(join(p, 'server.mjs'), `import './a.mjs';\n`);
    writeFileSync(join(f, 'server.mjs'), `import './b.mjs';\n`);
    expect(() => resolveLaunchEntry({ primaryRoot: p, fallbackRoot: f })).toThrow(/Install incomplete/);
  });
});
