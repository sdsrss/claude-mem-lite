// Pre-tag defect review (D#212) P1-1: two sessions starting at once both read the block, both delete
// the file. The second unlinkSync fails with ENOENT — the file is already gone — and the fallback
// that empties a file it could not delete wrote a 0-byte CLAUDE.local.md back, for good: no later
// session or unadopt removes a file with no block, and it keeps AGENTS.md switched off.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const lost = vi.hoisted(() => ({ race: false }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal();
  const unlinkSync = (p) => {
    real.unlinkSync(p);
    if (lost.race) {
      // The other session got there first: the file is gone, and our call reports it.
      const e = new Error(`ENOENT: no such file or directory, unlink '${p}'`);
      e.code = 'ENOENT';
      throw e;
    }
  };
  return { ...real, default: { ...real, unlinkSync }, unlinkSync };
});

const { removeBlockAt } = await import('../claudemd.mjs');

describe('removeBlockAt when another process deleted the file first', () => {
  let dir;
  afterEach(() => {
    lost.race = false;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no file behind', () => {
    dir = mkdtempSync(join(tmpdir(), 'cml-enoent-'));
    const p = join(dir, 'CLAUDE.local.md');
    writeFileSync(p, '<!-- claude-mem-lite:begin v1 -->\nguidance\n<!-- claude-mem-lite:end -->\n');
    lost.race = true;
    expect(removeBlockAt(p, 'claude-mem-lite').action).toBe('removed');
    expect(existsSync(p)).toBe(false);
  });
});
