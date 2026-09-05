// Audit 2026-09-02 P2-6: the "how do I invoke this registry hit" rule ran to ~15 lines in
// `mem-cli.mjs cmdRegistry` and again in `server.mjs mem_registry`, and the two copies HAD
// ALREADY DIVERGED — which is the point, not a hypothetical:
//
//   MCP   portablePath = isManaged ? toPortable(local_path) : ''
//   CLI   portablePath = isManaged && local_path.startsWith(home) ? '~'+… : (local_path || '')
//
// For a NON-managed resource the CLI therefore printed `Path: /home/<user>/…` — absolute,
// un-tilde'd — on a row whose `Use:` line is `Skill("x")` and never refers to the path.
// MCP printed no path line at all. Nothing was asserting either behaviour, so the divergence
// was free to happen and free to stay.
//
// The MCP semantics are the ones kept: for a non-managed hit the path is not actionable and
// spelling out a home directory to say so is a small leak for no gain.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resourceUseHint } from '../lib/registry-core.mjs';
import { REPO } from './shipped-tree.mjs';

const HOME = '/home/tester';
const MANAGED = '/home/tester/.claude-mem-lite/managed/';
const ctx = { home: HOME, managedPrefix: MANAGED };

describe('resourceUseHint', () => {
  it('a managed skill directory resolves to its SKILL.md and tilde-ifies the path', () => {
    const r = { name: 'my-skill', type: 'skill', local_path: `${MANAGED}repo/my-skill` };
    const h = resourceUseHint(r, ctx);
    expect(h.isManaged).toBe(true);
    expect(h.portablePath).toBe('~/.claude-mem-lite/managed/repo/my-skill');
    expect(h.howToUse).toBe(
      'Read("~/.claude-mem-lite/managed/repo/my-skill/SKILL.md") or mem_use(name="my-skill")',
    );
  });

  it('a managed .md path is used as-is, not suffixed again', () => {
    const r = { name: 'my-agent', type: 'agent', local_path: `${MANAGED}group/agents/a.md` };
    const h = resourceUseHint(r, ctx);
    expect(h.howToUse).toContain('Read("~/.claude-mem-lite/managed/group/agents/a.md")');
    expect(h.howToUse).not.toContain('SKILL.md');
    // Agents carry the type argument; skills do not.
    expect(h.howToUse).toContain('type="agent"');
  });

  it('THE DRIFT: a non-managed resource yields NO path, on both faces', () => {
    // The exact divergence. Under the CLI's old expression this returned the absolute
    // local_path and the caller printed a `Path:` line for it.
    const r = {
      name: 'plugin-skill',
      type: 'skill',
      local_path: '/home/tester/.claude/skills/x',
      invocation_name: 'ns:x',
    };
    const h = resourceUseHint(r, ctx);
    expect(h.isManaged).toBe(false);
    expect(h.portablePath).toBe('');
    expect(h.howToUse).toBe('Skill("ns:x")');
  });

  it('a non-managed agent invokes through Agent(subagent_type=…)', () => {
    const r = { name: 'x', type: 'agent', local_path: '/elsewhere/x.md', invocation_name: 'ns:x' };
    expect(resourceUseHint(r, ctx).howToUse).toBe('Agent(subagent_type="ns:x")');
  });

  it('no invocation_name and not managed falls back to mem_use', () => {
    const r = { name: 'orphan', type: 'skill', local_path: '/elsewhere/orphan' };
    expect(resourceUseHint(r, ctx).howToUse).toBe('mem_use(name="orphan")');
  });

  it('a managed path outside home keeps its absolute form rather than mangling it', () => {
    // CLAUDE_MEM_DIR can relocate the managed tree off $HOME. `slice(home.length)` on a path
    // that does not start with home would cut arbitrary characters off the front.
    const r = { name: 's', type: 'skill', local_path: '/mnt/vol/managed/s/SKILL.md' };
    const h = resourceUseHint(r, { home: HOME, managedPrefix: '/mnt/vol/managed/' });
    expect(h.isManaged).toBe(true);
    expect(h.portablePath).toBe('/mnt/vol/managed/s/SKILL.md');
  });

  it('a missing local_path is not managed and does not throw', () => {
    expect(resourceUseHint({ name: 'n', type: 'skill' }, ctx)).toEqual({
      isManaged: false,
      portablePath: '',
      howToUse: 'mem_use(name="n")',
    });
  });
});

describe('neither face keeps a private copy of the rule', () => {
  // A unit test of the shared helper stays green while a caller keeps its own branch —
  // exactly the state P2-6 describes. Both faces are checked for the tell: the `Skill(` /
  // `Agent(subagent_type=` construction that only belongs in the helper now.
  const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

  it.each(['mem-cli.mjs', 'server.mjs'])('%s calls resourceUseHint', (rel) => {
    expect(read(rel)).toMatch(/resourceUseHint\(/);
  });

  it.each(['mem-cli.mjs', 'server.mjs'])('%s no longer builds the invocation string itself', (rel) => {
    expect(read(rel), `${rel} still constructs Agent(subagent_type=…) for a registry hit`).not.toMatch(
      /Agent\(subagent_type="\$\{r\.invocation_name\}"\)/,
    );
  });

  it('the scan can say NO', () => {
    // `not.toMatch` passes against a pattern matching nothing. This is the line that shipped.
    expect('howToUse = `Agent(subagent_type="${r.invocation_name}")`;').toMatch(
      /Agent\(subagent_type="\$\{r\.invocation_name\}"\)/,
    );
  });
});
