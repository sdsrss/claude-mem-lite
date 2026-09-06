// Guards the MCP tool surface against silent drift:
//   - Core set must be exactly the 9 tools promised by the invited-memory
//     contract (6 retrieval/save + 3 defer, v2.70+); extending it bloats every
//     agent's startup context.
//   - "Equivalent CLI:" lines in descriptions must match the actual CLI
//     (caught by issue: maintain/compress/optimize doc drift, fixed with
//     this round's low-risk bundle).
//   - Each tool must carry DO NOT / USE guidance blocks (scenario-driven
//     descriptions per the plugin's invocation contract).
import { describe, it, expect } from 'vitest';
import { tools } from '../tool-schemas.mjs';

const CORE_TOOLS = [
  'mem_search',
  'mem_recent',
  'mem_timeline',
  'mem_get',
  'mem_save',
  'mem_recall',
  'mem_defer',
  'mem_defer_list',
  'mem_defer_drop',
];

describe('MCP tools surface', () => {
  it('exposes exactly 9 core tools via tools/list', () => {
    const exposed = tools
      .filter((t) => !t.hidden)
      .map((t) => t.name)
      .sort();
    expect(exposed).toEqual([...CORE_TOOLS].sort());
  });

  it('registers all known hidden tools by exact name', () => {
    const hidden = tools
      .filter((t) => t.hidden === true)
      .map((t) => t.name)
      .sort();
    expect(hidden).toEqual(
      [
        'mem_browse',
        'mem_compress',
        'mem_delete',
        'mem_export',
        'mem_fts_check',
        'mem_maintain',
        'mem_optimize',
        'mem_stats',
        'mem_update',
      ].sort(),
    );
  });

  it('has no accidental duplicates in the registered set', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool description carries DO NOT / USE guidance blocks', () => {
    for (const t of tools) {
      expect(t.description, `${t.name} missing "DO NOT use when" block`).toContain('DO NOT use when:');
      expect(t.description, `${t.name} missing "USE when" block`).toContain('USE when:');
    }
  });

  it('every tool description carries an Equivalent CLI line (except mem_use, MCP-only)', () => {
    for (const t of tools) {
      expect(t.description, `${t.name} missing "Equivalent CLI:" line`).toMatch(/Equivalent CLI:/);
    }
  });

  it('Equivalent CLI lines use actual CLI flags (no phantom --action/--operations)', () => {
    // Regression: maintain/compress/optimize docs once referenced
    // --action/--operations/--preview/--max-items — flags that don't exist
    // in the CLI parser. Agents following those docs got silent errors.
    for (const t of tools) {
      if (!/Equivalent CLI:/.test(t.description)) continue;
      const cliLine = t.description.match(/Equivalent CLI:[^\n]*/)[0];
      // Specific maintain/optimize docs now use --ops / --run / --run-all / --task
      if (t.name === 'mem_maintain') {
        expect(cliLine).not.toContain('--action');
        expect(cliLine).not.toContain('--operations');
      }
      if (t.name === 'mem_optimize') {
        expect(cliLine).not.toContain('--action');
        expect(cliLine).not.toContain('--max-items');
      }
      if (t.name === 'mem_compress') {
        // preview is the default, not a flag — CLI uses --execute to flip
        expect(cliLine).not.toMatch(/\[--preview\]/);
      }
    }
  });

  it('core tool name/order is stable (inline snapshot)', () => {
    const exposed = tools.filter((t) => !t.hidden).map((t) => t.name);
    expect(exposed).toMatchInlineSnapshot(`
      [
        "mem_search",
        "mem_recent",
        "mem_timeline",
        "mem_get",
        "mem_save",
        "mem_recall",
        "mem_defer",
        "mem_defer_list",
        "mem_defer_drop",
      ]
    `);
  });
});
