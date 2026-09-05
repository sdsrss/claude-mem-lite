// Consistency test: ensures scripts/post-tool-use.sh skip patterns match skip-tools.mjs
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SKIP_TOOLS, SKIP_PREFIXES } from '../skip-tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bashScript = readFileSync(join(__dirname, '..', 'scripts', 'post-tool-use.sh'), 'utf-8');

/**
 * Parse the bash case statement to extract exact tool names and prefix patterns.
 *
 * The bash script has two sections in the case block:
 * 1. Exact matches: tool names separated by | in a case pattern
 * 2. Prefix filters: glob patterns like "mem_*" separated by |
 *
 * We also look for the Read tool handled separately above the case block.
 */
function parseBashSkipTools(script) {
  const exactTools = new Set();
  const prefixes = [];

  // Read is handled separately before the case block (has its own if-block)
  if (/if \[\[ "\$tool" == "Read" \]\]/.test(script)) {
    exactTools.add('Read');
  }

  // Extract exact matches section — lines between "Exact matches" comment and next comment or prefix section
  const exactMatch = script.match(/# Exact matches[^\n]*\n([\s\S]*?)(?=\n\s*# Prefix|\n\s*\*\))/);
  if (exactMatch) {
    // Extract tool names: everything before the closing )
    const block = exactMatch[1];
    // Remove line continuations, whitespace, and the trailing )
    const cleaned = block.replace(/\\\n/g, '').replace(/\s+/g, '');
    // Remove trailing ) and extract pipe-separated names
    const names = cleaned
      .replace(/\)[\s\S]*$/, '')
      .split('|')
      .filter(Boolean);
    for (const name of names) {
      exactTools.add(name);
    }
  }

  // Extract prefix filters section
  const prefixMatch = script.match(/# Prefix filters\n\s*(.*?)\)/);
  if (prefixMatch) {
    const patterns = prefixMatch[1]
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const pattern of patterns) {
      // Convert bash glob "foo*" to prefix "foo"
      if (pattern.endsWith('*')) {
        prefixes.push(pattern.slice(0, -1));
      }
    }
  }

  return { exactTools, prefixes };
}

describe('skip-tools consistency', () => {
  const { exactTools: bashExactTools, prefixes: bashPrefixes } = parseBashSkipTools(bashScript);

  it('bash exact tools match SKIP_TOOLS set', () => {
    const nodeTools = new Set(SKIP_TOOLS);
    const missingInBash = [...nodeTools].filter((t) => !bashExactTools.has(t));
    const extraInBash = [...bashExactTools].filter((t) => !nodeTools.has(t));

    expect(
      missingInBash,
      `Tools in skip-tools.mjs but not in post-tool-use.sh: ${missingInBash.join(', ')}`,
    ).toEqual([]);
    expect(
      extraInBash,
      `Tools in post-tool-use.sh but not in skip-tools.mjs: ${extraInBash.join(', ')}`,
    ).toEqual([]);
  });

  it('bash prefix patterns match SKIP_PREFIXES', () => {
    const nodePrefixes = [...SKIP_PREFIXES].sort();
    const sortedBashPrefixes = [...bashPrefixes].sort();

    expect(
      sortedBashPrefixes,
      'Prefix patterns in post-tool-use.sh must match SKIP_PREFIXES in skip-tools.mjs',
    ).toEqual(nodePrefixes);
  });

  it('SKIP_TOOLS is non-empty', () => {
    expect(SKIP_TOOLS.size).toBeGreaterThan(0);
  });

  it('SKIP_PREFIXES is non-empty', () => {
    expect(SKIP_PREFIXES.length).toBeGreaterThan(0);
  });

  it('hook.mjs imports from skip-tools.mjs (not inline definition)', () => {
    const hookSource = readFileSync(join(__dirname, '..', 'hook.mjs'), 'utf-8');
    expect(hookSource).toContain("from './skip-tools.mjs'");
    // Should NOT have an inline SKIP_TOOLS definition
    expect(hookSource).not.toMatch(/^const SKIP_TOOLS\s*=\s*new Set\(/m);
  });
});
