// R10 P2-4 — commands/*.md are read by the MODEL, so a wrong instruction there is a wrong
// behaviour, not a typo. Both files told the agent to run
// `mem_maintain(action="execute", operations=["purge_stale"])` with no `confirm`. That call
// does not purge: server.mjs treats an unconfirmed purge_stale as a dry-run PREVIEW and
// returns normally. So the documented flow asks the user for permission, gets it, runs a
// call that deletes nothing, and reports success — the worst of the three possible
// outcomes, because the user now believes the cleanup happened.
//
// The `/mem cleanup Nd` mapping had a second problem: it advertised an arbitrary N while
// the schema floors retain_days at 7, so `/mem cleanup 3d` is rejected by zod.
//
// Guarded by reading the schema, not by restating the numbers here — a guard that hardcodes
// 7 and 365 goes stale the same way the docs did.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { memMaintainSchema } from '../tool-schemas.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

/** The retain_days bounds, read out of the schema by probing it. */
function retainDaysBounds() {
  const schema = z.object(memMaintainSchema);
  const ok = (n) => schema.safeParse({ action: 'execute', retain_days: n }).success;
  let min = null;
  let max = null;
  for (let n = 1; n <= 400; n++) {
    if (ok(n)) {
      if (min === null) min = n;
      max = n;
    }
  }
  return { min, max };
}

describe('R10 P2-4 — the purge instruction the model reads actually purges', () => {
  it('premise: an unconfirmed purge_stale really is a no-op preview', () => {
    const schema = z.object(memMaintainSchema);
    // Both parse — the schema does not require confirm, the HANDLER branches on it. That is
    // exactly why the docs could be wrong without anything failing.
    expect(schema.safeParse({ action: 'execute', operations: ['purge_stale'] }).success).toBe(true);
    expect(
      readFileSync(join(REPO, 'server.mjs'), 'utf8'),
      'the confirm gate moved; this guard is describing code that no longer exists',
    ).toContain('const purgeConfirmed = args.confirm === true;');
  });

  for (const rel of ['commands/mem.md', 'commands/update.md']) {
    it(`${rel} pairs every purge_stale instruction with confirm=true`, () => {
      const src = read(rel);
      const lines = src.split('\n').filter((l) => l.includes('purge_stale'));
      expect(lines.length, `${rel} no longer mentions purge_stale at all`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${rel}: purge_stale instruction without confirm=true → silent no-op`).toMatch(
          /confirm\s*=\s*true/,
        );
      }
    });
  }

  it('commands/mem.md states the retain_days range the schema actually enforces', () => {
    const { min, max } = retainDaysBounds();
    expect(min).toBe(7);
    expect(max).toBe(365);
    const src = read('commands/mem.md');
    expect(src, 'the retain_days bounds are not written down where the model reads them').toContain(`${min}`);
    expect(src).toMatch(new RegExp(`retain_days[^\\n]*${min}[^\\n]*${max}`));
  });
});
