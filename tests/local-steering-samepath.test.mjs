// Pre-tag round-3 review (D#212) R3-11: on a case-insensitive disk (macOS APFS by default)
// realpath keeps the spelling it is given, so `~/projects/app` typed in a shell and the
// `~/Projects/App` git reports compared as two directories: an explicit adopt at the root took
// the root for a subdirectory and left the local copy loading beside CLAUDE.md. realpath is made
// to keep spellings here, as it does there; a symlink stands in for the second spelling.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal();
  const realpathSync = Object.assign((p) => resolve(String(p)), { native: (p) => resolve(String(p)) });
  return { ...real, default: { ...real, realpathSync }, realpathSync };
});

const { samePath } = await import('../lib/local-steering.mjs');

describe('samePath where realpath keeps the spelling it is given', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('two spellings of one directory are the same path', () => {
    dir = mkdtempSync(join(tmpdir(), 'cml-samepath-'));
    mkdirSync(join(dir, 'App'));
    symlinkSync(join(dir, 'App'), join(dir, 'app'));
    expect(samePath(join(dir, 'app'), join(dir, 'App'))).toBe(true);
  });

  it('two directories are not', () => {
    dir = mkdtempSync(join(tmpdir(), 'cml-samepath-'));
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    expect(samePath(join(dir, 'a'), join(dir, 'b'))).toBe(false);
  });

  it('a path that does not exist is compared by spelling', () => {
    dir = mkdtempSync(join(tmpdir(), 'cml-samepath-'));
    expect(samePath(join(dir, 'gone'), join(dir, 'gone'))).toBe(true);
    expect(samePath(join(dir, 'gone'), join(dir, 'other'))).toBe(false);
  });
});
