import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../lib/atomic-write.mjs';

const dirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'atomic-write-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop(), { recursive: true, force: true });
    } catch {}
  }
});

describe('atomic-write', () => {
  it('writes the data and leaves no temp file behind', () => {
    const d = tmp();
    const f = join(d, 'config.json');
    atomicWriteFileSync(f, '{"a":1}\n');
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}\n');
    expect(readdirSync(d)).toEqual(['config.json']); // no .tmp-* leftover
  });

  it('creates the parent directory if missing', () => {
    const f = join(tmp(), 'nested', 'deep', 'config.json');
    atomicWriteFileSync(f, 'hi');
    expect(readFileSync(f, 'utf8')).toBe('hi');
  });

  it('overwrites an existing file', () => {
    const f = join(tmp(), 'config.json');
    writeFileSync(f, 'old');
    atomicWriteFileSync(f, 'new');
    expect(readFileSync(f, 'utf8')).toBe('new');
  });

  it('with backup:true preserves the FIRST (last-known-good) version only', () => {
    const f = join(tmp(), 'config.json');
    writeFileSync(f, 'original');

    atomicWriteFileSync(f, 'v2', { backup: true });
    expect(readFileSync(f, 'utf8')).toBe('v2');
    expect(readFileSync(f + '.bak', 'utf8')).toBe('original');

    // Second write must NOT clobber the backup with the now-bad 'v2'.
    atomicWriteFileSync(f, 'v3', { backup: true });
    expect(readFileSync(f, 'utf8')).toBe('v3');
    expect(readFileSync(f + '.bak', 'utf8')).toBe('original');
  });

  it('with backup:false creates no .bak', () => {
    const f = join(tmp(), 'config.json');
    writeFileSync(f, 'original');
    atomicWriteFileSync(f, 'new');
    expect(existsSync(f + '.bak')).toBe(false);
  });

  it('backup is a no-op when the target does not yet exist', () => {
    const f = join(tmp(), 'config.json');
    atomicWriteFileSync(f, 'first', { backup: true });
    expect(readFileSync(f, 'utf8')).toBe('first');
    expect(existsSync(f + '.bak')).toBe(false);
  });

  it('writes THROUGH a symlink (dotfiles) instead of replacing it with a regular file', () => {
    const d = tmp();
    const dotfiles = join(d, 'dotfiles');
    mkdirSync(dotfiles);
    const claude = join(d, 'claude');
    mkdirSync(claude);
    const target = join(dotfiles, 'settings.json');
    writeFileSync(target, '{"old":1}');
    const link = join(claude, 'settings.json');
    symlinkSync(target, link);

    atomicWriteFileSync(link, '{"new":2}', { backup: true });

    expect(lstatSync(link).isSymbolicLink()).toBe(true); // link preserved, not clobbered
    expect(readFileSync(target, 'utf8')).toBe('{"new":2}'); // wrote through to the real target
    expect(readFileSync(link, 'utf8')).toBe('{"new":2}');
    expect(readFileSync(target + '.bak', 'utf8')).toBe('{"old":1}'); // backup captured the target, not the link
    expect(existsSync(link + '.bak')).toBe(false); // no stray .bak next to the symlink
  });
});
