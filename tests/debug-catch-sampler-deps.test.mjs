// debugCatch is the error-handler-of-last-resort: every swallowed exception in this
// codebase ends here, and CLAUDE_MEM_CATCH_SAMPLE turns it into the post-mortem trail.
// So what it depends on matters more than what anything else depends on — a dependency
// that is broken in the situation you are sampling takes the evidence down with it.
//
// It used to reach for schema.mjs solely to read DB_DIR. Audit P3 justified changing
// that with "the error path might load the native binding", and that premise is FALSE:
// better-sqlite3 dlopens its .node lazily, on `new Database()`, not on import (measured:
// 0 shared objects after import, 1 after construction), and this path never constructs
// one. The real defect is plainer and was verified by blocking the specifier: with
// schema.mjs unresolvable, NO sample was written at all. The sampler inherited the whole
// import graph of the DB layer — 24ms of cold module loading, and a silent total failure
// if any of it is broken — to obtain one string.
//
// It now imports lib/resolve-data-dir.mjs, whose only imports are node:os and node:path.
// The second benefit is timing: DB_DIR is evaluated at schema.mjs module load, so a test
// (or CLAUDE_MEM_TEST_GUARD) that redirects the data dir afterwards was ignored here;
// calling resolveDataDir at sample time honours it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

describe('debugCatch sampling path dependencies', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'catch-deps-'));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  });

  // One child process, one blocked specifier, one question: does the post-mortem trail
  // survive when the DB layer cannot be loaded? Run as a subprocess because the block
  // has to be installed before utils.mjs is imported.
  const runWithBlocked = (blockedSuffix) => {
    // module.register + a hooks module, NOT module.registerHooks: the latter landed in
    // Node 22.15 and this package declares engines >=20, so it threw a SyntaxError on
    // the CI matrix's node-20 leg while passing locally on 24. register() has been
    // available since 20.6.
    const hooks = join(dir, 'hooks.mjs');
    writeFileSync(
      hooks,
      `
      export async function resolve(specifier, context, next) {
        if (specifier.endsWith(${JSON.stringify(blockedSuffix)})) {
          throw new Error('BLOCKED ' + specifier);
        }
        return next(specifier, context);
      }
    `,
    );
    const blocker = join(dir, 'blocker.mjs');
    writeFileSync(
      blocker,
      `
      import { register } from 'node:module';
      import { pathToFileURL } from 'node:url';
      register(pathToFileURL(${JSON.stringify(hooks)}).href);
    `,
    );
    execFileSync(
      process.execPath,
      [
        '--import',
        blocker,
        '--input-type=module',
        '-e',
        `
        import { debugCatch } from ${JSON.stringify(join(REPO, 'utils.mjs'))};
        debugCatch(new Error('probe'), 'sampler-dep-probe');
        await new Promise((r) => setTimeout(r, 600));
      `,
      ],
      {
        cwd: REPO,
        env: { ...process.env, CLAUDE_MEM_CATCH_SAMPLE: '1', CLAUDE_MEM_DIR: dir, CLAUDE_MEM_DEBUG: '' },
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
    const errDir = join(dir, 'errors');
    return existsSync(errDir) ? readdirSync(errDir) : [];
  };

  it('still records a sample when schema.mjs cannot be resolved', () => {
    // Pre-fix this wrote nothing: the sampler awaited an import of schema.mjs purely for
    // DB_DIR, so a broken DB layer erased the very trail meant to explain it.
    expect(runWithBlocked('schema.mjs').length).toBeGreaterThan(0);
  });

  it('control: the sampler does write when nothing is blocked', () => {
    // Without this, the case above passes just as well if sampling is broken outright
    // in this harness for an unrelated reason.
    expect(runWithBlocked('this-module-does-not-exist.mjs').length).toBeGreaterThan(0);
  });

  it('resolveDataDir at call time equals the DB_DIR the sampler used to import', async () => {
    // The substitution must be exact, or samples land somewhere nobody looks.
    const { resolveDataDir } = await import('../lib/resolve-data-dir.mjs');
    const { DB_DIR } = await import('../schema.mjs');
    expect(resolveDataDir(process.env.CLAUDE_MEM_DIR)).toBe(DB_DIR);
  });
});
