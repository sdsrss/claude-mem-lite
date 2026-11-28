import { describe, it, expect } from 'vitest';
import { stripHostBlocks, stripPromptBlocks } from '../lib/host-blocks.mjs';
import { stripPrivate } from '../lib/private-strip.mjs';

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

  it('removes every consecutive leading block, whitespace between them allowed', () => {
    expect(stripHostBlocks(`  ${BLOCK}\n${BLOCK}\na`)).toBe('a');
  });

  it('keeps a pair that is not at the start: the user typed it', () => {
    const text = `a\n${BLOCK}\nb`;
    expect(stripHostBlocks(text)).toBe(text);
    expect(stripHostBlocks(`${BLOCK}\na\n${BLOCK}\nb`)).toBe(`a\n${BLOCK}\nb`);
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

// The two strips cannot simply be chained: see stripPromptBlocks in lib/host-blocks.mjs.
describe('stripPromptBlocks', () => {
  it('returns an empty string for a host-only prompt', () => {
    expect(stripPromptBlocks(BLOCK)).toBe('');
  });

  // Fail closed wherever the opener sits: a leading pair cannot be told apart from one the
  // user typed, so an unclosed <private> inside it redacts to the end like any other.
  it('redacts to the end from an unmatched <private> inside the block (fail closed)', () => {
    const block = '<browser_instruction>steps <private>never closed</browser_instruction>';
    expect(stripPromptBlocks(`${block}\n\nfix the billing retry bug`)).toBe('[redacted]');
  });

  it('a typed leading pair holding an opener does not leak what follows', () => {
    for (const opener of ['<private>', '<private x>', '<PRIVATE>']) {
      const text = `<browser_instruction>${opener}</browser_instruction> my password is hunter2`;
      expect(stripPromptBlocks(text), opener).toBe('[redacted]');
    }
  });

  it('redacts through the closer of a region that opens inside the block, leaking nothing', () => {
    const out = stripPromptBlocks(
      '<browser_instruction>x <private>a</browser_instruction> secret</private> typed',
    );
    expect(out).toBe('[redacted] typed');
    expect(out).not.toContain('secret');
  });

  it('still redacts an unclosed <private> outside any block to the end', () => {
    expect(stripPromptBlocks(`${BLOCK} hello <private>my secret and more`)).toBe('hello [redacted]');
  });

  it('drops a private region wholly inside the block with no marker', () => {
    expect(
      stripPromptBlocks('<browser_instruction>a <private>p</private> b</browser_instruction> typed'),
    ).toBe('typed');
  });

  it('redacts a normal private region beside a block', () => {
    expect(stripPromptBlocks(`${BLOCK} use <private>key</private> here`)).toBe('use [redacted] here');
  });

  it('returns the same string when nothing matches, and passes non-strings through', () => {
    const text = '  plain <b>text</b> ';
    expect(stripPromptBlocks(text)).toBe(text);
    expect(stripPromptBlocks('no tags at all')).toBe('no tags at all');
    expect(stripPromptBlocks(undefined)).toBe(undefined);
  });

  // A pair typed mid-prompt is user text, so it cannot disarm <private> redaction.
  it('a typed pair straddling <private> tags does not disarm redaction (review case 1)', () => {
    const text = '<private>s1 <browser_instruction></private><private></browser_instruction> typed after';
    expect(stripPromptBlocks(text)).toBe(stripPrivate(text));
    expect(stripPromptBlocks(text)).not.toContain('typed after');
  });

  it('a typed pair holding an opener does not leak what follows (review case 2)', () => {
    const text = 'example: <browser_instruction><private></browser_instruction> my password is hunter2';
    expect(stripPromptBlocks(text)).toBe(stripPrivate(text));
    expect(stripPromptBlocks(text)).not.toContain('hunter2');
  });

  it('keeps a mid-prompt typed pair verbatim', () => {
    const text = 'why does <browser_instruction>x</browser_instruction> appear?';
    expect(stripPromptBlocks(text)).toBe(text);
  });

  it('a private-only prompt comes out exactly as stripPrivate gives it, untrimmed', () => {
    const text = '  use <private>tok</private> to deploy\n';
    expect(stripPromptBlocks(text)).toBe(stripPrivate(text));
    expect(stripPromptBlocks(text)).toBe('  use [redacted] to deploy\n');
  });

  it('fails closed on any number of unclosed openers in the leading block', () => {
    const prompt = (count) => `<browser_instruction>${'<private>'.repeat(count)}</browser_instruction> typed`;
    for (const count of [1, 16, 17])
      expect(stripPromptBlocks(prompt(count)), String(count)).toBe('[redacted]');
  });

  it('stays linear on openers packed inside a block, and fails closed', () => {
    const dense = `<browser_instruction>${'<private>'.repeat(12000)}</browser_instruction> typed`;
    const started = performance.now();
    const out = stripPromptBlocks(dense);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out).toBe('[redacted]');
  });
});
