import { describe, it, expect } from 'vitest';
import { stripHostBlocks } from '../lib/host-blocks.mjs';

// Shape as the UserPromptSubmit hook receives it from the VS Code extension: the block is
// its own transcript text part, joined in front of the typed text.
const BLOCK =
  '<browser_instruction># Claude in Chrome browser automation\n\nYou have access to browser automation tools ' +
  '(mcp__claude-in-chrome__*) for interacting with web pages in Chrome.</browser_instruction>';

describe('stripHostBlocks', () => {
  it('removes a prepended block and keeps the typed text', () => {
    expect(stripHostBlocks(`${BLOCK}\n\nfix the billing retry bug`)).toBe('fix the billing retry bug');
  });

  it('returns an empty string when the prompt was only the block', () => {
    expect(stripHostBlocks(BLOCK)).toBe('');
  });

  it('removes every well-formed block', () => {
    expect(stripHostBlocks(`${BLOCK}\na\n${BLOCK}\nb`)).toBe('a\n\nb');
  });

  it('leaves an opener with no close alone (a prompt that mentions the tag)', () => {
    const text = 'why does <browser_instruction> show up in my handoff?';
    expect(stripHostBlocks(text)).toBe(text);
  });

  it('does not trim or otherwise touch text that has no block', () => {
    const text = '  keep my <b>spacing</b>  \n';
    expect(stripHostBlocks(text)).toBe(text);
  });

  it('passes non-strings through', () => {
    expect(stripHostBlocks(undefined)).toBe(undefined);
    expect(stripHostBlocks(42)).toBe(42);
  });

  it('stays linear on opener-dense input', () => {
    const dense = '<browser_instruction>'.repeat(12000) + 'x'; // ~252KB, the stdin cap
    const started = performance.now();
    expect(stripHostBlocks(dense)).toBe(dense);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
